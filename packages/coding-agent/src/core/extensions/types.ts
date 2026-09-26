import type {
	AgentMessage,
	AgentToolResult,
	AgentToolUpdateCallback,
	ThinkingLevel,
	ToolExecutionMode,
} from "@earendil-works/pi-agent-core";
import type {
	Api,
	AssistantMessageEvent,
	AssistantMessageEventStream,
	ConstrainedSamplingConfig,
	InputModality,
	MediaContent,
	Message,
	Model,
	Provider,
	ProviderHeaders,
	ProviderId,
	RefreshModelsContext,
	SimpleStreamOptions,
	TextContent,
	ToolResultMessage,
	TranscriptContext,
	Usage,
} from "@earendil-works/pi-ai";
import type {
	AutocompleteItem,
	AutocompleteProvider,
	Component,
	EditorComponent,
	EditorTheme,
	KeyId,
	OverlayHandle,
	OverlayOptions,
	TUI,
} from "@earendil-works/pi-tui";
import type { Static, TSchema } from "typebox";
import type { Theme } from "../../modes/interactive/theme/theme.ts";
import type { BashResult } from "../bash-executor.ts";
import type { CompactionPreparation, CompactionResult } from "../compaction/index.ts";
import type { EventBus } from "../event-bus.ts";
import type { ExecOptions, ExecResult } from "../exec.ts";
import type { ReadonlyFooterDataProvider } from "../footer-data-provider.ts";
import type { KeybindingsManager } from "../keybindings.ts";
import type { CustomMessage } from "../messages.ts";
import type { ModelRegistry } from "../model-registry.ts";
import type { ScopedModel } from "../model-resolver.ts";
import type {
	BranchSummaryEntry,
	CompactionEntry,
	ContextEditEntry,
	CustomEntry,
	ProjectedSessionEntry,
	ReadonlySessionManager,
	SessionEntry,
	SessionManager,
} from "../session-manager.ts";
import type { SlashCommandInfo } from "../slash-commands.ts";
import type { SourceInfo } from "../source-info.ts";
import type { BuildSystemPromptOptions, NormalizedBuildSystemPromptOptions } from "../system-prompt.ts";
import type { BashOperations } from "../tools/bash.ts";
import type {
	BashToolDetails,
	BashToolInput,
	EditToolInput,
	ReadToolDetails,
	ReadToolInput,
	WriteToolInput,
} from "../tools/index.ts";

export type { ExecOptions, ExecResult } from "../exec.ts";
export type { BuildSystemPromptOptions, NormalizedBuildSystemPromptOptions } from "../system-prompt.ts";
export type { AgentToolResult, AgentToolUpdateCallback, ToolExecutionMode };
export type { AppKeybinding, KeybindingsManager } from "../keybindings.ts";

export interface ExtensionUIDialogOptions {
	signal?: AbortSignal;
	timeout?: number;
}

export type WidgetPlacement = "aboveEditor" | "belowEditor";

export interface ExtensionWidgetOptions {
	placement?: WidgetPlacement;
}

export type TerminalInputHandler = (data: string) => { consume?: boolean; data?: string } | undefined;

export interface WorkingIndicatorOptions {
	frames?: string[];
	intervalMs?: number;
}

export type AutocompleteProviderFactory = (current: AutocompleteProvider) => AutocompleteProvider;
export type EditorFactory = (tui: TUI, theme: EditorTheme, keybindings: KeybindingsManager) => EditorComponent;

export interface ExtensionUIContext {
	select(title: string, options: string[], opts?: ExtensionUIDialogOptions): Promise<string | undefined>;

	confirm(title: string, message: string, opts?: ExtensionUIDialogOptions): Promise<boolean>;

	input(title: string, placeholder?: string, opts?: ExtensionUIDialogOptions): Promise<string | undefined>;

	notify(message: string, type?: "info" | "warning" | "error"): void;

	onTerminalInput(handler: TerminalInputHandler): () => void;

	setStatus(key: string, text: string | undefined): void;

	setWorkingMessage(message?: string): void;

	setWorkingVisible(visible: boolean): void;

	setWorkingIndicator(options?: WorkingIndicatorOptions): void;

	setHiddenThinkingLabel(label?: string): void;

	setWidget(key: string, content: string[] | undefined, options?: ExtensionWidgetOptions): void;
	setWidget(
		key: string,
		content: ((tui: TUI, theme: Theme) => Component & { dispose?(): void }) | undefined,
		options?: ExtensionWidgetOptions,
	): void;

	setFooter(
		factory:
			| ((tui: TUI, theme: Theme, footerData: ReadonlyFooterDataProvider) => Component & { dispose?(): void })
			| undefined,
	): void;

	setHeader(factory: ((tui: TUI, theme: Theme) => Component & { dispose?(): void }) | undefined): void;

	setTitle(title: string): void;

