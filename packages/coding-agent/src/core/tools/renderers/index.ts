import type { ToolDefinition } from "../../extensions/types.ts";
import type { ToolName } from "../index.ts";
import { bashRenderers } from "./bash.ts";
import { editRenderers } from "./edit.ts";
import { readRenderers } from "./read.ts";
import { writeRenderers } from "./write.ts";

export type ToolRenderers = Pick<ToolDefinition<any, any>, "renderCall" | "renderResult">;

function createAllToolRenderers(): Record<ToolName, ToolRenderers> {
	return {
		read: readRenderers,
		bash: bashRenderers,
		edit: editRenderers,
		write: writeRenderers,
	};
}

export function withBuiltInRenderers<TDefinition extends ToolRenderers>(
	toolName: string,
	definition: TDefinition | undefined,
): TDefinition | ToolRenderers | undefined {
	const builtIn = createAllToolRenderers()[toolName as ToolName];
	if (!definition) return builtIn;
	if (!builtIn) return definition;
	return {
		...definition,
		renderCall: definition.renderCall ?? builtIn.renderCall,
		renderResult: definition.renderResult ?? builtIn.renderResult,
	};
}
