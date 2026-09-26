import { describe, expect, it } from "bun:test";
import { BackgroundJobsComponent, formatElapsed } from "../src/modes/interactive/components/background-jobs.ts";
import { stripAnsi } from "../src/utils/ansi.ts";

describe("formatElapsed", () => {
	it("formats seconds, minutes and hours", () => {
		expect([formatElapsed(9_400), formatElapsed(65_000), formatElapsed(3_725_000)]).toEqual([
			"9s",
			"1m 05s",
			"1h 02m",
		]);
	});
});

describe("BackgroundJobsComponent", () => {
	it("lists jobs with their elapsed time and wraps long commands", () => {
		const jobs = [
			{ command: "bun test", startedAt: 1_000, kill: () => {} },
			{ command: "sleep 100 && echo done", startedAt: 55_000, kill: () => {} },
		];
		const component = new BackgroundJobsComponent(
			() => jobs,
			() => 66_000,
			() => {},
		);

		expect(component.render(24).map(stripAnsi)).toEqual([
			"────────────────────────",
			"Background jobs",
			"",
			"›  1m 05s  bun test",
			"      11s  sleep 100 &&",
			"           echo done",
			"",
			"↑↓ select · x kill · esc",
			"────────────────────────",
		]);
	});

	it("kills the selected job", () => {
		const killed: string[] = [];
		const jobs = [
			{ command: "bun test", startedAt: 1_000, kill: () => killed.push("bun test") },
			{ command: "sleep 100", startedAt: 55_000, kill: () => killed.push("sleep 100") },
		];
		const component = new BackgroundJobsComponent(
			() => jobs,
			() => 66_000,
			() => {},
		);

		component.handleInput("\x1b[B");
		component.handleInput("x");

		expect(killed).toEqual(["sleep 100"]);
	});

	it("closes on escape", () => {
		const closed: string[] = [];
		const component = new BackgroundJobsComponent(
			() => [],
			() => 0,
			() => closed.push("closed"),
		);

		component.handleInput("\x1b");

		expect(closed).toEqual(["closed"]);
	});
});
