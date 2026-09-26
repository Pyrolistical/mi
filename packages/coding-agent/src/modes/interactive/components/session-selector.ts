import * as os from "node:os";
import {
	type Component,
	Container,
	type Focusable,
	getKeybindings,
	Input,
	Spacer,
	Text,
	truncateToWidth,
	visibleWidth,
} from "@earendil-works/pi-tui";
import { KeybindingsManager } from "../../../core/keybindings.ts";
import type { SessionInfo } from "../../../core/session-manager.ts";
import { theme } from "../theme/theme.ts";
import { DynamicBorder } from "./dynamic-border.ts";
import { keyHint, keyText } from "./keybinding-hints.ts";
import { filterAndSortSessions, hasSessionName, type NameFilter, type SortMode } from "./session-selector-search.ts";

type SessionScope = "current" | "all";

function shortenPath(path: string): string {
	const home = os.homedir();
	if (!path) return path;
	if (path.startsWith(home)) {
		return `~${path.slice(home.length)}`;
	}
	return path;
}

function formatSessionDate(date: Date): string {
	const now = new Date();
	const diffMs = now.getTime() - date.getTime();
	const diffMins = Math.floor(diffMs / 60000);
	const diffHours = Math.floor(diffMs / 3600000);
	const diffDays = Math.floor(diffMs / 86400000);

	if (diffMins < 1) return "now";
	if (diffMins < 60) return `${diffMins}m`;
	if (diffHours < 24) return `${diffHours}h`;
	if (diffDays < 7) return `${diffDays}d`;
	if (diffDays < 30) return `${Math.floor(diffDays / 7)}w`;
	if (diffDays < 365) return `${Math.floor(diffDays / 30)}mo`;
	return `${Math.floor(diffDays / 365)}y`;
}

class SessionSelectorHeader implements Component {
	private scope: SessionScope;
	private sortMode: SortMode;
	private nameFilter: NameFilter;
	private requestRender: () => void;
	private showId = false;
	private confirmingDeleteId: string | null = null;
	private statusMessage: { type: "info" | "error"; message: string } | null = null;
	private statusTimeout: ReturnType<typeof setTimeout> | null = null;
	private showRenameHint = false;

	constructor(scope: SessionScope, sortMode: SortMode, nameFilter: NameFilter, requestRender: () => void) {
		this.scope = scope;
		this.sortMode = sortMode;
		this.nameFilter = nameFilter;
		this.requestRender = requestRender;
	}

	setScope(scope: SessionScope): void {
		this.scope = scope;
	}

	setSortMode(sortMode: SortMode): void {
		this.sortMode = sortMode;
	}

	setNameFilter(nameFilter: NameFilter): void {
		this.nameFilter = nameFilter;
	}

	setShowId(showId: boolean): void {
		this.showId = showId;
	}

	setShowRenameHint(show: boolean): void {
		this.showRenameHint = show;
	}

	setConfirmingDeleteId(id: string | null): void {
		this.confirmingDeleteId = id;
	}

	private clearStatusTimeout(): void {
		if (!this.statusTimeout) return;
		clearTimeout(this.statusTimeout);
		this.statusTimeout = null;
	}

	setStatusMessage(msg: { type: "info" | "error"; message: string } | null, autoHideMs?: number): void {
		this.clearStatusTimeout();
		this.statusMessage = msg;
		if (!msg || !autoHideMs) return;

		this.statusTimeout = setTimeout(() => {
			this.statusMessage = null;
			this.statusTimeout = null;
			this.requestRender();
		}, autoHideMs);
	}

	invalidate(): void {}

