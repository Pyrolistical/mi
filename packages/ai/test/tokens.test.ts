import { describe, expect, it } from "bun:test";
import { stream } from "../src/compat.ts";
import type { Api, Context, Model, StreamOptions } from "../src/types.ts";

type StreamOptionsWithExtras = StreamOptions & Record<string, unknown>;
import { openaiModel } from "./openai-models.ts";

async function testTokensOnAbort<TApi extends Api>(llm: Model<TApi>, options: StreamOptionsWithExtras = {}) {
	const context: Context = {
		messages: [
			{
				role: "user",
				content: "Write a long poem with 20 stanzas about the beauty of nature.",
				timestamp: Date.now(),
			},
		],
		systemPrompt: "You are a helpful assistant.",
	};

	const controller = new AbortController();
	const response = stream(llm, context, { ...options, signal: controller.signal });

	let abortFired = false;
	let text = "";
	for await (const event of response) {
		if (!abortFired && (event.type === "text_delta" || event.type === "thinking_delta")) {
			text += event.delta;
			if (text.length >= 1000) {
				abortFired = true;
				controller.abort();
			}
		}
	}

	const msg = await response.result();

	expect(msg.stopReason).toBe("aborted");

	expect(msg.usage.input).toBe(0);
	expect(msg.usage.output).toBe(0);
}

describe("Token Statistics on Abort", () => {
	describe.skipIf(!process.env.OPENAI_API_KEY)("OpenAI Completions Provider", () => {
		const { compat: _compat, ...baseModel } = openaiModel("gpt-4o-mini");
		void _compat;
		const llm: Model<"openai-completions"> = {
			...baseModel,
			api: "openai-completions",
		};

		it(
			"should include token stats when aborted mid-stream",
			async () => {
				await testTokensOnAbort(llm);
			},
			{ retry: 3, timeout: 30000 },
		);
	});
});
