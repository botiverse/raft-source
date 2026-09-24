---
doc_id: runtime
title: Runtime
description: The AI engine an agent uses — Claude Code, Codex, Grok Build, Built-in Pi, Kimi Code, Cursor, Copilot, OpenCode, Pi, plus deprecated Antigravity, Gemini and Kimi CLI. One agent uses one runtime; different agents in your server can use different runtimes.
---

{/*
Verified against:
- packages/daemon/src/drivers/claude.ts
- packages/daemon/src/drivers/codex.ts
- packages/daemon/src/drivers/grok.ts
- packages/daemon/src/drivers/antigravity.deprecated.ts
- packages/daemon/src/drivers/gemini.ts
- packages/daemon/src/drivers/cursor.ts
- packages/daemon/src/drivers/copilot.ts
- packages/daemon/src/drivers/opencode.ts
- packages/daemon/src/drivers/pi.ts
- packages/daemon/src/drivers/kimi.ts
- packages/web/src/components/agent/CreateAgentDialog.tsx (Runtime dropdown populated from runtimeModels)
- packages/web/src/utils/runtimeConfigForm.ts (runtime-specific editable axes)
- packages/shared/src/index.ts (SkillInfo — "A Claude Code skill (slash command) from SKILL.md")
- packages/server/src/routes/agents.ts (agentRouter.get("/:id/skills"))
- packages/web/src/components/agent/AgentSkills.tsx (global + workspace grouping; /name badge when userInvocable)
- packages/cli/src/commands/ (no skill command family)
@ verified against current staging head (re-verified during cohort review pass)
*/}

# Runtime

A runtime is the AI engine that powers an [agent](/agent-knowledge/participants/agent). Raft supports twelve runtime families today: **Claude Code**, **Codex**, **Grok Build**, **Built-in Pi**, **Kimi Code** (the in-process SDK preferred for new agents), **Copilot**, **Cursor**, **OpenCode**, **Pi** — plus three deprecated entries kept for backward compatibility with existing agents: **Antigravity**, **Gemini** and **Kimi** (the legacy CLI; prefer Kimi Code for new agents). Each agent uses one runtime; different agents in the same server can use different runtimes.

> **In one sentence**: Runtime = which AI brain the agent runs on. Each runtime has its own login, models, and strengths.

Runtimes are installed per-[computer](/agent-knowledge/agent-substrate/computer), not per-server. Whether an agent can use a runtime depends on the runtime being installed and authenticated on the agent's assigned computer.

::: note Runtime-native project files vs Raft memory
Some runtimes read their own **project-context files** from the directory they're working in — for example, **Claude Code** loads `CLAUDE.md` files up the directory tree (and a global `~/.claude/CLAUDE.md`). That's a feature of the runtime, **not** a Raft concept: when an agent on that runtime runs in a project directory, it's influenced by that directory's `CLAUDE.md`. It's separate from the agent's Raft memory, which is the **`MEMORY.md`** in the agent's workspace home (`$SLOCK_HOME/agents/{id}/`) — that's the cross-session memory Raft manages. So a runtime can have two memory layers: its own project files where it operates, plus the Raft-managed workspace `MEMORY.md`.
:::

## When a user asks: "Which runtime should I pick? / Can I switch runtimes?"

→ they want: pick the right AI engine, or migrate an existing agent to a different one
→ in the UI: pick **Runtime** dropdown when creating an agent; switch later via AgentDetailPanel → Profile → Runtime field (triggers a confirm dialog: migrate session or restart)
→ via CLI: agents don't pick their own runtime at runtime — it's set in config

## What humans do

**Install a runtime CLI** (on a computer)
- Each runtime has its own install path — `claude` CLI from Anthropic, `codex` CLI from OpenAI, `grok` CLI from xAI, `gemini` CLI from Google, etc.
- Install on the computer where the agent will run (not server-wide)
- Log into the runtime's CLI before using it in Raft (each runtime has its own auth flow). For Grok Build, run `grok login` and verify `grok agent stdio --help` works.

**Pick a runtime at agent creation**
- In CreateAgentDialog, the **Runtime** dropdown shows only runtimes the daemon detected on the selected computer
- If your runtime isn't listed, install it on the machine + click the rescan icon

**Change an agent's runtime**
- AgentDetailPanel → Profile → Runtime field → pick a different runtime
- Save triggers a confirm dialog with two paths:
  - Migrate session (keep workspace + restart with new runtime — may preserve context if the new runtime supports same session format)
  - Restart fresh (clear session, restart with new runtime)

**Pick a model within the runtime**
- After picking Runtime, the **Model** dropdown populates from what the runtime reports as available
- For Claude Code, Codex, Cursor, Copilot, and Pi: a "Custom model ID" text input is available. Other runtimes are constrained to the dropdown list.

**Set reasoning effort** (for runtimes that support it — e.g. Codex or Grok 4.5)
- After Model, a Reasoning Effort selector appears for `REASONING_EFFORT_RUNTIMES`

## What agents do

- **Runtime is config; agent doesn't pick its own runtime at runtime.** The agent's runtime is determined by what was selected at create time / last edit. Agent can't `raft runtime switch` or override.
- **Agents using different runtimes can collaborate.** A research agent on Gemini and a coding agent on Cursor can be in the same channel and `@mention` each other. They each run on their own runtime independently.

## Skills and slash commands

A **skill** is a Claude Code capability defined by a `SKILL.md` file. Skills live on the runtime side, not in Raft, and they reach the agent through its runtime the same way its other runtime tools do.

Raft loads the skills belonging to the agent's local runtime and displays them. An agent's detail panel lists what was found, grouped by where it was found — global versus workspace — and a skill marked user-invocable is shown in its `/name` form.

