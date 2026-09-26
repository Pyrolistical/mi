import { type Component, truncateToWidth, visibleWidth } from "@earendil-works/pi-tui";
import type { UpdateCounts } from "../../../core/update-check.ts";
import { theme } from "../theme/theme.ts";

export class UpdateStatusComponent implements Component {
	private counts: UpdateCounts = { mi: 0, pi: 0 };

	setCounts(counts: UpdateCounts): void {
		this.counts = counts;
	}

	invalidate(): void {}

	render(width: number): string[] {
		const parts = [
			...(this.counts.mi > 0 ? [`mi ${this.counts.mi}`] : []),
			...(this.counts.pi > 0 ? [`pi ${this.counts.pi}`] : []),
		];
		if (parts.length === 0) {
			return [""];
		}
		const text = truncateToWidth(parts.join(" "), width, "");
		return [" ".repeat(Math.max(0, width - visibleWidth(text))) + theme.fg("warning", text)];
	}
}
