import { execFileSync, spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, relative } from "node:path";
import ts from "typescript";

const CODE_FILE = /\.(ts|tsx|js|mjs|cjs|sh|c|h)$/;
const NOT_LIVE = /(^|\/)(docs?|examples?|tests?|__tests__)\/|\.(test|spec)\.[cm]?[jt]sx?$/;

function stripComments(path: string, text: string): string {
	if (path.endsWith(".sh")) {
		return text
			.split("\n")
			.filter((line) => !/^\s*#/.test(line))
			.join("\n");
	}
	const scanner = ts.createScanner(ts.ScriptTarget.Latest, false, ts.LanguageVariant.Standard, text);
	let result = "";
	for (let kind = scanner.scan(); kind !== ts.SyntaxKind.EndOfFileToken; kind = scanner.scan()) {
		if (kind === ts.SyntaxKind.SingleLineCommentTrivia || kind === ts.SyntaxKind.ShebangTrivia) continue;
		if (kind === ts.SyntaxKind.MultiLineCommentTrivia) {
			result += "\n".repeat(scanner.getTokenText().split("\n").length - 1);
			continue;
		}
		result += scanner.getTokenText();
	}
	return result;
}

function writeLiveCode(commit: string, out: string): number {
	let total = 0;
	const tree = mkdtempSync(join(tmpdir(), "mi-count-lines-tree-"));
	execFileSync("sh", ["-c", `git archive "$1" | tar -x -C "$2"`, "sh", commit, tree]);
	for (const entry of readdirSync(tree, { recursive: true, withFileTypes: true })) {
		if (!entry.isFile()) continue;
		const path = relative(tree, join(entry.parentPath, entry.name));
		if (!CODE_FILE.test(path) || NOT_LIVE.test(path)) continue;
		const lines = stripComments(path, readFileSync(join(tree, path), "utf-8"))
			.split("\n")
			.filter((line) => line.trim() !== "");
		total += lines.length;
		mkdirSync(dirname(join(out, path)), { recursive: true });
		writeFileSync(join(out, path), `${lines.join("\n")}\n`);
	}
	rmSync(tree, { recursive: true, force: true });
	return total;
}

const head = process.argv[2] ?? "HEAD";
const base = execFileSync("git", ["merge-base", head, "upstream/main"], { encoding: "utf-8" }).trim();
const root = mkdtempSync(join(tmpdir(), "mi-count-lines-"));
writeLiveCode(base, join(root, "pi"));
const remaining = writeLiveCode(head, join(root, "mi"));
const diff = spawnSync("git", ["diff", "--no-index", "-M", "--numstat", "pi", "mi"], { cwd: root, encoding: "utf-8" });
rmSync(root, { recursive: true, force: true });
if (diff.status !== 1) throw new Error(`git diff failed: ${diff.stderr}`);

let added = 0;
let deleted = 0;
for (const line of diff.stdout.trim().split("\n")) {
	const [insertions, deletions] = line.split("\t");
	added += Number(insertions);
	deleted += Number(deletions);
}
const width = Math.max(deleted, added, remaining).toLocaleString("en-US").length;
console.log(`- ${deleted.toLocaleString("en-US").padStart(width)} lines of pi code`);
console.log(`+ ${added.toLocaleString("en-US").padStart(width)} lines added`);
console.log(`= ${remaining.toLocaleString("en-US").padStart(width)} lines of mi code`);
