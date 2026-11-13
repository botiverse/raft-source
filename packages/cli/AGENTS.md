# Raft CLI Design Principles

## Positioning

The Raft CLI is an **agent-facing local execution interface**, not a user-facing CLI product. It replaces the MCP chat-bridge as a more direct, composable alternative for daemon-spawned agent processes (Claude Code, Codex, etc.). Humans use the web app or daemon app.

The CLI serves two agent modes (see the `clientMode` contract in `src/client.ts`): **managed-runner**, where the daemon injects a `raft` wrapper via PATH prepend (`cliTransport.ts`) and owns credentials, and **self-hosted-runner**, where `raft agent login` writes a profile credential file and the CLI calls `/internal/agent-api/*` directly. The legacy `slock` alias remains a compatibility entrypoint during the rename window.

The daemon also injects `SLOCK_HOME` into spawned agent processes. The CLI must treat that value as the Raft app-level user-data root when it needs daemon-owned local state. See `rfcs/020-slock-home.md`.

## Core Principles

### 1. CLI is the canonical execution/query layer

The CLI provides a stable entry point for the daemon, external orchestrators, and shell callers. All chat/task/attachment operations go through `raft <resource> <action>`.

### 2. Stable contract first, capabilities second

Lock down the interface contract before adding new commands:

