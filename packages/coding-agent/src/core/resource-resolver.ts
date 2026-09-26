import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { basename, dirname, join, relative, resolve, sep } from "node:path";
import { createIgnoreMatcher, type IgnoreMatcher } from "@earendil-works/pi-agent-core";
import { CONFIG_DIR_NAME } from "../config.ts";
import { canonicalizePath, resolvePath } from "../utils/paths.ts";
import type { SettingsManager } from "./settings-manager.ts";

export interface PathMetadata {
	source: string;
	scope: SourceScope;
	baseDir?: string;
}

export interface ResolvedResource {
	path: string;
	enabled: boolean;
	metadata: PathMetadata;
}

export interface ResolvedPaths {
	extensions: ResolvedResource[];
	skills: ResolvedResource[];
	prompts: ResolvedResource[];
}

interface ResourceResolverOptions {
	cwd: string;
	agentDir: string;
	settingsManager: SettingsManager;
}

type SourceScope = "user" | "project" | "temporary";

interface ResourceAccumulator {
	extensions: Map<string, { metadata: PathMetadata; enabled: boolean }>;
	skills: Map<string, { metadata: PathMetadata; enabled: boolean }>;
	prompts: Map<string, { metadata: PathMetadata; enabled: boolean }>;
}

function resourcePrecedenceRank(m: PathMetadata): number {
	const scopeBase = m.scope === "project" ? 0 : 2;
	return scopeBase + (m.source === "local" ? 0 : 1);
}

type ResourceType = "extensions" | "skills" | "prompts";

const RESOURCE_TYPES: ResourceType[] = ["extensions", "skills", "prompts"];

const FILE_PATTERNS: Record<ResourceType, RegExp> = {
	extensions: /\.(ts|js)$/,
	skills: /\.md$/,
	prompts: /\.md$/,
};

const IGNORE_FILE_NAMES = [".gitignore", ".ignore", ".fdignore"];

function toPosixPath(p: string): string {
	return p.split(sep).join("/");
}

function getHomeDir(): string {
	return process.env.HOME || homedir();
}

function prefixIgnorePattern(line: string, prefix: string): string | null {
	const trimmed = line.trim();
	if (!trimmed) return null;
	if (trimmed.startsWith("#") && !trimmed.startsWith("\\#")) return null;

	let pattern = line;
	let negated = false;

	if (pattern.startsWith("!")) {
		negated = true;
		pattern = pattern.slice(1);
	} else if (pattern.startsWith("\\!")) {
		pattern = pattern.slice(1);
	}

	if (pattern.startsWith("/")) {
		pattern = pattern.slice(1);
	}

	const prefixed = prefix ? `${prefix}${pattern}` : pattern;
	return negated ? `!${prefixed}` : prefixed;
}

function addIgnoreRules(ig: IgnoreMatcher, dir: string, rootDir: string): void {
	const relativeDir = relative(rootDir, dir);
	const prefix = relativeDir ? `${toPosixPath(relativeDir)}/` : "";

	for (const filename of IGNORE_FILE_NAMES) {
		const ignorePath = join(dir, filename);
		if (!existsSync(ignorePath)) continue;
		try {
			const content = readFileSync(ignorePath, "utf-8");
			const patterns = content
				.split(/\r?\n/)
				.map((line) => prefixIgnorePattern(line, prefix))
				.filter((line): line is string => Boolean(line));
			if (patterns.length > 0) {
				ig.add(patterns);
			}
		} catch {}
	}
}

function isPattern(s: string): boolean {
	return s.startsWith("!") || s.startsWith("+") || s.startsWith("-") || s.includes("*") || s.includes("?");
}

function splitPatterns(entries: string[]): { plain: string[]; patterns: string[] } {
	const plain: string[] = [];
	const patterns: string[] = [];
	for (const entry of entries) {
		if (isPattern(entry)) {
			patterns.push(entry);
		} else {
			plain.push(entry);
		}
	}
	return { plain, patterns };
}

