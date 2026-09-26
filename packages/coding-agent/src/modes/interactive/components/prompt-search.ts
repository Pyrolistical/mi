import {
	type Component,
	type Focusable,
	getKeybindings,
	Input,
	truncateToWidth,
	wrapTextWithAnsi,
} from "@earendil-works/pi-tui";
import type { SessionPrompts, StoredPrompt } from "../../../core/session-store.ts";
import { theme } from "../theme/theme.ts";
import { keyHint, rawKeyHint } from "./keybinding-hints.ts";

const RESULT_LIMIT = 200;
const FOOTER_LINES = 3;
const MARKER_WIDTH = 2;

export function searchTerms(query: string): string[] {
	return query
		.toLowerCase()
		.split(/\s+/)
		.map((term) => term.replaceAll('"', ""))
		.filter((term) => term.length > 0);
}

function highlight(line: string, terms: string[]): string {
	if (terms.length === 0) return line;
	const escaped = terms.map((term) => term.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"));
	return line.replace(new RegExp(`(${escaped.join("|")})`, "gi"), (match) =>
		theme.fg("accent", `\x1b[1m${match}\x1b[22m`),
	);
}

function sanitize(text: string): string {
	return text.replace(/\t/g, "  ").replace(/[\x00-\x08\x0b-\x1f\x7f]/g, " ");
}

export class PromptSearchComponent implements Component, Focusable {
	private readonly input = new Input({ prompt: theme.fg("accent", "search: ") });
	private readonly search: (query: string, limit: number) => StoredPrompt[];
	private readonly loadSession: (sessionId: string) => SessionPrompts;
	private readonly getHeight: () => number;
	private readonly onSelect: (prompt: string) => void;
	private readonly onCancel: () => void;
	private results: StoredPrompt[] = [];
	private session: SessionPrompts | undefined;
	private resultPosition = { selectedIndex: 0, scrollStart: 0 };
	private terms: string[] = [];
	private selectedIndex = 0;
	private scrollStart = 0;
	private centerSelected = false;
	private error: string | undefined;

	private _focused = false;
	get focused(): boolean {
		return this._focused;
	}
	set focused(value: boolean) {
		this._focused = value;
		this.input.focused = value;
	}

	constructor(
		search: (query: string, limit: number) => StoredPrompt[],
		loadSession: (sessionId: string) => SessionPrompts,
		getHeight: () => number,
		onSelect: (prompt: string) => void,
		onCancel: () => void,
	) {
		this.search = search;
		this.loadSession = loadSession;
		this.getHeight = getHeight;
		this.onSelect = onSelect;
		this.onCancel = onCancel;
		this.input.onSubmit = () => this.selectCurrent();
		this.runSearch("");
	}

	invalidate(): void {}

	handleInput(data: string): void {
		const kb = getKeybindings();
		if (kb.matches(data, "tui.select.cancel")) {
			if (this.session) this.closeSession();
			else this.onCancel();
			return;
		}
		if (kb.matches(data, "tui.input.tab")) {
			if (this.session) this.closeSession();
			else this.openSession();
			return;
		}
		if (kb.matches(data, "tui.select.up")) {
			this.selectedIndex = Math.max(0, this.selectedIndex - 1);
			return;
		}
		if (kb.matches(data, "tui.select.down")) {
			this.selectedIndex = Math.min(Math.max(0, this.shown().length - 1), this.selectedIndex + 1);
			return;
		}
		if (kb.matches(data, "tui.select.confirm")) {
			this.selectCurrent();
			return;
		}
		if (this.session) return;
		const before = this.input.getValue();
		this.input.handleInput(data);
		const query = this.input.getValue();
		if (query !== before) this.runSearch(query);
	}

	private shown(): StoredPrompt[] {
		return this.session?.prompts ?? this.results;
	}

	private selectCurrent(): void {
		const prompt = this.shown()[this.selectedIndex];
		if (prompt !== undefined) this.onSelect(prompt.text);
	}

	private openSession(): void {
		const result = this.results[this.selectedIndex];
		if (result === undefined) return;
		this.session = this.loadSession(result.sessionId);
		this.resultPosition = { selectedIndex: this.selectedIndex, scrollStart: this.scrollStart };
		this.selectedIndex = this.session.prompts.findIndex((prompt) => prompt.seq === result.seq);
		this.centerSelected = true;
	}

	private closeSession(): void {
		this.session = undefined;
		this.centerSelected = false;
		this.selectedIndex = this.resultPosition.selectedIndex;
		this.scrollStart = this.resultPosition.scrollStart;
	}

	private runSearch(query: string): void {
		this.terms = searchTerms(query);
		this.selectedIndex = 0;
		this.scrollStart = 0;
		try {
			this.results = this.search(query, RESULT_LIMIT);
			this.error = undefined;
		} catch (err) {
			this.results = [];
			this.error = err instanceof Error ? err.message : String(err);
		}
	}

	private renderPrompt(prompt: string, selected: boolean, width: number, maxLines: number): string[] {
		const textWidth = Math.max(10, width - MARKER_WIDTH);
		const wrapped = sanitize(prompt)
			.split("\n")
			.flatMap((line) => wrapTextWithAnsi(highlight(line, this.terms), textWidth));
		const shown = wrapped.length > maxLines ? wrapped.slice(0, Math.max(0, maxLines - 1)) : wrapped;
		const lines = shown.map((line, index) => {
			const marker = selected && index === 0 ? theme.fg("accent", "› ") : "  ";
			return marker + (selected ? line : theme.fg("muted", line));
		});
		if (shown.length < wrapped.length) {
			lines.push(`  ${theme.fg("dim", `… ${wrapped.length - shown.length} more lines`)}`);
		}
		return lines.map((line) => truncateToWidth(line, width, "…"));
	}

	render(width: number): string[] {
		const height = Math.max(FOOTER_LINES + 1, this.getHeight());
		const resultsHeight = height - FOOTER_LINES;
		const prompts = this.shown();
		const blocks = prompts.map((prompt, index) => [
			...this.renderPrompt(prompt.text, index === this.selectedIndex, width, resultsHeight - 1),
			"",
		]);

		if (this.centerSelected) {
			this.centerSelected = false;
			const above = (resultsHeight - blocks[this.selectedIndex]!.length) / 2;
			let used = 0;
			this.scrollStart = this.selectedIndex;
			while (this.scrollStart > 0 && used + blocks[this.scrollStart - 1]!.length <= above) {
				this.scrollStart--;
				used += blocks[this.scrollStart]!.length;
			}
		}
		if (this.selectedIndex < this.scrollStart) this.scrollStart = this.selectedIndex;
		const fits = (start: number): boolean => {
			let used = 0;
			for (let i = start; i <= this.selectedIndex; i++) used += blocks[i]!.length;
			return used <= resultsHeight;
		};
		while (this.scrollStart < this.selectedIndex && !fits(this.scrollStart)) this.scrollStart++;

		const results: string[] = [];
		if (this.error) {
			results.push(theme.fg("error", truncateToWidth(`  ${this.error}`, width, "…")));
		} else if (prompts.length === 0) {
			results.push(theme.fg("muted", this.terms.length === 0 ? "  No previous prompts" : "  No matches"));
		}
		for (let i = this.scrollStart; i < blocks.length; i++) {
			const block = blocks[i]!;
			if (results.length + block.length > resultsHeight && results.length > 0) break;
			results.push(...block.slice(0, resultsHeight - results.length));
		}
		while (results.length < resultsHeight) results.push("");

		const sep = theme.fg("muted", " · ");
		const hints = this.session
			? [
					rawKeyHint("↑↓", "select"),
					keyHint("tui.select.confirm", "edit"),
					keyHint("tui.input.tab", "back"),
					theme.fg("muted", `${prompts.length} prompts in session`),
				]
			: [
					rawKeyHint("↑↓", "select"),
					keyHint("tui.select.confirm", "edit"),
					keyHint("tui.input.tab", "session"),
					keyHint("tui.select.cancel", "cancel"),
					theme.fg("muted", `${prompts.length >= RESULT_LIMIT ? `${RESULT_LIMIT}+` : prompts.length} prompts`),
				];
		const query = this.session
			? [
					truncateToWidth(
						theme.fg("accent", "session: ") +
							(this.session.name ?? this.session.sessionId) +
							theme.fg("muted", ` · ${this.session.cwd}`),
						width,
						"…",
					),
				]
			: this.input.render(width);

		return [
			...results,
			theme.fg("border", "─".repeat(Math.max(1, width))),
			...query,
			truncateToWidth(hints.join(sep), width, "…"),
		];
	}
}
