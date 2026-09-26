import { mkdirSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { AuthStorage } from "../src/core/auth-storage.ts";
import { ExtensionRunner } from "../src/core/extensions/runner.ts";
import { DefaultResourceLoader, loadProjectContextFiles } from "../src/core/resource-loader.ts";
import { SessionManager } from "../src/core/session-manager.ts";
import { SettingsManager } from "../src/core/settings-manager.ts";
import type { Skill } from "../src/core/skills.ts";
import { createSyntheticSourceInfo } from "../src/core/source-info.ts";

import { createModelRegistry } from "./model-runtime-test-utils.ts";

describe("DefaultResourceLoader", () => {
	let tempDir: string;
	let agentDir: string;
	let cwd: string;

	beforeEach(() => {
		tempDir = join(tmpdir(), `rl-test-${Date.now()}-${Math.random().toString(36).slice(2)}`);
		agentDir = join(tempDir, "agent");
		cwd = join(tempDir, "project");
		mkdirSync(agentDir, { recursive: true });
		mkdirSync(cwd, { recursive: true });
	});

	afterEach(() => {
		rmSync(tempDir, { recursive: true, force: true });
	});

	describe("reload", () => {
		it("should initialize with empty results before reload", () => {
			const loader = new DefaultResourceLoader({ cwd, agentDir });

			expect(loader.getExtensions().extensions).toEqual([]);
			expect(loader.getSkills().skills).toEqual([]);
			expect(loader.getPrompts().prompts).toEqual([]);
		});

		it("should not treat a project manifest as the owner of a project extension", async () => {
			const extensionsDir = join(cwd, ".pi", "extensions");
			mkdirSync(extensionsDir, { recursive: true });
			writeFileSync(
				join(cwd, "package.json"),
				JSON.stringify({ dependencies: { "@earendil-works/pi-coding-agent": "1.0.0" } }),
			);
			writeFileSync(join(extensionsDir, "project-extension.ts"), "export default function() {}");

			const loader = new DefaultResourceLoader({ cwd, agentDir });
			await loader.reload();

			expect(loader.getExtensions().extensions).toHaveLength(1);
			expect(loader.getExtensions().warnings).toEqual([]);
		});

		it("should discover skills from agentDir", async () => {
			const skillsDir = join(agentDir, "skills");
			mkdirSync(skillsDir, { recursive: true });
			writeFileSync(
				join(skillsDir, "test-skill.md"),
				`---
name: test-skill
description: A test skill
---
Skill content here.`,
			);

			const loader = new DefaultResourceLoader({ cwd, agentDir });
			await loader.reload();

			const { skills } = loader.getSkills();
			expect(skills.some((s) => s.name === "test-skill")).toBe(true);
		});

		it("should ignore extra markdown files in auto-discovered skill dirs", async () => {
			const skillDir = join(agentDir, "skills", "pi-skills", "browser-tools");
			mkdirSync(skillDir, { recursive: true });
			writeFileSync(
				join(skillDir, "SKILL.md"),
				`---
name: browser-tools
description: Browser tools
---
Skill content here.`,
			);
			writeFileSync(join(skillDir, "EFFICIENCY.md"), "No frontmatter here");

			const loader = new DefaultResourceLoader({ cwd, agentDir });
			await loader.reload();

			const { skills, diagnostics } = loader.getSkills();
			expect(skills.some((s) => s.name === "browser-tools")).toBe(true);
			expect(diagnostics.some((d) => d.path?.endsWith("EFFICIENCY.md"))).toBe(false);
		});

		it("should discover prompts from agentDir", async () => {
			const promptsDir = join(agentDir, "prompts");
			mkdirSync(promptsDir, { recursive: true });
			writeFileSync(
				join(promptsDir, "test-prompt.md"),
				`---
description: A test prompt
---
Prompt content.`,
			);

			const loader = new DefaultResourceLoader({ cwd, agentDir });
			await loader.reload();

			const { prompts } = loader.getPrompts();
			expect(prompts.some((p) => p.name === "test-prompt")).toBe(true);
		});

		it("should report invalid prompt frontmatter while loading valid siblings", async () => {
			const promptsDir = join(agentDir, "prompts");
			const invalidPromptPath = join(promptsDir, "invalid.md");
			mkdirSync(promptsDir, { recursive: true });
			writeFileSync(invalidPromptPath, "---\ndescription: Broken: unquoted colon\n---\nDo something.\n");
			writeFileSync(join(promptsDir, "valid.md"), "Valid prompt content.");

			const loader = new DefaultResourceLoader({ cwd, agentDir });
			await loader.reload();

			const { prompts, diagnostics } = loader.getPrompts();
			expect(prompts.map((prompt) => prompt.name)).toEqual(["valid"]);
			expect(diagnostics).toEqual([
				expect.objectContaining({
					type: "warning",
					path: invalidPromptPath,
					message: expect.stringContaining("YAML Parse error"),
				}),
			]);
		});

		it("should prefer project resources over user on name collisions", async () => {
			const userPromptsDir = join(agentDir, "prompts");
			const projectPromptsDir = join(cwd, ".pi", "prompts");
			mkdirSync(userPromptsDir, { recursive: true });
			mkdirSync(projectPromptsDir, { recursive: true });
			const userPromptPath = join(userPromptsDir, "commit.md");
			const projectPromptPath = join(projectPromptsDir, "commit.md");
			writeFileSync(userPromptPath, "User prompt");
			writeFileSync(projectPromptPath, "Project prompt");

			const userSkillDir = join(agentDir, "skills", "collision-skill");
			const projectSkillDir = join(cwd, ".pi", "skills", "collision-skill");
			mkdirSync(userSkillDir, { recursive: true });
			mkdirSync(projectSkillDir, { recursive: true });
			const userSkillPath = join(userSkillDir, "SKILL.md");
			const projectSkillPath = join(projectSkillDir, "SKILL.md");
			writeFileSync(
				userSkillPath,
				`---
name: collision-skill
description: user
---
User skill`,
			);
			writeFileSync(
				projectSkillPath,
				`---
name: collision-skill
description: project
---
Project skill`,
			);

			const loader = new DefaultResourceLoader({ cwd, agentDir });
			await loader.reload();

			const prompt = loader.getPrompts().prompts.find((p) => p.name === "commit");
			expect(prompt?.filePath).toBe(projectPromptPath);

			const skill = loader.getSkills().skills.find((s) => s.name === "collision-skill");
			expect(skill?.filePath).toBe(projectSkillPath);
		});

		it("should load symlinked user and project extensions once", async () => {
			const sharedExtDir = join(tempDir, "shared-extensions");
			mkdirSync(sharedExtDir, { recursive: true });
			writeFileSync(
				join(sharedExtDir, "shared.ts"),
				`export default function(pi) {
	pi.registerCommand("shared", {
		description: "shared command",
		handler: async () => {},
	});
}`,
			);

			mkdirSync(agentDir, { recursive: true });
			mkdirSync(join(cwd, ".pi"), { recursive: true });
			symlinkSync(sharedExtDir, join(agentDir, "extensions"), "dir");
			symlinkSync(sharedExtDir, join(cwd, ".pi", "extensions"), "dir");

			const loader = new DefaultResourceLoader({ cwd, agentDir });
			await loader.reload();

			const extensionsResult = loader.getExtensions();
			expect(extensionsResult.extensions).toHaveLength(1);
			expect(extensionsResult.errors).toEqual([]);

			expect(extensionsResult.extensions[0].path).toBe(join(cwd, ".pi", "extensions", "shared.ts"));
		});


		it("should keep both extensions loaded when command names collide", async () => {
			const userExtDir = join(agentDir, "extensions");
			const projectExtDir = join(cwd, ".pi", "extensions");
			mkdirSync(userExtDir, { recursive: true });
			mkdirSync(projectExtDir, { recursive: true });

			writeFileSync(
				join(projectExtDir, "project.ts"),
				`export default function(pi) {
	pi.registerCommand("deploy", {
		description: "project deploy",
		handler: async () => {},
	});
	pi.registerCommand("project-only", {
		description: "project only",
		handler: async () => {},
	});
}`,
			);

			writeFileSync(
				join(userExtDir, "user.ts"),
				`export default function(pi) {
	pi.registerCommand("deploy", {
		description: "user deploy",
		handler: async () => {},
	});
	pi.registerCommand("user-only", {
		description: "user only",
		handler: async () => {},
	});
}`,
			);

			const loader = new DefaultResourceLoader({ cwd, agentDir });
			await loader.reload();

			const extensionsResult = loader.getExtensions();
			expect(extensionsResult.extensions).toHaveLength(2);
			expect(extensionsResult.errors.some((e) => e.error.includes('Command "/deploy" conflicts'))).toBe(false);

			const sessionManager = SessionManager.inMemory();
			const authStorage = AuthStorage.create(join(tempDir, "auth.json"));
			const modelRegistry = await createModelRegistry(authStorage);
			const runner = new ExtensionRunner(
				extensionsResult.extensions,
				extensionsResult.runtime,
				cwd,
				sessionManager,
				modelRegistry,
			);

			expect(runner.getCommand("deploy:1")?.description).toBe("project deploy");
			expect(runner.getCommand("deploy:2")?.description).toBe("user deploy");
			expect(runner.getCommand("project-only")?.description).toBe("project only");
			expect(runner.getCommand("user-only")?.description).toBe("user only");

			const commands = runner.getRegisteredCommands();
			expect(commands.map((command) => command.invocationName)).toEqual([
				"deploy:1",
				"project-only",
				"deploy:2",
				"user-only",
			]);
		});

		it("should honor overrides for auto-discovered resources", async () => {
			const settingsManager = SettingsManager.inMemory();
			settingsManager.setExtensionPaths(["-extensions/disabled.ts"]);
			settingsManager.setSkillPaths(["-skills/skip-skill"]);
			settingsManager.setPromptTemplatePaths(["-prompts/skip.md"]);

			const extensionsDir = join(agentDir, "extensions");
			mkdirSync(extensionsDir, { recursive: true });
			writeFileSync(join(extensionsDir, "disabled.ts"), "export default function() {}");

			const skillDir = join(agentDir, "skills", "skip-skill");
			mkdirSync(skillDir, { recursive: true });
			writeFileSync(
				join(skillDir, "SKILL.md"),
				`---
name: skip-skill
description: Skip me
---
Content`,
			);

			const promptsDir = join(agentDir, "prompts");
			mkdirSync(promptsDir, { recursive: true });
			writeFileSync(join(promptsDir, "skip.md"), "Skip prompt");

			const loader = new DefaultResourceLoader({ cwd, agentDir, settingsManager });
			await loader.reload();

			const { extensions } = loader.getExtensions();
			const { skills } = loader.getSkills();
			const { prompts } = loader.getPrompts();

			expect(extensions.some((e) => e.path.endsWith("disabled.ts"))).toBe(false);
			expect(skills.some((s) => s.name === "skip-skill")).toBe(false);
			expect(prompts.some((p) => p.name === "skip")).toBe(false);
		});

		it("should discover AGENTS.md context files", async () => {
			writeFileSync(join(cwd, "AGENTS.md"), "# Project Guidelines\n\nBe helpful.");

			const loader = new DefaultResourceLoader({ cwd, agentDir });
			await loader.reload();

			const { agentsFiles } = loader.getAgentsFiles();
			expect(agentsFiles.some((f) => f.path.includes("AGENTS.md"))).toBe(true);
		});

		it("should prefer AGENTS.override.md within each directory while preserving ancestor layering", async () => {
			const nestedCwd = join(cwd, "service");
			mkdirSync(nestedCwd);
			writeFileSync(join(agentDir, "AGENTS.md"), "global instructions");
			writeFileSync(join(agentDir, "AGENTS.override.md"), "global override");
			writeFileSync(join(cwd, "AGENTS.md"), "project instructions");
			writeFileSync(join(nestedCwd, "AGENTS.md"), "service instructions");
			writeFileSync(join(nestedCwd, "AGENTS.override.md"), "service override");

			const loader = new DefaultResourceLoader({ cwd: nestedCwd, agentDir });
			await loader.reload();

			expect(loader.getAgentsFiles().agentsFiles).toEqual([
				{ path: join(agentDir, "AGENTS.override.md"), content: "global override" },
				{ path: join(cwd, "AGENTS.md"), content: "project instructions" },
				{ path: join(nestedCwd, "AGENTS.override.md"), content: "service override" },
			]);
		});

		it("should ignore context file candidates that are directories", async () => {
			mkdirSync(join(cwd, "AGENTS.override.md"));
			mkdirSync(join(cwd, "AGENTS.md"));
			writeFileSync(join(cwd, "CLAUDE.md"), "Fallback instructions");
			const consoleError = vi.spyOn(console, "error").mockImplementation(() => {});

			const loader = new DefaultResourceLoader({ cwd, agentDir });
			await loader.reload();

			expect(loader.getAgentsFiles().agentsFiles).toContainEqual({
				path: join(cwd, "CLAUDE.md"),
				content: "Fallback instructions",
			});
			expect(consoleError).not.toHaveBeenCalledWith(expect.stringContaining(join(cwd, "AGENTS.md")));
			expect(consoleError).not.toHaveBeenCalledWith(expect.stringContaining(join(cwd, "AGENTS.override.md")));
			consoleError.mockRestore();
		});

		it("should skip context file discovery when noContextFiles is true", async () => {
			writeFileSync(join(cwd, "AGENTS.override.md"), "# Override Guidelines\n\nBe helpful.");
			writeFileSync(join(cwd, "AGENTS.md"), "# Project Guidelines\n\nBe helpful.");
			writeFileSync(join(cwd, "CLAUDE.md"), "# Claude Guidelines\n\nBe helpful.");

			const loader = new DefaultResourceLoader({ cwd, agentDir, noContextFiles: true });
			await loader.reload();

			const { agentsFiles } = loader.getAgentsFiles();
			expect(agentsFiles).toEqual([]);
		});

		it("should discover SYSTEM.md from cwd/.pi", async () => {
			const piDir = join(cwd, ".pi");
			mkdirSync(piDir, { recursive: true });
			writeFileSync(join(piDir, "SYSTEM.md"), "You are a helpful assistant.");

			const loader = new DefaultResourceLoader({ cwd, agentDir });
			await loader.reload();

			expect(loader.getSystemPrompt()).toBe("You are a helpful assistant.");
		});


		it("should discover APPEND_SYSTEM.md", async () => {
			const piDir = join(cwd, ".pi");
			mkdirSync(piDir, { recursive: true });
			writeFileSync(join(piDir, "APPEND_SYSTEM.md"), "Additional instructions.");

			const loader = new DefaultResourceLoader({ cwd, agentDir });
			await loader.reload();

			expect(loader.getAppendSystemPrompt()).toContain("Additional instructions.");
		});
	});

	describe("system prompt sources", () => {
		it("exposes discovered project SYSTEM.md as the system prompt source", async () => {
			const piDir = join(cwd, ".pi");
			const systemPromptPath = join(piDir, "SYSTEM.md");
			mkdirSync(piDir, { recursive: true });
			writeFileSync(systemPromptPath, "Project system prompt.");

			const loader = new DefaultResourceLoader({ cwd, agentDir });
			await loader.reload();

			expect(loader.getSystemPrompt()).toBe("Project system prompt.");
			expect(loader.getSystemPromptSource()).toEqual({ path: systemPromptPath });
		});

		it("exposes discovered global SYSTEM.md as the system prompt source", async () => {
			const systemPromptPath = join(agentDir, "SYSTEM.md");
			writeFileSync(systemPromptPath, "Global system prompt.");

			const loader = new DefaultResourceLoader({ cwd, agentDir });
			await loader.reload();

			expect(loader.getSystemPrompt()).toBe("Global system prompt.");
			expect(loader.getSystemPromptSource()).toEqual({ path: systemPromptPath });
		});

		it("does not expose literal system prompt text as a source", async () => {
			const loader = new DefaultResourceLoader({ cwd, agentDir, systemPrompt: "Literal system prompt." });
			await loader.reload();

			expect(loader.getSystemPrompt()).toBe("Literal system prompt.");
			expect(loader.getSystemPromptSource()).toBeUndefined();
		});

		it("exposes file-backed system prompt options as a source", async () => {
			const systemPromptPath = join(tempDir, "custom-system.md");
			writeFileSync(systemPromptPath, "Custom system prompt.");

			const loader = new DefaultResourceLoader({ cwd, agentDir, systemPrompt: systemPromptPath });
			await loader.reload();

			expect(loader.getSystemPrompt()).toBe("Custom system prompt.");
			expect(loader.getSystemPromptSource()).toEqual({ path: systemPromptPath });
		});

		it("exposes discovered APPEND_SYSTEM.md as an append system prompt source", async () => {
			const piDir = join(cwd, ".pi");
			const appendSystemPromptPath = join(piDir, "APPEND_SYSTEM.md");
			mkdirSync(piDir, { recursive: true });
			writeFileSync(appendSystemPromptPath, "Project append prompt.");

			const loader = new DefaultResourceLoader({ cwd, agentDir });
			await loader.reload();

			expect(loader.getAppendSystemPrompt()).toEqual(["Project append prompt."]);
			expect(loader.getAppendSystemPromptSources()).toEqual([{ path: appendSystemPromptPath }]);
		});

		it("does not expose literal append system prompt text as a source", async () => {
			const loader = new DefaultResourceLoader({ cwd, agentDir, appendSystemPrompt: ["Literal append prompt."] });
			await loader.reload();

			expect(loader.getAppendSystemPrompt()).toEqual(["Literal append prompt."]);
			expect(loader.getAppendSystemPromptSources()).toEqual([]);
		});

		it("only exposes file-backed append system prompt options as sources", async () => {
			const appendSystemPromptPath = join(tempDir, "custom-append.md");
			writeFileSync(appendSystemPromptPath, "Custom append prompt.");

			const loader = new DefaultResourceLoader({
				cwd,
				agentDir,
				appendSystemPrompt: [appendSystemPromptPath, "Literal append prompt."],
			});
			await loader.reload();

			expect(loader.getAppendSystemPrompt()).toEqual(["Custom append prompt.", "Literal append prompt."]);
			expect(loader.getAppendSystemPromptSources()).toEqual([{ path: appendSystemPromptPath }]);
		});
	});

	describe("extendResources", () => {
		it("should load skills and prompts with extension metadata", async () => {
			const extraSkillDir = join(tempDir, "extra-skills", "extra-skill");
			mkdirSync(extraSkillDir, { recursive: true });
			const skillPath = join(extraSkillDir, "SKILL.md");
			writeFileSync(
				skillPath,
				`---
name: extra-skill
description: Extra skill
---
Extra content`,
			);

			const extraPromptDir = join(tempDir, "extra-prompts");
			mkdirSync(extraPromptDir, { recursive: true });
			const promptPath = join(extraPromptDir, "extra.md");
			writeFileSync(
				promptPath,
				`---
description: Extra prompt
---
Extra prompt content`,
			);

			const loader = new DefaultResourceLoader({ cwd, agentDir });
			await loader.reload();

			loader.extendResources({
				skillPaths: [
					{
						path: extraSkillDir,
						metadata: {
							source: "extension:extra",
							scope: "temporary",
							baseDir: extraSkillDir,
						},
					},
				],
				promptPaths: [
					{
						path: promptPath,
						metadata: {
							source: "extension:extra",
							scope: "temporary",
							baseDir: extraPromptDir,
						},
					},
				],
			});

			const { skills } = loader.getSkills();
			const loadedSkill = skills.find((skill) => skill.name === "extra-skill");
			expect(loadedSkill).toBeDefined();
			expect(loadedSkill?.sourceInfo?.source).toBe("extension:extra");
			expect(loadedSkill?.sourceInfo?.path).toBe(skillPath);

			const { prompts } = loader.getPrompts();
			const loadedPrompt = prompts.find((prompt) => prompt.name === "extra");
			expect(loadedPrompt).toBeDefined();
			expect(loadedPrompt?.sourceInfo?.source).toBe("extension:extra");
			expect(loadedPrompt?.sourceInfo?.path).toBe(promptPath);
		});

		it("should load extension resources returned as file URLs", async () => {
			const extraSkillDir = join(tempDir, "extra skills", "file-url-skill");
			mkdirSync(extraSkillDir, { recursive: true });
			const skillPath = join(extraSkillDir, "SKILL.md");
			writeFileSync(
				skillPath,
				`---
name: file-url-skill
description: File URL skill
---
Extra content`,
			);

			const loader = new DefaultResourceLoader({ cwd, agentDir });
			await loader.reload();

			loader.extendResources({
				skillPaths: [
					{
						path: pathToFileURL(extraSkillDir).href,
						metadata: {
							source: "extension:file-url",
							scope: "temporary",
							baseDir: extraSkillDir,
						},
					},
				],
			});

			const { skills, diagnostics } = loader.getSkills();
			expect(diagnostics).toEqual([]);
			const loadedSkill = skills.find((skill) => skill.name === "file-url-skill");
			expect(loadedSkill).toBeDefined();
			expect(loadedSkill?.filePath).toBe(skillPath);
			expect(loadedSkill?.sourceInfo?.source).toBe("extension:file-url");
		});
	});

	describe("noSkills option", () => {
		it("should skip skill discovery when noSkills is true", async () => {
			const skillsDir = join(agentDir, "skills");
			mkdirSync(skillsDir, { recursive: true });
			writeFileSync(
				join(skillsDir, "test-skill.md"),
				`---
name: test-skill
description: A test skill
---
Content`,
			);

			const loader = new DefaultResourceLoader({ cwd, agentDir, noSkills: true });
			await loader.reload();

			const { skills } = loader.getSkills();
			expect(skills).toEqual([]);
		});

		it("should still load additional skill paths when noSkills is true", async () => {
			const customSkillDir = join(tempDir, "custom-skills");
			mkdirSync(customSkillDir, { recursive: true });
			writeFileSync(
				join(customSkillDir, "custom.md"),
				`---
name: custom
description: Custom skill
---
Content`,
			);

			const loader = new DefaultResourceLoader({
				cwd,
				agentDir,
				noSkills: true,
				additionalSkillPaths: [customSkillDir],
			});
			await loader.reload();

			const { skills } = loader.getSkills();
			expect(skills.some((s) => s.name === "custom")).toBe(true);
		});
	});

	describe("override functions", () => {
		it("should apply skillsOverride", async () => {
			const injectedSkill: Skill = {
				name: "injected",
				description: "Injected skill",
				filePath: "/fake/path",
				baseDir: "/fake",
				sourceInfo: createSyntheticSourceInfo("/fake/path", { source: "custom" }),
				disableModelInvocation: false,
			};
			const loader = new DefaultResourceLoader({
				cwd,
				agentDir,
				skillsOverride: () => ({
					skills: [injectedSkill],
					diagnostics: [],
				}),
			});
			await loader.reload();

			const { skills } = loader.getSkills();
			expect(skills).toHaveLength(1);
			expect(skills[0].name).toBe("injected");
		});

		it("should apply systemPromptOverride", async () => {
			const loader = new DefaultResourceLoader({
				cwd,
				agentDir,
				systemPromptOverride: () => "Custom system prompt",
			});
			await loader.reload();

			expect(loader.getSystemPrompt()).toBe("Custom system prompt");
		});
	});

	describe("extension conflict detection", () => {
		it("should detect tool conflicts between extensions", async () => {
			const ext1Dir = join(agentDir, "extensions", "ext1");
			const ext2Dir = join(agentDir, "extensions", "ext2");
			mkdirSync(ext1Dir, { recursive: true });
			mkdirSync(ext2Dir, { recursive: true });

			writeFileSync(
				join(ext1Dir, "index.ts"),
				`
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
export default function(pi: ExtensionAPI) {
  pi.registerTool({
    name: "duplicate-tool",
    description: "First",
    parameters: Type.Object({}),
    execute: async () => ({ result: "1" }),
  });
}`,
			);

			writeFileSync(
				join(ext2Dir, "index.ts"),
				`
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
export default function(pi: ExtensionAPI) {
  pi.registerTool({
    name: "duplicate-tool",
    description: "Second",
    parameters: Type.Object({}),
    execute: async () => ({ result: "2" }),
  });
}`,
			);

			const loader = new DefaultResourceLoader({ cwd, agentDir });
			await loader.reload();

			const { errors } = loader.getExtensions();
			expect(errors.some((e) => e.error.includes("duplicate-tool") && e.error.includes("conflicts"))).toBe(true);
		});

		it("should prefer explicit CLI extensions over discovered extensions when commands and tools conflict", async () => {
			const globalExtDir = join(agentDir, "extensions");
			mkdirSync(globalExtDir, { recursive: true });
			const explicitExtPath = join(tempDir, "explicit-extension.ts");

			writeFileSync(
				join(globalExtDir, "global.ts"),
				`
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
export default function(pi: ExtensionAPI) {
  pi.registerTool({
    name: "duplicate-tool",
    description: "global tool",
    parameters: Type.Object({}),
    execute: async () => ({ result: "global" }),
  });
  pi.registerCommand("deploy", {
    description: "global command",
    handler: async () => {},
  });
}`,
			);

			writeFileSync(
				explicitExtPath,
				`
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
export default function(pi: ExtensionAPI) {
  pi.registerTool({
    name: "duplicate-tool",
    description: "explicit tool",
    parameters: Type.Object({}),
    execute: async () => ({ result: "explicit" }),
  });
  pi.registerCommand("deploy", {
    description: "explicit command",
    handler: async () => {},
  });
}`,
			);

			const loader = new DefaultResourceLoader({
				cwd,
				agentDir,
				additionalExtensionPaths: [explicitExtPath],
			});
			await loader.reload();

			const extensionsResult = loader.getExtensions();
			expect(extensionsResult.extensions[0]?.path).toBe(explicitExtPath);

			const sessionManager = SessionManager.inMemory();
			const authStorage = AuthStorage.create(join(tempDir, "auth-explicit.json"));
			const modelRegistry = await createModelRegistry(authStorage);
			const runner = new ExtensionRunner(
				extensionsResult.extensions,
				extensionsResult.runtime,
				cwd,
				sessionManager,
				modelRegistry,
			);

			expect(runner.getCommand("deploy:1")?.description).toBe("explicit command");
			expect(runner.getCommand("deploy:2")?.description).toBe("global command");
			expect(runner.getToolDefinition("duplicate-tool")?.description).toBe("explicit tool");
		});
	});

	describe("loadProjectContextFiles - nested worktree dedup", () => {
		const linkWorktree = (mainDir: string, worktreeDir: string, name: string) => {
			const gitDir = join(mainDir, ".git", "worktrees", name);
			mkdirSync(gitDir, { recursive: true });
			writeFileSync(join(mainDir, ".git", "HEAD"), "ref: refs/heads/main\n");
			writeFileSync(join(gitDir, "HEAD"), "ref: refs/heads/feat\n");
			writeFileSync(join(gitDir, "commondir"), "../..");
			writeFileSync(join(worktreeDir, ".git"), `gitdir: ${gitDir}\n`);
		};

		const setupNestedWorktree = () => {
			const outer = join(tempDir, "outer");
			const main = join(outer, "main");
			const worktree = join(main, "worktrees", "feat");
			const worktreeSrc = join(worktree, "src");
			mkdirSync(worktreeSrc, { recursive: true });
			linkWorktree(main, worktree, "feat");
			return { outer, main, worktree, worktreeSrc };
		};

		it("should skip the main repo's duplicate when the worktree root has its own context", () => {
			const { main, worktree, worktreeSrc } = setupNestedWorktree();
			writeFileSync(join(main, "AGENTS.md"), "main repo instructions");
			writeFileSync(join(worktree, "AGENTS.md"), "worktree instructions");

			const files = loadProjectContextFiles({ cwd: worktreeSrc, agentDir });

			expect(files.map((f) => f.content)).toEqual(["worktree instructions"]);
		});

		it("should still inherit the main repo's context when the worktree root has none", () => {
			const { main, worktreeSrc } = setupNestedWorktree();
			writeFileSync(join(main, "AGENTS.md"), "main repo instructions");

			const files = loadProjectContextFiles({ cwd: worktreeSrc, agentDir });

			expect(files.map((f) => f.content)).toEqual(["main repo instructions"]);
		});

		it("should only skip the same filename, not a differently named context file", () => {
			const { main, worktree, worktreeSrc } = setupNestedWorktree();
			writeFileSync(join(main, "CLAUDE.md"), "main repo instructions");
			writeFileSync(join(worktree, "AGENTS.md"), "worktree instructions");

			const files = loadProjectContextFiles({ cwd: worktreeSrc, agentDir });

			expect(files.map((f) => f.content)).toEqual(["main repo instructions", "worktree instructions"]);
		});

		it("should NOT skip the container's context in a bare layout (proj/.bare + proj/main)", () => {
			const proj = join(tempDir, "proj");
			const bare = join(proj, ".bare");
			const worktree = join(proj, "main");
			const worktreeGitDir = join(bare, "worktrees", "main");
			mkdirSync(worktreeGitDir, { recursive: true });
			mkdirSync(worktree, { recursive: true });
			writeFileSync(join(bare, "HEAD"), "ref: refs/heads/main\n");
			writeFileSync(join(worktreeGitDir, "HEAD"), "ref: refs/heads/main\n");
			writeFileSync(join(worktreeGitDir, "commondir"), "../..");
			writeFileSync(join(worktree, ".git"), `gitdir: ${worktreeGitDir}\n`);
			writeFileSync(join(proj, "AGENTS.md"), "container instructions");
			writeFileSync(join(worktree, "AGENTS.md"), "worktree instructions");

			const files = loadProjectContextFiles({ cwd: worktree, agentDir });

			expect(files.map((f) => f.content)).toEqual(["container instructions", "worktree instructions"]);
		});

		it("should keep loading ancestors above the main repo", () => {
			const { outer, main, worktree, worktreeSrc } = setupNestedWorktree();
			writeFileSync(join(outer, "AGENTS.md"), "outer instructions");
			writeFileSync(join(main, "AGENTS.md"), "main repo instructions");
			writeFileSync(join(worktree, "AGENTS.md"), "worktree instructions");

			const files = loadProjectContextFiles({ cwd: worktreeSrc, agentDir });

			expect(files.map((f) => f.content)).toEqual(["outer instructions", "worktree instructions"]);
		});

		it("should NOT skip anything for a sibling worktree (main repo is not an ancestor)", () => {
			const outer = join(tempDir, "outer");
			const main = join(outer, "main");
			const sib = join(outer, "sib-feat");
			const sibSrc = join(sib, "src");
			mkdirSync(sibSrc, { recursive: true });
			mkdirSync(main, { recursive: true });
			writeFileSync(join(outer, "AGENTS.md"), "outer instructions");
			writeFileSync(join(sib, "AGENTS.md"), "sibling worktree instructions");
			linkWorktree(main, sib, "sib");

			const files = loadProjectContextFiles({ cwd: sibSrc, agentDir });

			expect(files.map((f) => f.content)).toEqual(["outer instructions", "sibling worktree instructions"]);
		});

		it("should NOT skip the superproject's context from inside a submodule", () => {
			const sup = join(tempDir, "super");
			const sub = join(sup, "vendor", "lib");
			const subSrc = join(sub, "src");
			mkdirSync(subSrc, { recursive: true });
			writeFileSync(join(sup, "AGENTS.md"), "superproject instructions");
			writeFileSync(join(sub, "AGENTS.md"), "submodule instructions");
			const subGitDir = join(sup, ".git", "modules", "vendor", "lib");
			mkdirSync(subGitDir, { recursive: true });
			writeFileSync(join(subGitDir, "HEAD"), "ref: refs/heads/main\n");
			writeFileSync(join(sub, ".git"), `gitdir: ${subGitDir}\n`);

			const files = loadProjectContextFiles({ cwd: subSrc, agentDir });

			expect(files.map((f) => f.content)).toEqual(["superproject instructions", "submodule instructions"]);
		});

		it("should keep climbing past an ordinary repo root", () => {
			const outer = join(tempDir, "outer");
			const repo = join(outer, "repo");
			const leaf = join(repo, "src");
			mkdirSync(leaf, { recursive: true });
			mkdirSync(join(repo, ".git"), { recursive: true });
			writeFileSync(join(repo, ".git", "HEAD"), "ref: refs/heads/main\n");
			writeFileSync(join(outer, "AGENTS.md"), "outer instructions");
			writeFileSync(join(repo, "AGENTS.md"), "repo instructions");
			writeFileSync(join(leaf, "AGENTS.md"), "leaf instructions");

			const files = loadProjectContextFiles({ cwd: leaf, agentDir });

			expect(files.map((f) => f.content)).toEqual(["outer instructions", "repo instructions", "leaf instructions"]);
		});

		it("should climb normally when the gitdir: target does not exist", () => {
			const repo = join(tempDir, "corrupt");
			const src = join(repo, "src");
			mkdirSync(src, { recursive: true });
			writeFileSync(join(repo, ".git"), "gitdir: /nonexistent/path/worktrees/feat\n");
			writeFileSync(join(repo, "AGENTS.md"), "repo instructions");
			writeFileSync(join(src, "AGENTS.md"), "src instructions");

			const files = loadProjectContextFiles({ cwd: src, agentDir });

			expect(files.map((f) => f.content)).toEqual(["repo instructions", "src instructions"]);
		});
	});
});
