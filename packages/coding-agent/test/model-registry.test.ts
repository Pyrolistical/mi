import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { normalizeContext } from "@earendil-works/pi-ai";
import type { Api, Model, OpenAICompletionsCompat } from "@earendil-works/pi-ai/compat";
import { getApiProvider, getSupportedThinkingLevels } from "@earendil-works/pi-ai/compat";
import { afterEach, beforeEach, describe, expect, test, vi } from "bun:test";
import { AuthStorage } from "../src/core/auth-storage.ts";
import type { ModelsJsonProvider } from "../src/core/model-config.ts";
import type { ModelRegistry, ProviderConfigInput } from "../src/core/model-registry.ts";
import { clearConfigValueCache } from "../src/core/resolve-config-value.ts";
import { createModelRegistry } from "./model-runtime-test-utils.ts";

describe("ModelRegistry", () => {
	let tempDir: string;
	let modelsJsonPath: string;
	let authStorage: AuthStorage;

	beforeEach(() => {
		tempDir = join(tmpdir(), `pi-test-model-registry-${Date.now()}-${Math.random().toString(36).slice(2)}`);
		mkdirSync(tempDir, { recursive: true });
		modelsJsonPath = join(tempDir, "models.json");
		authStorage = AuthStorage.inMemory();
	});

	afterEach(() => {
		if (tempDir && existsSync(tempDir)) {
			rmSync(tempDir, { recursive: true });
		}
		clearConfigValueCache();
		vi.restoreAllMocks();
	});

	function providerConfig(
		baseUrl: string,
		models: Array<{ id: string; name?: string }>,
		api: string = "anthropic-messages",
	): ProviderConfigInput {
		return {
			baseUrl,
			apiKey: "test-key",
			api: api as Api,
			models: models.map((m) => ({
				id: m.id,
				name: m.name ?? m.id,
				reasoning: false,
				input: ["text"],
				cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
				contextWindow: 100000,
				maxTokens: 8000,
			})),
		};
	}

	function writeModelsJson(providers: Record<string, ReturnType<typeof providerConfig>>) {
		writeFileSync(modelsJsonPath, JSON.stringify({ providers }));
	}

	function getModelsForProvider(registry: ModelRegistry, provider: string) {
		return registry.getAll().filter((m) => m.provider === provider);
	}

	function toShPath(value: string): string {
		return value.replace(/\\/g, "/").replace(/"/g, '\\"');
	}

	function writeRawModelsJson(providers: Record<string, unknown>) {
		writeFileSync(modelsJsonPath, JSON.stringify({ providers }));
	}

	const openAiModel: Model<Api> = {
		id: "test-openai-model",
		name: "Test OpenAI Model",
		api: "openai-completions",
		provider: "openrouter",
		baseUrl: "https://api.openai.com/v1",
		reasoning: false,
		input: ["text"],
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
		contextWindow: 128000,
		maxTokens: 4096,
	};

	const emptyContext = normalizeContext({
		messages: [],
	});

	describe("custom models merge behavior", () => {
		test("custom models require baseUrl", async () => {
			writeRawModelsJson({
				"my-custom-provider": {
					apiKey: "test-key",
					models: [
						{
							id: "my-model",
							api: "openai-completions",
							reasoning: false,
							input: ["text"],
						},
					],
				},
			});

			const registry = await createModelRegistry(authStorage, modelsJsonPath);
			expect(registry.getError()).toContain("baseUrl");
		});

		test("reports every provider composition error", async () => {
			writeRawModelsJson({
				"broken-one": { api: "openai-completions", models: [{ id: "one" }] },
				"broken-two": { api: "openai-completions", models: [{ id: "two" }] },
			});

			const registry = await createModelRegistry(authStorage, modelsJsonPath);
			const error = registry.getError();

			expect(error).toContain('Provider "broken-one"');
			expect(error).toContain('Provider "broken-two"');
		});

		test("provider-level compat applies to custom models", async () => {
			writeRawModelsJson({
				demo: {
					baseUrl: "https://example.com/v1",
					apiKey: "DEMO_KEY",
					api: "openai-completions",
					compat: {
						supportsUsageInStreaming: false,
						maxTokensField: "max_tokens",
					},
					models: [
						{
							id: "demo-model",
							reasoning: false,
							input: ["text"],
							cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
							contextWindow: 1000,
							maxTokens: 100,
						},
					],
				},
			});

			const registry = await createModelRegistry(authStorage, modelsJsonPath);
			const compat = registry.find("demo", "demo-model")?.compat as OpenAICompletionsCompat | undefined;

			expect(compat?.supportsUsageInStreaming).toBe(false);
			expect(compat?.maxTokensField).toBe("max_tokens");
		});

		test("model-level compat overrides provider-level compat for custom models", async () => {
			writeRawModelsJson({
				demo: {
					baseUrl: "https://example.com/v1",
					apiKey: "DEMO_KEY",
					api: "openai-completions",
					compat: {
						supportsUsageInStreaming: false,
						maxTokensField: "max_tokens",
					},
					models: [
						{
							id: "demo-model",
							reasoning: false,
							input: ["text"],
							cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
							contextWindow: 1000,
							maxTokens: 100,
							compat: {
								supportsUsageInStreaming: true,
								maxTokensField: "max_completion_tokens",
							},
						},
					],
				},
			});

			const registry = await createModelRegistry(authStorage, modelsJsonPath);
			const compat = registry.find("demo", "demo-model")?.compat as OpenAICompletionsCompat | undefined;

			expect(compat?.supportsUsageInStreaming).toBe(true);
			expect(compat?.maxTokensField).toBe("max_completion_tokens");
		});

		test("model schema accepts thinkingLevelMap and compat schema accepts supportsStrictMode and cacheControlFormat", async () => {
			writeRawModelsJson({
				demo: {
					baseUrl: "https://example.com/v1",
					apiKey: "DEMO_KEY",
					api: "openai-completions",
					models: [
						{
							id: "demo-model",
							reasoning: true,
							input: ["text"],
							cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
							contextWindow: 1000,
							maxTokens: 100,
							thinkingLevelMap: {
								minimal: null,
								high: "max",
							},
							compat: {
								supportsStrictMode: false,
								cacheControlFormat: "anthropic",
							},
						},
					],
				},
			});

			const registry = await createModelRegistry(authStorage, modelsJsonPath);
			const model = registry.find("demo", "demo-model");
			const compat = model?.compat as OpenAICompletionsCompat | undefined;

			expect(registry.getError()).toBeUndefined();
			expect(model?.thinkingLevelMap).toEqual({ minimal: null, high: "max" });
			expect(compat?.supportsStrictMode).toBe(false);
			expect(compat?.cacheControlFormat).toBe("anthropic");
		});

		test("compat schema accepts chat template thinking configuration", async () => {
			writeRawModelsJson({
				demo: {
					baseUrl: "https://example.com/v1",
					apiKey: "DEMO_KEY",
					api: "openai-completions",
					models: [
						{
							id: "kwargs-model",
							reasoning: true,
							input: ["text"],
							cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
							contextWindow: 1000,
							maxTokens: 100,
							compat: {
								thinkingFormat: "chat-template",
								chatTemplateKwargs: {
									preserve_thinking: true,
									thinking: { $var: "thinking.enabled" },
								},
							},
						},
					],
				},
			});

			const registry = await createModelRegistry(authStorage, modelsJsonPath);
			const kwargsCompat = registry.find("demo", "kwargs-model")?.compat as OpenAICompletionsCompat | undefined;

			expect(registry.getError()).toBeUndefined();
			expect(kwargsCompat?.thinkingFormat).toBe("chat-template");
			expect(kwargsCompat?.chatTemplateKwargs).toEqual({
				preserve_thinking: true,
				thinking: { $var: "thinking.enabled" },
			});
		});

		test("refresh() reloads merged custom models from disk", async () => {
			writeModelsJson({
				openrouter: providerConfig("https://first-proxy.example.com/v1", [{ id: "claude-custom" }]),
			});
			const registry = await createModelRegistry(authStorage, modelsJsonPath);
			expect(getModelsForProvider(registry, "openrouter").some((m) => m.id === "claude-custom")).toBe(true);

			writeModelsJson({
				openrouter: providerConfig("https://second-proxy.example.com/v1", [{ id: "claude-custom-2" }]),
			});
			await registry.refresh();

			const openaiModels = getModelsForProvider(registry, "openrouter");
			expect(openaiModels.some((m) => m.id === "claude-custom")).toBe(false);
			expect(openaiModels.some((m) => m.id === "claude-custom-2")).toBe(true);
		});
	});

	describe("modelOverrides (per-model customization)", () => {
		test("model override applies to a single model", async () => {
			writeRawModelsJson({
				openrouter: {
					baseUrl: "https://openrouter.ai/api/v1",
					api: "openai-completions",
					models: [{ id: "openai/gpt-oss-120b" }, { id: "openai/gpt-oss-20b" }],
					modelOverrides: {
						"openai/gpt-oss-120b": {
							name: "Custom Sonnet Name",
						},
					},
				},
			});

			const registry = await createModelRegistry(authStorage, modelsJsonPath);
			const models = getModelsForProvider(registry, "openrouter");

			const sonnet = models.find((m) => m.id === "openai/gpt-oss-120b");
			expect(sonnet?.name).toBe("Custom Sonnet Name");

			const opus = models.find((m) => m.id === "openai/gpt-oss-20b");
			expect(opus?.name).not.toBe("Custom Sonnet Name");
		});

		test("custom model and model override carry sampling params", async () => {
			writeRawModelsJson({
				openrouter: {
					baseUrl: "https://my-proxy.example.com/v1",
					api: "openai-completions",
					models: [
						{
							id: "custom/sampling-model",
							samplingParams: { temperature: 1, top_p: 0.95, top_k: 0 },
						},
						{ id: "openai/gpt-oss-120b" },
						{ id: "openai/gpt-oss-20b" },
					],
					modelOverrides: {
						"openai/gpt-oss-120b": {
							samplingParams: { top_p: 0.9 },
						},
					},
				},
			});

			const registry = await createModelRegistry(authStorage, modelsJsonPath);
			const models = getModelsForProvider(registry, "openrouter");

			const custom = models.find((m) => m.id === "custom/sampling-model");
			expect(custom?.samplingParams).toEqual({ temperature: 1, top_p: 0.95, top_k: 0 });

			const sonnet = models.find((m) => m.id === "openai/gpt-oss-120b");
			expect(sonnet?.samplingParams).toEqual({ top_p: 0.9 });

			const opus = models.find((m) => m.id === "openai/gpt-oss-20b");
			expect(opus?.samplingParams).toBeUndefined();
		});

		test("custom model and model override carry prompt cache lifetimes", async () => {
			writeRawModelsJson({
				openrouter: {
					baseUrl: "https://my-proxy.example.com/v1",
					api: "openai-completions",
					models: [
						{ id: "custom/cached-model", promptCache: { short: 120 } },
						{ id: "openai/gpt-oss-120b" },
						{ id: "openai/gpt-oss-20b" },
					],
					modelOverrides: {
						"openai/gpt-oss-120b": { promptCache: { short: 300 } },
					},
				},
			});

			const registry = await createModelRegistry(authStorage, modelsJsonPath);
			const openrouter = getModelsForProvider(registry, "openrouter");

			expect(registry.getError()).toBeUndefined();
			expect(openrouter.find((m) => m.id === "custom/cached-model")?.promptCache).toEqual({ short: 120 });
			expect(openrouter.find((m) => m.id === "openai/gpt-oss-120b")?.promptCache).toEqual({ short: 300 });
			expect(openrouter.find((m) => m.id === "openai/gpt-oss-20b")?.promptCache).toBeUndefined();
		});


		test("model override with compat.openRouterRouting", async () => {
			writeRawModelsJson({
				openrouter: {
					baseUrl: "https://openrouter.ai/api/v1",
					api: "openai-completions",
					models: [{ id: "openai/gpt-oss-120b" }, { id: "openai/gpt-oss-20b" }],
					modelOverrides: {
						"openai/gpt-oss-120b": {
							compat: {
								openRouterRouting: { only: ["amazon-bedrock"] },
							},
						},
					},
				},
			});

			const registry = await createModelRegistry(authStorage, modelsJsonPath);
			const models = getModelsForProvider(registry, "openrouter");

			const sonnet = models.find((m) => m.id === "openai/gpt-oss-120b");
			const compat = sonnet?.compat as OpenAICompletionsCompat | undefined;
			expect(compat?.openRouterRouting).toEqual({ only: ["amazon-bedrock"] });
		});

		test("supportsFinishReason can be configured at provider and model levels", async () => {
			const provider: ModelsJsonProvider = {
				baseUrl: "https://openrouter.ai/api/v1",
				api: "openai-completions",
				models: [{ id: "openai/gpt-oss-120b" }, { id: "openai/gpt-oss-20b" }],
				compat: { supportsFinishReason: true },
				modelOverrides: {
					"openai/gpt-oss-120b": {
						compat: { supportsFinishReason: false },
					},
				},
			};
			writeRawModelsJson({ openrouter: provider });

			const registry = await createModelRegistry(authStorage, modelsJsonPath);
			const models = getModelsForProvider(registry, "openrouter");
			const sonnet = models.find((model) => model.id === "openai/gpt-oss-120b");
			const opus = models.find((model) => model.id === "openai/gpt-oss-20b");

			expect((sonnet?.compat as OpenAICompletionsCompat | undefined)?.supportsFinishReason).toBe(false);
			expect((opus?.compat as OpenAICompletionsCompat | undefined)?.supportsFinishReason).toBe(true);
		});

		test("model override deep merges compat settings", async () => {
			writeRawModelsJson({
				openrouter: {
					baseUrl: "https://openrouter.ai/api/v1",
					api: "openai-completions",
					models: [{ id: "openai/gpt-oss-120b" }, { id: "openai/gpt-oss-20b" }],
					modelOverrides: {
						"openai/gpt-oss-120b": {
							compat: {
								openRouterRouting: { order: ["anthropic", "together"] },
							},
						},
					},
				},
			});

			const registry = await createModelRegistry(authStorage, modelsJsonPath);
			const models = getModelsForProvider(registry, "openrouter");
			const sonnet = models.find((m) => m.id === "openai/gpt-oss-120b");

			const compat = sonnet?.compat as OpenAICompletionsCompat | undefined;
			expect(compat?.openRouterRouting).toEqual({ order: ["anthropic", "together"] });
		});

		test("multiple model overrides on same provider", async () => {
			writeRawModelsJson({
				openrouter: {
					baseUrl: "https://openrouter.ai/api/v1",
					api: "openai-completions",
					models: [{ id: "openai/gpt-oss-120b" }, { id: "openai/gpt-oss-20b" }],
					modelOverrides: {
						"openai/gpt-oss-120b": {
							compat: { openRouterRouting: { only: ["amazon-bedrock"] } },
						},
						"openai/gpt-oss-20b": {
							compat: { openRouterRouting: { only: ["anthropic"] } },
						},
					},
				},
			});

			const registry = await createModelRegistry(authStorage, modelsJsonPath);
			const models = getModelsForProvider(registry, "openrouter");

			const sonnet = models.find((m) => m.id === "openai/gpt-oss-120b");
			const opus = models.find((m) => m.id === "openai/gpt-oss-20b");

			const sonnetCompat = sonnet?.compat as OpenAICompletionsCompat | undefined;
			const opusCompat = opus?.compat as OpenAICompletionsCompat | undefined;
			expect(sonnetCompat?.openRouterRouting).toEqual({ only: ["amazon-bedrock"] });
			expect(opusCompat?.openRouterRouting).toEqual({ only: ["anthropic"] });
		});

		test("model override combined with baseUrl override", async () => {
			writeRawModelsJson({
				openrouter: {
					baseUrl: "https://my-proxy.example.com/v1",
					api: "openai-completions",
					models: [{ id: "openai/gpt-oss-120b" }, { id: "openai/gpt-oss-20b" }],
					modelOverrides: {
						"openai/gpt-oss-120b": {
							name: "Proxied Sonnet",
						},
					},
				},
			});

			const registry = await createModelRegistry(authStorage, modelsJsonPath);
			const models = getModelsForProvider(registry, "openrouter");
			const sonnet = models.find((m) => m.id === "openai/gpt-oss-120b");

			expect(sonnet?.baseUrl).toBe("https://my-proxy.example.com/v1");
			expect(sonnet?.name).toBe("Proxied Sonnet");

			const opus = models.find((m) => m.id === "openai/gpt-oss-20b");
			expect(opus?.baseUrl).toBe("https://my-proxy.example.com/v1");
			expect(opus?.name).not.toBe("Proxied Sonnet");
		});

		test("model override for non-existent model ID is ignored", async () => {
			writeRawModelsJson({
				openrouter: {
					baseUrl: "https://openrouter.ai/api/v1",
					api: "openai-completions",
					models: [{ id: "openai/gpt-oss-120b" }, { id: "openai/gpt-oss-20b" }],
					modelOverrides: {
						"nonexistent/model-id": {
							name: "This should not appear",
						},
					},
				},
			});

			const registry = await createModelRegistry(authStorage, modelsJsonPath);
			const models = getModelsForProvider(registry, "openrouter");

			expect(models.find((m) => m.id === "nonexistent/model-id")).toBeUndefined();
			expect(registry.getError()).toBeUndefined();
		});

		test("model override can change cost fields partially", async () => {
			writeRawModelsJson({
				openrouter: {
					baseUrl: "https://openrouter.ai/api/v1",
					api: "openai-completions",
					models: [
						{ id: "openai/gpt-oss-120b", cost: { input: 1, output: 2, cacheRead: 0, cacheWrite: 0 } },
						{ id: "openai/gpt-oss-20b" },
					],
					modelOverrides: {
						"openai/gpt-oss-120b": {
							cost: { input: 99 },
						},
					},
				},
			});

			const registry = await createModelRegistry(authStorage, modelsJsonPath);
			const models = getModelsForProvider(registry, "openrouter");
			const sonnet = models.find((m) => m.id === "openai/gpt-oss-120b");

			expect(sonnet?.cost.input).toBe(99);
			expect(sonnet?.cost.output).toBe(2);
		});

		test("model override can add headers at request time", async () => {
			writeRawModelsJson({
				openrouter: {
					baseUrl: "https://openrouter.ai/api/v1",
					api: "openai-completions",
					models: [{ id: "openai/gpt-oss-120b" }, { id: "openai/gpt-oss-20b" }],
					modelOverrides: {
						"openai/gpt-oss-120b": {
							headers: { "X-Custom-Model-Header": "value" },
						},
					},
				},
			});

			const registry = await createModelRegistry(authStorage, modelsJsonPath);
			const models = getModelsForProvider(registry, "openrouter");
			const sonnet = models.find((m) => m.id === "openai/gpt-oss-120b");
			expect(sonnet).toBeDefined();

			const auth = await registry.getApiKeyAndHeaders(sonnet!);
			expect(auth.ok).toBe(true);
			if (auth.ok) {
				expect(auth.headers?.["X-Custom-Model-Header"]).toBe("value");
			}
		});

		test("refresh() picks up model override changes", async () => {
			writeRawModelsJson({
				openrouter: {
					baseUrl: "https://openrouter.ai/api/v1",
					api: "openai-completions",
					models: [{ id: "openai/gpt-oss-120b" }, { id: "openai/gpt-oss-20b" }],
					modelOverrides: {
						"openai/gpt-oss-120b": {
							name: "First Name",
						},
					},
				},
			});

			const registry = await createModelRegistry(authStorage, modelsJsonPath);
			expect(
				getModelsForProvider(registry, "openrouter").find((m) => m.id === "openai/gpt-oss-120b")?.name,
			).toBe("First Name");

			writeRawModelsJson({
				openrouter: {
					baseUrl: "https://openrouter.ai/api/v1",
					api: "openai-completions",
					models: [{ id: "openai/gpt-oss-120b" }, { id: "openai/gpt-oss-20b" }],
					modelOverrides: {
						"openai/gpt-oss-120b": {
							name: "Second Name",
						},
					},
				},
			});
			await registry.refresh();

			expect(
				getModelsForProvider(registry, "openrouter").find((m) => m.id === "openai/gpt-oss-120b")?.name,
			).toBe("Second Name");
		});

		test("removing model override restores defined values", async () => {
			writeRawModelsJson({
				openrouter: {
					baseUrl: "https://openrouter.ai/api/v1",
					api: "openai-completions",
					models: [{ id: "openai/gpt-oss-120b" }, { id: "openai/gpt-oss-20b" }],
					modelOverrides: {
						"openai/gpt-oss-120b": {
							name: "Custom Name",
						},
					},
				},
			});

			const registry = await createModelRegistry(authStorage, modelsJsonPath);
			const customName = getModelsForProvider(registry, "openrouter").find(
				(m) => m.id === "openai/gpt-oss-120b",
			)?.name;
			expect(customName).toBe("Custom Name");

			writeRawModelsJson({
				openrouter: {
					baseUrl: "https://openrouter.ai/api/v1",
					api: "openai-completions",
					models: [{ id: "openai/gpt-oss-120b" }, { id: "openai/gpt-oss-20b" }],
				},
			});
			await registry.refresh();

			const restoredName = getModelsForProvider(registry, "openrouter").find(
				(m) => m.id === "openai/gpt-oss-120b",
			)?.name;
			expect(restoredName).toBe("openai/gpt-oss-120b");
		});
	});

	describe("dynamic provider lifecycle", () => {
		test("getProviderDisplayName resolves registered and fallback names", async () => {
			const registry = await createModelRegistry(authStorage, modelsJsonPath);

			expect(registry.getProviderDisplayName("unknown-provider")).toBe("unknown-provider");

			registry.registerProvider("named-provider", {
				name: "Named Provider",
				baseUrl: "https://provider.test/v1",
				apiKey: "test-key",
				api: "openai-completions",
				models: [
					{
						id: "demo-model",
						name: "Demo Model",
						reasoning: false,
						input: ["text"],
						cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
						contextWindow: 128000,
						maxTokens: 4096,
					},
				],
			});
			expect(registry.getProviderDisplayName("named-provider")).toBe("Named Provider");

		});

		test("modelOverrides apply to dynamically registered provider models", async () => {
			writeRawModelsJson({
				"extension-provider": {
					modelOverrides: {
						"extension-model": {
							name: "Overridden Extension Model",
							thinkingLevelMap: {
								off: null,
								minimal: null,
								low: null,
								medium: null,
								xhigh: "max",
							},
							headers: { "x-model-override": "enabled" },
						},
					},
				},
			});

			const registry = await createModelRegistry(authStorage, modelsJsonPath);
			registry.registerProvider("extension-provider", {
				baseUrl: "https://provider.test/v1",
				apiKey: "test-key",
				api: "openai-completions",
				models: [
					{
						id: "extension-model",
						name: "Extension Model",
						reasoning: true,
						input: ["text"],
						cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
						contextWindow: 128000,
						maxTokens: 4096,
					},
				],
			});

			const model = registry.find("extension-provider", "extension-model");
			expect(model).toBeDefined();
			if (!model) {
				throw new Error("extension model was not registered");
			}
			expect(model.name).toBe("Overridden Extension Model");
			expect(model.thinkingLevelMap).toEqual({
				off: null,
				minimal: null,
				low: null,
				medium: null,
				xhigh: "max",
			});
			expect(getSupportedThinkingLevels(model)).toEqual(["high", "xhigh"]);
			expect(await registry.getApiKeyAndHeaders(model)).toMatchObject({
				ok: true,
				headers: { "x-model-override": "enabled" },
			});
		});

		test("registerProvider treats uppercase apiKey and headers as literals", async () => {
			const envKeys = ["CUSTOM_NAME", "BEARER", "MODEL_TOKEN"];
			const savedEnv: Record<string, string | undefined> = {};
			for (const key of envKeys) {
				savedEnv[key] = process.env[key];
				process.env[key] = `env-${key}`;
			}
			const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});

			try {
				const registry = await createModelRegistry(authStorage, modelsJsonPath);

				registry.registerProvider("literal-provider", {
					...providerConfig("https://provider.test/v1", [{ id: "demo-model" }], "openai-completions"),
					apiKey: "CUSTOM_NAME",
					headers: { Authorization: "BEARER" },
					models: [
						{
							id: "demo-model",
							name: "demo-model",
							reasoning: false,
							input: ["text"],
							cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
							contextWindow: 100000,
							maxTokens: 8000,
							headers: { "x-model-token": "MODEL_TOKEN" },
						},
					],
				});

				expect(await registry.getApiKeyForProvider("literal-provider")).toBe("CUSTOM_NAME");
				const model = registry.find("literal-provider", "demo-model");
				expect(model).toBeDefined();
				expect(await registry.getApiKeyAndHeaders(model!)).toMatchObject({
					ok: true,
					apiKey: "CUSTOM_NAME",
					headers: {
						Authorization: "BEARER",
						"x-model-token": "MODEL_TOKEN",
					},
				});
				expect(warnSpy).not.toHaveBeenCalled();
			} finally {
				for (const key of envKeys) {
					if (savedEnv[key] === undefined) {
						delete process.env[key];
					} else {
						process.env[key] = savedEnv[key];
					}
				}
			}
		});

		test("failed registerProvider does not persist invalid streamSimple config", async () => {
			const registry = await createModelRegistry(authStorage, modelsJsonPath);

			expect(() =>
				registry.registerProvider("broken-provider", {
					streamSimple: (() => {
						throw new Error("should not run");
					}) as any,
				}),
			).toThrow('Provider broken-provider: "api" is required when registering streamSimple.');

			await expect(registry.refresh()).resolves.toMatchObject({ aborted: false });
		});

		test("failed registerProvider does not remove existing provider models", async () => {
			const registry = await createModelRegistry(authStorage, modelsJsonPath);

			registry.registerProvider("demo-provider", {
				baseUrl: "https://provider.test/v1",
				apiKey: "test-key",
				api: "openai-completions",
				models: [
					{
						id: "demo-model",
						name: "Demo Model",
						reasoning: false,
						input: ["text"],
						cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
						contextWindow: 128000,
						maxTokens: 4096,
					},
				],
			});

			expect(registry.find("demo-provider", "demo-model")).toBeDefined();

			expect(() =>
				registry.registerProvider("demo-provider", {
					baseUrl: "https://provider.test/v2",
					apiKey: "test-key",
					models: [
						{
							id: "broken-model",
							name: "Broken Model",
							reasoning: false,
							input: ["text"],
							cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
							contextWindow: 128000,
							maxTokens: 4096,
						},
					],
				}),
			).toThrow('Provider demo-provider, model broken-model: no "api" specified.');

			expect(registry.find("demo-provider", "demo-model")).toBeDefined();
			await expect(registry.refresh()).resolves.toMatchObject({ aborted: false });
			expect(registry.find("demo-provider", "demo-model")).toBeDefined();
		});

		test("streamSimple overlays do not mutate the global compat API registry", async () => {
			const registry = await createModelRegistry(authStorage, modelsJsonPath);

			registry.registerProvider("stream-override-provider", {
				api: "openai-completions",
				streamSimple: () => {
					throw new Error("custom streamSimple override");
				},
			});

			let threwCustomOverride = false;
			try {
				getApiProvider("openai-completions")?.streamSimple(openAiModel, emptyContext);
			} catch (error) {
				threwCustomOverride = error instanceof Error && error.message === "custom streamSimple override";
			}
			expect(threwCustomOverride).toBe(false);

			registry.unregisterProvider("stream-override-provider");

			let threwCustomOverrideAfterUnregister = false;
			try {
				getApiProvider("openai-completions")?.streamSimple(openAiModel, emptyContext);
			} catch (error) {
				threwCustomOverrideAfterUnregister =
					error instanceof Error && error.message === "custom streamSimple override";
			}
			expect(threwCustomOverrideAfterUnregister).toBe(false);
		});

		describe("dynamic provider override persistence", () => {
			test("models plus baseUrl override survives refresh", async () => {
				const registry = await createModelRegistry(authStorage, modelsJsonPath);

				registry.registerProvider("openrouter", {
					...providerConfig("https://custom.test/anthropic", [{ id: "custom-claude" }], "anthropic-messages"),
					baseUrl: "https://custom.test/anthropic",
				});
				registry.registerProvider("openrouter", { baseUrl: "https://proxy.test/anthropic" });
				await registry.refresh();

				expect(getModelsForProvider(registry, "openrouter").map((m) => m.id)).toEqual(["custom-claude"]);
				expect(registry.find("openrouter", "custom-claude")?.baseUrl).toBe("https://proxy.test/anthropic");
			});

			test("models-only custom provider registration survives refresh", async () => {
				const registry = await createModelRegistry(authStorage, modelsJsonPath);

				registry.registerProvider(
					"custom-provider",
					providerConfig("https://custom.test/v1", [{ id: "custom-a" }, { id: "custom-b" }], "openai-completions"),
				);
				await registry.refresh();

				expect(getModelsForProvider(registry, "custom-provider").map((m) => m.id)).toEqual([
					"custom-a",
					"custom-b",
				]);
			});

			test("baseUrl-only override keeps custom provider models after refresh", async () => {
				const registry = await createModelRegistry(authStorage, modelsJsonPath);

				registry.registerProvider(
					"custom-provider",
					providerConfig("https://custom.test/v1", [{ id: "custom-a" }, { id: "custom-b" }], "openai-completions"),
				);
				registry.registerProvider("custom-provider", { baseUrl: "https://proxy.test/custom" });
				await registry.refresh();

				expect(getModelsForProvider(registry, "custom-provider").map((m) => m.id)).toEqual([
					"custom-a",
					"custom-b",
				]);
				expect(
					getModelsForProvider(registry, "custom-provider").every(
						(m) => m.baseUrl === "https://proxy.test/custom",
					),
				).toBe(true);
			});

			test("headers-only override keeps custom provider models after refresh", async () => {
				const registry = await createModelRegistry(authStorage, modelsJsonPath);

				registry.registerProvider(
					"custom-provider",
					providerConfig("https://custom.test/v1", [{ id: "custom-a" }, { id: "custom-b" }], "openai-completions"),
				);
				registry.registerProvider("custom-provider", { headers: { "x-proxy": "enabled" } });
				await registry.refresh();

				const models = getModelsForProvider(registry, "custom-provider");
				expect(models.map((m) => m.id)).toEqual(["custom-a", "custom-b"]);
				expect(models.every((m) => m.baseUrl === "https://custom.test/v1")).toBe(true);
				expect(await registry.getApiKeyAndHeaders(models[0])).toMatchObject({
					ok: true,
					headers: { "x-proxy": "enabled" },
				});
			});
		});
	});

	describe("API key resolution", () => {
		function providerWithApiKey(apiKey: string) {
			return {
				baseUrl: "https://example.com/v1",
				apiKey,
				api: "anthropic-messages",
				models: [
					{
						id: "test-model",
						name: "Test Model",
						reasoning: false,
						input: ["text"],
						cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
						contextWindow: 100000,
						maxTokens: 8000,
					},
				],
			};
		}

		test("apiKey with ! prefix executes command and uses stdout", async () => {
			writeRawModelsJson({
				"custom-provider": providerWithApiKey("!echo test-api-key-from-command"),
			});

			const registry = await createModelRegistry(authStorage, modelsJsonPath);
			const apiKey = await registry.getApiKeyForProvider("custom-provider");

			expect(apiKey).toBe("test-api-key-from-command");
		});

		test("apiKey with ! prefix trims whitespace from command output", async () => {
			writeRawModelsJson({
				"custom-provider": providerWithApiKey("!echo '  spaced-key  '"),
			});

			const registry = await createModelRegistry(authStorage, modelsJsonPath);
			const apiKey = await registry.getApiKeyForProvider("custom-provider");

			expect(apiKey).toBe("spaced-key");
		});

		test("apiKey with ! prefix handles multiline output (uses trimmed result)", async () => {
			writeRawModelsJson({
				"custom-provider": providerWithApiKey("!printf 'line1\\nline2'"),
			});

			const registry = await createModelRegistry(authStorage, modelsJsonPath);
			const apiKey = await registry.getApiKeyForProvider("custom-provider");

			expect(apiKey).toBe("line1\nline2");
		});

		test("apiKey with ! prefix returns undefined on command failure", async () => {
			writeRawModelsJson({
				"custom-provider": providerWithApiKey("!exit 1"),
			});

			const registry = await createModelRegistry(authStorage, modelsJsonPath);
			const apiKey = await registry.getApiKeyForProvider("custom-provider");

			expect(apiKey).toBeUndefined();
		});

		test("apiKey with ! prefix returns undefined on nonexistent command", async () => {
			writeRawModelsJson({
				"custom-provider": providerWithApiKey("!nonexistent-command-12345"),
			});

			const registry = await createModelRegistry(authStorage, modelsJsonPath);
			const apiKey = await registry.getApiKeyForProvider("custom-provider");

			expect(apiKey).toBeUndefined();
		});

		test("apiKey with ! prefix returns undefined on empty output", async () => {
			writeRawModelsJson({
				"custom-provider": providerWithApiKey("!printf ''"),
			});

			const registry = await createModelRegistry(authStorage, modelsJsonPath);
			const apiKey = await registry.getApiKeyForProvider("custom-provider");

			expect(apiKey).toBeUndefined();
		});

		test("apiKey with $ prefix resolves to env value", async () => {
			const originalEnv = process.env.TEST_API_KEY_12345;
			process.env.TEST_API_KEY_12345 = "env-api-key-value";

			try {
				writeRawModelsJson({
					"custom-provider": providerWithApiKey("$TEST_API_KEY_12345"),
				});

				const registry = await createModelRegistry(authStorage, modelsJsonPath);
				const apiKey = await registry.getApiKeyForProvider("custom-provider");

				expect(apiKey).toBe("env-api-key-value");
			} finally {
				if (originalEnv === undefined) {
					delete process.env.TEST_API_KEY_12345;
				} else {
					process.env.TEST_API_KEY_12345 = originalEnv;
				}
			}
		});

		test("apiKey with braced env syntax resolves to env value", async () => {
			const originalEnv = process.env.TEST_BRACED_API_KEY_12345;
			process.env.TEST_BRACED_API_KEY_12345 = "braced-env-api-key-value";
			const bracedKey = "$" + "{TEST_BRACED_API_KEY_12345}";

			try {
				writeRawModelsJson({
					"custom-provider": providerWithApiKey(bracedKey),
				});

				const registry = await createModelRegistry(authStorage, modelsJsonPath);
				const apiKey = await registry.getApiKeyForProvider("custom-provider");

				expect(apiKey).toBe("braced-env-api-key-value");
			} finally {
				if (originalEnv === undefined) {
					delete process.env.TEST_BRACED_API_KEY_12345;
				} else {
					process.env.TEST_BRACED_API_KEY_12345 = originalEnv;
				}
			}
		});

		test("apiKey interpolates braced env references inside literals", async () => {
			const originalPartA = process.env.TEST_INTERPOLATED_PART_A_12345;
			const originalPartB = process.env.TEST_INTERPOLATED_PART_B_12345;
			process.env.TEST_INTERPOLATED_PART_A_12345 = "left";
			process.env.TEST_INTERPOLATED_PART_B_12345 = "right";
			const interpolatedKey = ["$", "{TEST_INTERPOLATED_PART_A_12345}_$", "{TEST_INTERPOLATED_PART_B_12345}"].join(
				"",
			);

			try {
				writeRawModelsJson({
					"custom-provider": providerWithApiKey(interpolatedKey),
				});

				const registry = await createModelRegistry(authStorage, modelsJsonPath);
				const apiKey = await registry.getApiKeyForProvider("custom-provider");

				expect(apiKey).toBe("left_right");
			} finally {
				if (originalPartA === undefined) {
					delete process.env.TEST_INTERPOLATED_PART_A_12345;
				} else {
					process.env.TEST_INTERPOLATED_PART_A_12345 = originalPartA;
				}
				if (originalPartB === undefined) {
					delete process.env.TEST_INTERPOLATED_PART_B_12345;
				} else {
					process.env.TEST_INTERPOLATED_PART_B_12345 = originalPartB;
				}
			}
		});

		test("apiKey with $$ prefix escapes a leading dollar", async () => {
			writeRawModelsJson({
				"custom-provider": providerWithApiKey("$$TEST_API_KEY_12345"),
			});

			const registry = await createModelRegistry(authStorage, modelsJsonPath);
			const apiKey = await registry.getApiKeyForProvider("custom-provider");

			expect(apiKey).toBe("$TEST_API_KEY_12345");
		});

		test("apiKey with $! escapes a literal bang and still interpolates later env refs", async () => {
			const originalEnv = process.env.TEST_API_KEY_12345;
			process.env.TEST_API_KEY_12345 = "env-api-key-value";

			try {
				writeRawModelsJson({
					"custom-provider": providerWithApiKey("$!literal-$TEST_API_KEY_12345"),
				});

				const registry = await createModelRegistry(authStorage, modelsJsonPath);
				const apiKey = await registry.getApiKeyForProvider("custom-provider");

				expect(apiKey).toBe("!literal-env-api-key-value");
			} finally {
				if (originalEnv === undefined) {
					delete process.env.TEST_API_KEY_12345;
				} else {
					process.env.TEST_API_KEY_12345 = originalEnv;
				}
			}
		});

		test("plain apiKey is used directly even when it matches an env var", async () => {
			const originalEnv = process.env.TEST_API_KEY_12345;
			process.env.TEST_API_KEY_12345 = "env-api-key-value";

			try {
				writeRawModelsJson({
					"custom-provider": providerWithApiKey("TEST_API_KEY_12345"),
				});

				const registry = await createModelRegistry(authStorage, modelsJsonPath);
				const apiKey = await registry.getApiKeyForProvider("custom-provider");

				expect(apiKey).toBe("TEST_API_KEY_12345");
			} finally {
				if (originalEnv === undefined) {
					delete process.env.TEST_API_KEY_12345;
				} else {
					process.env.TEST_API_KEY_12345 = originalEnv;
				}
			}
		});

		test("apiKey as literal value is used directly when not an env var", async () => {
			delete process.env.literal_api_key_value;

			writeRawModelsJson({
				"custom-provider": providerWithApiKey("literal_api_key_value"),
			});

			const registry = await createModelRegistry(authStorage, modelsJsonPath);
			const apiKey = await registry.getApiKeyForProvider("custom-provider");

			expect(apiKey).toBe("literal_api_key_value");
		});

		test("apiKey command can use shell features like pipes", async () => {
			writeRawModelsJson({
				"custom-provider": providerWithApiKey("!echo 'hello world' | tr ' ' '-'"),
			});

			const registry = await createModelRegistry(authStorage, modelsJsonPath);
			const apiKey = await registry.getApiKeyForProvider("custom-provider");

			expect(apiKey).toBe("hello-world");
		});

		describe("request-time resolution", () => {
			test("command is executed on every provider lookup", async () => {
				const counterFile = join(tempDir, "counter");
				writeFileSync(counterFile, "0");

				const counterPath = toShPath(counterFile);
				const command = `!sh -c 'count=$(cat "${counterPath}"); echo $((count + 1)) > "${counterPath}"; echo "key-value"'`;
				writeRawModelsJson({
					"custom-provider": providerWithApiKey(command),
				});

				const registry = await createModelRegistry(authStorage, modelsJsonPath);
				await registry.getApiKeyForProvider("custom-provider");
				await registry.getApiKeyForProvider("custom-provider");
				await registry.getApiKeyForProvider("custom-provider");

				const count = parseInt(readFileSync(counterFile, "utf-8").trim(), 10);
				expect(count).toBe(3);
			});

			test("commands are re-executed across registry instances", async () => {
				const counterFile = join(tempDir, "counter");
				writeFileSync(counterFile, "0");

				const counterPath = toShPath(counterFile);
				const command = `!sh -c 'count=$(cat "${counterPath}"); echo $((count + 1)) > "${counterPath}"; echo "key-value"'`;
				writeRawModelsJson({
					"custom-provider": providerWithApiKey(command),
				});

				const registry1 = await createModelRegistry(authStorage, modelsJsonPath);
				await registry1.getApiKeyForProvider("custom-provider");

				const registry2 = await createModelRegistry(authStorage, modelsJsonPath);
				await registry2.getApiKeyForProvider("custom-provider");

				const count = parseInt(readFileSync(counterFile, "utf-8").trim(), 10);
				expect(count).toBe(2);
			});

			test("different commands resolve independently", async () => {
				writeRawModelsJson({
					"provider-a": providerWithApiKey("!echo key-a"),
					"provider-b": providerWithApiKey("!echo key-b"),
				});

				const registry = await createModelRegistry(authStorage, modelsJsonPath);

				const keyA = await registry.getApiKeyForProvider("provider-a");
				const keyB = await registry.getApiKeyForProvider("provider-b");

				expect(keyA).toBe("key-a");
				expect(keyB).toBe("key-b");
			});

			test("failed commands are retried", async () => {
				const counterFile = join(tempDir, "counter");
				writeFileSync(counterFile, "0");

				const counterPath = toShPath(counterFile);
				const command = `!sh -c 'count=$(cat "${counterPath}"); echo $((count + 1)) > "${counterPath}"; exit 1'`;
				writeRawModelsJson({
					"custom-provider": providerWithApiKey(command),
				});

				const registry = await createModelRegistry(authStorage, modelsJsonPath);
				const key1 = await registry.getApiKeyForProvider("custom-provider");
				const key2 = await registry.getApiKeyForProvider("custom-provider");

				expect(key1).toBeUndefined();
				expect(key2).toBeUndefined();

				const count = parseInt(readFileSync(counterFile, "utf-8").trim(), 10);
				expect(count).toBe(2);
			});

			test("provider auth status reports apiKey environment variables from models.json", async () => {
				const envVarName = "TEST_API_KEY_STATUS_TEST_98765";
				const originalEnv = process.env[envVarName];

				try {
					process.env[envVarName] = "status-test-key";

					writeRawModelsJson({
						"custom-provider": providerWithApiKey(`$${envVarName}`),
					});

					const registry = await createModelRegistry(authStorage, modelsJsonPath);

					expect(registry.getProviderAuthStatus("custom-provider")).toEqual({
						configured: true,
						source: "environment",
						label: envVarName,
					});
				} finally {
					if (originalEnv === undefined) {
						delete process.env[envVarName];
					} else {
						process.env[envVarName] = originalEnv;
					}
				}
			});

			test("provider auth status reports interpolated apiKey environment variables", async () => {
				const envVarNameA = "TEST_API_KEY_STATUS_PART_A_98765";
				const envVarNameB = "TEST_API_KEY_STATUS_PART_B_98765";
				const originalEnvA = process.env[envVarNameA];
				const originalEnvB = process.env[envVarNameB];
				process.env[envVarNameA] = "left";
				process.env[envVarNameB] = "right";
				const interpolatedKey = ["$", "{", envVarNameA, "}_$", "{", envVarNameB, "}"].join("");

				try {
					writeRawModelsJson({
						"custom-provider": providerWithApiKey(interpolatedKey),
					});

					const registry = await createModelRegistry(authStorage, modelsJsonPath);

					expect(registry.getProviderAuthStatus("custom-provider")).toEqual({
						configured: true,
						source: "environment",
						label: `${envVarNameA}, ${envVarNameB}`,
					});
				} finally {
					if (originalEnvA === undefined) {
						delete process.env[envVarNameA];
					} else {
						process.env[envVarNameA] = originalEnvA;
					}
					if (originalEnvB === undefined) {
						delete process.env[envVarNameB];
					} else {
						process.env[envVarNameB] = originalEnvB;
					}
				}
			});

			test("provider auth status reports non-env apiKey values from models.json as a config key", async () => {
				writeRawModelsJson({
					"custom-provider": providerWithApiKey("literal_api_key_value"),
				});

				const registry = await createModelRegistry(authStorage, modelsJsonPath);

				expect(registry.getProviderAuthStatus("custom-provider")).toEqual({
					configured: true,
					source: "models_json_key",
				});
			});

			test("missing explicit env apiKey keeps provider unavailable", async () => {
				const envVarName = "TEST_API_KEY_MISSING_TEST_98765";
				const originalEnv = process.env[envVarName];
				delete process.env[envVarName];

				try {
					writeRawModelsJson({
						"custom-provider": providerWithApiKey(`$${envVarName}`),
					});

					const registry = await createModelRegistry(authStorage, modelsJsonPath);

					expect(registry.getProviderAuthStatus("custom-provider")).toEqual({ configured: false });
					expect(registry.getAvailable().some((model) => model.provider === "custom-provider")).toBe(false);
				} finally {
					if (originalEnv === undefined) {
						delete process.env[envVarName];
					} else {
						process.env[envVarName] = originalEnv;
					}
				}
			});

			test("provider auth status reports command apiKey values from models.json without executing them", async () => {
				const counterFile = join(tempDir, "status-counter");
				writeFileSync(counterFile, "0");
				const counterPath = toShPath(counterFile);
				const command = `!sh -c 'echo 1 > "${counterPath}"; echo key-value'`;
				writeRawModelsJson({
					"custom-provider": providerWithApiKey(command),
				});

				const registry = await createModelRegistry(authStorage, modelsJsonPath);

				expect(registry.getProviderAuthStatus("custom-provider")).toEqual({
					configured: true,
					source: "models_json_command",
				});
				expect(readFileSync(counterFile, "utf-8")).toBe("0");
			});

			test("environment variables are not cached (changes are picked up)", async () => {
				const envVarName = "TEST_API_KEY_CACHE_TEST_98765";
				const originalEnv = process.env[envVarName];

				try {
					process.env[envVarName] = "first-value";

					writeRawModelsJson({
						"custom-provider": providerWithApiKey(`$${envVarName}`),
					});

					const registry = await createModelRegistry(authStorage, modelsJsonPath);

					const key1 = await registry.getApiKeyForProvider("custom-provider");
					expect(key1).toBe("first-value");

					process.env[envVarName] = "second-value";

					const key2 = await registry.getApiKeyForProvider("custom-provider");
					expect(key2).toBe("second-value");
				} finally {
					if (originalEnv === undefined) {
						delete process.env[envVarName];
					} else {
						process.env[envVarName] = originalEnv;
					}
				}
			});

			test("getAvailable does not execute command-backed apiKey resolution", async () => {
				const counterFile = join(tempDir, "counter");
				writeFileSync(counterFile, "0");

				const counterPath = toShPath(counterFile);
				const command = `!sh -c 'count=$(cat "${counterPath}"); echo $((count + 1)) > "${counterPath}"; echo "key-value"'`;
				writeRawModelsJson({
					"custom-provider": providerWithApiKey(command),
				});

				const registry = await createModelRegistry(authStorage, modelsJsonPath);
				const available = registry.getAvailable();

				expect(available.some((m) => m.provider === "custom-provider")).toBe(true);
				const count = parseInt(readFileSync(counterFile, "utf-8").trim(), 10);
				expect(count).toBe(0);
			});

			test("getApiKeyAndHeaders resolves authHeader on every request", async () => {
				const tokenFile = join(tempDir, "token");
				writeFileSync(tokenFile, "token-1");
				const tokenPath = toShPath(tokenFile);

				writeRawModelsJson({
					"custom-provider": {
						...providerWithApiKey(`!sh -c 'cat "${tokenPath}"'`),
						authHeader: true,
					},
				});

				const registry = await createModelRegistry(authStorage, modelsJsonPath);
				const model = registry.find("custom-provider", "test-model");
				expect(model).toBeDefined();

				const auth1 = await registry.getApiKeyAndHeaders(model!);
				expect(auth1).toEqual({
					ok: true,
					apiKey: "token-1",
					headers: { Authorization: "Bearer token-1" },
				});

				writeFileSync(tokenFile, "token-2");

				const auth2 = await registry.getApiKeyAndHeaders(model!);
				expect(auth2).toEqual({
					ok: true,
					apiKey: "token-2",
					headers: { Authorization: "Bearer token-2" },
				});
			});

			test("getApiKeyAndHeaders resolves configured auth exactly once", async () => {
				const counterFile = join(tempDir, "auth-counter");
				writeFileSync(counterFile, "0");
				const counterPath = toShPath(counterFile);
				writeRawModelsJson({
					"custom-provider": {
						...providerWithApiKey(
							`!sh -c 'count=$(cat "${counterPath}"); count=$((count + 1)); echo "$count" > "${counterPath}"; echo "token-$count"'`,
						),
						authHeader: true,
					},
				});

				const registry = await createModelRegistry(authStorage, modelsJsonPath);
				const auth = await registry.getApiKeyAndHeaders(registry.find("custom-provider", "test-model")!);

				expect(auth).toEqual({
					ok: true,
					apiKey: "token-1",
					headers: { Authorization: "Bearer token-1" },
				});
				expect(readFileSync(counterFile, "utf-8").trim()).toBe("1");
			});

			test("stored credentials bypass lower-priority configured auth commands", async () => {
				const counterFile = join(tempDir, "fallback-counter");
				writeFileSync(counterFile, "0");
				const counterPath = toShPath(counterFile);
				writeRawModelsJson({
					"custom-provider": providerWithApiKey(`!sh -c 'echo 1 > "${counterPath}"; echo fallback-key'`),
				});
				await authStorage.modify("custom-provider", async () => ({ type: "api_key", key: "stored-key" }));

				const registry = await createModelRegistry(authStorage, modelsJsonPath);
				const auth = await registry.getApiKeyAndHeaders(registry.find("custom-provider", "test-model")!);

				expect(auth).toMatchObject({ ok: true, apiKey: "stored-key" });
				expect(readFileSync(counterFile, "utf-8").trim()).toBe("0");
			});

			test("getApiKeyAndHeaders preserves the legacy missing-key authHeader error", async () => {
				writeRawModelsJson({
					"custom-provider": {
						baseUrl: "https://example.test/v1",
						api: "openai-completions",
						authHeader: true,
						models: [{ id: "test-model" }],
					},
				});

				const registry = await createModelRegistry(authStorage, modelsJsonPath);
				const auth = await registry.getApiKeyAndHeaders(registry.find("custom-provider", "test-model")!);

				expect(auth).toEqual({ ok: false, error: 'No API key found for "custom-provider"' });
			});

			test("getApiKeyAndHeaders returns an error for failed authHeader resolution", async () => {
				writeRawModelsJson({
					"custom-provider": {
						...providerWithApiKey("!exit 1"),
						authHeader: true,
					},
				});

				const registry = await createModelRegistry(authStorage, modelsJsonPath);
				const model = registry.find("custom-provider", "test-model");
				expect(model).toBeDefined();

				const auth = await registry.getApiKeyAndHeaders(model!);
				expect(auth.ok).toBe(false);
				if (!auth.ok) {
					expect(auth.error).toContain('Failed to resolve API key for provider "custom-provider"');
				}
			});
		});
	});
});
