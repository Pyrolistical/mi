import { APP_NAME } from "../config.ts";

export function setupCli(): void {
	process.title = APP_NAME;
	process.env.MI_CODING_AGENT = "true";
	process.env.AI_AGENT = APP_NAME;
	process.emitWarning = (() => {}) as typeof process.emitWarning;
}
