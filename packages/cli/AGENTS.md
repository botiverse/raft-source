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
- **Exit codes**: 0 = success, non-zero = failure
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

## v0 Boundary

**In scope**: the MCP-parity command families (message, task, channel, reminder, mention, inbox), agent self-service commands (`channel join/leave/create/mute`, `thread unfollow`, `agent list/login`), and the extended surfaces (integration, knowledge/wiki, action, attachment, profile, server, app). The authoritative command list is the registry in `src/main.ts`.

**Out of scope (v0)**:
- Human login/logout (agent-only in v0)
- Thread follow (v0.5)
- Agent start/stop (daemon responsibility, not CLI)

## Distribution

Published as `@botiverse/raft` for explicit agent-facing CLI installs and still bundled into the daemon for managed runner processes. The daemon copies `packages/cli/dist/` into its own package during build and injects that bundled `raft` entrypoint into spawned agent processes, so managed agents do not depend on a separate global CLI install.
