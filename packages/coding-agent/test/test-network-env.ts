import { stubEnv } from "./test-helpers.ts";

export function allowNetwork(): void {
	stubEnv("MI_OFFLINE", undefined);
}
