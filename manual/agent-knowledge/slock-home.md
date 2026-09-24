---
doc_id: slock-home
title: SLOCK_HOME user-data root
description: The app-level local data root shared by the daemon, the bundled agent CLI and runtime helpers; what lives under it, how to relocate it, and how to run several environments side by side.
aliases:
  - slock-home
  - raft-home
  - daemon/slock-home
  - user-data root
  - local state directory
---

# SLOCK_HOME user-data root

`SLOCK_HOME` is the Slock user-data root: an app-level data directory for Slock-owned local state used by the daemon, bundled agent CLI, and daemon-owned runtime helpers.

It is not a profile root and is not bound to one account, machine, or server. Future profile-like concepts should be layered above this root instead of redefining `SLOCK_HOME`.

If unset, it defaults to:

```text
$HOME/.slock
```

If set, the daemon normalizes it to an absolute path at startup and passes the same value to spawned agent/runtime processes.

## What belongs under SLOCK_HOME

Current canonical Slock-owned stores:

| State | Default path | With `SLOCK_HOME=/tmp/slock-prod` |
|---|---|---|
| Agent workspaces and per-agent wrapper state | `$HOME/.slock/agents` | `/tmp/slock-prod/agents` |
| Machine locks, local daemon traces, and machine-scoped state | `$HOME/.slock/machines` | `/tmp/slock-prod/machines` |
| Chat bridge attachment download cache | `$HOME/.slock/attachments` | `/tmp/slock-prod/attachments` |

Per-agent `.slock` directories remain inside each agent workspace, so they are isolated when `agents/` is isolated by `SLOCK_HOME`.

Future Slock-owned local state, including `raft-computer` state, child daemon registry, downloaded daemon package cache, pid files, sockets, and update metadata, must also derive from `SLOCK_HOME` unless a later contract explicitly defines a separate data root.

## Migration

Default installs require no migration: unset `SLOCK_HOME` continues to use `$HOME/.slock`.

To split an existing install into an explicit environment, move the full root and export `SLOCK_HOME`:

```bash
mv "$HOME/.slock" "$HOME/.slock-prod"
export SLOCK_HOME="$HOME/.slock-prod"
```

If only part of the old root should move, use this mapping:

```bash
mkdir -p "$SLOCK_HOME"
mv "$HOME/.slock/agents" "$SLOCK_HOME/agents"
mv "$HOME/.slock/machines" "$SLOCK_HOME/machines"
mv "$HOME/.slock/attachments" "$SLOCK_HOME/attachments"
```

Phase 0 does not auto-migrate data. When `SLOCK_HOME` points away from `$HOME/.slock`, daemon startup warns if known legacy default-root state still exists.

## Multi-environment example

Use separate roots for prod/staging/play when you need separate app-level user-data roots so credentials, daemon internals, logs, traces, workspaces, and caches do not mix:

```bash
SLOCK_HOME="$HOME/.slock-prod" slock-daemon --server-url https://api.slock.ai --api-key "$PROD_MACHINE_KEY"
SLOCK_HOME="$HOME/.slock-staging" slock-daemon --server-url https://staging-api.slock.ai --api-key "$STAGING_MACHINE_KEY"
```

Optional shell aliases:

```bash
alias slock-prod='SLOCK_HOME=$HOME/.slock-prod slock'
alias slock-staging='SLOCK_HOME=$HOME/.slock-staging slock'
```

`SLOCK_HOME` is a local boundary only. It is not sent as a server-side identity or authorization key.

## raftdev

`./raftdev start <name>` uses `SLOCK_HOME=<repo>/.slockdev/<name>/home` by default and injects it into the spawned dev processes. This keeps local dev daemon state, traces, attachment cache, and agent workspaces out of the user's real `$HOME/.slock`. Ambient `SLOCK_HOME` is ignored by raftdev so agent/runtime shells cannot accidentally override the isolated dev root.

To reproduce against a specific state root:

```bash
SLOCKDEV_HOME=/tmp/repro-slock-home ./raftdev start repro
```

## Not SLOCK_HOME-managed

Vendor runtime configuration and caches such as `$HOME/.codex`, `$HOME/.claude`, `$HOME/.gemini`, `$HOME/.kimi`, or OpenCode XDG directories are owned by those runtimes. Slock may read them for model/session discovery, but they are not daemon-owned Slock state in Phase 0.

Third-party local CLI integrations are a separate layer: do not globally change
agent runtime `HOME` to isolate them. Integrations that need per-agent CLI
credential/profile isolation should declare that need through the optional
agent behavior manifest contract. If a service does
not declare a local credential boundary, Slock must not infer one or redirect
`HOME` on the service's behalf.
