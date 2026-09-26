import { vi } from "vitest";

export function allowNetwork(): void {
	vi.stubEnv("PI_OFFLINE", undefined);
}
