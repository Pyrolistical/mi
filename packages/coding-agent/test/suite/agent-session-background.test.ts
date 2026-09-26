import { fauxAssistantMessage, fauxToolCall, getCurrentSystemPrompt } from "@earendil-works/pi-ai";
import { describe, expect, it } from "bun:test";
import { createHarness, getMessageText } from "./harness.ts";

describe("AgentSession background delivery", () => {
	it("runs before_agent_start for a triggered custom message", async () => {
		const harness = await createHarness({
			extensionFactories: [
				(pi) => {
					pi.on("before_agent_start", (event) => ({ systemPrompt: `${event.systemPrompt}\n\nextension prompt` }));
				},
			],
		});
		try {
			const prompts: string[] = [];
			harness.setResponses([
				(context) => {
					prompts.push(getCurrentSystemPrompt(context.messages));
					return fauxAssistantMessage("done");
				},
			]);

			await harness.session.sendCustomMessage(
				{ customType: "note", content: "wake up", display: true },
				{ triggerTurn: true, deliverAs: "steer" },
			);

			expect(prompts).toHaveLength(1);
			expect(prompts[0]).toEndWith("\n\nextension prompt");
		} finally {
			harness.cleanup();
		}
	});

	it("steers a triggered message sent while another is starting the run", async () => {
		const harness = await createHarness({
			extensionFactories: [
				(pi) => {
					pi.on("before_agent_start", async () => {
						await Promise.resolve();
					});
				},
			],
		});
		try {
			const requests: string[][] = [];
			harness.setResponses([
				(context) => {
					requests.push(context.messages.filter((m) => m.role === "user").map(getMessageText));
					return fauxAssistantMessage("done");
				},
			]);

			await Promise.all([
				harness.session.sendCustomMessage(
					{ customType: "note", content: "first", display: true },
					{ triggerTurn: true, deliverAs: "steer" },
				),
				harness.session.sendCustomMessage(
					{ customType: "note", content: "second", display: true },
					{ triggerTurn: true, deliverAs: "steer" },
				),
			]);

			expect(requests).toEqual([["first", "second"]]);
		} finally {
			harness.cleanup();
		}
	});

	it("steers a user message sent while another is starting the run", async () => {
		const harness = await createHarness({
			extensionFactories: [
				(pi) => {
					pi.on("before_agent_start", async () => {
						await Promise.resolve();
					});
				},
			],
		});
		try {
			const requests: string[][] = [];
			harness.setResponses([
				(context) => {
					requests.push(context.messages.filter((m) => m.role === "user").map(getMessageText));
					return fauxAssistantMessage("done");
				},
			]);

			await Promise.all([
				harness.session.sendUserMessage("first", { deliverAs: "steer" }),
				harness.session.sendUserMessage("second", { deliverAs: "steer" }),
			]);

			expect(requests).toEqual([["first", "second"]]);
		} finally {
			harness.cleanup();
		}
	});

	it("steers a user prompt sent while a triggered message is starting the run", async () => {
		const harness = await createHarness({
			extensionFactories: [
				(pi) => {
					pi.on("before_agent_start", async () => {
						await Promise.resolve();
					});
				},
			],
		});
		try {
			const requests: string[][] = [];
			harness.setResponses([
				(context) => {
					requests.push(context.messages.filter((m) => m.role === "user").map(getMessageText));
					return fauxAssistantMessage("done");
				},
			]);

			await Promise.all([
				harness.session.sendCustomMessage(
					{ customType: "note", content: "notification", display: true },
					{ triggerTurn: true, deliverAs: "steer" },
				),
				harness.session.prompt("user prompt", { streamingBehavior: "steer" }),
			]);

			expect(requests).toEqual([["notification", "user prompt"]]);
		} finally {
			harness.cleanup();
		}
	});

	it("sends a backgrounded bash command's output once it exits", async () => {
		const harness = await createHarness({ initialActiveToolNames: ["bash"] });
		try {
			const requests: string[][] = [];
			harness.setResponses([
				fauxAssistantMessage(fauxToolCall("bash", { command: "echo hi", background: true }, { id: "call-1" }), {
					stopReason: "toolUse",
				}),
				fauxAssistantMessage("waiting"),
				(context) => {
					requests.push(context.messages.filter((m) => m.role === "user").map(getMessageText));
					return fauxAssistantMessage("done");
				},
			]);

			await harness.session.prompt("start");
			await harness.session.waitForBackgroundCommands();

			expect(requests).toEqual([
				["start", "Background command finished: echo hi\n\nhi\n\n\nCommand exited with code 0"],
			]);
		} finally {
			harness.cleanup();
		}
	});

	it("saves a triggered message that arrives during a turn the user interrupts", async () => {
		const harness = await createHarness();
		try {
			const thinking = Promise.withResolvers<void>();
			const release = Promise.withResolvers<void>();
			harness.setResponses([
				async () => {
					thinking.resolve();
					await release.promise;
					return fauxAssistantMessage("thinking");
				},
			]);

			const run = harness.session.prompt("start");
			await thinking.promise;
			await harness.session.sendCustomMessage(
				{ customType: "note", content: "background output", display: true },
				{ triggerTurn: true, deliverAs: "steer" },
			);
			harness.session.clearQueue();
			const aborted = harness.session.abort();
			release.resolve();
			await run;
			await aborted;

			expect(
				harness.sessionManager
					.getEntries()
					.filter((entry) => entry.type === "custom_message")
					.map((entry) => entry.content),
			).toEqual(["background output"]);
		} finally {
			harness.cleanup();
		}
	});

	it("reports the number of running background commands", async () => {
		const harness = await createHarness({ initialActiveToolNames: ["bash"] });
		try {
			const running: number[] = [];
			harness.session.subscribe((event) => {
				if (event.type === "background_commands_update") running.push(event.running);
			});
			harness.setResponses([
				fauxAssistantMessage(fauxToolCall("bash", { command: "echo hi", background: true }, { id: "call-1" }), {
					stopReason: "toolUse",
				}),
				fauxAssistantMessage("waiting"),
				fauxAssistantMessage("done"),
			]);

			await harness.session.prompt("start");
			await harness.session.waitForBackgroundCommands();

			expect(running).toEqual([1, 0]);
		} finally {
			harness.cleanup();
		}
	});

	it("saves the output so far of a running background command when the session closes", async () => {
		const harness = await createHarness({ initialActiveToolNames: ["bash"] });
		try {
			harness.setResponses([
				fauxAssistantMessage(fauxToolCall("bash", { command: "sleep 60", background: true }, { id: "call-1" }), {
					stopReason: "toolUse",
				}),
				fauxAssistantMessage("waiting"),
			]);
			await harness.session.prompt("start");

			harness.session.dispose();

			expect(
				harness.sessionManager
					.getEntries()
					.filter((entry) => entry.type === "custom_message")
					.map((entry) => entry.content),
			).toEqual(["Background command finished: sleep 60\n\nCommand killed because the session closed"]);
		} finally {
			harness.cleanup();
		}
	});

	it("saves a triggered message still queued when the session closes", async () => {
		const harness = await createHarness();
		try {
			const thinking = Promise.withResolvers<void>();
			harness.setResponses([
				async () => {
					thinking.resolve();
					return await new Promise<never>(() => {});
				},
			]);

			void harness.session.prompt("start");
			await thinking.promise;
			await harness.session.sendCustomMessage(
				{ customType: "note", content: "background output", display: true },
				{ triggerTurn: true, deliverAs: "steer" },
			);
			harness.session.dispose();

			expect(
				harness.sessionManager
					.getEntries()
					.filter((entry) => entry.type === "custom_message")
					.map((entry) => entry.content),
			).toEqual(["background output"]);
		} finally {
			harness.cleanup();
		}
	});
});