	render(width: number): string[] {
		const title = this.scope === "current" ? "Resume Session (Current Folder)" : "Resume Session (All)";
		const leftText = title;

		const sortLabel = this.sortMode === "threaded" ? "Threaded" : this.sortMode === "recent" ? "Recent" : "Fuzzy";
		const sortText = theme.fg("muted", "Sort: ") + theme.fg("accent", sortLabel);

		const nameLabel = this.nameFilter === "all" ? "All" : "Named";
		const nameText = theme.fg("muted", "Name: ") + theme.fg("accent", nameLabel);

		let scopeText: string;
		if (this.scope === "current") {
			scopeText = `${theme.fg("accent", "◉ Current Folder")}${theme.fg("muted", " | ○ All")}`;
		} else {
			scopeText = `${theme.fg("muted", "○ Current Folder | ")}${theme.fg("accent", "◉ All")}`;
		}

		const rightText = truncateToWidth(`${scopeText}  ${nameText}  ${sortText}`, width, "");
		const availableLeft = Math.max(0, width - visibleWidth(rightText) - 1);
		const left = truncateToWidth(leftText, availableLeft, "");
		const spacing = Math.max(0, width - visibleWidth(left) - visibleWidth(rightText));

		let hintLine1: string;
		let hintLine2: string;
		if (this.confirmingDeleteId !== null) {
			const confirmHint = `Delete session? ${keyHint("tui.select.confirm", "confirm")} · ${keyHint("tui.select.cancel", "cancel")}`;
			hintLine1 = theme.fg("error", truncateToWidth(confirmHint, width, "…"));
			hintLine2 = "";
		} else if (this.statusMessage) {
			const color = this.statusMessage.type === "error" ? "error" : "accent";
			hintLine1 = theme.fg(color, truncateToWidth(this.statusMessage.message, width, "…"));
			hintLine2 = "";
		} else {
			const idState = this.showId ? "(on)" : "(off)";
			const sep = theme.fg("muted", " · ");
			const hint1 =
				keyHint("tui.input.tab", "scope") + sep + theme.fg("muted", 're:<pattern> regex · "phrase" exact');
			const hint2Parts = [
				keyHint("app.session.toggleSort", "sort"),
				keyHint("app.session.toggleNamedFilter", "named"),
				keyHint("app.session.delete", "delete"),
				keyHint("app.session.toggleId", `id ${idState}`),
			];
			if (this.showRenameHint) {
				hint2Parts.push(keyHint("app.session.rename", "rename"));
			}
			const hint2 = hint2Parts.join(sep);
			hintLine1 = truncateToWidth(hint1, width, "…");
			hintLine2 = truncateToWidth(hint2, width, "…");
		}

		return [`${left}${" ".repeat(spacing)}${rightText}`, hintLine1, hintLine2];
	}
}

interface SessionTreeNode {
	session: SessionInfo;
	children: SessionTreeNode[];
	latestActivity: number;
}

interface FlatSessionNode {
	session: SessionInfo;
	depth: number;
	isLast: boolean;
	ancestorContinues: boolean[];
}

function buildSessionTree(sessions: SessionInfo[]): SessionTreeNode[] {
	const byId = new Map<string, SessionTreeNode>();

	for (const session of sessions) {
		byId.set(session.id, { session, children: [], latestActivity: session.modified.getTime() });
	}

	const roots: SessionTreeNode[] = [];

	for (const session of sessions) {
		const node = byId.get(session.id)!;
		const parent = session.parentSessionId ? byId.get(session.parentSessionId) : undefined;

		if (parent) {
			parent.children.push(node);
		} else {
			roots.push(node);
		}
	}

	const updateLatestActivity = (node: SessionTreeNode): number => {
		let latestActivity = node.session.modified.getTime();
		for (const child of node.children) {
			latestActivity = Math.max(latestActivity, updateLatestActivity(child));
		}
		node.latestActivity = latestActivity;
		return latestActivity;
	};

	for (const root of roots) {
		updateLatestActivity(root);
	}

	const sortNodes = (nodes: SessionTreeNode[]): void => {
		nodes.sort((a, b) => b.latestActivity - a.latestActivity);
		for (const node of nodes) {
			sortNodes(node.children);
		}
	};
	sortNodes(roots);

	return roots;
}

