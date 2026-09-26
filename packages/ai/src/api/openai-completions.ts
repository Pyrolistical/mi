import { postOpenAIStream } from "./openai-http.ts";
import type {
	ChatCompletionAssistantMessageParam,
	ChatCompletionChunk,
	ChatCompletionChunkChoice,
	ChatCompletionContentPart,
	ChatCompletionContentPartImage,
	ChatCompletionContentPartText,
	ChatCompletionContentPartVideo,
	ChatCompletionCreateParamsStreaming,
	ChatCompletionDeveloperMessageParam,
	ChatCompletionMessageParam,
	ChatCompletionMessageToolCall,
	ChatCompletionSystemMessageParam,
	ChatCompletionTool,
	ChatCompletionToolChoiceOption,
	ChatCompletionToolMessageParam,
} from "./openai-types.ts";
import { calculateCost, clampThinkingLevel } from "../models.ts";
import type {
	AssistantMessage,
	CacheRetention,
	ChatTemplateKwargValue,
	JsonValue,
	MediaContent,
	Message,
	Model,
	OpenAICompletionsCompat,
	ProviderEnv,
	ProviderHeaders,
	SimpleStreamOptions,
	StopReason,
	StreamFunction,
	StreamOptions,
	TextContent,
	ThinkingBudgets,
	ThinkingContent,
	ThinkingTokenBudgetField,
	Tool,
	ToolCall,
	ToolResultMessage,
} from "../types.ts";
import { formatProviderError, normalizeProviderError } from "../utils/error-body.ts";
import { AssistantMessageEventStream } from "../utils/event-stream.ts";
import { shortHash } from "../utils/hash.ts";
import { headersToRecord } from "../utils/headers.ts";
import { parseStreamingJson } from "../utils/json-parse.ts";
import { getPiUserAgent } from "../utils/pi-user-agent.ts";
import { getProviderEnvValue } from "../utils/provider-env.ts";
import { retryProviderRequest } from "../utils/provider-retry.ts";
import { sanitizeSurrogates } from "../utils/sanitize-unicode.ts";
import { getSystemMessageText, renderSystemMessageUpdate } from "../utils/text.ts";
import {
	getDeclaredTools,
	resolveTranscript,
	resolveTranscriptTools,
	type TranscriptContext,
} from "../utils/transcript.ts";
import {
	appendGrammarToolInputJsonDelta,
	createGrammarToolInputProperties,
	type GrammarToolInputJsonBuffer,
	getGrammarToolInput,
	getJsonSchemaToolParameters,
	resolveGrammarConstrainedSampling,
	resolveJsonSchemaStrictSampling,
} from "./constrained-sampling.ts";
import { clampOpenAIPromptCacheKey } from "./openai-prompt-cache.ts";
import { buildBaseOptions, clampThinkingBudgetToAnswerRoom, thinkingBudgetForLevel } from "./simple-options.ts";
import { transformMessages } from "./transform-messages.ts";

function hasHeader(headers: ProviderHeaders | undefined, name: string): boolean {
	if (!headers) return false;
	const expected = name.toLowerCase();
	for (const [key, value] of Object.entries(headers)) {
		if (key.toLowerCase() === expected && value !== null && value.trim().length > 0) return true;
	}
	return false;
}

function removesHeader(headers: ProviderHeaders | undefined, name: string): boolean {
	const expected = name.toLowerCase();
	return Object.entries(headers ?? {}).some(([key, value]) => key.toLowerCase() === expected && value === null);
}

function getClientApiKey(provider: string, apiKey: string | undefined, headers: ProviderHeaders | undefined): string {
	if (apiKey) return apiKey;
	if (
		hasHeader(headers, "authorization") ||
		hasHeader(headers, "cf-aig-authorization") ||
		removesHeader(headers, "authorization")
	) {
		return "unused";
	}
	throw new Error(`No API key for provider: ${provider}`);
}

function hasToolHistory(messages: Message[]): boolean {
	for (const msg of messages) {
		if (msg.role === "toolResult") {
			return true;
		}
		if (msg.role === "assistant") {
			if (msg.content.some((block) => block.type === "toolCall")) {
				return true;
			}
		}
	}
	return false;
}

function isTextContentBlock(block: { type: string }): block is TextContent {
	return block.type === "text";
}

function isThinkingContentBlock(block: { type: string }): block is ThinkingContent {
	return block.type === "thinking";
}

function isToolCallBlock(block: { type: string }): block is ToolCall {
	return block.type === "toolCall";
}

function isMediaContentBlock(block: { type: string }): block is MediaContent {
	return block.type === "image" || block.type === "video";
}

function describeMedia(blocks: readonly MediaContent[], pluralSuffix = ""): string {
	const [first] = blocks;
	return first && blocks.every((block) => block.type === first.type) ? `${first.type}${pluralSuffix}` : "media";
}

function convertMediaContent(block: MediaContent): ChatCompletionContentPartImage | ChatCompletionContentPartVideo {
	const url = `data:${block.mimeType};base64,${block.data}`;
	if (block.type === "video") {
		return { type: "input_video", input_video: { url } };
	}
	return { type: "image_url", image_url: { url } };
}

function isReasoningDetailObject(detail: unknown): detail is Record<string, unknown> {
	return typeof detail === "object" && detail !== null && !Array.isArray(detail);
}

function hasValidCommonReasoningDetailFields(candidate: Record<string, unknown>): boolean {
	return (
		(candidate.id === undefined || candidate.id === null || typeof candidate.id === "string") &&
		(candidate.format === undefined || typeof candidate.format === "string") &&
		(candidate.index === undefined || typeof candidate.index === "number")
	);
}

function isOpenAIReasoningDetail(detail: unknown): detail is OpenAIReasoningDetail {
	if (!isReasoningDetailObject(detail) || !hasValidCommonReasoningDetailFields(detail)) {
		return false;
	}
	switch (detail.type) {
		case "reasoning.summary":
			return typeof detail.summary === "string";
		case "reasoning.encrypted":
			return typeof detail.data === "string";
		case "reasoning.text":
			return (
				typeof detail.text === "string" &&
				(detail.signature === undefined || detail.signature === null || typeof detail.signature === "string")
			);
		default:
			return false;
	}
}

export interface OpenAICompletionsOptions extends StreamOptions {
	toolChoice?: ChatCompletionToolChoiceOption;
	reasoningEffort?: "minimal" | "low" | "medium" | "high" | "xhigh" | "max";
	thinkingBudgets?: ThinkingBudgets;
}

export interface ConvertCompletionsMessagesOptions {
	grammarToolInputProperties?: ReadonlyMap<string, string>;
}

