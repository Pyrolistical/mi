import { getCapabilities, hyperlink, isImageLine } from "../terminal-image.ts";
import type { Component } from "../tui.ts";
import { applyBackgroundToLine, visibleWidth, wrapTextWithAnsi } from "../utils.ts";

interface MarkdownElement {
	type: string;
	props: {
		children?: MarkdownNode[];
		[key: string]: unknown;
	};
}

type MarkdownNode = string | MarkdownElement;

const HEADING_LEVELS: Record<string, number> = { h1: 1, h2: 2, h3: 3, h4: 4, h5: 5, h6: 6 };
const LIST_TYPES = new Set(["ul", "ol"]);

function childrenOf(node: MarkdownElement): MarkdownNode[] {
	return node.props.children ?? [];
}

function isElement(node: MarkdownNode, type?: string): node is MarkdownElement {
	return typeof node !== "string" && (type === undefined || node.type === type);
}

function plainText(nodes: readonly MarkdownNode[]): string {
	return nodes.map((node) => (typeof node === "string" ? node : plainText(childrenOf(node)))).join("");
}

function isBlockNode(node: MarkdownNode): boolean {
	return (
		isElement(node) &&
		(node.type in HEADING_LEVELS ||
			LIST_TYPES.has(node.type) ||
			["p", "pre", "blockquote", "hr", "table", "html"].includes(node.type))
	);
}

function parseMarkdown(text: string): MarkdownNode[] {
	const root = Bun.markdown.react(text, undefined, { autolinks: true, strikethrough: false }) as unknown as MarkdownElement;
	return childrenOf(root);
}

