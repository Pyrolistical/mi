export interface FakeToolCall {
	name: string;
	arguments: Record<string, unknown>;
}

export interface FakeStep {
	text?: string;
	toolCalls?: FakeToolCall[];
	delayMs?: number;
}

export interface FakeChatRequest {
	messages: { role: string; content: string | { type: string; text?: string }[] }[];
}

export interface FakeLlamaServer {
	baseUrl: string;
	queue(steps: FakeStep[]): void;
	requests: FakeChatRequest[];
	stop(): void;
}

function chunk(body: Record<string, unknown>): Uint8Array {
	return new TextEncoder().encode(
		`data: ${JSON.stringify({ id: "fake", object: "chat.completion.chunk", created: 0, model: "fake", ...body })}\n\n`,
	);
}

function delta(content: Record<string, unknown>, finishReason: string | null = null): Uint8Array {
	return chunk({ choices: [{ index: 0, delta: content, finish_reason: finishReason }] });
}

function reply(step: FakeStep, requestIndex: number, signal: AbortSignal): ReadableStream {
	return new ReadableStream({
		async start(controller) {
			controller.enqueue(delta({ role: "assistant", content: "" }));
			if (step.delayMs) {
				await new Promise<void>((resolve) => {
					const timer = setTimeout(resolve, step.delayMs);
					signal.addEventListener("abort", () => {
						clearTimeout(timer);
						resolve();
					});
				});
				if (signal.aborted) return;
			}
			if (step.text) controller.enqueue(delta({ content: step.text }));
			for (const [index, call] of (step.toolCalls ?? []).entries()) {
				const toolCall = {
					index,
					id: `call_${requestIndex}_${index}`,
					type: "function",
					function: { name: call.name, arguments: JSON.stringify(call.arguments) },
				};
				controller.enqueue(delta({ tool_calls: [toolCall] }));
			}
			controller.enqueue(delta({}, step.toolCalls?.length ? "tool_calls" : "stop"));
			controller.enqueue(
				chunk({ choices: [], usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 } }),
			);
			controller.enqueue(new TextEncoder().encode("data: [DONE]\n\n"));
			controller.close();
		},
	});
}

export function startFakeLlamaServer(port = 0): FakeLlamaServer {
	const steps: FakeStep[] = [];
	const requests: FakeChatRequest[] = [];
	const server = Bun.serve({
		port,
		idleTimeout: 0,
		async fetch(request) {
			const url = new URL(request.url);
			if (url.pathname === "/v1/models") {
				return Response.json({ data: [{ id: "fake" }] });
			}
			if (url.pathname === "/props") {
				return Response.json({
					default_generation_settings: { n_ctx: 32768 },
					modalities: { vision: false, video: false },
					chat_template: "",
					chat_template_caps: {},
				});
			}
			if (url.pathname === "/v1/chat/completions") {
				requests.push((await request.json()) as FakeChatRequest);
				const step = steps.shift() ?? { text: "ok" };
				return new Response(reply(step, requests.length, request.signal), {
					headers: { "Content-Type": "text/event-stream" },
				});
			}
			if (url.pathname === "/fake/steps" && request.method === "POST") {
				steps.push(...((await request.json()) as FakeStep[]));
				return Response.json({ queued: steps.length });
			}
			if (url.pathname === "/fake/requests") {
				return Response.json(requests);
			}
			return new Response("not found", { status: 404 });
		},
	});
	return {
		baseUrl: `http://127.0.0.1:${server.port}/v1`,
		queue: (queued) => steps.push(...queued),
		requests,
		stop: () => server.stop(true),
	};
}

if (import.meta.main) {
	const server = startFakeLlamaServer(Number(process.argv[2] ?? 18080));
	console.log(`fake llama-server on ${server.baseUrl}`);
}