function collectFiles(
	dir: string,
	filePattern: RegExp,
	skipNodeModules = true,
	ignoreMatcher?: IgnoreMatcher,
	rootDir?: string,
): string[] {
	const files: string[] = [];
	if (!existsSync(dir)) return files;

	const root = rootDir ?? dir;
	const ig = ignoreMatcher ?? createIgnoreMatcher();
	addIgnoreRules(ig, dir, root);

	try {
		const entries = readdirSync(dir, { withFileTypes: true }).sort((a, b) => (a.name < b.name ? -1 : 1));
		for (const entry of entries) {
			if (entry.name.startsWith(".")) continue;
			if (skipNodeModules && entry.name === "node_modules") continue;

			const fullPath = join(dir, entry.name);
			let isDir = entry.isDirectory();
			let isFile = entry.isFile();

			if (entry.isSymbolicLink()) {
				try {
					const stats = statSync(fullPath);
					isDir = stats.isDirectory();
					isFile = stats.isFile();
				} catch {
					continue;
				}
			}

			const relPath = toPosixPath(relative(root, fullPath));
			const ignorePath = isDir ? `${relPath}/` : relPath;
			if (ig.ignores(ignorePath)) continue;

			if (isDir) {
				files.push(...collectFiles(fullPath, filePattern, skipNodeModules, ig, root));
			} else if (isFile && filePattern.test(entry.name)) {
				files.push(fullPath);
			}
		}
	} catch {}

	return files;
}

type SkillDiscoveryMode = "pi" | "agents";

function collectSkillEntries(
	dir: string,
	mode: SkillDiscoveryMode,
	ignoreMatcher?: IgnoreMatcher,
	rootDir?: string,
): string[] {
	const entries: string[] = [];
	if (!existsSync(dir)) return entries;

	const root = rootDir ?? dir;
	const ig = ignoreMatcher ?? createIgnoreMatcher();
	addIgnoreRules(ig, dir, root);

	try {
		const dirEntries = readdirSync(dir, { withFileTypes: true }).sort((a, b) => (a.name < b.name ? -1 : 1));

		for (const entry of dirEntries) {
			if (entry.name !== "SKILL.md") {
				continue;
			}

			const fullPath = join(dir, entry.name);
			let isFile = entry.isFile();
			if (entry.isSymbolicLink()) {
				try {
					isFile = statSync(fullPath).isFile();
				} catch {
					continue;
				}
			}

			const relPath = toPosixPath(relative(root, fullPath));
			if (isFile && !ig.ignores(relPath)) {
				entries.push(fullPath);
				return entries;
			}
		}

		for (const entry of dirEntries) {
			if (entry.name.startsWith(".")) continue;
			if (entry.name === "node_modules") continue;

			const fullPath = join(dir, entry.name);
			let isDir = entry.isDirectory();
			let isFile = entry.isFile();

			if (entry.isSymbolicLink()) {
				try {
					const stats = statSync(fullPath);
					isDir = stats.isDirectory();
					isFile = stats.isFile();
				} catch {
					continue;
				}
			}

			const relPath = toPosixPath(relative(root, fullPath));
			const shouldIncludeMarkdownFile =
				isFile &&
				entry.name.endsWith(".md") &&
				!ig.ignores(relPath) &&
				((mode === "pi" && dir === root) || (mode === "agents" && dir !== root));
			if (shouldIncludeMarkdownFile) {
				entries.push(fullPath);
				continue;
			}

			if (!isDir) continue;
			if (ig.ignores(`${relPath}/`)) continue;

			entries.push(...collectSkillEntries(fullPath, mode, ig, root));
		}
	} catch {}

	return entries;
}

function collectAutoSkillEntries(dir: string, mode: SkillDiscoveryMode): string[] {
	return collectSkillEntries(dir, mode);
}

function findGitRepoRoot(startDir: string): string | null {
	let dir = resolve(startDir);
	while (true) {
		if (existsSync(join(dir, ".git"))) {
			return dir;
		}
		const parent = dirname(dir);
		if (parent === dir) {
			return null;
		}
		dir = parent;
	}
}

function collectAncestorAgentsSkillDirs(startDir: string): string[] {
	const skillDirs: string[] = [];
	const resolvedStartDir = resolve(startDir);
	const gitRepoRoot = findGitRepoRoot(resolvedStartDir);

	let dir = resolvedStartDir;
	while (true) {
		skillDirs.push(join(dir, ".agents", "skills"));
		if (gitRepoRoot && dir === gitRepoRoot) {
			break;
		}
		const parent = dirname(dir);
		if (parent === dir) {
			break;
		}
		dir = parent;
	}

	return skillDirs;
}

