import { spawn } from "node:child_process";
import { once } from "node:events";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

const KEPT_ENV = ["PATH", "CI", "GITHUB_ACTIONS"];

const root = await mkdtemp(join(tmpdir(), "mi-test-"));
const home = join(root, "home");
await mkdir(join(home, ".config"), { recursive: true });
await mkdir(join(root, "tmp"));
await mkdir(join(root, "cache"));

const env: Record<string, string> = {
	HOME: home,
	TMPDIR: join(root, "tmp"),
	XDG_CONFIG_HOME: join(home, ".config"),
	XDG_CACHE_HOME: join(root, "cache"),
	LANG: "C",
	LC_ALL: "C",
	TZ: "UTC",
	GIT_CONFIG_NOSYSTEM: "1",
	GIT_CONFIG_GLOBAL: "/dev/null",
	GIT_TERMINAL_PROMPT: "0",
	GIT_ASKPASS: "false",
	GIT_EDITOR: "true",
	GIT_SEQUENCE_EDITOR: "true",
	MI_NO_LOCAL_LLM: "1",
};
for (const name of KEPT_ENV) {
	const value = process.env[name];
	if (value) {
		env[name] = value;
	}
}

const child = spawn(process.execPath, ["test", "--parallel", ...process.argv.slice(2)], { env, stdio: "inherit" });
const [code, signal] = (await once(child, "exit")) as [number | null, NodeJS.Signals | null];
await rm(root, { recursive: true, force: true });
process.exitCode = code ?? (signal ? 1 : 0);
