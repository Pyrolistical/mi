import {
	type AuthResult,
	createProvider,
	type InputModality,
	type Model,
	type Provider,
	type ThinkingLevelMap,
} from "@earendil-works/pi-ai";
import { openAICompletionsApi } from "@earendil-works/pi-ai/api/openai-completions.lazy";
import { type Static, Type } from "typebox";
import { Compile } from "typebox/compile";

export const LLAMA_SERVER_API = "llama-server";

const REQUEST_TIMEOUT_MS = 15_000;

const ModelListSchema = Type.Object({
	data: Type.Array(
		Type.Object({
			id: Type.String({ minLength: 1 }),
			aliases: Type.Optional(Type.Array(Type.String())),
			status: Type.Optional(Type.Object({ value: Type.String() })),
		}),
	),
});
const PropsSchema = Type.Object({
	default_generation_settings: Type.Object({ n_ctx: Type.Integer() }),
	modalities: Type.Object({ vision: Type.Boolean(), video: Type.Boolean() }),
	chat_template: Type.String(),
	chat_template_caps: Type.Object({ supports_reasoning_effort: Type.Optional(Type.Boolean()) }),
});
const modelListValidator = Compile(ModelListSchema);
const propsValidator = Compile(PropsSchema);

type LlamaServerModelInfo = Static<typeof ModelListSchema>["data"][number];
type LlamaServerProps = Static<typeof PropsSchema>;

const SELECTABLE_ROUTER_STATUSES = new Set(["loaded", "sleeping"]);
const REASONING_EFFORT_LEVELS: ThinkingLevelMap = { off: "none" };
const ENABLE_THINKING_LEVELS: ThinkingLevelMap = {
	off: "none",
	minimal: null,
	low: null,
	high: null,
	xhigh: null,
	max: null,
};

function llamaServerRootUrl(baseUrl: string): string {
	const url = new URL(baseUrl);
	if (url.protocol !== "http:" && url.protocol !== "https:") {
		throw new Error(`llama-server baseUrl must use http or https: ${baseUrl}`);
	}
	url.hash = "";
	url.search = "";
	url.pathname = url.pathname.replace(/\/+$/u, "").replace(/\/v1$/u, "");
	return url.toString().replace(/\/$/u, "");
}

async function getJson(url: string, apiKey: string | undefined, signal: AbortSignal): Promise<unknown> {
	const response = await fetch(url, {
		headers: apiKey ? { Authorization: `Bearer ${apiKey}` } : {},
		signal: AbortSignal.any([signal, AbortSignal.timeout(REQUEST_TIMEOUT_MS)]),
	});
	if (!response.ok) throw new Error(`llama-server ${url} returned HTTP ${response.status}: ${await response.text()}`);
	return response.json();
}

function toModel(
	providerId: string,
	inferenceUrl: string,
	info: LlamaServerModelInfo,
	props: LlamaServerProps,
): Model<"openai-completions"> {
	const contextWindow = props.default_generation_settings.n_ctx;
	if (contextWindow <= 0) throw new Error(`llama-server model ${info.id} reported invalid n_ctx ${contextWindow}`);
	const supportsReasoningEffort = props.chat_template_caps.supports_reasoning_effort === true;
	const reasoning = supportsReasoningEffort || props.chat_template.includes("enable_thinking");
	const input: InputModality[] = ["text"];
	if (props.modalities.vision) input.push("image");
	if (props.modalities.video) input.push("video");
	return {
		id: info.id,
		name: info.id,
		api: "openai-completions",
		provider: providerId,
		baseUrl: inferenceUrl,
		reasoning,
		...(reasoning && {
			thinkingLevelMap: supportsReasoningEffort ? REASONING_EFFORT_LEVELS : ENABLE_THINKING_LEVELS,
		}),
		input,
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
		contextWindow,
		maxTokens: contextWindow,
		compat: {
			supportsStore: false,
			supportsDeveloperRole: false,
			supportsReasoningEffort: true,
			supportsUsageInStreaming: true,
			supportsStrictMode: false,
			maxTokensField: "max_tokens",
			thinkingFormat: "openai",
		},
	};
}

async function discoverModels(
	providerId: string,
	rootUrl: string,
	modelIds: readonly string[] | undefined,
	apiKey: string | undefined,
	signal: AbortSignal,
): Promise<Model<"openai-completions">[]> {
	const listed = modelListValidator.Parse(await getJson(`${rootUrl}/v1/models`, apiKey, signal)).data;
	const isRouter = listed.some((info) => info.status !== undefined);
	for (const id of modelIds ?? []) {
		if (!listed.some((info) => info.id === id)) {
			throw new Error(`llama-server at ${rootUrl} does not serve model "${id}"`);
		}
	}
	const selected = listed.filter(
		(info) =>
			(!modelIds || modelIds.includes(info.id)) &&
			(!isRouter || SELECTABLE_ROUTER_STATUSES.has(info.status?.value ?? "")),
	);
	return Promise.all(
		selected.map(async (info) => {
			const query = isRouter ? `?${new URLSearchParams({ model: info.id, autoload: "false" })}` : "";
			const props = propsValidator.Parse(await getJson(`${rootUrl}/props${query}`, apiKey, signal));
			return toModel(providerId, `${rootUrl}/v1`, info, props);
		}),
	);
}

export function createLlamaServerProvider(
	providerId: string,
	baseUrl: string,
	modelIds: readonly string[] | undefined,
): Provider<"openai-completions"> {
	const rootUrl = llamaServerRootUrl(baseUrl);
	return createProvider({
		id: providerId,
		baseUrl: `${rootUrl}/v1`,
		auth: {
			apiKey: {
				name: "llama-server API key",
				check: async ({ credential }) => ({
					type: "api_key",
					source: credential?.key ? "stored credential" : LLAMA_SERVER_API,
				}),
				resolve: async ({ credential }): Promise<AuthResult> =>
					credential?.key
						? { auth: { apiKey: credential.key }, env: credential.env, source: "stored credential" }
						: { auth: { headers: { Authorization: null } }, source: LLAMA_SERVER_API },
			},
		},
		models: [],
		fetchModels: (context) => discoverModels(providerId, rootUrl, modelIds, context.credential?.key, context.signal),
		api: openAICompletionsApi(),
	});
}
