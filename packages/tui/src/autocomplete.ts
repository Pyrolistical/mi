import { readdirSync, statSync } from "fs";
import { homedir } from "os";
import { join } from "path";
import { fuzzyFilter } from "./fuzzy.ts";
import { autocompleteBoundaryRegex, autocompleteSeparatorRegex } from "./utils.ts";

const PATH_DELIMITERS = new Set([" ", "\t", '"', "'", "="]);
const tokenStartRegex = new RegExp(`${autocompleteBoundaryRegex.source}$`, "u");
const PATH_WRAPPERS: Record<string, string> = { "(": ")", "[": "]", "{": "}", "<": ">", "`": "`" };

const nameCollator = new Intl.Collator(undefined, { ignorePunctuation: true, caseFirst: "upper" });

function compareNames(a: string, b: string): number {
	return nameCollator.compare(a, b) || (a < b ? -1 : a > b ? 1 : 0);
}

function longestCommonPrefix(values: string[]): string {
	let common = values[0] ?? "";
	for (const value of values) {
		let length = 0;
		while (length < common.length && length < value.length && common[length] === value[length]) length++;
		common = common.slice(0, length);
	}
	return common;
}

function isDirectoryPath(path: string): boolean {
	try {
		return statSync(path).isDirectory();
	} catch {
		return false;
	}
}

function findLastDelimiter(text: string): number {
	let lastDelimiter = -1;
	let index = 0;
	for (const character of text) {
		index += character.length;
		if (PATH_DELIMITERS.has(character) || autocompleteSeparatorRegex.test(character)) {
			lastDelimiter = index - 1;
		}
	}
	return lastDelimiter;
}

function stripLeadingWrappers(token: string): string {
	let result = token;
	while (result.length > 0) {
		const closer = PATH_WRAPPERS[result[0]!];
		if (!closer || result.includes(closer, 1)) {
			break;
		}
		result = result.slice(1);
	}
	return result;
}

function findUnclosedQuoteStart(text: string): number | null {
	let inQuotes = false;
	let quoteStart = -1;

	for (let i = 0; i < text.length; i += 1) {
		if (text[i] === '"') {
			inQuotes = !inQuotes;
			if (inQuotes) {
				quoteStart = i;
			}
		}
	}

	return inQuotes ? quoteStart : null;
}

function isTokenStart(text: string, index: number): boolean {
	let start = index;
	while (start > 0 && PATH_WRAPPERS[text[start - 1]!]) {
		start -= 1;
	}
	return PATH_DELIMITERS.has(text[start - 1] ?? "") || tokenStartRegex.test(text.slice(0, start));
}

function extractQuotedPrefix(text: string): string | null {
	const quoteStart = findUnclosedQuoteStart(text);
	if (quoteStart === null) {
		return null;
	}

	if (quoteStart > 0 && text[quoteStart - 1] === "@") {
		if (!isTokenStart(text, quoteStart - 1)) {
			return null;
		}
		return text.slice(quoteStart - 1);
	}

	if (!isTokenStart(text, quoteStart)) {
		return null;
	}

	return text.slice(quoteStart);
}

function parsePathPrefix(prefix: string): { rawPrefix: string; isAtPrefix: boolean; isQuotedPrefix: boolean } {
	if (prefix.startsWith('@"')) {
		return { rawPrefix: prefix.slice(2), isAtPrefix: true, isQuotedPrefix: true };
	}
	if (prefix.startsWith('"')) {
		return { rawPrefix: prefix.slice(1), isAtPrefix: false, isQuotedPrefix: true };
	}
	if (prefix.startsWith("@")) {
		return { rawPrefix: prefix.slice(1), isAtPrefix: true, isQuotedPrefix: false };
	}
	return { rawPrefix: prefix, isAtPrefix: false, isQuotedPrefix: false };
}

function needsQuotes(path: string, isQuotedPrefix: boolean): boolean {
	return isQuotedPrefix || autocompleteSeparatorRegex.test(path);
}

