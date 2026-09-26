import type { EditorTheme, MarkdownTheme, SelectListTheme } from "../src/index.ts";
import { blue, cyan, gray, green, red, yellow } from "./ansi.ts";

const plain = (text: string) => text;

const defaultSelectListTheme: SelectListTheme = {
	selectedPrefix: blue,
	selectedText: plain,
	description: gray,
	scrollInfo: gray,
	noMatch: gray,
};

export const defaultMarkdownTheme: MarkdownTheme = {
	heading: cyan,
	link: blue,
	linkUrl: gray,
	code: yellow,
	codeBlock: green,
	codeBlockBorder: gray,
	quote: red,
	quoteBorder: gray,
	hr: gray,
	listBullet: cyan,
};

export const defaultEditorTheme: EditorTheme = {
	borderColor: gray,
	selectList: defaultSelectListTheme,
};