interface OpenAICompatCacheControl {
	type: "ephemeral";
	ttl?: string;
}

type ResolvedOpenAICompletionsCompat = Omit<
	Required<OpenAICompletionsCompat>,
	| "cacheControlFormat"
	| "supportsThinkingTokenBudget"
	| "thinkingTokenBudgetField"
	| "supportsMidConvoSystemMessages"
	| "supportsMidConvoToolAdditions"
	| "vllmPriority"
> & {
	cacheControlFormat?: OpenAICompletionsCompat["cacheControlFormat"];
	supportsThinkingTokenBudget?: OpenAICompletionsCompat["supportsThinkingTokenBudget"];
	thinkingTokenBudgetField?: OpenAICompletionsCompat["thinkingTokenBudgetField"];
	supportsMidConvoSystemMessages?: OpenAICompletionsCompat["supportsMidConvoSystemMessages"];
	supportsMidConvoToolAdditions?: OpenAICompletionsCompat["supportsMidConvoToolAdditions"];
	vllmPriority?: OpenAICompletionsCompat["vllmPriority"];
};

type ResolvedChatTemplateKwargValue = string | number | boolean | null;

type ChatCompletionInstructionMessageParam = ChatCompletionDeveloperMessageParam | ChatCompletionSystemMessageParam;

type KimiToolSystemMessageParam = {
	role: "system";
	tools: ChatCompletionTool[];
};

type OpenAIReasoningDetailBase = Record<string, JsonValue> & {
	id?: string | null;
	format?: string;
	index?: number;
};

type OpenAIReasoningSummaryDetail = OpenAIReasoningDetailBase & {
	type: "reasoning.summary";
	summary: string;
};

type OpenAIEncryptedReasoningDetail = OpenAIReasoningDetailBase & {
	type: "reasoning.encrypted";
	data: string;
};

type OpenAIReasoningTextDetail = OpenAIReasoningDetailBase & {
	type: "reasoning.text";
	text: string;
	signature?: string | null;
};

type OpenAIReasoningDetail = OpenAIReasoningSummaryDetail | OpenAIEncryptedReasoningDetail | OpenAIReasoningTextDetail;

function parseOpenAIReasoningDetails(signature: string | undefined): OpenAIReasoningDetail[] | undefined {
	if (!signature) return undefined;
	try {
		const parsed = JSON.parse(signature) as unknown;
		return Array.isArray(parsed) && parsed.length > 0 && parsed.every(isOpenAIReasoningDetail) ? parsed : undefined;
	} catch {
		return undefined;
	}
}

function parseLegacyEncryptedReasoningDetail(
	signature: string | undefined,
): OpenAIEncryptedReasoningDetail | undefined {
	if (!signature) return undefined;
	try {
		const parsed = JSON.parse(signature) as unknown;
		return isOpenAIReasoningDetail(parsed) &&
			parsed.type === "reasoning.encrypted" &&
			typeof parsed.id === "string" &&
			parsed.id.length > 0 &&
			parsed.data.length > 0
			? parsed
			: undefined;
	} catch {
		return undefined;
	}
}

function fillMissingCommonReasoningDetailFields(
	target: OpenAIReasoningDetailBase,
	source: OpenAIReasoningDetail,
): void {
	target.id ??= source.id;
	target.format ||= source.format;
	target.index ??= source.index;
}

function appendOpenAIReasoningDetail(details: OpenAIReasoningDetail[], detail: OpenAIReasoningDetail): void {
	const lastDetail = details[details.length - 1];
	if (detail.type === "reasoning.text" && lastDetail?.type === "reasoning.text") {
		lastDetail.text += detail.text;
		lastDetail.signature ||= detail.signature;
		fillMissingCommonReasoningDetailFields(lastDetail, detail);
		return;
	}
	if (detail.type === "reasoning.summary" && lastDetail?.type === "reasoning.summary") {
		lastDetail.summary += detail.summary;
		fillMissingCommonReasoningDetailFields(lastDetail, detail);
		return;
	}
	details.push({ ...detail });
}

const OPENAI_COMPLETIONS_REASONING_FIELDS = ["reasoning", "reasoning_content", "reasoning_text"] as const;

type OpenAICompletionsReasoningField = (typeof OPENAI_COMPLETIONS_REASONING_FIELDS)[number];

function isOpenAICompletionsReasoningField(field: string): field is OpenAICompletionsReasoningField {
	return OPENAI_COMPLETIONS_REASONING_FIELDS.includes(field as OpenAICompletionsReasoningField);
}

type ChatCompletionAssistantMessageParamWithReasoning = ChatCompletionAssistantMessageParam &
	Partial<Record<OpenAICompletionsReasoningField, string>> & {
		reasoning_details?: JsonValue[];
	};

type ChatCompletionTextPartWithCacheControl = ChatCompletionContentPartText & {
	cache_control?: OpenAICompatCacheControl;
};

type ChatCompletionToolWithCacheControl = ChatCompletionTool & {
	cache_control?: OpenAICompatCacheControl;
};

function resolveCacheRetention(cacheRetention?: CacheRetention, env?: ProviderEnv): CacheRetention {
	if (cacheRetention) {
		return cacheRetention;
	}
	if (getProviderEnvValue("MI_CACHE_RETENTION", env) === "long") {
		return "long";
	}
	return "short";
}