	custom<T>(
		factory: (
			tui: TUI,
			theme: Theme,
			keybindings: KeybindingsManager,
			done: (result: T) => void,
		) => (Component & { dispose?(): void }) | Promise<Component & { dispose?(): void }>,
		options?: {
			overlay?: boolean;
			overlayOptions?: OverlayOptions | (() => OverlayOptions);
			onHandle?: (handle: OverlayHandle) => void;
		},
	): Promise<T>;

	pasteToEditor(text: string): void;

	setEditorText(text: string): void;

	getEditorText(): string;

	editor(title: string, prefill?: string): Promise<string | undefined>;

	addAutocompleteProvider(factory: AutocompleteProviderFactory): void;

	setEditorComponent(factory: EditorFactory | undefined): void;

	getEditorComponent(): EditorFactory | undefined;

	readonly theme: Theme;

	getToolsExpanded(): boolean;

	setToolsExpanded(expanded: boolean): void;
}

export interface ContextUsage {
	tokens: number | null;
	contextWindow: number;
	percent: number | null;
}

export interface CompactOptions {
	customInstructions?: string;
	onComplete?: (result: CompactionResult) => void;
	onError?: (error: Error) => void;
}

export interface ExtensionContext {
	ui: ExtensionUIContext;
	hasUI: boolean;
	cwd: string;
	sessionManager: ReadonlySessionManager;
	modelRegistry: ModelRegistry;
	model: Model<any> | undefined;
	scopedModels: readonly ScopedModel[];
	thinkingLevel?: ThinkingLevel;
	isIdle(): boolean;
	signal: AbortSignal | undefined;
	abort(): void;
	hasPendingMessages(): boolean;
	shutdown(): void;
	getContextUsage(): ContextUsage | undefined;
	compact(options?: CompactOptions): void;
	getSystemPrompt(): string;
}

export interface ExtensionCommandContext extends ExtensionContext {
	getSystemPromptOptions(): BuildSystemPromptOptions;

	waitForIdle(): Promise<void>;

	newSession(options?: {
		parentSession?: string;
		setup?: (sessionManager: SessionManager) => Promise<void>;
		withSession?: (ctx: ReplacedSessionContext) => Promise<void>;
	}): Promise<{ cancelled: boolean }>;

	fork(
		entryId: string,
		options?: { position?: "before" | "at"; withSession?: (ctx: ReplacedSessionContext) => Promise<void> },
	): Promise<{ cancelled: boolean }>;

	navigateTree(
		targetId: string,
		options?: { summarize?: boolean; customInstructions?: string; replaceInstructions?: boolean; label?: string },
	): Promise<{ cancelled: boolean }>;

	switchSession(
		sessionPath: string,
		options?: { withSession?: (ctx: ReplacedSessionContext) => Promise<void> },
	): Promise<{ cancelled: boolean }>;

	reload(): Promise<void>;
}

export interface ReplacedSessionContext extends ExtensionCommandContext {
	sendMessage<T = unknown>(
		message: Pick<CustomMessage<T>, "customType" | "content" | "display" | "details">,
		options?: { triggerTurn?: boolean; deliverAs?: "steer" | "followUp" | "nextTurn" },
	): Promise<void>;

	sendUserMessage(
		content: string | (TextContent | MediaContent)[],
		options?: { deliverAs?: "steer" | "followUp"; expandPromptTemplates?: boolean },
	): Promise<void>;
}

export interface ToolRenderResultOptions {
	expanded: boolean;
	isPartial: boolean;
}

export interface ToolRenderContext<TState = any, TArgs = any> {
	args: TArgs;
	toolCallId: string;
	invalidate: () => void;
	lastComponent: Component | undefined;
	state: TState;
	cwd: string;
	executionStarted: boolean;
	argsComplete: boolean;
	isPartial: boolean;
	expanded: boolean;
	showImages: boolean;
	isError: boolean;
}

export interface ToolDefinition<TParams extends TSchema = TSchema, TDetails = unknown, TState = any> {
	name: string;
	label: string;
	description: string;
	parameters: TParams;
	constrainedSampling?: false | ConstrainedSamplingConfig;
	renderShell?: "default" | "self";

	prepareArguments?: (args: unknown) => Static<TParams>;

	executionMode?: ToolExecutionMode;

	execute(
		toolCallId: string,
		params: Static<TParams>,
		signal: AbortSignal | undefined,
		onUpdate: AgentToolUpdateCallback<TDetails> | undefined,
		ctx: ExtensionContext,
	): Promise<AgentToolResult<TDetails>>;

	renderCall?: (args: Static<TParams>, theme: Theme, context: ToolRenderContext<TState, Static<TParams>>) => Component;

	renderResult?: (
		result: AgentToolResult<TDetails>,
		options: ToolRenderResultOptions,
		theme: Theme,
		context: ToolRenderContext<TState, Static<TParams>>,
	) => Component;
}

