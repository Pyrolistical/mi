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

	it("follows the background job count with the callback count", () => {
		const component = new StatusRowComponent();
		component.setBackgroundJobs(2);
		component.setCallbacks(1);

		expect(component.render(30).map(stripAnsi)).toEqual([
			`${clickTarget(BACKGROUND_JOBS_CLICK_TARGET, "background 2")} callback 1       `,
		]);
	});

	it("shows the callback count without a button when no background job runs", () => {
		const component = new StatusRowComponent();
		component.setCallbacks(3);

		expect(component.render(20).map(stripAnsi)).toEqual(["callback 3          "]);
	});

	it("shares the row with update counts", () => {
		const component = new StatusRowComponent();
		component.setBackgroundJobs(2);
		component.setCallbacks(1);
		component.setUpdateCounts({ mi: 3, pi: 12 });

		expect(component.render(40).map(stripAnsi)).toEqual([
			`${clickTarget(BACKGROUND_JOBS_CLICK_TARGET, "background 2")} callback 1       mi 3 pi 12`,
		]);
	});

	it("truncates the counts on the left before update counts", () => {
		const component = new StatusRowComponent();
		component.setBackgroundJobs(2);
		component.setCallbacks(1);
		component.setUpdateCounts({ mi: 3, pi: 12 });

		expect(component.render(20).map(stripAnsi)).toEqual([
			`${clickTarget(BACKGROUND_JOBS_CLICK_TARGET, "backgroun")} mi 3 pi 12`,
		]);
	});
});