function flattenSessionTree(roots: SessionTreeNode[]): FlatSessionNode[] {
	const result: FlatSessionNode[] = [];

	const walk = (node: SessionTreeNode, depth: number, ancestorContinues: boolean[], isLast: boolean): void => {
		result.push({ session: node.session, depth, isLast, ancestorContinues });

		for (let i = 0; i < node.children.length; i++) {
			const childIsLast = i === node.children.length - 1;
			const continues = depth > 0 ? !isLast : false;
			walk(node.children[i]!, depth + 1, [...ancestorContinues, continues], childIsLast);
		}
	};

	for (let i = 0; i < roots.length; i++) {
		walk(roots[i]!, 0, [], i === roots.length - 1);
	}

	return result;
}

class SessionList implements Component, Focusable {
	public getSelectedSessionId(): string | undefined {
		const selected = this.filteredSessions[this.selectedIndex];
		return selected?.session.id;
	}
	private allSessions: SessionInfo[] = [];
	private filteredSessions: FlatSessionNode[] = [];
	private selectedIndex: number = 0;
	private selectionTouched = false;
	private searchInput: Input;
	private showCwd = false;
	private sortMode: SortMode = "threaded";
	private nameFilter: NameFilter = "all";
	private keybindings: KeybindingsManager;
	private showId = false;
	private confirmingDeleteId: string | null = null;
	private currentSessionId?: string;
	public onSelect?: (sessionId: string) => void;
	public onCancel?: () => void;
	public onExit: () => void = () => {};
	public onToggleScope?: () => void;
	public onToggleSort?: () => void;
	public onToggleNameFilter?: () => void;
	public onToggleId?: (showId: boolean) => void;
	public onDeleteConfirmationChange?: (id: string | null) => void;
	public onDeleteSession?: (sessionId: string) => void;
	public onRenameSession?: (sessionId: string) => void;
	public onError?: (message: string) => void;
	private maxVisible: number = 10;

	private _focused = false;
	get focused(): boolean {
		return this._focused;
	}
	set focused(value: boolean) {
		this._focused = value;
		this.searchInput.focused = value;
	}

	constructor(
		sessions: SessionInfo[],
		showCwd: boolean,
		sortMode: SortMode,
		nameFilter: NameFilter,
		keybindings: KeybindingsManager,
		currentSessionId?: string,
	) {
		this.allSessions = sessions;
		this.filteredSessions = [];
		this.searchInput = new Input();
		this.showCwd = showCwd;
		this.sortMode = sortMode;
		this.nameFilter = nameFilter;
		this.keybindings = keybindings;
		this.currentSessionId = currentSessionId;
		this.filterSessions("");

		this.searchInput.onSubmit = () => {
			if (this.filteredSessions[this.selectedIndex]) {
				const selected = this.filteredSessions[this.selectedIndex];
				if (this.onSelect) {
					this.onSelect(selected.session.id);
				}
			}
		};
	}

	setSortMode(sortMode: SortMode): void {
		this.sortMode = sortMode;
		this.filterSessions(this.searchInput.getValue());
	}

	setNameFilter(nameFilter: NameFilter): void {
		this.nameFilter = nameFilter;
		this.filterSessions(this.searchInput.getValue());
	}

	setSessions(sessions: SessionInfo[], showCwd: boolean): void {
		const selectedId = this.selectionTouched ? this.getSelectedSessionId() : undefined;
		this.allSessions = sessions;
		this.showCwd = showCwd;
		this.filterSessions(this.searchInput.getValue());
		if (!this.selectionTouched) {
			this.selectedIndex = 0;
		} else if (selectedId) {
			const selectedIndex = this.filteredSessions.findIndex((node) => node.session.id === selectedId);
			if (selectedIndex >= 0) this.selectedIndex = selectedIndex;
		}
	}

