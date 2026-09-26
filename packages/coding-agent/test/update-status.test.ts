import { beforeAll, describe, expect, it } from "bun:test";
import { UpdateStatusComponent } from "../src/modes/interactive/components/update-status.ts";

function stripAnsi(text: string): string {
	return text.replace(/\x1B\[[0-?]*[ -/]*[@-~]/g, "");
}

describe("UpdateStatusComponent", () => {
	beforeAll(() => {});

	it("renders a blank line when up to date", () => {
		const component = new UpdateStatusComponent();

		expect(component.render(20)).toEqual([""]);
	});

	it("right aligns mi before pi", () => {
		const component = new UpdateStatusComponent();
		component.setCounts({ mi: 3, pi: 12 });

		expect(component.render(20).map(stripAnsi)).toEqual(["          mi 3 pi 12"]);
	});

	it("omits a zero count", () => {
		const component = new UpdateStatusComponent();
		component.setCounts({ mi: 0, pi: 5 });

		expect(component.render(10).map(stripAnsi)).toEqual(["      pi 5"]);
	});
});