function trimPartialClosingFence(text: string): string {
	const lines = text.split("\n");
	let openMarker: string | undefined;
	for (const line of lines.slice(0, -1)) {
		const fence = /^[\s>]*(`{3,}|~{3,})/.exec(line)?.[1];
		if (!fence) continue;
		if (openMarker === undefined) openMarker = fence;
		else if (fence[0] === openMarker[0] && fence.length >= openMarker.length) openMarker = undefined;
	}
	const lastLine = lines[lines.length - 1]?.replace(/^[\s>]*/, "") ?? "";
	if (
		openMarker === undefined ||
		lastLine.length === 0 ||
		lastLine.length >= openMarker.length ||
		lastLine !== openMarker[0]?.repeat(lastLine.length)
	) {
		return text;
	}
	return lines.slice(0, -1).join("\n");
}

export interface DefaultTextStyle {
	color?: (text: string) => string;
	bgColor?: (text: string) => string;
}

export interface MarkdownTheme {
	heading: (text: string) => string;
	link: (text: string) => string;
	linkUrl: (text: string) => string;
	code: (text: string) => string;
	codeBlock: (text: string) => string;
	codeBlockBorder: (text: string) => string;
	quote: (text: string) => string;
	quoteBorder: (text: string) => string;
	hr: (text: string) => string;
	listBullet: (text: string) => string;
	codeBlockIndent?: string;
}

export interface MarkdownOptions {
	transform?: (markdown: string, availableWidth: number) => string;
}

interface InlineStyleContext {
	applyText: (text: string) => string;
	stylePrefix: string;
}

export class Markdown implements Component {
	private text: string;
	private paddingX: number;
	private paddingY: number;
	private defaultTextStyle?: DefaultTextStyle;
	private theme: MarkdownTheme;
	private options: MarkdownOptions;
	private defaultStylePrefix?: string;

	private cachedText?: string;
	private cachedWidth?: number;
	private cachedLines?: string[];

	constructor(
		text: string,
		paddingX: number,
		paddingY: number,
		theme: MarkdownTheme,
		defaultTextStyle?: DefaultTextStyle,
		options?: MarkdownOptions,
	) {
		this.text = text;
		this.paddingX = paddingX;
		this.paddingY = paddingY;
		this.theme = theme;
		this.defaultTextStyle = defaultTextStyle;
		this.options = options ? { ...options } : {};
	}

	setText(text: string): void {
		this.text = text;
		this.invalidate();
	}

	invalidate(): void {
		this.cachedText = undefined;
		this.cachedWidth = undefined;
		this.cachedLines = undefined;
	}

	render(width: number): string[] {
		if (this.cachedLines && this.cachedText === this.text && this.cachedWidth === width) {
			return this.cachedLines;
		}

		const contentWidth = Math.max(1, width - this.paddingX * 2);
		const text = this.options.transform?.(this.text, contentWidth) ?? this.text;

		if (!text || text.trim() === "") {
			const result: string[] = [];
			this.cachedText = this.text;
			this.cachedWidth = width;
			this.cachedLines = result;
			return result;
		}

		const normalizedText = text.replace(/\t/g, "   ");

		const nodes = parseMarkdown(trimPartialClosingFence(normalizedText));

		const renderedLines = this.renderBlocks(nodes, contentWidth);

		const wrappedLines: string[] = [];
		for (const line of renderedLines) {
			if (isImageLine(line)) {
				wrappedLines.push(line);
			} else {
				for (const wrappedLine of wrapTextWithAnsi(line, contentWidth)) {
					wrappedLines.push(wrappedLine);
				}
			}
		}

		const leftMargin = " ".repeat(this.paddingX);
		const rightMargin = " ".repeat(this.paddingX);
		const bgFn = this.defaultTextStyle?.bgColor;
		const contentLines: string[] = [];

		for (const line of wrappedLines) {
			if (isImageLine(line)) {
				contentLines.push(line);
				continue;
			}

			const lineWithMargins = leftMargin + line + rightMargin;

			if (bgFn) {
				contentLines.push(applyBackgroundToLine(lineWithMargins, width, bgFn));
			} else {
				const visibleLen = visibleWidth(lineWithMargins);
				const paddingNeeded = Math.max(0, width - visibleLen);
				contentLines.push(lineWithMargins + " ".repeat(paddingNeeded));
			}
		}

		const emptyLine = " ".repeat(width);
		const emptyLines: string[] = [];
		for (let i = 0; i < this.paddingY; i++) {
			const line = bgFn ? applyBackgroundToLine(emptyLine, width, bgFn) : emptyLine;
			emptyLines.push(line);
		}

		const result = emptyLines.concat(contentLines, emptyLines);

		this.cachedText = this.text;
		this.cachedWidth = width;
		this.cachedLines = result;

		return result.length > 0 ? result : [""];
	}

	private applyDefaultStyle(text: string): string {
		if (!this.defaultTextStyle) {
			return text;
		}

		let styled = text;

		if (this.defaultTextStyle.color) {
			styled = this.defaultTextStyle.color(styled);
		}

		return styled;
	}

	private getDefaultStylePrefix(): string {
		if (!this.defaultTextStyle) {
			return "";
		}

		if (this.defaultStylePrefix !== undefined) {
			return this.defaultStylePrefix;
		}

		const sentinel = "\u0000";
		let styled = sentinel;

		if (this.defaultTextStyle.color) {
			styled = this.defaultTextStyle.color(styled);
		}

		const sentinelIndex = styled.indexOf(sentinel);
		this.defaultStylePrefix = sentinelIndex >= 0 ? styled.slice(0, sentinelIndex) : "";
		return this.defaultStylePrefix;
	}

	private getStylePrefix(styleFn: (text: string) => string): string {
		const sentinel = "\u0000";
		const styled = styleFn(sentinel);
		const sentinelIndex = styled.indexOf(sentinel);
		return sentinelIndex >= 0 ? styled.slice(0, sentinelIndex) : "";
	}

	private getDefaultInlineStyleContext(): InlineStyleContext {
		return {
			applyText: (text: string) => this.applyDefaultStyle(text),
			stylePrefix: this.getDefaultStylePrefix(),
		};
	}

	private renderBlocks(nodes: readonly MarkdownNode[], width: number, styleContext?: InlineStyleContext): string[] {
		const lines: string[] = [];
		const groups = this.groupBlocks(nodes);
		for (let i = 0; i < groups.length; i++) {
			const group = groups[i];
			const next = groups[i + 1];
			lines.push(...this.renderBlock(group, width, styleContext));
			if (next && !(isElement(group, "p") && isElement(next) && LIST_TYPES.has(next.type))) {
				lines.push("");
			}
		}
		return lines;
	}

	private groupBlocks(nodes: readonly MarkdownNode[]): MarkdownElement[] {
		const groups: MarkdownElement[] = [];
		let inline: MarkdownNode[] = [];
		const flushInline = () => {
			if (inline.length > 0) groups.push({ type: "p", props: { children: inline } });
			inline = [];
		};
		for (const node of nodes) {
			if (isBlockNode(node)) {
				flushInline();
				groups.push(node as MarkdownElement);
			} else {
				inline.push(node);
			}
		}
		flushInline();
		return groups;
	}

	private renderBlock(node: MarkdownElement, width: number, styleContext?: InlineStyleContext): string[] {
		const lines: string[] = [];
		const headingLevel = HEADING_LEVELS[node.type];

		if (headingLevel !== undefined) {
			const headingPrefix = `${"#".repeat(headingLevel)} `;

			const headingStyleFn = (text: string) => this.theme.heading(text);

			const headingStyleContext: InlineStyleContext = {
				applyText: headingStyleFn,
				stylePrefix: this.getStylePrefix(headingStyleFn),
			};

			const headingText = this.renderInline(childrenOf(node), headingStyleContext);
			const styledHeading = headingLevel >= 3 ? headingStyleFn(headingPrefix) + headingText : headingText;
			lines.push(styledHeading);
			return lines;
		}

		switch (node.type) {
			case "p":
				lines.push(this.renderInline(childrenOf(node), styleContext));
				break;

			case "pre": {
				const indent = this.theme.codeBlockIndent ?? "  ";
				const language = typeof node.props.language === "string" ? node.props.language : "";
				lines.push(this.theme.codeBlockBorder(`\`\`\`${language}`));
				const code = plainText(childrenOf(node)).replace(/\n$/, "");
				for (const codeLine of code.split("\n")) {
					lines.push(`${indent}${this.theme.codeBlock(codeLine)}`);
				}
				lines.push(this.theme.codeBlockBorder("```"));
				break;
			}

			case "ul":
			case "ol":
				lines.push(...this.renderList(node, 0, width, styleContext));
				break;

			case "table":
				lines.push(...this.renderTable(node, width, styleContext));
				break;

			case "blockquote": {
				const quoteStyle = (text: string) => this.theme.quote(text);
				const quoteStylePrefix = this.getStylePrefix(quoteStyle);
				const applyQuoteStyle = (line: string): string => {
					if (!quoteStylePrefix) {
						return quoteStyle(line);
					}
					const lineWithReappliedStyle = line.replace(/\x1b\[0m/g, `\x1b[0m${quoteStylePrefix}`);
					return quoteStyle(lineWithReappliedStyle);
				};

				const quoteContentWidth = Math.max(1, width - 2);

				const quoteInlineStyleContext: InlineStyleContext = {
					applyText: (text: string) => text,
					stylePrefix: quoteStylePrefix,
				};
				const renderedQuoteLines = this.renderBlocks(childrenOf(node), quoteContentWidth, quoteInlineStyleContext);

				for (const quoteLine of renderedQuoteLines) {
					const styledLine = applyQuoteStyle(quoteLine);
					const wrappedLines = wrapTextWithAnsi(styledLine, quoteContentWidth);
					for (const wrappedLine of wrappedLines) {
						lines.push(this.theme.quoteBorder("│ ") + wrappedLine);
					}
				}
				break;
			}

			case "hr":
				lines.push(this.theme.hr("─".repeat(Math.min(width, 80))));
				break;

			case "html":
				lines.push(this.applyDefaultStyle(plainText(childrenOf(node)).trim()));
				break;
		}

		return lines;
	}

	private renderInline(nodes: readonly MarkdownNode[], styleContext?: InlineStyleContext): string {
		let result = "";
		const resolvedStyleContext = styleContext ?? this.getDefaultInlineStyleContext();
		const { applyText, stylePrefix } = resolvedStyleContext;
		const applyTextWithNewlines = (text: string): string => {
			const segments: string[] = text.split("\n");
			return segments.map((segment: string) => applyText(segment)).join("\n");
		};

		for (const node of nodes) {
			if (typeof node === "string") {
				result += applyTextWithNewlines(node);
				continue;
			}
			switch (node.type) {
				case "code":
					result += this.theme.code(plainText(childrenOf(node))) + stylePrefix;
					break;

				case "a": {
					const href = typeof node.props.href === "string" ? node.props.href : "";
					const linkText = this.renderInline(childrenOf(node), resolvedStyleContext);
					const styledLink = this.theme.link(linkText);
					if (getCapabilities().hyperlinks) {
						result += hyperlink(styledLink, href) + stylePrefix;
					} else {
						const text = plainText(childrenOf(node));
						const hrefForComparison = href.startsWith("mailto:") ? href.slice(7) : href;
						if (text === href || text === hrefForComparison) {
							result += styledLink + stylePrefix;
						} else {
							result += styledLink + this.theme.linkUrl(` (${href})`) + stylePrefix;
						}
					}
					break;
				}

				case "br":
					result += "\n";
					break;

				case "img":
					result += applyTextWithNewlines(typeof node.props.alt === "string" ? node.props.alt : "");
					break;

				default:
					result += this.renderInline(childrenOf(node), resolvedStyleContext);
			}
		}

		while (stylePrefix && result.endsWith(stylePrefix)) {
			result = result.slice(0, -stylePrefix.length);
		}

		return result;
	}

	private renderList(
		list: MarkdownElement,
		depth: number,
		width: number,
		styleContext?: InlineStyleContext,
	): string[] {
		const lines: string[] = [];
		const indent = "    ".repeat(depth);
		const items = childrenOf(list).filter((item): item is MarkdownElement => isElement(item, "li"));
		const ordered = list.type === "ol";
		const startNumber = typeof list.props.start === "number" ? list.props.start : 1;
		const loose = items.some((item) => childrenOf(item).some((child) => isElement(child, "p")));

		for (let i = 0; i < items.length; i++) {
			const item = items[i];
			const isLastItem = i === items.length - 1;
			const bullet = ordered ? `${startNumber + i}. ` : "- ";
			const checked = item.props.checked;
			const taskMarker = typeof checked === "boolean" ? `[${checked ? "x" : " "}] ` : "";
			const marker = bullet + taskMarker;
			const firstPrefix = indent + this.theme.listBullet(marker);
			const continuationPrefix = indent + " ".repeat(visibleWidth(marker));
			const itemWidth = Math.max(1, width - visibleWidth(firstPrefix));
			let renderedAnyLine = false;

			for (const child of this.groupBlocks(childrenOf(item))) {
				if (LIST_TYPES.has(child.type)) {
					lines.push(...this.renderList(child, depth + 1, width, styleContext));
					renderedAnyLine = true;
					continue;
				}

				const itemLines = this.renderBlock(child, itemWidth, styleContext);
				if (loose && renderedAnyLine) lines.push("");
				for (const line of itemLines) {
					for (const wrappedLine of wrapTextWithAnsi(line, itemWidth)) {
						const linePrefix = renderedAnyLine ? continuationPrefix : firstPrefix;
						lines.push(linePrefix + wrappedLine);
						renderedAnyLine = true;
					}
				}
			}

			if (!renderedAnyLine) {
				lines.push(firstPrefix);
			}

			if (loose && !isLastItem) {
				lines.push("");
			}
		}

		return lines;
	}

	private getLongestWordWidth(text: string, maxWidth?: number): number {
		const words = text.split(/\s+/).filter((word) => word.length > 0);
		let longest = 0;
		for (const word of words) {
			longest = Math.max(longest, visibleWidth(word));
		}
		if (maxWidth === undefined) {
			return longest;
		}
		return Math.min(longest, maxWidth);
	}

	private wrapCellText(text: string, maxWidth: number, stylePrefix = ""): string[] {
		const lines = wrapTextWithAnsi(text, Math.max(1, maxWidth));
		return lines.map((line, index) => {
			const styleReset = index < lines.length - 1 ? "\x1b[22;23;24;25;27;28;29;39m" : "";
			return `${line}${styleReset}${stylePrefix}`;
		});
	}

	private renderTable(table: MarkdownElement, availableWidth: number, styleContext?: InlineStyleContext): string[] {
		const lines: string[] = [];
		const rowsOf = (section: string): MarkdownNode[][][] =>
			childrenOf(table)
				.filter((child): child is MarkdownElement => isElement(child, section))
				.flatMap((sectionNode) => childrenOf(sectionNode).filter((row): row is MarkdownElement => isElement(row, "tr")))
				.map((row) =>
					childrenOf(row)
						.filter((cell): cell is MarkdownElement => isElement(cell))
						.map((cell) => childrenOf(cell)),
				);
		const header = rowsOf("thead")[0] ?? [];
		const rows = rowsOf("tbody");
		const numCols = header.length;

		if (numCols === 0) {
			return lines;
		}

		const borderOverhead = 3 * numCols + 1;
		const availableForCells = availableWidth - borderOverhead;
		if (availableForCells < numCols) {
			const markdownRows = [header, ...rows].map((row) => `| ${row.map((cell) => plainText(cell)).join(" | ")} |`);
			return markdownRows.flatMap((row) => wrapTextWithAnsi(row, availableWidth));
		}

		const maxUnbrokenWordWidth = 30;

		const naturalWidths: number[] = [];
		const minWordWidths: number[] = [];
		for (let i = 0; i < numCols; i++) {
			const headerText = this.renderInline(header[i], styleContext);
			naturalWidths[i] = visibleWidth(headerText);
			minWordWidths[i] = Math.max(1, this.getLongestWordWidth(headerText, maxUnbrokenWordWidth));
		}
		for (const row of rows) {
			for (let i = 0; i < row.length; i++) {
				const cellText = this.renderInline(row[i], styleContext);
				naturalWidths[i] = Math.max(naturalWidths[i] || 0, visibleWidth(cellText));
				minWordWidths[i] = Math.max(
					minWordWidths[i] || 1,
					this.getLongestWordWidth(cellText, maxUnbrokenWordWidth),
				);
			}
		}

		let minColumnWidths = minWordWidths;
		let minCellsWidth = minColumnWidths.reduce((a, b) => a + b, 0);

		if (minCellsWidth > availableForCells) {
			minColumnWidths = new Array(numCols).fill(1);
			const remaining = availableForCells - numCols;

			if (remaining > 0) {
				const totalWeight = minWordWidths.reduce((total, width) => total + Math.max(0, width - 1), 0);
				const growth = minWordWidths.map((width) => {
					const weight = Math.max(0, width - 1);
					return totalWeight > 0 ? Math.floor((weight / totalWeight) * remaining) : 0;
				});

				for (let i = 0; i < numCols; i++) {
					minColumnWidths[i] += growth[i] ?? 0;
				}

				const allocated = growth.reduce((total, width) => total + width, 0);
				let leftover = remaining - allocated;
				for (let i = 0; leftover > 0 && i < numCols; i++) {
					minColumnWidths[i]++;
					leftover--;
				}
			}

			minCellsWidth = minColumnWidths.reduce((a, b) => a + b, 0);
		}

		const totalNaturalWidth = naturalWidths.reduce((a, b) => a + b, 0) + borderOverhead;
		let columnWidths: number[];

		if (totalNaturalWidth <= availableWidth) {
			columnWidths = naturalWidths.map((width, index) => Math.max(width, minColumnWidths[index]));
		} else {
			const totalGrowPotential = naturalWidths.reduce((total, width, index) => {
				return total + Math.max(0, width - minColumnWidths[index]);
			}, 0);
			const extraWidth = Math.max(0, availableForCells - minCellsWidth);
			columnWidths = minColumnWidths.map((minWidth, index) => {
				const naturalWidth = naturalWidths[index];
				const minWidthDelta = Math.max(0, naturalWidth - minWidth);
				let grow = 0;
				if (totalGrowPotential > 0) {
					grow = Math.floor((minWidthDelta / totalGrowPotential) * extraWidth);
				}
				return minWidth + grow;
			});

			const allocated = columnWidths.reduce((a, b) => a + b, 0);
			let remaining = availableForCells - allocated;
			while (remaining > 0) {
				let grew = false;
				for (let i = 0; i < numCols && remaining > 0; i++) {
					if (columnWidths[i] < naturalWidths[i]) {
						columnWidths[i]++;
						remaining--;
						grew = true;
					}
				}
				if (!grew) {
					break;
				}
			}
		}

		const topBorderCells = columnWidths.map((w) => "─".repeat(w));
		lines.push(`┌─${topBorderCells.join("─┬─")}─┐`);

		const headerCellLines: string[][] = header.map((cell, i) => {
			const text = this.renderInline(cell, styleContext);
			return this.wrapCellText(text, columnWidths[i], styleContext?.stylePrefix);
		});
		const headerLineCount = Math.max(...headerCellLines.map((c) => c.length));

		for (let lineIdx = 0; lineIdx < headerLineCount; lineIdx++) {
			const rowParts = headerCellLines.map((cellLines, colIdx) => {
				const text = cellLines[lineIdx] || "";
				return text + " ".repeat(Math.max(0, columnWidths[colIdx] - visibleWidth(text)));
			});
			lines.push(`│ ${rowParts.join(" │ ")} │`);
		}

		const separatorCells = columnWidths.map((w) => "─".repeat(w));
		const separatorLine = `├─${separatorCells.join("─┼─")}─┤`;
		lines.push(separatorLine);

		for (let rowIndex = 0; rowIndex < rows.length; rowIndex++) {
			const row = rows[rowIndex];
			const rowCellLines: string[][] = row.map((cell, i) => {
				const text = this.renderInline(cell, styleContext);
				return this.wrapCellText(text, columnWidths[i], styleContext?.stylePrefix);
			});
			const rowLineCount = Math.max(...rowCellLines.map((c) => c.length));

			for (let lineIdx = 0; lineIdx < rowLineCount; lineIdx++) {
				const rowParts = rowCellLines.map((cellLines, colIdx) => {
					const text = cellLines[lineIdx] || "";
					return text + " ".repeat(Math.max(0, columnWidths[colIdx] - visibleWidth(text)));
				});
				lines.push(`│ ${rowParts.join(" │ ")} │`);
			}

			if (rowIndex < rows.length - 1) {
				lines.push(separatorLine);
			}
		}

		const bottomBorderCells = columnWidths.map((w) => "─".repeat(w));
		lines.push(`└─${bottomBorderCells.join("─┴─")}─┘`);

		return lines;
	}
}