type AnyToolDefinition = ToolDefinition<any, any, any>;

export function defineTool<TParams extends TSchema, TDetails = unknown, TState = any>(
	tool: ToolDefinition<TParams, TDetails, TState>,
): ToolDefinition<TParams, TDetails, TState> & AnyToolDefinition {
	return tool as ToolDefinition<TParams, TDetails, TState> & AnyToolDefinition;
}

export interface ResourcesDiscoverEvent {
	type: "resources_discover";
	cwd: string;
	reason: "startup" | "reload";
}

export interface ResourcesDiscoverResult {
	skillPaths?: string[];
	promptPaths?: string[];
}

export interface SessionStartEvent {
	type: "session_start";
	reason: "startup" | "reload" | "new" | "resume" | "fork";
	previousSessionFile?: string;
}

export interface SessionInfoChangedEvent {
	type: "session_info_changed";
	name: string | undefined;
}

export interface SessionBeforeSwitchEvent {
	type: "session_before_switch";
	reason: "new" | "resume";
	targetSessionFile?: string;
}

export interface SessionBeforeForkEvent {
	type: "session_before_fork";
	entryId: string;
	position: "before" | "at";
}

export interface SessionBeforeCompactEvent {
	type: "session_before_compact";
	preparation: CompactionPreparation;
	branchEntries: SessionEntry[];
	customInstructions?: string;
	reason: "manual" | "threshold" | "overflow";
	willRetry: boolean;
	signal: AbortSignal;
}

export interface SessionCompactEvent {
	type: "session_compact";
	compactionEntry: CompactionEntry;
	fromExtension: boolean;
	reason: "manual" | "threshold" | "overflow";
	willRetry: boolean;
}

export interface SessionCompactFailedEvent {
	type: "session_compact_failed";
	reason: "manual" | "threshold" | "overflow";
	errorMessage?: string;
	aborted: boolean;
	willRetry: boolean;
	fromExtension: boolean;
}

export interface SessionShutdownEvent {
	type: "session_shutdown";
	reason: "quit" | "reload" | "new" | "resume" | "fork";
	targetSessionFile?: string;
}

export interface TreePreparation {
	targetId: string;
	oldLeafId: string | null;
	commonAncestorId: string | null;
	entriesToSummarize: SessionEntry[];
	userWantsSummary: boolean;
	customInstructions?: string;
	replaceInstructions?: boolean;
	label?: string;
}

export interface SessionBeforeTreeEvent {
	type: "session_before_tree";
	preparation: TreePreparation;
	signal: AbortSignal;
}

export interface SessionTreeEvent {
	type: "session_tree";
	newLeafId: string | null;
	oldLeafId: string | null;
	summaryEntry?: BranchSummaryEntry;
	fromExtension?: boolean;
}

export type SessionEvent =
	| SessionStartEvent
	| SessionInfoChangedEvent
	| SessionBeforeSwitchEvent
	| SessionBeforeForkEvent
	| SessionBeforeCompactEvent
	| SessionCompactEvent
	| SessionCompactFailedEvent
	| SessionShutdownEvent
	| SessionBeforeTreeEvent
	| SessionTreeEvent;

export interface ContextEvent {
	type: "context";
	messages: AgentMessage[];
}

export interface ContextWithSystemEvent {
	type: "context_with_system";
	messages: AgentMessage[];
}

export interface BeforeProviderRequestEvent {
	type: "before_provider_request";
	payload: unknown;
}

export interface BeforeProviderHeadersEvent {
	type: "before_provider_headers";
	headers: ProviderHeaders;
}

export interface AfterProviderResponseEvent {
	type: "after_provider_response";
	status: number;
	headers: Record<string, string>;
}

export interface ProviderStreamEvent {
	type: "provider_stream_event";
	provider: ProviderId;
	api: Api;
	model: string;
	data: unknown;
}

export interface BeforeAgentStartEvent {
	type: "before_agent_start";
	prompt: string;
	images?: MediaContent[];
	readonly systemPrompt: string;
	systemPromptOptions: NormalizedBuildSystemPromptOptions;
}

export interface AgentStartEvent {
	type: "agent_start";
}

export interface AgentEndEvent {
	type: "agent_end";
	messages: AgentMessage[];
}

export type AgentActivityOutcome = "completed" | "aborted" | "error";

export interface CustomEntryDraft {
	type: "custom";
	customType: string;
	data?: unknown;
}

export interface CustomMessageEntryDraft {
	type: "custom_message";
	customType: string;
	content: string | (TextContent | MediaContent)[];
	display: boolean;
	details?: unknown;
}

export interface ContextEditEntryDraft {
	type: "context_edit";
	targetId: string;
	replacement: ContextEditEntry["replacement"];
}

