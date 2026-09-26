import { describe, expect, test } from "vitest";
import { findExtensionStackMatches } from "../src/core/crash-log.ts";

type StackExtension = Parameters<typeof findExtensionStackMatches>[1][number];

describe("extension crash attribution", () => {
	test("does not attribute sibling single-file extensions", () => {
		const extension = (name: string): StackExtension => ({
			path: `/plugins/${name}.ts`,
			resolvedPath: `/plugins/${name}.ts`,
			sourceInfo: {
				path: `/plugins/${name}.ts`,
				source: `/plugins/${name}.ts`,
				scope: "user",
				baseDir: "/plugins",
			},
		});
		const stack = "Error: broken\n    at run (file:///plugins/b.ts:4:2)";

		expect(findExtensionStackMatches(stack, [extension("a"), extension("b")])).toEqual(["/plugins/b.ts"]);
	});

	test("ignores extension paths in the error message", () => {
		const extension: StackExtension = {
			path: "/tmp/memory/extensions/index.ts",
			resolvedPath: "/tmp/memory/extensions/index.ts",
			sourceInfo: {
				path: "/tmp/memory/extensions/index.ts",
				source: "local",
				scope: "user",
				baseDir: "/tmp/memory/extensions",
			},
		};
		const stack = `Error: Failed to read ${extension.resolvedPath}\n    at run (file:///opt/pi/dist/core.js:4:2)`;

		expect(findExtensionStackMatches(stack, [extension])).toEqual([]);
	});

	test("decodes frame paths independently from malformed error text", () => {
		const extension: StackExtension = {
			path: "/Users/reporter/.pi/agent/extensions/local memory/index.ts",
			resolvedPath: "/Users/reporter/.pi/agent/extensions/local memory/index.ts",
			sourceInfo: {
				path: "/Users/reporter/.pi/agent/extensions/local memory/index.ts",
				source: "local",
				scope: "user",
				baseDir: "/Users/reporter/.pi/agent/extensions",
			},
		};
		const stack =
			"Error: progress 100%\n    at run (file:///Users/reporter/.pi/agent/extensions/local%20memory/worker.ts:4:2)";

		expect(findExtensionStackMatches(stack, [extension])).toEqual([extension.path]);
	});
});
