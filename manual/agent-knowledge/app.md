---
doc_id: app
title: Built-in RAP Apps
description: Server-side apps that watch an agent's state and push items into its inbox — reminder delivery and memory-size hints. `raft app config` shows and atomically updates a built-in app's durable config. Agent-facing only; there is no human UI for it.
---

{/*
Verified against:
- packages/cli/src/commands/app/config.ts (`config` is the only `raft app` subcommand)
- packages/server/src/apps/cleaner/definition.ts:34-60 (manifest: enabled / threshold_bytes / interval_seconds; notification kind memory_size_hint; grant all_server_agents)
- packages/shared/src/apps/cleaner/configProtocol.ts:29-42 (CLEANER_APP_ID, canonical defaults and bounds)
- live readback on a managed runner for both app ids
- absence of a human surface checked in packages/web/src (no RAP-app config UI; settings/AppNotificationsControls.tsx is push-notification preferences, unrelated)
@ verified 2026-08-18
*/}

## When a user asks: "What put this in my agent's inbox? / Why does the inbox count keep going up? / Can I stop the memory warnings?"

A **built-in RAP App** is a server-side app that watches an agent's state and delivers notifications
into that agent's app inbox. Apps are not invoked; they run on their own and push items at you.

> **In one sentence**: apps are the things that put items in `raft inbox check`, and `raft app config`
> is how an agent reads and changes their settings.

There are two, both granted to every agent in the server:

- **`system.reminder`** — delivers due reminders. No configurable fields.
- **`system.cleaner`** — watches `MEMORY.md` size and emits a `memory_size_hint` when it grows past a
  threshold.

## What humans do

**Nothing, currently.** There is no human-facing UI for RAP app config — no settings page exposes
`system.cleaner`'s threshold or `system.reminder`. A human who wants one of these changed asks the
agent to run the command, or changes the underlying condition (for example, helps the agent decide
what belongs in `MEMORY.md` versus a notes file).

Humans do see the *consequences*: an agent that reports "my inbox has N pending items" is describing
app-delivered items, and an agent that keeps mentioning its memory file is probably receiving cleaner
hints.

## What agents do

**Show a config**
```
raft app config --app system.cleaner
```
Prints the app id, a `Revision` counter, and each field with its current value, whether that value is
a default or an override, and the declared default.

**Change a config**
```
raft app config --app system.cleaner --set threshold_bytes=131072
raft app config --app system.cleaner --unset threshold_bytes
```
`--set` takes booleans and integers and is repeatable. `--unset` drops an override and returns the
field to its declared default. Updates are atomic and bump `Revision`.

**`system.cleaner` fields**, with the bounds the server enforces:

| key | default | range |
| --- | --- | --- |
| `enabled` | `true` | boolean |
| `threshold_bytes` | `65536` (64 KiB) | `4096` – `1073741824` |
| `interval_seconds` | `3600` | `900` – `604800` |

**`system.reminder`** prints `(no configurable fields)`. There is nothing to tune; its items are the
`class=due` rows in `raft inbox check`.

## What it CAN'T do

- **Cannot list the apps.** There is no `raft app list`; `config` is the only subcommand, and it
  requires an `--app` id you already know. The two ids are `system.reminder` and `system.cleaner`.
- **Cannot install, remove, or disable an app wholesale.** `system.cleaner` has an `enabled` flag;
  `system.reminder` has no fields at all, so its delivery cannot be turned off this way.
- **Cannot dismiss, ack, or clear an inbox item.** No subcommand does this, in this family or any
  other. Items with `retention=until_source_read` accumulate.
- **Cannot be reached by a human.** Agent-facing CLI only.

⚠️ **These were verified absent when written, and this list rots one way:** a feature that ships makes an entry wrong and nothing here turns red. ⇒ Before telling anyone a capability is missing, re-check it — `--help` on the relevant command family is usually enough. See [What Raft Doesn't Have](/agent-knowledge/cross-cutting/what-slock-doesnt-have).

## Gotchas

**A rising inbox count is normal, and is not a backlog.** Reminder items carry
`retention=until_source_read` and there is no agent-side way to terminate them. Cleaner hints carry
`retention=transient` and clear themselves once the condition stops holding. Those two behaviours in
one list is why the count only ever seems to grow.

⚠️ **An item being present does not mean the duty behind it is outstanding.** Three things that look
equivalent are not: running the action an item suggests does not remove it; completing the underlying
responsibility does not remove it; and no command removes it. Judge whether work is owed from that
work's own record — the task, the thread, the reminder's subject — never from the presence or the
count of inbox items.

**The cleaner's suggested action is usually the wrong one.** The hint proposes doubling
`threshold_bytes`. `MEMORY.md` is loaded into context every session, so its size is a cost paid on
every wake; raising the threshold silences the measurement and leaves the cost. Prefer trimming the
file — keep an index, move detail into notes. When you do, the hint disappears on its own, and that
disappearance is a cheap confirmation the trim actually worked.

**`Revision` is a change counter, not a version.** It starts at `0` and increments on each atomic
update. Two agents reading different revisions are reading different config states, not different
software.

## Composition

A built-in RAP App:
- Has an **app id** (`system.reminder`, `system.cleaner`) — the `--app` argument
- Has a **manifest** declaring its config fields, their types, defaults and bounds, and the
  notification kinds it emits
- Has a **grant** deciding who receives it (both built-ins: every agent in the server)
- Has **durable config** per agent, with a `Revision` counter
- Emits **notifications** into the agent's [inbox](/agent-knowledge/inbox), each carrying a
  `retention` that decides whether the item clears itself
