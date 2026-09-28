import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "bun:test";
import { formatMailboxMessage } from "../src/core/mailbox.ts";
import { SessionManager } from "../src/core/session-manager.ts";
import { SessionStore } from "../src/core/session-store.ts";

function savedFullMessage(text: string): string {
	const path = text.match(/Full message: (.+)\]$/)![1];
	const saved = readFileSync(path, "utf-8");
	rmSync(path);
	return saved;
}

describe("mailbox message formatting", () => {
	it("keeps the first 2000 lines of a long message and saves the full message to a file", () => {
		const body = Array.from({ length: 2500 }, (_, index) => `line ${index + 1}`).join("\n");

		const text = formatMailboxMessage({ id: 1, origin: "render", body, sentAt: 1000 });

		expect(text.startsWith("Callback from render\n\nline 1\nline 2\n")).toBe(true);
		expect(text).toContain("\nline 2000\n\n[Showing lines 1-2000 of 2500. Full message: ");
		expect(text).not.toContain("line 2001");
		expect(savedFullMessage(text)).toBe(body);
	});

	it("keeps the lines of a large message that fit in 50KB and saves the full message to a file", () => {
		const body = Array.from({ length: 100 }, () => "y".repeat(1023)).join("\n");

		const text = formatMailboxMessage({ id: 1, origin: "render", body, sentAt: 1000 });

		expect(text).toContain(`${"y".repeat(1023)}\n\n[Showing lines 1-50 of 100 (50.0KB limit). Full message: `);
		expect(savedFullMessage(text)).toBe(body);
	});

	it("saves a message whose first line is over 50KB to a file", () => {
		const body = "z".repeat(60 * 1024);

		const text = formatMailboxMessage({ id: 1, origin: "render", body, sentAt: 1000 });

		expect(text).toMatch(/^Callback from render\n\n\[Line 1 is 60\.0KB, exceeds 50\.0KB limit\. Full message: .+\]$/);
		expect(savedFullMessage(text)).toBe(body);
	});
});

