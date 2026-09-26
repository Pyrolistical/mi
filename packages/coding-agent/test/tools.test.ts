import { chmodSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { afterEach, beforeEach, describe, expect, it, vi } from "bun:test";
import { executeBashWithOperations } from "../src/core/bash-executor.ts";
import type { ExtensionContext } from "../src/core/extensions/types.ts";
import {
	type BashOperations,
	createBashTool,
	createBashToolDefinition,
	createLocalBashOperations,
} from "../src/core/tools/bash.ts";
import { createEditToolDefinition } from "../src/core/tools/edit.ts";
import { createReadToolDefinition } from "../src/core/tools/read.ts";
import { createWriteToolDefinition } from "../src/core/tools/write.ts";
import { createEditTool, createReadTool, createWriteTool } from "../src/index.ts";
import * as shellModule from "../src/utils/shell.ts";

const readTool = createReadTool(process.cwd());
const writeTool = createWriteTool(process.cwd());
const editTool = createEditTool(process.cwd());
const bashTool = createBashTool(process.cwd());

function getTextOutput(result: any): string {
	return (
		result.content
			?.filter((c: any) => c.type === "text")
			.map((c: any) => c.text)
			.join("\n") || ""
	);
}

describe("Coding Agent Tools", () => {
	let testDir: string;

	beforeEach(() => {
		testDir = join(tmpdir(), `coding-agent-test-${Date.now()}`);
		mkdirSync(testDir, { recursive: true });
	});

	afterEach(() => {
		vi.restoreAllMocks();
		rmSync(testDir, { recursive: true, force: true });
	});

	describe("read tool", () => {
		it("should read file contents that fit within limits", async () => {
			const testFile = join(testDir, "test.txt");
			const content = "Hello, world!\nLine 2\nLine 3";
			writeFileSync(testFile, content);

			const result = await readTool.execute("test-call-1", { path: testFile });

			expect(getTextOutput(result)).toBe(content);
			expect(getTextOutput(result)).not.toContain("Use offset=");
			expect(result.details).toBeUndefined();
		});

		it("should handle non-existent files", async () => {
			const testFile = join(testDir, "nonexistent.txt");

			await expect(readTool.execute("test-call-2", { path: testFile })).rejects.toThrow(/ENOENT|not found/i);
		});

		it("should truncate files exceeding line limit", async () => {
			const testFile = join(testDir, "large.txt");
			const lines = Array.from({ length: 2500 }, (_, i) => `Line ${i + 1}`);
			writeFileSync(testFile, lines.join("\n"));

			const result = await readTool.execute("test-call-3", { path: testFile });
			const output = getTextOutput(result);

			expect(output).toContain("Line 1");
			expect(output).toContain("Line 2000");
			expect(output).not.toContain("Line 2001");
			expect(output).toContain("[Showing lines 1-2000 of 2500. Use offset=2001 to continue.]");
		});

		it("should truncate when byte limit exceeded", async () => {
			const testFile = join(testDir, "large-bytes.txt");
			const lines = Array.from({ length: 500 }, (_, i) => `Line ${i + 1}: ${"x".repeat(200)}`);
			writeFileSync(testFile, lines.join("\n"));

			const result = await readTool.execute("test-call-4", { path: testFile });
			const output = getTextOutput(result);

			expect(output).toContain("Line 1:");
			expect(output).toMatch(/\[Showing lines 1-\d+ of 500 \(.* limit\)\. Use offset=\d+ to continue\.\]/);
		});

		it("should handle offset parameter", async () => {
			const testFile = join(testDir, "offset-test.txt");
			const lines = Array.from({ length: 100 }, (_, i) => `Line ${i + 1}`);
			writeFileSync(testFile, lines.join("\n"));

			const result = await readTool.execute("test-call-5", { path: testFile, offset: 51 });
			const output = getTextOutput(result);

			expect(output).not.toContain("Line 50");
			expect(output).toContain("Line 51");
			expect(output).toContain("Line 100");
			expect(output).not.toContain("Use offset=");
		});

		it("should handle limit parameter", async () => {
			const testFile = join(testDir, "limit-test.txt");
			const lines = Array.from({ length: 100 }, (_, i) => `Line ${i + 1}`);
			writeFileSync(testFile, lines.join("\n"));

			const result = await readTool.execute("test-call-6", { path: testFile, limit: 10 });
			const output = getTextOutput(result);

			expect(output).toContain("Line 1");
			expect(output).toContain("Line 10");
			expect(output).not.toContain("Line 11");
			expect(output).toContain("[90 more lines in file. Use offset=11 to continue.]");
		});

		it("should handle offset + limit together", async () => {
			const testFile = join(testDir, "offset-limit-test.txt");
			const lines = Array.from({ length: 100 }, (_, i) => `Line ${i + 1}`);
			writeFileSync(testFile, lines.join("\n"));

			const result = await readTool.execute("test-call-7", {
				path: testFile,
				offset: 41,
				limit: 20,
			});
			const output = getTextOutput(result);

			expect(output).not.toContain("Line 40");
			expect(output).toContain("Line 41");
			expect(output).toContain("Line 60");
			expect(output).not.toContain("Line 61");
			expect(output).toContain("[40 more lines in file. Use offset=61 to continue.]");
		});

		it("should show error when offset is beyond file length", async () => {
			const testFile = join(testDir, "short.txt");
			writeFileSync(testFile, "Line 1\nLine 2\nLine 3");

			await expect(readTool.execute("test-call-8", { path: testFile, offset: 100 })).rejects.toThrow(
				/Offset 100 is beyond end of file \(3 lines total\)/,
			);
		});

		it("should include truncation details when truncated", async () => {
			const testFile = join(testDir, "large-file.txt");
			const lines = Array.from({ length: 2500 }, (_, i) => `Line ${i + 1}`);
			writeFileSync(testFile, lines.join("\n"));

			const result = await readTool.execute("test-call-9", { path: testFile });

			expect(result.details).toBeDefined();
			expect(result.details?.truncation).toBeDefined();
			expect(result.details?.truncation?.truncated).toBe(true);
			expect(result.details?.truncation?.truncatedBy).toBe("lines");
			expect(result.details?.truncation?.totalLines).toBe(2500);
			expect(result.details?.truncation?.outputLines).toBe(2000);
		});

		it("should detect image MIME type from file magic (not extension)", async () => {
			const png1x1Base64 =
				"iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR4nGNgYGD4DwABBAEAX+XDSwAAAABJRU5ErkJggg==";
			const pngBuffer = Buffer.from(png1x1Base64, "base64");

			const testFile = join(testDir, "image.txt");
			writeFileSync(testFile, pngBuffer);

			const result = await readTool.execute("test-call-img-1", { path: testFile });

			expect(result.content[0]?.type).toBe("text");
			expect(getTextOutput(result)).toContain("Read image file [image/png]");

			const imageBlock = result.content.find(
				(c): c is { type: "image"; mimeType: string; data: string } => c.type === "image",
			);
			expect(imageBlock).toBeDefined();
			expect(imageBlock?.mimeType).toBe("image/png");
			expect(typeof imageBlock?.data).toBe("string");
			expect((imageBlock?.data ?? "").length).toBeGreaterThan(0);
		});

		it("should treat files with image extension but non-image content as text", async () => {
			const testFile = join(testDir, "not-an-image.png");
			writeFileSync(testFile, "definitely not a png");

			const result = await readTool.execute("test-call-img-2", { path: testFile });
			const output = getTextOutput(result);

			expect(output).toContain("definitely not a png");
			expect(result.content.some((c: any) => c.type === "image")).toBe(false);
		});
	});

	describe("write tool", () => {
		it("should write file contents", async () => {
			const testFile = join(testDir, "write-test.txt");
			const content = "Test content";

			const result = await writeTool.execute("test-call-3", { path: testFile, content });

			expect(getTextOutput(result)).toBe(`Successfully wrote to ${testFile}`);
			expect(result.details).toBeUndefined();
		});

		it("should create parent directories", async () => {
			const testFile = join(testDir, "nested", "dir", "test.txt");
			const content = "Nested content";

			const result = await writeTool.execute("test-call-4", { path: testFile, content });

			expect(getTextOutput(result)).toContain("Successfully wrote");
		});
	});

	describe("edit tool", () => {
		it("should replace text in file", async () => {
			const testFile = join(testDir, "edit-test.txt");
			const originalContent = "Hello, world!";
			writeFileSync(testFile, originalContent);

			const result = await editTool.execute("test-call-5", {
				path: testFile,
				edits: [{ oldText: "world", newText: "testing" }],
			});

			expect(getTextOutput(result)).toContain("Successfully replaced");
			expect(readFileSync(testFile, "utf-8")).toBe("Hello, testing!");
		});

		it("should fail if text not found", async () => {
			const testFile = join(testDir, "edit-test.txt");
			const originalContent = "Hello, world!";
			writeFileSync(testFile, originalContent);

			await expect(
				editTool.execute("test-call-6", {
					path: testFile,
					edits: [{ oldText: "nonexistent", newText: "testing" }],
				}),
			).rejects.toThrow(/Could not find the exact text/);
		});

		it("should include ENOENT when the edit target does not exist", async () => {
			const missingFile = join(testDir, "missing.txt");

			await expect(
				editTool.execute("test-call-6b", {
					path: missingFile,
					edits: [{ oldText: "hello", newText: "world" }],
				}),
			).rejects.toThrow(`Could not edit file: ${missingFile}. Error code: ENOENT.`);
		});

		it("should fail if text appears multiple times", async () => {
			const testFile = join(testDir, "edit-test.txt");
			const originalContent = "foo foo foo";
			writeFileSync(testFile, originalContent);

			await expect(
				editTool.execute("test-call-7", {
					path: testFile,
					edits: [{ oldText: "foo", newText: "bar" }],
				}),
			).rejects.toThrow(/Found 3 occurrences/);
		});

		it("should replace multiple disjoint regions in one call", async () => {
			const testFile = join(testDir, "edit-multi.txt");
			writeFileSync(testFile, "alpha\nbeta\ngamma\ndelta\n");

			const result = await editTool.execute("test-call-8", {
				path: testFile,
				edits: [
					{ oldText: "alpha\n", newText: "ALPHA\n" },
					{ oldText: "gamma\n", newText: "GAMMA\n" },
				],
			});

			expect(getTextOutput(result)).toContain("Successfully replaced 2 block(s)");
			expect(readFileSync(testFile, "utf-8")).toBe("ALPHA\nbeta\nGAMMA\ndelta\n");
		});

		it("should match edits against the original file, not incrementally", async () => {
			const testFile = join(testDir, "edit-multi-original.txt");
			writeFileSync(testFile, "foo\nbar\nbaz\n");

			await editTool.execute("test-call-9", {
				path: testFile,
				edits: [
					{ oldText: "foo\n", newText: "foo bar\n" },
					{ oldText: "bar\n", newText: "BAR\n" },
				],
			});

			expect(readFileSync(testFile, "utf-8")).toBe("foo bar\nBAR\nbaz\n");
		});

		it("should fail when edits is empty", async () => {
			const testFile = join(testDir, "edit-empty-edits.txt");
			writeFileSync(testFile, "hello\nworld\n");

			await expect(
				editTool.execute("test-call-11", {
					path: testFile,
					edits: [],
				}),
			).rejects.toThrow(/edits must contain at least one replacement/);
		});

		it("should fail when multi-edit regions overlap", async () => {
			const testFile = join(testDir, "edit-overlap.txt");
			writeFileSync(testFile, "one\ntwo\nthree\n");

			await expect(
				editTool.execute("test-call-12", {
					path: testFile,
					edits: [
						{ oldText: "one\ntwo\n", newText: "ONE\nTWO\n" },
						{ oldText: "two\nthree\n", newText: "TWO\nTHREE\n" },
					],
				}),
			).rejects.toThrow(/overlap/);
		});

		it("should not partially apply edits when one edit fails", async () => {
			const testFile = join(testDir, "edit-no-partial.txt");
			const originalContent = "alpha\nbeta\ngamma\n";
			writeFileSync(testFile, originalContent);

			await expect(
				editTool.execute("test-call-13", {
					path: testFile,
					edits: [
						{ oldText: "alpha\n", newText: "ALPHA\n" },
						{ oldText: "missing\n", newText: "MISSING\n" },
					],
				}),
			).rejects.toThrow(/Could not find/);

			expect(readFileSync(testFile, "utf-8")).toBe(originalContent);
		});

		it("should include EACCES for read-only files", async () => {
			const testFile = join(testDir, "edit-readonly.txt");
			writeFileSync(testFile, "hello\n");
			chmodSync(testFile, 0o444);

			await expect(
				editTool.execute("test-call-14", {
					path: testFile,
					edits: [{ oldText: "hello", newText: "world" }],
				}),
			).rejects.toThrow(`Could not edit file: ${testFile}. Error code: EACCES.`);
		});

		it("should include the original error message for unknown edit access errors", async () => {
			const genericFailureTool = createEditTool(testDir, {
				operations: {
					access: async () => {
						throw new Error("disk offline");
					},
					readFile: async () => Buffer.from("hello\n", "utf-8"),
					writeFile: async () => {},
				},
			});

			await expect(
				genericFailureTool.execute("test-call-16", {
					path: "broken.txt",
					edits: [{ oldText: "hello", newText: "world" }],
				}),
			).rejects.toThrow("Could not edit file: broken.txt. Error: disk offline.");
		});
	});

	describe("bash tool", () => {
		it("should execute simple commands", async () => {
			const result = await bashTool.execute("test-call-8", { command: "echo 'test output'" });

			expect(getTextOutput(result)).toContain("test output");
			expect(result.details).toBeUndefined();
		});

		it("should handle command errors", async () => {
			await expect(bashTool.execute("test-call-9", { command: "exit 1" })).rejects.toThrow(
				/(Command failed|code 1)/,
			);
		});

		it("should map signal-killed commands to 128 plus the signal number", async () => {
			const operations = createLocalBashOperations();
			for (const { signal, exitCode } of [
				{ signal: "KILL", exitCode: 137 },
				{ signal: "TERM", exitCode: 143 },
			]) {
				const result = await operations.exec(`kill -${signal} $$`, testDir, { onData: () => {} });
				expect(result.exitCode).toBe(exitCode);
			}
		});

		it("should reject signal-killed commands while preserving partial output", async () => {
			for (const { signal, exitCode } of [
				{ signal: "KILL", exitCode: 137 },
				{ signal: "TERM", exitCode: 143 },
			]) {
				const execution = bashTool.execute(`test-call-signal-${signal}`, {
					command: `printf 'before-kill\\n'; kill -${signal} $$`,
				});
				await expect(execution).rejects.toThrow(new RegExp(`before-kill\\s+Command exited with code ${exitCode}$`));
			}
		});

		it("should reject a null exit code from custom operations", async () => {
			const operations: BashOperations = {
				exec: async (_command, _cwd, { onData }) => {
					onData(Buffer.from("partial\n", "utf-8"));
					return { exitCode: null };
				},
			};
			const bash = createBashTool(testDir, { operations });

			await expect(bash.execute("test-call-null-exit", { command: "remote" })).rejects.toThrow(
				/partial\s+Command terminated without an exit code$/,
			);
		});

		it("should respect timeout", async () => {
			const command = `${JSON.stringify(process.execPath)} -e ${JSON.stringify("setInterval(() => {}, 1000)")}`;
			await expect(bashTool.execute("test-call-10", { command, timeout: 0.05 })).rejects.toThrow(/timed out/i);
		});

		it("should include full output path for truncated timeout and abort errors", async () => {
			for (const testCase of [
				{ error: "timeout:5", expected: "Command timed out after 5 seconds" },
				{ error: "aborted", expected: "Command aborted" },
			]) {
				const operations: BashOperations = {
					exec: async (_command, _cwd, { onData }) => {
						for (let i = 1; i <= 3000; i++) {
							onData(Buffer.from(`${i}\n`, "utf-8"));
						}
						throw new Error(testCase.error);
					},
				};
				const bash = createBashTool(testDir, { operations });

				let error: unknown;
				try {
					await bash.execute(`test-call-${testCase.error}`, { command: "chatty-fail" });
				} catch (err) {
					error = err;
				}

				expect(error).toBeInstanceOf(Error);
				const message = (error as Error).message;
				expect(message).toContain(testCase.expected);
				expect(message).toMatch(/\[Showing lines \d+-\d+ of \d+\. Full output: /);
				expect(message).not.toContain("Full output: undefined");
				const fullOutputPath = message.match(/Full output: ([^\]\n]+)/)?.[1];
				expect(fullOutputPath).toBeDefined();
				expect(existsSync(fullOutputPath!)).toBe(true);
				const fullOutput = readFileSync(fullOutputPath!, "utf-8");
				expect(fullOutput).toContain("1\n2\n3");
				expect(fullOutput).toContain("2998\n2999\n3000");
			}
		});

		it("should throw error when cwd does not exist", async () => {
			const nonexistentCwd = "/this/directory/definitely/does/not/exist/12345";

			const bashToolWithBadCwd = createBashTool(nonexistentCwd);

			await expect(bashToolWithBadCwd.execute("test-call-11", { command: "echo test" })).rejects.toThrow(
				/Working directory does not exist/,
			);
		});

		it("should handle process spawn errors", async () => {
			vi.spyOn(shellModule, "getShellConfig").mockReturnValueOnce({
				shell: "/nonexistent-shell-path-xyz123",
				args: ["-c"],
			});

			const bashWithBadShell = createBashTool(testDir);

			await expect(bashWithBadShell.execute("test-call-12", { command: "echo test" })).rejects.toThrow(/ENOENT/);
		});

		it("should pass shellPath through to shell resolution", async () => {
			const getShellConfigSpy = vi.spyOn(shellModule, "getShellConfig");
			const bashWithCustomShell = createBashTool(testDir, {
				shellPath: "/custom/bash",
				operations: {
					exec: async () => ({ exitCode: 0 }),
				},
			});

			await bashWithCustomShell.execute("test-call-12b", { command: "echo test" });

			expect(getShellConfigSpy).not.toHaveBeenCalled();

			const ops = createLocalBashOperations({ shellPath: "/custom/bash" });
			await expect(
				ops.exec("echo test", testDir, {
					onData: () => {},
				}),
			).rejects.toThrow("Custom shell path not found: /custom/bash");
			expect(getShellConfigSpy).toHaveBeenCalledWith("/custom/bash");
		});

		it("should prepend command prefix when configured", async () => {
			const bashWithPrefix = createBashTool(testDir, {
				commandPrefix: "export TEST_VAR=hello",
			});

			const result = await bashWithPrefix.execute("test-prefix-1", { command: "echo $TEST_VAR" });
			expect(getTextOutput(result).trim()).toBe("hello");
		});

		it("should include output from both prefix and command", async () => {
			const bashWithPrefix = createBashTool(testDir, {
				commandPrefix: "echo prefix-output",
			});

			const result = await bashWithPrefix.execute("test-prefix-2", { command: "echo command-output" });
			expect(getTextOutput(result).trim()).toBe("prefix-output\ncommand-output");
		});

		it("should work without command prefix", async () => {
			const bashWithoutPrefix = createBashTool(testDir, {});

			const result = await bashWithoutPrefix.execute("test-prefix-3", { command: "echo no-prefix" });
			expect(getTextOutput(result).trim()).toBe("no-prefix");
		});

		it("should coalesce streaming updates for chatty output", async () => {
			const operations: BashOperations = {
				exec: async (_command, _cwd, { onData }) => {
					for (let i = 0; i < 5000; i++) {
						onData(Buffer.from(`line ${i}\n`, "utf-8"));
					}
					return { exitCode: 0 };
				},
			};
			const updates: Array<{ content: Array<{ type: string; text?: string }>; details?: unknown }> = [];
			const bash = createBashTool(testDir, { operations });

			const result = await bash.execute("test-call-chatty-updates", { command: "chatty" }, undefined, (update) =>
				updates.push(update),
			);

			expect(updates.length).toBeLessThan(25);
			expect(getTextOutput(result)).toContain("line 4999");
		});

		it("should not count a trailing newline as an extra truncated bash output line", async () => {
			const operations: BashOperations = {
				exec: async (_command, _cwd, { onData }) => {
					for (let i = 1; i <= 4000; i++) {
						onData(Buffer.from(`line-${String(i).padStart(4, "0")}\n`, "utf-8"));
					}
					return { exitCode: 0 };
				},
			};
			const bash = createBashTool(testDir, { operations });

			const result = await bash.execute("test-call-trailing-newline-line-count", { command: "many-lines" });
			const output = getTextOutput(result);

			expect(result.details?.truncation?.totalLines).toBe(4000);
			expect(result.details?.truncation?.outputLines).toBe(2000);
			expect(output).toContain("line-2001");
			expect(output).toContain("line-4000");
			expect(output).toMatch(/\[Showing lines 2001-4000 of 4000\. Full output: /);
			expect(output).not.toContain("4001");
		});

		it("should decode UTF-8 characters split across output chunks", async () => {
			const euro = Buffer.from("€\n", "utf-8");
			const operations: BashOperations = {
				exec: async (_command, _cwd, { onData }) => {
					onData(euro.subarray(0, 1));
					onData(euro.subarray(1));
					return { exitCode: 0 };
				},
			};
			const bash = createBashTool(testDir, { operations });

			const result = await bash.execute("test-call-split-utf8", { command: "split-utf8" });

			expect(getTextOutput(result).trim()).toBe("€");
		});

		it("should expose local bash operations for extension reuse", async () => {
			const ops = createLocalBashOperations();
			const chunks: Buffer[] = [];

			const result = await ops.exec("echo $TEST_LOCAL_BASH_OPS", testDir, {
				onData: (data) => chunks.push(data),
				env: { ...process.env, TEST_LOCAL_BASH_OPS: "from-local-ops" },
			});

			expect(result.exitCode).toBe(0);
			expect(Buffer.concat(chunks).toString("utf-8").trim()).toBe("from-local-ops");
		});

		it("should preserve executeBash sanitization when using local bash operations", async () => {
			const result = await executeBashWithOperations(
				"printf '\\033[31mred\\033[0m\\r\\n'",
				process.cwd(),
				createLocalBashOperations(),
			);

			expect(result.exitCode).toBe(0);
			expect(result.output).toBe("red\n");
		});

		it("should persist full output when truncation happens by line count only", async () => {
			const bash = createBashTool(testDir);
			const result = await bash.execute("test-call-line-truncation", { command: "seq 3000" });
			const output = getTextOutput(result);
			const fullOutputPath = result.details?.fullOutputPath;

			expect(result.details?.truncation?.truncated).toBe(true);
			expect(result.details?.truncation?.truncatedBy).toBe("lines");
			expect(fullOutputPath).toBeDefined();
			expect(output).toMatch(/\[Showing lines \d+-\d+ of \d+\. Full output: /);
			expect(output).not.toContain("Full output: undefined");

			for (let i = 0; i < 20 && (!fullOutputPath || !existsSync(fullOutputPath)); i++) {
				await new Promise((resolve) => setTimeout(resolve, 10));
			}

			expect(fullOutputPath).toBeDefined();
			expect(existsSync(fullOutputPath!)).toBe(true);
			const fullOutput = readFileSync(fullOutputPath!, "utf-8");
			expect(fullOutput).toContain("1\n2\n3");
			expect(fullOutput).toContain("2998\n2999\n3000");
		});

		it("executeBash should persist full output when truncation happens by line count only", async () => {
			const result = await executeBashWithOperations("seq 3000", process.cwd(), createLocalBashOperations());
			const fullOutputPath = result.fullOutputPath;

			expect(result.truncated).toBe(true);
			expect(fullOutputPath).toBeDefined();

			for (let i = 0; i < 20 && (!fullOutputPath || !existsSync(fullOutputPath)); i++) {
				await new Promise((resolve) => setTimeout(resolve, 10));
			}

			expect(fullOutputPath).toBeDefined();
			expect(existsSync(fullOutputPath!)).toBe(true);
			const fullOutput = readFileSync(fullOutputPath!, "utf-8");
			expect(fullOutput).toContain("1\n2\n3");
			expect(fullOutput).toContain("2998\n2999\n3000");
		});
	});
});

function fakeCtx(cwd: string): ExtensionContext {
	return { cwd } as ExtensionContext;
}

describe("tool cwd resolution", () => {
	let testDir: string;

	beforeEach(() => {
		testDir = join(tmpdir(), `coding-agent-cwd-test-${Date.now()}`);
		mkdirSync(testDir, { recursive: true });
	});

	afterEach(() => {
		rmSync(testDir, { recursive: true, force: true });
	});

	it("read uses ctx.cwd when provided", async () => {
		const testFile = join(testDir, "ctx-cwd-read.txt");
		writeFileSync(testFile, "hello from ctx.cwd");
		const tool = createReadToolDefinition("/");
		const result = await tool.execute(
			"test-read-ctx-cwd",
			{ path: "ctx-cwd-read.txt" },
			undefined,
			undefined,
			fakeCtx(testDir),
		);
		const output = getTextOutput(result);
		expect(output).toContain("hello from ctx.cwd");
	});

	it("write uses ctx.cwd when provided", async () => {
		const tool = createWriteToolDefinition("/");
		await tool.execute(
			"test-write-ctx-cwd",
			{ path: "ctx-cwd-write.txt", content: "written via ctx.cwd" },
			undefined,
			undefined,
			fakeCtx(testDir),
		);
		const content = readFileSync(join(testDir, "ctx-cwd-write.txt"), "utf-8");
		expect(content).toBe("written via ctx.cwd");
	});

	it("edit uses ctx.cwd when provided", async () => {
		const testFile = join(testDir, "ctx-cwd-edit.txt");
		writeFileSync(testFile, "old text");
		const tool = createEditToolDefinition("/");
		await tool.execute(
			"test-edit-ctx-cwd",
			{ path: "ctx-cwd-edit.txt", edits: [{ oldText: "old text", newText: "new text" }] },
			undefined,
			undefined,
			fakeCtx(testDir),
		);
		const content = readFileSync(testFile, "utf-8");
		expect(content).toBe("new text");
	});

	it("bash uses ctx.cwd when provided", async () => {
		const tool = createBashToolDefinition("/", { exposeSessionEnvironment: false });
		const result = await tool.execute(
			"test-bash-ctx-cwd",
			{ command: "pwd" },
			undefined,
			undefined,
			fakeCtx(testDir),
		);
		const output = getTextOutput(result);
		expect(output).toContain(testDir);
	});
});

describe("edit tool fuzzy matching", () => {
	let testDir: string;

	beforeEach(() => {
		testDir = join(tmpdir(), `coding-agent-fuzzy-test-${Date.now()}`);
		mkdirSync(testDir, { recursive: true });
	});

	afterEach(() => {
		rmSync(testDir, { recursive: true, force: true });
	});

	it("should match text with trailing whitespace stripped", async () => {
		const testFile = join(testDir, "trailing-ws.txt");
		writeFileSync(testFile, "line one   \nline two  \nline three\n");

		const result = await editTool.execute("test-fuzzy-1", {
			path: testFile,
			edits: [{ oldText: "line one\nline two\n", newText: "replaced\n" }],
		});

		expect(getTextOutput(result)).toContain("Successfully replaced");
		const content = readFileSync(testFile, "utf-8");
		expect(content).toBe("replaced\nline three\n");
	});

	it("should match fullwidth punctuation in Chinese text", async () => {
		const testFile = join(testDir, "chinese-punctuation.txt");
		writeFileSync(testFile, "你好，世界\n你好（世界）\n");

		const result = await editTool.execute("test-fuzzy-chinese", {
			path: testFile,
			edits: [{ oldText: "你好,世界\n你好(世界)\n", newText: "你好，pi\n你好(pi)\n" }],
		});

		expect(getTextOutput(result)).toContain("Successfully replaced");
		const content = readFileSync(testFile, "utf-8");
		expect(content).toBe("你好，pi\n你好(pi)\n");
	});

	it("should match compatibility-equivalent Unicode forms", async () => {
		const testFile = join(testDir, "unicode-compatibility.txt");
		writeFileSync(testFile, "ＡＢＣ１２３\ncafe\u0301\n");

		const result = await editTool.execute("test-fuzzy-unicode", {
			path: testFile,
			edits: [{ oldText: "ABC123\ncafé\n", newText: "XYZ789\ncoffee\n" }],
		});

		expect(getTextOutput(result)).toContain("Successfully replaced");
		const content = readFileSync(testFile, "utf-8");
		expect(content).toBe("XYZ789\ncoffee\n");
	});

	it("should match smart single quotes to ASCII quotes", async () => {
		const testFile = join(testDir, "smart-quotes.txt");
		writeFileSync(testFile, "console.log(\u2018hello\u2019);\n");

		const result = await editTool.execute("test-fuzzy-2", {
			path: testFile,
			edits: [{ oldText: "console.log('hello');", newText: "console.log('world');" }],
		});

		expect(getTextOutput(result)).toContain("Successfully replaced");
		const content = readFileSync(testFile, "utf-8");
		expect(content).toContain("world");
	});

	it("should match smart double quotes to ASCII quotes", async () => {
		const testFile = join(testDir, "smart-double-quotes.txt");
		writeFileSync(testFile, "const msg = \u201CHello World\u201D;\n");

		const result = await editTool.execute("test-fuzzy-3", {
			path: testFile,
			edits: [{ oldText: 'const msg = "Hello World";', newText: 'const msg = "Goodbye";' }],
		});

		expect(getTextOutput(result)).toContain("Successfully replaced");
		const content = readFileSync(testFile, "utf-8");
		expect(content).toContain("Goodbye");
	});

	it("should match Unicode dashes to ASCII hyphen", async () => {
		const testFile = join(testDir, "unicode-dashes.txt");
		writeFileSync(testFile, "range: 1\u20135\nbreak\u2014here\n");

		const result = await editTool.execute("test-fuzzy-4", {
			path: testFile,
			edits: [{ oldText: "range: 1-5\nbreak-here", newText: "range: 10-50\nbreak--here" }],
		});

		expect(getTextOutput(result)).toContain("Successfully replaced");
		const content = readFileSync(testFile, "utf-8");
		expect(content).toContain("10-50");
	});

	it("should match non-breaking space to regular space", async () => {
		const testFile = join(testDir, "nbsp.txt");
		writeFileSync(testFile, "hello\u00A0world\n");

		const result = await editTool.execute("test-fuzzy-5", {
			path: testFile,
			edits: [{ oldText: "hello world", newText: "hello universe" }],
		});

		expect(getTextOutput(result)).toContain("Successfully replaced");
		const content = readFileSync(testFile, "utf-8");
		expect(content).toContain("universe");
	});

	it("should prefer exact match over fuzzy match", async () => {
		const testFile = join(testDir, "exact-preferred.txt");
		writeFileSync(testFile, "const x = 'exact';\nconst y = 'other';\n");

		const result = await editTool.execute("test-fuzzy-6", {
			path: testFile,
			edits: [{ oldText: "const x = 'exact';", newText: "const x = 'changed';" }],
		});

		expect(getTextOutput(result)).toContain("Successfully replaced");
		const content = readFileSync(testFile, "utf-8");
		expect(content).toBe("const x = 'changed';\nconst y = 'other';\n");
	});

	it("should still fail when text is not found even with fuzzy matching", async () => {
		const testFile = join(testDir, "no-match.txt");
		writeFileSync(testFile, "completely different content\n");

		await expect(
			editTool.execute("test-fuzzy-7", {
				path: testFile,
				edits: [{ oldText: "this does not exist", newText: "replacement" }],
			}),
		).rejects.toThrow(/Could not find the exact text/);
	});

	it("should detect duplicates after fuzzy normalization", async () => {
		const testFile = join(testDir, "fuzzy-dups.txt");
		writeFileSync(testFile, "hello world   \nhello world\n");

		await expect(
			editTool.execute("test-fuzzy-8", {
				path: testFile,
				edits: [{ oldText: "hello world", newText: "replaced" }],
			}),
		).rejects.toThrow(/Found 2 occurrences/);
	});

	it("should support fuzzy matching in multi-edit mode", async () => {
		const testFile = join(testDir, "fuzzy-multi.txt");
		writeFileSync(testFile, "console.log(\u2018hello\u2019);\nhello\u00A0world\n");

		await editTool.execute("test-fuzzy-9", {
			path: testFile,
			edits: [
				{ oldText: "console.log('hello');\n", newText: "console.log('world');\n" },
				{ oldText: "hello world\n", newText: "hello universe\n" },
			],
		});

		expect(readFileSync(testFile, "utf-8")).toBe("console.log('world');\nhello universe\n");
	});

	it("should preserve the correct occurrence when fuzzy replacement equals a nearby line", async () => {
		const testFile = join(testDir, "fuzzy-preserve-duplicate-line.txt");
		const originalContent = ["replace me\u0020\u0020\u0020", "after\u0020\u0020\u0020", ""].join("\n");
		writeFileSync(testFile, originalContent);

		await editTool.execute("test-fuzzy-preserve-duplicate-line", {
			path: testFile,
			edits: [{ oldText: "replace me\n", newText: "after\n" }],
		});

		const expectedContent = ["after", "after\u0020\u0020\u0020", ""].join("\n");
		expect(readFileSync(testFile, "utf-8")).toBe(expectedContent);
	});

	it("should preserve untouched lines for fuzzy multi-edits", async () => {
		const testFile = join(testDir, "fuzzy-preserve-multi.txt");
		const originalContent = [
			"keep before\u0020\u0020",
			"first target\u0020\u0020",
			"first after",
			"keep middle\u0020\u0020\u0020",
			"second target\u0020\u0020",
			"second after",
			"keep after\u0020\u0020",
			"",
		].join("\n");
		writeFileSync(testFile, originalContent);

		await editTool.execute("test-fuzzy-preserve-multi", {
			path: testFile,
			edits: [
				{ oldText: "first target\nfirst after", newText: "FIRST\nFIRST2" },
				{ oldText: "second target\nsecond after", newText: "SECOND\nSECOND2" },
			],
		});

		const expectedContent = [
			"keep before\u0020\u0020",
			"FIRST",
			"FIRST2",
			"keep middle\u0020\u0020\u0020",
			"SECOND",
			"SECOND2",
			"keep after\u0020\u0020",
			"",
		].join("\n");
		expect(readFileSync(testFile, "utf-8")).toBe(expectedContent);
	});
});

describe("edit tool CRLF handling", () => {
	let testDir: string;

	beforeEach(() => {
		testDir = join(tmpdir(), `coding-agent-crlf-test-${Date.now()}`);
		mkdirSync(testDir, { recursive: true });
	});

	afterEach(() => {
		rmSync(testDir, { recursive: true, force: true });
	});

	it("should match LF oldText against CRLF file content", async () => {
		const testFile = join(testDir, "crlf-test.txt");

		writeFileSync(testFile, "line one\r\nline two\r\nline three\r\n");

		const result = await editTool.execute("test-crlf-1", {
			path: testFile,
			edits: [{ oldText: "line two\n", newText: "replaced line\n" }],
		});

		expect(getTextOutput(result)).toContain("Successfully replaced");
	});

	it("should preserve CRLF line endings after edit", async () => {
		const testFile = join(testDir, "crlf-preserve.txt");
		writeFileSync(testFile, "first\r\nsecond\r\nthird\r\n");

		await editTool.execute("test-crlf-2", {
			path: testFile,
			edits: [{ oldText: "second\n", newText: "REPLACED\n" }],
		});

		const content = readFileSync(testFile, "utf-8");
		expect(content).toBe("first\r\nREPLACED\r\nthird\r\n");
	});

	it("should preserve LF line endings for LF files", async () => {
		const testFile = join(testDir, "lf-preserve.txt");
		writeFileSync(testFile, "first\nsecond\nthird\n");

		await editTool.execute("test-lf-1", {
			path: testFile,
			edits: [{ oldText: "second\n", newText: "REPLACED\n" }],
		});

		const content = readFileSync(testFile, "utf-8");
		expect(content).toBe("first\nREPLACED\nthird\n");
	});

	it("should detect duplicates across CRLF/LF variants", async () => {
		const testFile = join(testDir, "mixed-endings.txt");

		writeFileSync(testFile, "hello\r\nworld\r\n---\r\nhello\nworld\n");

		await expect(
			editTool.execute("test-crlf-dup", {
				path: testFile,
				edits: [{ oldText: "hello\nworld\n", newText: "replaced\n" }],
			}),
		).rejects.toThrow(/Found 2 occurrences/);
	});

	it("should preserve UTF-8 BOM after edit", async () => {
		const testFile = join(testDir, "bom-test.txt");
		writeFileSync(testFile, "\uFEFFfirst\r\nsecond\r\nthird\r\n");

		await editTool.execute("test-bom", {
			path: testFile,
			edits: [{ oldText: "second\n", newText: "REPLACED\n" }],
		});

		const content = readFileSync(testFile, "utf-8");
		expect(content).toBe("\uFEFFfirst\r\nREPLACED\r\nthird\r\n");
	});

	it("should preserve CRLF line endings and BOM in multi-edit mode", async () => {
		const testFile = join(testDir, "bom-crlf-multi.txt");
		writeFileSync(testFile, "\uFEFFfirst\r\nsecond\r\nthird\r\nfourth\r\n");

		await editTool.execute("test-crlf-multi", {
			path: testFile,
			edits: [
				{ oldText: "second\n", newText: "SECOND\n" },
				{ oldText: "fourth\n", newText: "FOURTH\n" },
			],
		});

		const content = readFileSync(testFile, "utf-8");
		expect(content).toBe("\uFEFFfirst\r\nSECOND\r\nthird\r\nFOURTH\r\n");
	});
});