- **Command structure**: `raft <resource> <action> [flags]`, resources are singular nouns
- **Output contract**: Agent-facing commands output MCP-matching canonical text on stdout by default; commands that support `--json` switch stdout to JSON. Errors go to stderr: a labelled text envelope (`Error:`/`Code:`/... block) by default, or a JSON object `{"ok":false,"error":{"code","message",...}}` with `--json` (see `src/core/renderer.ts` `renderError`)
- **Exit codes**: 0 = success, non-zero = failure, except 10: the command paused to ask the agent something and printed how to answer (`cont <id> [choice]`, the daemon's wrapper for the hidden `raft __continue`; `src/commands/continuation/`)
- **Continuation pilot**: while the Server's `continuations_pilot_v0` flag is on for the agent's server (Feature Flag Admin; the CLI reads it from the agent context, `features.continuationsPilot`, only when a send is held, so no restart is needed), a plain text `raft message send` held for unseen messages asks instead of saving a draft (don't send first, as the held text puts sending nothing first; then write a new message, send as it is, and send anyway once the server suggests it), keeping the message in the continuation. Off, unknown (an older Server) or unreadable, it is today's draft flow. `--send-draft`, `--json` and reviewer isolation keep the draft flow; `cont` answers a continuation whatever the flag says (`src/commands/message/_sendContinuation.ts`)
- **Free text never starts a line**: anything a person, an agent or an app can set (a body, a description, a display name, a title, a comment, a filename) is printed through `indentAgentBodyContinuationLines` when it is a block (every line after the first gets `  │ `; a block on its own line gets the prefix on its first line too) or `foldAgentOneLineText` when it is a one-line field (`packages/shared/src/agentMessageText.ts`). A line break in it could otherwise start a column-0 line that a reader takes for a message header (guard: `packages/shared/src/agentText/headerForgery.test.ts`)
- **Object references**: unified grammar — `#channel`, `dm:@peer`, `#channel:shortid`, permalink — accepted directly by `--channel` / `--target` flags
- **Raft refs in prose**: when referencing Raft objects in message text, use bare refs or angle-wrapped refs (`#channel`, `<#channel>`, `<@alice>`, `<task #123>`). Do not wrap refs in backticks unless documenting literal syntax; named links use `[label](<#channel msg=abc12345>)`. Grammar source of truth: `rfcs/018-slock-refs.md`.

### Agent-facing identity reference contract

Agents operate at the AX layer and must not need to know Raft UUIDs for human
or agent identities. Agent-facing surfaces include the `raft` CLI, daemon
prompt/tool documentation, and `/internal/*` routes.

- Human and agent identity references are handles: `@alice` in free-form target
  strings, or `alice` only when a field explicitly documents a typed handle.
- Channel/conversation references use the target DSL: `#channel`, `dm:@peer`,
  `#channel:shortid`, or `dm:@peer:shortid`.
- A human and an agent in one server may share a name (e.g. both called `skyzh`).
  For those names `dm:@skyzh` is ambiguous, so a DM target carries the peer kind:
  `dm:@skyzh~agent` is the agent's DM, `dm:@skyzh~human` is the human's. Other
  names keep the bare `dm:@peer` form.
- The server-side internal boundary is responsible for resolving handles into
  UUIDs and applying server membership, visibility, deleted-agent, and authz
  checks. Daemon/CLI code may parse target syntax, but it must not become the
  authoritative identity handle -> UUID resolver.
- Public web `/api/*` routes may remain UUID-oriented because browser stores
  and pickers already hold the selected entity UUIDs. That is a human UI
  implementation detail, not an agent contract.
- UUIDs are still valid for non-identity resources and anchors: message ids or
  short ids, attachment ids, reminder ids, task numbers, and internal metadata
  after the server has resolved an agent-facing handle.
- Any new agent-facing identity field that requires `userId`, `agentId`, or a
  principal UUID is a contract regression. Accept a handle at the agent-facing
  boundary and freeze the resolved UUID only in internal metadata.
- One scoped exception: an **App Bot** may name a DM `dm:sub:<sub>`, where
  `<sub>` is the `sub` its App received when the person signed in with Raft.
  - Scope: App Bot credentials only (the App-issued `sk_agent_*` key of a Bot
    whose binding, installation, Bot grant and App are live), the message send
    routes (`/internal/agent-api/send`, `/v2/send`), a top-level DM target only
    (no `:<short id>` thread suffix).
  - Why: an App identifies people by the `sub` from login. A handle can be
    renamed, and the App only learns the new one at the person's next login.
    This contract protects LLM agents from UUIDs; Apps are programs that work
    with ids.
  - How: the server resolves `sub` only in `resolveAppSubjectToUserId`
    (`packages/server/src/services/appSubjectService.ts`), then runs the same
    DM path as `dm:@name~human`. Every other caller and every miss (unknown
    sub, not a member, guest, retired account) gets the answer for any target
    the server cannot resolve, byte for byte. Responses keep naming the DM
    `dm:@name`. The prefix is `dm:sub:`, never `dm:user:`: that is the inert
    spelling of `dm:@name` in quoted text and a legacy task-ref alias, so a
    name and a subject never share a prefix.
  - Do not extend it to ordinary agents, other routes or other identity
    fields, and do not teach it in CLI help, the agent manual or prompts. App
    developers find it in [docs/raft-app](../../docs/raft-app/README.md#app-bot-dm-a-person-by-sub).

### 3. Query / mutation semantics are explicit and single-purpose

Each command does one thing. `check` is non-blocking check. `send` is send. Don't smuggle side-effects into a command that reads as something else.

### 4. Agent / automation first, composable and scriptable

- stdout/stderr are machine-readable
- Single-command responsibilities, pipeable
- Designed for shell scripts, supervisors, and external orchestrators to consume

### 5. Don't prematurely expose primitives that change agent behavior

If the daemon already controls agent lifecycle and provides push notifications (stdin), don't expose a blocking `wait` or equivalent that could alter how agents schedule their work. Be conservative — add behavioral primitives only when a real use case demands them (e.g., daemonless mode).

### 6. Interface semantics live in `--help`, not in the system prompt

The system prompt carries only a short command list with one-line descriptions. The CLI's `--help` output is the single source of truth for flags, usage, and semantics. Agents call `raft --help` / `raft <resource> <action> --help` when they need details.

### 7. Build on shared client, don't hand-roll HTTP

CLI commands should use the shared client in `src/client.ts` (it selects the transport from `AgentContext.clientMode`) and helpers from `@botiverse/raft-shared` rather than hand-rolling `/internal/*` requests per command.

Import shared values from `@botiverse/raft-shared/src/agentCliSurface` (add a re-export there from the defining module when you need a new one); only `import type` may use the root `@botiverse/raft-shared`. The root index loads ~80 modules the CLI never uses, and every `raft` call parses whatever the bundle contains. `src/sharedImports.test.ts` enforces this.

### 8. Output tail: only what the next step needs

Agents read every command's output on every turn. After a result, print a line only if it is a fact about this result the agent cannot see in the payload (more pages exist, something was held, who was woken), or the one command the agent most likely runs next when it is not already on screen.

- Never restate rules from the system prompt or `--help` in success output; they stay there and in the Manual.
- Guidance an agent needs once goes through the once-per-context path (glimpse / passive AX, e.g. the channel card), not into every output.
- When there is nothing to do, print nothing about it: no `Next:` line.

## v0 Boundary

**In scope**: the MCP-parity command families (message, task, channel, reminder, mention, inbox), agent self-service commands (`channel join/leave/create/mute`, `thread unfollow`, `agent list/login/logout`), and the extended surfaces (integration, knowledge, action, attachment, profile, server, app). The authoritative command list is the registry in `src/main.ts`.

**Out of scope (v0)**:
- Human login/logout (agent-only in v0)
- Thread follow (v0.5)
- Agent start/stop (daemon responsibility, not CLI)

## Distribution

Published as `@botiverse/raft` for explicit agent-facing CLI installs and still bundled into the daemon for managed runner processes. The daemon copies `packages/cli/dist/` into its own package during build and injects that bundled `raft` entrypoint into spawned agent processes, so managed agents do not depend on a separate global CLI install.

The package also installs `cont` (`dist/cont.js`): `cont <id> [choice]` is `raft __continue`, the answer to a command that paused (exit 10). The daemon writes the same `cont` beside its `raft` wrapper, so an agent answers the same way whether the daemon runs it or it installed the CLI itself.

If a POSIX login shell puts a global CLI ahead of the injected wrapper, the CLI
uses `SLOCK_CLI_TRANSPORT_DIR` together with the exact home/agent/launch projection
to hand the command back to the managed wrapper before parsing or profile auth.
It never searches other agents or copies their credentials. The handoff inherits
stdio, preserves arguments and exit status, forwards SIGINT/SIGTERM/SIGHUP, and
rejects reentry without wrapper credentials. Missing or mismatched managed paths
fail explicitly instead of using a personal profile. Windows global-entry
recovery still requires the injected `.cmd` wrapper; arbitrary arguments are not
passed through a new shell. Outside managed contexts, normal CLI login applies.

The subprocess contracts can be run against a freshly built npm bin with
`RAFT_TEST_CLI_ENTRY=dist/raft.js pnpm exec vitest run src/auth/managedTransport.test.ts`
from this package after `pnpm build` (use `dist/slock.js` to check the legacy bin).

Vitest clears inherited `RAFT_*` and `SLOCK_*` variables before forking workers,
so a managed runner's credentials, state paths, and context-generation signal
cannot affect test fixtures. Tests set their own fixture environment after
startup. The two preserved harness controls are `RAFT_TEST_CLI_ENTRY` (artifact
entry) and `RAFT_CLI_TEST_EVENT_LOG` (execution manifest reporter output).
