import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { stream as streamOpenAICompletions } from "../src/api/openai-completions.ts";
import { normalizeContext } from "../src/compat.ts";
import type { Model } from "../src/types.ts";

class PayloadCaptured extends Error {
	constructor() {
		super("payload captured");
		this.name = "PayloadCaptured";
	}
}

function stopAfterPayload<TPayload>(capture: (payload: TPayload) => void): (payload: unknown) => never {
	return (payload: unknown): never => {
		capture(payload as TPayload);
		throw new PayloadCaptured();
	};
}

describe("Cache Retention (PI_CACHE_RETENTION)", () => {
	const originalEnv = process.env.PI_CACHE_RETENTION;

	beforeEach(() => {
		delete process.env.PI_CACHE_RETENTION;
	});

	afterEach(() => {
		if (originalEnv !== undefined) {
			process.env.PI_CACHE_RETENTION = originalEnv;
		} else {
			delete process.env.PI_CACHE_RETENTION;
		}
	});

	const context = normalizeContext({
		systemPrompt: "You are a helpful assistant.",
		messages: [{ role: "user", content: "Hello", timestamp: Date.now() }],
	});

	describe("OpenAI Completions Provider", () => {
		function createCompletionsModel(compat?: Model<"openai-completions">["compat"]): Model<"openai-completions"> {
			return {
				id: "test-model",
				name: "Test Model",
				api: "openai-completions",
				provider: "test-openai-completions",
				baseUrl: "https://my-proxy.example.com/v1",
				reasoning: false,
				input: ["text"],
				cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
				contextWindow: 128000,
				maxTokens: 4096,
				compat,
			};
		}

		it("should set prompt_cache_retention for non-api.openai.com baseUrl by default", async () => {
			let capturedPayload: any = null;

			try {
				const s = streamOpenAICompletions(createCompletionsModel(), context, {
					apiKey: "fake-key",
					cacheRetention: "long",
					sessionId: "session-completions",
					onPayload: stopAfterPayload((payload) => {
						capturedPayload = payload;
					}),
				});

				for await (const event of s) {
					if (event.type === "error") break;
				}
			} catch {
			}

			expect(capturedPayload).not.toBeNull();
			expect(capturedPayload.prompt_cache_key).toBe("session-completions");
			expect(capturedPayload.prompt_cache_retention).toBe("24h");
		});

		it("should omit prompt_cache_retention when supportsLongCacheRetention is false", async () => {
			let capturedPayload: any = null;

			try {
				const s = streamOpenAICompletions(createCompletionsModel({ supportsLongCacheRetention: false }), context, {
					apiKey: "fake-key",
					cacheRetention: "long",
					sessionId: "session-completions-false",
					onPayload: stopAfterPayload((payload) => {
						capturedPayload = payload;
					}),
				});

				for await (const event of s) {
					if (event.type === "error") break;
				}
			} catch {
			}

			expect(capturedPayload).not.toBeNull();
			expect(capturedPayload.prompt_cache_key).toBeUndefined();
			expect(capturedPayload.prompt_cache_retention).toBeUndefined();
		});
	});
});