export interface CompactionEntryDraft {
	type: "compaction";
	summary: string;
	firstKeptEntryId: string | null;
	details?: unknown;
	usage?: Usage;
}

export type SessionBoundaryDraft =
	CustomEntryDraft | CustomMessageEntryDraft | ContextEditEntryDraft | CompactionEntryDraft;

export interface BoundaryContextPreview {
	contextEntries: ProjectedSessionEntry[];
	contextMessages: AgentMessage[];
	llmMessages: Message[];
	pendingMessages: AgentMessage[];
	canContinue: boolean;
}

export interface BoundaryState {
	entries: SessionBoundaryDraft[];
	continue: boolean;
	context: BoundaryContextPreview;
	outcome: AgentActivityOutcome;
}

export interface BoundaryResult {
	entries?: SessionBoundaryDraft[];
	continue?: boolean;
}

export interface AgentBeforeSettleEvent extends BoundaryState {
	type: "agent_before_settle";
}

export interface AgentSettledEvent {
	type: "agent_settled";
}

export type UIPromptKind = "select" | "confirm" | "input" | "editor" | "custom";

export interface UIPromptStartEvent {
	type: "ui_prompt_start";
	reason: "ui_prompt";
	kind: UIPromptKind;
	title?: string;
}

export interface UIPromptEndEvent {
	type: "ui_prompt_end";
	reason: "ui_prompt";
	kind: UIPromptKind;
	title?: string;
}

export interface TurnStartEvent {
	type: "turn_start";
	turnIndex: number;
	timestamp: number;
}

export interface TurnEndEvent extends BoundaryState {
	type: "turn_end";
	turnIndex: number;
	message: AgentMessage;
	toolResults: ToolResultMessage[];
	messageEntryId: string;
	toolResultEntryIds: string[];
}

export interface MessageStartEvent {
	type: "message_start";
	message: AgentMessage;
}

export interface MessageUpdateEvent {
	type: "message_update";
	message: AgentMessage;
	assistantMessageEvent: AssistantMessageEvent;
}

export interface MessageEndEvent {
	type: "message_end";
	message: AgentMessage;
}

export interface ToolExecutionStartEvent {
	type: "tool_execution_start";
	toolCallId: string;
	toolName: string;
	args: any;
}

export interface ToolExecutionUpdateEvent {
	type: "tool_execution_update";
	toolCallId: string;
	toolName: string;
	args: any;
	partialResult: any;
}

export interface ToolExecutionEndEvent {
	type: "tool_execution_end";
	toolCallId: string;
	toolName: string;
	result: any;
	isError: boolean;
}

export type ModelSelectSource = "set" | "cycle" | "restore";

export interface ModelSelectEvent {
	type: "model_select";
	model: Model<any>;
	previousModel: Model<any> | undefined;
	source: ModelSelectSource;
}

export interface ThinkingLevelSelectEvent {
	type: "thinking_level_select";
	level: ThinkingLevel;
	previousLevel: ThinkingLevel;
}

export interface UserBashEvent {
	type: "user_bash";
	command: string;
	excludeFromContext: boolean;
	cwd: string;
}

export type InputSource = "interactive" | "extension";

export interface InputEvent {
	type: "input";
	text: string;
	images?: MediaContent[];
	source: InputSource;
	streamingBehavior?: "steer" | "followUp";
}

export type InputEventResult =
	{ action: "continue" } | { action: "transform"; text: string; images?: MediaContent[] } | { action: "handled" };

interface ToolCallEventBase {
	type: "tool_call";
	toolCallId: string;
}

export interface BashToolCallEvent extends ToolCallEventBase {
	toolName: "bash";
	input: BashToolInput;
}

export interface ReadToolCallEvent extends ToolCallEventBase {
	toolName: "read";
	input: ReadToolInput;
}

export interface EditToolCallEvent extends ToolCallEventBase {
	toolName: "edit";
	input: EditToolInput;
}

export interface WriteToolCallEvent extends ToolCallEventBase {
	toolName: "write";
	input: WriteToolInput;
}

export interface CustomToolCallEvent extends ToolCallEventBase {
	toolName: string;
	input: Record<string, unknown>;
}

export type ToolCallEvent =
	BashToolCallEvent | ReadToolCallEvent | EditToolCallEvent | WriteToolCallEvent | CustomToolCallEvent;

interface ToolResultEventBase {
	type: "tool_result";
	toolCallId: string;
	input: Record<string, unknown>;
	content: (TextContent | MediaContent)[];
	isError: boolean;
	usage?: Usage;
}

interface BashToolResultEvent extends ToolResultEventBase {
	toolName: "bash";
	details: BashToolDetails | undefined;
}

interface ReadToolResultEvent extends ToolResultEventBase {
	toolName: "read";
	details: ReadToolDetails | undefined;
}

interface EditToolResultEvent extends ToolResultEventBase {
	toolName: "edit";
	details: undefined;
}

