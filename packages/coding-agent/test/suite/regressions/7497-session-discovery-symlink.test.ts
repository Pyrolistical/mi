import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { importLegacyJsonlSessions, SessionManager } from "../../../src/core/session-manager.ts";

describe("regression #7497: import legacy sessions through symlinked directories", () => {
	let tempDir: string;
	let sessionsDir: string;

	beforeEach(() => {
		tempDir = mkdtempSync(join(tmpdir(), "pi-session-discovery-"));
		sessionsDir = join(tempDir, "agent", "sessions");
		mkdirSync(sessionsDir, { recursive: true });
	});

	afterEach(() => {
		rmSync(tempDir, { recursive: true, force: true });
	});

	function writeSession(dir: string, id: string): void {
		mkdirSync(dir, { recursive: true });
		writeFileSync(
			join(dir, `${id}.jsonl`),
			`${JSON.stringify({
				type: "session",
				version: 3,
				id,
				timestamp: "2026-08-03T00:00:00.000Z",
				cwd: join(tempDir, "project"),
			})}\n`,
		);
	}

	it("imports a session through a directory link", () => {
		const targetDir = join(tempDir, "linked-sessions");
		writeSession(targetDir, "linked");
		const aliasDir = join(sessionsDir, "--linked--");
		symlinkSync(targetDir, aliasDir, "dir");

		importLegacyJsonlSessions(sessionsDir);

		expect(SessionManager.listAll(sessionsDir).map((session) => session.id)).toEqual(["linked"]);
	});

	it("ignores a broken directory link without hiding valid sessions", () => {
		writeSession(join(sessionsDir, "--regular--"), "regular");
		const targetDir = join(tempDir, "removed-sessions");
		mkdirSync(targetDir);
		symlinkSync(targetDir, join(sessionsDir, "--broken--"), "dir");
		rmSync(targetDir, { recursive: true });

		importLegacyJsonlSessions(sessionsDir);

		expect(SessionManager.listAll(sessionsDir).map((session) => session.id)).toEqual(["regular"]);
	});

	it("ignores links to files", () => {
		writeSession(join(sessionsDir, "--regular--"), "regular");
		const targetFile = join(tempDir, "not-a-directory");
		writeFileSync(targetFile, "");
		symlinkSync(targetFile, join(sessionsDir, "--file--"), "file");

		importLegacyJsonlSessions(sessionsDir);

		expect(SessionManager.listAll(sessionsDir).map((session) => session.id)).toEqual(["regular"]);
	});
});
