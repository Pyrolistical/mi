import * as OsModule from "node:os";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { copyToClipboard, readClipboardText } from "../src/utils/clipboard.ts";

const mocks = vi.hoisted(() => ({
	command:
		vi.fn<
			(
				command: string,
				args: readonly string[],
				options?: { input?: string; timeoutMs?: number },
			) => Promise<Buffer | undefined>
		>(),
	platform: vi.fn<() => NodeJS.Platform>(),
}));
vi.mock("../src/utils/clipboard-command.ts", () => ({ runClipboardCommand: mocks.command }));
vi.mock("node:os", async () => ({
	...(await vi.importActual<typeof OsModule>("node:os")),
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
		vi.stubEnv(name, "");
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
	vi.unstubAllEnvs();
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
			vi.stubEnv("DISPLAY", ":0");
			vi.stubEnv(env, "1");
			mocks.command.mockImplementation(async (name) => (name === command ? Buffer.from(text) : undefined));
			await expect(readClipboardText()).resolves.toBe(text || null);
			expect(mocks.command.mock.calls.map(([name]) => name)).toEqual(calls);
			expect(mocks.command).toHaveBeenLastCalledWith(command, args, { timeoutMs: 5000 });
		});
	}
	test("returns null after all commands fail", async () => {
		mocks.platform.mockReturnValue("linux");
		vi.stubEnv("DISPLAY", ":0");
		vi.stubEnv("WAYLAND_DISPLAY", "wayland-0");
		mocks.command.mockResolvedValue(undefined);
		await expect(readClipboardText()).resolves.toBeNull();
		expect(mocks.command.mock.calls.map(([name]) => name)).toEqual(["wl-paste", "xclip", "xsel"]);
	});
	test("falls back to X11 tools when wl-paste is unavailable", async () => {
		mocks.platform.mockReturnValue("linux");
		vi.stubEnv("WAYLAND_DISPLAY", "wayland-0");
		vi.stubEnv("DISPLAY", ":0");
		mocks.command.mockImplementation(async (name) => (name === "wl-paste" ? undefined : Buffer.from("X11 text")));
		await expect(readClipboardText()).resolves.toBe("X11 text");
	});
});

describe("copyToClipboard", () => {
	test("macOS uses pbcopy and skips OSC 52", async () => {
		await copyToClipboard("hello");
		expect(mocks.command).toHaveBeenCalledWith("pbcopy", [], { input: "hello", timeoutMs: 5000 });
		expect(osc52Writes).toHaveLength(0);
	});
	test("Linux uses xclip with a display", async () => {
		mocks.platform.mockReturnValue("linux");
		vi.stubEnv("DISPLAY", ":0");
		await copyToClipboard("hello");
		expect(mocks.command).toHaveBeenCalledWith("xclip", ["-selection", "clipboard"], {
			input: "hello",
			timeoutMs: 5000,
		});
	});
	test("waits for the command write before emitting remote OSC 52", async () => {
		vi.stubEnv("SSH_CONNECTION", "client server");
		let complete = (_value: Buffer | undefined) => {};
		mocks.command.mockReturnValue(
			new Promise<Buffer | undefined>((resolve) => {
				complete = resolve;
			}),
		);
		const copy = copyToClipboard("hello");
		expect(osc52Writes).toHaveLength(0);
		complete(Buffer.alloc(0));
		await copy;
		expect(osc52Writes).toHaveLength(1);
	});
	test("tries xclip and xsel after wl-copy fails", async () => {
		mocks.platform.mockReturnValue("linux");
		vi.stubEnv("WAYLAND_DISPLAY", "wayland-0");
		vi.stubEnv("DISPLAY", ":0");
		mocks.command.mockImplementation(async (name) => (name === "xsel" ? Buffer.alloc(0) : undefined));
		await copyToClipboard("hello");
		expect(mocks.command.mock.calls.map(([name]) => name)).toEqual(["wl-copy", "xclip", "xsel"]);
		expect(osc52Writes).toHaveLength(0);
	});
	test("local Linux failure does not report an unverified OSC 52 write as success", async () => {
		mocks.platform.mockReturnValue("linux");
		vi.stubEnv("DISPLAY", ":0");
		mocks.command.mockResolvedValue(undefined);
		await expect(copyToClipboard("hello")).rejects.toThrow(
			"Clipboard unavailable: install `xclip` or `xsel`, or check X11 access",
		);
		expect(mocks.command.mock.calls.map(([name]) => name)).toEqual(["xclip", "xsel"]);
		expect(osc52Writes).toHaveLength(0);
	});
	test("display-less Linux falls back to OSC 52", async () => {
		mocks.platform.mockReturnValue("linux");
		await copyToClipboard("hello");
		expect(mocks.command).not.toHaveBeenCalled();
		expect(osc52Writes).toHaveLength(1);
	});
	test("reports the Wayland clipboard tool instead of the X11 fallback", async () => {
		mocks.platform.mockReturnValue("linux");
		vi.stubEnv("WAYLAND_DISPLAY", "wayland-0");
		vi.stubEnv("DISPLAY", ":0");
		mocks.command.mockResolvedValue(undefined);
		await expect(copyToClipboard("hello")).rejects.toThrow(
			"Clipboard unavailable: install `wl-clipboard` (`wl-copy`) or check Wayland access",
		);
		expect(mocks.command.mock.calls.map(([name]) => name)).toEqual(["wl-copy", "xclip", "xsel"]);
	});
	test("uses OSC 52 when command writes fail in a remote session", async () => {
		vi.stubEnv("SSH_CONNECTION", "client server");
		mocks.command.mockResolvedValue(undefined);
		await copyToClipboard("hello");
		expect(osc52Writes).toHaveLength(1);
	});
	test("does not emit oversized OSC 52 payloads", async () => {
		vi.stubEnv("SSH_CONNECTION", "client server");
		mocks.command.mockResolvedValue(undefined);
		await expect(copyToClipboard("x".repeat(80_000))).rejects.toThrow(
			"Clipboard unavailable: text exceeds the OSC 52 size limit",
		);
		expect(osc52Writes).toHaveLength(0);
	});
});
