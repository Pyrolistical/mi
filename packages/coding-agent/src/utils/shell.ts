import { existsSync } from "node:fs";
import { delimiter } from "node:path";
import { spawnSync } from "child_process";
import { getBinDir } from "../config.ts";

export interface ShellConfig {
	shell: string;
	args: string[];
}

function findExecutableOnPath(executable: string): string | null {
	try {
		const result = spawnSync("which", [executable], { encoding: "utf-8", timeout: 5000 });
		if (result.status === 0 && result.stdout) {
			const firstMatch = result.stdout.trim().split(/\r?\n/)[0];
			if (firstMatch) {
				return firstMatch;
			}
		}
	} catch {}
	return null;
}

export function getShellConfig(customShellPath?: string): ShellConfig {
	if (customShellPath) {
		if (existsSync(customShellPath)) {
			return { shell: customShellPath, args: ["-c"] };
		}
		throw new Error(`Custom shell path not found: ${customShellPath}`);
	}

	if (existsSync("/bin/bash")) {
		return { shell: "/bin/bash", args: ["-c"] };
	}

	const bashOnPath = findExecutableOnPath("bash");
	if (bashOnPath) {
		return { shell: bashOnPath, args: ["-c"] };
	}

	return { shell: "sh", args: ["-c"] };
}

export function getShellEnv(): NodeJS.ProcessEnv {
	const binDir = getBinDir();
	const currentPath = process.env.PATH ?? "";
	const pathEntries = currentPath.split(delimiter).filter(Boolean);
	const hasBinDir = pathEntries.includes(binDir);
	const updatedPath = hasBinDir ? currentPath : [binDir, currentPath].filter(Boolean).join(delimiter);

	return {
		...process.env,
		PATH: updatedPath,
	};
}

export function sanitizeBinaryOutput(str: string): string {
	return Array.from(str)
		.filter((char) => {
			const code = char.codePointAt(0);

			if (code === undefined) return false;

			if (code === 0x09 || code === 0x0a || code === 0x0d) return true;

			if (code <= 0x1f) return false;

			if (code >= 0xfff9 && code <= 0xfffb) return false;

			return true;
		})
		.join("");
}

const trackedDetachedChildPids = new Set<number>();

export function trackDetachedChildPid(pid: number): void {
	trackedDetachedChildPids.add(pid);
}

export function untrackDetachedChildPid(pid: number): void {
	trackedDetachedChildPids.delete(pid);
}

export function killTrackedDetachedChildren(): void {
	for (const pid of trackedDetachedChildPids) {
		killProcessTree(pid);
	}
	trackedDetachedChildPids.clear();
}

export function killProcessTree(pid: number): void {
	try {
		process.kill(-pid, "SIGKILL");
	} catch {
		try {
			process.kill(pid, "SIGKILL");
		} catch {}
	}
}
