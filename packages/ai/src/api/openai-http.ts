import type { FetchFunction, ProviderHeaders } from "../types.ts";

const DEFAULT_TIMEOUT_MS = 10 * 60 * 1000;

export class OpenAIHttpError extends Error {
	readonly status: number | undefined;
	readonly headers: Headers | undefined;
	readonly error: unknown;

	constructor(
		status: number | undefined,
		error: unknown,
		message: string | undefined,
		headers: Headers | undefined,
		options?: ErrorOptions,
	) {
		super(makeErrorMessage(status, error, message), options);
		this.name = "OpenAIHttpError";
		this.status = status;
		this.headers = headers;
		this.error = error;
	}
}

function makeErrorMessage(status: number | undefined, error: unknown, message: string | undefined): string {
	const errorMessage = (error as { message?: unknown } | undefined)?.message;
	const msg = errorMessage
		? typeof errorMessage === "string"
			? errorMessage
			: JSON.stringify(errorMessage)
		: error
			? JSON.stringify(error)
			: message;
	if (status && msg) return `${status} ${msg}`;
	if (status) return `${status} status code (no body)`;
	if (msg) return msg;
	return "(no status code or body)";
}

export interface OpenAIStreamRequest {
	baseUrl: string;
	path: string;
	apiKey: string;
	headers: ProviderHeaders;
	body: unknown;
	signal?: AbortSignal;
	timeoutMs?: number;
	fetch?: FetchFunction;
}

export interface OpenAIStreamResponse<TEvent> {
	response: Response;
	events: AsyncIterable<TEvent>;
}

function buildUrl(baseUrl: string, path: string): string {
	return baseUrl.endsWith("/") ? `${baseUrl}${path.slice(1)}` : `${baseUrl}${path}`;
}

function buildHeaders(apiKey: string, headers: ProviderHeaders): Headers {
	const result = new Headers({
		accept: "application/json",
		"content-type": "application/json",
		authorization: `Bearer ${apiKey}`,
	});
	for (const [name, value] of Object.entries(headers)) {
		if (value === null) result.delete(name);
		else result.set(name, value);
	}
	return result;
}

function isAbortError(error: unknown): boolean {
	return error instanceof Error && (error.name === "AbortError" || error.name === "TimeoutError");
}

function parseJson(text: string): unknown {
	try {
		return JSON.parse(text);
	} catch {
		return undefined;
	}
}

export async function postOpenAIStream<TEvent>(request: OpenAIStreamRequest): Promise<OpenAIStreamResponse<TEvent>> {
	request.signal?.throwIfAborted();
	const controller = new AbortController();
	const abort = () => controller.abort(request.signal?.reason);
	request.signal?.addEventListener("abort", abort, { once: true });
	let timedOut = false;
	const timeout = setTimeout(() => {
		timedOut = true;
		controller.abort();
	}, request.timeoutMs ?? DEFAULT_TIMEOUT_MS);

	let response: Response;
	try {
		response = await (request.fetch ?? globalThis.fetch)(buildUrl(request.baseUrl, request.path), {
			method: "POST",
			headers: buildHeaders(request.apiKey, request.headers),
			body: JSON.stringify(request.body),
			signal: controller.signal,
		});
	} catch (error) {
		request.signal?.removeEventListener("abort", abort);
		if (request.signal?.aborted) throw error;
		if (timedOut) throw new OpenAIHttpError(undefined, undefined, "Request timed out.", undefined);
		throw new OpenAIHttpError(undefined, undefined, "Connection error.", undefined, { cause: error });
	} finally {
		clearTimeout(timeout);
	}

	if (!response.ok) {
		request.signal?.removeEventListener("abort", abort);
		const text = await response.text().catch((error: unknown) => String(error));
		const json = parseJson(text) as { error?: unknown } | undefined;
		throw new OpenAIHttpError(response.status, json?.error, json ? undefined : text, response.headers);
	}

	const body = response.body;
	if (!body) {
		request.signal?.removeEventListener("abort", abort);
		throw new OpenAIHttpError(undefined, undefined, "Attempted to iterate over a response with no body", undefined);
	}

	async function* events(): AsyncGenerator<TEvent> {
		let done = false;
		try {
			for await (const message of readServerSentEvents(body!)) {
				if (message.data.startsWith("[DONE]")) {
					done = true;
					break;
				}
				const data = JSON.parse(message.data) as { error?: unknown };
				if (message.event === "error") {
					throw new OpenAIHttpError(undefined, data.error, (data as { message?: string }).message, undefined);
				}
				if (data?.error) {
					throw new OpenAIHttpError(undefined, data.error, undefined, response.headers);
				}
				yield data as TEvent;
			}
			done = true;
		} catch (error) {
			if (isAbortError(error)) return;
			throw error;
		} finally {
			request.signal?.removeEventListener("abort", abort);
			if (!done) controller.abort();
		}
	}

	return { response, events: events() };
}

interface ServerSentEvent {
	event: string | null;
	data: string;
}

async function* readServerSentEvents(body: ReadableStream<Uint8Array>): AsyncGenerator<ServerSentEvent> {
	const decoder = new TextDecoder();
	let buffer = "";
	let event: string | null = null;
	let data: string[] = [];

	const takeMessage = (): ServerSentEvent | undefined => {
		if (event === null && data.length === 0) return undefined;
		const message = { event, data: data.join("\n") };
		event = null;
		data = [];
		return message.data.length > 0 ? message : undefined;
	};

	const handleLine = (line: string): ServerSentEvent | undefined => {
		if (line === "") return takeMessage();
		if (line.startsWith(":")) return undefined;
		const colon = line.indexOf(":");
		const field = colon === -1 ? line : line.slice(0, colon);
		let value = colon === -1 ? "" : line.slice(colon + 1);
		if (value.startsWith(" ")) value = value.slice(1);
		if (field === "event") event = value;
		else if (field === "data") data.push(value);
		return undefined;
	};

	for await (const chunk of body) {
		buffer += decoder.decode(chunk, { stream: true });
		let match = /\r\n|\n|\r/.exec(buffer);
		while (match) {
			if (match[0] === "\r" && match.index === buffer.length - 1) break;
			const line = buffer.slice(0, match.index);
			buffer = buffer.slice(match.index + match[0].length);
			const message = handleLine(line);
			if (message) yield message;
			match = /\r\n|\n|\r/.exec(buffer);
		}
	}
	buffer += decoder.decode();
	if (buffer.length > 0) {
		const message = handleLine(buffer);
		if (message) yield message;
	}
	const message = takeMessage();
	if (message) yield message;
}
