import { describe, expect, it } from "bun:test";
import { stream } from "../src/compat.ts";
import type { Context, Model } from "../src/types.ts";
import { openaiModel } from "./openai-models.ts";

function makeContext(): Context {
	return {
		messages: [
			{
				role: "user",
				content: `What is ${(Math.random() * 100) | 0} + ${(Math.random() * 100) | 0}? Think step by step.`,
				timestamp: Date.now(),
			},
		],
	};
}

describe.skipIf(!process.env.OPENAI_API_KEY)("xhigh reasoning", () => {
	describe("gpt 5.5 (supports xhigh)", () => {
		it("should work with openai-completions", async () => {
			const model = openaiModel("gpt-5.5");
			const s = stream(model, makeContext(), { reasoningEffort: "xhigh" });
			let hasThinking = false;

			for await (const event of s) {
				if (event.type === "thinking_start" || event.type === "thinking_delta") {
					hasThinking = true;
				}
			}

			const response = await s.result();
			expect(response.stopReason, `Error: ${response.errorMessage}`).toBe("stop");
			expect(response.content.some((b) => b.type === "text")).toBe(true);
			expect(hasThinking || response.content.some((b) => b.type === "thinking")).toBe(true);
		});
	});

	describe("gpt-5-mini (does not support xhigh)", () => {
		it("should error with openai-completions when using xhigh", async () => {
			const { compat: _compat, ...baseModel } = openaiModel("gpt-5-mini");
			void _compat;
			const model: Model<"openai-completions"> = {
				...baseModel,
				api: "openai-completions",
			};
			const s = stream(model, makeContext(), { reasoningEffort: "xhigh" });

			for await (const _ of s) {
			}

			const response = await s.result();
			expect(response.stopReason).toBe("error");
			expect(response.errorMessage).toContain("xhigh");
		});
	});
});
