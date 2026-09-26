import { type Component, clickTarget, truncateToWidth, visibleWidth } from "@earendil-works/pi-tui";
import type { UpdateCounts } from "../../../core/update-check.ts";
import { theme } from "../theme/theme.ts";

export const BACKGROUND_JOBS_CLICK_TARGET = "background-jobs";

export class StatusRowComponent implements Component {
	private counts: UpdateCounts = { mi: 0, pi: 0 };
	private backgroundJobs = 0;

	setUpdateCounts(counts: UpdateCounts): void {
		this.counts = counts;
	}

	setBackgroundJobs(running: number): void {
		this.backgroundJobs = running;
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
		const background = (this.backgroundJobs > 0 ? `background ${this.backgroundJobs}` : "").slice(
			0,
			Math.max(0, width - visibleWidth(updates) - 1),
		);
		if (!updates && !background) {
			return [""];
		}
		const gap = " ".repeat(width - visibleWidth(background) - visibleWidth(updates));
		return [
			(background ? clickTarget(BACKGROUND_JOBS_CLICK_TARGET, theme.fg("muted", background)) : "") +
				gap +
				theme.fg("warning", updates),
		];
	}
}