export const stream: StreamFunction<"openai-completions", OpenAICompletionsOptions> = (
	model: Model<"openai-completions">,
	context: TranscriptContext,
	options?: OpenAICompletionsOptions,
): AssistantMessageEventStream => {
	const stream = new AssistantMessageEventStream();
	const normalizedContext = resolveTranscript(context, getCompat(model).supportsMidConvoSystemMessages);

	(async () => {
		const output: AssistantMessage = {
			role: "assistant",
			content: [],
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
			stopReason: "pending",
			timestamp: Date.now(),
		};

		let streamedReasoningDetails: OpenAIReasoningDetail[] | undefined;
		const applyStreamedReasoningDetails = (block: ThinkingContent): void => {
			if (streamedReasoningDetails !== undefined) {
				block.thinkingSignature = JSON.stringify(streamedReasoningDetails);
			}
		};

		try {
			const apiKey = getClientApiKey(model.provider, options?.apiKey, options?.headers);
			const compat = getCompat(model);
			const grammarToolInputProperties = createGrammarToolInputProperties(
				getDeclaredTools(normalizedContext.messages),
				compat.supportsOpenAIGrammarTools,
			);
			const cacheRetention = resolveCacheRetention(options?.cacheRetention, options?.env);
			const cacheSessionId = cacheRetention === "none" ? undefined : options?.sessionId;
			const headers = createRequestHeaders(model, options?.headers, cacheSessionId, compat);
			let params = buildParams(
				model,
				normalizedContext,
				options,
				compat,
				cacheRetention,
				grammarToolInputProperties,
			);
			const nextParams = await options?.onPayload?.(params, model);
			if (nextParams !== undefined) {
				params = nextParams as ChatCompletionCreateParamsStreaming;
			}
			const { events: openaiStream, response } = await retryProviderRequest(
				() =>
					postOpenAIStream<ChatCompletionChunk>({
						baseUrl: model.baseUrl,
						path: "/chat/completions",
						apiKey,
						headers,
						body: params,
						signal: options?.signal,
						timeoutMs: options?.timeoutMs,
						fetch: options?.fetch,
					}),
				{
					maxRetries: options?.maxRetries,
					maxRetryDelayMs: options?.maxRetryDelayMs,
					signal: options?.signal,
				},
			);
			await options?.onResponse?.({ status: response.status, headers: headersToRecord(response.headers) }, model);
			stream.push({ type: "start", partial: output });

			interface StreamingToolCallBlock extends ToolCall {
				partialArgs?: string;
				customInput?: {
					property: string;
					jsonBuffer: GrammarToolInputJsonBuffer;
				};
				streamIndex?: number;
			}
			type StreamingBlock = TextContent | ThinkingContent | StreamingToolCallBlock;
			type StreamingToolCallDelta = {
				index?: number;
				id?: string;
				type?: string;
				function?: { name?: string; arguments?: string };
				custom?: { name?: string; input?: string };
			};

			let textBlock: TextContent | null = null;
			let thinkingBlock: ThinkingContent | null = null;
			let hasFinishReason = false;
			const toolCallBlocksByIndex = new Map<number, StreamingToolCallBlock>();
			const toolCallBlocksById = new Map<string, StreamingToolCallBlock>();
			const blocks = output.content as StreamingBlock[];
			const getContentIndex = (block: StreamingBlock) => blocks.indexOf(block);
			const getCustomToolCallInput = (block: StreamingToolCallBlock): string => {
				const property = block.customInput?.property;
				if (property === undefined) return "";
				const value = block.arguments[property];
				return typeof value === "string" ? value : "";
			};
			const appendCustomToolCallInput = (
				block: StreamingToolCallBlock,
				nextInput: string,
				close: boolean,
			): string | undefined => {
				const customInput = block.customInput;
				if (!customInput) return undefined;
				const delta = appendGrammarToolInputJsonDelta(
					customInput.jsonBuffer,
					customInput.property,
					nextInput,
					close,
				);
				block.arguments = { [customInput.property]: nextInput };
				return delta;
			};
			const finishBlock = (block: StreamingBlock) => {
				const contentIndex = getContentIndex(block);
				if (contentIndex === -1) {
					return;
				}
				if (block.type === "text") {
					stream.push({
						type: "text_end",
						contentIndex,
						content: block.text,
						partial: output,
					});
				} else if (block.type === "thinking") {
					applyStreamedReasoningDetails(block);
					stream.push({
						type: "thinking_end",
						contentIndex,
						content: block.thinking,
						partial: output,
					});
				} else if (block.type === "toolCall") {
					if (block.customInput) {
						const delta = appendCustomToolCallInput(block, getCustomToolCallInput(block), true);
						if (delta !== undefined) {
							stream.push({
								type: "toolcall_delta",
								contentIndex,
								delta,
								partial: output,
							});
						}
					} else {
						block.arguments = parseStreamingJson(block.partialArgs);
					}
					delete block.partialArgs;
					delete block.customInput;
					delete block.streamIndex;
					stream.push({
						type: "toolcall_end",
						contentIndex,
						toolCall: block,
						partial: output,
					});
				}
			};
			const ensureTextBlock = () => {
				if (!textBlock) {
					textBlock = { type: "text", text: "" };
					blocks.push(textBlock);
					stream.push({ type: "text_start", contentIndex: getContentIndex(textBlock), partial: output });
				}
				return textBlock;
			};
			const ensureThinkingBlock = (thinkingSignature: string) => {
				if (!thinkingBlock) {
					thinkingBlock = {
						type: "thinking",
						thinking: "",
						thinkingSignature,
					};
					blocks.push(thinkingBlock);
					stream.push({ type: "thinking_start", contentIndex: getContentIndex(thinkingBlock), partial: output });
				}
				return thinkingBlock;
			};
			const ensureToolCallBlock = (toolCall: StreamingToolCallDelta) => {
				const streamIndex = typeof toolCall.index === "number" ? toolCall.index : undefined;
				const name = toolCall.function?.name ?? toolCall.custom?.name ?? "";
				let block = streamIndex !== undefined ? toolCallBlocksByIndex.get(streamIndex) : undefined;
				if (!block && toolCall.id) {
					block = toolCallBlocksById.get(toolCall.id);
				}
				if (!block) {
					const customInputProperty =
						toolCall.custom && !toolCall.function ? (grammarToolInputProperties.get(name) ?? "input") : undefined;
					const hasCustomInput = customInputProperty !== undefined;
					block = {
						type: "toolCall",
						id: toolCall.id || "",
						name,
						arguments: hasCustomInput ? { [customInputProperty]: "" } : {},
						partialArgs: hasCustomInput ? undefined : "",
						customInput: hasCustomInput
							? { property: customInputProperty, jsonBuffer: { input: "", started: false, closed: false } }
							: undefined,
						streamIndex,
					};
					if (streamIndex !== undefined) {
						toolCallBlocksByIndex.set(streamIndex, block);
					}
					if (toolCall.id) {
						toolCallBlocksById.set(toolCall.id, block);
					}
					blocks.push(block);
					stream.push({
						type: "toolcall_start",
						contentIndex: getContentIndex(block),
						partial: output,
					});
				}
				if (streamIndex !== undefined && block.streamIndex === undefined) {
					block.streamIndex = streamIndex;
					toolCallBlocksByIndex.set(streamIndex, block);
				}
				if (toolCall.id) {
					toolCallBlocksById.set(toolCall.id, block);
				}
				if (!block.name && name) {
					block.name = name;
				}
				if (toolCall.custom && !toolCall.function && !block.customInput) {
					const customInputProperty = grammarToolInputProperties.get(block.name) ?? "input";
					block.arguments = { [customInputProperty]: "" };
					block.customInput = {
						property: customInputProperty,
						jsonBuffer: { input: "", started: false, closed: false },
					};
					delete block.partialArgs;
				}
				return block;
			};

			for await (const chunk of openaiStream) {
				await options?.onProviderStreamEvent?.(chunk, model);
				if (!chunk || typeof chunk !== "object") continue;

				output.responseId ||= chunk.id;
				if (typeof chunk.model === "string" && chunk.model.length > 0 && chunk.model !== model.id) {
					output.responseModel ||= chunk.model;
				}
				if (chunk.usage) {
					output.usage = parseChunkUsage(chunk.usage, model);
				}

				const choice = Array.isArray(chunk.choices) ? chunk.choices[0] : undefined;
				if (!choice) continue;

				if (!chunk.usage && (choice as any).usage) {
					output.usage = parseChunkUsage((choice as any).usage, model);
				}

				if (choice.finish_reason) {
					output.rawStopReason = choice.finish_reason;
					const finishReasonResult = mapStopReason(choice.finish_reason);
					output.stopReason = finishReasonResult.stopReason;
					if (finishReasonResult.errorMessage) {
						output.errorMessage = finishReasonResult.errorMessage;
					}
					hasFinishReason = true;
				}

				if (choice.delta) {
					if (
						choice.delta.content !== null &&
						choice.delta.content !== undefined &&
						choice.delta.content.length > 0
					) {
						const block = ensureTextBlock();
						block.text += choice.delta.content;
						stream.push({
							type: "text_delta",
							contentIndex: getContentIndex(block),
							delta: choice.delta.content,
							partial: output,
						});
					}

					const reasoningFields = ["reasoning_content", "reasoning", "reasoning_text"];
					const deltaFields = choice.delta as Record<string, unknown>;
					let foundReasoningField: string | null = null;
					for (const field of reasoningFields) {
						const value = deltaFields[field];
						if (typeof value === "string" && value.length > 0) {
							foundReasoningField = field;
							break;
						}
					}

					if (foundReasoningField) {
						const delta = deltaFields[foundReasoningField];
						if (typeof delta === "string" && delta.length > 0) {
							const block = ensureThinkingBlock(foundReasoningField);
							block.thinking += delta;
							stream.push({
								type: "thinking_delta",
								contentIndex: getContentIndex(block),
								delta,
								partial: output,
							});
						}
					}

					if (choice?.delta?.tool_calls) {
						for (const toolCall of choice.delta.tool_calls as StreamingToolCallDelta[]) {
							const block = ensureToolCallBlock(toolCall);
							if (!block.id && toolCall.id) {
								block.id = toolCall.id;
								toolCallBlocksById.set(toolCall.id, block);
							}
							const name = toolCall.function?.name ?? toolCall.custom?.name;
							if (!block.name && name) {
								block.name = name;
							}

							let delta = "";
							if (toolCall.function?.arguments) {
								delta = toolCall.function.arguments;
								block.partialArgs = (block.partialArgs ?? "") + toolCall.function.arguments;
								block.arguments = parseStreamingJson(block.partialArgs);
							} else if (toolCall.custom?.input) {
								const nextInput = getCustomToolCallInput(block) + toolCall.custom.input;
								delta = appendCustomToolCallInput(block, nextInput, false) ?? "";
							}
							stream.push({
								type: "toolcall_delta",
								contentIndex: getContentIndex(block),
								delta,
								partial: output,
							});
						}
					}

					const reasoningDetails = (choice.delta as { reasoning_details?: unknown }).reasoning_details;
					if (Array.isArray(reasoningDetails)) {
						for (const detail of reasoningDetails) {
							if (!isOpenAIReasoningDetail(detail)) continue;
							ensureThinkingBlock("");
							streamedReasoningDetails ??= [];
							appendOpenAIReasoningDetail(streamedReasoningDetails, detail);
						}
					}
				}
			}

			for (const block of blocks) {
				finishBlock(block);
			}
			if (options?.signal?.aborted) {
				throw new Error("Request was aborted");
			}

			if (output.stopReason === "aborted") {
				throw new Error("Request was aborted");
			}
			if (!hasFinishReason && !compat.supportsFinishReason) {
				output.stopReason = output.content.some((block) => block.type === "toolCall") ? "toolUse" : "stop";
			}
			if (output.stopReason === "error") {
				throw new Error(output.errorMessage || "Provider returned an error stop reason");
			}
			if ((compat.supportsFinishReason && !hasFinishReason) || output.stopReason === "pending") {
				throw new Error("Stream ended without finish_reason");
			}

			stream.push({ type: "done", reason: output.stopReason, message: output });
			stream.end();
		} catch (error) {
			for (const block of output.content) {
				if (block.type === "thinking") {
					applyStreamedReasoningDetails(block);
				}
				delete (block as { index?: number }).index;
				delete (block as { partialArgs?: string }).partialArgs;
				delete (block as { customInput?: unknown }).customInput;
				delete (block as { streamIndex?: number }).streamIndex;
			}
			output.stopReason = options?.signal?.aborted ? "aborted" : "error";
			output.errorMessage = formatProviderError(normalizeProviderError(error));
			const rawMetadata = (error as any)?.error?.metadata?.raw;
			if (rawMetadata && !output.errorMessage.includes(String(rawMetadata))) {
				output.errorMessage += `\n${rawMetadata}`;
			}
			stream.push({ type: "error", reason: output.stopReason, error: output });
			stream.end();
		}
	})();

	return stream;
};

