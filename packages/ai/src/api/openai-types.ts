export interface ChatCompletionContentPartText {
	type: "text";
	text: string;
}

export interface ChatCompletionContentPartImage {
	type: "image_url";
	image_url: { url: string; detail?: "auto" | "low" | "high" };
}

export type ChatCompletionContentPart = ChatCompletionContentPartText | ChatCompletionContentPartImage;

export interface ChatCompletionSystemMessageParam {
	role: "system";
	content: string | ChatCompletionContentPartText[];
	name?: string;
}

export interface ChatCompletionDeveloperMessageParam {
	role: "developer";
	content: string | ChatCompletionContentPartText[];
	name?: string;
}

export interface ChatCompletionUserMessageParam {
	role: "user";
	content: string | ChatCompletionContentPart[];
	name?: string;
}

export interface ChatCompletionMessageFunctionToolCall {
	id: string;
	type: "function";
	function: { name: string; arguments: string };
}

export interface ChatCompletionMessageCustomToolCall {
	id: string;
	type: "custom";
	custom: { name: string; input: string };
}

export type ChatCompletionMessageToolCall = ChatCompletionMessageFunctionToolCall | ChatCompletionMessageCustomToolCall;

export interface ChatCompletionAssistantMessageParam {
	role: "assistant";
	content?: string | ChatCompletionContentPartText[] | null;
	name?: string;
	refusal?: string | null;
	tool_calls?: ChatCompletionMessageToolCall[];
}

export interface ChatCompletionToolMessageParam {
	role: "tool";
	content: string | ChatCompletionContentPartText[];
	tool_call_id: string;
}

export type ChatCompletionMessageParam =
	| ChatCompletionDeveloperMessageParam
	| ChatCompletionSystemMessageParam
	| ChatCompletionUserMessageParam
	| ChatCompletionAssistantMessageParam
	| ChatCompletionToolMessageParam;

export interface ChatCompletionFunctionTool {
	type: "function";
	function: {
		name: string;
		description?: string;
		parameters?: Record<string, unknown>;
		strict?: boolean | null;
	};
}

export interface ChatCompletionCustomTool {
	type: "custom";
	custom: {
		name: string;
		description?: string;
		format?: { type: "text" } | { type: "grammar"; grammar: { definition: string; syntax: "lark" | "regex" } };
	};
}

export type ChatCompletionTool = ChatCompletionFunctionTool | ChatCompletionCustomTool;

export type ChatCompletionToolChoiceOption =
	| "none"
	| "auto"
	| "required"
	| { type: "function"; function: { name: string } }
	| { type: "custom"; custom: { name: string } }
	| { type: "allowed_tools"; allowed_tools: { mode: "auto" | "required"; tools: Record<string, unknown>[] } };

export interface ChatCompletionChunkToolCall {
	index: number;
	id?: string;
	type?: "function";
	function?: { name?: string; arguments?: string };
}

export interface ChatCompletionChunkChoice {
	index: number;
	delta: {
		content?: string | null;
		refusal?: string | null;
		role?: "developer" | "system" | "user" | "assistant" | "tool";
		tool_calls?: ChatCompletionChunkToolCall[];
	};
	finish_reason: "stop" | "length" | "tool_calls" | "content_filter" | "function_call" | null;
}

export interface CompletionUsage {
	prompt_tokens: number;
	completion_tokens: number;
	total_tokens: number;
	prompt_tokens_details?: { cached_tokens?: number };
	completion_tokens_details?: { reasoning_tokens?: number };
}

export interface ChatCompletionChunk {
	id: string;
	object: "chat.completion.chunk";
	created: number;
	model: string;
	choices: ChatCompletionChunkChoice[];
	usage?: CompletionUsage | null;
}

export interface ChatCompletionCreateParamsStreaming {
	model: string;
	messages: ChatCompletionMessageParam[];
	stream: true;
	stream_options?: { include_usage?: boolean };
	tools?: ChatCompletionTool[];
	tool_choice?: ChatCompletionToolChoiceOption;
	max_tokens?: number | null;
	max_completion_tokens?: number | null;
	[key: string]: unknown;
}
