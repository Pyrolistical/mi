export interface IgnoreMatcher {
	add(patterns: readonly string[]): void;
	ignores(path: string): boolean;
}

export function createIgnoreMatcher(): IgnoreMatcher {
	const rules: RegExp[] = [];
	return {
		add(patterns) {
			for (const pattern of patterns) {
				const rule = ignorePatternToRegExp(pattern);
				if (rule) rules.push(rule);
			}
		},
		ignores(path) {
			return rules.some((rule) => rule.test(path));
		},
	};
}

function ignorePatternToRegExp(pattern: string): RegExp | undefined {
	let body = pattern.trimEnd();
	if (!body || body.startsWith("#") || body.startsWith("!")) return undefined;
	if (body.startsWith("\\")) body = body.slice(1);
	const dirOnly = body.endsWith("/");
	if (dirOnly) body = body.slice(0, -1);
	const anchored = body.includes("/");
	if (body.startsWith("/")) body = body.slice(1);
	const glob = body.replace(/\*\*\/|\*\*|\*|\?|[.+^${}()|[\]\\]/g, (token) => {
		if (token === "**/") return "(?:.*/)?";
		if (token === "**") return ".*";
		if (token === "*") return "[^/]*";
		if (token === "?") return "[^/]";
		return `\\${token}`;
	});
	return new RegExp(`${anchored ? "^" : "(?:^|/)"}${glob}${dirOnly ? "/" : "(?:/|$)"}`);
}
