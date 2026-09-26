import { existsSync, mkdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
	type Api,
	type AssistantMessage,
	createAssistantMessageEventStream,
	type Model,
	normalizeContext,
	type ProviderHeaders,
	type SimpleStreamOptions,
} from "@earendil-works/pi-ai";
import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { AuthStorage } from "../src/core/auth-storage.ts";
import { createAgentSession } from "../src/core/sdk.ts";
import { SessionManager } from "../src/core/session-manager.ts";
import { SettingsManager } from "../src/core/settings-manager.ts";
import { createInMemoryModelRegistry, getModelRuntime } from "./model-runtime-test-utils.ts";

describe("createAgentSession provider headers", () => {
	let tempDir: string;
	let cwd: string;
	let agentDir: string;

	beforeEach(() => {
		tempDir = join(tmpdir(), `pi-sdk-headers-test-${Date.now()}-${Math.random().toString(36).slice(2)}`);
		cwd = join(tempDir, "project");
		agentDir = join(tempDir, "agent");
		mkdirSync(cwd, { recursive: true });
		mkdirSync(agentDir, { recursive: true });
	});

	afterEach(() => {
		if (tempDir && existsSync(tempDir)) {
			rmSync(tempDir, { recursive: true, force: true });
		}
	});

	function createModel(provider: string, baseUrl: string, id = `${provider}-test-model`): Model<Api> {
		return {
			id,
			name: `${provider} Test Model`,
			api: "openai-completions",
			provider,
			baseUrl,
			reasoning: false,
			input: ["text"],
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
			contextWindow: 128000,
			maxTokens: 4096,
		};
	}

	function createDoneStream() {
		const stream = createAssistantMessageEventStream();
		const message: AssistantMessage = {
			role: "assistant",
			content: [{ type: "text", text: "ok" }],
			api: "openai-completions",
			provider: "capture-provider",
			model: "capture-model",
			usage: {
				input: 0,
				output: 0,
				cacheRead: 0,
				cacheWrite: 0,
				totalTokens: 0,
				cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
			},
			stopReason: "stop",
			timestamp: Date.now(),
		};
		stream.end(message);
		return stream;
	}

	async function captureHeaders(
		model: Model<Api>,
		options: {
			providerHeaders?: Record<string, string>;
			requestHeaders?: Record<string, string>;
			sessionId?: string;
		} = {},
	): Promise<ProviderHeaders | undefined> {
		const settingsManager = SettingsManager.create(cwd, agentDir);

		const authStorage = AuthStorage.inMemory({
			[model.provider]: { type: "api_key", key: "test-api-key" },
		});
		const modelRegistry = await createInMemoryModelRegistry(authStorage);
		let capturedOptions: SimpleStreamOptions | undefined;

		modelRegistry.registerProvider(model.provider, {
			api: model.api,
			headers: options.providerHeaders,
			streamSimple: (_model, _context, providerOptions) => {
				capturedOptions = providerOptions;
				return createDoneStream();
			},
		});

		const modelRuntime = getModelRuntime(modelRegistry);
		const sessionManager = SessionManager.inMemory(cwd);
		if (options.sessionId) {
			sessionManager.newSession({ id: options.sessionId });
		}

		const { session } = await createAgentSession({
			cwd,
			agentDir,
			model,
			modelRuntime,
			settingsManager,
			sessionManager,
		});

		try {
			const stream = await session.agent.streamFunction(model, normalizeContext({ messages: [] }), {
				sessionId: session.sessionId,
				...(options.requestHeaders ? { headers: options.requestHeaders } : {}),
			});
			await stream.result();
			return capturedOptions?.headers;
		} finally {
			session.dispose();
			modelRegistry.unregisterProvider(model.provider);
		}
	}

	it("passes provider and request headers through", async () => {
		const headers = await captureHeaders(createModel("openrouter", "https://openrouter.ai/api/v1"), {
			providerHeaders: {
				"HTTP-Referer": "https://provider.example",
				"X-OpenRouter-Categories": "provider-category",
			},
			requestHeaders: {
				"X-OpenRouter-Title": "request-title",
			},
		});

		expect(headers?.["HTTP-Referer"]).toBe("https://provider.example");
		expect(headers?.["X-OpenRouter-Title"]).toBe("request-title");
		expect(headers?.["X-OpenRouter-Categories"]).toBe("provider-category");
	});
});
