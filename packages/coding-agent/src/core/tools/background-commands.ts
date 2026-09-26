export interface BackgroundCommandResult {
	toolCallId: string;
	command: string;
	text: string;
}

export interface BackgroundJob {
	command: string;
	startedAt: number;
	kill(): void;
	close(): BackgroundCommandResult;
}

export class BackgroundCommands {
	private readonly controller = new AbortController();
	private readonly running = new Map<Promise<BackgroundCommandResult>, BackgroundJob>();

	private readonly deliver: (result: BackgroundCommandResult) => void;
	private readonly changed: (running: number) => void;

	constructor(deliver: (result: BackgroundCommandResult) => void, changed: (running: number) => void) {
		this.deliver = deliver;
		this.changed = changed;
	}

	get signal(): AbortSignal {
		return this.controller.signal;
	}

	get size(): number {
		return this.running.size;
	}

	get jobs(): BackgroundJob[] {
		return [...this.running.values()];
	}

	add(job: BackgroundJob, result: Promise<BackgroundCommandResult>): void {
		this.running.set(result, job);
		this.changed(this.running.size);
		void this.deliverWhenDone(result);
	}

	async next(): Promise<void> {
		await Promise.race(this.running.keys());
	}

	close(): BackgroundCommandResult[] {
		if (this.signal.aborted) return [];
		const results = this.jobs.map((job) => job.close());
		this.controller.abort();
		return results;
	}

	private async deliverWhenDone(result: Promise<BackgroundCommandResult>): Promise<void> {
		const settled = await result;
		this.running.delete(result);
		this.changed(this.running.size);
		if (this.signal.aborted) {
			return;
		}
		this.deliver(settled);
	}
}
