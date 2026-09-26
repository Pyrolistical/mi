import { existsSync, mkdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { DefaultResourceLoader } from "../../../src/core/resource-loader.ts";
import { SettingsManager } from "../../../src/core/settings-manager.ts";

describe("regression #3616: in-memory settings survive reload", () => {
	let tempDir: string;
	let agentDir: string;

	beforeEach(() => {
		tempDir = join(tmpdir(), `pi-settings-inmemory-${Date.now()}-${Math.random().toString(36).slice(2)}`);
		agentDir = join(tempDir, "agent");
		mkdirSync(agentDir, { recursive: true });
	});

	afterEach(() => {
		if (tempDir && existsSync(tempDir)) {
			rmSync(tempDir, { recursive: true, force: true });
		}
	});

	it("preserves initial settings after direct reload", async () => {
		const settingsManager = SettingsManager.inMemory({
			defaultThinkingLevel: "high",
			images: { blockImages: true },
			compaction: { enabled: false },
		});

		await settingsManager.reload();

		expect(settingsManager.getDefaultThinkingLevel()).toBe("high");
		expect(settingsManager.getBlockImages()).toBe(true);
		expect(settingsManager.getCompactionEnabled()).toBe(false);
		expect(settingsManager.getGlobalSettings()).toEqual({
			defaultThinkingLevel: "high",
			images: { blockImages: true },
			compaction: { enabled: false },
		});
	});

	it("preserves initial settings when DefaultResourceLoader reloads", async () => {
		const settingsManager = SettingsManager.inMemory({
			defaultThinkingLevel: "high",
			images: { blockImages: true },
			compaction: { enabled: false },
		});
		const resourceLoader = new DefaultResourceLoader({
			cwd: tempDir,
			agentDir,
			settingsManager,
			noExtensions: true,
			noSkills: true,
			noPromptTemplates: true,
			noContextFiles: true,
		});

		await resourceLoader.reload();

		expect(settingsManager.getDefaultThinkingLevel()).toBe("high");
		expect(settingsManager.getBlockImages()).toBe(true);
		expect(settingsManager.getCompactionEnabled()).toBe(false);
	});

	it("preserves initial settings after an unrelated setter, flush, and reload", async () => {
		const settingsManager = SettingsManager.inMemory({
			images: { blockImages: true },
			compaction: { enabled: false },
		});

		settingsManager.setDefaultProvider("openai");
		await settingsManager.flush();
		await settingsManager.reload();

		expect(settingsManager.getDefaultProvider()).toBe("openai");
		expect(settingsManager.getBlockImages()).toBe(true);
		expect(settingsManager.getCompactionEnabled()).toBe(false);
		expect(settingsManager.getGlobalSettings()).toEqual({
			images: { blockImages: true },
			compaction: { enabled: false },
			defaultProvider: "openai",
		});
	});
});
