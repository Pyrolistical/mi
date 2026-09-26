import { describe, expect, test } from "bun:test";
import type { Args } from "../src/cli/args.ts";
import { buildInitialMessage } from "../src/cli/initial-message.ts";

function createArgs(messages: string[] = []): Args {
	return {
		messages: [...messages],
		fileArgs: [],
		unknownFlags: new Map(),
		diagnostics: [],
	};
}

describe("buildInitialMessage", () => {
	test("combines file text and first CLI message in one prompt", () => {
		const parsed = createArgs(["Explain it", "Second message"]);
		const result = buildInitialMessage({
			parsed,
			fileText: "file\n",
		});

		expect(result.initialMessage).toBe("file\nExplain it");
		expect(parsed.messages).toEqual(["Second message"]);
	});
});