function buildOpenCompletionValue(path: string, options: { isAtPrefix: boolean; isQuotedPrefix: boolean }): string {
	const at = options.isAtPrefix ? "@" : "";
	const quote = needsQuotes(path, options.isQuotedPrefix) ? '"' : "";
	return `${at}${quote}${path}`;
}

function buildCompletionValue(path: string, options: { isAtPrefix: boolean; isQuotedPrefix: boolean }): string {
	const closeQuote = needsQuotes(path, options.isQuotedPrefix) ? '"' : "";
	return `${buildOpenCompletionValue(path, options)}${closeQuote}`;
}

function toDotRelative(value: string): string {
	const quote = value.startsWith('"') ? '"' : "";
	const path = value.slice(quote.length);
	if (/^(\.{1,2}\/|\/|~)/.test(path)) {
		return value;
	}
	return `${quote}./${path}`;
}

export interface AutocompleteItem {
	value: string;
	label: string;
	description?: string;
}

type Awaitable<T> = T | Promise<T>;

export interface SlashCommand {
	name: string;
	description?: string;
	argumentHint?: string;
	getArgumentCompletions?(argumentPrefix: string): Awaitable<AutocompleteItem[] | null>;
}

export interface AutocompleteSuggestions {
	items: AutocompleteItem[];
	prefix: string;
	commonPrefix?: string;
}

export interface AutocompleteProvider {
	triggerCharacters?: string[];

	getSuggestions(
		lines: string[],
		cursorLine: number,
		cursorCol: number,
		options: { signal: AbortSignal; force?: boolean },
	): Promise<AutocompleteSuggestions | null>;

	applyCompletion(
		lines: string[],
		cursorLine: number,
		cursorCol: number,
		item: AutocompleteItem,
		prefix: string,
	): {
		lines: string[];
		cursorLine: number;
		cursorCol: number;
	};

	shouldTriggerFileCompletion?(lines: string[], cursorLine: number, cursorCol: number): boolean;
}

export class CombinedAutocompleteProvider implements AutocompleteProvider {
	private commands: (SlashCommand | AutocompleteItem)[];
	private basePath: string;

	constructor(commands: (SlashCommand | AutocompleteItem)[] = [], basePath: string) {
		this.commands = commands;
		this.basePath = basePath;
	}

	async getSuggestions(
		lines: string[],
		cursorLine: number,
		cursorCol: number,
		options: { signal: AbortSignal; force?: boolean },
	): Promise<AutocompleteSuggestions | null> {
		const currentLine = lines[cursorLine] || "";
		const textBeforeCursor = currentLine.slice(0, cursorCol);

		const atPrefix = this.extractAtPrefix(textBeforeCursor);
		if (atPrefix) {
			return this.getFileSuggestions(atPrefix);
		}

		if (!options.force && textBeforeCursor.startsWith("/")) {
			const spaceIndex = textBeforeCursor.indexOf(" ");

			if (spaceIndex === -1) {
				const prefix = textBeforeCursor.slice(1);
				const commandItems = this.commands.map((cmd) => {
					const name = "name" in cmd ? cmd.name : cmd.value;
					const hint = "argumentHint" in cmd && cmd.argumentHint ? cmd.argumentHint : undefined;
					const desc = cmd.description ?? "";
					const fullDesc = hint ? (desc ? `${hint} — ${desc}` : hint) : desc;
					return {
						name,
						label: name,
						description: fullDesc || undefined,
					};
				});

				const bareNameMatches = fuzzyFilter(commandItems, prefix, (item) =>
					item.name.startsWith("skill:") ? item.name.slice("skill:".length) : item.name,
				);
				const bareNameMatchSet = new Set(bareNameMatches);
				const fullNameOnlyMatches = fuzzyFilter(
					commandItems.filter((item) => item.name.startsWith("skill:") && !bareNameMatchSet.has(item)),
					prefix,
					(item) => item.name,
				);
				const filtered = [...bareNameMatches, ...fullNameOnlyMatches].map((item) => ({
					value: item.name,
					label: item.label,
					...(item.description && { description: item.description }),
				}));

				if (filtered.length === 0) return null;

				return {
					items: filtered,
					prefix: textBeforeCursor,
				};
			}

			const commandName = textBeforeCursor.slice(1, spaceIndex);
			const argumentText = textBeforeCursor.slice(spaceIndex + 1);

			const command = this.commands.find((cmd) => {
				const name = "name" in cmd ? cmd.name : cmd.value;
				return name === commandName;
			});
			if (!command || !("getArgumentCompletions" in command) || !command.getArgumentCompletions) {
				return null;
			}

			const argumentSuggestions = await command.getArgumentCompletions(argumentText);
			if (!Array.isArray(argumentSuggestions) || argumentSuggestions.length === 0) {
				return null;
			}

			const common = longestCommonPrefix(argumentSuggestions.map((item) => item.value));
			return {
				items: argumentSuggestions,
				prefix: argumentText,
				...(argumentSuggestions.length > 1 &&
					common.length > argumentText.length &&
					common.startsWith(argumentText) && { commonPrefix: common }),
			};
		}

		const pathMatch = this.extractPathPrefix(textBeforeCursor, options.force ?? false);
		if (pathMatch === null) {
			return null;
		}

		return this.getFileSuggestions(pathMatch);
	}

