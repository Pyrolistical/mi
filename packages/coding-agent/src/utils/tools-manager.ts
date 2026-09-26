import { spawnSync } from "child_process";
import { existsSync } from "fs";
import { join } from "path";
import { getBinDir } from "../config.ts";

const TOOLS_DIR = getBinDir();

interface ToolConfig {
	name: string;
	binaryName: string;
	systemBinaryNames?: string[];
}

const TOOLS: Record<string, ToolConfig> = {
	fd: {
		name: "fd",
		binaryName: "fd",
		systemBinaryNames: ["fd", "fdfind"],
	},
	rg: {
		name: "ripgrep",
		binaryName: "rg",
	},
};

function commandExists(cmd: string): boolean {
	try {
		const result = spawnSync(cmd, ["--version"], { stdio: "pipe" });
		return result.error === undefined || result.error === null;
	} catch {
		return false;
	}
}

export function getToolPath(tool: "fd" | "rg"): string | null {
	const config = TOOLS[tool];
	if (!config) return null;

	const localPath = join(TOOLS_DIR, config.binaryName);
	if (existsSync(localPath)) {
		return localPath;
	}

	const systemBinaryNames = config.systemBinaryNames ?? [config.binaryName];
	for (const systemBinaryName of systemBinaryNames) {
		if (commandExists(systemBinaryName)) {
			return systemBinaryName;
		}
	}

	return null;
}

export interface ToolStatus {
	type: "info" | "warning";
	message: string;
}

export function ensureTool(tool: "fd" | "rg", onStatus?: (status: ToolStatus) => void): string | undefined {
	const existingPath = getToolPath(tool);
	if (existingPath) {
		return existingPath;
	}
	const config = TOOLS[tool];
	onStatus?.({ type: "warning", message: `${config.name} not found. Install it or place it in ${TOOLS_DIR}` });
	return undefined;
}