describe("mailbox", () => {
	it("queues a message sent to a callback until a mailbox entry is saved", () => {
		const sessionDir = mkdtempSync(join(tmpdir(), "mi-mailbox-"));
		try {
			const session = SessionManager.create("/work", sessionDir, { id: "parser-lexer" });
			session.appendMessage({ role: "user", content: "start the render", timestamp: 1 });
			const store = SessionStore.open(sessionDir);

			const signature = store.sessionIdSignature("parser-lexer");
			store.sendMessage(
				store.createMailboxAddress("parser-lexer", signature, "render", 900),
				"render finished",
				1000,
			);
			const [message] = store.undeliveredMessages("parser-lexer");
			expect(message).toEqual({ id: 1, origin: "render", body: "render finished", sentAt: 1000 });

			session.appendCustomMessageEntry("mailbox", "Callback from render\n\nrender finished", true, {
				id: 1,
				origin: "render",
				sentAt: 1000,
			});
			expect(store.undeliveredMessages("parser-lexer")).toEqual([]);
		} finally {
			rmSync(sessionDir, { recursive: true });
		}
	});

	it("counts the callbacks that have not been called yet", () => {
		const sessionDir = mkdtempSync(join(tmpdir(), "mi-mailbox-"));
		try {
			const session = SessionManager.create("/work", sessionDir, { id: "parser-lexer" });
			session.appendMessage({ role: "user", content: "start the render", timestamp: 1 });
			const store = SessionStore.open(sessionDir);
			const signature = store.sessionIdSignature("parser-lexer");

			const render = store.createMailboxAddress("parser-lexer", signature, "render", 900);
			store.createMailboxAddress("parser-lexer", signature, "deploy", 950);
			expect(store.pendingCallbacks("parser-lexer")).toBe(2);

			store.sendMessage(render, "render finished", 1000);
			expect(store.pendingCallbacks("parser-lexer")).toBe(1);
		} finally {
			rmSync(sessionDir, { recursive: true });
		}
	});

	it("rejects a callback whose id was changed", () => {
		const sessionDir = mkdtempSync(join(tmpdir(), "mi-mailbox-"));
		try {
			const session = SessionManager.create("/work", sessionDir, { id: "parser-lexer" });
			session.appendMessage({ role: "user", content: "start the render", timestamp: 1 });
			const store = SessionStore.open(sessionDir);
			const signature = store.sessionIdSignature("parser-lexer");
			store.createMailboxAddress("parser-lexer", signature, "deploy", 900);
			const address = store.createMailboxAddress("parser-lexer", signature, "render", 950);

			expect(() => store.sendMessage(address.replace(/^2:/, "1:"), "render finished", 1000)).toThrow(
				"invalid address signature",
			);
		} finally {
			rmSync(sessionDir, { recursive: true });
		}
	});

	it("refuses to create a callback for a session id signed for another session", () => {
		const sessionDir = mkdtempSync(join(tmpdir(), "mi-mailbox-"));
		try {
			const session = SessionManager.create("/work", sessionDir, { id: "parser-lexer" });
			session.appendMessage({ role: "user", content: "start the render", timestamp: 1 });
			const store = SessionStore.open(sessionDir);

			expect(() =>
				store.createMailboxAddress("parser-lexer", store.sessionIdSignature("parser-ast"), "render", 900),
			).toThrow("invalid session id signature");
		} finally {
			rmSync(sessionDir, { recursive: true });
		}
	});

	it("prints instructions for the agent when mi create-callback has no origin", async () => {
		const cli = join(import.meta.dir, "../src/cli.ts");

		const create = Bun.spawn([process.execPath, cli, "create-callback"], { stderr: "pipe" });

		expect(await create.exited).toBe(0);
		expect(await new Response(create.stdout).text()).toStartWith("Usage: mi create-callback <origin>\n");
	});

	it("sends stdin to the command printed by mi create-callback", async () => {
		const sessionDir = mkdtempSync(join(tmpdir(), "mi-mailbox-"));
		try {
			const session = SessionManager.create("/work", sessionDir, { id: "parser-lexer" });
			session.appendMessage({ role: "user", content: "start the render", timestamp: 1 });
			const cli = join(import.meta.dir, "../src/cli.ts");
			const env = {
				...process.env,
				MI_SESSION_ID: "parser-lexer",
				MI_SESSION_ID_SIGNATURE: session.getSessionIdSignature(),
				MI_SESSION_DIR: sessionDir,
			};

			const create = Bun.spawn([process.execPath, cli, "create-callback", "render video"], { env, stderr: "pipe" });
			const callbackCommand = (await new Response(create.stdout).text()).trim().split(" ");
			expect(await new Response(create.stderr).text()).toBe("");
			expect(callbackCommand.slice(0, 5)).toEqual([process.execPath, cli, "callback", "--session-dir", sessionDir]);

			const callback = Bun.spawn(callbackCommand, {
				stdin: new TextEncoder().encode("render finished"),
				stderr: "pipe",
			});
			expect(await new Response(callback.stderr).text()).toBe("");
			expect(await callback.exited).toBe(0);

			const [message] = SessionStore.open(sessionDir).undeliveredMessages("parser-lexer");
			expect(message).toMatchObject({ origin: "render video", body: "render finished" });
		} finally {
			rmSync(sessionDir, { recursive: true });
		}
	});

	it("creates no callback when mi create-callback cannot print a command that works unquoted", async () => {
		const sessionDir = mkdtempSync(join(tmpdir(), "mi mailbox-"));
		try {
			const session = SessionManager.create("/work", sessionDir, { id: "parser-lexer" });
			session.appendMessage({ role: "user", content: "start the render", timestamp: 1 });
			const cli = join(import.meta.dir, "../src/cli.ts");
			const env = {
				...process.env,
				MI_SESSION_ID: "parser-lexer",
				MI_SESSION_ID_SIGNATURE: session.getSessionIdSignature(),
				MI_SESSION_DIR: sessionDir,
			};

			const create = Bun.spawn([process.execPath, cli, "create-callback", "render"], { env, stderr: "pipe" });

			expect(await create.exited).toBe(1);
			expect(SessionStore.open(sessionDir).pendingCallbacks("parser-lexer")).toBe(0);
		} finally {
			rmSync(sessionDir, { recursive: true });
		}
	});
});