function collectAutoPromptEntries(dir: string): string[] {
	const entries: string[] = [];
	if (!existsSync(dir)) return entries;

	const ig = createIgnoreMatcher();
	addIgnoreRules(ig, dir, dir);

	try {
		const dirEntries = readdirSync(dir, { withFileTypes: true }).sort((a, b) => (a.name < b.name ? -1 : 1));
		for (const entry of dirEntries) {
			if (entry.name.startsWith(".")) continue;
			if (entry.name === "node_modules") continue;

			const fullPath = join(dir, entry.name);
			let isFile = entry.isFile();
			if (entry.isSymbolicLink()) {
				try {
					isFile = statSync(fullPath).isFile();
				} catch {
					continue;
				}
			}

			const relPath = toPosixPath(relative(dir, fullPath));
			if (ig.ignores(relPath)) continue;

			if (isFile && entry.name.endsWith(".md")) {
				entries.push(fullPath);
			}
		}
	} catch {}

	return entries;
}

function resolveExtensionEntries(dir: string): string[] | null {
	const indexTs = join(dir, "index.ts");
	const indexJs = join(dir, "index.js");
	if (existsSync(indexTs)) {
		return [indexTs];
	}
	if (existsSync(indexJs)) {
		return [indexJs];
	}

	return null;
}

function collectAutoExtensionEntries(dir: string): string[] {
	const entries: string[] = [];
	if (!existsSync(dir)) return entries;

	const rootEntries = resolveExtensionEntries(dir);
	if (rootEntries) {
		return rootEntries;
	}

	const ig = createIgnoreMatcher();
	addIgnoreRules(ig, dir, dir);

	try {
		const dirEntries = readdirSync(dir, { withFileTypes: true }).sort((a, b) => (a.name < b.name ? -1 : 1));
		for (const entry of dirEntries) {
			if (entry.name.startsWith(".")) continue;
			if (entry.name === "node_modules") continue;

			const fullPath = join(dir, entry.name);
			let isDir = entry.isDirectory();
			let isFile = entry.isFile();

			if (entry.isSymbolicLink()) {
				try {
					const stats = statSync(fullPath);
					isDir = stats.isDirectory();
					isFile = stats.isFile();
				} catch {
					continue;
				}
			}

			const relPath = toPosixPath(relative(dir, fullPath));
			const ignorePath = isDir ? `${relPath}/` : relPath;
			if (ig.ignores(ignorePath)) continue;

			if (isFile && (entry.name.endsWith(".ts") || entry.name.endsWith(".js"))) {
				entries.push(fullPath);
			} else if (isDir) {
				const resolvedEntries = resolveExtensionEntries(fullPath);
				if (resolvedEntries) {
					entries.push(...resolvedEntries);
				}
			}
		}
	} catch {}

	return entries;
}

function collectResourceFiles(dir: string, resourceType: ResourceType): string[] {
	if (resourceType === "skills") {
		return collectSkillEntries(dir, "pi");
	}
	if (resourceType === "extensions") {
		return collectAutoExtensionEntries(dir);
	}
	return collectFiles(dir, FILE_PATTERNS[resourceType]);
}

function matchesAnyPattern(filePath: string, patterns: string[], baseDir: string): boolean {
	const rel = toPosixPath(relative(baseDir, filePath));
	const name = basename(filePath);
	const filePathPosix = toPosixPath(filePath);
	const isSkillFile = name === "SKILL.md";
	const parentDir = isSkillFile ? dirname(filePath) : undefined;
	const parentRel = isSkillFile ? toPosixPath(relative(baseDir, parentDir!)) : undefined;
	const parentName = isSkillFile ? basename(parentDir!) : undefined;
	const parentDirPosix = isSkillFile ? toPosixPath(parentDir!) : undefined;

	return patterns.some((pattern) => {
		const glob = new Bun.Glob(toPosixPath(pattern));
		if (glob.match(rel) || glob.match(name) || glob.match(filePathPosix)) {
			return true;
		}
		if (!isSkillFile) return false;
		return glob.match(parentRel!) || glob.match(parentName!) || glob.match(parentDirPosix!);
	});
}

