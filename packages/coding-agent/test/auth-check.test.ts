import { existsSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { InMemoryModelsStore } from "@earendil-works/pi-ai";
import { afterEach, beforeEach, describe, expect, test } from "vitest";
import { parseArgs } from "../src/cli/args.ts";
import { checkProviderAuth } from "../src/cli/auth-check.ts";
import { parseAuthCommand } from "../src/cli/auth-command.ts";
import { AuthStorage, ReadOnlyAuthStorage } from "../src/core/auth-storage.ts";
import { ModelRuntime } from "../src/core/model-runtime.ts";

const tempDir = join(tmpdir(), `pi-test-auth-check-${Date.now()}-${Math.random().toString(36).slice(2)}`);

async function createRuntime(credentials: AuthStorage | ReadOnlyAuthStorage): Promise<ModelRuntime> {
	const modelsPath = join(tempDir, "models.json");
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
		refreshOnCreate: false,
	});
}

describe("auth check command", () => {
	beforeEach(() => {
		if (existsSync(tempDir)) rmSync(tempDir, { recursive: true });
		mkdirSync(tempDir, { recursive: true });
	});

	afterEach(() => {
		if (existsSync(tempDir)) rmSync(tempDir, { recursive: true });
	});

	test("reports a configured provider as ready", async () => {
		const runtime = await createRuntime(AuthStorage.inMemory({ openrouter: { type: "api_key", key: "test-key" } }));

		await expect(checkProviderAuth(parseArgs(["--provider", "openrouter"]), runtime)).resolves.toEqual({
			status: "ready",
			provider: "openrouter",
			authType: "api_key",
		});
	});

	test("resolves the provider from --model", async () => {
		const runtime = await createRuntime(AuthStorage.inMemory({ openrouter: { type: "api_key", key: "test-key" } }));

		await expect(checkProviderAuth(parseArgs(["--model", "openrouter/openai/gpt-5.5"]), runtime)).resolves.toEqual({
			status: "ready",
			provider: "openrouter",
			authType: "api_key",
		});
		await expect(
			checkProviderAuth(parseArgs(["--provider", "openrouter", "--model", "openai/gpt-5.5"]), runtime),
		).resolves.toMatchObject({ status: "ready", provider: "openrouter" });
	});

	test("reports an unknown provider as not ready", async () => {
		const runtime = await createRuntime(AuthStorage.inMemory());

		await expect(checkProviderAuth(parseArgs(["--provider", "not-installed"]), runtime)).resolves.toEqual({
			status: "not_ready",
			provider: "not-installed",
			reason: "provider_not_found",
		});
	});

	test("does not treat an unresolved stored environment reference as configured", async () => {
		const authPath = join(tempDir, "auth.json");
		writeFileSync(
			authPath,
			JSON.stringify({ openrouter: { type: "api_key", key: "$MISSING_AUTH_CHECK_KEY" } }),
			"utf-8",
		);
		const runtime = await createRuntime(new ReadOnlyAuthStorage(authPath));

		await expect(checkProviderAuth(parseArgs(["--provider", "openrouter"]), runtime)).resolves.toEqual({
			status: "not_ready",
			provider: "openrouter",
			reason: "credentials_not_configured",
		});
	});

	test("reports malformed auth state as invalid", async () => {
		const authPath = join(tempDir, "auth.json");
		writeFileSync(authPath, "{invalid-json", "utf-8");
		const runtime = await createRuntime(new ReadOnlyAuthStorage(authPath));

		await expect(checkProviderAuth(parseArgs(["--provider", "openrouter"]), runtime)).resolves.toEqual({
			status: "invalid",
			provider: "openrouter",
			reason: "invalid_state",
		});
	});

	test("does not create an auth file or its parent directory", async () => {
		const authPath = join(tempDir, "agent", "auth.json");
		const runtime = await createRuntime(new ReadOnlyAuthStorage(authPath));

		await expect(checkProviderAuth(parseArgs(["--provider", "openrouter"]), runtime)).resolves.toMatchObject({
			status: "not_ready",
			reason: "credentials_not_configured",
		});
		expect(existsSync(authPath)).toBe(false);
		expect(existsSync(join(tempDir, "agent"))).toBe(false);
	});

	test("accepts optional JSON output and credential output", () => {
		expect(parseAuthCommand(["auth", "check", "--provider", "openrouter"])).toEqual({
			kind: "check",
			args: ["--provider", "openrouter"],
			json: false,
			credentials: false,
		});
		expect(parseAuthCommand(["auth", "check", "--json", "--credentials", "--provider", "openrouter"])).toEqual({
			kind: "check",
			args: ["--provider", "openrouter"],
			json: true,
			credentials: true,
		});
	});
});
