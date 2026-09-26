import type { OpenAICompletionsOptions } from "./api/openai-completions.ts";
import type { AssistantMessageDiagnostic } from "./utils/diagnostics.ts";
import type { AssistantMessageEventStream } from "./utils/event-stream.ts";

export type { AssistantMessageEventStream } from "./utils/event-stream.ts";

export type KnownApi = "openai-completions";

export type Api = KnownApi | (string & {});

export type ProviderId = string;

export type ToolChoice = "auto" | "none";
export type ThinkingLevel = "minimal" | "low" | "medium" | "high" | "xhigh" | "max";
export type ModelThinkingLevel = "off" | ThinkingLevel;
export type ThinkingLevelMap = Partial<Record<ModelThinkingLevel, string | null>>;
export type ChatTemplateKwargValue =
	| string
	| number
	| boolean
	| null
	| {
			$var: "thinking.enabled" | "thinking.effort" | "thinking.budget";
			omitWhenOff?: boolean;
	  };

export type ThinkingTokenBudgetField = "thinking_token_budget" | "thinking_budget" | "thinking_budget_tokens";

export interface ThinkingBudgets {
	minimal?: number;
	low?: number;
	medium?: number;
	high?: number;
}

export type CacheRetention = "none" | "short" | "long";

export type ModelPromptCache = Partial<Record<Exclude<CacheRetention, "none">, number>>;

export type ProviderEnv = Record<string, string>;
export type ProviderHeaders = Record<string, string | null>;
export type FetchFunction = (input: string | URL | Request, init?: RequestInit) => Promise<Response>;
export type SessionAffinityFormat = "openai" | "openai-nosession" | "openrouter";

export interface ProviderResponse {
	status: number;
	headers: Record<string, string>;
}

export interface ProviderRequestOptions<TModel = Model<Api>> {
	signal?: AbortSignal;
	apiKey?: string;
	fetch?: FetchFunction;
	env?: ProviderEnv;
	onPayload?: (payload: unknown, model: TModel) => unknown | undefined | Promise<unknown | undefined>;
	onResponse?: (response: ProviderResponse, model: TModel) => void | Promise<void>;
	headers?: ProviderHeaders;
	timeoutMs?: number;
	maxRetries?: number;
	maxRetryDelayMs?: number;
}

export interface StreamOptions extends ProviderRequestOptions<Model<Api>> {
	onResponse?: (response: ProviderResponse, model: Model<Api>) => void | Promise<void>;
	onProviderStreamEvent?: (data: unknown, model: Model<Api>) => void | Promise<void>;
	temperature?: number;
	samplingParams?: Record<string, unknown>;
	maxTokens?: number;
	cacheRetention?: CacheRetention;
	sessionId?: string;
	metadata?: Record<string, unknown>;
}

export type ProviderStreamOptions = StreamOptions & Record<string, unknown>;

export interface ApiOptionsMap {
	"openai-completions": OpenAICompletionsOptions;
}

export type ApiStreamOptions<TApi extends Api> = TApi extends keyof ApiOptionsMap
	? ApiOptionsMap[TApi]
	: StreamOptions & Record<string, unknown>;

export interface ProviderStreams {
	stream(model: Model<Api>, context: TranscriptContext, options?: StreamOptions): AssistantMessageEventStream;
	streamSimple(
		model: Model<Api>,
		context: TranscriptContext,
		options?: SimpleStreamOptions,
	): AssistantMessageEventStream;
}

export interface SimpleStreamOptions extends StreamOptions {
	toolChoice?: ToolChoice;
	reasoning?: ThinkingLevel;
	thinkingBudgets?: ThinkingBudgets;
}

export type StreamFunction<TApi extends Api = Api, TOptions extends StreamOptions = StreamOptions> = (
	model: Model<TApi>,
	context: TranscriptContext,
	options?: TOptions,
) => AssistantMessageEventStream;

export interface TextContent {
	type: "text";
	text: string;
	textSignature?: string;
}

export interface ThinkingContent {
	type: "thinking";
	thinking: string;
	thinkingSignature?: string;
	redacted?: boolean;
}

export interface ImageContent {
	type: "image";
	data: string;
	mimeType: string;
}

export interface VideoContent {
	type: "video";
	data: string;
	mimeType: string;
}

export type MediaContent = ImageContent | VideoContent;

