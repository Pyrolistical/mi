import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { execFile } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { countMiBehind, countPiBehind, scheduledChecks, UpdateStore } from "../src/core/update-check.ts";

const execFileAsync = promisify(execFile);

describe("scheduledChecks", () => {
	it("uses yesterday's check before 12:00 UTC", () => {
		expect(scheduledChecks(Date.parse("2026-09-26T11:00:00Z"))).toEqual({
			latest: Date.parse("2026-09-25T12:00:00Z"),
			next: Date.parse("2026-09-26T12:00:00Z"),
		});
	});

	it("uses today's check at and after 12:00 UTC", () => {
		expect(scheduledChecks(Date.parse("2026-09-26T12:00:00Z"))).toEqual({
			latest: Date.parse("2026-09-26T12:00:00Z"),
			next: Date.parse("2026-09-27T12:00:00Z"),
		});
	});

	it("crosses month and year ends", () => {
		expect(scheduledChecks(Date.parse("2026-12-31T13:00:00Z"))).toEqual({
			latest: Date.parse("2026-12-31T12:00:00Z"),
			next: Date.parse("2027-01-01T12:00:00Z"),
		});
	});
});

describe("UpdateStore", () => {
	let dir: string;

	beforeEach(async () => {
		dir = await mkdtemp(join(tmpdir(), "update-store-"));
	});

	afterEach(async () => {
		await rm(dir, { recursive: true, force: true });
	});

	it("lets only one instance claim a due check and shares its result", () => {
		const a = UpdateStore.open(join(dir, "update.sqlite"));
		const b = UpdateStore.open(join(dir, "update.sqlite"));

		expect(a.claim("a", 1_000, 2_000)).toBe(true);
		expect(b.claim("b", 1_000, 2_000)).toBe(false);
		a.complete("a", 7, 3_000);

		expect(b.claim("b", 1_000, 4_000)).toBe(false);
		expect(b.readPiBehind()).toBe(7);
		expect(b.claim("b", 5_000, 6_000)).toBe(true);
		a.close();
		b.close();
	});

	it("takes over a claim abandoned for over ten minutes", () => {
		const a = UpdateStore.open(join(dir, "update.sqlite"));
		const b = UpdateStore.open(join(dir, "update.sqlite"));

		expect(a.claim("a", 1_000, 2_000)).toBe(true);
		expect(b.claim("b", 1_000, 602_001)).toBe(true);
		a.complete("a", 7, 602_002);

		expect(b.readPiBehind()).toBe(0);
		a.close();
		b.close();
	});
});

describe("commit counts", () => {
	let repo: string;

	async function git(...args: string[]): Promise<string> {
		const { stdout } = await execFileAsync("git", ["-c", "user.name=t", "-c", "user.email=t@t", ...args], {
			cwd: repo,
		});
		return stdout.trim();
	}

	async function commit(message: string): Promise<string> {
		await writeFile(join(repo, "file.txt"), message);
		await git("add", "file.txt");
		await git("commit", "-q", "-m", message);
		return git("rev-parse", "HEAD");
	}

	beforeEach(async () => {
		repo = await mkdtemp(join(tmpdir(), "update-repo-"));
		await git("init", "-q", "-b", "master");
		const fork = await commit("fork point");
		await commit("upstream 1");
		const upstream = await commit("upstream 2");
		await git("update-ref", "refs/remotes/upstream/main", upstream);
		await git("reset", "-q", "--hard", fork);
	});

	afterEach(async () => {
		await rm(repo, { recursive: true, force: true });
	});

	it("counts upstream commits not in master since the fork point", async () => {
		await commit("mi 1");

		expect(await countPiBehind(repo)).toBe(2);
	});

	it("counts master commits added since startup", async () => {
		const start = await commit("mi 1");
		await commit("mi 2");
		await commit("mi 3");

		expect(await countMiBehind(repo, start)).toBe(2);
	});

	it("counts all mi commits on top of pi when master was rewritten", async () => {
		const start = await commit("mi 1");
		await git("reset", "-q", "--hard", "HEAD~1");
		await commit("mi 1 rewritten");
		await commit("mi 2");

		expect(await countMiBehind(repo, start)).toBe(2);
	});
});
