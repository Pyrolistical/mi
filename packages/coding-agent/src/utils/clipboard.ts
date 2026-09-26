import { platform } from "node:os";
import { runClipboardCommand } from "./clipboard-command.ts";

const MAX_OSC52_ENCODED_LENGTH = 100_000;

function isRemoteSession(env: NodeJS.ProcessEnv): boolean {
	return Boolean(env.SSH_CONNECTION || env.SSH_CLIENT || env.MOSH_CONNECTION);
}

function emitOsc52(text: string): boolean {
	const encoded = Buffer.from(text).toString("base64");
	if (encoded.length > MAX_OSC52_ENCODED_LENGTH) {
		return false;
	}
	process.stdout.write(`\x1b]52;c;${encoded}\x07`);
	return true;
}

export async function readClipboardText(): Promise<string | null> {
	if (platform() === "linux") {
		const commands: [string, string[]][] = [];
		if (process.env.TERMUX_VERSION) commands.push(["termux-clipboard-get", []]);
		if (process.env.WAYLAND_DISPLAY) commands.push(["wl-paste", ["--no-newline", "--type", "text"]]);
		if (process.env.DISPLAY) {
			commands.push(["xclip", ["-selection", "clipboard", "-out"]], ["xsel", ["--clipboard", "--output"]]);
		}
		for (const [command, args] of commands) {
			const bytes = await runClipboardCommand(command, args, { timeoutMs: 5000 });
			if (bytes !== undefined) return bytes.toString("utf8") || null;
		}
	}
	return null;
}

export async function copyToClipboard(text: string): Promise<void> {
	const p = platform();
	const env = process.env;
	let copied = false;
	const commands: [string, string[]][] = [];
	if (p === "darwin") commands.push(["pbcopy", []]);
	else {
		if (env.TERMUX_VERSION) commands.push(["termux-clipboard-set", []]);
		if (env.WAYLAND_DISPLAY) commands.push(["wl-copy", []]);
		if (env.DISPLAY) {
			commands.push(["xclip", ["-selection", "clipboard"]], ["xsel", ["--clipboard", "--input"]]);
		}
	}
	for (const [command, args] of commands) {
		if ((await runClipboardCommand(command, args, { input: text, timeoutMs: 5000 })) !== undefined) {
			copied = true;
			break;
		}
	}
	const headless = p === "linux" && !env.DISPLAY && !env.WAYLAND_DISPLAY && !env.TERMUX_VERSION;
	let oversized = false;
	if (isRemoteSession(env) || (!copied && headless)) {
		if (emitOsc52(text)) copied = true;
		else oversized = true;
	}
	if (copied) return;
	if (oversized) throw new Error("Clipboard unavailable: text exceeds the OSC 52 size limit");
	if (p === "linux") {
		if (env.TERMUX_VERSION) {
			throw new Error("Clipboard unavailable: install the Termux:API app and `termux-api` package");
		}
		if (env.WAYLAND_DISPLAY) {
			throw new Error("Clipboard unavailable: install `wl-clipboard` (`wl-copy`) or check Wayland access");
		}
		if (env.DISPLAY) {
			throw new Error("Clipboard unavailable: install `xclip` or `xsel`, or check X11 access");
		}
	}
	throw new Error("Clipboard unavailable");
}
