import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { InMemoryModelsStore } from "@earendil-works/pi-ai";
import { describe, expect, test, vi } from "bun:test";
import { parseArgs } from "../src/cli/args.ts";
import { AuthCommandError, isAuthCommandHelp, parseAuthCommand } from "../src/cli/auth-command.ts";
import { resolveCredentialForPrint } from "../src/cli/credential-print.ts";
import { AuthStorage } from "../src/core/auth-storage.ts";
import { ModelRuntime } from "../src/core/model-runtime.ts";
import { main } from "../src/main.ts";

async function createRuntime(credentials: AuthStorage): Promise<ModelRuntime> {
	const modelsPath = join(mkdtempSync(join(tmpdir(), "pi-credential-print-")), "models.json");
	writeFileSync(
		modelsPath,
		JSON.stringify({
			providers: {
				openrouter: {
					baseUrl: "https://openrouter.ai/api/v1",
					api: "openai-completions",
					models: [{ id: "openai/gpt-5.5" }],
				},
			},
		}),
	);
	return ModelRuntime.create({
		credentials,
		modelsPath,
		modelsStore: new InMemoryModelsStore(),
		allowModelNetwork: false,
	});
}

describe("credential print commands", () => {
	test("prints a resolved API key", async () => {
		const runtime = await createRuntime(
			AuthStorage.inMemory({ openrouter: { type: "api_key", key: "test-api-key" } }),
		);
		const args = parseArgs(["--provider", "openrouter"]);

		await expect(resolveCredentialForPrint(args, runtime)).resolves.toBe("test-api-key");
	});

	test("reports unknown auth options like package commands", async () => {
		const originalExitCode = process.exitCode;
		const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
		try {
			process.exitCode = undefined;
			await main(["auth", "check", "--provider", "openrouter", "--credentails"]);
			const stderr = errorSpy.mock.calls.map(([message]) => String(message)).join("\n");
			expect(stderr).toContain('Unknown option --credentails for "auth check".');
			expect(stderr).toContain(
				'Use "mi --help" or "mi auth check --provider <provider> [--json] [--credentials]".',
			);
			expect<unknown>(process.exitCode).toBe(1);
		} finally {
			process.exitCode = originalExitCode ?? 0;
			errorSpy.mockRestore();
		}
	});

	test("parses credential commands and rejects invalid arguments", async () => {
		const runtime = await createRuntime(AuthStorage.inMemory({}));

		expect(parseAuthCommand(["auth", "print-api-key", "--provider", "openrouter"])).toEqual({
			kind: "api_key",
			args: ["--provider", "openrouter"],
			json: false,
			credentials: false,
		});
		expect(parseAuthCommand(["auth", "check", "--provider", "openrouter", "--json", "--credentials"])).toEqual({
			kind: "check",
			args: ["--provider", "openrouter"],
			json: true,
			credentials: true,
		});
		expect(() => parseAuthCommand(["auth", "print-api-key", "--json"])).toThrow("only supported by auth check");
		expect(isAuthCommandHelp(["auth", "--help"])).toBe(true);
		expect(isAuthCommandHelp(["auth", "print-api-key", "--help"])).toBe(true);
		expect(isAuthCommandHelp(["auth", "check", "--help"])).toBe(true);
		expect(() => parseAuthCommand(["auth", "unknown"])).toThrow(AuthCommandError);
		await expect(resolveCredentialForPrint(parseArgs([]), runtime)).rejects.toThrow(
			"requires --provider <provider> or --model <model>",
		);
	});
});
