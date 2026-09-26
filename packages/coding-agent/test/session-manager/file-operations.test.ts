import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { importLegacyJsonlSessions, loadEntriesFromFile, SessionManager } from "../../src/core/session-manager.ts";

const USAGE = {
	input: 1,
	output: 1,
	cacheRead: 0,
	cacheWrite: 0,
	totalTokens: 2,
	cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
};

function persistExchange(session: SessionManager, prompt: string, reply: string, timestamp: number): void {
	session.appendMessage({ role: "user", content: prompt, timestamp });
	session.appendMessage({
		role: "assistant",
		content: [{ type: "text", text: reply }],
		api: "anthropic-messages",
		provider: "anthropic",
		model: "test",
		usage: USAGE,
		stopReason: "stop",
		timestamp: timestamp + 1,
	});
}

describe("loadEntriesFromFile", () => {
	let tempDir: string;

	beforeEach(() => {
		tempDir = mkdtempSync(join(tmpdir(), "session-test-"));
	});

	afterEach(() => {
		rmSync(tempDir, { recursive: true, force: true });
	});

	it("returns empty array for non-existent file", () => {
		expect(loadEntriesFromFile(join(tempDir, "nonexistent.jsonl"))).toEqual([]);
	});

	it("returns empty array for file without valid session header", () => {
		const file = join(tempDir, "no-header.jsonl");
		writeFileSync(file, '{"type":"message","id":"1"}\n');
		expect(loadEntriesFromFile(file)).toEqual([]);
	});

	it("skips malformed lines but keeps valid ones", () => {
		const file = join(tempDir, "mixed.jsonl");
		writeFileSync(
			file,
			'{"type":"session","id":"abc","timestamp":"2025-01-01T00:00:00Z","cwd":"/tmp"}\n' +
				"not valid json\n" +
				'{"type":"message","id":"1","parentId":null,"timestamp":"2025-01-01T00:00:01Z","message":{"role":"user","content":"hi","timestamp":1}}',
		);
		const entries = loadEntriesFromFile(file);
		expect(entries.map((entry) => entry.type)).toEqual(["session", "message"]);
	});
});

describe("SessionManager JSONL import", () => {
	let tempDir: string;

	beforeEach(() => {
		tempDir = mkdtempSync(join(tmpdir(), "session-test-"));
	});

	afterEach(() => {
		rmSync(tempDir, { recursive: true, force: true });
	});

	it("imports a session file and opens it by id", () => {
		const file = join(tempDir, "session.jsonl");
		writeFileSync(
			file,
			'{"type":"session","version":3,"id":"imported","timestamp":"2025-01-01T00:00:00Z","cwd":"/tmp/project"}\n' +
				'{"type":"message","id":"1","parentId":null,"timestamp":"2025-01-01T00:00:01Z","message":{"role":"user","content":"hi","timestamp":1}}\n',
		);

		expect(SessionManager.importJsonl(file, tempDir)).toBe("imported");

		const session = SessionManager.open("imported", tempDir);
		expect(session.getCwd()).toBe("/tmp/project");
		expect(session.buildSessionContext().messages).toEqual([{ role: "user", content: "hi", timestamp: 1 }]);
	});

	it("does not import a stored session id twice", () => {
		const file = join(tempDir, "session.jsonl");
		writeFileSync(
			file,
			'{"type":"session","version":3,"id":"twice","timestamp":"2025-01-01T00:00:00Z","cwd":"/tmp/project"}\n' +
				'{"type":"message","id":"1","parentId":null,"timestamp":"2025-01-01T00:00:01Z","message":{"role":"user","content":"hi","timestamp":1}}\n',
		);

		SessionManager.importJsonl(file, tempDir);
		SessionManager.importJsonl(file, tempDir);

		expect(SessionManager.open("twice", tempDir).getEntries()).toHaveLength(1);
	});

	it("migrates v1 entries on import", () => {
		const file = join(tempDir, "v1.jsonl");
		writeFileSync(
			file,
			'{"type":"session","id":"v1","timestamp":"2025-01-01T00:00:00Z","cwd":"/tmp/project"}\n' +
				'{"type":"message","timestamp":"2025-01-01T00:00:01Z","message":{"role":"user","content":"hi","timestamp":1}}\n',
		);

		SessionManager.importJsonl(file, tempDir);

		const session = SessionManager.open("v1", tempDir);
		expect(session.getHeader()?.version).toBe(3);
		expect(session.getEntries()[0]?.parentId).toBeNull();
	});

	it("imports legacy per-project directories, links parents by id, and renames imported files", () => {
		const projectDir = join(tempDir, "--tmp-project--");
		mkdirSync(projectDir);
		const parentFile = join(projectDir, "2025-01-01_parent.jsonl");
		const childFile = join(projectDir, "2025-01-02_child.jsonl");
		writeFileSync(
			parentFile,
			'{"type":"session","version":3,"id":"parent","timestamp":"2025-01-01T00:00:00Z","cwd":"/tmp/project"}\n',
		);
		writeFileSync(
			childFile,
			`${JSON.stringify({
				type: "session",
				version: 3,
				id: "child",
				timestamp: "2025-01-02T00:00:00Z",
				cwd: "/tmp/project",
				parentSession: parentFile,
			})}\n`,
		);

		expect(importLegacyJsonlSessions(tempDir)).toBe(2);

		expect(SessionManager.open("child", tempDir).getHeader()?.parentSession).toBe("parent");
		expect(existsSync(`${parentFile}.imported`)).toBe(true);
		expect(existsSync(childFile)).toBe(false);
		expect(importLegacyJsonlSessions(tempDir)).toBe(0);
	});
});

