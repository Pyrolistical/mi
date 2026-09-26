import { describe, expect, it } from "bun:test";
import { complete } from "../src/compat.ts";
import type { Api, AssistantMessage, Context, Model, StreamOptions, UserMessage } from "../src/types.ts";

type StreamOptionsWithExtras = StreamOptions & Record<string, unknown>;
import { openaiModel } from "./openai-models.ts";

async function testEmptyMessage<TApi extends Api>(llm: Model<TApi>, options: StreamOptionsWithExtras = {}) {
	const emptyMessage: UserMessage = {
		role: "user",
		content: [],
		timestamp: Date.now(),
	};

	const context: Context = {
		messages: [emptyMessage],
	};

	const response = await complete(llm, context, options);

	expect(response).toBeDefined();
	expect(response.role).toBe("assistant");
	if (response.stopReason === "error") {
		expect(response.errorMessage).toBeDefined();
	} else {
		expect(response.content).toBeDefined();
	}
}

async function testEmptyStringMessage<TApi extends Api>(llm: Model<TApi>, options: StreamOptionsWithExtras = {}) {
	const context: Context = {
		messages: [
			{
				role: "user",
				content: "",
				timestamp: Date.now(),
			},
		],
	};

	const response = await complete(llm, context, options);

	expect(response).toBeDefined();
	expect(response.role).toBe("assistant");

	if (response.stopReason === "error") {
		expect(response.errorMessage).toBeDefined();
	} else {
		expect(response.content).toBeDefined();
	}
}

async function testWhitespaceOnlyMessage<TApi extends Api>(llm: Model<TApi>, options: StreamOptionsWithExtras = {}) {
	const context: Context = {
		messages: [
			{
				role: "user",
				content: "   \n\t  ",
				timestamp: Date.now(),
			},
		],
	};

	const response = await complete(llm, context, options);

	expect(response).toBeDefined();
	expect(response.role).toBe("assistant");

	if (response.stopReason === "error") {
		expect(response.errorMessage).toBeDefined();
	} else {
		expect(response.content).toBeDefined();
	}
}

async function testEmptyAssistantMessage<TApi extends Api>(llm: Model<TApi>, options: StreamOptionsWithExtras = {}) {
	const emptyAssistant: AssistantMessage = {
		role: "assistant",
		content: [],
		api: llm.api,
		provider: llm.provider,
		model: llm.id,
		usage: {
			input: 10,
			output: 0,
			cacheRead: 0,
			cacheWrite: 0,
			totalTokens: 10,
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
		},
		stopReason: "stop",
		timestamp: Date.now(),
	};

	const context: Context = {
		messages: [
			{
				role: "user",
				content: "Hello, how are you?",
				timestamp: Date.now(),
			},
			emptyAssistant,
			{
				role: "user",
				content: "Please respond this time.",
				timestamp: Date.now(),
			},
		],
	};

	const response = await complete(llm, context, options);

	expect(response).toBeDefined();
	expect(response.role).toBe("assistant");

	if (response.stopReason === "error") {
		expect(response.errorMessage).toBeDefined();
	} else {
		expect(response.content).toBeDefined();
		expect(response.content.length).toBeGreaterThan(0);
	}
}

describe("AI Providers Empty Message Tests", () => {
	describe.skipIf(!process.env.OPENAI_API_KEY)("OpenAI Completions Provider Empty Messages", () => {
		const llm = openaiModel("gpt-4o-mini");

		it(
			"should handle empty content array",
			async () => {
				await testEmptyMessage(llm);
			},
			{ retry: 3, timeout: 30000 },
		);

		it(
			"should handle empty string content",
			async () => {
				await testEmptyStringMessage(llm);
			},
			{ retry: 3, timeout: 30000 },
		);

		it(
			"should handle whitespace-only content",
			async () => {
				await testWhitespaceOnlyMessage(llm);
			},
			{ retry: 3, timeout: 30000 },
		);

		it(
			"should handle empty assistant message in conversation",
			async () => {
				await testEmptyAssistantMessage(llm);
			},
			{ retry: 3, timeout: 30000 },
		);
	});
});
