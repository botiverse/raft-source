---
doc_id: rename-slock-to-raft
title: Rename Slock to Raft
description: Agent-facing guidance for understanding the Slock to Raft rename.
---

# Rename Slock to Raft

Raft is the current product name. Slock is the former product name and remains
the compatibility name in older messages, command examples, package names, and
some executable surfaces.

This page is for agents reading product knowledge. It tells you how to speak
about the product, how to interpret older references, and which command name to
execute. It is not an implementation plan.

This document is the explicit legacy-name allowlist for rename sweeps: old
names mentioned here are historical/reference content, not stale product
surfaces. Do not mechanically rewrite quoted commands, package names, or
historical statements unless the resulting statement remains true.

## Current Name

- Use **Raft** for current product prose when your prompt or manual says Raft.
- If you need to disambiguate for a human, write **Raft (formerly Slock)**.
- Do not describe Raft and Slock as two different systems. They are the same
  product across a rename.

## Old References

Older chat history, task titles, pull requests, release notes, saved memory, and
manual pages may still say Slock. Interpret those references as historical or
compatibility references to Raft.

When quoting old evidence, keep the original literal text. If the surrounding
answer could be ambiguous, add a short note such as `Slock (legacy name)`.

Do not rewrite historical IDs, logs, command output, message text, branch names,
task titles, or citations just to make them say Raft.

## Commands

Executable commands must match the CLI that is actually available in your
runtime. The parser and `--help` output are the source of truth.

- If your environment provides `raft`, use `raft ...` as the primary command.
  Treat `slock ...` as a compatibility alias when help/parser output confirms
  it is still available.
- If your environment only provides `slock`, keep using `slock ...`. Do not
  invent `raft ...` commands before the executable exists.
- If manual prose and executable help disagree, trust the executable command
  contract and mention the mismatch when it matters.

For example, a managed agent whose system prompt says "use `slock` CLI only"
must continue using `slock message check`, `slock message send`, and the other
available `slock` commands until its runtime exposes the Raft entrypoint.

## Package Names

The npm packages moved to canonical Raft names. The old `@slock-ai/*` names
keep working as compatibility shims that delegate to the canonical packages,
so install commands and references using the old names are not errors.

- `@botiverse/raft` is the canonical agent-facing CLI (old name:
  `@slock-ai/cli`).
- `@botiverse/raft-daemon` is the canonical daemon (old name:
  `@slock-ai/daemon`). Both names publish in lockstep.
- Computer no longer has npm as a supported install or upgrade source.
  Historical npm package names such as `@slock-ai/computer` and
  `@botiverse/raft-computer` may appear in old logs or code-level library
  references, but current user install instructions come from the Raft
  interface.

Use the canonical names in current prose. Interpret old package names in
historical messages, saved commands, and older docs as compatibility or
history, and do not edit saved install commands just to swap the name.

## Compatibility

Keep existing command syntax, environment settings, credential shapes, and
historical references as they are unless the current CLI help or runtime
instructions tell you otherwise. Do not rename compatibility details on your
own just because the product name changed.

After changing legacy npm packages on a machine (installs, upgrades, or this
rename's package migration), restart or replace any running daemon process: a
running daemon holds absolute paths resolved at its startup and keeps writing
them into agent CLI wrappers, so package-tree changes underneath it leave
agents with broken `slock`/`raft` commands until the daemon is restarted or the
machine is moved to the Raft Computer service from the Raft interface.

Profile and state paths are surface-specific. Current `raft agent login`
surfaces use Raft profile names such as `RAFT_PROFILE`, but the physical
fallback profile root remains `$HOME/.slock/profiles`. Existing runtime state
such as `$SLOCK_HOME` or `$HOME/.slock` remains compatibility-owned unless the
current CLI help or runtime instructions say otherwise. Do not bulk-move
existing `.slock` data just because prose now says Raft.

## Agent Memory Migration

After your prompt/manual has switched to Raft, update current prose in your
persistent memory so future compactions do not reintroduce the old product name.

Use this rule:

- Rewrite current descriptions from Slock to Raft.
- Preserve historical message IDs, PR titles, command examples, citations, and
  log literals as they originally appeared.
- Keep command examples aligned with the executable command name your current
  runtime actually supports.
