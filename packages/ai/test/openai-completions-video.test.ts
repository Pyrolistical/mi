import { describe, expect, it, vi } from "bun:test";
import { convertMessages, streamSimple } from "../src/api/openai-completions.ts";
import type { AssistantMessage, FetchFunction, Model, OpenAICompletionsCompat } from "../src/types.ts";
import { normalizeContext } from "../src/utils/transcript.ts";

const compat: Omit<Required<OpenAICompletionsCompat>, "thinkingTokenBudgetField" | "vllmPriority"> = {
	supportsStore: false,
	supportsDeveloperRole: false,
	supportsReasoningEffort: true,
	supportsUsageInStreaming: true,
	supportsFinishReason: true,
	maxTokensField: "max_tokens",
	requiresToolResultName: false,
	requiresAssistantAfterToolResult: false,
	requiresThinkingAsText: false,
	thinkingFormat: "openai",
	openRouterRouting: {},
	chatTemplateKwargs: {},
	supportsThinkingTokenBudget: false,
	supportsStrictMode: false,
	supportsOpenAIGrammarTools: false,
	supportsMidConvoSystemMessages: false,
	supportsMidConvoToolAdditions: false,
	cacheControlFormat: "anthropic",
	sendSessionAffinityHeaders: false,
	sessionAffinityFormat: "openai",
	supportsLongCacheRetention: false,
};

function llamaModel(input: Model<"openai-completions">["input"]): Model<"openai-completions"> {
	return {
		id: "qwen",
		name: "qwen",
		api: "openai-completions",
		provider: "local",
		baseUrl: "http://127.0.0.1:8080/v1",
		reasoning: false,
		input,
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
		contextWindow: 10_000,
		maxTokens: 10_000,
	};
}

describe("openai-completions video input", () => {
	it("sends user videos as input_video parts", () => {
		const context = normalizeContext({
			messages: [
				{
					role: "user",
					content: [
						{ type: "text", text: "describe" },
						{ type: "video", data: "dmlkZW8=", mimeType: "video/mp4" },
					],
					timestamp: 1,
				},
			],
		});

		expect(convertMessages(llamaModel(["text", "video"]), context, compat)).toEqual([
			{
				role: "user",
				content: [
					{ type: "text", text: "describe" },
					{ type: "input_video", input_video: { url: "data:video/mp4;base64,dmlkZW8=" } },
				],
			},
		]);
	});

	it("attaches tool-result videos in a follow-up user message", () => {
		const model = llamaModel(["text", "video"]);
		const assistant: AssistantMessage = {
			role: "assistant",
			content: [{ type: "toolCall", id: "tool-1", name: "read", arguments: { path: "clip.mp4" } }],
			api: model.api,
			provider: model.provider,
			model: model.id,
			usage: {
				input: 0,
				output: 0,
				cacheRead: 0,
				cacheWrite: 0,
				totalTokens: 0,
				cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
			},
			stopReason: "toolUse",
			timestamp: 2,
		};
		const context = normalizeContext({
			messages: [
				{ role: "user", content: "watch clip.mp4", timestamp: 1 },
				assistant,
				{
					role: "toolResult",
					toolCallId: "tool-1",
					toolName: "read",
					content: [{ type: "video", data: "dmlkZW8=", mimeType: "video/webm" }],
					isError: false,
					timestamp: 3,
				},
			],
		});

		expect(convertMessages(model, context, compat).slice(2)).toEqual([
			{ role: "tool", content: "(see attached video)", tool_call_id: "tool-1" },
			{
				role: "user",
				content: [
					{ type: "text", text: "Attached video(s) from tool result:" },
					{ type: "input_video", input_video: { url: "data:video/webm;base64,dmlkZW8=" } },
				],
			},
		]);
	});

	it("replaces videos with a placeholder for models without video input", () => {
		const context = normalizeContext({
			messages: [
				{
					role: "user",
					content: [
						{ type: "video", data: "dmlkZW8=", mimeType: "video/mp4" },
						{ type: "image", data: "aW1hZ2U=", mimeType: "image/png" },
					],
					timestamp: 1,
				},
			],
		});

		expect(convertMessages(llamaModel(["text", "image"]), context, compat)).toEqual([
			{
				role: "user",
				content: [
					{ type: "text", text: "(video omitted: model does not support video)" },
					{ type: "image_url", image_url: { url: "data:image/png;base64,aW1hZ2U=" } },
				],
			},
		]);
	});

	it("sends no authorization header when auth removes it", async () => {
		const fetch = vi.fn<FetchFunction>(
			async () => new Response(JSON.stringify({ error: { message: "stop" } }), { status: 400 }),
		);
		const context = normalizeContext({ messages: [{ role: "user", content: "hello", timestamp: 1 }] });

		await streamSimple(llamaModel(["text"]), context, {
			headers: { Authorization: null },
			fetch,
			maxRetries: 0,
		}).result();

		const init = fetch.mock.calls[0]?.[1];
		expect(new Headers(init?.headers).has("authorization")).toBe(false);
	});
});