interface WriteToolResultEvent extends ToolResultEventBase {
	toolName: "write";
	details: undefined;
}

interface CustomToolResultEvent extends ToolResultEventBase {
	toolName: string;
	details: unknown;
}

export type ToolResultEvent =
	BashToolResultEvent | ReadToolResultEvent | EditToolResultEvent | WriteToolResultEvent | CustomToolResultEvent;

export function isBashToolResult(e: ToolResultEvent): e is BashToolResultEvent {
	return e.toolName === "bash";
}
export function isReadToolResult(e: ToolResultEvent): e is ReadToolResultEvent {
	return e.toolName === "read";
}
export function isEditToolResult(e: ToolResultEvent): e is EditToolResultEvent {
	return e.toolName === "edit";
}
export function isWriteToolResult(e: ToolResultEvent): e is WriteToolResultEvent {
	return e.toolName === "write";
}

export function isToolCallEventType(toolName: "bash", event: ToolCallEvent): event is BashToolCallEvent;
export function isToolCallEventType(toolName: "read", event: ToolCallEvent): event is ReadToolCallEvent;
export function isToolCallEventType(toolName: "edit", event: ToolCallEvent): event is EditToolCallEvent;
export function isToolCallEventType(toolName: "write", event: ToolCallEvent): event is WriteToolCallEvent;
export function isToolCallEventType<TName extends string, TInput extends Record<string, unknown>>(
	toolName: TName,
	event: ToolCallEvent,
): event is ToolCallEvent & { toolName: TName; input: TInput };
export function isToolCallEventType(toolName: string, event: ToolCallEvent): boolean {
	return event.toolName === toolName;
}

export type ExtensionEvent =
	| ResourcesDiscoverEvent
	| SessionEvent
	| ContextEvent
	| ContextWithSystemEvent
	| BeforeProviderRequestEvent
	| BeforeProviderHeadersEvent
	| AfterProviderResponseEvent
	| ProviderStreamEvent
	| BeforeAgentStartEvent
	| AgentStartEvent
	| AgentEndEvent
	| AgentBeforeSettleEvent
	| AgentSettledEvent
	| UIPromptStartEvent
	| UIPromptEndEvent
	| TurnStartEvent
	| TurnEndEvent
	| MessageStartEvent
	| MessageUpdateEvent
	| MessageEndEvent
	| ToolExecutionStartEvent
	| ToolExecutionUpdateEvent
	| ToolExecutionEndEvent
	| ModelSelectEvent
	| ThinkingLevelSelectEvent
	| UserBashEvent
	| InputEvent
	| ToolCallEvent
	| ToolResultEvent;

export interface ContextEventResult {
	messages?: AgentMessage[];
}

export type TurnEndEventResult = BoundaryResult;
export type AgentBeforeSettleEventResult = BoundaryResult;

export type BeforeProviderRequestEventResult = unknown;

export interface ToolCallEventResult {
	block?: boolean;
	reason?: string;
	terminate?: boolean;
}

export type UserBashEventResult =
	| {
			operations: BashOperations;
			result?: never;
	  }
	| {
			operations?: never;
			result: BashResult;
	  };

export interface ToolResultEventResult {
	content?: (TextContent | MediaContent)[];
	details?: unknown;
	isError?: boolean;
	usage?: Usage;
}

export interface MessageEndEventResult {
	message?: AgentMessage;
}

export interface BeforeAgentStartEventResult {
	message?: Pick<CustomMessage, "customType" | "content" | "display" | "details">;
	systemPrompt?: string;
}

export interface SessionBeforeSwitchResult {
	cancel?: boolean;
}

export interface SessionBeforeForkResult {
	cancel?: boolean;
	skipConversationRestore?: boolean;
}

export interface SessionBeforeCompactResult {
	cancel?: boolean;
	compaction?: CompactionResult;
}

export interface SessionBeforeTreeResult {
	cancel?: boolean;
	summary?: {
		summary: string;
		details?: unknown;
		usage?: Usage;
	};
	customInstructions?: string;
	replaceInstructions?: boolean;
	label?: string;
}

export interface MessageRenderOptions {
	expanded: boolean;
	outputPad: number;
}

export interface MarkdownTransformContext {
	messageType: "user" | "assistant" | "assistant-thinking";
	isStreaming: boolean;
	availableWidth: number;
}

export type MarkdownTransformer = (markdown: string, context: MarkdownTransformContext) => string;

export interface EntryRenderOptions {
	expanded: boolean;
}

export type MessageRenderer<T = unknown> = (
	message: CustomMessage<T>,
	options: MessageRenderOptions,
	theme: Theme,
) => Component | undefined;

export type EntryRenderer<T = unknown> = (
	entry: CustomEntry<T>,
	options: EntryRenderOptions,
	theme: Theme,
) => Component | undefined;

