import assert from "node:assert";
import { describe, it } from "node:test";
import { Editor } from "../src/components/editor.ts";
import type { Terminal } from "../src/terminal.ts";
import { TuiMainScreen } from "../src/tui-main-screen.ts";
import { defaultEditorTheme } from "./test-themes.ts";

function createTerminal(writes: string[]): Terminal {
	return {
		start: () => {},
		stop: () => {},
		write: (data: string) => {
			writes.push(data);
		},
		columns: 40,
		rows: 24,
		kittyProtocolActive: false,
		hideCursor: () => {
			writes.push("hide");
		},
		showCursor: () => {
			writes.push("show");
		},
	} as unknown as Terminal;
}

describe("hardware cursor", () => {
	it("shows the terminal cursor at the focused editor without a reverse-video cell", () => {
		const writes: string[] = [];
		const tui = new TuiMainScreen(createTerminal(writes));
		const editor = new Editor(tui, defaultEditorTheme);
		tui.addChild(editor);
		tui.setFocus(editor);
		editor.setText("hi");
		tui.start();
		tui.renderNow();

		assert.ok(!writes.join("").includes("\x1b[7m"));
		assert.strictEqual(writes.at(-1), "show");
		tui.stop();
	});
});