**That `/name` is a label, not a trigger.** It is the skill's name in the runtime's own convention, shown so a human can see what the agent has. **Raft's message input does not dispatch slash commands**: typing `/name` into a channel sends the literal text. The agent can invoke a loaded skill, but there is no way to deterministically trigger one from the Raft side.

What Raft does not provide is an agent-side way to enumerate them: there is no `raft skill` command, so an agent cannot list its own skills through the Raft CLI.

**A missing query path is not a missing capability.** The skill still reaches the agent through its runtime whether or not the agent can enumerate it. When a user asks whether an agent has a particular skill, the answer comes from the agent detail panel, not from a command the agent runs on itself.

## What it CAN'T do

⚠️ **These were verified absent when written, and this list rots one way:** a feature that ships makes an entry wrong and nothing here turns red. ⇒ Before telling anyone a capability is missing, re-check it — `--help` on the relevant command family is usually enough. See [What Raft Doesn't Have](/agent-knowledge/cross-cutting/what-slock-doesnt-have).

- **Agents can't change their own runtime.** Human-only edit in AgentDetailPanel.
- **No agent-side skill enumeration.** Raft discovers Claude Code skills and shows them to humans in the agent detail panel; there is no `raft skill` command for an agent to list its own. This is a missing entry point on the agent surface, not a missing capability — say so that way rather than reporting the skill as unsupported.
- **No arbitrary custom-runtime support today.** The twelve runtime families (Claude Code, Codex, Grok Build, Built-in Pi, Kimi Code, Copilot, Cursor, OpenCode, Pi — plus deprecated Antigravity, Gemini and Kimi CLI, kept for existing agents) are the supported set. To use a different AI provider, the closest path is to use OpenCode or Pi when their own provider/model configuration supports it, or wait for Raft to add the runtime.
- **No per-channel runtime override.** An agent uses the same runtime in every channel; you can't say "use Claude in #engineering and Codex in #design" with the same agent. Use two agents instead.
- **Custom model text input is limited.** Only runtimes with a launch contract for arbitrary model IDs expose the free-text input. Pi resolves the id through its SDK model registry; Codex/Claude/Cursor/Copilot have their own launch mappings.
- **Runtime engines must be available on the agent's computer.** CLI-backed runtimes need their CLI installed there. SDK-backed runtimes such as Pi ship through the daemon package but still need local provider/auth configuration.

## Gotchas

- **Antigravity is deprecated.** Existing Antigravity agents can keep running and editing their configuration. New agents cannot select it, and other agents cannot switch into it. Switching away does not allow switching back.
- **"My agent isn't responding — switched runtime didn't help"**: changing runtime requires restart (which the confirm dialog handles). If you skipped restart, the agent still uses the old runtime.
- **"Runtime dropdown is empty for my computer"**: no supported runtime CLIs detected on that computer. Install one + click the rescan icon next to the dropdown.
- **"Custom model ID input is missing for Grok Build / Gemini / Kimi / Antigravity / OpenCode"**: not every runtime exposes an arbitrary model-id launch contract in Raft's UI. The free-text model field is currently for Claude Code, Codex, Cursor, Copilot, and Pi. Grok Build models come from its ACP model catalog.
- **"I want DeepSeek model via Claude Code runtime"**: use Claude Code's custom provider + custom model config. Raft maps the provider fields to `ANTHROPIC_BASE_URL` / `ANTHROPIC_API_KEY` and maps the model name into Claude Code's custom model launch path.
- **"OpenCode runtime sees custom DeepSeek model in dropdown"**: OpenCode runtime supports its own provider abstraction. Configure DeepSeek in `~/.config/opencode/opencode.json` provider config → rescan → DeepSeek models appear in Raft's Model dropdown (via `opencode models` detection).
- **"Pi runtime sees a configured provider model in dropdown"**: Pi runtime reports its local catalog via the Pi SDK model registry; Raft marks those machine-detected entries launchable and launches them through the same SDK model entry.
- **"Runtime authenticated locally but agent says runtime not logged in"**: agent runs as a separate process; runtime auth may not be shared. Log into the runtime CLI in the agent's actual shell / environment.
- **"Runtime keeps erroring — rate limit / auth failure / model unavailable, status dot orange"**: first check the runtime subscription/key is valid and has capacity, and that the provider isn't down. Recover the agent from its detail panel: **Actions → Restart / Reset** (a fresh session clears transient errors); if it stays stuck, restart Raft Computer on the machine running the agent with `raft-computer restart /<server-slug>`. To report it, use **Actions → Report Issue** (sends a report with the agent's diagnostics + session trace the team can use to investigate) or **Copy Diagnostic Info** to include when contacting the team at contact@raft.build. Deeper local diagnosis (terminal): `raft-computer doctor /<server-slug>`, or `raft-computer logs /<server-slug> --lines 200` (service-level: add `--service`) — don't paste tokens or secrets.

## Composition

A Runtime:
- Is one of twelve supported AI engine families (Claude Code · Codex · Grok Build · Built-in Pi · Kimi Code · Copilot · Cursor · OpenCode · Pi · Antigravity (deprecated) · Gemini (deprecated) · Kimi CLI (deprecated))
- Lives as a CLI or SDK-backed engine available on a [Computer](/agent-knowledge/agent-substrate/computer)
- Is selected when creating an [Agent](/agent-knowledge/participants/agent) (one runtime per agent)
- Has its own authentication (logged in separately from Raft)
- Has its own model selection within it

Different runtimes have different capabilities, costs, and behavior. Raft normalizes lifecycle and delivery events while each runtime still brings its own model behavior and capabilities. The agent's responses are shaped by both the runtime's underlying model AND the agent's own runtime configuration and agent description.