export interface RegisteredCommand {
	name: string;
	sourceInfo: SourceInfo;
	description?: string;
	getArgumentCompletions?: (argumentPrefix: string) => AutocompleteItem[] | null | Promise<AutocompleteItem[] | null>;
	handler: (args: string, ctx: ExtensionCommandContext) => Promise<void>;
}

export interface ResolvedCommand extends RegisteredCommand {
	invocationName: string;
}

export type ExtensionHandler<E, R = undefined> = (event: E, ctx: ExtensionContext) => Promise<R | void> | R | void;

export interface ExtensionAPI {
	on(
		event: "resources_discover",
		handler: ExtensionHandler<ResourcesDiscoverEvent, ResourcesDiscoverResult>,
	): () => void;
	on(event: "session_start", handler: ExtensionHandler<SessionStartEvent>): () => void;
	on(event: "session_info_changed", handler: ExtensionHandler<SessionInfoChangedEvent>): () => void;
	on(
		event: "session_before_switch",
		handler: ExtensionHandler<SessionBeforeSwitchEvent, SessionBeforeSwitchResult>,
	): () => void;
	on(
		event: "session_before_fork",
		handler: ExtensionHandler<SessionBeforeForkEvent, SessionBeforeForkResult>,
	): () => void;
	on(
		event: "session_before_compact",
		handler: ExtensionHandler<SessionBeforeCompactEvent, SessionBeforeCompactResult>,
	): () => void;
	on(event: "session_compact", handler: ExtensionHandler<SessionCompactEvent>): () => void;
	on(event: "session_compact_failed", handler: ExtensionHandler<SessionCompactFailedEvent>): () => void;
	on(event: "session_shutdown", handler: ExtensionHandler<SessionShutdownEvent>): () => void;
	on(
		event: "session_before_tree",
		handler: ExtensionHandler<SessionBeforeTreeEvent, SessionBeforeTreeResult>,
	): () => void;
	on(event: "session_tree", handler: ExtensionHandler<SessionTreeEvent>): () => void;
	on(event: "context", handler: ExtensionHandler<ContextEvent, ContextEventResult>): () => void;
	on(event: "context_with_system", handler: ExtensionHandler<ContextWithSystemEvent, ContextEventResult>): () => void;
	on(
		event: "before_provider_request",
		handler: ExtensionHandler<BeforeProviderRequestEvent, BeforeProviderRequestEventResult>,
	): () => void;
	on(event: "before_provider_headers", handler: ExtensionHandler<BeforeProviderHeadersEvent>): () => void;
	on(event: "after_provider_response", handler: ExtensionHandler<AfterProviderResponseEvent>): () => void;
	on(event: "provider_stream_event", handler: ExtensionHandler<ProviderStreamEvent>): () => void;
	on(
		event: "before_agent_start",
		handler: ExtensionHandler<BeforeAgentStartEvent, BeforeAgentStartEventResult>,
	): () => void;
	on(event: "agent_start", handler: ExtensionHandler<AgentStartEvent>): () => void;
	on(event: "agent_end", handler: ExtensionHandler<AgentEndEvent>): () => void;
	on(
		event: "agent_before_settle",
		handler: ExtensionHandler<AgentBeforeSettleEvent, AgentBeforeSettleEventResult>,
	): () => void;
	on(event: "agent_settled", handler: ExtensionHandler<AgentSettledEvent>): () => void;
	on(event: "ui_prompt_start", handler: ExtensionHandler<UIPromptStartEvent>): () => void;
	on(event: "ui_prompt_end", handler: ExtensionHandler<UIPromptEndEvent>): () => void;
	on(event: "turn_start", handler: ExtensionHandler<TurnStartEvent>): () => void;
	on(event: "turn_end", handler: ExtensionHandler<TurnEndEvent, TurnEndEventResult>): () => void;
	on(event: "message_start", handler: ExtensionHandler<MessageStartEvent>): () => void;
	on(event: "message_update", handler: ExtensionHandler<MessageUpdateEvent>): () => void;
	on(event: "message_end", handler: ExtensionHandler<MessageEndEvent, MessageEndEventResult>): () => void;
	on(event: "tool_execution_start", handler: ExtensionHandler<ToolExecutionStartEvent>): () => void;
	on(event: "tool_execution_update", handler: ExtensionHandler<ToolExecutionUpdateEvent>): () => void;
	on(event: "tool_execution_end", handler: ExtensionHandler<ToolExecutionEndEvent>): () => void;
	on(event: "model_select", handler: ExtensionHandler<ModelSelectEvent>): () => void;
	on(event: "thinking_level_select", handler: ExtensionHandler<ThinkingLevelSelectEvent>): () => void;
	on(event: "tool_call", handler: ExtensionHandler<ToolCallEvent, ToolCallEventResult>): () => void;
	on(event: "tool_result", handler: ExtensionHandler<ToolResultEvent, ToolResultEventResult>): () => void;
	on(event: "user_bash", handler: ExtensionHandler<UserBashEvent, UserBashEventResult>): () => void;
	on(event: "input", handler: ExtensionHandler<InputEvent, InputEventResult>): () => void;

