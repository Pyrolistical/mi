import * as OsModule from "node:os";
import { afterEach, beforeEach, describe, expect, test, vi } from "bun:test";
import { stubEnv, unstubAllEnvs } from "./test-helpers.ts";
import { copyToClipboard, readClipboardText } from "../src/utils/clipboard.ts";

const mocks = {
	command:
		vi.fn<
			(
				command: string,
				args: readonly string[],
				options?: { input?: string; timeoutMs?: number },
			) => Promise<Buffer | undefined>
		>(),
	platform: vi.fn<() => NodeJS.Platform>(),
};
vi.mock("../src/utils/clipboard-command.ts", () => ({ runClipboardCommand: mocks.command }));
const actualOs = { ...OsModule };
vi.mock("node:os", () => ({
	...actualOs,
	platform: mocks.platform,
}));

let originalWrite: typeof process.stdout.write;
let osc52Writes: string[];
beforeEach(() => {
	vi.resetAllMocks();
	for (const name of [
		"SSH_CONNECTION",
		"SSH_CLIENT",
		"MOSH_CONNECTION",
		"WAYLAND_DISPLAY",
		"DISPLAY",
		"TERMUX_VERSION",
	])
		stubEnv(name, "");
	mocks.platform.mockReturnValue("darwin");
	mocks.command.mockResolvedValue(Buffer.alloc(0));
	osc52Writes = [];
	originalWrite = process.stdout.write.bind(process.stdout);
	process.stdout.write = ((...args: Parameters<typeof process.stdout.write>) => {
		const [chunk] = args;
		if (typeof chunk === "string" && chunk.startsWith("\x1b]52;c;")) {
			osc52Writes.push(chunk);
			return true;
		}
		return originalWrite(...args);
	}) as typeof process.stdout.write;
});
afterEach(() => {
	process.stdout.write = originalWrite;
	unstubAllEnvs();
});

describe("readClipboardText", () => {
	test("returns null outside Linux without running commands", async () => {
		await expect(readClipboardText()).resolves.toBeNull();
		expect(mocks.command).not.toHaveBeenCalled();
	});
	for (const [env, command, args, calls] of [
		["WAYLAND_DISPLAY", "wl-paste", ["--no-newline", "--type", "text"], ["wl-paste"]],
		["DISPLAY", "xclip", ["-selection", "clipboard", "-out"], ["xclip"]],
		["DISPLAY", "xsel", ["--clipboard", "--output"], ["xclip", "xsel"]],
		["TERMUX_VERSION", "termux-clipboard-get", [], ["termux-clipboard-get"]],
	] as const) {
		test.each(["clipboard text", ""])(`${command} result %j stops fallback`, async (text) => {
			mocks.platform.mockReturnValue("linux");
			stubEnv("DISPLAY", ":0");
			stubEnv(env, "1");
			mocks.command.mockImplementation(async (name) => (name === command ? Buffer.from(text) : undefined));
			await expect(readClipboardText()).resolves.toBe(text || null);
			expect<unknown>(mocks.command.mock.calls.map(([name]) => name)).toEqual(calls);
			expect(mocks.command).toHaveBeenLastCalledWith(command, args, { timeoutMs: 5000 });
		});
	}
	test("returns null after all commands fail", async () => {
		mocks.platform.mockReturnValue("linux");
		stubEnv("DISPLAY", ":0");
		stubEnv("WAYLAND_DISPLAY", "wayland-0");
		mocks.command.mockResolvedValue(undefined);
		await expect(readClipboardText()).resolves.toBeNull();
		expect(mocks.command.mock.calls.map(([name]) => name)).toEqual(["wl-paste", "xclip", "xsel"]);
	});
	test("falls back to X11 tools when wl-paste is unavailable", async () => {
		mocks.platform.mockReturnValue("linux");
		stubEnv("WAYLAND_DISPLAY", "wayland-0");
		stubEnv("DISPLAY", ":0");
		mocks.command.mockImplementation(async (name) => (name === "wl-paste" ? undefined : Buffer.from("X11 text")));
		await expect(readClipboardText()).resolves.toBe("X11 text");
	});
});

describe("copyToClipboard", () => {
	test.each(["darwin", "linux"] as const)("%s: writes OSC 52 without running commands", async (platform) => {
		mocks.platform.mockReturnValue(platform);
		stubEnv("DISPLAY", ":0");
		await copyToClipboard("hello");
		expect(osc52Writes).toEqual([`\x1b]52;c;${Buffer.from("hello").toString("base64")}\x07`]);
		expect(mocks.command).not.toHaveBeenCalled();
	});
	test("does not emit oversized OSC 52 payloads", async () => {
		await expect(copyToClipboard("x".repeat(80_000))).rejects.toThrow(
			"Clipboard unavailable: text exceeds the OSC 52 size limit",
		);
		expect(osc52Writes).toHaveLength(0);
	});
});
