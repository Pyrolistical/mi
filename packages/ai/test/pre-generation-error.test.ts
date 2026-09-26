import { describe, expect, it } from "bun:test";
import { streamSimple as streamOpenAICompletions } from "../src/api/openai-completions.ts";
import type { Api, AssistantMessageEventStream, Model } from "../src/types.ts";
import { normalizeContext } from "../src/utils/transcript.ts";

function model<TApi extends Api>(api: TApi): Model<TApi> {
	return {
		id: "test-model",
		name: "Test",
		api,
		provider: "test-provider",
		baseUrl: "https://example.invalid",
		reasoning: false,
		input: ["text"],
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
		contextWindow: 1_000,
		maxTokens: 100,
	};
}

function expectMissingAuthThrows(create: () => AssistantMessageEventStream): void {
	expect(create).toThrow("No API key for provider: test-provider");
}

describe("direct API authentication", () => {
	it("throws synchronously when auth is missing", () => {
		const context = normalizeContext({ messages: [] });
		expectMissingAuthThrows(() => streamOpenAICompletions(model("openai-completions"), context, {}));
	});
});
