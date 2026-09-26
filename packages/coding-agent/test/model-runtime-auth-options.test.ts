import { type CredentialStore, InMemoryCredentialStore } from "@earendil-works/pi-ai";
import { describe, expect, it } from "vitest";
import { AuthStorage } from "../src/core/auth-storage.ts";
import { ModelRuntime } from "../src/core/model-runtime.ts";

function authOptions(runtime: ModelRuntime) {
	return runtime
		.getProviders()
		.map((provider) => ({ type: "api_key" as const, provider, method: provider.auth.apiKey }));
}

function testModel(id: string) {
	return {
		id,
		name: id,
		reasoning: false,
		input: ["text"] as ("text" | "image")[],
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
		contextWindow: 10000,
		maxTokens: 1000,
	};
}

describe("ModelRuntime auth options", () => {
	it("accepts a pi-ai CredentialStore", async () => {
		const credentials = new InMemoryCredentialStore();
		await credentials.modify("openrouter", async () => ({ type: "api_key", key: "stored-key" }));
		const runtime = await ModelRuntime.create({ credentials, modelsPath: null });
		runtime.registerProvider("openrouter", {
			baseUrl: "https://openrouter.ai/api/v1",
			api: "openai-completions",
			models: [testModel("openai/gpt-5.5")],
		});

		expect((await runtime.getAuth("openrouter"))?.auth.apiKey).toBe("stored-key");
	});

	it("scopes provider availability reads and records refresh failures", async () => {
		const base = new InMemoryCredentialStore();
		const reads: string[] = [];
		let failReads = false;
		const credentials: CredentialStore = {
			read: async (providerId) => {
				reads.push(providerId);
				if (failReads) throw new Error(`read failed for ${providerId}`);
				return base.read(providerId);
			},
			list: () => base.list(),
			modify: (providerId, fn) => base.modify(providerId, fn),
			delete: (providerId) => base.delete(providerId),
		};
		const runtime = await ModelRuntime.create({ credentials, modelsPath: null });
		runtime.registerProvider("openrouter", {
			baseUrl: "https://openrouter.ai/api/v1",
			api: "openai-completions",
			models: [testModel("openai/gpt-5.5")],
		});

		reads.length = 0;
		await runtime.getAvailable("openrouter");
		expect(new Set(reads)).toEqual(new Set(["openrouter"]));

		failReads = true;
		await expect(runtime.getAvailable("openrouter")).rejects.toThrow("Credential store read failed for openrouter");
		expect(runtime.getError()).toContain("Availability refresh: Credential store read failed for openrouter");

		failReads = false;
		await runtime.getAvailable();
		expect(runtime.getError()).toBeUndefined();
	});




	it("constructs an API key method for an extension API-key provider", async () => {
		const runtime = await ModelRuntime.create({ credentials: AuthStorage.inMemory(), modelsPath: null });
		runtime.registerProvider("extension-api-key", {
			name: "Extension API Key",
			baseUrl: "https://example.test/v1",
			apiKey: "$EXTENSION_TEST_API_KEY",
			api: "openai-completions",
			models: [testModel("extension-model")],
		});

		const options = authOptions(runtime).filter((option) => option.provider.id === "extension-api-key");
		expect(options).toHaveLength(1);
		expect(options[0]).toMatchObject({
			type: "api_key",
			provider: { id: "extension-api-key", name: "Extension API Key" },
			method: { name: "API key" },
		});
	});

	it("resolves configured auth from request-scoped environment overrides", async () => {
		const runtime = await ModelRuntime.create({ credentials: AuthStorage.inMemory(), modelsPath: null });
		runtime.registerProvider("request-env-provider", {
			baseUrl: "https://example.test/v1",
			apiKey: "$REQUEST_SCOPED_API_KEY",
			headers: { "x-request-value": "$REQUEST_SCOPED_HEADER" },
			api: "openai-completions",
			models: [testModel("request-env-model")],
		});

		const auth = await runtime.getAuth("request-env-provider", {
			env: { REQUEST_SCOPED_API_KEY: "request-key", REQUEST_SCOPED_HEADER: "request-header" },
		});

		expect(auth?.auth).toEqual({ apiKey: "request-key", headers: { "x-request-value": "request-header" } });
	});

	it("lets an explicit Authorization header override authHeader case-insensitively", async () => {
		const runtime = await ModelRuntime.create({ credentials: AuthStorage.inMemory(), modelsPath: null });
		let capturedHeaders: Record<string, string | null> | undefined;
		runtime.registerProvider("auth-header-provider", {
			baseUrl: "https://example.test/v1",
			apiKey: "generated-key",
			authHeader: true,
			api: "openai-completions",
			streamSimple: (_model, _context, options) => {
				capturedHeaders = options?.headers;
				throw new Error("captured");
			},
			models: [testModel("auth-header-model")],
		});
		const model = runtime.getModel("auth-header-provider", "auth-header-model");
		expect(model).toBeDefined();

		await runtime.completeSimple(model!, { messages: [] }, { headers: { authorization: "Explicit token" } });

		expect(capturedHeaders).toEqual({ authorization: "Explicit token" });
	});

	it("transforms fully assembled headers once without forwarding the transform", async () => {
		const runtime = await ModelRuntime.create({ credentials: AuthStorage.inMemory(), modelsPath: null });
		let capturedHeaders: Record<string, string | null> | undefined;
		let transforms = 0;
		runtime.registerProvider("header-provider", {
			baseUrl: "https://example.test/v1",
			apiKey: "generated-key",
			authHeader: true,
			headers: { "x-provider": "provider" },
			api: "openai-completions",
			streamSimple: (_model, _context, options) => {
				expect(options).not.toHaveProperty("transformHeaders");
				capturedHeaders = options?.headers;
				throw new Error("captured");
			},
			models: [{ ...testModel("header-model"), headers: { "x-model": "model" } }],
		});
		const model = runtime.getModel("header-provider", "header-model");
		expect(model).toBeDefined();

		await runtime.completeSimple(
			model!,
			{ messages: [] },
			{
				headers: { "x-explicit": "explicit" },
				transformHeaders: async (headers) => {
					transforms++;
					expect(headers).toEqual({
						Authorization: "Bearer generated-key",
						"x-provider": "provider",
						"x-model": "model",
						"x-explicit": "explicit",
					});
					return { ...headers, "x-transformed": "yes" };
				},
			},
		);

		expect(transforms).toBe(1);
		expect(capturedHeaders).toEqual({
			Authorization: "Bearer generated-key",
			"x-provider": "provider",
			"x-model": "model",
			"x-explicit": "explicit",
			"x-transformed": "yes",
		});
	});


});
