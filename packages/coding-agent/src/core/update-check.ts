import { Database } from "bun:sqlite";
import { execFile } from "node:child_process";
import { randomUUID } from "node:crypto";
import { type FSWatcher, mkdirSync, watch } from "node:fs";
import { join } from "node:path";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

const UPDATE_DB_FILE = "update.sqlite";
const CHECK_HOUR_UTC = 12;
const DAY_MS = 24 * 60 * 60_000;
const CLAIM_TIMEOUT_MS = 10 * 60_000;
const GIT_TIMEOUT_MS = 120_000;

const SCHEMA = `
PRAGMA busy_timeout = 5000;

CREATE TABLE IF NOT EXISTS update_check (
	id INTEGER PRIMARY KEY CHECK (id = 1),
	pi_behind INTEGER NOT NULL DEFAULT 0,
	fetched_at INTEGER NOT NULL DEFAULT 0,
	claimed_by TEXT,
	claimed_at INTEGER
);

INSERT OR IGNORE INTO update_check (id)
VALUES (1);
`;

export interface UpdateCounts {
	mi: number;
	pi: number;
}

export function scheduledChecks(now: number): { latest: number; next: number } {
	const date = new Date(now);
	const today = Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate(), CHECK_HOUR_UTC);
	if (today <= now) {
		return { latest: today, next: today + DAY_MS };
	}
	return { latest: today - DAY_MS, next: today };
}

async function git(repoDir: string, args: string[]): Promise<string> {
	const { stdout } = await execFileAsync("git", args, { cwd: repoDir, signal: AbortSignal.timeout(GIT_TIMEOUT_MS) });
	return stdout.trim();
}

async function countCommits(repoDir: string, range: string): Promise<number> {
	return Number(await git(repoDir, ["rev-list", "--count", range]));
}

async function isAncestor(repoDir: string, ancestor: string, descendant: string): Promise<boolean> {
	try {
		await git(repoDir, ["merge-base", "--is-ancestor", ancestor, descendant]);
		return true;
	} catch (error) {
		if (error instanceof Error && "code" in error && error.code === 1) {
			return false;
		}
		throw error;
	}
}

export async function countPiBehind(repoDir: string): Promise<number> {
	const base = await git(repoDir, ["merge-base", "master", "upstream/main"]);
	return countCommits(repoDir, `${base}..upstream/main`);
}

export async function countMiBehind(repoDir: string, startCommit: string): Promise<number> {
	if (await isAncestor(repoDir, startCommit, "master")) {
		return countCommits(repoDir, `${startCommit}..master`);
	}
	const base = await git(repoDir, ["merge-base", "master", "upstream/main"]);
	return countCommits(repoDir, `${base}..master`);
}

export class UpdateStore {
	private readonly db: Database;

	constructor(db: Database) {
		this.db = db;
	}

	static open(dbPath: string): UpdateStore {
		const db = new Database(dbPath, { create: true, strict: true });
		db.exec(SCHEMA);
		return new UpdateStore(db);
	}

	readPiBehind(): number {
		const row = this.db
			.query<{ pi_behind: number }, []>(
				`SELECT pi_behind
				FROM update_check
				WHERE id = 1`,
			)
			.get();
		if (!row) {
			throw new Error("update_check row is missing");
		}
		return row.pi_behind;
	}

	setPiBehind(piBehind: number): void {
		this.db
			.query(
				`UPDATE update_check
				SET pi_behind = ?
				WHERE id = 1`,
			)
			.run(piBehind);
	}

	claim(owner: string, dueAt: number, now: number): boolean {
		return this.db
			.transaction(() => {
				const result = this.db
					.query(
						`UPDATE update_check
						SET claimed_by = ?, claimed_at = ?
						WHERE id = 1
							AND fetched_at < ?
							AND (claimed_at IS NULL OR claimed_at < ?)`,
					)
					.run(owner, now, dueAt, now - CLAIM_TIMEOUT_MS);
				return result.changes === 1;
			})
			.immediate();
	}

	complete(owner: string, piBehind: number, now: number): void {
		this.db
			.query(
				`UPDATE update_check
				SET pi_behind = ?, fetched_at = ?, claimed_by = NULL, claimed_at = NULL
				WHERE id = 1
					AND claimed_by = ?`,
			)
			.run(piBehind, now, owner);
	}

