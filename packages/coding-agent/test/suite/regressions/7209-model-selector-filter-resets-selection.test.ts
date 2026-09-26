import { setKeybindings, type TUI } from "@earendil-works/pi-tui";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "bun:test";
import { waitFor } from "../../test-helpers.ts";
import { KeybindingsManager } from "../../../src/core/keybindings.ts";
import { ModelSelectorComponent } from "../../../src/modes/interactive/components/model-selector.ts";
import { stripAnsi } from "../../../src/utils/ansi.ts";
import { createHarness, type Harness } from "../harness.ts";

function createFakeTui(): TUI {
	return { requestRender: () => {} } as unknown as TUI;
}

function selectedModelId(rendered: string): string | undefined {
	const line = rendered.split("\n").find((l) => l.startsWith("→ "));
	if (!line) return undefined;
	const rest = line.replace(/^→\s*/, "");
	const id = rest.split(" [")[0]?.replace(/^✓\s*/, "");
	return id?.trim() || undefined;
}

describe("model selector filter resets selection to top", () => {
	const harnesses: Harness[] = [];

	beforeAll(() => {});

	beforeEach(() => {
		setKeybindings(new KeybindingsManager());
	});

	afterAll(() => {
		while (harnesses.length > 0) {
			harnesses.pop()?.cleanup();
		}
	});

	it("moves selection to the first row in the All tab when typing a query", async () => {
		const harness = await createHarness({
			models: [
				{ id: "alpha-1", name: "Alpha One", reasoning: true },
				{ id: "alpha-2", name: "Alpha Two", reasoning: true },
				{ id: "alpha-3", name: "Alpha Three", reasoning: true },
				{ id: "beta-1", name: "Beta One", reasoning: true },
			],
		});
		harnesses.push(harness);

		const current = harness.getModel("alpha-1")!;
		const selector = new ModelSelectorComponent(
			createFakeTui(),
			current,
			harness.session.modelRuntime,
			[],
			() => {},
			() => {},
		);

		await waitFor(() => {
			const rendered = stripAnsi(selector.render(120).join("\n"));
			expect(rendered).toContain("Model catalogs refreshed.");
		});

		expect(selectedModelId(stripAnsi(selector.render(120).join("\n")))).toBe("alpha-1");

		selector.handleInput("\x1b[B");
		selector.handleInput("\x1b[B");
		expect(selectedModelId(stripAnsi(selector.render(120).join("\n")))).toBe("alpha-3");

		for (const char of "alpha") {
			selector.handleInput(char);
		}

		const rendered = stripAnsi(selector.render(120).join("\n"));
		expect(selectedModelId(rendered)).toBe("alpha-1");
		expect(rendered).not.toContain("beta-1");
	});

	it("moves selection to the first row in the Scoped tab when typing a query", async () => {
		const harness = await createHarness({
			models: [
				{ id: "alpha-1", name: "Alpha One", reasoning: true },
				{ id: "alpha-2", name: "Alpha Two", reasoning: true },
				{ id: "alpha-3", name: "Alpha Three", reasoning: true },
			],
		});
		harnesses.push(harness);

		const alpha1 = harness.getModel("alpha-1")!;
		const alpha2 = harness.getModel("alpha-2")!;
		const alpha3 = harness.getModel("alpha-3")!;

		const selector = new ModelSelectorComponent(
			createFakeTui(),
			alpha1,
			harness.session.modelRuntime,
			[{ model: alpha2 }, { model: alpha3 }, { model: alpha1 }],
			() => {},
			() => {},
		);

		await waitFor(() => {
			const rendered = stripAnsi(selector.render(120).join("\n"));
			expect(rendered).toContain("Model catalogs refreshed.");
		});

		expect(selectedModelId(stripAnsi(selector.render(120).join("\n")))).toBe("alpha-1");

		for (const char of "alpha") {
			selector.handleInput(char);
		}

		expect(selectedModelId(stripAnsi(selector.render(120).join("\n")))).toBe("alpha-2");
	});
});