describe("SessionManager storage", () => {
	let tempDir: string;

	beforeEach(() => {
		tempDir = mkdtempSync(join(tmpdir(), "session-test-"));
	});

	afterEach(() => {
		rmSync(tempDir, { recursive: true, force: true });
	});

	it("does not store a session with only setup entries", () => {
		const session = SessionManager.create("/tmp/project-a", tempDir);
		session.appendModelChange("openai", "gpt-4o");
		session.appendThinkingLevelChange("off");

		expect(session.isSaved()).toBe(false);
		expect(SessionManager.exists(session.getSessionId(), tempDir)).toBe(false);
	});

	it("stores a session at the first user message", () => {
		const session = SessionManager.create("/tmp/project-a", tempDir);
		session.appendModelChange("openai", "gpt-4o");
		session.appendMessage({ role: "user", content: "pending", timestamp: 1 });

		expect(session.isSaved()).toBe(true);
		expect(
			SessionManager.open(session.getSessionId(), tempDir)
				.getEntries()
				.map((entry) => entry.type),
		).toEqual(["model_change", "message"]);
		expect(SessionManager.searchPrompts("pending", 10, tempDir)).toEqual([
			{ seq: 2, sessionId: session.getSessionId(), text: "pending" },
		]);
	});

	it("reopens stored entries appended after the first save", () => {
		const session = SessionManager.create("/tmp/project-a", tempDir);
		persistExchange(session, "first", "reply", 1000);
		session.appendSessionInfo("named");

		const reopened = SessionManager.open(session.getSessionId(), tempDir);
		expect(reopened.getEntries()).toEqual(session.getEntries());
		expect(reopened.getSessionName()).toBe("named");
		expect(reopened.getLeafId()).toBe(session.getLeafId());
	});

	it("scopes current-folder APIs by cwd while listing all sessions", () => {
		const sessionA = SessionManager.create("/tmp/project-a", tempDir);
		persistExchange(sessionA, "from A", "reply to A", 1000);
		const sessionB = SessionManager.create("/tmp/project-b", tempDir);
		persistExchange(sessionB, "from B", "reply to B", 2000);

		expect(SessionManager.list("/tmp/project-a", tempDir).map((s) => s.id)).toEqual([sessionA.getSessionId()]);
		expect(SessionManager.listAll(tempDir).map((s) => s.id)).toEqual([
			sessionB.getSessionId(),
			sessionA.getSessionId(),
		]);
		expect(SessionManager.continueRecent("/tmp/project-a", tempDir).getSessionId()).toBe(sessionA.getSessionId());
	});

	it("lists session metadata", () => {
		const session = SessionManager.create("/tmp/project-a", tempDir, { id: "listed" });
		persistExchange(session, "first prompt", "first reply", 1000);
		session.appendSessionInfo("my session");

		const [info] = SessionManager.list("/tmp/project-a", tempDir);
		expect(info).toMatchObject({
			id: "listed",
			cwd: "/tmp/project-a",
			name: "my session",
			messageCount: 2,
			firstMessage: "first prompt",
			allMessagesText: "first prompt first reply",
		});
		expect(info?.modified.getTime()).toBe(1001);
	});

	it("finds sessions by id prefix preferring the current cwd", () => {
		const other = SessionManager.create("/tmp/project-b", tempDir, { id: "abc-other" });
		persistExchange(other, "other", "reply", 2000);
		const local = SessionManager.create("/tmp/project-a", tempDir, { id: "abc-local" });
		persistExchange(local, "local", "reply", 1000);

		expect(SessionManager.find("/tmp/project-a", "abc", tempDir)).toEqual({
			id: "abc-local",
			cwd: "/tmp/project-a",
		});
		expect(SessionManager.find("/tmp/project-a", "abc-o", tempDir)).toEqual({
			id: "abc-other",
			cwd: "/tmp/project-b",
		});
	});

	it("deletes a session", () => {
		const session = SessionManager.create("/tmp/project-a", tempDir, { id: "doomed" });
		persistExchange(session, "prompt", "reply", 1000);

		SessionManager.delete("doomed", tempDir);

		expect(SessionManager.exists("doomed", tempDir)).toBe(false);
		expect(SessionManager.searchPrompts("prompt", 10, tempDir)).toEqual([]);
	});

	it("forks a stored session into another cwd", () => {
		const source = SessionManager.create("/tmp/project-a", tempDir, { id: "source" });
		persistExchange(source, "prompt", "reply", 1000);

		const fork = SessionManager.forkFrom("source", "/tmp/project-b", tempDir, { id: "fork" });

		const reopened = SessionManager.open("fork", tempDir);
		expect(reopened.getCwd()).toBe("/tmp/project-b");
		expect(reopened.getHeader()?.parentSession).toBe("source");
		expect(reopened.getEntries()).toEqual(fork.getEntries());
	});
});

