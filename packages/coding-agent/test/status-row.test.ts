import { describe, expect, it } from "bun:test";
import { clickTarget } from "@earendil-works/pi-tui";
import { BACKGROUND_JOBS_CLICK_TARGET, StatusRowComponent } from "../src/modes/interactive/components/status-row.ts";
import { stripAnsi } from "../src/utils/ansi.ts";

describe("StatusRowComponent", () => {
	it("renders a blank line when up to date with no background jobs", () => {
		const component = new StatusRowComponent();

		expect(component.render(20)).toEqual([""]);
	});

	it("right aligns mi before pi", () => {
		const component = new StatusRowComponent();
		component.setUpdateCounts({ mi: 3, pi: 12 });

		expect(component.render(20).map(stripAnsi)).toEqual(["          mi 3 pi 12"]);
	});

	it("omits a zero count", () => {
		const component = new StatusRowComponent();
		component.setUpdateCounts({ mi: 0, pi: 5 });

		expect(component.render(10).map(stripAnsi)).toEqual(["      pi 5"]);
	});

	it("left aligns the background job count as a button", () => {
		const component = new StatusRowComponent();
		component.setBackgroundJobs(1);

		expect(component.render(20).map(stripAnsi)).toEqual([
			`${clickTarget(BACKGROUND_JOBS_CLICK_TARGET, "background 1")}        `,
		]);
	});

	it("shares the row with update counts", () => {
		const component = new StatusRowComponent();
		component.setBackgroundJobs(2);
		component.setUpdateCounts({ mi: 3, pi: 12 });

		expect(component.render(40).map(stripAnsi)).toEqual([
			`${clickTarget(BACKGROUND_JOBS_CLICK_TARGET, "background 2")}                  mi 3 pi 12`,
		]);
	});

	it("truncates the background job count before update counts", () => {
		const component = new StatusRowComponent();
		component.setBackgroundJobs(2);
		component.setUpdateCounts({ mi: 3, pi: 12 });

		expect(component.render(20).map(stripAnsi)).toEqual([
			`${clickTarget(BACKGROUND_JOBS_CLICK_TARGET, "backgroun")} mi 3 pi 12`,
		]);
	});
});
