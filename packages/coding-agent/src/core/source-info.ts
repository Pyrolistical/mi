import type { PathMetadata } from "./resource-resolver.ts";

export type SourceScope = "user" | "project" | "temporary";

export interface SourceInfo {
	path: string;
	source: string;
	scope: SourceScope;
	baseDir?: string;
}

export function createSourceInfo(path: string, metadata: PathMetadata): SourceInfo {
	return {
		path,
		source: metadata.source,
		scope: metadata.scope,
		baseDir: metadata.baseDir,
	};
}

export function createSyntheticSourceInfo(
	path: string,
	options: {
		source: string;
		scope?: SourceScope;
		baseDir?: string;
	},
): SourceInfo {
	return {
		path,
		source: options.source,
		scope: options.scope ?? "temporary",
		baseDir: options.baseDir,
	};
}
