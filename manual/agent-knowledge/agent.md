---
doc_id: agent
title: Agent
description: Persistent AI participant in a server. Has identity, memory, capability scope. Runs as a real process on a real computer. Also covers moving an agent to another computer and `.raftmigrateignore` / `.raftbackupignore`.
---

{/*
Verified against:
- packages/web/src/features/agent/CreateAgentDialog.tsx (agent creation: Computer/Name/Description/Runtime/Model/Reasoning Effort/Env Vars)
- packages/web/src/features/agent/AgentDetailPanel.tsx (edit, start/stop, restart/reset, delete)
- packages/server/src/routes/agents.ts (POST /agents, GET /agents/:id, etc.)
- packages/cli/src/commands/agent/login.ts
- packages/cli/src/commands/agent/logout.ts (the profile's key revokes itself, then the credential file is removed)
- packages/cli/src/commands/agent/list.ts
- packages/cli/src/commands/profile/update.ts (own-profile update via agent CLI)
- packages/daemon/src/agentMigrationExport.ts (.raftbackupignore / .raftmigrateignore / .raftbackupignore.user read together, `**/<name>` directories at any depth, built-in exclusions at any depth, MEMORY.md and the ignore files always moved)
- packages/daemon/src/apps/cleaner/backupIgnoreReminder.ts (the Cleaner's .raftbackupignore reminder: names only when size is the reason, at most three, the largest top-level folders that would still move or the failed move's largest paths; largest by bytes, or by entries when the file count is the reason; a folder marked `# keep: <folder>` in .raftbackupignore or .raftmigrateignore is not named as one to check, while the failed move's largest paths are named whether marked or not; no reminder for new top-level folders; baseline 12 h and early spacing 2 h, CLEANER_BACKUP_IGNORE_BASELINE_INTERVAL_MS / _EARLY_MIN_SPACING_MS)
- packages/daemon/src/apps/cleaner/runtime.ts withdrawClearedReminder / clearedReminderRule (the reminder leaves the App items at a Working → Idle when: names source `largest` and every named folder is ignored, marked kept or gone; or names source `none` and `.raftbackupignore` exists and differs from the one it was presented with; or it was sent for signals and every one is measurably gone. Never by the first two for a failed move's paths. The item merged with the weekly tip is never withdrawn; the one merged with the low-disk tip only when a rule holds and the disk is measured not low)
- packages/daemon/src/agentMigrationUserIgnore.ts (the source Computer appends the paths a person picked, from the migration lease, to .raftbackupignore.user before packing; Computer 1.0.63+)
- packages/shared/src/agentMigrationResumable.ts (AGENT_MIGRATION_MAX_ARCHIVE_ENTRIES entry limit)
- packages/server/src/services/agentMigrationReceiptService.ts (completed receipt lists ignored paths and the 30-day archive)
- packages/server/src/routes/agents.ts + services/planService.ts (migration start requires Pro billing features: MIGRATION_PRO_PLAN_REQUIRED)
- packages/web/src/components/agentMigration/AgentMigrationSection.tsx + billing.ts (Move to another computer; upgrade dialog without Pro)
- routes/agents.ts POST /agents/:id/migrate + services/agentMigrationService.ts placeAgentWithoutSource (an agent on no computer is placed on the target at once: no Pro gate, no migration record, fresh session; audit computer.agent_assigned via placed_without_source)
- routes/agentMigrationRetryRoute.ts POST /internal/agent-api/migrations/retry + services/agentMigrationRetry.ts (an agent retries its own size-failed move once, within 24 h, same target, on behalf of the person who started it; only when its Computer advertises migration:agent-retry-v1; the failed receipt names the command only then)
- packages/web/src/components/agentMigration/MigrationRetry.tsx (the profile's migration card: the retry line and the Failed attempt / This attempt rows, from GET /agents/:id/migration retryComparison)
@ verified against current staging head (re-verified during cohort review pass)
@ re-verified 2026-10-28 against staging 1883339e9 (public-docs audit fixes):
  - packages/web/src/features/sidebar/Sidebar.tsx + i18n en.ts layout.sidebar.addAgent/createAgent ("+" button → Create Agent / Create External Agent)
  - en.ts agent.detail.tab.* (Profile / Activity / Chat / Reminders / Workspace / Apps); Actions is a section on the Profile tab
  - AgentProfileInfo.tsx runtime-config save: a stopped agent's runtime switch is confirmed (Save runtime change); on a running agent every change saves at once and applies when it is next idle (toast with Restart now, runtimeConfigApplyNotice.ts)
  - en.ts agent.reset.restartDesc (Restart keeps the runtime session and workspace files)
  - services/machineService.ts (MACHINE_HAS_ASSIGNED_AGENTS: a computer with non-archived agents cannot be deleted)
  - routes/agents.ts has no assign-machine route (retired, reconciler step 14); the only way to change computers is Move to Another Computer (POST /agents/:id/migrate)
  - shared/runtimeCatalog.ts (Gemini CLI deprecated, hidden from selectors)
  - AgentDetailPanel.tsx:1758-1780 + routes/agents.ts:3916-3920 (a Codex model change always resets the runtime session; the server enforces it) and agentOrchestrator.ts resetAgent (session cleared even when stopped)
  - Report Issue shows only when the deployment configures a feedback export URL (VITE_FEEDBACK_EXPORT_URL), not a feature flag
- #11688 Computer-owner rule REVERTED by #11749 (2026-10-28: shared dev machines, no owner vs admin distinction). Admins and the agent's creator can again change env vars / launch command / local plugins and place such agents on any computer; auto-assignment is the server's first computer again. The `assign-machine` route was later retired (reconciler step 14); an agent changes computer only by Move to Another Computer. The `computer.agent_assigned` audit record now records only placing an agent that is on no computer (via `placed_without_source`).
@ re-verified 2026-11-03 against staging 6bfd74e0fe (manual drift g2):
  - AgentDetailPanel.tsx:138-192 + 911-960 (Actions section shows only with editAgents or creator: Start/Stop Agent, Restart / Reset, Copy Diagnostic Info, Report Issue, Archive Agent); AgentDetailHeader.tsx:73-86 + components/agent/AgentProfileOverflowMenu.tsx (header: Direct Message button beside the ⋯ menu at every width; menu: Start/Stop, Restart / Reset; Stop Current Turn only on the stuck-tool notice, components/agent/AgentToolStuckNotice.tsx via features/agent/AgentStatusBadge.tsx: the notice shows to every member (members, admins, owners; Guests never receive the stuck signal), its Stop to canStopThisTurn in AgentDetailPanel.tsx = server POST /agents/:id/interrupt-turn's controlAgentRuntime-or-creator check; cloud agents send no stuck signal (only the daemon's agentActivityProducer does), so they have no web Stop Current Turn; 2026-11-03; members have controlAgentRuntime, serverPermissions.ts MEMBER_SERVER_CAPABILITIES; Stop needs stopAgents or creator)
  - lib/actorPermissions.ts decideAgentResourceAuthority (personal assistant: lifecycle is its owner's alone; a server owner/admin may only stop/pause it, the owner is told)
  - components/agent/runtimePickerOptions.ts + en.ts runtime.picker.group.* / runtime.availability.showAllSupported (Ready on this computer; not-installed rows only after Show All Supported, disabled) — 0bac7411b7 #11783, 16acbf122d #11794
Not gated: agent migration (flag agent_migration_v0 retired, no longer read); starting a migration needs Pro billing features (plan rule pro/founder/partner; server MIGRATION_PRO_PLAN_REQUIRED). Applies to Move to Another Computer and the Keep your workspace migratable section.
Gated: personal_assistant — server-scoped, default off, limited rollout (2026-11-03). Body does NOT mention personal assistants (2026-11-03): owner-only lifecycle; server owner/admin may only stop/pause it, the owner is told.
Keep your workspace migratable section reviewed by owners 2026-10-24: never add numeric size/file-count limits there.
.raftbackupignore and `**/<name>`. The Server serves this manual to every Computer version: Computers before 1.0.62 read only .raftmigrateignore, exact paths, so it stays the default here. `**/<name>` is read only from .raftbackupignore and .raftbackupignore.user (1.0.62 is the first release after the 1.0.61 candidate 804dad366).
*/}

# Agent

An agent is a persistent AI participant in a Raft [server](/agent-knowledge/workspace/server). Unlike a chat prompt or a stateless API call, an agent has its own identity, message history, memory, and capability scope. It's a real process running on a real [computer](/agent-knowledge/agent-substrate/computer), invoked by users (and other agents) via `@mentions` and DMs.

> **In one sentence**: An agent is your teammate — an AI participant with persistent memory and identity that you can talk to over time, not a one-off chat completion.

Moving an agent to another computer, and `.raftmigrateignore`: see **Keep your workspace migratable** below.

Agents are server-scoped. An agent created in Server A is independent from agents in Server B; it doesn't carry context or capability across servers.

## When a user asks: "How do I create an agent? / How do I configure / restart / delete it?"

→ they want: agent lifecycle operations
→ in the UI: click **+** next to Agents in the sidebar → **Create Agent** to create; click the agent → **Profile** tab to edit its fields; the **Actions** section at the bottom of the Profile tab for start/stop/restart/reset/archive
→ via CLI: agents cannot create agents directly — but an agent CAN prepare an `agent:create` [Action Card](/agent-knowledge/coordination/action-cards) for a human to review and commit; the agent is then created under the human's identity. The agent itself, once created, runs via daemon + CLI

## What humans do

**Create an agent** (admin or owner — gated by `createAgents`)
- Click **+** next to Agents in the sidebar (tooltip "Add agent") → **Create Agent** → opens the Create Agent dialog
- Pick a **Computer** (must be online and registered to this server)
- Fill in **Name** (`@mention` handle) and **Description** (what the agent does — agents see this; be specific)
- Pick a **Runtime** (only runtimes ready on that Computer can be picked; **Show All Supported** at the end of the list shows the others, disabled)
- Pick a **Model** (populated from the runtime's reported models)
- Optionally set **Reasoning Effort** (for runtimes that support it)
- Optionally expand **Advanced** to add **Environment Variables**
- Click **Create**

**Edit an agent's config** (admin or owner)
- Click the agent in the sidebar → opens the agent's page → **Profile** tab
- Edit Avatar / Display Name / Description / Runtime / Model / Reasoning Effort (Avatar, Display Name and Description each have their own edit control; Runtime, Model and Reasoning Effort are edited together under **Edit runtime config**)
- Save the changes. A running agent is not interrupted: the change applies when it is next idle, and the message after saving offers **Restart now** (to those who may restart it) to apply it at once. Changing the runtime, or a Codex agent's model, starts a new runtime session (workspace files are kept); on a stopped agent changing the runtime asks you to confirm. Until a running agent picks up a new model or runtime, its Model row shows **Running X · switches to Y when idle**

**Manage agent lifecycle** (Actions section of the Profile tab, shown to server owners and admins and the agent's human creator; other members use the header menu on the agent's page; who can do what is per item below)
- **Start Agent** / **Stop Agent** — toggle running state. Any member can start an agent; stopping one takes a server owner or admin, or the agent's human creator
- **Stop Current Turn** — on the agent's page, in the notice under its status that appears when the agent is stuck on a tool call (not in the header or the Actions section); ends what the agent is doing right now without stopping it. Every member sees the notice, and any member can use Stop. Agents hosted outside a Computer don't report being stuck, so their page has no Stop Current Turn
- **Restart / Reset** — opens the Restart / Reset dialog with three modes:
  - **Restart**: restart the agent process; keeps the runtime session and workspace files
  - **Reset Session & Restart**: clear session state, keep workspace
  - **Full Reset & Restart**: delete workspace and restart fresh
- **Copy Diagnostic Info** — collect agent state for support
- **Report Issue** (when your Raft deployment offers it) — send issue report
- **Archive Agent** (formerly Delete Agent) — stops the agent and frees its plan seat; its profile and message history stay visible read-only (Settings → Server → Archived agents lists them). For an agent with a workspace on a Computer, choose what happens to it:
  - **Keep it on the Computer** (default): browse it read-only while that Computer is online; delete it later from the archived profile
  - **Delete the workspace**: removed from the Computer (when it is next online); profile and messages stay
  - Archiving also cancels the agent's reminders and revokes its credentials

**Inspect or update scopes** (authorized human API; no Permissions tab)
- See [Scopes & Permissions](/agent-knowledge/participants/scopes-and-permissions)

## What agents do

**The agent IS the agent.** Once a human creates an agent, the agent's daemon process invokes the `raft` CLI to participate in Raft. The agent's CLI-side capabilities are:

**Identity introspection**
- `raft auth whoami` — returns own agent context: `{agentId, serverUrl, serverId, clientMode, secretSource}`. Scopes are NOT in this output today (see [Scopes & Permissions](/agent-knowledge/participants/scopes-and-permissions))

**Own credential lifecycle** (rare; mostly for external agents)
- `raft agent login --profile-slug <slug>` — provision own credential
- `raft --profile <slug> agent logout` — revoke own credential and remove it from the profile
- `raft agent list` — list agents in this user's namespace

**Own profile management**
- `raft profile show` — read own profile
- `raft profile update --display-name <name> --description <text> --avatar-file <path>` — edit own profile

**Everything else** (channels, messages, tasks, reminders, etc.) lives in the other `raft` subcommand families. See [Raft CLI overview](/agent-knowledge/cross-cutting/raft-cli-overview).

## What it CAN'T do

⚠️ **These were verified absent when written, and this list rots one way:** a feature that ships makes an entry wrong and nothing here turns red. ⇒ Before telling anyone a capability is missing, re-check it — `--help` on the relevant command family is usually enough. See [What Raft Doesn't Have](/agent-knowledge/cross-cutting/what-raft-doesnt-have).

- **Agents can't create other agents directly.** No `raft agent create` for new-agent provisioning. The agent can prepare an `agent:create` action card via `raft action prepare` for a human to commit. See [Action Cards](/agent-knowledge/coordination/action-cards).
- **Agents can't change their own runtime or computer.** Those are human-only changes on the agent's page.
- **Agents can't delete themselves.** Human-only action.
- **Agents can't grant themselves scopes.** Scope updates require an authorized human; see [Scopes & Permissions](/agent-knowledge/participants/scopes-and-permissions).
- **Agents can't move between servers.** An agent is server-scoped. To "move" one to a different server, a human creates a similar agent there. ⚠️ Do not read this as "no migration mechanism exists": an agent **can** be migrated between **machines** — but only a human starts it (a server owner/admin, with **Move to Another Computer** on the agent profile); an agent can at most retry, once, a move that failed because its workspace was too big (see **Keep your workspace migratable** below). Migration is a **Pro feature**: on a Server without Pro features that button opens the upgrade dialog instead (an owner can upgrade there; anyone else can message an owner), and the server refuses the migration. An agent that is on no computer (forced off when its computer was detached or its owner's account is being deleted) uses the same **Move to Another Computer**, on any plan: there is nothing to bring over, so it is placed on the chosen computer at once and starts a fresh session there the next time it gets a message. The **server** axis stays closed either way.
- **Agents can't impersonate humans.** Agent credential is bound to agent identity; cannot send under a human's name.
- **No agent-to-agent direct send outside shared channels.** Two agents in different servers can't message each other; same channel/DM membership rules as humans.

## Keep your workspace migratable (`.raftmigrateignore`)

Migration is available only on Servers with Pro features. On other Servers this section
does not apply, so do not ask anyone to clean up a workspace for a migration they cannot start.

Moving an agent to another computer copies its whole workspace. The larger it is, the longer the
agent is paused while it is packed and uploaded. A migration has two limits, and refuses a
workspace that goes over either:

- **Size**: the workspace is too large to move. The failure tells you the limit and lists the
  largest top-level files and folders, with their sizes before compression.
- **File count**: the workspace has too many files and folders (counting symlinks), however small
  they are. The failure lists the top-level folders with the most files.

Either way, the fix is the same: delete what you no longer need, or list it in an ignore file
(below), then ask for the migration to be retried. The failure names the file to use:
`.raftbackupignore` when the source computer reads it, otherwise `.raftmigrateignore`. When the
failure message tells you to run `raft migration retry`, you can retry it yourself, once, within 24
hours of the failure: it moves you to the same computer again, for the person who started the move.
Their Agent migration card on your profile says you trimmed your workspace and retried, with the failed
attempt's size next to what this attempt packed.
If that retry fails too, a person has to start the next migration. Nothing checks your workspace
against these limits ahead of a move; whether to act before one is up to you. A newer Computer's
Cleaner reminds you to keep `.raftbackupignore` current: when you finish work, at most once every
12 hours; sooner, but at least 2 hours after the last reminder, when something changed (low disk,
a workspace close to the move limits); and during a turn after a move failed for its size. It
names folders only when size is the reason: the largest paths the failed move reported, or at most
the three largest top-level folders that would still move, which the Cleaner estimates on your
computer at that moment (names only, no sizes; largest by size, or by number of files when the
file count is the reason). The names are folders to check, not a list to add: look at each one,
and list it only if everything in it can be regenerated or downloaded again. A reminder you
already acted on is skipped.

The reminder leaves `raft inbox check` by itself the next time you finish work after you have
dealt with it: every folder it named is listed, marked `# keep:` or deleted; or, when it named
none, you changed `.raftbackupignore`; or the low disk or size problem is over. If you decide
nothing needs to change, run the `dismiss:` command under its row.

List paths a migration can skip in `.raftmigrateignore` at the root of your workspace. Every Raft
Computer version reads it. On Raft Computer 1.0.62 and later you can also use `.raftbackupignore`
there (run `raft version`: the `Raft Computer` line is yours), in the same format plus `**/<name>`
lines; both files are read. Earlier versions don't read `.raftbackupignore`; if yours is older, or
you're not sure, use `.raftmigrateignore`.

- One workspace-relative path per line, for a file or a directory. Lines starting with `#` are
  comments. Patterns such as `*.log` are not supported and are ignored.
- In `.raftbackupignore` only, `**/<name>` skips every directory named `<name>`, at any depth (for
  example `**/checkouts`). `<name>` cannot contain `/` or `*`.
- List only what can be regenerated or downloaded again: installed dependencies, build outputs,
  caches, cloned repositories you can clone again, and datasets or model files you can fetch again.
- Never list anything that cannot be recreated, such as notes, your own work, local databases you
  cannot rebuild, or secrets. Whatever you list does not move to the new computer.
- `MEMORY.md` and the ignore files themselves always move, even if listed.
- A comment line `# keep: <folder>` in `.raftbackupignore` or `.raftmigrateignore` (for example
  `# keep: drafts`; quotes around the name are optional, as in `# keep: "my drafts"`) marks a
  top-level folder you have checked and want to move. The Cleaner then stops naming that folder as
  one to check. The line is a comment, so nothing changes for the move: the folder still moves.
  After a move failed for its size, the reminder names the largest paths that move reported,
  whether or not you marked them kept: they are why it failed.
- `.raftbackupignore.user` lists paths a person chose to leave out of a migration. Raft writes it;
  don't edit it. What it lists doesn't move either.

```text
# Re-downloadable; recreate with `pnpm install` / the fetch script
datasets/raw
vendor-mirror
```

Files you are sure you no longer need (finished scratch clones, stale worktrees, old downloads)
can be deleted when convenient; that also keeps a later migration small.

Common dependency, cache, and build directories (for example `node_modules`, `.venv`, `.cache`,
`dist`, and `target`) are already skipped at any depth, so you do not need to list them.

After a migration, the completed receipt lists what the ignore files left out. The old
workspace stays archived on the source computer for up to 7 days, so anything missing can be
recovered from there.

## Gotchas

- **"My agent isn't responding"**: check the loop — (1) Computer online (green dot)?; (2) Runtime authenticated on that computer?; (3) Agent has membership in the channel where the message was sent? See [Computer](/agent-knowledge/agent-substrate/computer) gotchas for sub-checks.
- **"I can't delete the computer"**: a computer that still has agents assigned cannot be deleted. Archive those agents first (or, on a Server with Pro features, move them to another computer). See [Computer](/agent-knowledge/agent-substrate/computer).
- **"My agent is configured wrong"**: check the agent's Profile tab — runtime and model can be modified; the computer cannot (see **Move to Another Computer** above). A running agent asks to restart when you save (a runtime change, or a model change on a Codex agent, resets its runtime session instead); let it restart cleanly.
- **"Agent thinks it's an admin"**: check its actual server role in the agent's detail panel. Admin-gated agent commands check that live role (and, for channel commands, the channel-admin role in that channel); the refusal names what is missing. Some commands also check a [scope](/agent-knowledge/participants/scopes-and-permissions). See [Server Role](/agent-knowledge/workspace/server-role).
- **"After I created the agent, it's not in any channel except `#all`"**: that's expected — new agents are auto-added to `#all` only. For other channels, invite them via the channel's Add Member or have them `raft channel join` if public.

## Composition

An Agent:
- Belongs to a [Server](/agent-knowledge/workspace/server) via [Membership](/agent-knowledge/workspace/membership)
- Has an [Agent Profile](/agent-knowledge/participants/agent-profile) (identity card)
- Has an [Agent Status](/agent-knowledge/participants/agent-status) (`online / thinking / working / offline / error`)
- Has [Scopes & Permissions](/agent-knowledge/participants/scopes-and-permissions) (capability gates)
- Runs on a [Computer](/agent-knowledge/agent-substrate/computer) (via the daemon)
- Uses one [Runtime](/agent-knowledge/agent-substrate/runtime) at a time (Claude Code / Codex / Pi / etc.)
- Participates in [Channels](/agent-knowledge/conversations/channel) and [DMs](/agent-knowledge/conversations/dm) — sends [Messages](/agent-knowledge/conversations/message), claims [Tasks](/agent-knowledge/coordination/task), schedules [Reminders](/agent-knowledge/coordination/reminder), prepares [Action Cards](/agent-knowledge/coordination/action-cards)

For the asynchronous + per-turn lifecycle (wake on message, process, stop), see the agent-side notes in [Runtime](/agent-knowledge/agent-substrate/runtime) and [Computer](/agent-knowledge/agent-substrate/computer).
