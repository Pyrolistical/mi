import { basename, dirname } from "node:path";
import type { ImageContent, TextContent } from "@earendil-works/pi-ai";
import { Text } from "@earendil-works/pi-tui";
import { keyHint, keyText } from "../../../modes/interactive/components/keybinding-hints.ts";
import type { Theme } from "../../../modes/interactive/theme/theme.ts";
import { formatPathRelativeToCwdOrAbsolute } from "../../../utils/paths.ts";
import type { ToolDefinition, ToolRenderResultOptions } from "../../extensions/types.ts";
import { resolveToCwd } from "../path-utils.ts";
import type { ReadToolDetails } from "../read.ts";
import { getTextOutput, renderToolPath, replaceTabs, str } from "../render-utils.ts";
import { DEFAULT_MAX_BYTES, DEFAULT_MAX_LINES, formatSize } from "../truncate.ts";

interface CompactReadClassification {
	kind: "resource" | "skill";
	label: string;
}
const COMPACT_RESOURCE_FILE_NAMES = new Set(["AGENTS.override.md", "AGENTS.md", "AGENTS.MD", "CLAUDE.md", "CLAUDE.MD"]);
type ReadRenderArgs = { path?: string; file_path?: string; offset?: number; limit?: number };
function formatReadLineRange(args: ReadRenderArgs | undefined, theme: Theme): string {
	if (args?.offset == null && args?.limit == null) return "";
	const startLine = args.offset ?? 1;
	const endLine = args.limit != null ? startLine + args.limit - 1 : "";
	return theme.fg("warning", `:${startLine}${endLine ? `-${endLine}` : ""}`);
}
function formatReadCall(args: ReadRenderArgs | undefined, theme: Theme, cwd: string): string {
	const pathDisplay = renderToolPath(str(args?.file_path ?? args?.path), theme, cwd);
	return `${theme.fg("toolTitle", "read")} ${pathDisplay}${formatReadLineRange(args, theme)}`;
}
function trimTrailingEmptyLines(lines: string[]): string[] {
	let end = lines.length;
	while (end > 0 && lines[end - 1] === "") {
		end--;
	}
	return lines.slice(0, end);
}
function getCompactReadClassification(
	args: ReadRenderArgs | undefined,
	cwd: string,
): CompactReadClassification | undefined {
	const rawPath = str(args?.file_path ?? args?.path);
	if (!rawPath) return undefined;

	const absolutePath = resolveToCwd(rawPath, cwd);
	const fileName = basename(absolutePath);
	if (fileName === "SKILL.md") {
		return { kind: "skill", label: basename(dirname(absolutePath)) || fileName };
	}

	if (COMPACT_RESOURCE_FILE_NAMES.has(fileName)) {
		return { kind: "resource", label: formatPathRelativeToCwdOrAbsolute(absolutePath, cwd) };
	}

	return undefined;
}
function formatCompactReadCall(
	classification: CompactReadClassification,
	args: ReadRenderArgs | undefined,
	theme: Theme,
): string {
	const expandHint = theme.fg("dim", ` (${keyText("app.tools.expand")} to expand)`);
	if (classification.kind === "skill") {
		return (
			theme.fg("customMessageLabel", `\x1b[1m[skill]\x1b[22m `) +
			theme.fg("customMessageText", classification.label) +
			formatReadLineRange(args, theme) +
			expandHint
		);
	}

	return (
		theme.fg("toolTitle", `read ${classification.kind}`) +
		" " +
		theme.fg("accent", classification.label) +
		formatReadLineRange(args, theme) +
		expandHint
	);
}
function formatReadResult(
	result: { content: (TextContent | ImageContent)[]; details?: ReadToolDetails },
	options: ToolRenderResultOptions,
	theme: Theme,
	showImages: boolean,
	isError: boolean,
): string {
	if (!options.expanded && !isError) {
		return "";
	}

	const output = getTextOutput(result, showImages);
	const lines = trimTrailingEmptyLines(output.split("\n"));
	const maxLines = options.expanded ? lines.length : 10;
	const displayLines = lines.slice(0, maxLines);
	const remaining = lines.length - maxLines;
	let text = `\n${displayLines.map((line) => theme.fg("toolOutput", replaceTabs(line))).join("\n")}`;
	if (remaining > 0) {
		text += `${theme.fg("muted", `\n... (${remaining} more lines,`)} ${keyHint("app.tools.expand", "to expand")}${theme.fg("muted", ")")}`;
	}

	const truncation = result.details?.truncation;
	if (truncation?.truncated) {
		if (truncation.firstLineExceedsLimit) {
			text += `\n${theme.fg("warning", `[First line exceeds ${formatSize(truncation.maxBytes ?? DEFAULT_MAX_BYTES)} limit]`)}`;
		} else if (truncation.truncatedBy === "lines") {
			text += `\n${theme.fg("warning", `[Truncated: showing ${truncation.outputLines} of ${truncation.totalLines} lines (${truncation.maxLines ?? DEFAULT_MAX_LINES} line limit)]`)}`;
		} else {
			text += `\n${theme.fg("warning", `[Truncated: ${truncation.outputLines} lines shown (${formatSize(truncation.maxBytes ?? DEFAULT_MAX_BYTES)} limit)]`)}`;
		}
	}
	return text;
}

export const readRenderers: Pick<ToolDefinition<any, ReadToolDetails | undefined>, "renderCall" | "renderResult"> = {
	renderCall(rawArgs, theme, context) {
		const args = rawArgs as ReadRenderArgs | undefined;
		const text = (context.lastComponent as Text | undefined) ?? new Text("", 0, 0);
		const classification = !context.expanded ? getCompactReadClassification(args, context.cwd) : undefined;
		text.setText(
			classification ? formatCompactReadCall(classification, args, theme) : formatReadCall(args, theme, context.cwd),
		);
		return text;
	},
	renderResult(result, options, theme, context) {
		const text = (context.lastComponent as Text | undefined) ?? new Text("", 0, 0);
		text.setText(formatReadResult(result, options, theme, context.showImages, context.isError));
		return text;
	},
};
