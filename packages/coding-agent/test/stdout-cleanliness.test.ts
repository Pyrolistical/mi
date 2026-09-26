import { spawn } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { ENV_AGENT_DIR } from "../src/config.ts";
import { allowNetwork } from "./test-network-env.ts";

const cliPath = resolve(__dirname, "../src/cli.ts");

const tempDirs: string[] = [];

beforeEach(() => {
	allowNetwork();
});

afterEach(() => {
	for (const dir of tempDirs.splice(0)) {
		rmSync(dir, { recursive: true, force: true });
	}
});

function createTempDir(): string {
	const dir = mkdtempSync(join(tmpdir(), "pi-stdout-clean-"));
	tempDirs.push(dir);
	return dir;
}

async function runCli(args: string[]): Promise<{ stdout: string; stderr: string; code: number | null }> {
	const tempRoot = createTempDir();
	const agentDir = join(tempRoot, "agent");
	const projectDir = join(tempRoot, "project");
	mkdirSync(agentDir, { recursive: true });
	mkdirSync(projectDir, { recursive: true });

	return await new Promise((resolvePromise, reject) => {
		const child = spawn(process.execPath, [cliPath, ...args], {
			cwd: projectDir,
			env: {
				...process.env,
				[ENV_AGENT_DIR]: agentDir,
			},
			stdio: ["ignore", "pipe", "pipe"],
		});

		let stdout = "";
		let stderr = "";
		child.stdout.on("data", (chunk) => {
			stdout += chunk.toString();
		});
		child.stderr.on("data", (chunk) => {
			stderr += chunk.toString();
		});
		child.on("error", reject);
		child.on("close", (code) => {
			resolvePromise({ stdout, stderr, code });
		});
	});
}

describe("stdout cleanliness", () => {
	it("prints plain --help to stdout when stdout is redirected", async () => {
		const result = await runCli(["--help"]);

		expect(result.code).toBe(0);
		expect(result.stdout).toContain("Usage:");
		expect(result.stderr).not.toContain("Usage:");
	});
});