	release(owner: string): void {
		this.db
			.query(
				`UPDATE update_check
				SET claimed_by = NULL, claimed_at = NULL
				WHERE id = 1
					AND claimed_by = ?`,
			)
			.run(owner);
	}

	close(): void {
		this.db.close();
	}
}

export class UpdateChecker {
	private readonly owner = randomUUID();
	private readonly disposed = new AbortController();
	private readonly watchers: FSWatcher[] = [];
	private counts: UpdateCounts = { mi: 0, pi: 0 };
	private refreshing = false;
	private refreshAgain = false;
	private listener: ((counts: UpdateCounts) => void) | undefined;
	private errorListener: ((error: unknown) => void) | undefined;

	private readonly repoDir: string;
	private readonly gitDir: string;
	private readonly startCommit: string;
	private readonly dbPath: string;
	private readonly store: UpdateStore;

	private constructor(repoDir: string, gitDir: string, startCommit: string, dbPath: string, store: UpdateStore) {
		this.repoDir = repoDir;
		this.gitDir = gitDir;
		this.startCommit = startCommit;
		this.dbPath = dbPath;
		this.store = store;
	}

	static async create(sourceDir: string, agentDir: string): Promise<UpdateChecker> {
		const repoDir = await git(sourceDir, ["rev-parse", "--show-toplevel"]);
		const gitDir = await git(repoDir, ["rev-parse", "--absolute-git-dir"]);
		const startCommit = await git(repoDir, ["rev-parse", "HEAD"]);
		mkdirSync(agentDir, { recursive: true });
		const dbPath = join(agentDir, UPDATE_DB_FILE);
		return new UpdateChecker(repoDir, gitDir, startCommit, dbPath, UpdateStore.open(dbPath));
	}

	start(onChange: (counts: UpdateCounts) => void, onError: (error: unknown) => void): void {
		this.listener = onChange;
		this.errorListener = onError;
		this.watchers.push(watch(this.dbPath, () => this.readStored()));
		this.watchers.push(watch(join(this.gitDir, "logs", "refs", "heads", "master"), () => void this.refresh()));
		this.scheduleNext();
		void this.startup();
	}

	dispose(): void {
		this.disposed.abort();
		for (const watcher of this.watchers) {
			watcher.close();
		}
		this.store.close();
	}

	private async startup(): Promise<void> {
		await this.refresh();
		await this.runIfDue();
	}

	private scheduleNext(): void {
		const now = Date.now();
		const signal = AbortSignal.any([this.disposed.signal, AbortSignal.timeout(scheduledChecks(now).next - now)]);
		signal.addEventListener("abort", () => {
			if (this.disposed.signal.aborted) {
				return;
			}
			this.scheduleNext();
			void this.runIfDue();
		});
	}

	private async runIfDue(): Promise<void> {
		const now = Date.now();
		if (!this.store.claim(this.owner, scheduledChecks(now).latest, now)) {
			return;
		}
		try {
			await git(this.repoDir, ["fetch", "--quiet", "upstream"]);
			this.store.complete(this.owner, await countPiBehind(this.repoDir), Date.now());
		} catch (error) {
			this.store.release(this.owner);
			this.errorListener?.(error);
		}
	}

	private readStored(): void {
		if (this.disposed.signal.aborted) {
			return;
		}
		try {
			this.emit({ ...this.counts, pi: this.store.readPiBehind() });
		} catch (error) {
			this.errorListener?.(error);
		}
	}

	private async refresh(): Promise<void> {
		if (this.refreshing) {
			this.refreshAgain = true;
			return;
		}
		this.refreshing = true;
		try {
			do {
				this.refreshAgain = false;
				const mi = await countMiBehind(this.repoDir, this.startCommit);
				const pi = await countPiBehind(this.repoDir);
				if (this.disposed.signal.aborted) {
					return;
				}
				this.store.setPiBehind(pi);
				this.emit({ mi, pi });
			} while (this.refreshAgain);
		} catch (error) {
			this.errorListener?.(error);
		} finally {
			this.refreshing = false;
		}
	}

	private emit(counts: UpdateCounts): void {
		if (counts.mi === this.counts.mi && counts.pi === this.counts.pi) {
			return;
		}
		this.counts = counts;
		this.listener?.(counts);
	}
}
