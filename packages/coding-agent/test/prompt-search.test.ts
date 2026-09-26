import { setKeybindings } from "@earendil-works/pi-tui";
import { beforeAll, beforeEach, describe, expect, it } from "bun:test";
import { KeybindingsManager } from "../src/core/keybindings.ts";
import type { SessionPrompts } from "../src/core/session-store.ts";
import { PromptSearchComponent, searchTerms } from "../src/modes/interactive/components/prompt-search.ts";

function stripAnsi(text: string): string {
	return text.replace(/\x1B\[[0-?]*[ -/]*[@-~]/g, "");
}

function noSession(sessionId: string): SessionPrompts {
	throw new Error(`unexpected session ${sessionId}`);
}

function type(component: PromptSearchComponent, text: string): void {
	for (const char of text) component.handleInput(char);
}

describe("searchTerms", () => {
	it("lowercases and splits on whitespace", () => {
		expect(searchTerms('  Foo "bar"  baz ')).toEqual(["foo", "bar", "baz"]);
	});
});

describe("PromptSearchComponent", () => {
	beforeAll(() => {});

	beforeEach(() => {
		setKeybindings(new KeybindingsManager());
	});

	it("lists recent prompts initially and searches as the query is typed", () => {
		const queries: string[] = [];
		const component = new PromptSearchComponent(
			(query) => {
				queries.push(query);
				return [];
			},
			noSession,
			() => 20,
			() => {},
			() => {},
		);

		type(component, "abc");

		expect(queries).toEqual(["", "a", "ab", "abc"]);
	});

	it("renders whole prompts at the requested height", () => {
		const component = new PromptSearchComponent(
			() => [
				{ seq: 2, sessionId: "a", text: "first line\nuse sqlite here\nlast line" },
				{ seq: 1, sessionId: "a", text: "sqlite again" },
			],
			noSession,
			() => 10,
			() => {},
			() => {},
		);

		type(component, "sqlite");
		const lines = component.render(80).map(stripAnsi);

		expect(lines).toHaveLength(10);
		expect(lines.slice(0, 6).map((line) => line.trimEnd())).toEqual([
			"› first line",
			"  use sqlite here",
			"  last line",
			"",
			"  sqlite again",
			"",
		]);
		expect(lines[8]?.trimEnd()).toBe("search: sqlite");
	});

	it("truncates a prompt taller than the results area", () => {
		const component = new PromptSearchComponent(
			() => [{ seq: 1, sessionId: "a", text: "1\n2\n3\n4\n5\n6" }],
			noSession,
			() => 7,
			() => {},
			() => {},
		);

		const lines = component.render(80).map(stripAnsi);

		expect(lines.slice(0, 4).map((line) => line.trimEnd())).toEqual(["› 1", "  2", "  … 4 more lines", ""]);
	});

	it("scrolls by whole prompts to keep the selected prompt visible", () => {
		const component = new PromptSearchComponent(
			() => [
				{ seq: 3, sessionId: "a", text: "first\nprompt" },
				{ seq: 2, sessionId: "a", text: "second\nprompt" },
				{ seq: 1, sessionId: "a", text: "third\nprompt" },
			],
			noSession,
			() => 9,
			() => {},
			() => {},
		);

		component.handleInput("\x1b[B");
		component.handleInput("\x1b[B");
		const lines = component.render(80).map(stripAnsi);

		expect(lines.slice(0, 6).map((line) => line.trimEnd())).toEqual([
			"  second",
			"  prompt",
			"",
			"› third",
			"  prompt",
			"",
		]);
	});

	it("selects the highlighted prompt on enter", () => {
		const selected: string[] = [];
		const component = new PromptSearchComponent(
			() => [
				{ seq: 2, sessionId: "a", text: "first" },
				{ seq: 1, sessionId: "a", text: "second\nline" },
			],
			noSession,
			() => 20,
			(prompt) => selected.push(prompt),
			() => {},
		);

		component.handleInput("\x1b[B");
		component.handleInput("\r");

		expect(selected).toEqual(["second\nline"]);
	});

	it("opens the session of the selected result on tab around that prompt", () => {
		const selected: string[] = [];
		const component = new PromptSearchComponent(
			() => [
				{ seq: 20, sessionId: "other", text: "deploy staging" },
				{ seq: 13, sessionId: "a", text: "deploy prod" },
			],
			(sessionId) => ({
				sessionId,
				cwd: "/tmp/project-a",
				name: "release",
				prompts: [
					{ seq: 16, sessionId, text: "p6" },
					{ seq: 15, sessionId, text: "p5" },
					{ seq: 14, sessionId, text: "p4" },
					{ seq: 13, sessionId, text: "deploy prod" },
					{ seq: 12, sessionId, text: "p2" },
					{ seq: 11, sessionId, text: "p1" },
					{ seq: 10, sessionId, text: "p0" },
				],
			}),
			() => 13,
			(prompt) => selected.push(prompt),
			() => {},
		);

		component.handleInput("\x1b[B");
		component.handleInput("\t");
		const lines = component.render(80).map(stripAnsi);

		expect(lines.slice(0, 10).map((line) => line.trimEnd())).toEqual([
			"  p5",
			"",
			"  p4",
			"",
			"› deploy prod",
			"",
			"  p2",
			"",
			"  p1",
			"",
		]);
		expect(lines[11]?.trimEnd()).toBe("session: release · /tmp/project-a");

		component.handleInput("\x1b[B");
		component.handleInput("\r");

		expect(selected).toEqual(["p2"]);
	});

	it("returns to the results with the same selection on tab", () => {
		const component = new PromptSearchComponent(
			() => [
				{ seq: 2, sessionId: "a", text: "first" },
				{ seq: 1, sessionId: "a", text: "second" },
			],
			(sessionId) => ({
				sessionId,
				cwd: "/tmp/project-a",
				name: undefined,
				prompts: [
					{ seq: 2, sessionId, text: "first" },
					{ seq: 1, sessionId, text: "second" },
				],
			}),
			() => 10,
			() => {},
			() => {},
		);

		component.handleInput("\x1b[B");
		component.handleInput("\t");
		component.handleInput("\x1b[A");
		component.handleInput("\t");
		const lines = component.render(80).map(stripAnsi);

		expect(lines.slice(0, 4).map((line) => line.trimEnd())).toEqual(["  first", "", "› second", ""]);
		expect(lines[8]?.trimEnd()).toBe("search:");
	});

	it("cancels on escape", () => {
		let cancelled = false;
		const component = new PromptSearchComponent(
			() => [],
			noSession,
			() => 20,
			() => {},
			() => {
				cancelled = true;
			},
		);

		component.handleInput("\x1b");

		expect(cancelled).toBe(true);
	});
});
