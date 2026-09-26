import type { Component } from "@earendil-works/pi-tui";
import { theme } from "../theme/theme.ts";

export class DynamicBorder implements Component {
	private color: (str: string) => string;

	constructor(color: (str: string) => string = (str) => theme.fg("border", str)) {
		this.color = color;
	}

	invalidate(): void {}

	render(width: number): string[] {
		return [this.color("─".repeat(Math.max(1, width)))];
	}
}