	registerTool<TParams extends TSchema = TSchema, TDetails = unknown, TState = any>(
		tool: ToolDefinition<TParams, TDetails, TState>,
	): void;

	registerCommand(name: string, options: Omit<RegisteredCommand, "name" | "sourceInfo">): void;

	registerShortcut(
		shortcut: KeyId,
		options: {
			description?: string;
			handler: (ctx: ExtensionContext) => Promise<void> | void;
		},
	): void;

	registerFlag(
		name: string,
		options:
			| {
					description?: string;
					type: "boolean";
					default?: boolean;
			  }
			| {
					description?: string;
					type: "string";
					default?: string;
			  },
	): void;

	getFlag(name: string): boolean | string | undefined;

	registerMessageRenderer<T = unknown>(customType: string, renderer: MessageRenderer<T>): void;

	registerMarkdownTransformer(transformer: MarkdownTransformer): void;

	registerEntryRenderer<T = unknown>(customType: string, renderer: EntryRenderer<T>): void;

	sendMessage<T = unknown>(
		message: Pick<CustomMessage<T>, "customType" | "content" | "display" | "details">,
		options?: { triggerTurn?: boolean; deliverAs?: "steer" | "followUp" | "nextTurn" },
	): void;

	sendUserMessage(
		content: string | (TextContent | MediaContent)[],
		options?: { deliverAs?: "steer" | "followUp"; expandPromptTemplates?: boolean },
	): void;

	appendEntry<T = unknown>(customType: string, data?: T): void;

	setSessionName(name: string): void;

	getSessionName(): string | undefined;

	setLabel(entryId: string, label: string | undefined): void;

	exec(command: string, args: string[], options?: ExecOptions): Promise<ExecResult>;

	getActiveTools(): string[];

	getAllTools(): ToolInfo[];

	setActiveTools(toolNames: string[]): void;

	getCommands(): SlashCommandInfo[];

	setModel(model: Model<any>): Promise<boolean>;

	getThinkingLevel(): ThinkingLevel;

	setThinkingLevel(level: ThinkingLevel): void;

	registerProvider(provider: Provider): void;
	registerProvider(name: string, config: ProviderConfig): void;

	unregisterProvider(name: string): void;

	events: EventBus;
}

export interface ProviderConfig {
	name?: string;
	baseUrl?: string;
	apiKey?: string;
	api?: Api;
	streamSimple?: (
		model: Model<Api>,
		context: TranscriptContext,
		options?: SimpleStreamOptions,
	) => AssistantMessageEventStream;
	headers?: Record<string, string>;
	authHeader?: boolean;
	models?: ProviderModelConfig[];
	refreshModels?(context: RefreshModelsContext): Promise<ProviderModelConfig[]>;
}

interface ProviderModelConfigBase {
	id: string;
	name: string;
	api?: string;
	baseUrl?: string;
	input: InputModality[];
	cost: Model<Api>["cost"];
	headers?: Record<string, string>;
}

interface ProviderChatModelConfig extends ProviderModelConfigBase {
	api?: Api;
	reasoning: boolean;
	thinkingLevelMap?: Model<Api>["thinkingLevelMap"];
	promptCache?: Model<Api>["promptCache"];
	contextWindow: number;
	maxTokens: number;
	samplingParams?: Record<string, unknown>;
	compat?: Model<Api>["compat"];
}

export type ProviderModelConfig = ProviderChatModelConfig;

export type ExtensionFactory = (pi: ExtensionAPI) => void | Promise<void>;

export type InlineExtension =
	| ExtensionFactory
	| {
			name: string;
			factory: ExtensionFactory;
			hidden?: boolean;
	  };

export interface RegisteredTool {
	definition: ToolDefinition;
	sourceInfo: SourceInfo;
}

export interface ExtensionFlag {
	name: string;
	description?: string;
	type: "boolean" | "string";
	default?: boolean | string;
	extensionPath: string;
}

export interface ExtensionShortcut {
	shortcut: KeyId;
	description?: string;
	handler: (ctx: ExtensionContext) => Promise<void> | void;
	extensionPath: string;
}

type HandlerFn = (...args: unknown[]) => Promise<unknown>;

type SendMessageHandler = <T = unknown>(
	message: Pick<CustomMessage<T>, "customType" | "content" | "display" | "details">,
	options?: { triggerTurn?: boolean; deliverAs?: "steer" | "followUp" | "nextTurn" },
) => void;

type SendUserMessageHandler = (
	content: string | (TextContent | MediaContent)[],
	options?: { deliverAs?: "steer" | "followUp"; expandPromptTemplates?: boolean },
) => void;

