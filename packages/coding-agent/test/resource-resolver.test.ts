import { mkdirSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PassThrough } from "node:stream";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { type ResolvedResource, ResourceResolver } from "../src/core/resource-resolver.ts";
import { SettingsManager } from "../src/core/settings-manager.ts";

function normalizeForMatch(value: string): string {
	return value.replace(/\\/g, "/");
}

function pathEndsWith(actualPath: string, suffix: string): boolean {
	return normalizeForMatch(actualPath).endsWith(normalizeForMatch(suffix));
}

const isEnabled = (r: ResolvedResource, pathMatch: string, matchFn: "endsWith" | "includes" = "endsWith") => {
	const normalizedPath = normalizeForMatch(r.path);
	const normalizedMatch = normalizeForMatch(pathMatch);
	return matchFn === "endsWith"
		? normalizedPath.endsWith(normalizedMatch) && r.enabled
		: normalizedPath.includes(normalizedMatch) && r.enabled;
};

const isDisabled = (r: ResolvedResource, pathMatch: string, matchFn: "endsWith" | "includes" = "endsWith") => {
	const normalizedPath = normalizeForMatch(r.path);
	const normalizedMatch = normalizeForMatch(pathMatch);
	return matchFn === "endsWith"
		? normalizedPath.endsWith(normalizedMatch) && !r.enabled
		: normalizedPath.includes(normalizedMatch) && !r.enabled;
};

