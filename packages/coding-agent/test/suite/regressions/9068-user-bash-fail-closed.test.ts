import { describe, expect, test, vi } from "vitest";
import type { UserBashEvent, UserBashEventResult } from "../../../src/core/extensions/types.ts";
import { InteractiveMode } from "../../../src/modes/interactive/interactive-mode.ts";
import { createHarness, type Harness } from "../harness.ts";

vi.mock("../../../src/modes/interactive/theme/theme.js", () => ({ theme: {} }));

vi.mock("../../../src/modes/interactive/components/bash-execution.js", () => ({
	BashExecutionComponent: class {
		appendOutput(): void {}
		setComplete(): void {}
	},
}));

type InteractiveBashContext = {
	defaultEditor: { onSubmit?: (text: string) => Promise<void> | void };
	editor: { addToHistory?: (text: string) => void };
	session: Harness["session"];
	sessionManager: Harness["sessionManager"];
	ui: { requestRender(): void };
	chatContainer: { addChild(component: unknown): void };
	pendingMessagesContainer: { addChild(component: unknown): void };
	pendingBashComponents: unknown[];
	isBashMode: boolean;
	handleBashCommand(command: string, excludeFromContext?: boolean): Promise<void>;
	showError(message: string): void;
	updateEditorBorderColor(): void;
};

const interactiveModePrototype = InteractiveMode.prototype as unknown as {
	setupEditorSubmitHandler(this: InteractiveBashContext): void;
	handleBashCommand(this: InteractiveBashContext, command: string, excludeFromContext?: boolean): Promise<void>;
};

const localResult = {
	output: "local output",
	exitCode: 0,
	cancelled: false,
	truncated: false,
};

describe("Interactive user_bash failure handling (#9068)", () => {
	test.each([
		["!pwd", false],
		["!!pwd", true],
	])("fails closed for %s when a handler returns an empty result", async (input, excludeFromContext) => {
		const events: UserBashEvent[] = [];
		const harness = await createHarness({
			extensionFactories: [
				(pi) => {
					pi.on("user_bash", async (event) => {
						events.push(event);
						return {} as unknown as UserBashEventResult;
					});
				},
			],
		});
		const executeBash = vi.spyOn(harness.session, "executeBash").mockResolvedValue(localResult);
		const context: InteractiveBashContext = {
			defaultEditor: {},
			editor: { addToHistory: vi.fn() },
			session: harness.session,
			sessionManager: harness.sessionManager,
			ui: { requestRender: vi.fn() },
			chatContainer: { addChild: vi.fn() },
			pendingMessagesContainer: { addChild: vi.fn() },
			pendingBashComponents: [],
			isBashMode: true,
			handleBashCommand: interactiveModePrototype.handleBashCommand,
			showError: vi.fn(),
			updateEditorBorderColor: vi.fn(),
		};
		interactiveModePrototype.setupEditorSubmitHandler.call(context);

		try {
			await context.defaultEditor.onSubmit?.(input);

			expect(events).toEqual([
				{
					type: "user_bash",
					command: "pwd",
					excludeFromContext,
					cwd: harness.sessionManager.getCwd(),
				},
			]);
			expect(executeBash).not.toHaveBeenCalled();
		} finally {
			executeBash.mockRestore();
			harness.cleanup();
		}
	});
});