type AppendEntryHandler = <T = unknown>(customType: string, data?: T) => void;

type SetSessionNameHandler = (name: string) => void;

type GetSessionNameHandler = () => string | undefined;

type GetActiveToolsHandler = () => string[];

export type ToolInfo = Pick<ToolDefinition, "name" | "description" | "parameters"> & {
	sourceInfo: SourceInfo;
};

type GetAllToolsHandler = () => ToolInfo[];

type GetCommandsHandler = () => SlashCommandInfo[];

type SetActiveToolsHandler = (toolNames: string[]) => void;

type RefreshToolsHandler = () => void;

type SetModelHandler = (model: Model<any>) => Promise<boolean>;

type GetThinkingLevelHandler = () => ThinkingLevel;

type SetThinkingLevelHandler = (level: ThinkingLevel) => void;

type SetLabelHandler = (entryId: string, label: string | undefined) => void;

interface ExtensionRuntimeState {
	flagValues: Map<string, boolean | string>;
	pendingProviderRegistrations: Array<{ name: string; config: ProviderConfig; extensionPath: string }>;
	pendingNativeProviderRegistrations: Array<{ provider: Provider; extensionPath: string }>;
	assertActive: () => void;
	invalidate: (message?: string) => void;
	trackEventBusSubscription: (unsubscribe: () => void) => () => void;
	registerProvider: (name: string, config: ProviderConfig, extensionPath?: string) => void;
	registerNativeProvider: (provider: Provider, extensionPath?: string) => void;
	unregisterProvider: (name: string, extensionPath?: string) => void;
}

export interface ExtensionActions {
	sendMessage: SendMessageHandler;
	sendUserMessage: SendUserMessageHandler;
	appendEntry: AppendEntryHandler;
	setSessionName: SetSessionNameHandler;
	getSessionName: GetSessionNameHandler;
	setLabel: SetLabelHandler;
	getActiveTools: GetActiveToolsHandler;
	getAllTools: GetAllToolsHandler;
	setActiveTools: SetActiveToolsHandler;
	refreshTools: RefreshToolsHandler;
	getCommands: GetCommandsHandler;
	setModel: SetModelHandler;
	getThinkingLevel: GetThinkingLevelHandler;
	setThinkingLevel: SetThinkingLevelHandler;
}

export interface ExtensionContextActions {
	getModel: () => Model<any> | undefined;
	getScopedModels: () => readonly ScopedModel[];
	isIdle: () => boolean;
	getSignal: () => AbortSignal | undefined;
	abort: () => void;
	hasPendingMessages: () => boolean;
	shutdown: () => void;
	getContextUsage: () => ContextUsage | undefined;
	compact: (options?: CompactOptions) => void;
	getSystemPrompt: () => string;
	getSystemPromptOptions?: () => BuildSystemPromptOptions;
}

export interface ExtensionCommandContextActions {
	waitForIdle: () => Promise<void>;
	newSession: (options?: {
		parentSession?: string;
		setup?: (sessionManager: SessionManager) => Promise<void>;
		withSession?: (ctx: ReplacedSessionContext) => Promise<void>;
	}) => Promise<{ cancelled: boolean }>;
	fork: (
		entryId: string,
		options?: { position?: "before" | "at"; withSession?: (ctx: ReplacedSessionContext) => Promise<void> },
	) => Promise<{ cancelled: boolean }>;
	navigateTree: (
		targetId: string,
		options?: { summarize?: boolean; customInstructions?: string; replaceInstructions?: boolean; label?: string },
	) => Promise<{ cancelled: boolean }>;
	switchSession: (
		sessionPath: string,
		options?: { withSession?: (ctx: ReplacedSessionContext) => Promise<void> },
	) => Promise<{ cancelled: boolean }>;
	reload: () => Promise<void>;
}

export interface ExtensionRuntime extends ExtensionRuntimeState, ExtensionActions {}

export interface Extension {
	path: string;
	resolvedPath: string;
	hidden?: boolean;
	sourceInfo: SourceInfo;
	handlers: Map<string, HandlerFn[]>;
	tools: Map<string, RegisteredTool>;
	messageRenderers: Map<string, MessageRenderer>;
	markdownTransformer?: MarkdownTransformer;
	entryRenderers?: Map<string, EntryRenderer>;
	commands: Map<string, RegisteredCommand>;
	flags: Map<string, ExtensionFlag>;
	shortcuts: Map<KeyId, ExtensionShortcut>;
}

export interface LoadExtensionsResult {
	extensions: Extension[];
	errors: Array<{ path: string; error: string }>;
	warnings?: Array<{ path: string; warning: string }>;
	runtime: ExtensionRuntime;
}

export interface ExtensionError {
	extensionPath: string;
	event: string;
	error: string;
	stack?: string;
}
