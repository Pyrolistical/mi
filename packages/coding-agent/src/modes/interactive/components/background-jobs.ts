import {
	type Component,
	type Focusable,
	getKeybindings,
	matchesKey,
	truncateToWidth,
	wrapTextWithAnsi,
} from "@earendil-works/pi-tui";
import type { BackgroundJob } from "../../../core/tools/background-commands.ts";
import { theme } from "../theme/theme.ts";
import { keyHint, rawKeyHint } from "./keybinding-hints.ts";

type ListedJob = Pick<BackgroundJob, "command" | "startedAt" | "kill">;

const ELAPSED_WIDTH = 7;
const PREFIX_WIDTH = ELAPSED_WIDTH + 4;

export function formatElapsed(ms: number): string {
	const seconds = Math.floor(ms / 1000);
	if (seconds < 60) return `${seconds}s`;
	const minutes = Math.floor(seconds / 60);
	if (minutes < 60) return `${minutes}m ${String(seconds % 60).padStart(2, "0")}s`;
	return `${Math.floor(minutes / 60)}h ${String(minutes % 60).padStart(2, "0")}m`;
}

export class BackgroundJobsComponent implements Component, Focusable {
	focused = false;
	private selectedIndex = 0;

	private readonly getJobs: () => ListedJob[];
	private readonly now: () => number;
	private readonly onClose: () => void;

	constructor(getJobs: () => ListedJob[], now: () => number, onClose: () => void) {
		this.getJobs = getJobs;
		this.now = now;
		this.onClose = onClose;
	}

	invalidate(): void {}

	handleInput(data: string): void {
		const kb = getKeybindings();
		const jobs = this.getJobs();
		if (kb.matches(data, "tui.select.cancel")) {
			this.onClose();
		} else if (kb.matches(data, "tui.select.up")) {
			this.selectedIndex = Math.max(0, this.selectedIndex - 1);
		} else if (kb.matches(data, "tui.select.down")) {
			this.selectedIndex = Math.max(0, Math.min(jobs.length - 1, this.selectedIndex + 1));
		} else if (matchesKey(data, "x")) {
			jobs[this.selectedIndex]?.kill();
		}
	}

	render(width: number): string[] {
		const jobs = this.getJobs();
		this.selectedIndex = Math.max(0, Math.min(jobs.length - 1, this.selectedIndex));
		const border = theme.fg("border", "─".repeat(Math.max(1, width)));
		const lines = [border, theme.fg("accent", "Background jobs"), ""];
		if (jobs.length === 0) {
			lines.push(theme.fg("muted", "No background jobs running"));
		}
		const now = this.now();
		for (const [index, job] of jobs.entries()) {
			const selected = index === this.selectedIndex;
			const elapsed = formatElapsed(now - job.startedAt).padStart(ELAPSED_WIDTH);
			for (const [row, text] of wrapTextWithAnsi(job.command, Math.max(1, width - PREFIX_WIDTH)).entries()) {
				const prefix = row === 0 ? `${selected ? "›" : " "} ${elapsed}  ` : " ".repeat(PREFIX_WIDTH);
				const line = truncateToWidth(prefix + text, width, "");
				lines.push(selected ? theme.fg("accent", line) : line);
			}
		}
		const sep = theme.fg("muted", " · ");
		lines.push(
			"",
			truncateToWidth(
				[rawKeyHint("↑↓", "select"), rawKeyHint("x", "kill"), keyHint("tui.select.cancel", "close")].join(sep),
				width,
				"",
			),
			border,
		);
		return lines;
	}
}