function normalizeExactPattern(pattern: string): string {
	const normalized = pattern.startsWith("./") || pattern.startsWith(".\\") ? pattern.slice(2) : pattern;
	return toPosixPath(normalized);
}

function matchesAnyExactPattern(filePath: string, patterns: string[], baseDir: string): boolean {
	if (patterns.length === 0) return false;
	const rel = toPosixPath(relative(baseDir, filePath));
	const name = basename(filePath);
	const filePathPosix = toPosixPath(filePath);
	const isSkillFile = name === "SKILL.md";
	const parentDir = isSkillFile ? dirname(filePath) : undefined;
	const parentRel = isSkillFile ? toPosixPath(relative(baseDir, parentDir!)) : undefined;
	const parentDirPosix = isSkillFile ? toPosixPath(parentDir!) : undefined;

	return patterns.some((pattern) => {
		const normalized = normalizeExactPattern(pattern);
		if (normalized === rel || normalized === filePathPosix) {
			return true;
		}
		if (!isSkillFile) return false;
		return normalized === parentRel || normalized === parentDirPosix;
	});
}

function getOverridePatterns(entries: string[]): string[] {
	return entries.filter((pattern) => pattern.startsWith("!") || pattern.startsWith("+") || pattern.startsWith("-"));
}

function isEnabledByOverrides(filePath: string, patterns: string[], baseDir: string): boolean {
	const overrides = getOverridePatterns(patterns);
	const excludes = overrides.filter((pattern) => pattern.startsWith("!")).map((pattern) => pattern.slice(1));
	const forceIncludes = overrides.filter((pattern) => pattern.startsWith("+")).map((pattern) => pattern.slice(1));
	const forceExcludes = overrides.filter((pattern) => pattern.startsWith("-")).map((pattern) => pattern.slice(1));

	let enabled = true;
	if (excludes.length > 0 && matchesAnyPattern(filePath, excludes, baseDir)) {
		enabled = false;
	}
	if (forceIncludes.length > 0 && matchesAnyExactPattern(filePath, forceIncludes, baseDir)) {
		enabled = true;
	}
	if (forceExcludes.length > 0 && matchesAnyExactPattern(filePath, forceExcludes, baseDir)) {
		enabled = false;
	}
	return enabled;
}

function applyPatterns(allPaths: string[], patterns: string[], baseDir: string): Set<string> {
	const includes: string[] = [];
	const excludes: string[] = [];
	const forceIncludes: string[] = [];
	const forceExcludes: string[] = [];

	for (const p of patterns) {
		if (p.startsWith("+")) {
			forceIncludes.push(p.slice(1));
		} else if (p.startsWith("-")) {
			forceExcludes.push(p.slice(1));
		} else if (p.startsWith("!")) {
			excludes.push(p.slice(1));
		} else {
			includes.push(p);
		}
	}

	let result: string[];
	if (includes.length === 0) {
		result = [...allPaths];
	} else {
		result = allPaths.filter((filePath) => matchesAnyPattern(filePath, includes, baseDir));
	}

	if (excludes.length > 0) {
		result = result.filter((filePath) => !matchesAnyPattern(filePath, excludes, baseDir));
	}

	if (forceIncludes.length > 0) {
		for (const filePath of allPaths) {
			if (!result.includes(filePath) && matchesAnyExactPattern(filePath, forceIncludes, baseDir)) {
				result.push(filePath);
			}
		}
	}

	if (forceExcludes.length > 0) {
		result = result.filter((filePath) => !matchesAnyExactPattern(filePath, forceExcludes, baseDir));
	}

	return new Set(result);
}

export class ResourceResolver {
	private cwd: string;
	private agentDir: string;
	private settingsManager: SettingsManager;

	constructor(options: ResourceResolverOptions) {
		this.cwd = resolvePath(options.cwd);
		this.agentDir = resolvePath(options.agentDir);
		this.settingsManager = options.settingsManager;
	}