	private filterSessions(query: string): void {
		const trimmed = query.trim();
		const nameFiltered =
			this.nameFilter === "all" ? this.allSessions : this.allSessions.filter((session) => hasSessionName(session));

		if (this.sortMode === "threaded" && !trimmed) {
			const roots = buildSessionTree(nameFiltered);
			this.filteredSessions = flattenSessionTree(roots);
		} else {
			const filtered = filterAndSortSessions(nameFiltered, query, this.sortMode, "all");
			this.filteredSessions = filtered.map((session) => ({
				session,
				depth: 0,
				isLast: true,
				ancestorContinues: [],
			}));
		}
		this.selectedIndex = Math.min(this.selectedIndex, Math.max(0, this.filteredSessions.length - 1));
	}

	private setConfirmingDeleteId(id: string | null): void {
		this.confirmingDeleteId = id;
		this.onDeleteConfirmationChange?.(id);
	}

	private startDeleteConfirmationForSelectedSession(): void {
		const selected = this.filteredSessions[this.selectedIndex];
		if (!selected) return;

		if (selected.session.id === this.currentSessionId) {
			this.onError?.("Cannot delete the currently active session");
			return;
		}

		this.setConfirmingDeleteId(selected.session.id);
	}

	invalidate(): void {}

	render(width: number): string[] {
		const lines: string[] = [];

		lines.push(...this.searchInput.render(width));
		lines.push("");

		if (this.filteredSessions.length === 0) {
			let emptyMessage: string;
			if (this.nameFilter === "named") {
				const toggleKey = keyText("app.session.toggleNamedFilter");
				if (this.showCwd) {
					emptyMessage = `  No named sessions found. Press ${toggleKey} to show all.`;
				} else {
					emptyMessage = `  No named sessions in current folder. Press ${toggleKey} to show all, or Tab to view all.`;
				}
			} else if (this.showCwd) {
				emptyMessage = "  No sessions found";
			} else {
				emptyMessage = "  No sessions in current folder. Press Tab to view all.";
			}
			lines.push(theme.fg("muted", truncateToWidth(emptyMessage, width, "…")));
			return lines;
		}

		const startIndex = Math.max(
			0,
			Math.min(this.selectedIndex - Math.floor(this.maxVisible / 2), this.filteredSessions.length - this.maxVisible),
		);
		const endIndex = Math.min(startIndex + this.maxVisible, this.filteredSessions.length);

		for (let i = startIndex; i < endIndex; i++) {
			const node = this.filteredSessions[i]!;
			const session = node.session;
			const isSelected = i === this.selectedIndex;
			const isConfirmingDelete = session.id === this.confirmingDeleteId;
			const isCurrent = session.id === this.currentSessionId;

			const prefix = this.buildTreePrefix(node);

			const hasName = !!session.name;
			const displayText = session.name ?? session.firstMessage;
			const normalizedMessage = displayText.replace(/[\x00-\x1f\x7f]/g, " ").trim();

			const age = formatSessionDate(session.modified);
			const msgCount = String(session.messageCount);
			let rightPart = `${msgCount} ${age}`;
			if (this.showCwd && session.cwd) {
				rightPart = `${shortenPath(session.cwd)} ${rightPart}`;
			}
			if (this.showId) {
				rightPart = `${session.id} ${rightPart}`;
			}

			const cursor = isSelected ? theme.fg("accent", "› ") : "  ";

			const prefixWidth = visibleWidth(prefix);
			const rightWidth = visibleWidth(rightPart) + 2;
			const availableForMsg = width - 2 - prefixWidth - rightWidth;

			const truncatedMsg = truncateToWidth(normalizedMessage, Math.max(10, availableForMsg), "…");

			let messageColor: "error" | "warning" | "accent" | null = null;
			if (isConfirmingDelete) {
				messageColor = "error";
			} else if (isCurrent) {
				messageColor = "accent";
			} else if (hasName) {
				messageColor = "warning";
			}
			let styledMsg = messageColor ? theme.fg(messageColor, truncatedMsg) : truncatedMsg;
			if (isSelected) {
				styledMsg = styledMsg;
			}

			const leftPart = cursor + theme.fg("dim", prefix) + styledMsg;
			const leftWidth = visibleWidth(leftPart);
			const spacing = Math.max(1, width - leftWidth - visibleWidth(rightPart));
			const styledRight = theme.fg(isConfirmingDelete ? "error" : "dim", rightPart);

			let line = leftPart + " ".repeat(spacing) + styledRight;
			if (isSelected) {
				line = theme.inverse(line);
			}
			lines.push(truncateToWidth(line, width));
		}

		if (startIndex > 0 || endIndex < this.filteredSessions.length) {
			const scrollText = `  (${this.selectedIndex + 1}/${this.filteredSessions.length})`;
			const scrollInfo = theme.fg("muted", truncateToWidth(scrollText, width, ""));
			lines.push(scrollInfo);
		}

		return lines;
	}

