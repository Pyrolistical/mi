import type { MediaContent } from "@earendil-works/pi-ai";
import type { Args } from "./args.ts";

export interface InitialMessageInput {
	parsed: Args;
	fileText?: string;
	fileImages?: MediaContent[];
}

export interface InitialMessageResult {
	initialMessage?: string;
	initialImages?: MediaContent[];
}

export function buildInitialMessage({ parsed, fileText, fileImages }: InitialMessageInput): InitialMessageResult {
	const parts: string[] = [];
	if (fileText) {
		parts.push(fileText);
	}

	if (parsed.messages.length > 0) {
		parts.push(parsed.messages[0]);
		parsed.messages.shift();
	}

	return {
		initialMessage: parts.length > 0 ? parts.join("") : undefined,
		initialImages: fileImages && fileImages.length > 0 ? fileImages : undefined,
	};
}
