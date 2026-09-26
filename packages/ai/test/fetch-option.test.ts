import { afterEach, describe, expect, it, vi } from "bun:test";
import { streamSimple as streamOpenAICompletions } from "../src/api/openai-completions.ts";
import type { Api, FetchFunction, Model } from "../src/types.ts";
import { normalizeContext } from "../src/utils/transcript.ts";

const context = normalizeContext({
	messages: [{ role: "user", content: "hello", timestamp: 1 }],
});

function createModel<TApi extends Api>(api: TApi): Model<TApi> {
	return {
		id: "test-model",
		name: "Test Model",
		api,
		provider: "test-provider",
		baseUrl: "https://upstream.test/v1",
		reasoning: false,
		input: ["text"],
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
		contextWindow: 10_000,
		maxTokens: 1_000,
	};
}

function mockFetches() {
	const fallback = vi.spyOn(globalThis, "fetch").mockRejectedValue(new Error("ambient fetch must not be called"));
	const custom = vi.fn<FetchFunction>(
		async () =>
			new Response(JSON.stringify({ error: { message: "upstream rejected request" } }), {
				status: 401,
				headers: { "content-type": "application/json" },
			}),
	);
	return { custom, fallback };
}

afterEach(() => {
	vi.restoreAllMocks();
});

describe("fetch stream option", () => {
	it("passes fetch through streamSimple to OpenAI adapters", async () => {
		const adapters = [
			() =>
				streamOpenAICompletions(createModel("openai-completions"), context, {
					apiKey: "test-key",
					fetch: custom,
					maxRetries: 0,
				}).result(),
		];
		const { custom, fallback } = mockFetches();
		for (const run of adapters) {
			await run();
		}
		expect(custom).toHaveBeenCalledTimes(adapters.length);
		expect(fallback).not.toHaveBeenCalled();
		expect<unknown>(globalThis.fetch).toBe(fallback);
	});
});
