import { existsSync, readFileSync } from "fs";
import { homedir } from "os";
import { basename, dirname, join } from "path";
import { fileURLToPath } from "url";
import { normalizePath } from "./utils/paths.ts";
import { stripBom } from "./utils/text.ts";

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

const isBunBinary =
	import.meta.url.includes("$bunfs") || import.meta.url.includes("~BUN") || import.meta.url.includes("%7EBUN");

export function findNodePackageDir(startDir: string): string {
	let dir = startDir;
	while (dir !== dirname(dir)) {
		if (existsSync(join(dir, "package.json"))) {
			const parent = dirname(dir);
			if (basename(dir) === "dist" && existsSync(join(parent, "package.json"))) {
				return parent;
			}
			return dir;
		}
		dir = dirname(dir);
	}
	return startDir;
}

export function getPackageDir(): string {
	const envDir = process.env.MI_PACKAGE_DIR;
	if (envDir) {
		return normalizePath(envDir);
	}

	if (isBunBinary) {
		return dirname(process.execPath);
	}
	return findNodePackageDir(__dirname);
}

function getPackageJsonPath(): string {
	return join(getPackageDir(), "package.json");
}

interface PackageJson {
	name?: string;
	version?: string;
	piConfig?: {
		name?: string;
		configDir?: string;
	};
}

let pkg: PackageJson = {};
try {
	pkg = JSON.parse(stripBom(readFileSync(getPackageJsonPath(), "utf-8"))) as PackageJson;
} catch (e: unknown) {
	const err = e as NodeJS.ErrnoException;
	if (err.code !== "ENOENT") throw e;
}

const piConfigName: string | undefined = pkg.piConfig?.name;
export const APP_NAME: string = piConfigName || "pi";
export const APP_TITLE: string = piConfigName ? APP_NAME : "π";
export const CONFIG_DIR_NAME: string = pkg.piConfig?.configDir || ".pi";
export const VERSION: string = pkg.version || "0.0.0";

export const ENV_AGENT_DIR = `${APP_NAME.toUpperCase()}_CODING_AGENT_DIR`;
export const ENV_SESSION_DIR = `${APP_NAME.toUpperCase()}_CODING_AGENT_SESSION_DIR`;

export function expandTildePath(path: string): string {
	return normalizePath(path);
}

export function getAgentDir(): string {
	const envDir = process.env[ENV_AGENT_DIR];
	if (envDir) {
		return expandTildePath(envDir);
	}
	return join(homedir(), CONFIG_DIR_NAME, "agent");
}

export function getBinDir(): string {
	return join(getAgentDir(), "bin");
}

export function getSessionsDir(): string {
	return join(getAgentDir(), "sessions");
}

export function getDebugLogPath(): string {
	return join(getAgentDir(), `${APP_NAME}-debug.log`);
}