	applyCompletion(
		lines: string[],
		cursorLine: number,
		cursorCol: number,
		item: AutocompleteItem,
		prefix: string,
	): { lines: string[]; cursorLine: number; cursorCol: number } {
		const currentLine = lines[cursorLine] || "";
		const beforePrefix = currentLine.slice(0, cursorCol - prefix.length);
		const afterCursor = currentLine.slice(cursorCol);
		const isQuotedPrefix = prefix.startsWith('"') || prefix.startsWith('@"');
		const hasLeadingQuoteAfterCursor = afterCursor.startsWith('"');
		const hasTrailingQuoteInItem = item.value.endsWith('"');
		const adjustedAfterCursor =
			isQuotedPrefix && hasTrailingQuoteInItem && hasLeadingQuoteAfterCursor ? afterCursor.slice(1) : afterCursor;

		const isSlashCommand = prefix.startsWith("/") && beforePrefix.trim() === "" && !prefix.slice(1).includes("/");
		if (isSlashCommand) {
			const newLine = `${beforePrefix}/${item.value} ${adjustedAfterCursor}`;
			const newLines = [...lines];
			newLines[cursorLine] = newLine;

			return {
				lines: newLines,
				cursorLine,
				cursorCol: beforePrefix.length + item.value.length + 2,
			};
		}

		if (prefix.startsWith("@")) {
			const isDirectory = item.label.endsWith("/");
			const suffix = isDirectory || adjustedAfterCursor !== "" ? "" : " ";
			const value = isDirectory ? item.value : toDotRelative(item.value.slice(1));
			const newLine = `${beforePrefix + value}${suffix}${adjustedAfterCursor}`;
			const newLines = [...lines];
			newLines[cursorLine] = newLine;

			const hasTrailingQuote = value.endsWith('"');
			const cursorOffset = isDirectory && hasTrailingQuote ? value.length - 1 : value.length;

			return {
				lines: newLines,
				cursorLine,
				cursorCol: beforePrefix.length + cursorOffset + suffix.length,
			};
		}

		const textBeforeCursor = currentLine.slice(0, cursorCol);
		if (textBeforeCursor.includes("/") && textBeforeCursor.includes(" ")) {
			const newLine = beforePrefix + item.value + adjustedAfterCursor;
			const newLines = [...lines];
			newLines[cursorLine] = newLine;

			const isDirectory = item.label.endsWith("/");
			const hasTrailingQuote = item.value.endsWith('"');
			const cursorOffset = isDirectory && hasTrailingQuote ? item.value.length - 1 : item.value.length;

			return {
				lines: newLines,
				cursorLine,
				cursorCol: beforePrefix.length + cursorOffset,
			};
		}

		const newLine = beforePrefix + item.value + adjustedAfterCursor;
		const newLines = [...lines];
		newLines[cursorLine] = newLine;

		const isDirectory = item.label.endsWith("/");
		const hasTrailingQuote = item.value.endsWith('"');
		const cursorOffset = isDirectory && hasTrailingQuote ? item.value.length - 1 : item.value.length;

		return {
			lines: newLines,
			cursorLine,
			cursorCol: beforePrefix.length + cursorOffset,
		};
	}

