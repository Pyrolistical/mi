import { Database } from "bun:sqlite";
import { existsSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import type { Message, TextContent } from "@earendil-works/pi-ai";
import { resolvePath } from "../utils/paths.ts";
import {
	formatMailboxAddress,
	MAILBOX_CUSTOM_TYPE,
	type MailboxMessage,
	type MailboxMessageDetails,
	parseMailboxAddress,
	signSessionId,
	verifySessionId,
} from "./mailbox.ts";
import type { SessionEntry, SessionHeader, SessionInfo } from "./session-manager.ts";

const SESSION_DB_FILE = "sessions.db";

const SCHEMA = `
PRAGMA journal_mode = WAL;
PRAGMA synchronous = NORMAL;
PRAGMA busy_timeout = 5000;

CREATE TABLE IF NOT EXISTS sessions (
	id TEXT PRIMARY KEY,
	cwd TEXT NOT NULL,
	created TEXT NOT NULL,
	parent_session_id TEXT,
	header TEXT NOT NULL,
	name TEXT,
	header_time INTEGER NOT NULL,
	last_activity INTEGER,
	modified INTEGER GENERATED ALWAYS AS (coalesce(last_activity, header_time)) VIRTUAL,
	message_count INTEGER NOT NULL,
	first_message TEXT
) WITHOUT ROWID;

CREATE INDEX IF NOT EXISTS ix_sessions_cwd ON sessions(cwd, modified);
CREATE INDEX IF NOT EXISTS ix_sessions_modified ON sessions(modified);

CREATE TABLE IF NOT EXISTS entries (
	seq INTEGER PRIMARY KEY,
	session_id TEXT NOT NULL,
	payload TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS ix_entries_session ON entries(session_id, seq);

CREATE VIRTUAL TABLE IF NOT EXISTS entry_text USING fts5(
	text,
	session_id UNINDEXED,
	entry_id UNINDEXED,
	role UNINDEXED,
	tokenize = 'unicode61 remove_diacritics 2',
	prefix = '2 3'
);

CREATE TABLE IF NOT EXISTS callback (
	id INTEGER PRIMARY KEY,
	session_id TEXT NOT NULL,
	origin TEXT NOT NULL,
	created_at INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS ix_callback_session ON callback(session_id);

CREATE TRIGGER IF NOT EXISTS callback_session_exists
BEFORE INSERT ON callback
WHEN NOT EXISTS (
	SELECT 1
	FROM sessions
	WHERE id = NEW.session_id
)
BEGIN
	SELECT RAISE(ABORT, 'no such session');
END;

CREATE TABLE IF NOT EXISTS callback_message (
	id INTEGER PRIMARY KEY,
	callback_id INTEGER NOT NULL,
	body TEXT NOT NULL,
	sent_at INTEGER NOT NULL,
	delivered_at INTEGER
);

CREATE INDEX IF NOT EXISTS ix_callback_message_callback ON callback_message(callback_id);

CREATE TRIGGER IF NOT EXISTS callback_message_callback_exists
BEFORE INSERT ON callback_message
WHEN NOT EXISTS (
	SELECT 1
	FROM callback
	WHERE id = NEW.callback_id
)
BEGIN
	SELECT RAISE(ABORT, 'no such session');
END;

CREATE TABLE IF NOT EXISTS mailbox_key (
	id INTEGER PRIMARY KEY CHECK (id = 1),
	key BLOB NOT NULL
);

INSERT OR IGNORE INTO mailbox_key (id, key) VALUES (1, randomblob(32));
`;

interface EntrySummary {
	message: boolean;
	activity: number | undefined;
	role: "user" | "assistant" | undefined;
	text: string | undefined;
	name: string | null | undefined;
}

interface SessionSummary {
	name: string | null;
	lastActivity: number | null;
	messageCount: number;
	firstMessage: string | null;
}

interface SessionRow {
	id: string;
	cwd: string;
	created: string;
	parent_session_id: string | null;
	name: string | null;
	modified: number;
	message_count: number;
	first_message: string | null;
	all_text: string | null;
}

export interface StoredPrompt {
	seq: number;
	sessionId: string;
	text: string;
}

export interface SessionPrompts {
	sessionId: string;
	cwd: string;
	name: string | undefined;
	prompts: StoredPrompt[];
}

function isMessageWithContent(message: unknown): message is Message {
	return typeof message === "object" && message !== null && "role" in message && "content" in message;
}

function textBlocks(message: Message): string[] {
	const content = message.content;
	if (typeof content === "string") {
		return [content];
	}
	return content.filter((block): block is TextContent => block.type === "text").map((block) => block.text);
}

function summarizeEntry(entry: SessionEntry): EntrySummary {
	const summary: EntrySummary = {
		message: false,
		activity: undefined,
		role: undefined,
		text: undefined,
		name: undefined,
	};
	if (entry.type === "session_info") {
		summary.name = entry.name?.trim() || null;
		return summary;
	}
	if (entry.type !== "message") return summary;
	summary.message = true;
	const message = entry.message;
	if (!isMessageWithContent(message)) return summary;
	if (message.role !== "user" && message.role !== "assistant") return summary;
	summary.role = message.role;
	const entryTime = new Date(entry.timestamp).getTime();
	summary.activity =
		typeof message.timestamp === "number" ? message.timestamp : Number.isNaN(entryTime) ? undefined : entryTime;
	const text = textBlocks(message).join("\n");
	summary.text = text || undefined;
	return summary;
}

function firstMessageText(entry: SessionEntry, summary: EntrySummary): string | undefined {
	if (summary.role !== "user" || !summary.text || entry.type !== "message") return undefined;
	if (!isMessageWithContent(entry.message)) return undefined;
	return textBlocks(entry.message).join(" ");
}

function headerTime(header: SessionHeader): number {
	const time = new Date(header.timestamp).getTime();
	return Number.isNaN(time) ? 0 : time;
}

function toFtsQuery(input: string): string {
	return input
		.split(/\s+/)
		.filter((token) => token.length > 0)
		.map((token) => `"${token.replaceAll('"', '""')}"*`)
		.join(" ");
}

export class SessionStore {
	private static readonly stores = new Map<string, SessionStore>();

	static open(sessionDir: string): SessionStore {
		const dbPath = join(resolvePath(sessionDir), SESSION_DB_FILE);
		const cached = SessionStore.stores.get(dbPath);
		if (cached && existsSync(dbPath)) return cached;
		mkdirSync(resolvePath(sessionDir), { recursive: true });
		const db = new Database(dbPath, { create: true, strict: true });
		db.exec(SCHEMA);
		const store = new SessionStore(db, dbPath);
		SessionStore.stores.set(dbPath, store);
		return store;
	}

	private readonly db: Database;
	private readonly mailboxKey: Uint8Array;
	readonly path: string;

	private constructor(db: Database, path: string) {
		this.db = db;
		this.path = path;
		this.mailboxKey = db.query<{ key: Uint8Array }, []>(`SELECT key FROM mailbox_key`).get()!.key;
	}

	has(id: string): boolean {
		const row = this.db
			.query<{ id: string }, [string]>(
				`SELECT id
				FROM sessions
				WHERE id = ?`,
			)
			.get(id);
		return row !== null;
	}

	load(id: string): { header: SessionHeader; entries: SessionEntry[] } | undefined {
		const row = this.db
			.query<{ header: string }, [string]>(
				`SELECT header
				FROM sessions
				WHERE id = ?`,
			)
			.get(id);
		if (!row) return undefined;
		const header: SessionHeader = JSON.parse(row.header);
		const entries = this.db
			.query<{ payload: string }, [string]>(
				`SELECT payload
				FROM entries
				WHERE session_id = ?
				ORDER BY seq`,
			)
			.all(id)
			.map((entryRow): SessionEntry => JSON.parse(entryRow.payload));
		return { header, entries };
	}

	insert(header: SessionHeader, entries: SessionEntry[]): void {
		const entrySummaries = entries.map(summarizeEntry);
		this.db
			.transaction(() => {
				const summary: SessionSummary = {
					name: null,
					lastActivity: null,
					messageCount: 0,
					firstMessage: null,
				};
				for (const [index, entry] of entries.entries()) {
					const entrySummary = entrySummaries[index]!;
					if (entrySummary.name !== undefined) summary.name = entrySummary.name;
					if (entrySummary.message) summary.messageCount++;
					if (entrySummary.activity !== undefined) {
						summary.lastActivity = Math.max(summary.lastActivity ?? 0, entrySummary.activity);
					}
					summary.firstMessage ??= firstMessageText(entry, entrySummary) ?? null;
				}
				this.db
					.query(
						`INSERT INTO sessions (id, cwd, created, parent_session_id, header, name, header_time, last_activity, message_count, first_message)
						VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
					)
					.run(
						header.id,
						header.cwd,
						header.timestamp,
						header.parentSession ?? null,
						JSON.stringify(header),
						summary.name,
						headerTime(header),
						summary.lastActivity,
						summary.messageCount,
						summary.firstMessage,
					);
				for (const [index, entry] of entries.entries()) {
					this.insertEntry(header.id, entry, entrySummaries[index]!);
				}
			})
			.immediate();
	}

	append(sessionId: string, entry: SessionEntry): void {
		const summary = summarizeEntry(entry);
		this.db
			.transaction(() => {
				this.insertEntry(sessionId, entry, summary);
				this.db
					.query(
						`UPDATE sessions
						SET
							message_count = message_count + ?,
							last_activity = coalesce(max(last_activity, ?), ?, last_activity),
							first_message = coalesce(first_message, ?),
							name = CASE WHEN ? THEN ? ELSE name END
						WHERE id = ?`,
					)
					.run(
						summary.message ? 1 : 0,
						summary.activity ?? null,
						summary.activity ?? null,
						firstMessageText(entry, summary) ?? null,
						summary.name !== undefined,
						summary.name ?? null,
						sessionId,
					);
			})
			.immediate();
	}

	delete(id: string): void {
		this.db
			.transaction(() => {
				this.deleteRows(id);
			})
			.immediate();
	}

	list(cwd?: string): SessionInfo[] {
		const select = `SELECT
				s.id,
				s.cwd,
				s.created,
				s.parent_session_id,
				s.name,
				s.modified,
				s.message_count,
				s.first_message,
				(
					SELECT group_concat(t.text, ' ')
					FROM entries e
					JOIN entry_text t ON t.rowid = e.seq
					WHERE e.session_id = s.id
				) AS all_text
			FROM sessions s`;
		const rows =
			cwd === undefined
				? this.db
						.query<SessionRow, []>(
							`${select}
							ORDER BY s.modified DESC`,
						)
						.all()
				: this.db
						.query<SessionRow, [string]>(
							`${select}
							WHERE s.cwd = ?
							ORDER BY s.modified DESC`,
						)
						.all(cwd);
		return rows.map((row): SessionInfo => ({
			id: row.id,
			cwd: row.cwd,
			name: row.name ?? undefined,
			parentSessionId: row.parent_session_id ?? undefined,
			created: new Date(row.created),
			modified: new Date(row.modified),
			messageCount: row.message_count,
			firstMessage: row.first_message ?? "(no messages)",
			allMessagesText: row.all_text ?? "",
		}));
	}

	mostRecent(cwd: string): string | undefined {
		const row = this.db
			.query<{ id: string }, [string]>(
				`SELECT id
				FROM sessions
				WHERE cwd = ?
				ORDER BY modified DESC
				LIMIT 1`,
			)
			.get(cwd);
		return row?.id;
	}

	find(idOrPrefix: string, cwd: string): { id: string; cwd: string } | undefined {
		const row = this.db
			.query<{ id: string; cwd: string }, [string, string, string, string]>(
				`SELECT id, cwd
				FROM sessions
				WHERE substr(id, 1, length(?)) = ?
				ORDER BY cwd = ? DESC, id = ? DESC, modified DESC
				LIMIT 1`,
			)
			.get(idOrPrefix, idOrPrefix, cwd, idOrPrefix);
		return row ?? undefined;
	}

	searchPrompts(query: string, limit: number): StoredPrompt[] {
		const match = toFtsQuery(query);
		return match
			? this.db
					.query<StoredPrompt, [string, number]>(
						`SELECT max(rowid) AS seq, session_id AS sessionId, text
						FROM entry_text
						WHERE entry_text MATCH ?
							AND role = 'user'
						GROUP BY text
						ORDER BY seq DESC
						LIMIT ?`,
					)
					.all(match, limit)
			: this.db
					.query<StoredPrompt, [number]>(
						`SELECT max(rowid) AS seq, session_id AS sessionId, text
						FROM entry_text
						WHERE role = 'user'
						GROUP BY text
						ORDER BY seq DESC
						LIMIT ?`,
					)
					.all(limit);
	}

	sessionPrompts(sessionId: string): SessionPrompts {
		const session = this.db
			.query<{ cwd: string; name: string | null }, [string]>(
				`SELECT cwd, name
				FROM sessions
				WHERE id = ?`,
			)
			.get(sessionId);
		if (!session) throw new Error(`no such session ${sessionId}`);
		const prompts = this.db
			.query<StoredPrompt, [string]>(
				`SELECT t.rowid AS seq, e.session_id AS sessionId, t.text
				FROM entries e
				JOIN entry_text t ON t.rowid = e.seq
				WHERE e.session_id = ?
					AND t.role = 'user'
				ORDER BY e.seq DESC`,
			)
			.all(sessionId);
		return { sessionId, cwd: session.cwd, name: session.name ?? undefined, prompts };
	}

	promptHistory(cwd: string, limit: number): string[] {
		return this.db
			.query<{ text: string }, [string, number]>(
				`SELECT t.text
				FROM sessions s
				JOIN entries e ON e.session_id = s.id
				JOIN entry_text t ON t.rowid = e.seq
				WHERE s.cwd = ?
					AND t.role = 'user'
				ORDER BY e.seq DESC
				LIMIT ?`,
			)
			.all(cwd, limit)
			.map((row) => row.text);
	}

	sessionIdSignature(sessionId: string): string {
		return signSessionId(this.mailboxKey, sessionId);
	}

	createMailboxAddress(sessionId: string, sessionIdSignature: string, origin: string, createdAt: number): string {
		verifySessionId(this.mailboxKey, sessionId, sessionIdSignature);
		const callbackId = this.db
			.query<{ id: number }, [string, string, number]>(
				`INSERT INTO callback (session_id, origin, created_at)
				VALUES (?, ?, ?)
				RETURNING id`,
			)
			.get(sessionId, origin, createdAt)!.id;
		return formatMailboxAddress(this.mailboxKey, callbackId);
	}

	sendMessage(address: string, body: string, sentAt: number): void {
		this.db
			.query(
				`INSERT INTO callback_message (callback_id, body, sent_at)
				VALUES (?, ?, ?)`,
			)
			.run(parseMailboxAddress(this.mailboxKey, address), body, sentAt);
	}

	undeliveredMessages(sessionId: string): MailboxMessage[] {
		return this.db
			.query<MailboxMessage, [string]>(
				`SELECT m.id, c.origin, m.body, m.sent_at AS sentAt
				FROM callback_message m
				JOIN callback c ON c.id = m.callback_id
				WHERE c.session_id = ?
					AND m.delivered_at IS NULL
				ORDER BY m.id`,
			)
			.all(sessionId);
	}

	pendingCallbacks(sessionId: string): number {
		return this.db
			.query<{ pending: number }, [string]>(
				`SELECT COUNT(*) AS pending
				FROM callback c
				WHERE c.session_id = ?
					AND NOT EXISTS (
						SELECT 1
						FROM callback_message m
						WHERE m.callback_id = c.id
					)`,
			)
			.get(sessionId)!.pending;
	}

	private insertEntry(sessionId: string, entry: SessionEntry, summary: EntrySummary): void {
		const result = this.db
			.query(
				`INSERT INTO entries (session_id, payload)
				VALUES (?, ?)`,
			)
			.run(sessionId, JSON.stringify(entry));
		if (entry.type === "custom_message" && entry.customType === MAILBOX_CUSTOM_TYPE) {
			const details = entry.details as MailboxMessageDetails;
			this.db
				.query(
					`UPDATE callback_message
					SET delivered_at = ?
					WHERE id = ?
						AND delivered_at IS NULL
						AND callback_id IN (
							SELECT id
							FROM callback
							WHERE session_id = ?
						)`,
				)
				.run(Date.now(), details.id, sessionId);
		}
		if (!summary.text || !summary.role) return;
		this.db
			.query(
				`INSERT INTO entry_text (rowid, text, session_id, entry_id, role)
				VALUES (?, ?, ?, ?, ?)`,
			)
			.run(result.lastInsertRowid, summary.text, sessionId, entry.id, summary.role);
	}

	private deleteRows(id: string): void {
		this.db
			.query(
				`DELETE FROM callback_message
				WHERE callback_id IN (
					SELECT id
					FROM callback
					WHERE session_id = ?
				)`,
			)
			.run(id);
		this.db
			.query(
				`DELETE FROM callback
				WHERE session_id = ?`,
			)
			.run(id);
		this.db
			.query(
				`DELETE FROM entry_text
				WHERE rowid IN (
					SELECT seq
					FROM entries
					WHERE session_id = ?
				)`,
			)
			.run(id);
		this.db
			.query(
				`DELETE FROM entries
				WHERE session_id = ?`,
			)
			.run(id);
		this.db
			.query(
				`DELETE FROM sessions
				WHERE id = ?`,
			)
			.run(id);
	}
}
