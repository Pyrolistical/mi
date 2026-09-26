import assert from "node:assert";
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, beforeEach, describe, it, test } from "node:test";
import { CombinedAutocompleteProvider } from "../src/autocomplete.ts";

type FolderStructure = {
	dirs?: string[];
	files?: Record<string, string>;
};

const setupFolder = (baseDir: string, structure: FolderStructure = {}): void => {
	const dirs = structure.dirs ?? [];
	const files = structure.files ?? {};

	dirs.forEach((dir) => {
		mkdirSync(join(baseDir, dir), { recursive: true });
	});
	Object.entries(files).forEach(([filePath, contents]) => {
		const fullPath = join(baseDir, filePath);
		mkdirSync(dirname(fullPath), { recursive: true });
		writeFileSync(fullPath, contents);
	});
};

const getSuggestions = (
	provider: CombinedAutocompleteProvider,
	lines: string[],
	cursorLine: number,
	cursorCol: number,
	force: boolean = false,
) => provider.getSuggestions(lines, cursorLine, cursorCol, { signal: new AbortController().signal, force });

describe("CombinedAutocompleteProvider", () => {
	describe("extractPathPrefix", () => {
		it("extracts / from 'hey /' when forced", async () => {
			const provider = new CombinedAutocompleteProvider([], "/tmp");
			const lines = ["hey /"];
			const cursorLine = 0;
			const cursorCol = 5;

			const result = await getSuggestions(provider, lines, cursorLine, cursorCol, true);

			assert.notEqual(result, null, "Should return suggestions for root directory");
			if (result) {
				assert.strictEqual(result.prefix, "/", "Prefix should be '/'");
			}
		});

		it("extracts /A from '/A' when forced", async () => {
			const provider = new CombinedAutocompleteProvider([], "/tmp");
			const lines = ["/A"];
			const cursorLine = 0;
			const cursorCol = 2;

			const result = await getSuggestions(provider, lines, cursorLine, cursorCol, true);

			console.log("Result:", result);
			if (result) {
				assert.strictEqual(result.prefix, "/A", "Prefix should be '/A'");
			}
		});

		it("does not trigger for slash commands", async () => {
			const provider = new CombinedAutocompleteProvider([], "/tmp");
			const lines = ["/model"];
			const cursorLine = 0;
			const cursorCol = 6;

			const result = await getSuggestions(provider, lines, cursorLine, cursorCol, true);

			console.log("Result:", result);
			assert.strictEqual(result, null, "Should not trigger for slash commands");
		});

		it("triggers for absolute paths after slash command argument", async () => {
			const provider = new CombinedAutocompleteProvider([], "/tmp");
			const lines = ["/command /"];
			const cursorLine = 0;
			const cursorCol = 10;

			const result = await getSuggestions(provider, lines, cursorLine, cursorCol, true);

			console.log("Result:", result);
			assert.notEqual(result, null, "Should trigger for absolute paths in command arguments");
			if (result) {
				assert.strictEqual(result.prefix, "/", "Prefix should be '/'");
			}
		});
	});

	describe("@ file suggestions", () => {
		let rootDir = "";
		let baseDir = "";
		let outsideDir = "";

		beforeEach(() => {
			rootDir = mkdtempSync(join(tmpdir(), "pi-autocomplete-root-"));
			baseDir = join(rootDir, "cwd");
			outsideDir = join(rootDir, "outside");
			mkdirSync(baseDir, { recursive: true });
			mkdirSync(outsideDir, { recursive: true });
		});

		afterEach(() => {
			rmSync(rootDir, { recursive: true, force: true });
		});

		test("returns all files and folders for empty @ query", async () => {
			setupFolder(baseDir, {
				dirs: ["src"],
				files: {
					"README.md": "readme",
				},
			});

			const provider = new CombinedAutocompleteProvider([], baseDir);
			const line = "@";
			const result = await getSuggestions(provider, [line], 0, line.length);

			const values = result?.items.map((item) => item.value).sort();
			assert.deepStrictEqual(values, ["@README.md", "@src/"].sort());
		});

		test("recognizes @ after CJK punctuation without consuming the preceding text", async () => {
			setupFolder(baseDir, { files: { "README.md": "readme" } });
			const provider = new CombinedAutocompleteProvider([], baseDir);
			for (const before of ["查看，", "\u3000", ..."，．：；！？（）［］｛｝“”‘’…—。、「」『』《》【】"]) {
				for (const force of [false, true]) {
					const line = `${before}@REA`;
					const result = await getSuggestions(provider, [line], 0, line.length, force);
					assert.ok(result, line);
					assert.strictEqual(result.prefix, "@REA");
					assert.deepStrictEqual(
						result.items.map((item) => item.value),
						["@README.md"],
					);
					const applied = provider.applyCompletion([line], 0, line.length, result.items[0]!, result.prefix);
					assert.strictEqual(applied.lines[0], `${before}./README.md `);
					assert.strictEqual(applied.cursorCol, applied.lines[0]!.length);
				}
			}
		});

		test("recognizes @ after opening wrappers like ( and backticks", async () => {
			setupFolder(baseDir, { files: { "README.md": "readme" } });
			const provider = new CombinedAutocompleteProvider([], baseDir);
			for (const before of ["(", "see (", "[", "`", "<", "{"]) {
				const line = `${before}@REA`;
				const result = await getSuggestions(provider, [line], 0, line.length);
				assert.ok(result, line);
				assert.strictEqual(result.prefix, "@REA");
				const applied = provider.applyCompletion([line], 0, line.length, result.items[0]!, result.prefix);
				assert.strictEqual(applied.lines[0], `${before}./README.md `);
			}
			const embedded = "foo(@REA";
			assert.strictEqual(await getSuggestions(provider, [embedded], 0, embedded.length), null);
		});

		test("preserves CJK characters and embedded @ in attachment paths", async () => {
			setupFolder(baseDir, {
				files: { "文档/说明.md": "text", "文档@备份/说明.md": "backup" },
			});
			const provider = new CombinedAutocompleteProvider([], baseDir);
			for (const before of ["", "查看，"]) {
				for (const directory of ["文档", "文档@备份"]) {
					const prefix = `@${directory}/说`;
					const line = before + prefix;
					const result = await getSuggestions(provider, [line], 0, line.length);
					assert.ok(result, line);
					assert.strictEqual(result.prefix, prefix);
					assert.deepStrictEqual(
						result.items.map((item) => item.value),
						[`@${directory}/说明.md`],
					);
				}
			}
		});

		test("completes quoted CJK attachments after prose without losing path segments or quotes", async () => {
			const provider = new CombinedAutocompleteProvider([], baseDir);
			for (const separator of [" ", "\u3000", "，", "。"]) {
				const directory = `我的${separator}文档`;
				setupFolder(baseDir, {
					files: { [`${directory}/说明.md`]: "text", "文档/说明.md": "not the quoted path" },
				});
				const line = `查看：@"${directory}/说"后文`;
				const cursorCol = line.indexOf('"后文');
				const result = await getSuggestions(provider, [line], 0, cursorCol);
				assert.ok(result);
				assert.strictEqual(result.prefix, `@"${directory}/说`);
				assert.deepStrictEqual(
					result.items.map((item) => item.value),
					[`@"${directory}/说明.md"`],
				);
				const applied = provider.applyCompletion([line], 0, cursorCol, result.items[0]!, result.prefix);
				assert.strictEqual(applied.lines[0], `查看："./${directory}/说明.md"后文`);
				assert.strictEqual(applied.cursorCol, `查看："./${directory}/说明.md"`.length);
			}
		});

		test("does not interpret email addresses or @ after ASCII or CJK letters as attachment prefixes", async () => {
			setupFolder(baseDir, { files: { "README.md": "readme", "example.com": "text" } });
			const provider = new CombinedAutocompleteProvider([], baseDir);
			for (const before of ["user", "查看", "あ", "カ", "한", "ㄅ", "𠮷", "か\u3099", "禰\u{e0100}", "々", "Ａ"]) {
				for (const name of ["REA", "example.com"]) {
					const line = `${before}@${name}`;
					assert.strictEqual(await getSuggestions(provider, [line], 0, line.length), null, line);
				}
			}
		});

		test("lists only the direct entries of the directory in the prefix", async () => {
			setupFolder(baseDir, {
				dirs: ["src/lib"],
				files: {
					"src/index.ts": "export {};",
					"src/lib/util.ts": "export {};",
				},
			});

			const provider = new CombinedAutocompleteProvider([], baseDir);
			const line = "@src/";
			const result = await getSuggestions(provider, [line], 0, line.length);

			assert.deepStrictEqual(
				result?.items.map((item) => item.value),
				["@src/index.ts", "@src/lib/"],
			);
		});

		test("completes the last path segment by prefix", async () => {
			setupFolder(baseDir, {
				files: {
					"src/index.ts": "export {};",
					"src/main.ts": "export {};",
				},
			});

			const provider = new CombinedAutocompleteProvider([], baseDir);
			const line = "@src/in";
			const result = await getSuggestions(provider, [line], 0, line.length);

			assert.deepStrictEqual(
				result?.items.map((item) => item.value),
				["@src/index.ts"],
			);
		});

		test("completes relative paths outside the cwd", async () => {
			setupFolder(outsideDir, {
				files: {
					"alpha.ts": "export {};",
					"beta.ts": "export {};",
				},
			});

			const provider = new CombinedAutocompleteProvider([], baseDir);
			const line = "@../outside/a";
			const result = await getSuggestions(provider, [line], 0, line.length);

			assert.deepStrictEqual(
				result?.items.map((item) => item.value),
				["@../outside/alpha.ts"],
			);
		});

		test("lists hidden and dot entries", async () => {
			setupFolder(baseDir, {
				dirs: [".github"],
				files: {
					".env": "KEY=value",
				},
			});

			const provider = new CombinedAutocompleteProvider([], baseDir);
			const line = "@.";
			const result = await getSuggestions(provider, [line], 0, line.length);

			assert.deepStrictEqual(
				result?.items.map((item) => item.value),
				["@./", "@../", "@.env", "@.github/"],
			);
		});

		test("matches file with extension in query", async () => {
			setupFolder(baseDir, {
				files: {
					"file.txt": "content",
				},
			});

			const provider = new CombinedAutocompleteProvider([], baseDir);
			const line = "@file.txt";
			const result = await getSuggestions(provider, [line], 0, line.length);

			const values = result?.items.map((item) => item.value);
			assert.ok(values?.includes("@file.txt"));
		});

		test("filters are case sensitive", async () => {
			setupFolder(baseDir, {
				files: {
					"README.md": "readme",
					"readme.txt": "readme",
				},
			});

			const provider = new CombinedAutocompleteProvider([], baseDir);
			const line = "@re";
			const result = await getSuggestions(provider, [line], 0, line.length);

			const values = result?.items.map((item) => item.value);
			assert.deepStrictEqual(values, ["@readme.txt"]);
		});

		test("sorts directories and files together by name", async () => {
			setupFolder(baseDir, {
				dirs: ["b"],
				files: {
					"a.txt": "text",
					"c.txt": "text",
				},
			});

			const provider = new CombinedAutocompleteProvider([], baseDir);
			const line = "@";
			const result = await getSuggestions(provider, [line], 0, line.length);

			assert.deepStrictEqual(
				result?.items.map((item) => item.value),
				["@a.txt", "@b/", "@c.txt"],
			);
		});

		test("sorts ignoring punctuation with uppercase first", async () => {
			setupFolder(baseDir, {
				dirs: ["linkdir-target", "linkdir", "Src", "src"],
				files: {
					".env": "KEY=value",
					broken: "text",
				},
			});

			const provider = new CombinedAutocompleteProvider([], baseDir);
			const line = "@";
			const result = await getSuggestions(provider, [line], 0, line.length);

			assert.deepStrictEqual(
				result?.items.map((item) => item.value),
				["@broken", "@.env", "@linkdir/", "@linkdir-target/", "@Src/", "@src/"],
			);
		});

		test("lists dot entries inside a directory", async () => {
			setupFolder(baseDir, { dirs: ["src"] });

			const provider = new CombinedAutocompleteProvider([], baseDir);
			const line = "@src/..";
			const result = await getSuggestions(provider, [line], 0, line.length);

			assert.deepStrictEqual(
				result?.items.map((item) => item.value),
				["@src/../"],
			);
		});

		test("common prefix stops where the matches differ", async () => {
			setupFolder(baseDir, {
				files: {
					"with space.txt": "text",
					"with.txt": "text",
				},
			});

			const provider = new CombinedAutocompleteProvider([], baseDir);
			const line = "@w";
			const result = await getSuggestions(provider, [line], 0, line.length);

			assert.strictEqual(result?.commonPrefix, "@with");
		});

		test("common prefix opens a quote when it contains whitespace", async () => {
			setupFolder(baseDir, {
				files: {
					"with space.txt": "text",
					"with spice.txt": "text",
				},
			});

			const provider = new CombinedAutocompleteProvider([], baseDir);
			const line = "@w";
			const result = await getSuggestions(provider, [line], 0, line.length);

			assert.strictEqual(result?.commonPrefix, '@"with sp');
		});

		test("adds no space when text follows the cursor", async () => {
			setupFolder(baseDir, { files: { "src.txt": "text" } });

			const provider = new CombinedAutocompleteProvider([], baseDir);
			const line = "look at @src.t now";
			const cursorCol = "look at @src.t".length;
			const result = await getSuggestions(provider, [line], 0, cursorCol);
			assert.ok(result);
			const applied = provider.applyCompletion([line], 0, cursorCol, result.items[0]!, result.prefix);

			assert.strictEqual(applied.lines[0], "look at ./src.txt now");
			assert.strictEqual(applied.cursorCol, "look at ./src.txt".length);
		});

		test("quotes paths containing whitespace or CJK punctuation for @ suggestions", async () => {
			const provider = new CombinedAutocompleteProvider([], baseDir);
			for (const separator of [" ", "\u3000", "，", "。"]) {
				const directory = `my${separator}folder`;
				setupFolder(baseDir, { files: { [`${directory}/test.txt`]: "content" } });
				const line = "@my";
				const result = await getSuggestions(provider, [line], 0, line.length);
				assert.ok(result);
				const item = result.items.find((entry) => entry.value === `@"${directory}/"`);
				assert.ok(item, directory);
				const applied = provider.applyCompletion([line], 0, line.length, item, result.prefix);
				const continued = await getSuggestions(provider, applied.lines, 0, applied.cursorCol);
				assert.strictEqual(continued?.prefix, `@"${directory}/`);
				assert.ok(continued?.items.some((entry) => entry.value === `@"${directory}/test.txt"`));
			}
		});

		test("returns symlinked directories when matching their name", async () => {
			setupFolder(outsideDir, {
				files: {
					"nested/file.txt": "symlinked",
				},
			});
			symlinkSync("../outside", join(baseDir, "symlinked_dir"));

			const provider = new CombinedAutocompleteProvider([], baseDir);
			const line = "@symlinked";
			const result = await getSuggestions(provider, [line], 0, line.length);

			const values = result?.items.map((item) => item.value) ?? [];
			assert.ok(values.includes("@symlinked_dir/"));
		});

		test("returns symlinked files without requiring type l", async () => {
			setupFolder(baseDir, {
				files: {
					"original.txt": "content",
				},
			});
			const linkPath = join(baseDir, "link.txt");
			symlinkSync("original.txt", linkPath);

			const provider = new CombinedAutocompleteProvider([], baseDir);
			const line = "@link";
			const result = await getSuggestions(provider, [line], 0, line.length);

			const values = result?.items.map((item) => item.value) ?? [];
			assert.ok(values.includes("@link.txt"));
		});

		test("continues autocomplete inside quoted @ paths", async () => {
			setupFolder(baseDir, {
				files: {
					"my folder/test.txt": "content",
					"my folder/other.txt": "content",
				},
			});

			const provider = new CombinedAutocompleteProvider([], baseDir);
			const line = '@"my folder/"';
			const result = await getSuggestions(provider, [line], 0, line.length - 1);

			assert.notEqual(result, null, "Should return suggestions for quoted folder path");
			const values = result?.items.map((item) => item.value);
			assert.ok(values?.includes('@"my folder/test.txt"'));
			assert.ok(values?.includes('@"my folder/other.txt"'));
		});

		test("applies quoted @ completion without duplicating closing quote", async () => {
			setupFolder(baseDir, {
				files: {
					"my folder/test.txt": "content",
				},
			});

			const provider = new CombinedAutocompleteProvider([], baseDir);
			const line = '@"my folder/te"';
			const cursorCol = line.length - 1;
			const result = await getSuggestions(provider, [line], 0, cursorCol);

			assert.notEqual(result, null, "Should return suggestions for quoted @ path");
			const item = result?.items.find((entry) => entry.value === '@"my folder/test.txt"');
			assert.ok(item, "Should find test.txt suggestion");

			const applied = provider.applyCompletion([line], 0, cursorCol, item!, result!.prefix);
			assert.strictEqual(applied.lines[0], '"./my folder/test.txt" ');
		});
	});

	describe("dot-slash path completion", () => {
		let baseDir = "";

		beforeEach(() => {
			baseDir = mkdtempSync(join(tmpdir(), "pi-autocomplete-"));
		});

		afterEach(() => {
			rmSync(baseDir, { recursive: true, force: true });
		});

		test("completes Chinese path prefixes after whitespace or CJK punctuation on Tab", async () => {
			setupFolder(baseDir, { files: { "说明.md": "file", "文档/说明.md": "nested file" } });
			const provider = new CombinedAutocompleteProvider([], baseDir);
			const completions = [
				{ prefix: "说", value: "说明.md" },
				{ prefix: "文", value: "文档/" },
				{ prefix: "文档/说", value: "文档/说明.md" },
				{ prefix: "./文档/说", value: "./文档/说明.md" },
				{ prefix: `${baseDir}/文档/说`, value: `${baseDir}/文档/说明.md` },
			];
			for (const separator of " \t\u3000\u00a0，：；。！？（「《") {
				for (const { prefix, value } of completions) {
					const before = `查看𠮷${separator}`;
					const line = `${before}${prefix} 后文`;
					const cursorCol = before.length + prefix.length;
					const result = await getSuggestions(provider, [line], 0, cursorCol, true);
					assert.ok(result, line);
					assert.strictEqual(result.prefix, prefix);
					assert.deepStrictEqual(
						result.items.map((item) => item.value),
						[value],
					);
					const applied = provider.applyCompletion([line], 0, cursorCol, result.items[0]!, result.prefix);
					assert.strictEqual(applied.lines[0], `${before}${value} 后文`);
					assert.strictEqual(applied.cursorCol, before.length + value.length);
				}
			}
		});

		test("treats unquoted separators as boundaries even when a matching literal path exists", async () => {
			setupFolder(baseDir, { files: { "归档/说明.md": "other" } });
			const provider = new CombinedAutocompleteProvider([], baseDir);
			for (const separator of [" ", "\u3000", "，", "。"]) {
				const directory = `资料${separator}归档`;
				setupFolder(baseDir, { files: { [`${directory}/说明.md`]: "archive" } });
				for (const marker of ["", "@"]) {
					const line = `${marker}${directory}/说`;
					const result = await getSuggestions(provider, [line], 0, line.length, true);
					assert.ok(result, line);
					assert.strictEqual(result.prefix, "归档/说");
					assert.deepStrictEqual(
						result.items.map((item) => item.value),
						["归档/说明.md"],
					);
				}
				const quoted = `查看，"${directory}/说"后文`;
				const cursorCol = quoted.indexOf('"后文');
				const result = await getSuggestions(provider, [quoted], 0, cursorCol, true);
				assert.ok(result);
				assert.strictEqual(result.prefix, `"${directory}/说`);
				assert.deepStrictEqual(
					result.items.map((item) => item.value),
					[`"${directory}/说明.md"`],
				);
				const applied = provider.applyCompletion([quoted], 0, cursorCol, result.items[0]!, result.prefix);
				assert.strictEqual(applied.lines[0], `查看，"${directory}/说明.md"后文`);
				const missing = `查看，"不存在${separator}归档/说`;
				assert.strictEqual(await getSuggestions(provider, [missing], 0, missing.length, true), null);
			}
		});

		test("handles an empty prefix after whitespace or CJK punctuation consistently", async () => {
			setupFolder(baseDir, { files: { "说明.md": "text" } });
			const provider = new CombinedAutocompleteProvider([], baseDir);
			for (const separator of [" ", "\t", "\u3000", "，", "。"]) {
				for (const force of [false, true]) {
					const line = `查看${separator}`;
					const result = await getSuggestions(provider, [line], 0, line.length, force);
					assert.ok(result, line);
					assert.strictEqual(result.prefix, "");
					assert.deepStrictEqual(
						result.items.map((item) => item.value),
						["说明.md"],
					);
				}
			}
			assert.strictEqual(await getSuggestions(provider, [""], 0, 0), null);
		});

		test("completes paths after opening wrappers like ( [ { < and backticks", async () => {
			setupFolder(baseDir, { files: { "src/main.ts": "x" } });
			const provider = new CombinedAutocompleteProvider([], baseDir);
			for (const wrapper of ["(", "[", "{", "<", "`", "((", "(`"]) {
				for (const prefix of ["src/ma", "./src/ma"]) {
					const before = `see ${wrapper}`;
					const line = `${before}${prefix}`;
					const result = await getSuggestions(provider, [line], 0, line.length, true);
					assert.ok(result, line);
					assert.strictEqual(result.prefix, prefix);
					const value = prefix.replace("src/ma", "src/main.ts");
					assert.deepStrictEqual(
						result.items.map((item) => item.value),
						[value],
					);
					const applied = provider.applyCompletion([line], 0, line.length, result.items[0]!, result.prefix);
					assert.strictEqual(applied.lines[0], `${before}${value}`);
				}
			}
		});

		test("completes quoted paths after opening wrappers", async () => {
			setupFolder(baseDir, { files: { "my dir/main.ts": "x" } });
			const provider = new CombinedAutocompleteProvider([], baseDir);
			const line = 'see ("my dir/ma';
			const result = await getSuggestions(provider, [line], 0, line.length, true);
			assert.ok(result);
			assert.strictEqual(result.prefix, '"my dir/ma');
			assert.deepStrictEqual(
				result.items.map((item) => item.value),
				['"my dir/main.ts"'],
			);
		});

		test("keeps wrappers that are closed inside the path", async () => {
			setupFolder(baseDir, { files: { "[slug]/page.tsx": "x", "(group)/layout.tsx": "x" } });
			const provider = new CombinedAutocompleteProvider([], baseDir);
			for (const [prefix, value] of [
				["[slug]/pa", "[slug]/page.tsx"],
				["(group)/la", "(group)/layout.tsx"],
				["./[slug]/pa", "./[slug]/page.tsx"],
			]) {
				const line = `see ${prefix}`;
				const result = await getSuggestions(provider, [line], 0, line.length, true);
				assert.ok(result, line);
				assert.strictEqual(result.prefix, prefix);
				assert.deepStrictEqual(
					result.items.map((item) => item.value),
					[value],
				);
			}
		});

		test("preserves CJK characters in unprefixed Tab completions", async () => {
			setupFolder(baseDir, { files: { "文档/说明.md": "text" } });
			const provider = new CombinedAutocompleteProvider([], baseDir);
			const line = "文档/说";
			const result = await getSuggestions(provider, [line], 0, line.length, true);
			assert.ok(result);
			assert.strictEqual(result.prefix, line);
			assert.deepStrictEqual(
				result.items.map((item) => item.value),
				["文档/说明.md"],
			);
		});

		test("preserves ./ prefix when completing paths", async () => {
			setupFolder(baseDir, {
				files: {
					"update.sh": "#!/bin/bash",
					"utils.ts": "export {};",
				},
			});

			const provider = new CombinedAutocompleteProvider([], baseDir);
			const line = "./up";
			const result = await getSuggestions(provider, [line], 0, line.length, true);

			assert.notEqual(result, null, "Should return suggestions for ./ path");
			const values = result?.items.map((item) => item.value);
			assert.ok(values?.includes("./update.sh"), `Expected ./update.sh in ${JSON.stringify(values)}`);
		});

		test("preserves ./ prefix for directory completions", async () => {
			setupFolder(baseDir, {
				dirs: ["src"],
				files: {
					"src/index.ts": "export {};",
				},
			});

			const provider = new CombinedAutocompleteProvider([], baseDir);
			const line = "./sr";
			const result = await getSuggestions(provider, [line], 0, line.length, true);

			assert.notEqual(result, null, "Should return suggestions for ./ directory path");
			const values = result?.items.map((item) => item.value);
			assert.ok(values?.includes("./src/"), `Expected ./src/ in ${JSON.stringify(values)}`);
		});
	});

	describe("quoted path completion", () => {
		let baseDir = "";

		beforeEach(() => {
			baseDir = mkdtempSync(join(tmpdir(), "pi-autocomplete-"));
		});

		afterEach(() => {
			rmSync(baseDir, { recursive: true, force: true });
		});

		test("quotes paths containing whitespace or CJK punctuation for direct completion", async () => {
			const provider = new CombinedAutocompleteProvider([], baseDir);
			for (const separator of [" ", "\u3000", "，", "。"]) {
				const directory = `my${separator}folder`;
				setupFolder(baseDir, { files: { [`${directory}/test.txt`]: "content" } });
				const line = "my";
				const result = await getSuggestions(provider, [line], 0, line.length, true);
				assert.ok(result);
				const item = result.items.find((entry) => entry.value === `"${directory}/"`);
				assert.ok(item, directory);
				const applied = provider.applyCompletion([line], 0, line.length, item, result.prefix);
				const continued = await getSuggestions(provider, applied.lines, 0, applied.cursorCol, true);
				assert.strictEqual(continued?.prefix, `"${directory}/`);
				assert.deepStrictEqual(
					continued?.items.map((entry) => entry.value),
					[`"${directory}/test.txt"`],
				);
			}
		});

		test("sorts quoted entries by name", async () => {
			setupFolder(baseDir, { dirs: ["z folder", "z，folder"], files: { "a.txt": "text" } });
			const provider = new CombinedAutocompleteProvider([], baseDir);
			const result = await getSuggestions(provider, [""], 0, 0, true);
			assert.ok(result);
			assert.deepStrictEqual(
				result.items.map((item) => item.label),
				["a.txt", "z folder/", "z，folder/"],
			);
		});

		test("continues completion inside quoted paths", async () => {
			setupFolder(baseDir, {
				files: {
					"my folder/test.txt": "content",
					"my folder/other.txt": "content",
				},
			});

			const provider = new CombinedAutocompleteProvider([], baseDir);
			const line = '"my folder/"';
			const result = await getSuggestions(provider, [line], 0, line.length - 1, true);

			assert.notEqual(result, null, "Should return suggestions for quoted folder path");
			const values = result?.items.map((item) => item.value);
			assert.ok(values?.includes('"my folder/test.txt"'));
			assert.ok(values?.includes('"my folder/other.txt"'));
		});

		test("applies quoted completion without duplicating closing quote", async () => {
			setupFolder(baseDir, {
				files: {
					"my folder/test.txt": "content",
				},
			});

			const provider = new CombinedAutocompleteProvider([], baseDir);
			const line = '"my folder/te"';
			const cursorCol = line.length - 1;
			const result = await getSuggestions(provider, [line], 0, cursorCol, true);

			assert.notEqual(result, null, "Should return suggestions for quoted path");
			const item = result?.items.find((entry) => entry.value === '"my folder/test.txt"');
			assert.ok(item, "Should find test.txt suggestion");

			const applied = provider.applyCompletion([line], 0, cursorCol, item!, result!.prefix);
			assert.strictEqual(applied.lines[0], '"my folder/test.txt"');
		});
	});
});
