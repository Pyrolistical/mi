import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "bun:test";
import { SessionManager } from "../../src/core/session-manager.ts";

const UUID_V7_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

describe("SessionManager.newSession with custom id", () => {
	it("uses the provided id instead of generating one", () => {
		const session = SessionManager.inMemory();
		session.newSession({ id: "my-custom-id" });
		expect(session.getSessionId()).toBe("my-custom-id");
	});

	it("uses the provided id when creating an in-memory session", () => {
		const session = SessionManager.inMemory(process.cwd(), { id: "memory-session-id" });
		expect(session.getSessionId()).toBe("memory-session-id");
		expect(session.getHeader()!.id).toBe("memory-session-id");
		expect(session.isPersisted()).toBe(false);
	});

	it("allows alphanumeric session ids with interior punctuation", () => {
		const session = SessionManager.inMemory();
		session.newSession({ id: "abc-123_def.456" });
		expect(session.getSessionId()).toBe("abc-123_def.456");
	});

	it("rejects invalid custom session ids", () => {
		const invalidIds = ["", "-abc", "abc-", "_abc", "abc_", ".abc", "abc.", "abc/def", "abc\\def", "abc def"];

		for (const id of invalidIds) {
			const session = SessionManager.inMemory();
			expect(() => session.newSession({ id })).toThrow(
				"Session id must be non-empty, contain only alphanumeric characters",
			);
		}
	});

	it("generates a UUIDv7 id when no id is provided", () => {
		const session = SessionManager.inMemory();
		session.newSession();
		const id = session.getSessionId();
		expect(id).toBeDefined();
		expect(id).not.toBe("");
		expect(id).toMatch(UUID_V7_RE);
	});

	it("generates a UUIDv7 id when options is provided without id", () => {
		const session = SessionManager.inMemory();
		session.newSession({ parentSession: "parent.jsonl" });
		const id = session.getSessionId();
		expect(id).toBeDefined();
		expect(id).not.toBe("");
		expect(id).toMatch(UUID_V7_RE);
	});

	it("includes the custom id in the session header", () => {
		const session = SessionManager.inMemory();
		session.newSession({ id: "header-test-id" });

		const header = session.getHeader();
		expect(header).not.toBeNull();
		expect(header!.id).toBe("header-test-id");
	});

	it("generates a UUIDv7 id when constructed without an explicit id", () => {
		const session = SessionManager.inMemory();
		expect(session.getSessionId()).toMatch(UUID_V7_RE);
		expect(session.getHeader()!.id).toBe(session.getSessionId());
	});

	it("uses the provided id when creating a persisted session", () => {
		const tempDir = mkdtempSync(join(tmpdir(), "pi-session-manager-"));
		const session = SessionManager.create(tempDir, tempDir, { id: "created-session-id" });

		expect(session.getSessionId()).toBe("created-session-id");
		expect(session.getHeader()!.id).toBe("created-session-id");
		expect(SessionManager.exists("created-session-id", tempDir)).toBe(false);
	});

	it("generates a UUIDv7 id when creating a branched session", () => {
		const session = SessionManager.inMemory();
		const firstId = session.appendMessage({
			role: "user",
			content: [{ type: "text", text: "hello" }],
			timestamp: Date.now(),
		});

		session.createBranchedSession(firstId);

		expect(session.getSessionId()).toMatch(UUID_V7_RE);
		expect(session.getHeader()!.id).toBe(session.getSessionId());
	});

	it("generates a UUIDv7 id when forking from another session", () => {
		const tempDir = mkdtempSync(join(tmpdir(), "pi-session-manager-"));
		const source = SessionManager.create(tempDir, tempDir, { id: "source-session-id" });
		source.appendMessage({
			role: "assistant",
			content: [{ type: "text", text: "hello" }],
			api: "openai-responses",
			provider: "openai",
			model: "gpt-5.4",
			usage: {
				input: 0,
				output: 0,
				cacheRead: 0,
				cacheWrite: 0,
				totalTokens: 0,
				cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
			},
			stopReason: "stop",
			timestamp: 1,
		});

		const forked = SessionManager.forkFrom("source-session-id", tempDir, tempDir);
		const header = forked.getHeader();
		expect(header!.id).toMatch(UUID_V7_RE);
		expect(header!.parentSession).toBe("source-session-id");
	});

	it("uses the provided id when forking from another session", () => {
		const tempDir = mkdtempSync(join(tmpdir(), "pi-session-manager-"));
		const source = SessionManager.create(tempDir, tempDir, { id: "source-session-id" });
		source.appendMessage({
			role: "assistant",
			content: [{ type: "text", text: "hello" }],
			api: "openai-responses",
			provider: "openai",
			model: "gpt-5.4",
			usage: {
				input: 0,
				output: 0,
				cacheRead: 0,
				cacheWrite: 0,
				totalTokens: 0,
				cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
			},
			stopReason: "stop",
			timestamp: 1,
		});

		const forked = SessionManager.forkFrom("source-session-id", tempDir, tempDir, { id: "forked-session-id" });
		expect(forked.getHeader()!.parentSession).toBe("source-session-id");
		expect(SessionManager.open("forked-session-id", tempDir).getEntries()).toHaveLength(1);
	});
});
