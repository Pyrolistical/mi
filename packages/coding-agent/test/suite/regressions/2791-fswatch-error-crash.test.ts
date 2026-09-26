import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { closeWatcher, watchWithErrorHandler } from "../../../src/utils/fs-watch.ts";

describe("issue #2791 fs.watch error event crashes process", () => {
	let tempRoot: string;

	beforeEach(() => {
		tempRoot = mkdtempSync(join(tmpdir(), "pi-2791-"));
	});

	afterEach(() => {
		rmSync(tempRoot, { recursive: true, force: true });
	});

	it("survives an error event on a watcher", () => {
		let errors = 0;
		const watcher = watchWithErrorHandler(
			tempRoot,
			() => {},
			() => errors++,
		);
		expect(watcher).not.toBeNull();

		watcher?.emit("error", new Error("simulated OS watcher failure"));

		expect(errors).toBe(1);
		closeWatcher(watcher);
	});
});
