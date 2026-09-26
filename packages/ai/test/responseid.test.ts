import { describe, expect, it } from "bun:test";
import { complete } from "../src/compat.ts";
import type { Api, Context, Model, StreamOptions } from "../src/types.ts";
import { openaiModel } from "./openai-models.ts";

type StreamOptionsWithExtras = StreamOptions & Record<string, unknown>;

async function expectResponseId<TApi extends Api>(model: Model<TApi>, options: StreamOptionsWithExtras = {}) {
	const context: Context = {
		systemPrompt: "You are a helpful assistant. Be concise.",
		messages: [{ role: "user", content: "Reply with exactly: response id test", timestamp: Date.now() }],
	};

	const response = await complete(model, context, options);

	expect(response.stopReason, response.errorMessage).not.toBe("error");
	expect(response.responseId).toBeTruthy();
	expect(typeof response.responseId).toBe("string");
}

describe("responseId E2E Tests", () => {
	describe.skipIf(!process.env.OPENAI_API_KEY)("OpenAI Completions Provider", () => {
		const { compat: _compat, ...baseModel } = openaiModel("gpt-4o-mini");
		void _compat;
		const llm: Model<"openai-completions"> = {
			...baseModel,
			api: "openai-completions",
		};

		it(
			"should expose responseId",
			async () => {
				await expectResponseId(llm);
			},
			{ retry: 3, timeout: 30000 },
		);
	});
});
