import { createHmac, randomBytes, timingSafeEqual } from "node:crypto";
import { type FSWatcher, watch, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, join } from "node:path";
import type { SessionStore } from "./session-store.ts";
import { DEFAULT_MAX_BYTES, formatSize, truncateHead } from "./tools/truncate.ts";

export const MAILBOX_CUSTOM_TYPE = "mailbox";

export interface MailboxMessage {
	id: number;
	origin: string;
	body: string;
	sentAt: number;
}

export type MailboxMessageDetails = Omit<MailboxMessage, "body">;

function sign(key: Uint8Array, text: string): string {
	return createHmac("sha256", key).update(text).digest("base64url");
}

function verify(key: Uint8Array, text: string, signature: string, error: string): void {
	const actual = Buffer.from(signature, "base64url");
	const expected = Buffer.from(sign(key, text), "base64url");
	if (actual.length !== expected.length || !timingSafeEqual(actual, expected)) throw new Error(error);
}

export function signSessionId(key: Uint8Array, sessionId: string): string {
	return sign(key, sessionId);
}

export function verifySessionId(key: Uint8Array, sessionId: string, signature: string): void {
	verify(key, sessionId, signature, "invalid session id signature");
}

export function formatMailboxAddress(key: Uint8Array, callbackId: number): string {
	return `${callbackId}:${sign(key, String(callbackId))}`;
}

export function parseMailboxAddress(key: Uint8Array, text: string): number {
	const [callbackId, signature, ...rest] = text.split(":");
	if (!callbackId || !/^\d+$/.test(callbackId) || !signature || rest.length > 0) throw new Error("malformed address");
	verify(key, callbackId, signature, "invalid address signature");
	return Number(callbackId);
}

export function mailboxMessageDetails({ id, origin, sentAt }: MailboxMessage): MailboxMessageDetails {
	return { id, origin, sentAt };
}

export function formatMailboxMessage({ origin, body }: MailboxMessage): string {
	const truncation = truncateHead(body);
	if (!truncation.truncated) return `Callback from ${origin}\n\n${body}`;
	const path = join(tmpdir(), `mi-callback-${randomBytes(8).toString("hex")}.txt`);
	writeFileSync(path, body);
	if (truncation.firstLineExceedsLimit) {
		const firstLineSize = formatSize(Buffer.byteLength(body.split("\n", 1)[0], "utf-8"));
		return `Callback from ${origin}\n\n[Line 1 is ${firstLineSize}, exceeds ${formatSize(DEFAULT_MAX_BYTES)} limit. Full message: ${path}]`;
	}
	const limit = truncation.truncatedBy === "bytes" ? ` (${formatSize(DEFAULT_MAX_BYTES)} limit)` : "";
	return `Callback from ${origin}\n\n${truncation.content}\n\n[Showing lines 1-${truncation.outputLines} of ${truncation.totalLines}${limit}. Full message: ${path}]`;
}

export class Mailbox {
	private readonly store: SessionStore;
	private readonly sessionId: () => string;
	private readonly deliver: (message: MailboxMessage) => void;
	private readonly pendingChanged: (pending: number) => void;
	private readonly delivering = new Set<number>();
	private readonly watcher: FSWatcher;
	pending = 0;

	constructor(
		store: SessionStore,
		sessionId: () => string,
		deliver: (message: MailboxMessage) => void,
		pendingChanged: (pending: number) => void,
	) {
		this.store = store;
		this.sessionId = sessionId;
		this.deliver = deliver;
		this.pendingChanged = pendingChanged;
		const wal = `${basename(store.path)}-wal`;
		this.watcher = watch(dirname(store.path), (_event, filename) => {
			if (filename === wal) this.check();
		});
		this.check();
	}

	close(): void {
		this.watcher.close();
	}

	private check(): void {
		const pending = this.store.pendingCallbacks(this.sessionId());
		if (pending !== this.pending) {
			this.pending = pending;
			this.pendingChanged(pending);
		}
		for (const message of this.store.undeliveredMessages(this.sessionId())) {
			if (this.delivering.has(message.id)) continue;
			this.delivering.add(message.id);
			this.deliver(message);
		}
	}
}
