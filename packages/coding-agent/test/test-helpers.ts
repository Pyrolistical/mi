const stubbedEnv = new Map<string, string | undefined>();

export function stubEnv(name: string, value: string | undefined): void {
	if (!stubbedEnv.has(name)) stubbedEnv.set(name, process.env[name]);
	if (value === undefined) delete process.env[name];
	else process.env[name] = value;
}

export function unstubAllEnvs(): void {
	for (const [name, value] of stubbedEnv) {
		if (value === undefined) delete process.env[name];
		else process.env[name] = value;
	}
	stubbedEnv.clear();
}

export async function waitFor<T>(callback: () => T | Promise<T>, timeoutMs = 1000): Promise<T> {
	const deadline = performance.now() + timeoutMs;
	while (true) {
		try {
			return await callback();
		} catch (error) {
			if (performance.now() >= deadline) throw error;
			await Bun.sleep(10);
		}
	}
}
