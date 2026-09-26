import assert from "node:assert";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, it } from "node:test";
import { CombinedAutocompleteProvider } from "../src/autocomplete.ts";
import { Editor } from "../src/components/editor.ts";
import type { TUI } from "../src/tui.ts";
import { defaultEditorTheme } from "./test-themes.ts";

const settle = (editor: Editor) =>
	(editor as unknown as { autocompleteRequestTask: Promise<void> }).autocompleteRequestTask;

describe("Editor @ tab completion", () => {
	let baseDir: string;

	beforeEach(() => {
		baseDir = mkdtempSync(join(tmpdir(), "pi-editor-autocomplete-"));
		mkdirSync(join(baseDir, "asdf-zxcv"));
		mkdirSync(join(baseDir, "asdf-qwer"));
	});

	afterEach(() => {
		rmSync(baseDir, { recursive: true, force: true });
	});

	const createEditor = () => {
		const tui = { requestRender: () => {}, terminal: { rows: 24 } } as unknown as TUI;
		const editor = new Editor(tui, defaultEditorTheme);
		editor.setAutocompleteProvider(new CombinedAutocompleteProvider([], baseDir));
		return editor;
	};

	it("completes the common prefix on tab", async () => {
		const editor = createEditor();
		editor.handleInput("@");
		editor.handleInput("a");
		editor.handleInput("\t");
		await settle(editor);

		assert.strictEqual(editor.getText(), "@asdf-");
		assert.strictEqual(editor.isShowingAutocomplete(), true);
	});

	it("completes the common prefix on tab while suggestions are showing", async () => {
		const editor = createEditor();
		mkdirSync(join(baseDir, "b"));
		editor.handleInput("@");
		editor.handleInput("\t");
		await settle(editor);
		editor.handleInput("a");
		await settle(editor);
		assert.strictEqual(editor.isShowingAutocomplete(), true);

		editor.handleInput("\t");
		await settle(editor);

		assert.strictEqual(editor.getText(), "@asdf-");
		assert.strictEqual(editor.isShowingAutocomplete(), true);
	});

	it("completes the only match on tab after the common prefix", async () => {
		const editor = createEditor();
		editor.handleInput("@");
		editor.handleInput("a");
		editor.handleInput("\t");
		await settle(editor);
		editor.handleInput("q");
		await settle(editor);
		editor.handleInput("\t");
		await settle(editor);

		assert.strictEqual(editor.getText(), "@asdf-qwer/");
	});

	it("completes a file inside a directory to its relative path without @", async () => {
		const editor = createEditor();
		writeFileSync(join(baseDir, "asdf-qwer", "notes.json"), "{}");
		editor.handleInput("@");
		editor.handleInput("a");
		editor.handleInput("\t");
		await settle(editor);
		editor.handleInput("q");
		await settle(editor);
		editor.handleInput("\t");
		await settle(editor);
		editor.handleInput("n");
		await settle(editor);
		editor.handleInput("\t");
		await settle(editor);

		assert.strictEqual(editor.getText(), "./asdf-qwer/notes.json ");
	});

	it("completes a common prefix with whitespace inside a quote", async () => {
		const editor = createEditor();
		writeFileSync(join(baseDir, "with space.txt"), "");
		writeFileSync(join(baseDir, "with spice.txt"), "");
		editor.handleInput("@");
		editor.handleInput("w");
		editor.handleInput("\t");
		await settle(editor);
		editor.handleInput("a");
		await settle(editor);
		editor.handleInput("\t");
		await settle(editor);

		assert.strictEqual(editor.getText(), '"./with space.txt" ');
	});

	it("keeps listing on tab when there is no longer common prefix", async () => {
		const editor = createEditor();
		editor.handleInput("@");
		editor.handleInput("a");
		editor.handleInput("\t");
		await settle(editor);
		editor.handleInput("\t");
		await settle(editor);

		assert.strictEqual(editor.getText(), "@asdf-");
		assert.strictEqual(editor.isShowingAutocomplete(), true);
	});
});
