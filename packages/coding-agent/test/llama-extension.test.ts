import { once } from "node:events";
import { createServer, type RequestListener, type Server, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import type { AuthContext, ModelsPublication, ModelsStoreEntry } from "@earendil-works/pi-ai";
import { afterEach, describe, expect, it } from "bun:test";
import { createEventBus } from "../src/core/event-bus.ts";
import { createExtensionRuntime, loadExtensionFromFactory } from "../src/core/extensions/loader.ts";
import { normalizeLlamaServerUrl } from "../src/extensions/llama/client.ts";
import llamaExtension from "../src/extensions/llama/index.ts";
import { createLlamaProvider, LLAMA_PROVIDER_ID } from "../src/extensions/llama/provider.ts";

const servers: Server[] = [];

async function listen(handler: RequestListener): Promise<{ server: Server; url: string }> {
	const server = createServer(handler);
	servers.push(server);
	server.listen(0, "127.0.0.1");
	await once(server, "listening");
	const address = server.address() as AddressInfo;
	return { server, url: `http://127.0.0.1:${address.port}` };
}

function json(response: ServerResponse, value: unknown): void {
	response.writeHead(200, { "Content-Type": "application/json" });
	response.end(JSON.stringify(value));
}

afterEach(async () => {
	await Promise.all(
		servers.splice(0).map(
			(server) =>
				new Promise<void>((resolve) => {
					server.close(() => resolve());
					server.closeAllConnections();
				}),
		),
	);
});

describe("llama.cpp extension", () => {
	it("registers a native provider", async () => {
		const runtime = createExtensionRuntime();
		await loadExtensionFromFactory(llamaExtension, process.cwd(), createEventBus(), runtime, "<inline:llama.cpp>");

		expect(runtime.pendingNativeProviderRegistrations.map((entry) => entry.provider.id)).toEqual([LLAMA_PROVIDER_ID]);
	});

	it("normalizes management and inference URLs", () => {
		expect(normalizeLlamaServerUrl("http://127.0.0.1:8080/v1/")).toBe("http://127.0.0.1:8080");
		expect(normalizeLlamaServerUrl("https://example.com/prefix/v1")).toBe("https://example.com/prefix");
		expect(() => normalizeLlamaServerUrl("file:///tmp/llama")).toThrow("http or https");
	});

	it("exposes loaded and sleeping models with router metadata", async () => {
		const { url } = await listen((request, response) => {
			if (request.url === "/models") {
				json(response, {
					data: [
						{
							id: "loaded",
							status: { value: "loaded", args: ["llama-server", "--n-gpu-layers", "999"] },
							architecture: { input_modalities: ["text", "image"] },
							meta: { n_ctx: 65536, n_ctx_train: 131072 },
						},
						{ id: "sleeping", status: { value: "sleeping" } },
						{ id: "unloaded", status: { value: "unloaded" } },
						{ id: "loading", status: { value: "loading" } },
					],
				});
				return;
			}
			if (new URL(request.url ?? "", "http://localhost").pathname === "/props") {
				json(response, {});
				return;
			}
			response.writeHead(404).end();
		});

		const provider = createLlamaProvider();
		await provider.refreshModels?.({
			credential: { type: "api_key", key: "local", env: { LLAMA_BASE_URL: url } },
			stored: undefined,
			publish: async (publication) => {
				publication.update?.();
				return true;
			},
			allowNetwork: true,
			signal: new AbortController().signal,
		});

		expect(provider.getModels()).toEqual([
			expect.objectContaining({
				id: "loaded",
				baseUrl: `${url}/v1`,
				contextWindow: 65536,
				maxTokens: 65536,
				input: ["text", "image"],
			}),
			expect.objectContaining({
				id: "sleeping",
				baseUrl: `${url}/v1`,
			}),
		]);
	});

	it("discovers chat-template thinking support for loaded models", async () => {
		let propsRequests = 0;
		const { url } = await listen((request, response) => {
			if (request.url === "/models") {
				json(response, {
					data: [{ id: "qwen", status: { value: "loaded" }, meta: { n_ctx: 32768 } }],
				});
				return;
			}
			const requestUrl = new URL(request.url ?? "", "http://localhost");
			if (requestUrl.pathname === "/props") {
				propsRequests++;
				expect(requestUrl.searchParams.get("model")).toBe("qwen");
				expect(requestUrl.searchParams.get("autoload")).toBe("false");
				json(response, { chat_template: "{% if enable_thinking %}think{% endif %}" });
				return;
			}
			response.writeHead(404).end();
		});

		const provider = createLlamaProvider();
		await provider.refreshModels?.({
			credential: { type: "api_key", key: "local", env: { LLAMA_BASE_URL: url } },
			stored: undefined,
			publish: async (publication) => {
				publication.update?.();
				return true;
			},
			allowNetwork: true,
			signal: new AbortController().signal,
		});

		expect(propsRequests).toBe(1);
		expect(provider.getModels()).toEqual([
			expect.objectContaining({
				id: "qwen",
				reasoning: true,
				thinkingLevelMap: {
					off: "off",
					minimal: null,
					low: null,
					medium: "medium",
					high: null,
					xhigh: null,
				},
				compat: expect.objectContaining({ thinkingFormat: "qwen-chat-template" }),
			}),
		]);
	});

	it("persists and restores selectable models for cache-only startup refreshes", async () => {
		let cachedEntry: ModelsStoreEntry | undefined;
		const { url } = await listen((request, response) => {
			if (request.url === "/models") {
				json(response, {
					data: [
						{ id: "loaded", status: { value: "loaded" }, meta: { n_ctx: 32768 } },
						{ id: "sleeping", status: { value: "sleeping" }, meta: { n_ctx: 32768 } },
						{ id: "unloaded", status: { value: "unloaded" } },
					],
				});
				return;
			}
			if (request.url === "/props?model=loaded&autoload=false") {
				json(response, {});
				return;
			}
			response.writeHead(404).end();
		});

		const publish = async (publication: ModelsPublication): Promise<boolean> => {
			if (publication.persist === null) cachedEntry = undefined;
			else if (publication.persist !== undefined) cachedEntry = structuredClone(publication.persist);
			publication.update?.();
			return true;
		};
		const first = createLlamaProvider();
		await first.refreshModels?.({
			credential: { type: "api_key", key: "local", env: { LLAMA_BASE_URL: url } },
			stored: cachedEntry,
			publish,
			allowNetwork: true,
			signal: new AbortController().signal,
		});
		expect(first.getModels().map((model) => model.id)).toEqual(["loaded", "sleeping"]);
		expect(cachedEntry?.models.map((model) => model.id)).toEqual(["loaded", "sleeping"]);

		const second = createLlamaProvider();
		await second.refreshModels?.({
			credential: { type: "api_key", key: "local", env: { LLAMA_BASE_URL: url } },
			stored: cachedEntry,
			publish,
			allowNetwork: false,
			signal: new AbortController().signal,
		});
		expect(second.getModels()).toEqual([
			expect.objectContaining({ id: "loaded", baseUrl: `${url}/v1`, contextWindow: 32768 }),
			expect.objectContaining({ id: "sleeping", baseUrl: `${url}/v1`, contextWindow: 32768 }),
		]);
	});

	it("exposes unloaded presets only when router autoload is enabled", async () => {
		let propsRequests = 0;
		const { url } = await listen((request, response) => {
			expect(request.headers.authorization).toBe("Bearer local");
			if (request.url === "/models") {
				json(response, {
					data: [
						{ id: "preset", status: { value: "unloaded" }, source: "preset", meta: { n_ctx: 65536 } },
						{ id: "failed-preset", status: { value: "unloaded", failed: true }, source: "preset" },
						{ id: "cache", status: { value: "unloaded" }, source: "cache" },
						{ id: "models-dir", status: { value: "unloaded" }, source: "models_dir" },
					],
				});
				return;
			}
			if (request.url === "/props") {
				propsRequests++;
				json(response, { role: "router", models_autoload: true });
				return;
			}
			response.writeHead(404).end();
		});

		let cachedEntry: ModelsStoreEntry | undefined;
		const provider = createLlamaProvider();
		await provider.refreshModels?.({
			credential: { type: "api_key", key: "local", env: { LLAMA_BASE_URL: url } },
			stored: undefined,
			publish: async (publication) => {
				if (publication.persist !== undefined && publication.persist !== null) {
					cachedEntry = structuredClone(publication.persist);
				}
				publication.update?.();
				return true;
			},
			allowNetwork: true,
			signal: new AbortController().signal,
		});

		expect(propsRequests).toBe(1);
		expect(provider.getModels().map((model) => model.id)).toEqual(["preset"]);
		expect(cachedEntry?.models.map((model) => model.id)).toEqual(["preset"]);
	});

	it("hides unloaded presets when router autoload is disabled", async () => {
		const { url } = await listen((request, response) => {
			if (request.url === "/models") {
				json(response, { data: [{ id: "preset", status: { value: "unloaded" }, source: "preset" }] });
				return;
			}
			if (request.url === "/props") {
				json(response, { role: "router", models_autoload: false });
				return;
			}
			response.writeHead(404).end();
		});

		const provider = createLlamaProvider();
		await provider.refreshModels?.({
			credential: { type: "api_key", key: "local", env: { LLAMA_BASE_URL: url } },
			stored: undefined,
			publish: async (publication) => {
				publication.update?.();
				return true;
			},
			allowNetwork: true,
			signal: new AbortController().signal,
		});

		expect(provider.getModels()).toEqual([]);
	});

	it("stays dormant until configured and resolves a stored URL plus optional key", async () => {
		const provider = createLlamaProvider();
		const auth = provider.auth.apiKey!;
		const emptyContext: AuthContext = {
			env: async () => undefined,
			fileExists: async () => false,
		};
		const signal = new AbortController().signal;
		expect(await auth.check?.({ ctx: emptyContext, signal })).toBeUndefined();
		expect(await auth.resolve({ ctx: emptyContext, signal })).toBeUndefined();

		const url = "http://127.0.0.1:8080";
		const credential = { type: "api_key" as const, key: "secret", env: { LLAMA_BASE_URL: url } };
		expect(await auth.resolve({ ctx: emptyContext, credential, signal })).toEqual({
			auth: { apiKey: "secret", baseUrl: `${url}/v1` },
			env: { LLAMA_BASE_URL: url },
			source: "stored credential",
		});
	});
});
