import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fauxAssistantMessage } from "@earendil-works/pi-ai";
import { describe, expect, it } from "bun:test";
import { SessionManager } from "../../src/core/session-manager.ts";
import { SessionStore } from "../../src/core/session-store.ts";
import { createHarness, getMessageText } from "./harness.ts";

describe("AgentSession mailbox", () => {
	it("wakes a live session with a message sent to its callback", async () => {
		const sessionDir = mkdtempSync(join(tmpdir(), "mi-mailbox-"));
		const session = SessionManager.create("/work", sessionDir, { id: "parser-lexer" });
		const harness = await createHarness({ sessionManager: session });
		try {
			const woken = Promise.withResolvers<string[]>();
			harness.setResponses([
				fauxAssistantMessage("started"),
				(context) => {
					woken.resolve(context.messages.filter((m) => m.role !== "system").map(getMessageText));
					return fauxAssistantMessage("got it");
				},
			]);
			await harness.session.prompt("start the render");
			harness.session.openMailbox();

			SessionManager.sendMessage(
				SessionManager.createMailboxAddress("parser-lexer", session.getSessionIdSignature()!, "render", sessionDir),
				"render finished",
				sessionDir,
			);

			expect(await woken.promise).toEqual([
				"start the render",
				"started",
				"Callback from render\n\nrender finished",
			]);
			await harness.session.waitForIdle();
			expect(SessionStore.open(sessionDir).undeliveredMessages("parser-lexer")).toEqual([]);
		} finally {
			harness.cleanup();
			rmSync(sessionDir, { recursive: true });
		}
	});

	it("delivers a message that arrived while the session was offline when it resumes", async () => {
		const sessionDir = mkdtempSync(join(tmpdir(), "mi-mailbox-"));
		const offline = SessionManager.create("/work", sessionDir, { id: "parser-ast" });
		offline.appendMessage({ role: "user", content: "start the render", timestamp: 1 });
		SessionManager.sendMessage(
			SessionManager.createMailboxAddress("parser-ast", offline.getSessionIdSignature()!, "render", sessionDir),
			"render finished",
			sessionDir,
		);
		const harness = await createHarness({ sessionManager: SessionManager.open("parser-ast", sessionDir) });
		try {
			const woken = Promise.withResolvers<string[]>();
			harness.setResponses([
				(context) => {
					woken.resolve(context.messages.filter((m) => m.role !== "system").map(getMessageText));
					return fauxAssistantMessage("got it");
				},
			]);

			harness.session.openMailbox();

			expect(await woken.promise).toEqual(["start the render", "Callback from render\n\nrender finished"]);
			await harness.session.waitForIdle();
			expect(SessionStore.open(sessionDir).undeliveredMessages("parser-ast")).toEqual([]);
		} finally {
			harness.cleanup();
			rmSync(sessionDir, { recursive: true });
		}
	});

	it("saves a message that arrives during a turn the user interrupts", async () => {
		const sessionDir = mkdtempSync(join(tmpdir(), "mi-mailbox-"));
		const session = SessionManager.create("/work", sessionDir, { id: "parser-token" });
		const harness = await createHarness({ sessionManager: session });
		try {
			const thinking = Promise.withResolvers<void>();
			const release = Promise.withResolvers<void>();
			harness.setResponses([
				async () => {
					thinking.resolve();
					await release.promise;
					return fauxAssistantMessage("thinking");
				},
			]);

			const run = harness.session.prompt("start the render");
			await thinking.promise;
			SessionManager.sendMessage(
				SessionManager.createMailboxAddress("parser-token", session.getSessionIdSignature()!, "render", sessionDir),
				"render finished",
				sessionDir,
			);
			harness.session.openMailbox();
			harness.session.clearQueue();
			const aborted = harness.session.abort();
			release.resolve();
			await run;
			await aborted;

			expect(
				harness.sessionManager
					.getEntries()
					.filter((entry) => entry.type === "custom_message")
					.map((entry) => entry.content),
			).toEqual(["Callback from render\n\nrender finished"]);
			expect(SessionStore.open(sessionDir).undeliveredMessages("parser-token")).toEqual([]);
		} finally {
			harness.cleanup();
			rmSync(sessionDir, { recursive: true });
		}
	});

	it("reports the number of callbacks that have not been called yet", async () => {
		const sessionDir = mkdtempSync(join(tmpdir(), "mi-mailbox-"));
		const session = SessionManager.create("/work", sessionDir, { id: "parser-scope" });
		session.appendMessage({ role: "user", content: "start the render", timestamp: 1 });
		const harness = await createHarness({ sessionManager: session });
		try {
			harness.setResponses([fauxAssistantMessage("got it")]);
			const pending: number[] = [];
			const called = Promise.withResolvers<void>();
			harness.session.subscribe((event) => {
				if (event.type !== "callbacks_update") return;
				pending.push(event.pending);
				if (event.pending === 0) called.resolve();
			});
			const address = SessionManager.createMailboxAddress(
				"parser-scope",
				session.getSessionIdSignature()!,
				"render",
				sessionDir,
			);
			harness.session.openMailbox();

			SessionManager.sendMessage(address, "render finished", sessionDir);
			await called.promise;

			expect(pending).toEqual([1, 0]);
			expect(harness.session.pendingCallbacks).toBe(0);
		} finally {
			harness.cleanup();
			rmSync(sessionDir, { recursive: true });
		}
	});
});
