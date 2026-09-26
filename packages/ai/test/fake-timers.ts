import { vi } from "bun:test";

async function flushMicrotasks(): Promise<void> {
	for (let i = 0; i < 20; i++) await Promise.resolve();
}

export async function advanceTimersByTimeAsync(ms: number): Promise<void> {
	await flushMicrotasks();
	for (let remaining = ms; remaining > 0; remaining -= 10) {
		vi.advanceTimersByTime(Math.min(10, remaining));
		await flushMicrotasks();
	}
}