export const streamSimple: StreamFunction<"openai-completions", SimpleStreamOptions> = (
	model: Model<"openai-completions">,
	context: TranscriptContext,
	options?: SimpleStreamOptions,
): AssistantMessageEventStream => {
	getClientApiKey(model.provider, options?.apiKey, options?.headers);

	const base = {
		...buildBaseOptions(model, context, options, options?.apiKey),
		toolChoice: options?.toolChoice,
	} satisfies OpenAICompletionsOptions;
	const clampedReasoning = options?.reasoning ? clampThinkingLevel(model, options.reasoning) : undefined;
	const reasoningEffort = clampedReasoning === "off" ? undefined : clampedReasoning;

	return stream(model, context, {
		...base,
		reasoningEffort,
		thinkingBudgets: options?.thinkingBudgets,
	} satisfies OpenAICompletionsOptions);
};

function createRequestHeaders(
	model: Model<"openai-completions">,
	optionsHeaders?: ProviderHeaders,
	sessionId?: string,
	compat: ResolvedOpenAICompletionsCompat = getCompat(model),
): ProviderHeaders {
	const headers: ProviderHeaders = { "User-Agent": getPiUserAgent(), ...model.headers };
	if (sessionId && compat.sendSessionAffinityHeaders) {
		if (compat.sessionAffinityFormat === "openrouter") {
			headers["x-session-id"] = sessionId;
		} else {
			if (compat.sessionAffinityFormat === "openai") {
				headers.session_id = sessionId;
			}
			headers["x-client-request-id"] = sessionId;
			headers["x-session-affinity"] = sessionId;
		}
	}

	if (optionsHeaders) {
		Object.assign(headers, optionsHeaders);
	}

	return headers;
}