	async resolve(): Promise<ResolvedPaths> {
		const accumulator = this.createAccumulator();
		const globalSettings = this.settingsManager.getGlobalSettings();
		const projectSettings = this.settingsManager.getProjectSettings();
		const globalBaseDir = this.agentDir;
		const projectBaseDir = join(this.cwd, CONFIG_DIR_NAME);

		for (const resourceType of RESOURCE_TYPES) {
			const target = this.getTargetMap(accumulator, resourceType);
			const globalEntries = (globalSettings[resourceType] ?? []) as string[];
			const projectEntries = (projectSettings[resourceType] ?? []) as string[];
			this.resolveLocalEntries(
				projectEntries,
				resourceType,
				target,
				{
					source: "local",
					scope: "project",
				},
				projectBaseDir,
			);
			this.resolveLocalEntries(
				globalEntries,
				resourceType,
				target,
				{
					source: "local",
					scope: "user",
				},
				globalBaseDir,
			);
		}

		this.addAutoDiscoveredResources(accumulator, globalSettings, projectSettings, globalBaseDir, projectBaseDir);

		return this.toResolvedPaths(accumulator);
	}

	resolveCliExtensions(sources: string[]): ResolvedResource[] {
		const metadata: PathMetadata = { source: "cli", scope: "temporary" };
		return this.collectFilesFromPaths(
			sources.map((source) => this.resolvePathFromBase(source, this.cwd)),
			"extensions",
		).map((path) => ({ path, enabled: true, metadata }));
	}

	private resolvePathFromBase(input: string, baseDir: string): string {
		return resolvePath(input, baseDir, { homeDir: getHomeDir(), trim: true });
	}

	private resolveLocalEntries(
		entries: string[],
		resourceType: ResourceType,
		target: Map<string, { metadata: PathMetadata; enabled: boolean }>,
		metadata: PathMetadata,
		baseDir: string,
	): void {
		if (entries.length === 0) return;

		const { plain, patterns } = splitPatterns(entries);
		const resolvedPlain = plain.map((p) => this.resolvePathFromBase(p, baseDir));
		const allFiles = this.collectFilesFromPaths(resolvedPlain, resourceType);

		const enabledPaths = applyPatterns(allFiles, patterns, baseDir);

		for (const f of allFiles) {
			this.addResource(target, f, metadata, enabledPaths.has(f));
		}
	}

	private addAutoDiscoveredResources(
		accumulator: ResourceAccumulator,
		globalSettings: ReturnType<SettingsManager["getGlobalSettings"]>,
		projectSettings: ReturnType<SettingsManager["getProjectSettings"]>,
		globalBaseDir: string,
		projectBaseDir: string,
	): void {
		const userMetadata: PathMetadata = {
			source: "auto",
			scope: "user",
			baseDir: globalBaseDir,
		};
		const projectMetadata: PathMetadata = {
			source: "auto",
			scope: "project",
			baseDir: projectBaseDir,
		};

		const userOverrides = {
			extensions: (globalSettings.extensions ?? []) as string[],
			skills: (globalSettings.skills ?? []) as string[],
			prompts: (globalSettings.prompts ?? []) as string[],
		};
		const projectOverrides = {
			extensions: (projectSettings.extensions ?? []) as string[],
			skills: (projectSettings.skills ?? []) as string[],
			prompts: (projectSettings.prompts ?? []) as string[],
		};

		const userDirs = {
			extensions: join(globalBaseDir, "extensions"),
			skills: join(globalBaseDir, "skills"),
			prompts: join(globalBaseDir, "prompts"),
		};
		const projectDirs = {
			extensions: join(projectBaseDir, "extensions"),
			skills: join(projectBaseDir, "skills"),
			prompts: join(projectBaseDir, "prompts"),
		};
		const userAgentsSkillsDir = join(getHomeDir(), ".agents", "skills");
		const projectAgentsSkillDirs = collectAncestorAgentsSkillDirs(this.cwd).filter(
			(dir) => resolve(dir) !== resolve(userAgentsSkillsDir),
		);

		const addResources = (
			resourceType: ResourceType,
			paths: string[],
			metadata: PathMetadata,
			overrides: string[],
			baseDir: string,
		) => {
			const target = this.getTargetMap(accumulator, resourceType);
			for (const path of paths) {
				const enabled = isEnabledByOverrides(path, overrides, baseDir);
				this.addResource(target, path, metadata, enabled);
			}
		};

		addResources(
			"extensions",
			collectAutoExtensionEntries(projectDirs.extensions),
			projectMetadata,
			projectOverrides.extensions,
			projectBaseDir,
		);

		addResources(
			"skills",
			collectAutoSkillEntries(projectDirs.skills, "pi"),
			projectMetadata,
			projectOverrides.skills,
			projectBaseDir,
		);

		for (const agentsSkillsDir of projectAgentsSkillDirs) {
			const agentsBaseDir = dirname(agentsSkillsDir);
			const agentsMetadata: PathMetadata = {
				...projectMetadata,
				baseDir: agentsBaseDir,
			};
			addResources(
				"skills",
				collectAutoSkillEntries(agentsSkillsDir, "agents"),
				agentsMetadata,
				projectOverrides.skills,
				agentsBaseDir,
			);
		}

		addResources(
			"prompts",
			collectAutoPromptEntries(projectDirs.prompts),
			projectMetadata,
			projectOverrides.prompts,
			projectBaseDir,
		);

		addResources(
			"extensions",
			collectAutoExtensionEntries(userDirs.extensions),
			userMetadata,
			userOverrides.extensions,
			globalBaseDir,
		);

		addResources(
			"skills",
			collectAutoSkillEntries(userDirs.skills, "pi"),
			userMetadata,
			userOverrides.skills,
			globalBaseDir,
		);

		const userAgentsBaseDir = dirname(userAgentsSkillsDir);
		const userAgentsMetadata: PathMetadata = {
			...userMetadata,
			baseDir: userAgentsBaseDir,
		};
		addResources(
			"skills",
			collectAutoSkillEntries(userAgentsSkillsDir, "agents"),
			userAgentsMetadata,
			userOverrides.skills,
			userAgentsBaseDir,
		);

		addResources(
			"prompts",
			collectAutoPromptEntries(userDirs.prompts),
			userMetadata,
			userOverrides.prompts,
			globalBaseDir,
		);
	}

