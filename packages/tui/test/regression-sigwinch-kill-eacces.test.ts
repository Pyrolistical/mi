import assert from "node:assert";
import { after, describe, it } from "node:test";
import { refreshTerminalDimensions } from "../src/terminal.ts";

describe("refreshTerminalDimensions", () => {
	const originalKill = process.kill;

	it("does not throw when kill(2) returns EACCES for self-signal", () => {
		process.kill = ((): typeof process.kill => {
			return (pid, _signal) => {
				if (pid === process.pid) {
					const err = new Error("kill EACCES") as NodeJS.ErrnoException;
					err.code = "EACCES";
					throw err;
				}
				return originalKill.call(process, pid, _signal);
			};
		})();

		assert.doesNotThrow(() => {
			refreshTerminalDimensions();
		});
	});

	it("preserves other error codes", () => {
		process.kill = ((): typeof process.kill => {
			return () => {
				const err = new Error("kill EPERM") as NodeJS.ErrnoException;
				err.code = "EPERM";
				throw err;
			};
		})();

		assert.doesNotThrow(() => {
			refreshTerminalDimensions();
		});
	});

	after(() => {
		process.kill = originalKill;
	});
});