function buildParams(
	model: Model<"openai-completions">,
	context: TranscriptContext,
	options?: OpenAICompletionsOptions,
	compat: ResolvedOpenAICompletionsCompat = getCompat(model),
	cacheRetention: CacheRetention = resolveCacheRetention(options?.cacheRetention, options?.env),
	grammarToolInputProperties: ReadonlyMap<string, string> = createGrammarToolInputProperties(
		getDeclaredTools(context.messages),
		compat.supportsOpenAIGrammarTools,
	),
) {
	const transcriptTools = resolveTranscriptTools(
		context.messages,
		compat.supportsMidConvoSystemMessages === true && compat.supportsMidConvoToolAdditions === true,
	);
	const messages = convertMessages(model, context, compat, {
		grammarToolInputProperties,
	});
	const cacheControl = getCompatCacheControl(compat, cacheRetention);

	const params: ChatCompletionCreateParamsStreaming = {
		model: model.id,
		messages,
		stream: true,
		prompt_cache_key:
			cacheRetention === "long" && compat.supportsLongCacheRetention
				? clampOpenAIPromptCacheKey(options?.sessionId)
				: undefined,
		prompt_cache_retention: cacheRetention === "long" && compat.supportsLongCacheRetention ? "24h" : undefined,
	};

	if (compat.supportsUsageInStreaming !== false) {
		params.stream_options = { include_usage: true };
	}

	if (compat.supportsStore) {
		params.store = false;
	}

	if (options?.maxTokens) {
		if (compat.maxTokensField === "max_tokens") {
			(params as { max_tokens?: number }).max_tokens = options.maxTokens;
		} else {
			params.max_completion_tokens = options.maxTokens;
		}
	}

	if (options?.temperature !== undefined) {
		params.temperature = options.temperature;
	}

	if (transcriptTools.requestTools.length > 0) {
		params.tools = convertTools(transcriptTools.requestTools, compat);
	} else if (hasToolHistory(context.messages)) {
		params.tools = [];
	}

	if (cacheControl) {
		applyAnthropicCacheControl(messages, params.tools, cacheControl);
	}

	if (options?.toolChoice) {
		params.tool_choice = options.toolChoice;
	}

	if (compat.vllmPriority !== undefined) {
		(params as any).priority = compat.vllmPriority;
	}

	const thinkingTokenBudgetField = resolveThinkingTokenBudgetField(compat);
	const thinkingBudget = resolveClampedThinkingBudget(model, options, params);

	if (compat.thinkingFormat === "qwen-chat-template" && model.reasoning) {
		(params as any).chat_template_kwargs = {
			enable_thinking: !!options?.reasoningEffort,
			preserve_thinking: true,
		};
	} else if (compat.thinkingFormat === "chat-template" && model.reasoning) {
		const chatTemplateKwargs = buildChatTemplateValues(model, options, compat.chatTemplateKwargs, thinkingBudget);
		if (chatTemplateKwargs) {
			(params as any).chat_template_kwargs = chatTemplateKwargs;
		}
	} else if (compat.thinkingFormat === "openrouter" && model.reasoning) {
		const openRouterParams = params as typeof params & { reasoning?: { effort?: string } };
		if (options?.reasoningEffort) {
			openRouterParams.reasoning = {
				effort: model.thinkingLevelMap?.[options.reasoningEffort] ?? options.reasoningEffort,
			};
		} else if (model.thinkingLevelMap?.off !== null) {
			openRouterParams.reasoning = { effort: model.thinkingLevelMap?.off ?? "none" };
		}
	} else if (options?.reasoningEffort && model.reasoning && compat.supportsReasoningEffort) {
		(params as any).reasoning_effort = model.thinkingLevelMap?.[options.reasoningEffort] ?? options.reasoningEffort;
	} else if (!options?.reasoningEffort && model.reasoning && compat.supportsReasoningEffort) {
		const offValue = model.thinkingLevelMap?.off;
		if (typeof offValue === "string") {
			(params as any).reasoning_effort = offValue;
		}
	}

	if (thinkingTokenBudgetField && thinkingBudget !== undefined) {
		Object.assign(params, { [thinkingTokenBudgetField]: thinkingBudget });
	}

	if (model.compat?.openRouterRouting) {
		(params as any).provider = model.compat.openRouterRouting;
	}

	Object.assign(params, model.samplingParams, options?.samplingParams);

	return params;
}

function resolveThinkingTokenBudgetField(
	compat: Pick<OpenAICompletionsCompat, "thinkingTokenBudgetField" | "supportsThinkingTokenBudget">,
): ThinkingTokenBudgetField | undefined {
	if (compat.thinkingTokenBudgetField) return compat.thinkingTokenBudgetField;
	if (compat.supportsThinkingTokenBudget) return "thinking_token_budget";
	return undefined;
}

function resolveClampedThinkingBudget(
	model: Model<"openai-completions">,
	options: OpenAICompletionsOptions | undefined,
	params: { max_tokens?: number | null; max_completion_tokens?: number | null },
): number | undefined {
	if (!options?.reasoningEffort || !model.reasoning) return undefined;
	const ceiling = params.max_tokens ?? params.max_completion_tokens ?? model.maxTokens;
	const budget = clampThinkingBudgetToAnswerRoom(
		thinkingBudgetForLevel(options.reasoningEffort, options.thinkingBudgets),
		ceiling,
	);
	return budget > 0 ? budget : undefined;
}

function buildChatTemplateValues(
	model: Model<"openai-completions">,
	options: OpenAICompletionsOptions | undefined,
	values: Record<string, ChatTemplateKwargValue>,
	thinkingBudget?: number,
): Record<string, ResolvedChatTemplateKwargValue> | undefined {
	const resolvedValues: Record<string, ResolvedChatTemplateKwargValue> = {};

	for (const [key, value] of Object.entries(values)) {
		const resolved = resolveChatTemplateKwargValue(model, options, value, thinkingBudget);
		if (resolved !== undefined) {
			resolvedValues[key] = resolved;
		}
	}

	return Object.keys(resolvedValues).length > 0 ? resolvedValues : undefined;
}

