import { type Component, clickTarget, truncateToWidth, visibleWidth } from "@earendil-works/pi-tui";
import type { UpdateCounts } from "../../../core/update-check.ts";
import { theme } from "../theme/theme.ts";

export const BACKGROUND_JOBS_CLICK_TARGET = "background-jobs";

export class StatusRowComponent implements Component {
	private counts: UpdateCounts = { mi: 0, pi: 0 };
	private backgroundJobs = 0;
	private callbacks = 0;

	setUpdateCounts(counts: UpdateCounts): void {
		this.counts = counts;
	}

	setBackgroundJobs(running: number): void {
		this.backgroundJobs = running;
	}

	setCallbacks(pending: number): void {
		this.callbacks = pending;
	}

	invalidate(): void {}

	render(width: number): string[] {
		const updates = truncateToWidth(
			[
				...(this.counts.mi > 0 ? [`mi ${this.counts.mi}`] : []),
				...(this.counts.pi > 0 ? [`pi ${this.counts.pi}`] : []),
			].join(" "),
			width,
			"",
		);
		const background = this.backgroundJobs > 0 ? `background ${this.backgroundJobs}` : "";
		const callbacks = this.callbacks > 0 ? `callback ${this.callbacks}` : "";
		const waiting = [background, callbacks]
			.filter((part) => part)
			.join(" ")
			.slice(0, Math.max(0, width - visibleWidth(updates) - 1));
		if (!updates && !waiting) {
			return [""];
		}
		const gap = " ".repeat(width - visibleWidth(waiting) - visibleWidth(updates));
		const button = waiting.slice(0, background.length);
		const rest = waiting.slice(button.length);
		return [
			(button ? clickTarget(BACKGROUND_JOBS_CLICK_TARGET, theme.fg("muted", button)) : "") +
				theme.fg("muted", rest) +
				gap +
				theme.fg("warning", updates),
		];
	}
}
