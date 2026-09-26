import type { ProviderEnv, ProviderHeaders } from "../types.ts";

export interface ModelAuth {
	apiKey?: string;
	headers?: ProviderHeaders;
	baseUrl?: string;
}

export interface ApiKeyCredential {
	type: "api_key";
	key?: string;
	env?: ProviderEnv;
}

export type Credential = ApiKeyCredential;

export interface CredentialInfo {
	providerId: string;
	type: Credential["type"];
}

export interface AuthOperationOptions {
	signal?: AbortSignal;
}

export interface CredentialStore {
	read(providerId: string, options?: AuthOperationOptions): Promise<Credential | undefined>;

	list(options?: AuthOperationOptions): Promise<readonly CredentialInfo[]>;

	modify(
		providerId: string,
		fn: (current: Credential | undefined) => Promise<Credential | undefined>,
		options?: AuthOperationOptions,
	): Promise<Credential | undefined>;

	delete(providerId: string, options?: AuthOperationOptions): Promise<void>;
}

export interface AuthContext {
	env(name: string): Promise<string | undefined>;
	fileExists(path: string): Promise<boolean>;
}

export interface AuthResult {
	auth: ModelAuth;
	env?: ProviderEnv;
	source?: string;
}

export interface AuthCheck {
	source?: string;
	type: "api_key";
}

export interface ApiKeyAuth {
	name: string;

	check?(input: {
		ctx: AuthContext;
		credential?: ApiKeyCredential;
		signal: AbortSignal;
	}): Promise<AuthCheck | undefined>;

	resolve(input: {
		ctx: AuthContext;
		credential?: ApiKeyCredential;
		signal: AbortSignal;
	}): Promise<AuthResult | undefined>;
}

export interface ProviderAuth {
	apiKey: ApiKeyAuth;
}
