import { createModelRegistry, getModelRuntime } from "./model-runtime-test-utils.ts";

import { existsSync, mkdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Agent } from "@earendil-works/pi-agent-core";
import { streamSimple } from "@earendil-works/pi-ai/compat";
import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { AgentSession, type AgentSessionEvent } from "../src/core/agent-session.ts";
import { AuthStorage } from "../src/core/auth-storage.ts";
import { SessionManager } from "../src/core/session-manager.ts";
import { SettingsManager } from "../src/core/settings-manager.ts";
import { createCodingTools } from "../src/index.ts";
import { API_KEY, createTestResourceLoader } from "./utilities.ts";
import { openaiModel } from "../../ai/test/openai-models.ts";

describe.skipIf(!API_KEY)("AgentSession compaction e2e", () => {
	let session: AgentSession;
	let tempDir: string;
	let sessionManager: SessionManager;
	let events: AgentSessionEvent[];

	beforeEach(async () => {
		tempDir = join(tmpdir(), `pi-compaction-test-${Date.now()}`);
		mkdirSync(tempDir, { recursive: true });

		events = [];
	});

	afterEach(async () => {
		if (session) {
			session.dispose();
		}
		if (tempDir && existsSync(tempDir)) {
			rmSync(tempDir, { recursive: true });
		}
	});

	async function createSession(inMemory = false) {
		const model = openaiModel("gpt-5-mini");
		const agent = new Agent({
			getApiKey: () => API_KEY,
			streamFn: streamSimple,
			initialState: {
				model,
				systemPrompt: "You are a helpful assistant. Be concise.",
				tools: createCodingTools(process.cwd()),
			},
		});

		sessionManager = inMemory ? SessionManager.inMemory() : SessionManager.create(tempDir);
		const settingsManager = SettingsManager.create(tempDir, tempDir);
		settingsManager.applyOverrides({ compaction: { keepRecentTokens: 1 } });
		const authStorage = AuthStorage.create(join(tempDir, "auth.json"));
		const modelRegistry = await createModelRegistry(authStorage);

		session = new AgentSession({
			agent,
			sessionManager,
			settingsManager,
			cwd: tempDir,
			modelRuntime: getModelRuntime(modelRegistry),
			resourceLoader: createTestResourceLoader(),
		});

		session.subscribe((event) => {
			events.push(event);
		});

		return session;
	}

	it("should trigger manual compaction via compact()", async () => {
		await createSession();

		await session.prompt("What is 2+2? Reply with just the number.");
		await session.agent.waitForIdle();

		await session.prompt("What is 3+3? Reply with just the number.");
		await session.agent.waitForIdle();

		const result = await session.compact();

		expect(result.summary).toBeDefined();
		expect(result.summary.length).toBeGreaterThan(0);
		expect(result.tokensBefore).toBeGreaterThan(0);

		const messages = session.messages;
		expect(messages.length).toBeGreaterThan(0);

		const firstMsg = messages[0];
		expect(firstMsg.role).toBe("compactionSummary");
	}, 120000);

	it("should maintain valid session state after compaction", async () => {
		await createSession();

		await session.prompt("What is the capital of France? One word answer.");
		await session.agent.waitForIdle();

		await session.prompt("What is the capital of Germany? One word answer.");
		await session.agent.waitForIdle();

		await session.compact();

		await session.prompt("What is the capital of Italy? One word answer.");
		await session.agent.waitForIdle();

		expect(session.messages.length).toBeGreaterThan(0);

		const assistantMessages = session.messages.filter((m) => m.role === "assistant");
		expect(assistantMessages.length).toBeGreaterThan(0);
	}, 180000);

	it("should persist compaction to session file", async () => {
		await createSession();

		await session.prompt("Say hello");
		await session.agent.waitForIdle();

		await session.prompt("Say goodbye");
		await session.agent.waitForIdle();

		await session.compact();

		const entries = sessionManager.getEntries();

		const compactionEntries = entries.filter((e) => e.type === "compaction");
		expect(compactionEntries.length).toBe(1);

		const compaction = compactionEntries[0];
		expect(compaction.type).toBe("compaction");
		if (compaction.type === "compaction") {
			expect(compaction.summary.length).toBeGreaterThan(0);
			expect(typeof compaction.firstKeptEntryId).toBe("string");
			expect(compaction.tokensBefore).toBeGreaterThan(0);
		}
	}, 120000);

	it("should work with --no-session mode (in-memory only)", async () => {
		await createSession(true);

		await session.prompt("What is 2+2? Reply with just the number.");
		await session.agent.waitForIdle();

		await session.prompt("What is 3+3? Reply with just the number.");
		await session.agent.waitForIdle();

		const result = await session.compact();

		expect(result.summary).toBeDefined();
		expect(result.summary.length).toBeGreaterThan(0);

		const entries = sessionManager.getEntries();
		const compactionEntries = entries.filter((e) => e.type === "compaction");
		expect(compactionEntries.length).toBe(1);
	}, 120000);

	it("should emit compaction events during manual compaction", async () => {
		await createSession();

		await session.prompt("Say hello");
		await session.agent.waitForIdle();

		await session.compact();

		const compactionEvents = events.filter((e) => e.type === "compaction_start" || e.type === "compaction_end");
		expect(compactionEvents).toHaveLength(2);
		expect(compactionEvents[0]).toEqual({ type: "compaction_start", reason: "manual" });
		expect(compactionEvents[1]).toMatchObject({
			type: "compaction_end",
			reason: "manual",
			aborted: false,
			willRetry: false,
		});

		const messageEndEvents = events.filter((e) => e.type === "message_end");
		expect(messageEndEvents.length).toBeGreaterThan(0);
	}, 120000);
});