describe("ResourceResolver", () => {
	let tempDir: string;
	let agentDir: string;
	let settingsManager: SettingsManager;
	let resourceResolver: ResourceResolver;
	let previousOfflineEnv: string | undefined;

	beforeEach(() => {
		previousOfflineEnv = process.env.PI_OFFLINE;
		delete process.env.PI_OFFLINE;
		tempDir = join(tmpdir(), `pm-test-${Date.now()}-${Math.random().toString(36).slice(2)}`);
		mkdirSync(tempDir, { recursive: true });
		agentDir = join(tempDir, "agent");
		mkdirSync(agentDir, { recursive: true });

		settingsManager = SettingsManager.inMemory();
		resourceResolver = new ResourceResolver({
			cwd: tempDir,
			agentDir,
			settingsManager,
		});
	});

	afterEach(() => {
		if (previousOfflineEnv === undefined) {
			delete process.env.PI_OFFLINE;
		} else {
			process.env.PI_OFFLINE = previousOfflineEnv;
		}
		vi.restoreAllMocks();
		vi.unstubAllGlobals();
		rmSync(tempDir, { recursive: true, force: true });
	});

	describe("resolve", () => {
		it("should return no package-sourced paths when no sources configured", async () => {
			const result = await resourceResolver.resolve();
			expect(result.extensions).toEqual([]);
			expect(result.prompts).toEqual([]);
			expect(result.skills.every((r) => r.metadata.source === "auto")).toBe(true);
		});

		it("should resolve local extension paths from settings", async () => {
			const extDir = join(agentDir, "extensions");
			mkdirSync(extDir, { recursive: true });
			const extPath = join(extDir, "my-extension.ts");
			writeFileSync(extPath, "export default function() {}");
			settingsManager.setExtensionPaths(["extensions/my-extension.ts"]);

			const result = await resourceResolver.resolve();
			expect(result.extensions.some((r) => r.path === extPath && r.enabled)).toBe(true);
		});

		it("should resolve skill paths from settings", async () => {
			const skillDir = join(agentDir, "skills", "my-skill");
			mkdirSync(skillDir, { recursive: true });
			const skillFile = join(skillDir, "SKILL.md");
			writeFileSync(
				skillFile,
				`---
name: test-skill
description: A test skill
---
Content`,
			);

			settingsManager.setSkillPaths(["skills"]);

			const result = await resourceResolver.resolve();
			expect(result.skills.some((r) => r.path === skillFile && r.enabled)).toBe(true);
		});

		it("should auto-discover root markdown skills from .pi skill dirs", async () => {
			const skillFile = join(agentDir, "skills", "single-file.md");
			mkdirSync(join(agentDir, "skills"), { recursive: true });
			writeFileSync(
				skillFile,
				`---
name: single-file
description: A root markdown skill
---
Content`,
			);

			const result = await resourceResolver.resolve();
			expect(result.skills.some((r) => r.path === skillFile && r.enabled)).toBe(true);
		});

		it("should resolve project paths relative to .pi", async () => {
			const extDir = join(tempDir, ".pi", "extensions");
			mkdirSync(extDir, { recursive: true });
			const extPath = join(extDir, "project-ext.ts");
			writeFileSync(extPath, "export default function() {}");

			settingsManager.setProjectExtensionPaths(["extensions/project-ext.ts"]);

			const result = await resourceResolver.resolve();
			expect(result.extensions.some((r) => r.path === extPath && r.enabled)).toBe(true);
		});

		it("should auto-discover user prompts with overrides", async () => {
			const promptsDir = join(agentDir, "prompts");
			mkdirSync(promptsDir, { recursive: true });
			const promptPath = join(promptsDir, "auto.md");
			writeFileSync(promptPath, "Auto prompt");

			settingsManager.setPromptTemplatePaths(["!prompts/auto.md"]);

			const result = await resourceResolver.resolve();
			expect(result.prompts.some((r) => r.path === promptPath && !r.enabled)).toBe(true);
		});

		it("should resolve symlinked user and project resources once", async () => {
			const previousHome = process.env.HOME;
			process.env.HOME = tempDir;

			try {
				const sharedDir = join(tempDir, "shared-resources");
				const sharedExtensionsDir = join(sharedDir, "extensions");
				const sharedSkillsDir = join(sharedDir, "skills");
				const sharedPromptsDir = join(sharedDir, "prompts");
				mkdirSync(sharedExtensionsDir, { recursive: true });
				mkdirSync(sharedSkillsDir, { recursive: true });
				mkdirSync(sharedPromptsDir, { recursive: true });

				writeFileSync(join(sharedExtensionsDir, "shared.ts"), "export default function() {}");
				mkdirSync(join(sharedSkillsDir, "shared-skill"), { recursive: true });
				writeFileSync(
					join(sharedSkillsDir, "shared-skill", "SKILL.md"),
					`---
name: shared-skill
description: Shared skill
---
Content`,
				);
				writeFileSync(join(sharedPromptsDir, "shared.md"), "Shared prompt");

				mkdirSync(join(agentDir), { recursive: true });
				mkdirSync(join(tempDir, ".pi"), { recursive: true });
				symlinkSync(sharedExtensionsDir, join(agentDir, "extensions"), "dir");
				symlinkSync(sharedSkillsDir, join(agentDir, "skills"), "dir");
				symlinkSync(sharedPromptsDir, join(agentDir, "prompts"), "dir");
				symlinkSync(sharedExtensionsDir, join(tempDir, ".pi", "extensions"), "dir");
				symlinkSync(sharedSkillsDir, join(tempDir, ".pi", "skills"), "dir");
				symlinkSync(sharedPromptsDir, join(tempDir, ".pi", "prompts"), "dir");

				const result = await resourceResolver.resolve();

				expect({
					extensions: result.extensions.length,
					skills: result.skills.length,
					prompts: result.prompts.length,
				}).toEqual({
					extensions: 1,
					skills: 1,
					prompts: 1,
				});

				expect(result.extensions[0].metadata.scope).toBe("project");
				expect(result.skills[0].metadata.scope).toBe("project");
				expect(result.prompts[0].metadata.scope).toBe("project");
			} finally {
				if (previousHome === undefined) {
					delete process.env.HOME;
				} else {
					process.env.HOME = previousHome;
				}
			}
		});

		it("should auto-discover project prompts with overrides", async () => {
			const promptsDir = join(tempDir, ".pi", "prompts");
			mkdirSync(promptsDir, { recursive: true });
			const promptPath = join(promptsDir, "is.md");
			writeFileSync(promptPath, "Is prompt");

			settingsManager.setProjectPromptTemplatePaths(["!prompts/is.md"]);

			const result = await resourceResolver.resolve();
			expect(result.prompts.some((r) => r.path === promptPath && !r.enabled)).toBe(true);
		});
	});

	describe("auto-discovered skill metadata", () => {
		it("should use the agent dir as baseDir for user .pi/agent skills", async () => {
			const skillPath = join(agentDir, "skills", "user-pi", "SKILL.md");
			mkdirSync(join(agentDir, "skills", "user-pi"), { recursive: true });
			writeFileSync(skillPath, "---\nname: user-pi\ndescription: user pi\n---\n");

			const result = await resourceResolver.resolve();
			const skill = result.skills.find((r) => r.path === skillPath);

			expect(skill?.metadata.source).toBe("auto");
			expect(skill?.metadata.scope).toBe("user");
			expect(skill?.metadata.baseDir).toBe(agentDir);
		});

		it("should use the project .pi dir as baseDir for project .pi skills", async () => {
			const projectBaseDir = join(tempDir, ".pi");
			const skillPath = join(projectBaseDir, "skills", "project-pi", "SKILL.md");
			mkdirSync(join(projectBaseDir, "skills", "project-pi"), { recursive: true });
			writeFileSync(skillPath, "---\nname: project-pi\ndescription: project pi\n---\n");

			const result = await resourceResolver.resolve();
			const skill = result.skills.find((r) => r.path === skillPath);

			expect(skill?.metadata.source).toBe("auto");
			expect(skill?.metadata.scope).toBe("project");
			expect(skill?.metadata.baseDir).toBe(projectBaseDir);
		});

		it("should use ~/.agents as baseDir for user .agents skills", async () => {
			const previousHome = process.env.HOME;
			process.env.HOME = tempDir;

			try {
				const agentsBaseDir = join(tempDir, ".agents");
				const skillPath = join(agentsBaseDir, "skills", "user-agents", "SKILL.md");
				mkdirSync(join(agentsBaseDir, "skills", "user-agents"), { recursive: true });
				writeFileSync(skillPath, "---\nname: user-agents\ndescription: user agents\n---\n");

				const result = await resourceResolver.resolve();
				const skill = result.skills.find((r) => r.path === skillPath);

				expect(skill?.metadata.source).toBe("auto");
				expect(skill?.metadata.scope).toBe("user");
				expect(skill?.metadata.baseDir).toBe(agentsBaseDir);
			} finally {
				if (previousHome === undefined) {
					delete process.env.HOME;
				} else {
					process.env.HOME = previousHome;
				}
			}
		});

		it("should use each project .agents dir as baseDir for project .agents skills", async () => {
			const repoRoot = join(tempDir, "repo");
			const nestedCwd = join(repoRoot, "packages", "feature");
			mkdirSync(nestedCwd, { recursive: true });
			mkdirSync(join(repoRoot, ".git"), { recursive: true });

			const repoAgentsBaseDir = join(repoRoot, ".agents");
			const repoSkill = join(repoAgentsBaseDir, "skills", "repo", "SKILL.md");
			mkdirSync(join(repoAgentsBaseDir, "skills", "repo"), { recursive: true });
			writeFileSync(repoSkill, "---\nname: repo\ndescription: repo\n---\n");

			const packageAgentsBaseDir = join(repoRoot, "packages", ".agents");
			const packageSkill = join(packageAgentsBaseDir, "skills", "package", "SKILL.md");
			mkdirSync(join(packageAgentsBaseDir, "skills", "package"), { recursive: true });
			writeFileSync(packageSkill, "---\nname: package\ndescription: package\n---\n");

			const pm = new ResourceResolver({
				cwd: nestedCwd,
				agentDir,
				settingsManager,
			});

			const result = await pm.resolve();
			const resolvedRepoSkill = result.skills.find((r) => r.path === repoSkill);
			const resolvedPackageSkill = result.skills.find((r) => r.path === packageSkill);

			expect(resolvedRepoSkill?.metadata.source).toBe("auto");
			expect(resolvedRepoSkill?.metadata.scope).toBe("project");
			expect(resolvedRepoSkill?.metadata.baseDir).toBe(repoAgentsBaseDir);
			expect(resolvedPackageSkill?.metadata.source).toBe("auto");
			expect(resolvedPackageSkill?.metadata.scope).toBe("project");
			expect(resolvedPackageSkill?.metadata.baseDir).toBe(packageAgentsBaseDir);
		});
	});

	describe(".agents/skills auto-discovery", () => {
		it("should scan .agents/skills from cwd up to git repo root", async () => {
			const repoRoot = join(tempDir, "repo");
			const nestedCwd = join(repoRoot, "packages", "feature");
			mkdirSync(nestedCwd, { recursive: true });
			mkdirSync(join(repoRoot, ".git"), { recursive: true });

			const aboveRepoSkill = join(tempDir, ".agents", "skills", "above-repo", "SKILL.md");
			mkdirSync(join(tempDir, ".agents", "skills", "above-repo"), { recursive: true });
			writeFileSync(aboveRepoSkill, "---\nname: above-repo\ndescription: above\n---\n");

			const repoRootSkill = join(repoRoot, ".agents", "skills", "repo-root", "SKILL.md");
			mkdirSync(join(repoRoot, ".agents", "skills", "repo-root"), { recursive: true });
			writeFileSync(repoRootSkill, "---\nname: repo-root\ndescription: repo\n---\n");

			const nestedSkill = join(repoRoot, "packages", ".agents", "skills", "nested", "SKILL.md");
			mkdirSync(join(repoRoot, "packages", ".agents", "skills", "nested"), { recursive: true });
			writeFileSync(nestedSkill, "---\nname: nested\ndescription: nested\n---\n");

			const pm = new ResourceResolver({
				cwd: nestedCwd,
				agentDir,
				settingsManager,
			});

			const result = await pm.resolve();
			expect(result.skills.some((r) => r.path === repoRootSkill && r.enabled)).toBe(true);
			expect(result.skills.some((r) => r.path === nestedSkill && r.enabled)).toBe(true);
			expect(result.skills.some((r) => r.path === aboveRepoSkill)).toBe(false);
		});

		it("should scan .agents/skills up to filesystem root when not in a git repo", async () => {
			const nonRepoRoot = join(tempDir, "non-repo");
			const nestedCwd = join(nonRepoRoot, "a", "b");
			mkdirSync(nestedCwd, { recursive: true });

			const rootSkill = join(nonRepoRoot, ".agents", "skills", "root", "SKILL.md");
			mkdirSync(join(nonRepoRoot, ".agents", "skills", "root"), { recursive: true });
			writeFileSync(rootSkill, "---\nname: root\ndescription: root\n---\n");

			const middleSkill = join(nonRepoRoot, "a", ".agents", "skills", "middle", "SKILL.md");
			mkdirSync(join(nonRepoRoot, "a", ".agents", "skills", "middle"), { recursive: true });
			writeFileSync(middleSkill, "---\nname: middle\ndescription: middle\n---\n");

			const pm = new ResourceResolver({
				cwd: nestedCwd,
				agentDir,
				settingsManager,
			});

			const result = await pm.resolve();
			expect(result.skills.some((r) => r.path === rootSkill && r.enabled)).toBe(true);
			expect(result.skills.some((r) => r.path === middleSkill && r.enabled)).toBe(true);
		});

		it("should ignore root markdown files in .agents/skills but discover nested markdown skills", async () => {
			const agentsSkillsDir = join(tempDir, ".agents", "skills");
			mkdirSync(join(agentsSkillsDir, "nested-skill"), { recursive: true });
			mkdirSync(join(agentsSkillsDir, "third-party"), { recursive: true });
			mkdirSync(join(agentsSkillsDir, "third-party", "vendor", "pack"), { recursive: true });
			const rootSkill = join(agentsSkillsDir, "root-file.md");
			const nestedSkill = join(agentsSkillsDir, "nested-skill", "SKILL.md");
			const nestedMarkdownSkill = join(agentsSkillsDir, "third-party", "child-skill.md");
			const deeplyNestedMarkdownSkill = join(agentsSkillsDir, "third-party", "vendor", "pack", "deep-skill.md");
			writeFileSync(rootSkill, "---\nname: root-file\ndescription: Root markdown file\n---\n");
			writeFileSync(nestedSkill, "---\nname: nested-skill\ndescription: Nested skill\n---\n");
			writeFileSync(nestedMarkdownSkill, "---\nname: child-skill\ndescription: Nested markdown skill\n---\n");
			writeFileSync(deeplyNestedMarkdownSkill, "---\nname: deep-skill\ndescription: Deep markdown skill\n---\n");

			const pm = new ResourceResolver({
				cwd: join(tempDir, "work"),
				agentDir,
				settingsManager,
			});
			mkdirSync(join(tempDir, "work"), { recursive: true });

			const result = await pm.resolve();
			expect(result.skills.some((r) => r.path === rootSkill)).toBe(false);
			expect(result.skills.some((r) => r.path === nestedSkill && r.enabled)).toBe(true);
			expect(result.skills.some((r) => r.path === nestedMarkdownSkill && r.enabled)).toBe(true);
			expect(result.skills.some((r) => r.path === deeplyNestedMarkdownSkill && r.enabled)).toBe(true);
		});

		it("should keep ~/.agents/skills user-scoped when cwd is under home in a non-git directory", async () => {
			const previousHome = process.env.HOME;
			process.env.HOME = tempDir;

			try {
				const cwd = join(tempDir, "scratch", "nested");
				const localAgentDir = join(tempDir, ".pi", "agent");
				const localSettingsManager = SettingsManager.inMemory();
				mkdirSync(cwd, { recursive: true });
				mkdirSync(localAgentDir, { recursive: true });

				const homeSkill = join(tempDir, ".agents", "skills", "home-skill", "SKILL.md");
				mkdirSync(join(tempDir, ".agents", "skills", "home-skill"), { recursive: true });
				writeFileSync(homeSkill, "---\nname: home-skill\ndescription: home\n---\n");

				const pm = new ResourceResolver({
					cwd,
					agentDir: localAgentDir,
					settingsManager: localSettingsManager,
				});

				const result = await pm.resolve();
				const matchingSkills = result.skills.filter((r) => r.path === homeSkill);
				expect(matchingSkills).toHaveLength(1);
				expect(matchingSkills[0]?.enabled).toBe(true);
				expect(matchingSkills[0]?.metadata.scope).toBe("user");
				expect(matchingSkills[0]?.metadata.source).toBe("auto");
			} finally {
				if (previousHome === undefined) {
					delete process.env.HOME;
				} else {
					process.env.HOME = previousHome;
				}
			}
		});

		it("should dedupe user skill entries when ~/.pi/agent/skills is a symlink to ~/.agents/skills", async () => {
			const previousHome = process.env.HOME;
			process.env.HOME = tempDir;

			try {
				const agentSkillsDir = join(agentDir, "skills");
				const agentsSkillsDir = join(tempDir, ".agents", "skills");
				mkdirSync(agentsSkillsDir, { recursive: true });
				symlinkSync(agentsSkillsDir, agentSkillsDir, "dir");

				const skillPath = join(agentsSkillsDir, "foo", "SKILL.md");
				mkdirSync(join(agentsSkillsDir, "foo"), { recursive: true });
				writeFileSync(skillPath, "---\nname: foo\ndescription: foo\n---\n");

				const result = await resourceResolver.resolve();
				const fooSkills = result.skills.filter((r) => pathEndsWith(r.path, "foo/SKILL.md"));

				expect(fooSkills).toHaveLength(1);
			} finally {
				if (previousHome === undefined) {
					delete process.env.HOME;
				} else {
					process.env.HOME = previousHome;
				}
			}
		});
	});

	describe("ignore files", () => {
		it("should respect .gitignore in skill directories", async () => {
			const skillsDir = join(agentDir, "skills");
			mkdirSync(skillsDir, { recursive: true });
			writeFileSync(join(skillsDir, ".gitignore"), "venv\n__pycache__\n");

			const goodSkillDir = join(skillsDir, "good-skill");
			mkdirSync(goodSkillDir, { recursive: true });
			writeFileSync(join(goodSkillDir, "SKILL.md"), "---\nname: good-skill\ndescription: Good\n---\nContent");

			const ignoredSkillDir = join(skillsDir, "venv", "bad-skill");
			mkdirSync(ignoredSkillDir, { recursive: true });
			writeFileSync(join(ignoredSkillDir, "SKILL.md"), "---\nname: bad-skill\ndescription: Bad\n---\nContent");

			settingsManager.setSkillPaths(["skills"]);

			const result = await resourceResolver.resolve();
			expect(result.skills.some((r) => r.path.includes("good-skill") && r.enabled)).toBe(true);
			expect(result.skills.some((r) => r.path.includes("venv") && r.enabled)).toBe(false);
		});

		it("should not apply parent .gitignore to .pi auto-discovery", async () => {
			writeFileSync(join(tempDir, ".gitignore"), ".pi\n");

			const skillDir = join(tempDir, ".pi", "skills", "auto-skill");
			mkdirSync(skillDir, { recursive: true });
			const skillPath = join(skillDir, "SKILL.md");
			writeFileSync(skillPath, "---\nname: auto-skill\ndescription: Auto\n---\nContent");

			const result = await resourceResolver.resolve();
			expect(result.skills.some((r) => r.path === skillPath && r.enabled)).toBe(true);
		});
	});

	describe("resolveCliExtensions", () => {
		it("should resolve local paths", async () => {
			const extPath = join(tempDir, "ext.ts");
			writeFileSync(extPath, "export default function() {}");

			const result = resourceResolver.resolveCliExtensions([extPath]);
			expect(result.some((r) => r.path === extPath && r.enabled)).toBe(true);
		});
	});

	describe("pattern filtering in top-level arrays", () => {
		it("should exclude extensions with ! pattern", async () => {
			const extDir = join(agentDir, "extensions");
			mkdirSync(extDir, { recursive: true });
			writeFileSync(join(extDir, "keep.ts"), "export default function() {}");
			writeFileSync(join(extDir, "remove.ts"), "export default function() {}");

			settingsManager.setExtensionPaths(["extensions", "!**/remove.ts"]);

			const result = await resourceResolver.resolve();
			expect(result.extensions.some((r) => isEnabled(r, "keep.ts"))).toBe(true);
			expect(result.extensions.some((r) => isDisabled(r, "remove.ts"))).toBe(true);
		});

		it("should filter prompts with exclusion pattern", async () => {
			const promptsDir = join(agentDir, "prompts");
			mkdirSync(promptsDir, { recursive: true });
			writeFileSync(join(promptsDir, "review.md"), "Review code");
			writeFileSync(join(promptsDir, "explain.md"), "Explain code");

			settingsManager.setPromptTemplatePaths(["prompts", "!explain.md"]);

			const result = await resourceResolver.resolve();
			expect(result.prompts.some((r) => isEnabled(r, "review.md"))).toBe(true);
			expect(result.prompts.some((r) => isDisabled(r, "explain.md"))).toBe(true);
		});

		it("should filter skills with exclusion pattern", async () => {
			const skillsDir = join(agentDir, "skills");
			mkdirSync(join(skillsDir, "good-skill"), { recursive: true });
			mkdirSync(join(skillsDir, "bad-skill"), { recursive: true });
			writeFileSync(
				join(skillsDir, "good-skill", "SKILL.md"),
				"---\nname: good-skill\ndescription: Good\n---\nContent",
			);
			writeFileSync(
				join(skillsDir, "bad-skill", "SKILL.md"),
				"---\nname: bad-skill\ndescription: Bad\n---\nContent",
			);

			settingsManager.setSkillPaths(["skills", "!**/bad-skill"]);

			const result = await resourceResolver.resolve();
			expect(result.skills.some((r) => isEnabled(r, "good-skill", "includes"))).toBe(true);
			expect(result.skills.some((r) => isDisabled(r, "bad-skill", "includes"))).toBe(true);
		});

		it("should work without patterns (backward compatible)", async () => {
			const extDir = join(agentDir, "extensions");
			mkdirSync(extDir, { recursive: true });
			const extPath = join(extDir, "my-ext.ts");
			writeFileSync(extPath, "export default function() {}");

			settingsManager.setExtensionPaths(["extensions/my-ext.ts"]);

			const result = await resourceResolver.resolve();
			expect(result.extensions.some((r) => r.path === extPath && r.enabled)).toBe(true);
		});
	});

	describe("force-include patterns", () => {
		it("should force-include extensions with + pattern after exclusion", async () => {
			const extDir = join(agentDir, "extensions");
			mkdirSync(extDir, { recursive: true });
			writeFileSync(join(extDir, "keep.ts"), "export default function() {}");
			writeFileSync(join(extDir, "excluded.ts"), "export default function() {}");
			writeFileSync(join(extDir, "force-back.ts"), "export default function() {}");

			settingsManager.setExtensionPaths(["extensions", "!extensions/*.ts", "+extensions/force-back.ts"]);

			const result = await resourceResolver.resolve();
			expect(result.extensions.some((r) => isDisabled(r, "keep.ts"))).toBe(true);
			expect(result.extensions.some((r) => isDisabled(r, "excluded.ts"))).toBe(true);
			expect(result.extensions.some((r) => isEnabled(r, "force-back.ts"))).toBe(true);
		});

		it("should force-include after specific exclusion", async () => {
			const extDir = join(agentDir, "extensions");
			mkdirSync(extDir, { recursive: true });
			writeFileSync(join(extDir, "a.ts"), "export default function() {}");
			writeFileSync(join(extDir, "b.ts"), "export default function() {}");

			settingsManager.setExtensionPaths(["extensions", "!extensions/b.ts", "+extensions/b.ts"]);

			const result = await resourceResolver.resolve();
			expect(result.extensions.some((r) => isEnabled(r, "a.ts"))).toBe(true);
			expect(result.extensions.some((r) => isEnabled(r, "b.ts"))).toBe(true);
		});

		it("should force-include prompts", async () => {
			const promptsDir = join(agentDir, "prompts");
			mkdirSync(promptsDir, { recursive: true });
			writeFileSync(join(promptsDir, "review.md"), "Review");
			writeFileSync(join(promptsDir, "explain.md"), "Explain");
			writeFileSync(join(promptsDir, "debug.md"), "Debug");

			settingsManager.setPromptTemplatePaths(["prompts", "!prompts/*.md", "+prompts/debug.md"]);

			const result = await resourceResolver.resolve();
			expect(result.prompts.some((r) => isDisabled(r, "review.md"))).toBe(true);
			expect(result.prompts.some((r) => isDisabled(r, "explain.md"))).toBe(true);
			expect(result.prompts.some((r) => isEnabled(r, "debug.md"))).toBe(true);
		});
	});

	describe("force-exclude patterns", () => {
		it("should force-exclude top-level resources", async () => {
			const extDir = join(agentDir, "extensions");
			mkdirSync(extDir, { recursive: true });
			writeFileSync(join(extDir, "alpha.ts"), "export default function() {}");
			writeFileSync(join(extDir, "beta.ts"), "export default function() {}");

			settingsManager.setExtensionPaths(["extensions", "+extensions/alpha.ts", "-extensions/alpha.ts"]);

			const result = await resourceResolver.resolve();
			expect(result.extensions.some((r) => isDisabled(r, "alpha.ts"))).toBe(true);
			expect(result.extensions.some((r) => isEnabled(r, "beta.ts"))).toBe(true);
		});
	});

	describe("multi-file extension discovery (issue #1102)", () => {
		it("should only load index.ts from subdirectories, not helper modules", async () => {
			const pkgDir = join(tempDir, "multifile-pkg");
			mkdirSync(join(pkgDir, "extensions", "subagent"), { recursive: true });

			writeFileSync(
				join(pkgDir, "extensions", "subagent", "index.ts"),
				`import { helper } from "./agents.ts";
export default function(api) { api.registerTool({ name: "test", description: "test", execute: async () => helper() }); }`,
			);
			writeFileSync(
				join(pkgDir, "extensions", "subagent", "agents.ts"),
				`export function helper() { return "helper"; }`,
			);
			writeFileSync(join(pkgDir, "extensions", "standalone.ts"), "export default function(api) {}");

			const result = resourceResolver.resolveCliExtensions([join(pkgDir, "extensions")]);

			expect(result.some((r) => pathEndsWith(r.path, "subagent/index.ts") && r.enabled)).toBe(true);
			expect(result.some((r) => pathEndsWith(r.path, "standalone.ts") && r.enabled)).toBe(true);

			expect(result.some((r) => pathEndsWith(r.path, "agents.ts"))).toBe(false);
		});

		it("should handle mixed top-level files and subdirectories", async () => {
			const pkgDir = join(tempDir, "mixed-pkg");
			mkdirSync(join(pkgDir, "extensions", "complex"), { recursive: true });

			writeFileSync(join(pkgDir, "extensions", "simple.ts"), "export default function(api) {}");

			writeFileSync(
				join(pkgDir, "extensions", "complex", "index.ts"),
				"import { a } from './a.ts'; export default function(api) {}",
			);
			writeFileSync(join(pkgDir, "extensions", "complex", "a.ts"), "export const a = 1;");
			writeFileSync(join(pkgDir, "extensions", "complex", "b.ts"), "export const b = 2;");

			const result = resourceResolver.resolveCliExtensions([join(pkgDir, "extensions")]);

			expect(result.some((r) => pathEndsWith(r.path, "simple.ts") && r.enabled)).toBe(true);
			expect(result.some((r) => pathEndsWith(r.path, "complex/index.ts") && r.enabled)).toBe(true);

			expect(result.some((r) => pathEndsWith(r.path, "complex/a.ts"))).toBe(false);
			expect(result.some((r) => pathEndsWith(r.path, "complex/b.ts"))).toBe(false);

			expect(result.filter((r) => r.enabled).length).toBe(2);
		});

		it("should skip subdirectories without index.ts", async () => {
			const pkgDir = join(tempDir, "no-entry-pkg");
			mkdirSync(join(pkgDir, "extensions", "broken"), { recursive: true });

			writeFileSync(join(pkgDir, "extensions", "broken", "helper.ts"), "export const x = 1;");
			writeFileSync(join(pkgDir, "extensions", "broken", "another.ts"), "export const y = 2;");

			writeFileSync(join(pkgDir, "extensions", "valid.ts"), "export default function(api) {}");

			const result = resourceResolver.resolveCliExtensions([join(pkgDir, "extensions")]);

			expect(result.some((r) => pathEndsWith(r.path, "valid.ts") && r.enabled)).toBe(true);
			expect(result.filter((r) => r.enabled).length).toBe(1);
		});
	});
});
