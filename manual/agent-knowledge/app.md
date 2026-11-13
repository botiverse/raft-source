---
doc_id: app
title: Built-in Apps
description: Understand built-in reminders and memory cleanup hints, and configure Cleaner with raft app config.
---

{/*
Verified against:
- packages/cli/src/commands/app/config.ts (view, set, unset, and atomic updates)
- packages/server/src/apps/cleaner/definition.ts (built-in app registration and config fields)
- packages/shared/src/apps/cleaner/configProtocol.ts (canonical defaults, bounds, and disk threshold)
- packages/daemon/src/apps/cleaner/runtime.ts (memory and disk checks, hints presented only at Working → Idle, memory hint with daily rewake cooldown, workspace tip weekly or once per low-disk episode)
- packages/daemon/src/apps/cleaner/definition.ts (memory threshold action and the guidance action on the workspace tip)
- packages/shared/src/agentInboxApp.ts and packages/daemon/src/agentCredentialProxy.ts (a Cleaner item's `dismiss:` line; `raft inbox dismiss --target` removes it on the Computer)
- packages/daemon/src/apps/cleaner/runtime.ts dropCurrentOwnerItem / withdrawClearedReminder (which items the Cleaner removes itself: the memory hint under the threshold, the reminder by its three rules, every item on a config change; never the workspace tip or the weekly "Tidy up" item) and packages/daemon/src/agentAppInboxNotice.ts appInboxItemNoticed (an item updated in place is not announced again; one removed and listed again is)
- packages/daemon/src/agentProcessManager.ts (Working → Idle signal; notices that must not interrupt a turn)
- manual/agent-knowledge/inbox.md (linked inbox guide)
@ verified 2026-10-11 against repository sources; no live runner verification in this update
Re-verified 2026-10-28 against staging 1883339e9 (public-docs audit fixes):
- Reminder App: not documented publicly yet, 2026-10-28 (body mentions removed); gate = reminder_app flag (server-scoped, default off) OR app installed+migrated; refusal reminders_moved_to_app on schedule/update/snooze (external agents get reminders_unsupported_for_external_agents first); a moved reminder answers reminder_migrated and has status/event migrated.
- packages/server/src/services/reminderAppGate.ts + apps/reminder/appMigration.ts (where the Reminder App is active it replaces system.reminder for new reminders)
- packages/cli/src/commands/message/_format.ts ("App items: not available for external agents.")
*/}

## Built-in apps

Built-in apps deliver reminders and cleanup hints to your agent's [inbox](/agent-knowledge/inbox).
Use `raft inbox check` to read them (app items are not available to external agents).

- **`system.reminder`** delivers due reminders. See [Reminder](/agent-knowledge/coordination/reminder).
- **`system.cleaner`** reminds you to tidy up when `MEMORY.md` exceeds its size threshold, and
  occasionally to tidy your workspace files. It also checks whether the disk holding agent data has
  less than 10% (and under 20 GiB) available space. Low disk space is a machine-wide condition, so
  there is no disk warning for agents; it can only prompt one extra workspace tip.

How long a Cleaner item stays in `raft inbox check`:

- The memory hint: until `MEMORY.md` is back within the threshold.
- The `.raftbackupignore` reminder: until the Cleaner takes it back (when, is under
  [Keep your workspace migratable](/agent-knowledge/agent)).
- The workspace tip, and the "Tidy up" item that came with a memory hint: until you dismiss them.
  The Cleaner never takes these back.

You can remove any of them yourself: the `dismiss:` line under the row is the command. While an
item is still in your list, the Cleaner may update its text without telling you again.

## Respond to a memory hint

`MEMORY.md` is loaded into context each session. Keep it concise:

- Remove outdated information, such as superseded decisions, completed task status, and obsolete
  environment details. Check against current sources; old information may still be valid.
- Keep an index in memory and move supporting details or history into notes.

Cleaner provides a reminder; you decide what to keep and what to remove. After `MEMORY.md` falls
within the size threshold, the hint clears on the next check.

The hint is advisory. Cleaner only delivers it right after you finish a piece of work (when you go
from Working to Idle), so it never interrupts a turn. It comes at most once a day while `MEMORY.md`
stays over the threshold, or sooner if the file grows by a quarter or more since the last hint. It
never starts a stopped agent or wakes an agent that has not been working.

## Respond to a workspace tip

At most once a week the memory hint comes with a separate workspace tip, and low disk space can
add one more. Cleaner does not pick files for you; at most it names your largest top-level folders
(see [Keep your workspace migratable](/agent-knowledge/agent)). When you have time:

- Delete workspace files you are sure you no longer need, such as stale worktrees, old build
  outputs, or temporary downloads.
- List the files you are unsure about and ask your owner or creator before deleting them. Ask only
  when the list has files you have not asked about before.
- Keep [`.raftmigrateignore`](/agent-knowledge/agent) up to date.

The hint's suggested command raises the size threshold, usually by doubling it. Use that when the
larger memory file is intentional; otherwise, trim the file first.

## Configure Cleaner

Run these commands in the agent's environment. Settings apply to that agent. `enabled` and
`interval_seconds` control both checks; `threshold_bytes` controls only the memory check.
The disk threshold is fixed: less than 10% and less than 20 GiB available.

View the current settings:

```sh
raft app config --app system.cleaner
```

| Setting | Default | Allowed values |
| --- | --- | --- |
| `enabled` | `true` | `true` or `false` |
| `threshold_bytes` | `65536` (64 KiB) | `4096`–`1073741824` bytes |
| `interval_seconds` | `3600` (1 hour) | `900`–`604800` seconds |

For example, set the size threshold to 128 KiB:

```sh
raft app config --app system.cleaner --set threshold_bytes=131072
```

Restore the default threshold:

```sh
raft app config --app system.cleaner --unset threshold_bytes
```

Turn Cleaner off or back on:

```sh
raft app config --app system.cleaner --set enabled=false
raft app config --app system.cleaner --set enabled=true
```

`--set` and `--unset` can each be repeated to change several settings in one command. The output
shows current values and whether each is a default or an override. `Revision` counts configuration
changes.

`system.reminder` has no configurable settings. See the [inbox guide](/agent-knowledge/inbox) for
handling its reminders.
