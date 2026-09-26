export type LlamaModelStatus = "unloaded" | "loading" | "loaded" | "downloading" | "sleeping";

export interface LlamaModelInfo {
	id: string;
	aliases?: string[];
	status: {
		value: LlamaModelStatus;
		args?: string[];
		failed?: boolean;
		exit_code?: number;
		progress?: Record<string, { done: number; total: number }>;
	};
	architecture?: {
		input_modalities?: string[];
		output_modalities?: string[];
	};
	source?: string;
	meta?: {
		n_ctx?: number;
		n_ctx_train?: number;
		size?: number;
		ftype?: string;
	};
}

export interface LlamaServerProps {
	models_autoload?: boolean;
	chat_template?: string;
}

function errorMessage(payload: unknown, fallback: string): string {
	if (typeof payload !== "object" || payload === null) return fallback;
	const error = (payload as { error?: unknown }).error;
	if (typeof error !== "object" || error === null) return fallback;
	const message = (error as { message?: unknown }).message;
	return typeof message === "string" && message ? message : fallback;
}

function isModelInfo(value: unknown): value is LlamaModelInfo {
	if (typeof value !== "object" || value === null) return false;
	const candidate = value as { id?: unknown; status?: { value?: unknown } };
	return typeof candidate.id === "string" && typeof candidate.status?.value === "string";
}

export function normalizeLlamaServerUrl(value: string): string {
	const url = new URL(value.trim());
	if (url.protocol !== "http:" && url.protocol !== "https:") {
		throw new Error("Server URL must use http or https");
	}
	url.hash = "";
	url.search = "";
	url.pathname = url.pathname.replace(/\/+$/u, "").replace(/\/v1$/u, "") || "/";
	return url.toString().replace(/\/$/u, "");
}

export function llamaInferenceUrl(serverUrl: string): string {
	return `${normalizeLlamaServerUrl(serverUrl)}/v1`;
}

export class LlamaClient {
	readonly serverUrl: string;
	private readonly apiKey: string | undefined;

	constructor(serverUrl: string, apiKey?: string) {
		this.serverUrl = normalizeLlamaServerUrl(serverUrl);
		this.apiKey = apiKey;
	}

	private async request(path: string, init: RequestInit = {}): Promise<unknown> {
		const headers = new Headers(init.headers);
		if (this.apiKey) headers.set("Authorization", `Bearer ${this.apiKey}`);
		const timeout = AbortSignal.timeout(15_000);
		const signal = init.signal ? AbortSignal.any([init.signal, timeout]) : timeout;
		const response = await fetch(`${this.serverUrl}${path}`, { ...init, headers, signal });
		let payload: unknown;
		try {
			payload = await response.json();
		} catch {
			payload = undefined;
		}
		if (!response.ok) throw new Error(errorMessage(payload, `llama.cpp returned HTTP ${response.status}`));
		return payload;
	}

	async list(options: { signal?: AbortSignal } = {}): Promise<LlamaModelInfo[]> {
		const payload = await this.request("/models", { signal: options.signal });
		if (typeof payload !== "object" || payload === null || !Array.isArray((payload as { data?: unknown }).data)) {
			throw new Error("llama.cpp returned an invalid model catalog");
		}
		const data = (payload as { data: unknown[] }).data;
		if (!data.every(isModelInfo)) throw new Error("Server is not running in llama.cpp router mode");
		return data;
	}

	async props(options: { model?: string; signal?: AbortSignal } = {}): Promise<LlamaServerProps> {
		const query = options.model ? `?${new URLSearchParams({ model: options.model, autoload: "false" })}` : "";
		const payload = await this.request(`/props${query}`, { signal: options.signal });
		if (typeof payload !== "object" || payload === null) return {};
		const { models_autoload: modelsAutoload, chat_template: chatTemplate } = payload as Record<string, unknown>;
		return {
			...(typeof modelsAutoload === "boolean" ? { models_autoload: modelsAutoload } : {}),
			...(typeof chatTemplate === "string" ? { chat_template: chatTemplate } : {}),
		};
	}
}