describe("SessionManager.searchPrompts", () => {
	let tempDir: string;

	beforeEach(() => {
		tempDir = mkdtempSync(join(tmpdir(), "session-test-"));
	});

	afterEach(() => {
		rmSync(tempDir, { recursive: true, force: true });
	});

	it("matches word prefixes of user prompts across sessions, most recent first", () => {
		const first = SessionManager.create("/tmp/project-a", tempDir, { id: "first" });
		persistExchange(first, "render the table", "rendered", 1000);
		const second = SessionManager.create("/tmp/project-b", tempDir, { id: "second" });
		persistExchange(second, "render the widget", "done rendering", 2000);

		expect(SessionManager.searchPrompts("rend", 10, tempDir)).toEqual([
			{ seq: 3, sessionId: "second", text: "render the widget" },
			{ seq: 1, sessionId: "first", text: "render the table" },
		]);
	});

	it("requires every term to match", () => {
		const session = SessionManager.create("/tmp/project-a", tempDir, { id: "terms" });
		persistExchange(session, "alpha beta", "ok", 1000);
		persistExchange(session, "alpha gamma", "ok", 2000);

		expect(SessionManager.searchPrompts("alpha gam", 10, tempDir)).toEqual([
			{ seq: 3, sessionId: "terms", text: "alpha gamma" },
		]);
	});

	it("lists each prompt once, most recently used first, for an empty query", () => {
		const session = SessionManager.create("/tmp/project-a", tempDir, { id: "recent" });
		persistExchange(session, "continue", "ok", 1000);
		persistExchange(session, "other", "ok", 2000);
		persistExchange(session, "continue", "ok", 3000);

		expect(SessionManager.searchPrompts("", 10, tempDir)).toEqual([
			{ seq: 5, sessionId: "recent", text: "continue" },
			{ seq: 3, sessionId: "recent", text: "other" },
		]);
	});

	it("treats query syntax characters as text", () => {
		const session = SessionManager.create("/tmp/project-a", tempDir, { id: "quotes" });
		persistExchange(session, 'say "hello" OR NOT', "ok", 1000);

		expect(SessionManager.searchPrompts('"hello" OR', 10, tempDir)).toEqual([
			{ seq: 1, sessionId: "quotes", text: 'say "hello" OR NOT' },
		]);
	});
});

describe("SessionManager.sessionPrompts", () => {
	let tempDir: string;

	beforeEach(() => {
		tempDir = mkdtempSync(join(tmpdir(), "session-test-"));
	});

	afterEach(() => {
		rmSync(tempDir, { recursive: true, force: true });
	});

	it("lists the user prompts of one session, most recent first", () => {
		const session = SessionManager.create("/tmp/project-a", tempDir, { id: "a" });
		persistExchange(session, "one", "ok", 1000);
		const other = SessionManager.create("/tmp/project-b", tempDir, { id: "b" });
		persistExchange(other, "other", "ok", 2000);
		persistExchange(session, "two", "ok", 3000);
		session.appendSessionInfo("named");

		expect(SessionManager.sessionPrompts("a", tempDir)).toEqual({
			sessionId: "a",
			cwd: "/tmp/project-a",
			name: "named",
			prompts: [
				{ seq: 5, sessionId: "a", text: "two" },
				{ seq: 1, sessionId: "a", text: "one" },
			],
		});
	});
});
