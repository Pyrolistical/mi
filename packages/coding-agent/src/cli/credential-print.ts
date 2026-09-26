import type { Api, Model } from "@earendil-works/pi-ai";
import { resolveCliModel } from "../core/model-resolver.ts";
import type { ModelRuntime } from "../core/model-runtime.ts";
import type { Args } from "./args.ts";
import { AuthCommandError, getAuthCredential, validateAuthCommandArgs } from "./auth-command.ts";

export async function resolveCredentialForPrint(
	args: Args,
	modelRuntime: ModelRuntime,
	signal?: AbortSignal,
): Promise<string> {
	const { provider: cliProvider, model: cliModel } = validateAuthCommandArgs(args, "api_key");
	const configuredProviders = new Set(
		(await modelRuntime.listCredentials({ signal })).map((credential) => credential.providerId),
	);
	const providers: Array<{ id: string; model?: Model<Api> }> = [];
	if (cliProvider) {
		const provider = modelRuntime.getProvider(cliProvider);
		if (!provider) {
			throw new AuthCommandError(`Unknown provider "${cliProvider}". Use --list-models to see available providers.`);
		}
		if (cliModel) {
			const resolved = resolveCliModel({ cliProvider: provider.id, cliModel, modelRuntime });
			if (resolved.error || !resolved.model) {
				throw new AuthCommandError(resolved.error ?? "Unable to resolve the requested provider/model");
			}
			providers.push({ id: provider.id, model: resolved.model });
		} else {
			providers.push({ id: provider.id });
		}
	} else {
		for (const provider of modelRuntime.getProviders()) {
			if (!configuredProviders.has(provider.id)) continue;
			const resolved = resolveCliModel({ cliProvider: provider.id, cliModel: cliModel!, modelRuntime });
			if (resolved.model && !resolved.error && !resolved.warning?.includes("Using custom model id")) {
				providers.push({ id: provider.id, model: resolved.model });
			}
		}
		if (providers.length === 0) {
			throw new AuthCommandError(`Model "${cliModel}" not found. Use --list-models to see available models.`);
		}
	}

	const credentials: Array<{ providerId: string; value: string }> = [];
	for (const provider of providers) {
		const auth = provider.model
			? await modelRuntime.getAuth(provider.model, { signal })
			: await modelRuntime.getAuth(provider.id, { signal });
		const value = getAuthCredential(auth);
		if (value) credentials.push({ providerId: provider.id, value });
	}

	if (credentials.length === 1) return credentials[0].value;
	if (credentials.length === 0) {
		throw new AuthCommandError("No usable API key is configured");
	}
	throw new AuthCommandError(
		`Multiple configured providers matched (${credentials.map(({ providerId }) => providerId).join(", ")}). Specify --provider.`,
	);
}
