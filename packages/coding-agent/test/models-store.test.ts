import { chmodSync, existsSync, mkdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Model } from "@earendil-works/pi-ai";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "bun:test";
import { FileModelsStore } from "../src/core/models-store.ts";

const sharedTempDir = join(tmpdir(), `pi-models-store-shared-${Date.now()}-${Math.random().toString(36).slice(2)}`);
const sharedModelsPath = join(sharedTempDir, "models-store.json");

beforeAll(() => {
	mkdirSync(sharedTempDir, { recursive: true });
});

afterAll(() => {
	if (existsSync(sharedTempDir)) rmSync(sharedTempDir, { recursive: true });
});

afterEach(() => {
	vi.restoreAllMocks();
});

function model(provider: string, id: string): Model<"openai-completions"> {
	return {
		id,
		name: id,
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

describe("FileModelsStore", () => {
	it("persists provider catalogs without replacing unrelated providers", async () => {
		const store = new FileModelsStore(sharedModelsPath);

		await store.write("one", { models: [model("one", "m1")], checkedAt: 100 });
		await store.write("two", { models: [model("two", "m2")], checkedAt: 200 });

		const reloaded = new FileModelsStore(sharedModelsPath);
		expect((await reloaded.read("one"))?.models.map((entry) => entry.id)).toEqual(["m1"]);
		expect((await reloaded.read("one"))?.checkedAt).toBe(100);
		expect((await reloaded.read("two"))?.models.map((entry) => entry.id)).toEqual(["m2"]);

		await reloaded.delete("one");
		expect(await reloaded.read("one")).toBeUndefined();
		expect((await reloaded.read("two"))?.models.map((entry) => entry.id)).toEqual(["m2"]);
	});

	it("preserves the mode of an existing models file", async () => {
		const managedModelsPath = join(sharedTempDir, "managed-mode.json");
		writeFileSync(managedModelsPath, "{}");
		chmodSync(managedModelsPath, 0o660);
		const store = new FileModelsStore(managedModelsPath);

		await store.write("one", { models: [model("one", "m1")], checkedAt: 100 });

		expect(statSync(managedModelsPath).mode & 0o777).toBe(0o660);
	});

});
