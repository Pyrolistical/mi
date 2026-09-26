import { Type } from "typebox";
import { describe, expect, it } from "vitest";
import { complete } from "../src/compat.ts";
import type { Api, Context, Model, StreamOptions, ToolResultMessage } from "../src/types.ts";

type StreamOptionsWithExtras = StreamOptions & Record<string, unknown>;
import { openaiModel } from "./openai-models.ts";

const emptySchema = Type.Object({});

async function testEmojiInToolResults<TApi extends Api>(llm: Model<TApi>, options: StreamOptionsWithExtras = {}) {
	const toolCallId = llm.provider === "mistral" ? "testtool1" : "test_1";
	const context: Context = {
		systemPrompt: "You are a helpful assistant.",
		messages: [
			{
				role: "user",
				content: "Use the test tool",
				timestamp: Date.now(),
			},
			{
				role: "assistant",
				content: [
					{
						type: "toolCall",
						id: toolCallId,
						name: "test_tool",
						arguments: {},
					},
				],
				api: llm.api,
				provider: llm.provider,
				model: llm.id,
				usage: {
					input: 0,
					output: 0,
					cacheRead: 0,
					cacheWrite: 0,
					totalTokens: 0,
					cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
				},
				stopReason: "toolUse",
				timestamp: Date.now(),
			},
		],
		tools: [
			{
				name: "test_tool",
				description: "A test tool",
				parameters: emptySchema,
			},
		],
	};

	const toolResult: ToolResultMessage = {
		role: "toolResult",
		toolCallId: toolCallId,
		toolName: "test_tool",
		content: [
			{
				type: "text",
				text: `Test with emoji 🙈 and other characters:
- Monkey emoji: 🙈
- Thumbs up: 👍
- Heart: ❤️
- Thinking face: 🤔
- Rocket: 🚀
- Mixed text: Mario Zechner wann? Wo? Bin grad äußersr eventuninformiert 🙈
- Japanese: こんにちは
- Chinese: 你好
- Mathematical symbols: ∑∫∂√
- Special quotes: "curly" 'quotes'`,
			},
		],
		isError: false,
		timestamp: Date.now(),
	};

	context.messages.push(toolResult);

	context.messages.push({
		role: "user",
		content: "Summarize the tool result briefly.",
		timestamp: Date.now(),
	});

	const response = await complete(llm, context, options);

	expect(response.stopReason).not.toBe("error");
	expect(response.errorMessage).toBeFalsy();
	expect(response.content.length).toBeGreaterThan(0);
}

async function testRealWorldLinkedInData<TApi extends Api>(llm: Model<TApi>, options: StreamOptionsWithExtras = {}) {
	const toolCallId = llm.provider === "mistral" ? "linkedin1" : "linkedin_1";
	const context: Context = {
		systemPrompt: "You are a helpful assistant.",
		messages: [
			{
				role: "user",
				content: "Use the linkedin tool to get comments",
				timestamp: Date.now(),
			},
			{
				role: "assistant",
				content: [
					{
						type: "toolCall",
						id: toolCallId,
						name: "linkedin_skill",
						arguments: {},
					},
				],
				api: llm.api,
				provider: llm.provider,
				model: llm.id,
				usage: {
					input: 0,
					output: 0,
					cacheRead: 0,
					cacheWrite: 0,
					totalTokens: 0,
					cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
				},
				stopReason: "toolUse",
				timestamp: Date.now(),
			},
		],
		tools: [
			{
				name: "linkedin_skill",
				description: "Get LinkedIn comments",
				parameters: emptySchema,
			},
		],
	};

	const toolResult: ToolResultMessage = {
		role: "toolResult",
		toolCallId: toolCallId,
		toolName: "linkedin_skill",
		content: [
			{
				type: "text",
				text: `Post: Hab einen "Generative KI für Nicht-Techniker" Workshop gebaut.
Unanswered Comments: 2

=> {
  "comments": [
    {
      "author": "Matthias Neumayer's  graphic link",
      "text": "Leider nehmen das viel zu wenige Leute ernst"
    },
    {
      "author": "Matthias Neumayer's  graphic link",
      "text": "Mario Zechner wann? Wo? Bin grad äußersr eventuninformiert 🙈"
    }
  ]
}`,
			},
		],
		isError: false,
		timestamp: Date.now(),
	};

	context.messages.push(toolResult);

	context.messages.push({
		role: "user",
		content: "How many comments are there?",
		timestamp: Date.now(),
	});

	const response = await complete(llm, context, options);

	expect(response.stopReason).not.toBe("error");
	expect(response.errorMessage).toBeFalsy();
	expect(response.content.some((b) => b.type === "text")).toBe(true);
}

async function testUnpairedHighSurrogate<TApi extends Api>(llm: Model<TApi>, options: StreamOptionsWithExtras = {}) {
	const toolCallId = llm.provider === "mistral" ? "testtool2" : "test_2";
	const context: Context = {
		systemPrompt: "You are a helpful assistant.",
		messages: [
			{
				role: "user",
				content: "Use the test tool",
				timestamp: Date.now(),
			},
			{
				role: "assistant",
				content: [
					{
						type: "toolCall",
						id: toolCallId,
						name: "test_tool",
						arguments: {},
					},
				],
				api: llm.api,
				provider: llm.provider,
				model: llm.id,
				usage: {
					input: 0,
					output: 0,
					cacheRead: 0,
					cacheWrite: 0,
					totalTokens: 0,
					cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
				},
				stopReason: "toolUse",
				timestamp: Date.now(),
			},
		],
		tools: [
			{
				name: "test_tool",
				description: "A test tool",
				parameters: emptySchema,
			},
		],
	};

	const unpairedSurrogate = String.fromCharCode(0xd83d);

	const toolResult: ToolResultMessage = {
		role: "toolResult",
		toolCallId: toolCallId,
		toolName: "test_tool",
		content: [{ type: "text", text: `Text with unpaired surrogate: ${unpairedSurrogate} <- should be sanitized` }],
		isError: false,
		timestamp: Date.now(),
	};

	context.messages.push(toolResult);

	context.messages.push({
		role: "user",
		content: "What did the tool return?",
		timestamp: Date.now(),
	});

	const response = await complete(llm, context, options);

	expect(response.stopReason).not.toBe("error");
	expect(response.errorMessage).toBeFalsy();
	expect(response.content.length).toBeGreaterThan(0);
}

describe("AI Providers Unicode Surrogate Pair Tests", () => {
	describe.skipIf(!process.env.OPENAI_API_KEY)("OpenAI Completions Provider Unicode Handling", () => {
		const llm = openaiModel("gpt-4o-mini");

		it("should handle emoji in tool results", { retry: 3, timeout: 30000 }, async () => {
			await testEmojiInToolResults(llm);
		});

		it("should handle real-world LinkedIn comment data with emoji", { retry: 3, timeout: 30000 }, async () => {
			await testRealWorldLinkedInData(llm);
		});

		it("should handle unpaired high surrogate (0xD83D) in tool results", { retry: 3, timeout: 30000 }, async () => {
			await testUnpairedHighSurrogate(llm);
		});
	});
});
