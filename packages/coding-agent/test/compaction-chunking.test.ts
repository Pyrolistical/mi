import type { AgentMessage } from "@earendil-works/pi-agent-core";
import type { AssistantMessage, Model, TranscriptContext } from "@earendil-works/pi-ai";
import * as piAiCompat from "@earendil-works/pi-ai/compat";
import { beforeEach, describe, expect, it, vi } from "bun:test";
import { type CompactionPreparation, compact, generateSummaryWithUsage } from "../src/core/compaction/index.ts";
import { SUMMARIZATION_SYSTEM_PROMPT, takeConversationChunk } from "../src/core/compaction/utils.ts";

const { completeSimpleMock } = {
	completeSimpleMock: vi.fn(),
};

const countCharsAsTokens = async (text: string): Promise<number> => text.length;

const actualPiAiCompat = { ...piAiCompat };
vi.mock("@earendil-works/pi-ai/compat", () => ({
	...actualPiAiCompat,
	completeSimple: completeSimpleMock,
}));

const model: Model<"openai-completions"> = {
	id: "small-window-model",
	name: "Small Window Model",
	api: "openai-completions",
	provider: "llama",
	baseUrl: "http://localhost:8080/v1",
	reasoning: false,
	input: ["text"],
	cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
	contextWindow: 30000,
	maxTokens: 8192,
};

function summaryResponse(text: string): AssistantMessage {
	return {
		role: "assistant",
		content: [{ type: "text", text }],
		api: "openai-completions",
		provider: "llama",
		model: "small-window-model",
		usage: {
			input: 10,
			output: 5,
			cacheRead: 0,
			cacheWrite: 0,
			totalTokens: 15,
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
		},
		stopReason: "stop",
		timestamp: 1,
	};
}

function measuredPromptTokensOf(callIndex: number): { sent: number; counted: number } {
	const context = completeSimpleMock.mock.calls[callIndex][1] as TranscriptContext;
	const user = context.messages.find((message) => message.role === "user")!;
	const text = (user.content as { type: "text"; text: string }[])[0].text;
	return {
		sent: completeSimpleMock.mock.calls[callIndex][2].contextTokens,
		counted: SUMMARIZATION_SYSTEM_PROMPT.length + text.length,
	};
}

function promptOf(callIndex: number): string {
	const context = completeSimpleMock.mock.calls[callIndex][1] as TranscriptContext;
	return JSON.stringify(context.messages);
}

describe("takeConversationChunk", () => {
	it("packs whole parts up to the limit", () => {
		expect(takeConversationChunk(["ab", "cd", "ef"], 6)).toEqual({ text: "ab\n\ncd", rest: ["ef"] });
	});

	it("splits a part larger than the limit", () => {
		expect(takeConversationChunk(["abcdef", "gh"], 4)).toEqual({ text: "abcd", rest: ["ef", "gh"] });
	});
});

describe("chunked summarization", () => {
	beforeEach(() => {
		completeSimpleMock.mockReset();
		completeSimpleMock
			.mockResolvedValueOnce(summaryResponse("summary of a and b"))
			.mockResolvedValueOnce(summaryResponse("summary of a, b and c"));
	});

	it("folds the messages that do not fit the context window into the previous summary", async () => {
		const messages: AgentMessage[] = [
			{ role: "user", content: "a".repeat(10000), timestamp: 1 },
			{ role: "user", content: "b".repeat(10000), timestamp: 2 },
			{ role: "user", content: "c".repeat(10000), timestamp: 3 },
		];

		const result = await generateSummaryWithUsage(
			messages,
			model,
			2000,
			undefined,
			undefined,
			undefined,
			undefined,
			undefined,
			undefined,
			undefined,
			undefined,
			undefined,
			undefined,
			undefined,
			countCharsAsTokens,
		);

		expect(result.text).toBe("summary of a, b and c");
		expect(result.usage.totalTokens).toBe(30);
		expect(completeSimpleMock).toHaveBeenCalledTimes(2);
		expect(promptOf(0)).toContain("a".repeat(10000));
		expect(promptOf(0)).toContain("b".repeat(10000));
		expect(promptOf(0)).not.toContain("ccc");
		expect(promptOf(0)).not.toContain("<previous-summary>");
		expect(promptOf(1)).not.toContain("aaa");
		expect(promptOf(1)).toContain("c".repeat(10000));
		expect(promptOf(1)).toContain("<previous-summary>\\nsummary of a and b\\n</previous-summary>");
		expect(measuredPromptTokensOf(0)).toEqual({ sent: 21240, counted: 21240 });
		expect(measuredPromptTokensOf(1)).toEqual({ sent: 11667, counted: 11667 });
	});

	it("folds a split turn prefix that does not fit the context window into the previous checkpoint", async () => {
		const preparation: CompactionPreparation = {
			firstKeptEntryId: "entry-keep",
			messagesToSummarize: [],
			turnPrefixMessages: [
				{ role: "user", content: "a".repeat(10000), timestamp: 1 },
				{ role: "user", content: "b".repeat(10000), timestamp: 2 },
				{ role: "user", content: "c".repeat(10000), timestamp: 3 },
			],
			isSplitTurn: true,
			tokensBefore: 7500,
			previousSummary: "earlier history",
			fileOps: { read: new Set(), written: new Set(), edited: new Set() },
			settings: { enabled: true, reserveTokens: 2000, keepRecentTokens: 20 },
		};

		const result = await compact(
			preparation,
			model,
			undefined,
			undefined,
			undefined,
			undefined,
			undefined,
			undefined,
			undefined,
			undefined,
			undefined,
			undefined,
			countCharsAsTokens,
		);

		expect(result.summary).toBe("earlier history\n\n---\n\n**Turn Context (split turn):**\n\nsummary of a, b and c");
		expect(completeSimpleMock).toHaveBeenCalledTimes(2);
		expect(promptOf(0)).toContain("b".repeat(10000));
		expect(promptOf(0)).not.toContain("<previous-checkpoint>");
		expect(promptOf(1)).toContain("c".repeat(10000));
		expect(promptOf(1)).toContain("<previous-checkpoint>\\nsummary of a and b\\n</previous-checkpoint>");
	});
});