	private extractAtPrefix(text: string): string | null {
		const quotedPrefix = extractQuotedPrefix(text);
		if (quotedPrefix?.startsWith('@"')) {
			return quotedPrefix;
		}

		const lastDelimiterIndex = findLastDelimiter(text);
		const token = stripLeadingWrappers(lastDelimiterIndex === -1 ? text : text.slice(lastDelimiterIndex + 1));

		if (token.startsWith("@")) {
			return token;
		}

		return null;
	}

	private extractPathPrefix(text: string, forceExtract: boolean = false): string | null {
		const quotedPrefix = extractQuotedPrefix(text);
		if (quotedPrefix) {
			return quotedPrefix;
		}

		const lastDelimiterIndex = findLastDelimiter(text);
		const pathPrefix = stripLeadingWrappers(lastDelimiterIndex === -1 ? text : text.slice(lastDelimiterIndex + 1));

		if (forceExtract) {
			return pathPrefix;
		}

		if (pathPrefix.includes("/") || pathPrefix.startsWith(".") || pathPrefix.startsWith("~/")) {
			return pathPrefix;
		}

		if (pathPrefix === "" && text !== "" && tokenStartRegex.test(text)) {
			return pathPrefix;
		}

		return null;
	}

	private expandHomePath(path: string): string {
		if (path.startsWith("~/")) {
			const expandedPath = join(homedir(), path.slice(2));
			return path.endsWith("/") && !expandedPath.endsWith("/") ? `${expandedPath}/` : expandedPath;
		} else if (path === "~") {
			return homedir();
		}
		return path;
	}

	private getFileSuggestions(prefix: string): AutocompleteSuggestions | null {
		const { rawPrefix, isAtPrefix, isQuotedPrefix } = parsePathPrefix(prefix);
		const dirPart = rawPrefix === "~" ? "~/" : rawPrefix.slice(0, rawPrefix.lastIndexOf("/") + 1);
		const searchPrefix = rawPrefix.slice(dirPart.length);
		const expandedDir = this.expandHomePath(dirPart);
		const searchDir = expandedDir.startsWith("/") ? expandedDir : join(this.basePath, expandedDir);

		let dirEntries;
		try {
			dirEntries = readdirSync(searchDir, { withFileTypes: true });
		} catch {
			return null;
		}
		const entries = dirEntries
			.filter((entry) => entry.name.startsWith(searchPrefix))
			.map((entry) => ({
				name: entry.name,
				isDirectory:
					entry.isDirectory() || (entry.isSymbolicLink() && isDirectoryPath(join(searchDir, entry.name))),
			}));
		for (const name of [".", ".."]) {
			if (searchPrefix.startsWith(".") && name.startsWith(searchPrefix)) {
				entries.push({ name, isDirectory: true });
			}
		}
		if (entries.length === 0) return null;
		entries.sort((a, b) => compareNames(a.name, b.name));

		const options = { isAtPrefix, isQuotedPrefix };
		const paths = entries.map((entry) => `${dirPart}${entry.name}${entry.isDirectory ? "/" : ""}`);
		const common = longestCommonPrefix(paths);
		return {
			items: entries.map((entry, index) => ({
				value: buildCompletionValue(paths[index]!, options),
				label: entry.name + (entry.isDirectory ? "/" : ""),
			})),
			prefix,
			...(entries.length > 1 &&
				common.length > rawPrefix.length && { commonPrefix: buildOpenCompletionValue(common, options) }),
		};
	}

	shouldTriggerFileCompletion(lines: string[], cursorLine: number, cursorCol: number): boolean {
		const currentLine = lines[cursorLine] || "";
		const textBeforeCursor = currentLine.slice(0, cursorCol);

		if (textBeforeCursor.trim().startsWith("/") && !textBeforeCursor.trim().includes(" ")) {
			return false;
		}

		return true;
	}
}
