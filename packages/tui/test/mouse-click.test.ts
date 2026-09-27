import assert from "node:assert";
import { describe, it } from "node:test";
import { Editor } from "../src/components/editor.ts";
import type { Terminal } from "../src/terminal.ts";
import { clickTarget, type TUI } from "../src/tui.ts";
import { TuiMainScreen } from "../src/tui-main-screen.ts";
import { Text } from "../src/components/text.ts";
import { defaultEditorTheme } from "./test-themes.ts";

function createTerminal(writes: string[]): { terminal: Terminal; send(data: string): void } {
	let onInput: ((data: string) => void) | undefined;
	const terminal = {
		start: (handler: (data: string) => void) => {
			onInput = handler;
		},
		stop: () => {},
		write: (data: string) => {
			writes.push(data);
		},
		columns: 40,
		rows: 24,
		kittyProtocolActive: false,
		hideCursor: () => {},
		showCursor: () => {},
	} as unknown as Terminal;
	return { terminal, send: (data) => onInput!(data) };
}

describe("Editor click from cursor", () => {
	it("moves the cursor to the clicked cell relative to the rendered cursor", () => {
		const tui = { requestRender: () => {}, terminal: { rows: 24 } } as unknown as TUI;
		const editor = new Editor(tui, defaultEditorTheme);
		editor.setText("hello\nworld");
		editor.render(40);

		editor.handleClickFromCursor(-1, -3);

		assert.deepStrictEqual(editor.getCursor(), { line: 0, col: 2 });
	});

	it("moves the cursor to the end of a line when clicking past it", () => {
		const tui = { requestRender: () => {}, terminal: { rows: 24 } } as unknown as TUI;
		const editor = new Editor(tui, defaultEditorTheme);
		editor.setText("hi\nworld");
		editor.render(40);

		editor.handleClickFromCursor(-1, 10);

		assert.deepStrictEqual(editor.getCursor(), { line: 0, col: 2 });
	});
});

describe("TuiMainScreen mouse click", () => {
	it("hands a left press back to the terminal until the next key press and clicks the focused editor relative to the cursor", () => {
		const writes: string[] = [];
		const { terminal, send } = createTerminal(writes);
		const tui = new TuiMainScreen(terminal);
		const editor = new Editor(tui, defaultEditorTheme);
		tui.addChild(editor);
		tui.setFocus(editor);
		editor.setText("hello\nworld");
		tui.start();
		tui.renderNow();
		writes.length = 0;

		send("\x1b[<0;3;10M");
		send("\x1b[<0;3;10m");
		assert.deepStrictEqual(writes, ["\x1b[?1000l\x1b[?1006l", "\x1b[6n"]);

		send("\x1b[11;6R");

		assert.deepStrictEqual(editor.getCursor(), { line: 0, col: 2 });

		send("!");

		assert.strictEqual(writes[2], "\x1b[?1000h\x1b[?1006h");
		assert.strictEqual(editor.getText(), "he!llo\nworld");
		tui.stop();
	});

	it("calls the handler of a clicked target instead of the focused editor", () => {
		const writes: string[] = [];
		const { terminal, send } = createTerminal(writes);
		const tui = new TuiMainScreen(terminal);
		const editor = new Editor(tui, defaultEditorTheme);
		const clicks: string[] = [];
		tui.addChild(new Text(`status ${clickTarget("jobs", "2 jobs")} end`, 0, 0));
		tui.addChild(editor);
		tui.setFocus(editor);
		editor.setText("hello");
		tui.addClickHandler("jobs", () => clicks.push("jobs"));
		tui.start();
		tui.renderNow();
		writes.length = 0;

		send("\x1b[<0;9;10M");
		send("\x1b[12;6R");

		assert.deepStrictEqual(clicks, ["jobs"]);
		assert.deepStrictEqual(editor.getCursor(), { line: 0, col: 5 });
		assert.ok(!writes.join("").includes("pi:k"));
		tui.stop();
	});

	it("hands the wheel back to the terminal until the next key press", () => {
		const writes: string[] = [];
		const { terminal, send } = createTerminal(writes);
		const tui = new TuiMainScreen(terminal);
		const editor = new Editor(tui, defaultEditorTheme);
		tui.addChild(editor);
		tui.setFocus(editor);
		editor.setText("hello\nworld");
		tui.start();
		tui.renderNow();
		writes.length = 0;

		send("\x1b[<64;3;10M");

		assert.deepStrictEqual(writes, ["\x1b[?1000l\x1b[?1006l"]);
		assert.strictEqual(editor.getText(), "hello\nworld");

		send("!");

		assert.strictEqual(writes[1], "\x1b[?1000h\x1b[?1006h");
		assert.strictEqual(editor.getText(), "hello\nworld!");
		tui.stop();
	});
});