export interface ToolCall {
	type: "toolCall";
	id: string;
	name: string;
	arguments: JsonObject;
	thoughtSignature?: string;
	namespace?: string;
}

export interface Usage {
	input: number;
	output: number;
	cacheRead: number;
	cacheWrite: number;
	cacheWrite1h?: number;
	reasoning?: number;
	totalTokens: number;
	cost: {
		input: number;
		output: number;
		cacheRead: number;
		cacheWrite: number;
		total: number;
	};
}

export type StopReason = "pending" | "stop" | "length" | "toolUse" | "error" | "aborted";

export type JsonValue = null | boolean | number | string | readonly JsonValue[] | JsonObject;
export type JsonObject = { [key: string]: JsonValue };

type IsAny<T> = 0 extends 1 & T ? true : false;
type IsExactlyJsonValue<T> = [T] extends [JsonValue] ? ([JsonValue] extends [T] ? true : false) : false;
type IsJsonProperty<T> =
	IsAny<T> extends true
		? false
		: unknown extends T
			? false
			: [Exclude<T, undefined>] extends [never]
				? true
				: IsJsonCompatible<Exclude<T, undefined>>;
type InvalidJsonKeys<T extends object> = {
	[TKey in keyof T]-?: TKey extends string | number ? (IsJsonProperty<T[TKey]> extends true ? never : TKey) : TKey;
}[keyof T];
type IsJsonCompatible<T> =
	IsAny<T> extends true
		? false
		: unknown extends T
			? false
			: IsExactlyJsonValue<T> extends true
				? true
				: T extends null | boolean | number | string
					? true
					: T extends undefined
						? false
						: T extends readonly (infer TItem)[]
							? IsJsonCompatible<TItem>
							: T extends (...args: never[]) => unknown
								? false
								: T extends object
									? [InvalidJsonKeys<T>] extends [never]
										? true
										: false
									: false;

export type JsonRepresentation<T> =
	IsAny<T> extends true
		? JsonValue
		: unknown extends T
			? JsonValue
			: [T] extends [JsonValue]
				? T
				: T extends readonly unknown[]
					? { [TKey in keyof T]: JsonRepresentation<Exclude<T[TKey], undefined>> }
					: T extends object
						? { [TKey in keyof T]: JsonRepresentation<Exclude<T[TKey], undefined>> }
						: never;

export interface SystemMessage {
	role: "system";
	content: string | TextContent[];
	sections?: Record<string, string | null>;
	toolsAdded?: Tool[];
	toolsRemoved?: ToolReference[];
	timestamp: number;
}

export interface UserMessage {
	role: "user";
	content: string | (TextContent | ImageContent | VideoContent)[];
	timestamp: number;
}

export interface AssistantMessage {
	role: "assistant";
	content: (TextContent | ThinkingContent | ToolCall)[];
	api: Api;
	provider: ProviderId;
	model: string;
	responseModel?: string;
	responseId?: string;
	providerThinkingLevel?: string;
	diagnostics?: AssistantMessageDiagnostic[];
	usage: Usage;
	stopReason: StopReason;
	errorMessage?: string;
	rawStopReason?: string;
	timestamp: number;
}

export type ToolResultMessage<TDetails = JsonValue> =
	IsJsonCompatible<TDetails> extends true
		? {
				role: "toolResult";
				toolCallId: string;
				toolName: string;
				content: (TextContent | ImageContent | VideoContent)[];
				details?: JsonRepresentation<TDetails>;
				usage?: Usage;
				isError: boolean;
				timestamp: number;
			}
		: never;

export type Message = SystemMessage | UserMessage | AssistantMessage | ToolResultMessage;

import type { TSchema } from "typebox";

export type GrammarFormat = "openai_lark" | "openai_regex";

export type GrammarVariants = Partial<Record<GrammarFormat, string>>;

export type ConstrainedSamplingConfig =
	| {
			type: "json_schema";
			strict: "prefer" | "require";
	  }
	| {
			type: "grammar";
			variants: GrammarVariants;
	  };

export interface Tool<TParameters extends TSchema = TSchema> {
	name: string;
	description: string;
	parameters: TParameters;
	constrainedSampling?: false | ConstrainedSamplingConfig;
}

export interface ToolReference {
	name: string;
}

export interface Context {
	systemPrompt?: string;
	messages: Message[];
	tools?: Tool[];
}

declare const transcriptContextBrand: unique symbol;