	private collectFilesFromPaths(paths: string[], resourceType: ResourceType): string[] {
		const files: string[] = [];
		for (const p of paths) {
			if (!existsSync(p)) continue;

			try {
				const stats = statSync(p);
				if (stats.isFile()) {
					files.push(p);
				} else if (stats.isDirectory()) {
					files.push(...collectResourceFiles(p, resourceType));
				}
			} catch {}
		}
		return files;
	}

	private getTargetMap(
		accumulator: ResourceAccumulator,
		resourceType: ResourceType,
	): Map<string, { metadata: PathMetadata; enabled: boolean }> {
		switch (resourceType) {
			case "extensions":
				return accumulator.extensions;
			case "skills":
				return accumulator.skills;
			case "prompts":
				return accumulator.prompts;
			default:
				throw new Error(`Unknown resource type: ${resourceType}`);
		}
	}

	private addResource(
		map: Map<string, { metadata: PathMetadata; enabled: boolean }>,
		path: string,
		metadata: PathMetadata,
		enabled: boolean,
	): void {
		if (!path) return;
		if (!map.has(path)) {
			map.set(path, { metadata, enabled });
		}
	}

	private createAccumulator(): ResourceAccumulator {
		return {
			extensions: new Map(),
			skills: new Map(),
			prompts: new Map(),
		};
	}

	private toResolvedPaths(accumulator: ResourceAccumulator): ResolvedPaths {
		const mapToResolved = (
			entries: Map<string, { metadata: PathMetadata; enabled: boolean }>,
		): ResolvedResource[] => {
			const resolved = Array.from(entries.entries()).map(([path, { metadata, enabled }]) => ({
				path,
				enabled,
				metadata,
			}));
			resolved.sort((a, b) => resourcePrecedenceRank(a.metadata) - resourcePrecedenceRank(b.metadata));

			const seen = new Set<string>();
			return resolved.filter((entry) => {
				const canonicalPath = canonicalizePath(entry.path);
				if (seen.has(canonicalPath)) return false;
				seen.add(canonicalPath);
				return true;
			});
		};

		return {
			extensions: mapToResolved(accumulator.extensions),
			skills: mapToResolved(accumulator.skills),
			prompts: mapToResolved(accumulator.prompts),
		};
	}
}
