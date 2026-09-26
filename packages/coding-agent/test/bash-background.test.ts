import { describe, expect, it } from "bun:test";
import { type BackgroundCommandResult, BackgroundCommands } from "../src/core/tools/background-commands.ts";
import { type BashOperations, createBashTool } from "../src/core/tools/bash.ts";

function received() {
	const { promise, resolve } = Promise.withResolvers<BackgroundCommandResult>();
	return { background: new BackgroundCommands(resolve, () => {}), delivered: promise };
}

function pendingOperations() {
	const exit = Promise.withResolvers<{ exitCode: number }>();
	const started = Promise.withResolvers<{ onData: (data: Buffer) => void; signal?: AbortSignal }>();
	const operations: BashOperations = {
		exec: async (_command, _cwd, options) => {
			started.resolve(options);
			return await exit.promise;
		},
	};
	return { operations, started: started.promise, exit };
}

describe("bash background", () => {
	it("returns the result of a command that exits before it is backgrounded", async () => {
		const { background } = received();
		const bash = createBashTool(process.cwd(), { background, backgroundAfterMs: 60_000 });

		const result = await bash.execute("call-1", { command: "echo hi" });

		expect(result.content).toEqual([{ type: "text", text: "hi\n" }]);
	});

	it("backgrounds immediately and delivers the output and exit code", async () => {
		const { background, delivered } = received();
		const bash = createBashTool(process.cwd(), { background, backgroundAfterMs: 60_000 });

		const result = await bash.execute("call-1", { command: "echo hi; exit 3", background: true });

		expect(result.content).toEqual([
			{ type: "text", text: "Command is running in the background. Its output will be sent to you when it exits." },
		]);
		expect(await delivered).toEqual({
			toolCallId: "call-1",
			command: "echo hi; exit 3",
			text: "Background command finished: echo hi; exit 3\n\nhi\n\n\nCommand exited with code 3",
		});
	});

	it("backgrounds a command still running after the delay", async () => {
		const { background, delivered } = received();
		const { operations, started, exit } = pendingOperations();
		const bash = createBashTool(process.cwd(), { operations, background, backgroundAfterMs: 1 });

		const result = await bash.execute("call-1", { command: "slow" });
		(await started).onData(Buffer.from("done\n"));
		exit.resolve({ exitCode: 0 });

		expect(result.content).toEqual([
			{ type: "text", text: "Command is running in the background. Its output will be sent to you when it exits." },
		]);
		expect(await delivered).toEqual({
			toolCallId: "call-1",
			command: "slow",
			text: "Background command finished: slow\n\ndone\n\n\nCommand exited with code 0",
		});
	});

	it("keeps a backgrounded command running when its tool call is aborted", async () => {
		const { background } = received();
		const { operations, started } = pendingOperations();
		const bash = createBashTool(process.cwd(), { operations, background, backgroundAfterMs: 1 });
		const toolCall = new AbortController();

		await bash.execute("call-1", { command: "slow", background: true }, toolCall.signal);
		toolCall.abort();

		expect((await started).signal?.aborted).toBe(false);
	});

	it("kills backgrounded commands on close and returns their output so far", async () => {
		const { background } = received();
		const { operations, started } = pendingOperations();
		const bash = createBashTool(process.cwd(), { operations, background, backgroundAfterMs: 1 });

		await bash.execute("call-1", { command: "slow", background: true });
		(await started).onData(Buffer.from("halfway\n"));

		expect(background.close()).toEqual([
			{
				toolCallId: "call-1",
				command: "slow",
				text: "Background command finished: slow\n\nhalfway\n\n\nCommand killed because the session closed",
			},
		]);
		expect((await started).signal?.aborted).toBe(true);
	});

	it("lists a backgrounded command and tells the agent when the user kills it", async () => {
		const { background, delivered } = received();
		const operations: BashOperations = {
			exec: (_command, _cwd, options) =>
				new Promise((_resolve, reject) => {
					options.signal?.addEventListener("abort", () => reject(new Error("aborted")));
				}),
		};
		const bash = createBashTool(process.cwd(), { operations, background, backgroundAfterMs: 1 });

		await bash.execute("call-1", { command: "slow", background: true });
		expect(background.jobs.map((job) => job.command)).toEqual(["slow"]);
		background.jobs[0].kill();

		expect(await delivered).toEqual({
			toolCallId: "call-1",
			command: "slow",
			text: "Background command finished: slow\n\nCommand killed by the user",
		});
	});
});
