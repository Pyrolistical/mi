import { platform } from "node:os";
import { runClipboardCommand } from "./clipboard-command.ts";

const MAX_OSC52_ENCODED_LENGTH = 100_000;

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
	const encoded = Buffer.from(text).toString("base64");
	if (encoded.length > MAX_OSC52_ENCODED_LENGTH) {
		throw new Error("Clipboard unavailable: text exceeds the OSC 52 size limit");
	}
	process.stdout.write(`\x1b]52;c;${encoded}\x07`);
}
