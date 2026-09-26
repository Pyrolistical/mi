import { Type } from "typebox";
import { describe, expect, it } from "vitest";
import { complete } from "../src/compat.ts";
import type { Api, Context, Model, StreamOptions, Tool } from "../src/types.ts";

type StreamOptionsWithExtras = StreamOptions & Record<string, unknown>;
import { openaiModel } from "./openai-models.ts";

const calculateSchema = Type.Object({
	expression: Type.String({ description: "The mathematical expression to evaluate" }),
});

const calculateTool: Tool = {
	name: "calculate",
	description: "Evaluate mathematical expressions",
	parameters: calculateSchema,
};

async function testToolCallWithoutResult<TApi extends Api>(model: Model<TApi>, options: StreamOptionsWithExtras = {}) {
	const context: Context = {
		systemPrompt: "You are a helpful assistant. Use the calculate tool when asked to perform calculations.",
		messages: [],
		tools: [calculateTool],
	};

	context.messages.push({
		role: "user",
		content: "Please calculate 25 * 18 using the calculate tool.",
		timestamp: Date.now(),
	});

	const firstResponse = await complete(model, context, options);
	context.messages.push(firstResponse);

	console.log("First response:", JSON.stringify(firstResponse, null, 2));

	const hasToolCall = firstResponse.content.some((block) => block.type === "toolCall");
	expect(hasToolCall).toBe(true);

	if (!hasToolCall) {
		throw new Error("Expected assistant to make a tool call, but none was found");
	}

	context.messages.push({
		role: "user",
		content: "Never mind, just tell me what is 2+2?",
		timestamp: Date.now(),
	});

	const secondResponse = await complete(model, context, options);
	console.log("Second response:", JSON.stringify(secondResponse, null, 2));

	expect(secondResponse.stopReason).not.toBe("error");

	expect(secondResponse.content.length).toBeGreaterThan(0);

	const textContent = secondResponse.content
		.filter((block) => block.type === "text")
		.map((block) => (block.type === "text" ? block.text : ""))
		.join(" ");
	const toolCalls = secondResponse.content.filter((block) => block.type === "toolCall").length;
	expect(toolCalls || textContent.length).toBeGreaterThan(0);
	console.log("Answer:", textContent);

	expect(["stop", "toolUse"]).toContain(secondResponse.stopReason);
}

describe("Tool Call Without Result Tests", () => {
	describe.skipIf(!process.env.OPENAI_API_KEY)("OpenAI Completions Provider", () => {
		const { compat: _compat, ...baseModel } = openaiModel("gpt-4o-mini");
		void _compat;
		const model: Model<"openai-completions"> = {
			...baseModel,
			api: "openai-completions",
		};

		it("should filter out tool calls without corresponding tool results", { retry: 3, timeout: 30000 }, async () => {
			await testToolCallWithoutResult(model);
		});
	});
});
