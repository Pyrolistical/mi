import { describe, expect, it } from "vitest";
import { envApiKeyAuth } from "../src/auth/helpers.ts";
import type { AuthContext } from "../src/auth/types.ts";
import { createModels, createProvider } from "../src/models.ts";
import { InMemoryModelsStore } from "../src/models-store.ts";
import { fauxAssistantMessage, fauxProvider } from "../src/providers/faux.ts";
import type {
	Api,
	Model,
	ProviderStreams,
} from "../src/types.ts";
import { AssistantMessageEventStream } from "../src/utils/event-stream.ts";
import { normalizeContext } from "../src/utils/transcript.ts";

function fakeAuthContext(env: Record<string, string>, files: string[] = []): AuthContext {
	return {
		env: async (name) => env[name],
		fileExists: async (path) => files.includes(path),
	};
}

const neverAbortedSignal = new AbortController().signal;

const context = normalizeContext({ messages: [{ role: "user", content: "hi", timestamp: Date.now() }] });

describe("envApiKeyAuth", () => {
	it("prefers the stored credential key and falls back through env vars in order", async () => {
		const auth = envApiKeyAuth("Test key", ["FIRST_KEY", "SECOND_KEY"]);

		const stored = await auth.resolve({
			ctx: fakeAuthContext({ FIRST_KEY: "env" }),
			credential: { type: "api_key", key: "stored" },
			signal: neverAbortedSignal,
		});
		expect(stored?.auth.apiKey).toBe("stored");
		expect(stored?.source).toBe("stored credential");

		const second = await auth.resolve({ ctx: fakeAuthContext({ SECOND_KEY: "second" }), signal: neverAbortedSignal });
		expect(second?.auth.apiKey).toBe("second");
		expect(second?.source).toBe("SECOND_KEY");

		expect(await auth.resolve({ ctx: fakeAuthContext({}), signal: neverAbortedSignal })).toBeUndefined();
	});

});

describe("createProvider", () => {
	function recordingStreams(label: string, calls: string[]): ProviderStreams {
		const respond = (model: Model<Api>) => {
			calls.push(`${label}:${model.id}`);
			const stream = new AssistantMessageEventStream();
			const message = fauxAssistantMessage("ok");
			stream.push({ type: "start", partial: message });
			stream.push({ type: "done", reason: "stop", message });
			stream.end(message);
			return stream;
		};
		return { stream: respond, streamSimple: respond };
	}

	function testModel(api: string, id: string): Model<Api> {
		return {
			id,
			name: id,
			api,
			provider: "mixed",
			baseUrl: "https://example.test/v1",
			reasoning: false,
			input: ["text"],
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
			contextWindow: 10000,
			maxTokens: 1000,
		};
	}


	it("dispatches on model.api for mixed-API providers", async () => {
		const calls: string[] = [];
		const provider = createProvider({
			id: "mixed",
			auth: { apiKey: { name: "Test", resolve: async () => ({ auth: {} }) } },
			models: [testModel("api-a", "model-a"), testModel("api-b", "model-b")],
			api: { "api-a": recordingStreams("a", calls), "api-b": recordingStreams("b", calls) },
		});
		const models = createModels();
		models.setProvider(provider);

		await models.completeSimple(testModel("api-a", "model-a"), context);
		await models.completeSimple(testModel("api-b", "model-b"), context);
		expect(calls).toEqual(["a:model-a", "b:model-b"]);
	});

	it("merges provider-resolved env into stream options", async () => {
		let capturedEnv: Record<string, string> | undefined;
		let capturedApiKey: string | undefined;
		const envModel = { ...testModel("api-a", "model-a"), provider: "env-provider" };
		const provider = createProvider({
			id: "env-provider",
			auth: {
				apiKey: {
					name: "Test",
					resolve: async () => ({
						auth: { apiKey: "provider-key" },
						env: { PROVIDER_ONLY: "provider", SHARED: "provider" },
					}),
				},
			},
			models: [envModel],
			api: {
				stream: (model, _context, options) => {
					capturedEnv = options?.env;
					capturedApiKey = options?.apiKey;
					return recordingStreams("a", []).stream(model, _context, options);
				},
				streamSimple: (model, _context, options) => {
					capturedEnv = options?.env;
					capturedApiKey = options?.apiKey;
					return recordingStreams("a", []).streamSimple(model, _context, options);
				},
			},
		});
		const models = createModels();
		models.setProvider(provider);

		await models.completeSimple(envModel, context, {
			apiKey: "request-key",
			env: { REQUEST_ONLY: "request", SHARED: "request" },
		});

		expect(capturedApiKey).toBe("request-key");
		expect(capturedEnv).toEqual({ PROVIDER_ONLY: "provider", REQUEST_ONLY: "request", SHARED: "request" });
	});


	it("produces a stream error for a model whose api has no implementation", async () => {
		const provider = createProvider({
			id: "mixed",
			auth: { apiKey: { name: "Test", resolve: async () => ({ auth: {} }) } },
			models: [testModel("api-a", "model-a")],
			api: { "api-a": recordingStreams("a", []) },
		});
		const result = await provider.streamSimple(testModel("api-ghost", "model-x"), context).result();
		expect(result.stopReason).toBe("error");
		expect(result.errorMessage).toContain("no API implementation");
	});

	it("lets a newer dynamic refresh bypass and supersede older network work", async () => {
		let fetches = 0;
		let markFirstStarted: (() => void) | undefined;
		let finishFirst: (() => void) | undefined;
		const firstStarted = new Promise<void>((resolve) => {
			markFirstStarted = resolve;
		});
		const firstBlocked = new Promise<void>((resolve) => {
			finishFirst = resolve;
		});
		const provider = createProvider({
			id: "dynamic",
			auth: { apiKey: { name: "Test", resolve: async () => ({ auth: {} }) } },
			models: [],
			fetchModels: async () => {
				fetches++;
				const current = fetches;
				if (current === 1) {
					markFirstStarted?.();
					await firstBlocked;
				}
				return [testModel("api-a", `listed-${current}`)];
			},
			api: recordingStreams("a", []),
		});

		const store = new InMemoryModelsStore();
		const models = createModels({ modelsStore: store });
		models.setProvider(provider);
		expect(provider.getModels()).toEqual([]);

		const first = models.refresh({ providers: ["dynamic"] });
		await firstStarted;
		const second = models.refresh({ providers: ["dynamic"] });
		await expect(second).resolves.toMatchObject({ aborted: false });
		await expect(first).resolves.toMatchObject({ aborted: false });
		expect(fetches).toBe(2);
		expect(provider.getModels().map((model) => model.id)).toEqual(["listed-2"]);
		expect((await store.read("dynamic"))?.models.map((model) => model.id)).toEqual(["listed-2"]);

		finishFirst?.();
		await new Promise((resolve) => setTimeout(resolve, 0));
		expect(provider.getModels().map((model) => model.id)).toEqual(["listed-2"]);
		expect((await store.read("dynamic"))?.models.map((model) => model.id)).toEqual(["listed-2"]);
	});
});

describe("fauxProvider", () => {
	it("streams queued responses through a Models collection", async () => {
		const faux = fauxProvider();
		const models = createModels();
		models.setProvider(faux.provider);
		faux.setResponses([fauxAssistantMessage("hello from faux")]);

		const model = models.getModels(faux.provider.id)[0];
		const result = await models.completeSimple(model, context);
		expect(result.stopReason).toBe("stop");
		expect(result.content).toEqual([{ type: "text", text: "hello from faux" }]);
		expect(faux.state.callCount).toBe(1);
	});


});
