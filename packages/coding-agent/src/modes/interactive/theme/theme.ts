import type { ThinkingLevel } from "@earendil-works/pi-agent-core";
import type { EditorTheme, MarkdownTheme, SelectListTheme, SettingsListTheme } from "@earendil-works/pi-tui";

const FOREGROUND = {
	accent: ["36", "39"],
	border: ["34", "39"],
	borderAccent: ["36", "39"],
	borderMuted: ["90", "39"],
	success: ["32", "39"],
	error: ["31", "39"],
	warning: ["33", "39"],
	muted: ["90", "39"],
	dim: ["2", "22"],
	text: ["39", "39"],
	thinkingText: ["90", "39"],
	userMessageText: ["39", "39"],
	customMessageText: ["39", "39"],
	customMessageLabel: ["35", "39"],
	toolTitle: ["39", "39"],
	toolOutput: ["90", "39"],
	mdHeading: ["1;33", "22;39"],
	mdLink: ["34", "39"],
	mdLinkUrl: ["90", "39"],
	mdCode: ["36", "39"],
	mdCodeBlock: ["32", "39"],
	mdCodeBlockBorder: ["90", "39"],
	mdQuote: ["90", "39"],
	mdQuoteBorder: ["90", "39"],
	mdHr: ["90", "39"],
	mdListBullet: ["36", "39"],
	toolDiffAdded: ["32", "39"],
	toolDiffRemoved: ["31", "39"],
	toolDiffContext: ["90", "39"],
	thinkingOff: ["90", "39"],
	thinkingMinimal: ["37", "39"],
	thinkingLow: ["34", "39"],
	thinkingMedium: ["36", "39"],
	thinkingHigh: ["35", "39"],
	thinkingXhigh: ["95", "39"],
	thinkingMax: ["91", "39"],
	bashMode: ["32", "39"],
} as const satisfies Record<string, readonly [string, string]>;

export type ThemeColor = keyof typeof FOREGROUND;

const THINKING_COLORS: Record<ThinkingLevel, ThemeColor> = {
	off: "thinkingOff",
	minimal: "thinkingMinimal",
	low: "thinkingLow",
	medium: "thinkingMedium",
	high: "thinkingHigh",
	xhigh: "thinkingXhigh",
	max: "thinkingMax",
};

export class Theme {
	fg(color: ThemeColor, text: string): string {
		const [open, close] = FOREGROUND[color];
		return `\x1b[${open}m${text}\x1b[${close}m`;
	}

	inverse(text: string): string {
		return `\x1b[7m${text}\x1b[27m`;
	}

	getThinkingBorderColor(level: ThinkingLevel): (str: string) => string {
		return (str: string) => this.fg(THINKING_COLORS[level], str);
	}

	getBashModeBorderColor(): (str: string) => string {
		return (str: string) => this.fg("bashMode", str);
	}
}

export const theme = new Theme();

export function getMarkdownTheme(): MarkdownTheme {
	return {
		heading: (text: string) => theme.fg("mdHeading", text),
		link: (text: string) => theme.fg("mdLink", text),
		linkUrl: (text: string) => theme.fg("mdLinkUrl", text),
		code: (text: string) => theme.fg("mdCode", text),
		codeBlock: (text: string) => theme.fg("mdCodeBlock", text),
		codeBlockBorder: (text: string) => theme.fg("mdCodeBlockBorder", text),
		quote: (text: string) => theme.fg("mdQuote", text),
		quoteBorder: (text: string) => theme.fg("mdQuoteBorder", text),
		hr: (text: string) => theme.fg("mdHr", text),
		listBullet: (text: string) => theme.fg("mdListBullet", text),
	};
}

export function getSelectListTheme(): SelectListTheme {
	return {
		selectedPrefix: (text: string) => theme.fg("accent", text),
		selectedText: (text: string) => theme.fg("accent", text),
		description: (text: string) => theme.fg("muted", text),
		scrollInfo: (text: string) => theme.fg("muted", text),
		noMatch: (text: string) => theme.fg("muted", text),
	};
}

export function getEditorTheme(): EditorTheme {
	return {
		borderColor: (text: string) => theme.fg("borderMuted", text),
		selectList: getSelectListTheme(),
	};
}

export function getSettingsListTheme(): SettingsListTheme {
	return {
		label: (text: string, selected: boolean) => (selected ? theme.fg("accent", text) : text),
		value: (text: string, selected: boolean) => (selected ? theme.fg("accent", text) : theme.fg("muted", text)),
		description: (text: string) => theme.fg("dim", text),
		cursor: theme.fg("accent", "→ "),
		hint: (text: string) => theme.fg("dim", text),
	};
}
