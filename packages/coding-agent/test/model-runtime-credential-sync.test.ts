import type { Model, Provider } from "@earendil-works/pi-ai";
import { describe, expect, it } from "bun:test";
import { AuthStorage } from "../src/core/auth-storage.ts";
import { ModelRuntime } from "../src/core/model-runtime.ts";

function model(provider: string): Model<"openai-completions"> {
	return {
		id: "dynamic",
		name: "Dynamic",
		api: "openai-completions",
		provider,
		baseUrl: "https://example.test/v1",
		reasoning: false,
		input: ["text"],
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
		contextWindow: 1000,
		maxTokens: 100,
	};
}

function provider(
	id: string,
	options: {
		refreshModels?: Provider["refreshModels"];
	} = {},
): Provider<"openai-completions"> {
	const providerModel = model(id);
	return {
		id,
		name: id,
		auth: {
			apiKey: {
				name: "API key",
				check: async ({ credential }) => (credential ? { type: "api_key", source: "stored" } : undefined),
				resolve: async ({ credential }) =>
					credential ? { auth: { apiKey: credential.key }, source: "stored" } : undefined,
			},
		},
		getModels: () => [providerModel],
		refreshModels: options.refreshModels,
		stream: () => {
			throw new Error("unused");
		},
		streamSimple: () => {
			throw new Error("unused");
		},
	};
}

async function runtimeWithProvider(
	registered: Provider,
	credentials: AuthStorage = AuthStorage.inMemory(),
): Promise<ModelRuntime> {
	const runtime = await ModelRuntime.create({ credentials, modelsPath: null, allowModelNetwork: false });
	runtime.registerNativeProvider(registered);
	await runtime.refresh({ allowNetwork: false, providers: [registered.id] });
	return runtime;
}

describe("ModelRuntime credential synchronization", () => {
	it("reports cancellation that occurs during provider-scoped availability", async () => {
		let blockAvailability = false;
		let markStarted: (() => void) | undefined;
		const started = new Promise<void>((resolve) => {
			markStarted = resolve;
		});
		const registered = provider("cancelled-availability");
		if (registered.auth.apiKey) {
			registered.auth.apiKey.check = async ({ credential }) => {
				if (blockAvailability) {
					markStarted?.();
					await new Promise<void>(() => {});
				}
				return credential ? { type: "api_key", source: "stored" } : undefined;
			};
		}
		const runtime = await runtimeWithProvider(registered);
		await runtime.setRuntimeApiKey(registered.id, "key");
		blockAvailability = true;
		const controller = new AbortController();
		const refresh = runtime.refresh({
			allowNetwork: false,
			providers: [registered.id],
			signal: controller.signal,
		});
		await started;
		controller.abort();

		await expect(refresh).resolves.toMatchObject({ aborted: true });
	});

	it("keeps provider-scoped refreshes from superseding unrelated providers", async () => {
		let markStarted: (() => void) | undefined;
		let finish: (() => void) | undefined;
		let firstSignal: AbortSignal | undefined;
		const started = new Promise<void>((resolve) => {
			markStarted = resolve;
		});
		const blocked = new Promise<void>((resolve) => {
			finish = resolve;
		});
		const runtime = await ModelRuntime.create({ credentials: AuthStorage.inMemory(), modelsPath: null });
		runtime.registerNativeProvider(
			provider("one", {
				refreshModels: async (context) => {
					if (!context.allowNetwork) return;
					firstSignal = context.signal;
					markStarted?.();
					await blocked;
				},
			}),
		);
		runtime.registerNativeProvider(provider("two"));
		await runtime.refresh({ allowNetwork: false, providers: ["one", "two"] });
		await runtime.setRuntimeApiKey("one", "one-key");
		await runtime.setRuntimeApiKey("two", "two-key");

		const first = runtime.refresh({ allowNetwork: true, providers: ["one"] });
		await started;
		await runtime.refresh({ allowNetwork: true, providers: ["two"] });
		expect(firstSignal?.aborted).toBe(false);

		finish?.();
		await first;
	});
});