function resolveChatTemplateKwargValue(
	model: Model<"openai-completions">,
	options: OpenAICompletionsOptions | undefined,
	value: ChatTemplateKwargValue,
	thinkingBudget?: number,
): ResolvedChatTemplateKwargValue | undefined {
	if (typeof value !== "object" || value === null) {
		return value;
	}

	const reasoningEffort = options?.reasoningEffort;
	if (!reasoningEffort && value.omitWhenOff) {
		return undefined;
	}
	if (value.$var === "thinking.enabled") {
		return !!reasoningEffort;
	}
	if (value.$var === "thinking.budget") {
		return thinkingBudget;
	}

	const mappedValue = reasoningEffort ? model.thinkingLevelMap?.[reasoningEffort] : model.thinkingLevelMap?.off;
	return mappedValue === undefined ? reasoningEffort : typeof mappedValue === "string" ? mappedValue : undefined;
}

function getCompatCacheControl(
	compat: ResolvedOpenAICompletionsCompat,
	cacheRetention: CacheRetention,
): OpenAICompatCacheControl | undefined {
	if (compat.cacheControlFormat !== "anthropic" || cacheRetention === "none") {
		return undefined;
	}

	const ttl = cacheRetention === "long" && compat.supportsLongCacheRetention ? "1h" : undefined;
	return { type: "ephemeral", ...(ttl ? { ttl } : {}) };
}

function applyAnthropicCacheControl(
	messages: ChatCompletionMessageParam[],
	tools: ChatCompletionTool[] | undefined,
	cacheControl: OpenAICompatCacheControl,
): void {
	addCacheControlToSystemPrompt(messages, cacheControl);
	addCacheControlToLastTool(tools, cacheControl);
	addCacheControlToLastConversationMessage(messages, cacheControl);
}

function addCacheControlToSystemPrompt(
	messages: ChatCompletionMessageParam[],
	cacheControl: OpenAICompatCacheControl,
): void {
	for (const message of messages) {
		if (message.role === "system" || message.role === "developer") {
			addCacheControlToInstructionMessage(message, cacheControl);
			return;
		}
	}
}

function addCacheControlToLastConversationMessage(
	messages: ChatCompletionMessageParam[],
	cacheControl: OpenAICompatCacheControl,
): void {
	for (let i = messages.length - 1; i >= 0; i--) {
		const message = messages[i];
		if (message.role === "user" || message.role === "assistant" || message.role === "tool") {
			if (addCacheControlToMessage(message, cacheControl)) {
				return;
			}
		}
	}
}

function addCacheControlToLastTool(
	tools: ChatCompletionTool[] | undefined,
	cacheControl: OpenAICompatCacheControl,
): void {
	if (!tools || tools.length === 0) {
		return;
	}

	const lastTool = tools[tools.length - 1] as ChatCompletionToolWithCacheControl;
	lastTool.cache_control = cacheControl;
}

function addCacheControlToInstructionMessage(
	message: ChatCompletionInstructionMessageParam,
	cacheControl: OpenAICompatCacheControl,
): boolean {
	return addCacheControlToTextContent(message, cacheControl);
}

function addCacheControlToMessage(
	message: ChatCompletionMessageParam,
	cacheControl: OpenAICompatCacheControl,
): boolean {
	if (message.role === "user" || message.role === "assistant" || message.role === "tool") {
		return addCacheControlToTextContent(message, cacheControl);
	}
	return false;
}

function addCacheControlToTextContent(
	message:
		| ChatCompletionInstructionMessageParam
		| ChatCompletionAssistantMessageParam
		| ChatCompletionToolMessageParam
		| Extract<ChatCompletionMessageParam, { role: "user" }>,
	cacheControl: OpenAICompatCacheControl,
): boolean {
	const content = message.content;
	if (typeof content === "string") {
		if (content.length === 0) {
			return false;
		}
		message.content = [
			{
				type: "text",
				text: content,
				cache_control: cacheControl,
			},
		] as ChatCompletionTextPartWithCacheControl[];
		return true;
	}

	if (!Array.isArray(content)) {
		return false;
	}

	for (let i = content.length - 1; i >= 0; i--) {
		const part = content[i];
		if (part?.type === "text") {
			const textPart = part as ChatCompletionTextPartWithCacheControl;
			textPart.cache_control = cacheControl;
			return true;
		}
	}

	return false;
}

