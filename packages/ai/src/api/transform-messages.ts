import type {
	Api,
	AssistantMessage,
	MediaContent,
	Message,
	Model,
	TextContent,
	ToolCall,
	ToolResultMessage,
} from "../types.ts";

const MEDIA_PLACEHOLDERS: Record<MediaContent["type"], { user: string; tool: string }> = {
	image: {
		user: "(image omitted: model does not support images)",
		tool: "(tool image omitted: model does not support images)",
	},
	video: {
		user: "(video omitted: model does not support video)",
		tool: "(tool video omitted: model does not support video)",
	},
};

function replaceUnsupportedMedia(
	content: (TextContent | MediaContent)[],
	unsupported: ReadonlySet<MediaContent["type"]>,
	source: "user" | "tool",
): (TextContent | MediaContent)[] {
	const result: (TextContent | MediaContent)[] = [];
	let previousPlaceholder: string | undefined;

	for (const block of content) {
		if (block.type !== "text" && unsupported.has(block.type)) {
			const placeholder = MEDIA_PLACEHOLDERS[block.type][source];
			if (previousPlaceholder !== placeholder) {
				result.push({ type: "text", text: placeholder });
			}
			previousPlaceholder = placeholder;
			continue;
		}

		result.push(block);
		previousPlaceholder = block.type === "text" ? block.text : undefined;
	}

	return result;
}

function downgradeUnsupportedMedia<TApi extends Api>(messages: Message[], model: Model<TApi>): Message[] {
	const unsupported = new Set((["image", "video"] as const).filter((modality) => !model.input.includes(modality)));
	if (unsupported.size === 0) {
		return messages;
	}

	return messages.map((msg) => {
		if (msg.role === "user" && Array.isArray(msg.content)) {
			return {
				...msg,
				content: replaceUnsupportedMedia(msg.content, unsupported, "user"),
			};
		}

		if (msg.role === "toolResult") {
			return {
				...msg,
				content: replaceUnsupportedMedia(msg.content, unsupported, "tool"),
			};
		}

		return msg;
	});
}

export function transformMessages<TApi extends Api>(
	messages: Message[],
	model: Model<TApi>,
	normalizeToolCallId?: (id: string, model: Model<TApi>, source: AssistantMessage) => string,
): Message[] {
	const toolCallIdMap = new Map<string, string>();
	const normalizedMessages = messages.map((msg) => (msg.content == null ? { ...msg, content: [] } : msg));
	const mediaAwareMessages = downgradeUnsupportedMedia(normalizedMessages, model);

	const transformed = mediaAwareMessages.map((msg) => {
		if (msg.role === "system" || msg.role === "user") {
			return msg;
		}

		if (msg.role === "toolResult") {
			const normalizedId = toolCallIdMap.get(msg.toolCallId);
			if (normalizedId && normalizedId !== msg.toolCallId) {
				return { ...msg, toolCallId: normalizedId };
			}
			return msg;
		}

		if (msg.role === "assistant") {
			const assistantMsg = msg as AssistantMessage;
			const isSameModel =
				assistantMsg.provider === model.provider &&
				assistantMsg.api === model.api &&
				assistantMsg.model === model.id;

			const transformedContent = assistantMsg.content.flatMap((block) => {
				if (block.type === "thinking") {
					if (block.redacted) {
						return isSameModel ? block : [];
					}
					if (isSameModel && block.thinkingSignature) return block;
					if (!block.thinking || block.thinking.trim() === "") return [];
					if (isSameModel) return block;
					return {
						type: "text" as const,
						text: block.thinking,
					};
				}

				if (block.type === "text") {
					if (isSameModel) return block;
					return {
						type: "text" as const,
						text: block.text,
					};
				}

				if (block.type === "toolCall") {
					const toolCall = block as ToolCall;
					let normalizedToolCall: ToolCall = toolCall;

					if (!isSameModel && toolCall.thoughtSignature) {
						normalizedToolCall = { ...toolCall };
						delete (normalizedToolCall as { thoughtSignature?: string }).thoughtSignature;
					}

					if (!isSameModel && normalizeToolCallId) {
						const normalizedId = normalizeToolCallId(toolCall.id, model, assistantMsg);
						if (normalizedId !== toolCall.id) {
							toolCallIdMap.set(toolCall.id, normalizedId);
							normalizedToolCall = { ...normalizedToolCall, id: normalizedId };
						}
					}

					return normalizedToolCall;
				}

				return block;
			});

			return {
				...assistantMsg,
				content: transformedContent,
			};
		}
		return msg;
	});

	const result: Message[] = [];
	let pendingToolCalls: ToolCall[] = [];
	let existingToolResultIds = new Set<string>();
	const heldSystemMessages: Message[] = [];
	const closePendingToolCalls = () => {
		if (pendingToolCalls.length > 0) {
			for (const tc of pendingToolCalls) {
				if (!existingToolResultIds.has(tc.id)) {
					result.push({
						role: "toolResult",
						toolCallId: tc.id,
						toolName: tc.name,
						content: [{ type: "text", text: "No result provided" }],
						isError: true,
						timestamp: Date.now(),
					} as ToolResultMessage);
				}
			}
			pendingToolCalls = [];
			existingToolResultIds = new Set();
		}
		result.push(...heldSystemMessages);
		heldSystemMessages.length = 0;
	};

	for (let i = 0; i < transformed.length; i++) {
		const msg = transformed[i];

		if (msg.role === "assistant") {
			closePendingToolCalls();

			const assistantMsg = msg as AssistantMessage;
			if (assistantMsg.stopReason === "error" || assistantMsg.stopReason === "aborted") {
				continue;
			}

			const toolCalls = assistantMsg.content.filter((b) => b.type === "toolCall") as ToolCall[];
			if (toolCalls.length > 0) {
				pendingToolCalls = toolCalls;
				existingToolResultIds = new Set();
			}

			result.push(msg);
		} else if (msg.role === "toolResult") {
			existingToolResultIds.add(msg.toolCallId);
			result.push(msg);
		} else if (msg.role === "system") {
			if (pendingToolCalls.length > 0) {
				heldSystemMessages.push(msg);
			} else {
				result.push(msg);
			}
		} else if (msg.role === "user") {
			closePendingToolCalls();
			result.push(msg);
		} else {
			result.push(msg);
		}
	}

	closePendingToolCalls();

	return result;
}