	private buildTreePrefix(node: FlatSessionNode): string {
		if (node.depth === 0) {
			return "";
		}

		const parts = node.ancestorContinues.map((continues) => (continues ? "│  " : "   "));
		const branch = node.isLast ? "└─ " : "├─ ";
		return parts.join("") + branch;
	}

	handleInput(keyData: string): void {
		const kb = getKeybindings();

		if (this.confirmingDeleteId !== null) {
			if (kb.matches(keyData, "tui.select.confirm")) {
				const idToDelete = this.confirmingDeleteId;
				this.setConfirmingDeleteId(null);
				this.onDeleteSession?.(idToDelete);
				return;
			}
			if (kb.matches(keyData, "tui.select.cancel")) {
				this.setConfirmingDeleteId(null);
				return;
			}
			return;
		}

		if (kb.matches(keyData, "tui.input.tab")) {
			if (this.onToggleScope) {
				this.onToggleScope();
			}
			return;
		}

		if (kb.matches(keyData, "app.session.toggleSort")) {
			this.onToggleSort?.();
			return;
		}

		if (this.keybindings.matches(keyData, "app.session.toggleNamedFilter")) {
			this.onToggleNameFilter?.();
			return;
		}

		if (kb.matches(keyData, "app.session.toggleId")) {
			this.showId = !this.showId;
			this.onToggleId?.(this.showId);
			return;
		}

		if (kb.matches(keyData, "app.session.delete")) {
			this.startDeleteConfirmationForSelectedSession();
			return;
		}

		if (kb.matches(keyData, "app.session.rename")) {
			const selected = this.filteredSessions[this.selectedIndex];
			if (selected) {
				this.onRenameSession?.(selected.session.id);
			}
			return;
		}

		if (kb.matches(keyData, "app.session.deleteNoninvasive")) {
			if (this.searchInput.getValue().length > 0) {
				this.searchInput.handleInput(keyData);
				this.filterSessions(this.searchInput.getValue());
				return;
			}

			this.startDeleteConfirmationForSelectedSession();
			return;
		}

		this.selectionTouched = true;
		if (kb.matches(keyData, "tui.select.up")) {
			this.selectedIndex = Math.max(0, this.selectedIndex - 1);
		} else if (kb.matches(keyData, "tui.select.down")) {
			this.selectedIndex = Math.min(this.filteredSessions.length - 1, this.selectedIndex + 1);
		} else if (kb.matches(keyData, "tui.select.pageUp")) {
			this.selectedIndex = Math.max(0, this.selectedIndex - this.maxVisible);
		} else if (kb.matches(keyData, "tui.select.pageDown")) {
			this.selectedIndex = Math.min(this.filteredSessions.length - 1, this.selectedIndex + this.maxVisible);
		} else if (kb.matches(keyData, "tui.select.confirm")) {
			const selected = this.filteredSessions[this.selectedIndex];
			if (selected && this.onSelect) {
				this.onSelect(selected.session.id);
			}
		} else if (kb.matches(keyData, "tui.select.cancel")) {
			if (this.onCancel) {
				this.onCancel();
			}
		} else {
			this.searchInput.handleInput(keyData);
			this.filterSessions(this.searchInput.getValue());
		}
	}
}

