import type { OpenAIStreamRequest } from "../src/api/openai-http.ts";
import type { FetchFunction } from "../src/types.ts";

interface FakeCreate {
	(
		params: any,
		options: { signal?: AbortSignal; timeout?: number },
	): {
		withResponse(): Promise<{ data: AsyncIterable<unknown>; response: { status: number; headers: Headers } }>;
	};
}

interface FakeClient {
	chat?: { completions: { create: FakeCreate } };
	responses?: { create: FakeCreate };
}

interface FakeClientOptions {
	apiKey: string;
	baseURL: string;
	defaultHeaders: OpenAIStreamRequest["headers"];
	fetch?: FetchFunction;
}

export function openAIHttpModule(createClient: (options: FakeClientOptions) => FakeClient) {
	return {
		postOpenAIStream: async (request: OpenAIStreamRequest) => {
			const client = createClient({
				apiKey: request.apiKey,
				baseURL: request.baseUrl,
				defaultHeaders: request.headers,
				fetch: request.fetch,
			});
			const create = request.path === "/responses" ? client.responses?.create : client.chat?.completions.create;
			if (!create) throw new Error(`No fake handler for ${request.path}`);
			const { data, response } = await create(request.body, {
				signal: request.signal,
				timeout: request.timeoutMs,
			}).withResponse();
			return { response, events: data };
		},
	};
}
