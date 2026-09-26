import { once } from "node:events";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import {
	createServer,
	type IncomingHttpHeaders,
	type RequestListener,
	type Server,
	type ServerResponse,
} from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { InMemoryCredentialStore } from "@earendil-works/pi-ai";
import { afterEach, describe, expect, it } from "bun:test";
import { ModelRuntime } from "../src/core/model-runtime.ts";
import { InMemoryCodingAgentModelsStore } from "../src/core/models-store.ts";

const servers: Server[] = [];
const dirs: string[] = [];

async function listen(handler: RequestListener): Promise<string> {
	const server = createServer(handler);
	servers.push(server);
	server.listen(0, "127.0.0.1");
	await once(server, "listening");
	return `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
}

function json(response: ServerResponse, value: unknown): void {
	response.writeHead(200, { "Content-Type": "application/json" });
	response.end(JSON.stringify(value));
}

async function createRuntime(providers: unknown): Promise<ModelRuntime> {
	const dir = await mkdtemp(join(tmpdir(), "pi-llama-server-"));
	dirs.push(dir);
	const modelsPath = join(dir, "models.json");
	await writeFile(modelsPath, JSON.stringify({ providers }));
	return ModelRuntime.create({
		credentials: new InMemoryCredentialStore(),
		modelsPath,
		modelsStore: new InMemoryCodingAgentModelsStore(),
		allowModelNetwork: false,
	});
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
	await Promise.all(dirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

describe("llama-server models.json api", () => {
	it("discovers a single served model without apiKey or models while creating the runtime", async () => {
		const url = await listen((request, response) => {
			if (request.url === "/v1/models") {
				json(response, { object: "list", data: [{ id: "qwen", aliases: ["qwen"], meta: { n_ctx: 200192 } }] });
				return;
			}
			if (request.url === "/props") {
				json(response, {
					default_generation_settings: { n_ctx: 200192 },
					modalities: { vision: true, video: true, audio: false },
					chat_template: "{{ enable_thinking }}",
					chat_template_caps: { supports_reasoning_effort: true },
				});
				return;
			}
			response.writeHead(404).end();
		});
		const runtime = await createRuntime({ local: { api: "llama-server", baseUrl: `${url}/v1` } });

		expect(runtime.getAvailableSnapshot()).toEqual([
			{
				id: "qwen",
				name: "qwen",
				api: "openai-completions",
				provider: "local",
				baseUrl: `${url}/v1`,
				reasoning: true,
				thinkingLevelMap: { off: "none" },
				input: ["text", "image", "video"],
				cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
				contextWindow: 200192,
				maxTokens: 200192,
				compat: {
					supportsStore: false,
					supportsDeveloperRole: false,
					supportsReasoningEffort: true,
					supportsUsageInStreaming: true,
					supportsStrictMode: false,
					maxTokensField: "max_tokens",
					thinkingFormat: "openai",
				},
			},
		]);
		const model = runtime.getModel("local", "qwen");
		expect(model && (await runtime.getAuth(model))?.auth).toEqual({ headers: { Authorization: null } });
	});

	it("applies models entries as overrides and sends the configured apiKey", async () => {
		const authorization: IncomingHttpHeaders["authorization"][] = [];
		const url = await listen((request, response) => {
			authorization.push(request.headers.authorization);
			if (request.url === "/v1/models") {
				json(response, { data: [{ id: "qwen" }] });
				return;
			}
			json(response, {
				default_generation_settings: { n_ctx: 32768 },
				modalities: { vision: false, video: false },
				chat_template: "",
				chat_template_caps: {},
			});
		});
		const runtime = await createRuntime({
			local: {
				api: "llama-server",
				baseUrl: url,
				apiKey: "secret",
				models: [
					{
						id: "qwen",
						name: "Qwen",
						maxTokens: 4096,
						cost: { input: 1, output: 2, cacheRead: 0, cacheWrite: 0 },
					},
				],
			},
		});

		const model = runtime.getModel("local", "qwen");
		expect({
			name: model?.name,
			reasoning: model?.reasoning,
			input: model?.input,
			contextWindow: model?.contextWindow,
			maxTokens: model?.maxTokens,
			cost: model?.cost,
		}).toEqual({
			name: "Qwen",
			reasoning: false,
			input: ["text"],
			contextWindow: 32768,
			maxTokens: 4096,
			cost: { input: 1, output: 2, cacheRead: 0, cacheWrite: 0, tiers: undefined },
		});
		expect(authorization).toEqual(["Bearer secret", "Bearer secret"]);
		expect(model && (await runtime.getAuth(model))?.auth.apiKey).toBe("secret");
	});

	it("lists only loaded and sleeping router models", async () => {
		const propsQueries: string[] = [];
		const url = await listen((request, response) => {
			const requestUrl = new URL(request.url ?? "", "http://localhost");
			if (requestUrl.pathname === "/v1/models") {
				json(response, {
					data: [
						{ id: "loaded", status: { value: "loaded" } },
						{ id: "sleeping", status: { value: "sleeping" } },
						{ id: "unloaded", status: { value: "unloaded" } },
					],
				});
				return;
			}
			propsQueries.push(requestUrl.search);
			json(response, {
				default_generation_settings: { n_ctx: 8192 },
				modalities: { vision: false, video: false },
				chat_template: "",
				chat_template_caps: {},
			});
		});
		const runtime = await createRuntime({ router: { api: "llama-server", baseUrl: url } });

		expect(runtime.getModels("router").map((model) => model.id)).toEqual(["loaded", "sleeping"]);
		expect(propsQueries.sort()).toEqual(["?model=loaded&autoload=false", "?model=sleeping&autoload=false"]);
	});

	it("defaults a custom provider with only baseUrl to llama-server", async () => {
		const url = await listen((request, response) => {
			if (request.url === "/v1/models") {
				json(response, { data: [{ id: "qwen" }] });
				return;
			}
			json(response, {
				default_generation_settings: { n_ctx: 32768 },
				modalities: { vision: false, video: false },
				chat_template: "",
				chat_template_caps: {},
			});
		});
		const runtime = await createRuntime({ local: { baseUrl: url } });

		expect(runtime.getModels("local").map((model) => [model.id, model.api, model.contextWindow])).toEqual([
			["qwen", "openai-completions", 32768],
		]);
	});
});
