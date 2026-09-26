import { setKeybindings } from "@earendil-works/pi-tui";
import { beforeAll, beforeEach, describe, expect, it } from "bun:test";
import { KeybindingsManager } from "../src/core/keybindings.ts";
import type { SessionInfo } from "../src/core/session-manager.ts";
import { SessionSelectorComponent } from "../src/modes/interactive/components/session-selector.ts";

function stripAnsi(text: string): string {
	return text.replace(/\x1B\[[0-?]*[ -/]*[@-~]/g, "");
}

function makeSession(overrides: Partial<SessionInfo> & { id: string }): SessionInfo {
	return {
		id: overrides.id,
		cwd: overrides.cwd ?? "",
		name: overrides.name,
		parentSessionId: overrides.parentSessionId,
		created: overrides.created ?? new Date(0),
		modified: overrides.modified ?? new Date(0),
		messageCount: overrides.messageCount ?? 1,
		firstMessage: overrides.firstMessage ?? "hello",
		allMessagesText: overrides.allMessagesText ?? "hello",
	};
}

const CTRL_D = "\x04";
const CTRL_BACKSPACE = "\x1b[127;5u";

describe("session selector delete and threading", () => {
	const keybindings = new KeybindingsManager();

	beforeEach(() => {
		setKeybindings(new KeybindingsManager());
	});

	beforeAll(() => {});

	it("does not treat Ctrl+Backspace as delete when search query is non-empty", () => {
		const sessions = [makeSession({ id: "a" }), makeSession({ id: "b" })];
		const selector = new SessionSelectorComponent(
			() => sessions,
			() => [],
			() => {},
			() => {},
			() => {},
			() => {},
			() => {},
			{ keybindings },
		);

		const list = selector.getSessionList();
		const confirmationChanges: Array<string | null> = [];
		list.onDeleteConfirmationChange = (id) => confirmationChanges.push(id);

		list.handleInput("a");
		list.handleInput(CTRL_BACKSPACE);

		expect(confirmationChanges).toEqual([]);
	});

	it("enters confirmation mode on Ctrl+D even with a non-empty search query", () => {
		const sessions = [makeSession({ id: "a" }), makeSession({ id: "b" })];
		const selector = new SessionSelectorComponent(
			() => sessions,
			() => [],
			() => {},
			() => {},
			() => {},
			() => {},
			() => {},
			{ keybindings },
		);

		const list = selector.getSessionList();
		const confirmationChanges: Array<string | null> = [];
		list.onDeleteConfirmationChange = (id) => confirmationChanges.push(id);

		list.handleInput("a");
		list.handleInput(CTRL_D);

		expect(confirmationChanges).toEqual(["a"]);
	});

	it("deletes the confirmed session and reloads the list", () => {
		let sessions = [
			makeSession({ id: "a", firstMessage: "first" }),
			makeSession({ id: "b", firstMessage: "second" }),
		];
		const deleted: string[] = [];
		const selector = new SessionSelectorComponent(
			() => sessions,
			() => [],
			(id) => {
				deleted.push(id);
				sessions = sessions.filter((session) => session.id !== id);
			},
			() => {},
			() => {},
			() => {},
			() => {},
			{ keybindings },
		);

		const list = selector.getSessionList();
		list.handleInput(CTRL_BACKSPACE);
		list.handleInput("\r");

		expect(deleted).toEqual(["a"]);
		const output = stripAnsi(selector.render(120).join("\n"));
		expect(output).not.toContain("first");
		expect(output).toContain("second");
	});

	it("shows all sessions after toggling scope", () => {
		const selector = new SessionSelectorComponent(
			() => [makeSession({ id: "current", firstMessage: "current prompt" })],
			() => [makeSession({ id: "other", firstMessage: "other prompt" })],
			() => {},
			() => {},
			() => {},
			() => {},
			() => {},
			{ keybindings },
		);

		selector.getSessionList().handleInput("\t");

		const output = stripAnsi(selector.render(120).join("\n"));
		expect(output).toContain("Resume Session (All)");
		expect(output).toContain("other prompt");
	});

	it("threads child sessions under their parent", () => {
		const sessions = [
			makeSession({ id: "parent", name: "Parent", modified: new Date("2026-01-01T00:00:00.000Z") }),
			makeSession({
				id: "child",
				parentSessionId: "parent",
				name: "Child",
				modified: new Date("2025-12-31T00:00:00.000Z"),
			}),
		];
		const selector = new SessionSelectorComponent(
			() => sessions,
			() => [],
			() => {},
			() => {},
			() => {},
			() => {},
			() => {},
			{ keybindings },
		);

		const output = stripAnsi(selector.render(120).join("\n"));
		expect(output).toContain("Parent");
		expect(output).toContain("└─ Child");
	});

	it("sorts threaded sessions by latest activity in their subtree", () => {
		const parentOne = makeSession({
			id: "parent-one",
			name: "Parent one",
			modified: new Date("2026-01-02T00:00:00.000Z"),
		});
		const parentTwo = makeSession({
			id: "parent-two",
			name: "Parent two",
			modified: new Date("2026-01-01T00:00:00.000Z"),
		});
		const childTwo = makeSession({
			id: "child-two",
			name: "Child two",
			parentSessionId: "parent-two",
			modified: new Date("2026-01-03T00:00:00.000Z"),
		});
		const selector = new SessionSelectorComponent(
			() => [parentOne, parentTwo, childTwo],
			() => [],
			() => {},
			() => {},
			() => {},
			() => {},
			() => {},
			{ keybindings },
		);

		const output = stripAnsi(selector.render(120).join("\n"));
		const parentTwoIndex = output.indexOf("Parent two");
		const childTwoIndex = output.indexOf("└─ Child two");
		const parentOneIndex = output.indexOf("Parent one");

		expect(parentTwoIndex).toBeGreaterThanOrEqual(0);
		expect(childTwoIndex).toBeGreaterThan(parentTwoIndex);
		expect(parentOneIndex).toBeGreaterThan(childTwoIndex);
	});

	it("refuses to delete the current session", () => {
		const sessions = [makeSession({ id: "parent", name: "Parent" })];
		const selector = new SessionSelectorComponent(
			() => sessions,
			() => [],
			() => {},
			() => {},
			() => {},
			() => {},
			() => {},
			{ keybindings },
			"parent",
		);

		const list = selector.getSessionList();
		const confirmationChanges: Array<string | null> = [];
		let errorMessage: string | undefined;
		list.onDeleteConfirmationChange = (id) => confirmationChanges.push(id);
		list.onError = (message) => {
			errorMessage = message;
		};

		list.handleInput(CTRL_D);

		expect(confirmationChanges).toEqual([]);
		expect(errorMessage).toBe("Cannot delete the currently active session");
	});
});