type SessionsLoader = () => SessionInfo[];

export class SessionSelectorComponent extends Container implements Focusable {
	handleInput(data: string): void {
		if (this.mode === "rename") {
			const kb = getKeybindings();
			if (kb.matches(data, "tui.select.cancel")) {
				this.exitRenameMode();
				return;
			}
			this.renameInput.handleInput(data);
			return;
		}

		this.sessionList.handleInput(data);
	}

	private canRename = true;
	private sessionList: SessionList;
	private header: SessionSelectorHeader;
	private keybindings: KeybindingsManager;
	private scope: SessionScope = "current";
	private sortMode: SortMode = "threaded";
	private nameFilter: NameFilter = "all";
	private currentSessionsLoader: SessionsLoader;
	private allSessionsLoader: SessionsLoader;
	private requestRender: () => void;
	private renameSession?: (sessionId: string, currentName: string | undefined) => Promise<void>;

	private mode: "list" | "rename" = "list";
	private renameInput = new Input();
	private renameTargetId: string | null = null;

	private _focused = false;
	get focused(): boolean {
		return this._focused;
	}
	set focused(value: boolean) {
		this._focused = value;
		this.sessionList.focused = value;
		this.renameInput.focused = value;
		if (value && this.mode === "rename") {
			this.renameInput.focused = true;
		}
	}

	private buildBaseLayout(content: Component, options?: { showHeader?: boolean }): void {
		this.clear();
		this.addChild(new Spacer(1));
		this.addChild(new DynamicBorder((s) => theme.fg("accent", s)));
		this.addChild(new Spacer(1));
		if (options?.showHeader ?? true) {
			this.addChild(this.header);
			this.addChild(new Spacer(1));
		}
		this.addChild(content);
		this.addChild(new Spacer(1));
		this.addChild(new DynamicBorder((s) => theme.fg("accent", s)));
	}

	constructor(
		currentSessionsLoader: SessionsLoader,
		allSessionsLoader: SessionsLoader,
		deleteSession: (sessionId: string) => void,
		onSelect: (sessionId: string) => void,
		onCancel: () => void,
		onExit: () => void,
		requestRender: () => void,
		options?: {
			renameSession?: (sessionId: string, currentName: string | undefined) => Promise<void>;
			showRenameHint?: boolean;
			keybindings?: KeybindingsManager;
		},
		currentSessionId?: string,
	) {
		super();
		this.keybindings = options?.keybindings ?? KeybindingsManager.create();
		this.currentSessionsLoader = currentSessionsLoader;
		this.allSessionsLoader = allSessionsLoader;
		this.requestRender = requestRender;
		this.header = new SessionSelectorHeader(this.scope, this.sortMode, this.nameFilter, this.requestRender);
		const renameSession = options?.renameSession;
		this.renameSession = renameSession;
		this.canRename = !!renameSession;
		this.header.setShowRenameHint(options?.showRenameHint ?? this.canRename);

		this.sessionList = new SessionList([], false, this.sortMode, this.nameFilter, this.keybindings, currentSessionId);

		this.buildBaseLayout(this.sessionList);

		this.renameInput.onSubmit = (value) => {
			void this.confirmRename(value);
		};

		const clearStatusMessage = () => this.header.setStatusMessage(null);
		this.sessionList.onSelect = (sessionId) => {
			clearStatusMessage();
			onSelect(sessionId);
		};
		this.sessionList.onCancel = () => {
			clearStatusMessage();
			onCancel();
		};
		this.sessionList.onExit = () => {
			clearStatusMessage();
			onExit();
		};
		this.sessionList.onToggleScope = () => this.toggleScope();
		this.sessionList.onToggleSort = () => this.toggleSortMode();
		this.sessionList.onToggleNameFilter = () => this.toggleNameFilter();
		this.sessionList.onRenameSession = (sessionId) => {
			if (!renameSession) return;
			const session = this.loadSessions().find((s) => s.id === sessionId);
			this.enterRenameMode(sessionId, session?.name);
		};

		this.sessionList.onToggleId = (showId) => {
			this.header.setShowId(showId);
			this.requestRender();
		};
		this.sessionList.onDeleteConfirmationChange = (id) => {
			this.header.setConfirmingDeleteId(id);
			this.requestRender();
		};
		this.sessionList.onError = (msg) => {
			this.header.setStatusMessage({ type: "error", message: msg }, 3000);
			this.requestRender();
		};

		this.sessionList.onDeleteSession = (sessionId: string) => {
			try {
				deleteSession(sessionId);
				this.header.setStatusMessage({ type: "info", message: "Session deleted" }, 2000);
			} catch (err) {
				const message = err instanceof Error ? err.message : String(err);
				this.header.setStatusMessage({ type: "error", message: `Failed to delete: ${message}` }, 3000);
			}
			this.showScope();
		};

		this.showScope();
	}

