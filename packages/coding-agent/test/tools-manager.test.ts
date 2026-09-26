import type * as ChildProcess from "node:child_process";
import type * as Fs from "node:fs";
import { describe, expect, it, vi } from "vitest";
import { ensureTool, type ToolStatus } from "../src/utils/tools-manager.ts";

vi.mock("fs", async (importOriginal) => {
	const actual = await importOriginal<typeof Fs>();
	return {
		...actual,
		existsSync: vi.fn(() => false),
	};
});

vi.mock("child_process", async (importOriginal) => {
	const actual = await importOriginal<typeof ChildProcess>();
	return {
		...actual,
		spawnSync: vi.fn(() => ({ error: new Error("not found") })),
	};
});

describe("ensureTool", () => {
	it("warns through the callback when the tool is missing", () => {
		const statuses: ToolStatus[] = [];
		const consoleLog = vi.spyOn(console, "log").mockImplementation(() => {});

		const result = ensureTool("fd", (status) => statuses.push(status));

		expect(result).toBeUndefined();
		expect(statuses).toHaveLength(1);
		expect(statuses[0]?.type).toBe("warning");
		expect(statuses[0]?.message).toMatch(/^fd not found\. Install it or place it in /);
		expect(consoleLog).not.toHaveBeenCalled();
		consoleLog.mockRestore();
	});
});
