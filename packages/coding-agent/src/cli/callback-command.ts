import { APP_NAME } from "../config.ts";
import { SessionManager } from "../core/session-manager.ts";
import { red } from "../utils/colors.ts";

const CREATE_CALLBACK_COMMAND_USAGE = `${APP_NAME} create-callback <origin>`;
const CALLBACK_COMMAND_USAGE = `${APP_NAME} callback --session-dir <dir> <address> < message`;
const CREATE_CALLBACK_INSTRUCTIONS = `Usage: ${CREATE_CALLBACK_COMMAND_USAGE}

Prints a callback command. Whatever is written to its stdin is sent to you as a message that starts a new turn, headed "Callback from <origin>". If the session is closed by then, the message arrives when it is resumed.

- <origin> is any string naming the source of the result. Quote it
- Only run it from your bash tool, it needs the session environment
- Pass it to a program that takes a callback, or pipe into it
- It can be called more than once, each call is a separate message
- After starting the program, end your turn. Don't poll or sleep, the result comes back to you

./render-async --callback "$(${APP_NAME} create-callback "render video")"`;

function fail(message: string): void {
	console.error(red(message));
	process.exitCode = 1;
}

function errorMessage(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}

export function runCreateCallbackCommand(args: string[]): void {
	if (args.length === 0) {
		console.log(CREATE_CALLBACK_INSTRUCTIONS);
		return;
	}
	const [origin] = args;
	if (args.length !== 1 || !origin) return fail(`Usage: ${CREATE_CALLBACK_COMMAND_USAGE}`);
	const {
		MI_SESSION_ID: sessionId,
		MI_SESSION_ID_SIGNATURE: sessionIdSignature,
		MI_SESSION_DIR: sessionDir,
	} = process.env;
	if (!sessionId || !sessionIdSignature || !sessionDir) {
		return fail(
			"Error: MI_SESSION_ID, MI_SESSION_ID_SIGNATURE or MI_SESSION_DIR is not set; this is only intended for the agent to call using its internal bash tool",
		);
	}
	try {
		const command = [process.execPath, Bun.main, "callback", "--session-dir", sessionDir];
		const unsafe = command.find((word) => !/^[A-Za-z0-9/._:+-]+$/.test(word));
		if (unsafe) throw new Error(`${unsafe} would need quoting`);
		const address = SessionManager.createMailboxAddress(sessionId, sessionIdSignature, origin, sessionDir);
		console.log([...command, address].join(" "));
	} catch (error) {
		fail(`Error: cannot create a callback to ${sessionId}: ${errorMessage(error)}`);
	}
}

export async function runCallbackCommand(args: string[]): Promise<void> {
	const [flag, sessionDir, address] = args;
	if (args.length !== 3 || flag !== "--session-dir" || !sessionDir || !address) {
		return fail(`Usage: ${CALLBACK_COMMAND_USAGE}`);
	}
	const body = await Bun.stdin.text();
	try {
		SessionManager.sendMessage(address, body, sessionDir);
	} catch (error) {
		fail(`Error: cannot call back ${address}: ${errorMessage(error)}`);
	}
}