	private loadSessions(): SessionInfo[] {
		return this.scope === "current" ? this.currentSessionsLoader() : this.allSessionsLoader();
	}

	private showScope(): void {
		this.header.setScope(this.scope);
		try {
			this.sessionList.setSessions(this.loadSessions(), this.scope === "all");
		} catch (err) {
			const message = err instanceof Error ? err.message : String(err);
			this.header.setStatusMessage({ type: "error", message: `Failed to load sessions: ${message}` }, 4000);
			this.sessionList.setSessions([], this.scope === "all");
		}
		this.requestRender();
	}

	private enterRenameMode(sessionId: string, currentName: string | undefined): void {
		this.mode = "rename";
		this.renameTargetId = sessionId;
		this.renameInput.setValue(currentName ?? "");
		this.renameInput.focused = true;

		const panel = new Container();
		panel.addChild(new Text("Rename Session", 1, 0));
		panel.addChild(new Spacer(1));
		panel.addChild(this.renameInput);
		panel.addChild(new Spacer(1));
		panel.addChild(
			new Text(
				theme.fg("muted", `${keyText("tui.select.confirm")} to save · ${keyText("tui.select.cancel")} to cancel`),
				1,
				0,
			),
		);

		this.buildBaseLayout(panel, { showHeader: false });
		this.requestRender();
	}

	private exitRenameMode(): void {
		this.mode = "list";
		this.renameTargetId = null;

		this.buildBaseLayout(this.sessionList);

		this.requestRender();
	}

	private async confirmRename(value: string): Promise<void> {
		const next = value.trim();
		if (!next) return;
		const target = this.renameTargetId;
		if (!target) {
			this.exitRenameMode();
			return;
		}

		const renameSession = this.renameSession;
		if (!renameSession) {
			this.exitRenameMode();
			return;
		}

		try {
			await renameSession(target, next);
			this.showScope();
		} finally {
			this.exitRenameMode();
		}
	}

	private toggleSortMode(): void {
		this.sortMode = this.sortMode === "threaded" ? "recent" : this.sortMode === "recent" ? "relevance" : "threaded";
		this.header.setSortMode(this.sortMode);
		this.sessionList.setSortMode(this.sortMode);
		this.requestRender();
	}

	private toggleNameFilter(): void {
		this.nameFilter = this.nameFilter === "all" ? "named" : "all";
		this.header.setNameFilter(this.nameFilter);
		this.sessionList.setNameFilter(this.nameFilter);
		this.requestRender();
	}

	private toggleScope(): void {
		this.scope = this.scope === "current" ? "all" : "current";
		this.showScope();
	}

	getSessionList(): SessionList {
		return this.sessionList;
	}
}
