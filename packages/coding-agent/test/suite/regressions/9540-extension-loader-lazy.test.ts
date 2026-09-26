import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it, vi } from "bun:test";

const state = { virtualModulesLoads: 0 };

vi.mock("../../../src/core/extensions/virtual-modules.ts", () => {
	state.virtualModulesLoads++;
	return { VIRTUAL_MODULES: {} };
});

import { loadExtensions } from "../../../src/core/extensions/loader.ts";

const directory = mkdtempSync(join(tmpdir(), "pi-extension-lazy-"));

afterAll(() => {
	rmSync(directory, { recursive: true, force: true });
});

describe("extension loader lazy imports", () => {
	it("defers virtual modules until importing an extension", async () => {
		const extensionPath = join(directory, "extension.ts");
		writeFileSync(extensionPath, "export default function () {}\n");
		expect(state.virtualModulesLoads).toBe(0);

		const result = await loadExtensions([extensionPath], directory);

		expect(result.errors).toEqual([]);
		expect(result.extensions).toHaveLength(1);
		expect(state.virtualModulesLoads).toBe(1);
	});
});