export function convertMessages(
	model: Model<"openai-completions">,
	context: TranscriptContext,
	compat: ResolvedOpenAICompletionsCompat,
	options?: ConvertCompletionsMessagesOptions,
): ChatCompletionMessageParam[] {
	const normalizedContext = resolveTranscript(context, compat.supportsMidConvoSystemMessages);
	const params: ChatCompletionMessageParam[] = [];

	const normalizeToolCallId = (id: string): string => {
		if (id.includes("|")) {
			const separatorIndex = id.indexOf("|");
			const callId = id.slice(0, separatorIndex).replace(/[^a-zA-Z0-9_-]/g, "_");
			const itemId = id.slice(separatorIndex + 1).replace(/[^a-zA-Z0-9_-]/g, "_");
			const combinedId = itemId.length > 0 ? `${callId}_${itemId}` : callId;
			if (combinedId.length <= 40) {
				return combinedId;
			}
			const hash = shortHash(id).slice(0, 8);
			const prefix = callId.slice(0, Math.max(1, 40 - hash.length - 1));
			return `${prefix}_${hash}`;
		}

		return id;
	};

	const transformedMessages = transformMessages(normalizedContext.messages, model, (id) => normalizeToolCallId(id));
	const transcriptTools = resolveTranscriptTools(
		normalizedContext.messages,
		compat.supportsMidConvoSystemMessages === true && compat.supportsMidConvoToolAdditions === true,
	);
	const instructionRole = model.reasoning && compat.supportsDeveloperRole ? "developer" : "system";

	let lastRole: string | null = null;

	for (let i = 0; i < transformedMessages.length; i++) {
		const msg = transformedMessages[i];
		if (compat.requiresAssistantAfterToolResult && lastRole === "toolResult" && msg.role === "user") {
			params.push({
				role: "assistant",
				content: "I have processed the tool results.",
			});
		}

		if (msg.role === "system") {
			const addedTools = i > 0 && transcriptTools.anchorsAdditions ? (msg.toolsAdded ?? []) : [];
			if (addedTools.length > 0) {
				const kimiToolMessage: KimiToolSystemMessageParam = {
					role: "system",
					tools: convertTools(addedTools, compat),
				};
				params.push(kimiToolMessage as unknown as ChatCompletionMessageParam);
			}
			const text = i === 0 ? getSystemMessageText(msg) : renderSystemMessageUpdate(msg);
			if (text.length > 0) {
				params.push({ role: instructionRole, content: sanitizeSurrogates(text) });
			}
		} else if (msg.role === "user") {
			if (typeof msg.content === "string") {
				params.push({
					role: "user",
					content: sanitizeSurrogates(msg.content),
				});
			} else {
				const content: ChatCompletionContentPart[] = msg.content
					.filter((item) => item.type !== "text" || item.text.length > 0)
					.map((item): ChatCompletionContentPart => {
						if (item.type === "text") {
							return {
								type: "text",
								text: sanitizeSurrogates(item.text),
							} satisfies ChatCompletionContentPartText;
						}
						return convertMediaContent(item);
					});
				if (content.length === 0) continue;
				params.push({
					role: "user",
					content,
				});
			}
		} else if (msg.role === "assistant") {
			const assistantMsg: ChatCompletionAssistantMessageParamWithReasoning = {
				role: "assistant",
				content: compat.requiresAssistantAfterToolResult ? "" : null,
			};

			const assistantTextParts = msg.content
				.filter(isTextContentBlock)
				.filter((block) => block.text.trim().length > 0)
				.map(
					(block) =>
						({
							type: "text",
							text: sanitizeSurrogates(block.text),
						}) satisfies ChatCompletionContentPartText,
				);
			const assistantText = assistantTextParts.map((part) => part.text).join("");

			const thinkingBlocks = msg.content.filter(isThinkingContentBlock);
			const toolCalls = msg.content.filter(isToolCallBlock);
			const signedReasoningDetails = thinkingBlocks
				.map((block) => parseOpenAIReasoningDetails(block.thinkingSignature))
				.find((details) => details !== undefined);
			const legacyReasoningDetails = toolCalls
				.map((toolCall) => parseLegacyEncryptedReasoningDetail(toolCall.thoughtSignature))
				.filter((detail): detail is OpenAIEncryptedReasoningDetail => detail !== undefined);
			const preservedReasoningDetails =
				signedReasoningDetails ?? (legacyReasoningDetails.length > 0 ? legacyReasoningDetails : undefined);

			const nonEmptyThinkingBlocks = thinkingBlocks.filter((block) => block.thinking.trim().length > 0);
			if (nonEmptyThinkingBlocks.length > 0) {
				if (compat.requiresThinkingAsText) {
					const thinkingText = nonEmptyThinkingBlocks
						.map((block) => sanitizeSurrogates(block.thinking))
						.join("\n\n");
					assistantMsg.content = [{ type: "text", text: thinkingText }, ...assistantTextParts];
				} else {
					if (assistantText.length > 0) {
						assistantMsg.content = assistantText;
					}

					if (!preservedReasoningDetails) {
						const signature = nonEmptyThinkingBlocks[0].thinkingSignature;
						if (signature && isOpenAICompletionsReasoningField(signature)) {
							assistantMsg[signature] = nonEmptyThinkingBlocks.map((block) => block.thinking).join("\n");
						}
					}
				}
			} else if (assistantText.length > 0) {
				assistantMsg.content = assistantText;
			}

			if (toolCalls.length > 0) {
				assistantMsg.tool_calls = toolCalls.map((tc): ChatCompletionMessageToolCall => {
					const customInputProperty = options?.grammarToolInputProperties?.get(tc.name);
					if (customInputProperty !== undefined) {
						return {
							id: tc.id,
							type: "custom",
							custom: {
								name: tc.name,
								input: sanitizeSurrogates(getGrammarToolInput(tc.name, tc.arguments, customInputProperty)),
							},
						};
					}
					return {
						id: tc.id,
						type: "function",
						function: {
							name: tc.name,
							arguments: JSON.stringify(tc.arguments),
						},
					};
				});
			}
			if (preservedReasoningDetails) {
				assistantMsg.reasoning_details = preservedReasoningDetails;
			}
			const content = assistantMsg.content;
			const hasContent =
				content !== null &&
				content !== undefined &&
				(typeof content === "string" ? content.length > 0 : content.length > 0);
			if (!hasContent && !assistantMsg.tool_calls) {
				continue;
			}
			params.push(assistantMsg);
		} else if (msg.role === "toolResult") {
			const toolMedia: MediaContent[] = [];
			let j = i;

			for (; j < transformedMessages.length && transformedMessages[j].role === "toolResult"; j++) {
				const toolMsg = transformedMessages[j] as ToolResultMessage;

				const textResult = toolMsg.content
					.filter(isTextContentBlock)
					.map((block) => block.text)
					.join("\n");
				const mediaBlocks = toolMsg.content.filter(isMediaContentBlock);

				const hasText = textResult.length > 0;
				const toolResultText = hasText
					? textResult
					: mediaBlocks.length > 0
						? `(see attached ${describeMedia(mediaBlocks)})`
						: "(no tool output)";
				const toolResultMsg: ChatCompletionToolMessageParam = {
					role: "tool",
					content: sanitizeSurrogates(toolResultText),
					tool_call_id: toolMsg.toolCallId,
				};
				if (compat.requiresToolResultName && toolMsg.toolName) {
					(toolResultMsg as any).name = toolMsg.toolName;
				}
				params.push(toolResultMsg);

				toolMedia.push(...mediaBlocks);
			}

			i = j - 1;

			if (toolMedia.length > 0) {
				if (compat.requiresAssistantAfterToolResult) {
					params.push({
						role: "assistant",
						content: "I have processed the tool results.",
					});
				}

				params.push({
					role: "user",
					content: [
						{
							type: "text",
							text: `Attached ${describeMedia(toolMedia, "(s)")} from tool result:`,
						},
						...toolMedia.map(convertMediaContent),
					],
				});
				lastRole = "user";
			} else {
				lastRole = "toolResult";
			}

			continue;
		}

		lastRole = msg.role;
	}

	return params;
}

function convertTools(tools: Tool[], compat: ResolvedOpenAICompletionsCompat): ChatCompletionTool[] {
	return tools.map((tool) => {
		const grammar = resolveGrammarConstrainedSampling(tool, compat.supportsOpenAIGrammarTools);
		if (grammar) {
			return {
				type: "custom",
				custom: {
					name: tool.name,
					description: tool.description,
					format: {
						type: "grammar",
						grammar: {
							syntax: grammar.format,
							definition: grammar.definition,
						},
					},
				},
			};
		}

		const strict = resolveJsonSchemaStrictSampling(tool, compat.supportsStrictMode !== false);
		return {
			type: "function",
			function: {
				name: tool.name,
				description: tool.description,
				parameters: getJsonSchemaToolParameters(tool, strict) as Record<string, unknown>,
				...(compat.supportsStrictMode !== false && { strict: strict ?? false }),
			},
		};
	});
}

