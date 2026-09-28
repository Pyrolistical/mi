import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "bun:test";
import { type FakeChatRequest, type FakeLlamaServer, startFakeLlamaServer } from "./fake-llama-server.ts";

const CLI = join(import.meta.dir, "../src/cli.ts");
const E2E_TIMEOUT_MS = 30_000;

interface E2E {
	dir: string;
	server: FakeLlamaServer;
	configDir: string;
	sessionDir: string;
	socket: string;
}

function setup(): E2E {
	const dir = mkdtempSync(join(tmpdir(), "mi-e2e-"));
	const server = startFakeLlamaServer();
	const configDir = join(dir, "config");
	mkdirSync(join(configDir, "mi"), { recursive: true });
	writeFileSync(
		join(configDir, "mi", "models.json"),
		JSON.stringify({ providers: { fake: { baseUrl: server.baseUrl } } }),
	);
	return { dir, server, configDir, sessionDir: join(dir, "sessions"), socket: join(dir, "tmux.sock") };
}

function teardown(e2e: E2E): void {
	Bun.spawnSync(["tmux", "-S", e2e.socket, "kill-server"]);
	e2e.server.stop();
	rmSync(e2e.dir, { recursive: true });
}

function tmux(e2e: E2E, ...args: string[]): string {
	const result = Bun.spawnSync(["tmux", "-S", e2e.socket, ...args]);
	if (result.exitCode !== 0) throw new Error(`tmux ${args.join(" ")}: ${result.stderr.toString()}`);
	return result.stdout.toString();
}

function quote(word: string): string {
	return `'${word.replaceAll("'", `'\\''`)}'`;
}

async function launch(e2e: E2E, ...flags: string[]): Promise<void> {
	const env = { ...process.env, XDG_CONFIG_HOME: e2e.configDir };
	const listModels = Bun.spawn([process.execPath, CLI, "--list-models"], { env, cwd: e2e.dir, stdout: "ignore" });
	expect(await listModels.exited).toBe(0);
	const command = [
		"env",
		`XDG_CONFIG_HOME=${e2e.configDir}`,
		process.execPath,
		CLI,
		"--offline",
		"--model",
		"fake/fake",
		"--session-dir",
		e2e.sessionDir,
		...flags,
	];
	tmux(e2e, "new-session", "-d", "-s", "mi", "-x", "100", "-y", "30", "-c", e2e.dir, command.map(quote).join(" "));
	await screenLine(e2e, /fake$/);
}

function screen(e2e: E2E): string[] {
	return tmux(e2e, "capture-pane", "-p", "-t", "mi").split("\n");
}

async function until<T>(description: () => string, check: () => T | undefined): Promise<T> {
	const deadline = Date.now() + 10_000;
	while (Date.now() < deadline) {
		const value = check();
		if (value !== undefined) return value;
		await Bun.sleep(50);
	}
	throw new Error(`timed out waiting for ${description()}`);
}

async function screenLine(e2e: E2E, pattern: RegExp): Promise<number> {
	return until(
		() => `${pattern} on the screen:\n${screen(e2e).join("\n")}`,
		() => {
			const row = screen(e2e).findIndex((line) => pattern.test(line));
			return row === -1 ? undefined : row + 1;
		},
	);
}

function type(e2e: E2E, text: string): void {
	tmux(e2e, "send-keys", "-t", "mi", "-l", text);
	tmux(e2e, "send-keys", "-t", "mi", "Enter");
}

function click(e2e: E2E, row: number, col: number): void {
	tmux(e2e, "send-keys", "-t", "mi", "-l", `\x1b[<0;${col};${row}M\x1b[<0;${col};${row}m`);
}

function userTexts(request: FakeChatRequest): string[] {
	return request.messages
		.filter((message) => message.role === "user")
		.map((message) =>
			typeof message.content === "string"
				? message.content
				: message.content.map((part) => part.text ?? "").join(""),
		);
}

async function request(e2e: E2E, count: number): Promise<FakeChatRequest> {
	return until(
		() => `request ${count}, got ${JSON.stringify(e2e.server.requests.map(userTexts))}`,
		() => e2e.server.requests[count - 1],
	);
}

describe("background commands and callbacks in the terminal", () => {
	it(
		"kills a background command from the list opened by clicking the background count",
		async () => {
			const e2e = setup();
			try {
				e2e.server.queue([
					{ toolCalls: [{ name: "bash", arguments: { command: "sleep 600", background: true } }] },
					{ text: "started" },
				]);
				await launch(e2e);

				type(e2e, "go");
				click(e2e, await screenLine(e2e, /^background 1$/), 3);
				await screenLine(e2e, /^› +\d+s {2}sleep 600$/);
				tmux(e2e, "send-keys", "-t", "mi", "x");

				expect(userTexts(await request(e2e, 3)).at(-1)).toBe(
					"Background command finished: sleep 600\n\nCommand killed by the user",
				);
			} finally {
				teardown(e2e);
			}
		},
		E2E_TIMEOUT_MS,
	);

	it(
		"counts a callback until it is called and wakes the agent with its message",
		async () => {
			const e2e = setup();
			try {
				const callbackFile = join(e2e.dir, "callback");
				e2e.server.queue([
					{
						toolCalls: [
							{
								name: "bash",
								arguments: { command: `${process.execPath} ${CLI} create-callback render > ${callbackFile}` },
							},
						],
					},
					{ text: "waiting" },
				]);
				await launch(e2e);

				type(e2e, "go");
				await screenLine(e2e, /^callback 1$/);
				const callback = Bun.spawn(readFileSync(callbackFile, "utf-8").trim().split(" "), {
					stdin: new TextEncoder().encode("render finished"),
				});
				expect(await callback.exited).toBe(0);

				expect(userTexts(await request(e2e, 3)).at(-1)).toBe("Callback from render\n\nrender finished");
			} finally {
				teardown(e2e);
			}
		},
		E2E_TIMEOUT_MS,
	);

	it(
		"sends a background command killed by closing the session with the first prompt after reopening",
		async () => {
			const e2e = setup();
			try {
				e2e.server.queue([
					{ toolCalls: [{ name: "bash", arguments: { command: "sleep 600", background: true } }] },
					{ text: "started" },
				]);
				await launch(e2e);
				type(e2e, "go");
				await screenLine(e2e, /^background 1$/);

				tmux(e2e, "send-keys", "-t", "mi", "C-d");
				await until(
					() => "mi to exit",
					() =>
						Bun.spawnSync(["tmux", "-S", e2e.socket, "has-session", "-t", "mi"]).exitCode === 0
							? undefined
							: true,
				);
				await launch(e2e, "--continue");
				type(e2e, "next");

				expect(userTexts(await request(e2e, 3)).slice(-2)).toEqual([
					"Background command finished: sleep 600\n\nCommand killed because the session closed",
					"next",
				]);
			} finally {
				teardown(e2e);
			}
		},
		E2E_TIMEOUT_MS,
	);
});
