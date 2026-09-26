import { rmSync } from "node:fs";
import { afterEach, describe, expect, it } from "bun:test";
import { isValidThinkingLevel } from "../src/cli/args.ts";
import { SettingsManager } from "../src/core/settings-manager.ts";

const tempDirs: string[] = [];

afterEach(() => {
	for (const dir of tempDirs.splice(0)) {
		rmSync(dir, { recursive: true, force: true });
	}
});

describe("max thinking level", () => {
	it("is accepted by CLI and settings", async () => {
		expect(isValidThinkingLevel("max")).toBe(true);

		const settings = SettingsManager.inMemory();
		settings.setDefaultThinkingLevel("max");
		await settings.flush();
		expect(settings.getDefaultThinkingLevel()).toBe("max");
	});
});