function parseChunkUsage(
	rawUsage: {
		prompt_tokens?: number;
		completion_tokens?: number;
		cached_tokens?: number;
		prompt_cache_hit_tokens?: number;
		prompt_tokens_details?: { cached_tokens?: number; cache_write_tokens?: number };
		completion_tokens_details?: { reasoning_tokens?: number };
	},
	model: Model<"openai-completions">,
): AssistantMessage["usage"] {
	const promptTokens = rawUsage.prompt_tokens || 0;
	const cacheReadTokens =
		rawUsage.prompt_tokens_details?.cached_tokens ?? rawUsage.prompt_cache_hit_tokens ?? rawUsage.cached_tokens ?? 0;
	const cacheWriteTokens = rawUsage.prompt_tokens_details?.cache_write_tokens || 0;

	const input = Math.max(0, promptTokens - cacheReadTokens - cacheWriteTokens);
	const outputTokens = rawUsage.completion_tokens || 0;
	const usage: AssistantMessage["usage"] = {
		input,
		output: outputTokens,
		cacheRead: cacheReadTokens,
		cacheWrite: cacheWriteTokens,
		reasoning: rawUsage.completion_tokens_details?.reasoning_tokens || 0,
		totalTokens: input + outputTokens + cacheReadTokens + cacheWriteTokens,
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
	};
	calculateCost(model, usage);
	return usage;
}

function mapStopReason(reason: ChatCompletionChunkChoice["finish_reason"] | string): {
	stopReason: StopReason;
	errorMessage?: string;
} {
	if (reason === null) return { stopReason: "stop" };
	switch (reason) {
		case "stop":
		case "end":
			return { stopReason: "stop" };
		case "length":
			return { stopReason: "length" };
		case "function_call":
		case "tool_calls":
			return { stopReason: "toolUse" };
		case "content_filter":
			return { stopReason: "error", errorMessage: "Provider finish_reason: content_filter" };
		case "network_error":
			return { stopReason: "error", errorMessage: "Provider finish_reason: network_error" };
		default:
			return {
				stopReason: "error",
				errorMessage: `Provider finish_reason: ${reason}`,
			};
	}
}

function detectCompat(model: Model<"openai-completions">): ResolvedOpenAICompletionsCompat {
	const isOpenRouter = model.provider === "openrouter" || model.baseUrl.includes("openrouter.ai");
	const isOpenRouterDeveloperRoleModel =
		isOpenRouter && (model.id.startsWith("anthropic/") || model.id.startsWith("openai/"));

	return {
		supportsStore: true,
		supportsDeveloperRole: isOpenRouterDeveloperRoleModel || !isOpenRouter,
		supportsReasoningEffort: true,
		supportsUsageInStreaming: true,
		supportsFinishReason: true,
		maxTokensField: "max_completion_tokens",
		requiresToolResultName: false,
		requiresAssistantAfterToolResult: false,
		requiresThinkingAsText: false,
		thinkingFormat: isOpenRouter ? "openrouter" : "openai",
		openRouterRouting: {},
		chatTemplateKwargs: {},
		supportsThinkingTokenBudget: false,
		thinkingTokenBudgetField: undefined,
		supportsStrictMode: false,
		supportsOpenAIGrammarTools: false,
		supportsMidConvoSystemMessages: false,
		supportsMidConvoToolAdditions: false,
		cacheControlFormat: isOpenRouter && model.id.startsWith("anthropic/") ? "anthropic" : undefined,
		sendSessionAffinityHeaders: isOpenRouter,
		sessionAffinityFormat: isOpenRouter ? "openrouter" : "openai",
		supportsLongCacheRetention: true,
	};
}

function getCompat(model: Model<"openai-completions">): ResolvedOpenAICompletionsCompat {
	const detected = detectCompat(model);
	if (!model.compat) return detected;

	return {
		supportsStore: model.compat.supportsStore ?? detected.supportsStore,
		supportsDeveloperRole: model.compat.supportsDeveloperRole ?? detected.supportsDeveloperRole,
		supportsReasoningEffort: model.compat.supportsReasoningEffort ?? detected.supportsReasoningEffort,
		supportsUsageInStreaming: model.compat.supportsUsageInStreaming ?? detected.supportsUsageInStreaming,
		supportsFinishReason: model.compat.supportsFinishReason ?? detected.supportsFinishReason,
		maxTokensField: model.compat.maxTokensField ?? detected.maxTokensField,
		requiresToolResultName: model.compat.requiresToolResultName ?? detected.requiresToolResultName,
		requiresAssistantAfterToolResult:
			model.compat.requiresAssistantAfterToolResult ?? detected.requiresAssistantAfterToolResult,
		requiresThinkingAsText: model.compat.requiresThinkingAsText ?? detected.requiresThinkingAsText,
		thinkingFormat: model.compat.thinkingFormat ?? detected.thinkingFormat,
		openRouterRouting: model.compat.openRouterRouting ?? {},
		chatTemplateKwargs: model.compat.chatTemplateKwargs ?? detected.chatTemplateKwargs,
		supportsThinkingTokenBudget: model.compat.supportsThinkingTokenBudget ?? detected.supportsThinkingTokenBudget,
		thinkingTokenBudgetField: model.compat.thinkingTokenBudgetField ?? detected.thinkingTokenBudgetField,
		supportsStrictMode: model.compat.supportsStrictMode ?? detected.supportsStrictMode,
		supportsOpenAIGrammarTools: model.compat.supportsOpenAIGrammarTools ?? detected.supportsOpenAIGrammarTools,
		supportsMidConvoSystemMessages:
			model.compat.supportsMidConvoSystemMessages ?? detected.supportsMidConvoSystemMessages,
		supportsMidConvoToolAdditions:
			model.compat.supportsMidConvoToolAdditions ?? detected.supportsMidConvoToolAdditions,
		cacheControlFormat: model.compat.cacheControlFormat ?? detected.cacheControlFormat,
		sendSessionAffinityHeaders: model.compat.sendSessionAffinityHeaders ?? detected.sendSessionAffinityHeaders,
		sessionAffinityFormat: model.compat.sessionAffinityFormat ?? detected.sessionAffinityFormat,
		supportsLongCacheRetention: model.compat.supportsLongCacheRetention ?? detected.supportsLongCacheRetention,
		vllmPriority: model.compat.vllmPriority,
	};
}
