import type { AuthResult } from "@earendil-works/pi-ai";
import { APP_NAME } from "../config.ts";
import type { Args } from "./args.ts";

export type AuthCommandKind = "check" | "api_key";

export interface AuthCommand {
	kind: AuthCommandKind;
	args: string[];
	json: boolean;
	credentials: boolean;
}

export class AuthCommandError extends Error {}

const AUTH_COMMAND_USAGE: Record<AuthCommandKind, string> = {
	check: `${APP_NAME} auth check --provider <provider> [--json] [--credentials]`,
	api_key: `${APP_NAME} auth print-api-key --provider <provider> [--model <model>]`,
};

export function getAuthCommandName(kind: AuthCommandKind): string {
	return kind === "check" ? "auth check" : "auth print-api-key";
}

export function getAuthCommandUsage(kind: AuthCommandKind): string {
	return AUTH_COMMAND_USAGE[kind];
}

export function isAuthCommandHelp(args: string[]): boolean {
	return (
		args[0] === "auth" &&
		(args[1] === undefined || args[1] === "help" || args.includes("--help") || args.includes("-h"))
	);
}

export function printAuthCommandHelp(): void {
	console.log(`Usage:
  pi auth print-api-key [--provider <provider>] [--model <model>]
  pi auth check [--provider <provider>] [--model <model>] [--json] [--credentials]

Auth commands require at least one of --provider or --model. --credentials emits the credential, or includes it in JSON output.`);
}

export function parseAuthCommand(args: string[]): AuthCommand | undefined {
	if (args[0] !== "auth") return undefined;

	const kind = args[1] === "check" ? "check" : args[1] === "print-api-key" ? "api_key" : undefined;
	if (!kind) {
		throw new AuthCommandError(
			`Unknown auth command "${args[1] ?? ""}". Use "${APP_NAME} auth print-api-key" or "${APP_NAME} auth check".`,
		);
	}

	const commandArgs: string[] = [];
	let json = false;
	let credentials = false;
	for (let index = 2; index < args.length; index++) {
		const arg = args[index];
		if (arg === "--json" || arg === "--credentials") {
			if (kind !== "check") throw new AuthCommandError(`${arg} is only supported by auth check`);
			if (arg === "--json") json = true;
			else credentials = true;
			continue;
		}
		commandArgs.push(arg);
	}

	return { kind, args: commandArgs, json, credentials };
}

export function validateAuthCommandArgs(args: Args, kind: AuthCommandKind): { provider?: string; model?: string } {
	const provider = args.provider?.trim() || undefined;
	const model = args.model?.trim() || undefined;
	if (args.unknownFlags.size > 0) {
		const option = args.unknownFlags.keys().next().value;
		throw new AuthCommandError(`Unknown option --${option} for "${getAuthCommandName(kind)}".`);
	}
	if (args.apiKey !== undefined || args.messages.length > 0 || args.fileArgs.length > 0) {
		throw new AuthCommandError("Auth commands only accept --provider and --model");
	}
	if (kind === "check") {
		if (!provider && !model) {
			throw new AuthCommandError("Auth checks require --provider <provider> or --model <model>");
		}
		return { provider, model };
	}
	if (!provider && !model) {
		throw new AuthCommandError("Credential printing requires --provider <provider> or --model <model>");
	}
	return { provider, model };
}

export function getAuthCredential(auth: AuthResult | undefined): string | undefined {
	if (auth?.auth.apiKey) return auth.auth.apiKey;
	const authorization = Object.entries(auth?.auth.headers ?? {}).find(
		([name]) => name.toLowerCase() === "authorization",
	)?.[1];
	return typeof authorization === "string" ? /^Bearer\s+(.+)$/iu.exec(authorization)?.[1] : undefined;
}