export type TranscriptContext = {
	messages: Message[];
	readonly [transcriptContextBrand]: true;
};

export type AssistantMessageEvent =
	| { type: "start"; partial: AssistantMessage }
	| { type: "text_start"; contentIndex: number; partial: AssistantMessage }
	| { type: "text_delta"; contentIndex: number; delta: string; partial: AssistantMessage }
	| { type: "text_end"; contentIndex: number; content: string; partial: AssistantMessage }
	| { type: "thinking_start"; contentIndex: number; partial: AssistantMessage }
	| { type: "thinking_delta"; contentIndex: number; delta: string; partial: AssistantMessage }
	| { type: "thinking_end"; contentIndex: number; content: string; partial: AssistantMessage }
	| { type: "toolcall_start"; contentIndex: number; partial: AssistantMessage }
	| { type: "toolcall_delta"; contentIndex: number; delta: string; partial: AssistantMessage }
	| { type: "toolcall_end"; contentIndex: number; toolCall: ToolCall; partial: AssistantMessage }
	| {
			type: "done";
			reason: Extract<StopReason, "stop" | "length" | "toolUse">;
			message: AssistantMessage;
	  }
	| { type: "error"; reason: Extract<StopReason, "aborted" | "error">; error: AssistantMessage };

export interface OpenAICompletionsCompat {
	supportsStore?: boolean;
	supportsDeveloperRole?: boolean;
	supportsReasoningEffort?: boolean;
	supportsUsageInStreaming?: boolean;
	supportsFinishReason?: boolean;
	maxTokensField?: "max_completion_tokens" | "max_tokens";
	requiresToolResultName?: boolean;
	requiresAssistantAfterToolResult?: boolean;
	requiresThinkingAsText?: boolean;
	thinkingFormat?: "openai" | "openrouter" | "chat-template" | "qwen-chat-template";
	chatTemplateKwargs?: Record<string, ChatTemplateKwargValue>;
	openRouterRouting?: OpenRouterRouting;
	thinkingTokenBudgetField?: ThinkingTokenBudgetField;
	supportsThinkingTokenBudget?: boolean;
	supportsOpenAIGrammarTools?: boolean;
	supportsMidConvoSystemMessages?: boolean;
	supportsMidConvoToolAdditions?: boolean;
	supportsStrictMode?: boolean;
	cacheControlFormat?: "anthropic";
	sendSessionAffinityHeaders?: boolean;
	sessionAffinityFormat?: SessionAffinityFormat;
	supportsLongCacheRetention?: boolean;
	vllmPriority?: number;
}

export interface OpenRouterRouting {
	allow_fallbacks?: boolean;
	require_parameters?: boolean;
	data_collection?: "deny" | "allow";
	zdr?: boolean;
	enforce_distillable_text?: boolean;
	order?: string[];
	only?: string[];
	ignore?: string[];
	quantizations?: string[];
	sort?:
		| string
		| {
				by?: string;
				partition?: string | null;
		  };
	max_price?: {
		prompt?: number | string;
		completion?: number | string;
		image?: number | string;
		audio?: number | string;
		request?: number | string;
	};
	preferred_min_throughput?:
		| number
		| {
				p50?: number;
				p75?: number;
				p90?: number;
				p99?: number;
		  };
	preferred_max_latency?:
		| number
		| {
				p50?: number;
				p75?: number;
				p90?: number;
				p99?: number;
		  };
}

export interface ModelCostRates {
	input: number;
	output: number;
	cacheRead: number;
	cacheWrite: number;
}

export interface ModelCostTier extends ModelCostRates {
	inputTokensAbove: number;
}

export interface ModelCost extends ModelCostRates {
	tiers?: ModelCostTier[];
}

export type InputModality = "text" | "image" | "video";

export interface BaseModel<TApi extends string> {
	id: string;
	name: string;
	api: TApi;
	provider: ProviderId;
	baseUrl: string;
	input: InputModality[];
	cost: ModelCost;
	headers?: Record<string, string>;
}

export interface Model<TApi extends Api> extends BaseModel<TApi> {
	reasoning: boolean;
	thinkingLevelMap?: ThinkingLevelMap;
	promptCache?: ModelPromptCache;
	contextWindow: number;
	maxTokens: number;
	samplingParams?: Record<string, unknown>;
	compat?: TApi extends "openai-completions" ? OpenAICompletionsCompat : never;
}
