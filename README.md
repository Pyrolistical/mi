# mi

```
- 133,703 lines of pi code
+   5,920 lines added
=  48,352 lines of mi code
```

Personal fork of [pi.dev](https://github.com/earendil-works/pi)

<details>
<summary>Deleted code</summary>

### Deletions that improved security

- Telemetry
- Attribution headers
- Commands that sent session content out
   - `/share`, which uploaded the session to a GitHub gist
   - `/bug`, which uploaded a report and optionally the transcript to the pi developers
- `/import`, which loaded session JSONL files from elsewhere into context
- Login flows; credentials come from `auth.json` or env vars
   - OAuth
   - `/login`
   - `/logout`
- Post-install downloaded code
   - Update check
   - Self-update
   - Package install
   - Git package sources
   - fd/rg auto-download
- Native platform helpers, including their prebuilt binaries
   - Clipboard addons
   - Shift+Enter detection
- Remote model catalog
- Experimental runtime and its packages
   - Server, including the socket listener
   - Client
   - Protocol
- Docs and examples that the system prompt pointed the model at
- npm dependencies

### Deleted features

- Built-in providers and the predefined model catalog; every provider comes from `models.json` and uses the OpenAI Completions API
   - openai
   - openrouter
   - anthropic
   - azure
   - bedrock
   - google
   - vertex
   - mistral
   - openai-codex
   - github-copilot
   - xai
   - groq
   - cerebras
   - deepseek
   - nvidia
   - fireworks
   - together
   - baseten
   - huggingface
   - moonshotai
   - kimi
   - zai
   - minimax
   - meta
   - opencode
   - cloudflare
   - ant-ling
   - qwen token plan
   - xiaomi
   - vercel
   - radius
   - typesafe
   - openrouter images
   - pi-messages
- Provider-specific OpenAI Completions compat, except OpenRouter
   - hostname detection
   - thinking formats: deepseek, zai, qwen, together, baseten, ant-ling, string-thinking
   - `vercelGatewayRouting`, `zaiToolStream`, `chatTemplateArgs`, `requiresReasoningContentOnAssistantMessages`
- OpenAI Responses API
- Deferred (polled) responses
- Model types other than chat
- `inputLimits` in `models.json`, including image resize limits
- Modes
   - Print mode (`-p`)
   - JSON mode (`--mode json`)
   - RPC mode and the RPC client
- Fullscreen alt-screen mode, with mouse selection and transcript search
- Package bundles: the `packages` setting and the `pi` manifest in `package.json`
- Agent proxy stream function
- External editor (ctrl+g)
- Slash commands
   - `/export`
   - `/changelog`
   - `/hotkeys`
   - `/trust`
   - `/llama`
- Project trust prompt and `trust.json`
- Packages
   - chord
   - the agent harness
   - durable
   - sqlite-node session backend
   - evals
   - the old agent package
- Startup
   - Startup banner
   - Migrations of old auth, session, tool, keybinding and extension layouts
   - First-time setup
   - Changelog display
   - `pi config`
- Rendering
   - Mermaid
   - Syntax highlighting
   - Diffs
   - Image resizing
   - Themes, the theme picker and theme files; colors come from the terminal's ANSI palette
   - Background tints on messages and tool output
- HTML export
- Tools
   - powershell
   - grep
   - find
   - ls
- Models
   - Image generation
   - Classifiers
- Cache warming
- Easter eggs
- Footer details
   - cwd
   - git branch
   - session name
- Platform support
   - Windows
   - WSL
- Repo files
   - Changelogs
   - Release scripts
   - Workflows
   - Node scripts
- Hooks
- New agents

</details>

## New features

### Automatic background bash

Commands still running after 2 seconds, or called with `background: true`, move to the background. The output arrives later as a message that starts a new turn.

This lets the agent end its turn and respond to you while the command runs.

`background N` on the left of the row above the editor counts the running commands. Click it to list the commands with how long each has been running: ↑↓ selects, x kills, Esc closes. The agent is told when you kill a command.

```
background 2 callback 1                      mi 2 pi 37
```

```
bash {"command": "bun test"}
→ Command is running in the background. Its output will be sent to you when it exits.

…the agent ends its turn, and you keep chatting…

Background command finished: bun test

 1059 pass
Command exited with code 0
```

### Bash style `@` completion

`@` lists the entries of the directory typed so far, matching case sensitively, and Tab completes the longest common prefix, like Tab in bash.

pi's `@` completion was Windows style: Tab inserted the whole highlighted match, so you had to check the highlight before hitting Tab.

```
@packages/<Tab>        lists agent/ ai/ coding-agent/ tui/
@packages/co<Tab>      completes to @packages/coding-agent/
```

### Bash style Ctrl+R prompt search

Ctrl+R searches previous prompts across all sessions and loads the pick into the editor.

```
› rebase onto upstream and keep the fork commits on top
  rebase the removal commit
search: rebase
```

Tab opens the session of the highlighted result, with that prompt selected among the session's other prompts. ↑↓ picks which prompt to load. Tab or Esc goes back to the results.

### Prompt history across processes

↑ in the editor recalls the latest 100 prompts of every session in the same cwd, including after a restart.

### Webhook style callbacks

`mi create-callback` lets the agent create webhook style callbacks for bash commands. It prints a callback command: whatever is written to its stdin is sent to the agent as a message that starts a new turn. If the session is closed by then, the message arrives when the session is resumed.

Callbacks work for both synchronous and asynchronous processes.

```
callback=$(mi create-callback render)

./render-sync | $callback
./render-async --callback "$callback"

Callback from render

{"status": "done"}
```

The synchronous style is rarely needed, since slow commands already move to the background automatically, but it can be useful inside bash subshells.

The asynchronous style needs a program that accepts a callback, and the agent has to be told which programs do, for example in `AGENTS.md`:

```
./render-async takes --callback <command> and pipes its result to it when the render finishes.
Run `mi create-callback` for how to create the callback.
```

Because the agent created the callback, it knows the result will come back to it, so it ends its turn instead of polling.

`callback N` in the row above the editor counts the callbacks that have not been called yet.

### Clipboard support with OSC 52

Copying sets the terminal's clipboard, locally and over SSH.

### Mouse support with SGR mouse reporting

Clicking in the input box moves the cursor to the clicked character. Dragging still selects text natively or starts tmux copy mode, and the wheel still scrolls the terminal or enters tmux copy mode.

### Hardware cursor

The input box shows the terminal's own cursor instead of drawing a reverse-video block, so the terminal or tmux cursor style and blink apply.

```
set -g cursor-style blinking-bar
```

### Short system prompt

The system prompt is a preamble followed by project context, skills and cwd. About 650 tokens fewer than pi's default system prompt.

```
You are an expert coding agent.

<project_context>
Project-specific instructions and guidelines:

<project_instructions path="/home/me/app/AGENTS.md">
...
</project_instructions>
</project_context>

<skills>
...
</skills>

<cwd>
/home/me/app
</cwd>
```

### `llama-server` api type

A custom provider in `models.json` with just a `baseUrl` is a llama-server provider. It discovers its models, context size and image and video input from the server.

This results in a much shorter `~/.config/mi/models.json`.

```json
{
	"providers": {
		"local": {
			"baseUrl": "http://127.0.0.1:8080/v1"
		}
	}
}
```

### `~/.config/mi` config dir

Settings, credentials, extensions, skills and sessions live under `$XDG_CONFIG_HOME/mi`, which defaults to `~/.config/mi`, and project resources under `.mi/`.

```
~/.config/mi/auth.json
~/.config/mi/models.json
~/.config/mi/sessions/sessions.db
./.mi/skills/
```

### Pending updates

`mi N` and `pi N` above the editor count the commits waiting to be picked up. `mi N` is how many commits the running instance is behind `master`; restart to pick them up. `pi N` is how many upstream commits `master` has yet to take, checked daily at 12:00 UTC. `--offline` skips the check.

```
                   mi 2 pi 37
> _
```

## Bug fixes

### Fixed `/new` reverting to default, now keeps current model

`/new` starts a fresh session on the current model and thinking level.

```
/model qwen        thinking: high
/new               still qwen, thinking: high
```

### Fixed bodyless 413 error, now triggers compaction

A `413 (no body)` response from any provider counts as context overflow, so the session compacts and retries.

```
Error: 413 status code (no body)
→ compacting context, then retrying
```

### Fixed compaction exceeding the context window, now summarizes in chunks

A conversation too large for one summarization request is summarized in chunks that fit the model context window. Only llama-server providers; others still send one request.

```
Error: Compaction failed: Summarization failed: 400: request (1195129 tokens) exceeds the available context size (262144 tokens)
→ summarizing chunk by chunk, then one compaction
```

## Updating from upstream

1. `git fetch upstream`
2. List incoming commits: `git log --reverse --stat $(git merge-base master upstream/main)..upstream/main`
3. Summarize every incoming feature for the user; commits that only touch deleted features can be skipped
4. Get the user's approval before proceeding
   - Features the user chooses to leave out are deleted in the `mi/removals` commit
   - So is anything that brings back removed code or adds npm packages
5. `git rebase -i upstream/main`; the fork commits replay in order, each group labeled by a branch that `rebase.updateRefs` moves along
   - `mi/removals`: the single removal commit
   - `mi/bun`: `migrated to bun`
   - `mi/tooling`: the prettier and package scripts commit
6. Add `exec bun run format && git commit -a --amend --no-edit` right after `mi/tooling`, so upstream code is formatted before the feature commits replay
7. Resolve conflicts
   - modify/delete: keep the deletion
   - Files upstream added to deleted features apply without conflict: `git rm` them, listed by `git diff --name-only --diff-filter=A <old merge-base> upstream/main`
   - Everything else: keep the fork behavior on top of the new upstream code
8. Check
   - `bun run test`, which runs `bun test --parallel` in an isolated HOME, TMPDIR and git config
   - The end to end tests drive mi in tmux against `packages/coding-agent/test/fake-llama-server.ts`, so tmux must be installed
   - The fake llama-server also runs on its own: `bun packages/coding-agent/test/fake-llama-server.ts [port]`, queue replies with `POST /fake/steps`, read what the model received from `GET /fake/requests`
   - `bun run typecheck`
9. Squash later fixes into their fork commit with `git commit --fixup` and `git rebase -i --autosquash`
