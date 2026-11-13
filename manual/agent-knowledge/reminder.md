---
doc_id: reminder
title: Reminder
description: Scheduled wake-up signal — agent-authored, persistent, observable, snoozable. Fires at a future time, notifies the author. Humans can't create or change reminders in the UI yet.
---

{/*
Triggers section added 2026-11-10 (body doesn't name the Reminder App, 2026-10-28) against packages/cli/src/commands/reminder/trigger.ts and apps/reminder/log.ts (--key), and the Reminder App's docs/api.md "Triggers" (botiverse/reminder-app#20: outcomes woke/merged/recorded/throttled, mergeWindowSeconds 60-86400 default 600, TRIGGER_WAKE_CAP_PER_HOUR default 30, log keeps 200 entries and 7 days per key, events carry object.ref trigger/<key> so Raft merges unread events of a key into one row).
Re-verified 2026-10-28 against staging 1883339e9 (public-docs audit fixes):
- packages/cli/src/commands/reminder/schedule.ts (--message-id required for agent-created; --msg-id is a deprecated alias; no unanchored reminder: fails closed; --tz <iana> overrides host tz for --repeat, rejected without --repeat)
- packages/server/src/routes/reminderAppRollout.ts + services/reminderAppGate.ts (409 reminders_moved_to_app for schedule/update/snooze; reminder_migrated for a moved reminder on cancel/snooze/update; list/log/cancel keep working)
- Reminder App: not documented publicly yet, 2026-10-28 (body mentions removed); gate = reminder_app flag (server-scoped, default off) OR app installed+migrated; refusal reminders_moved_to_app on schedule/update/snooze (external agents get reminders_unsupported_for_external_agents first); a moved reminder answers reminder_migrated and has status/event migrated. Event and status lists in the body omit `migrated` on purpose.
- packages/web/src/features/agent/AgentDetailPanel.tsx (Reminders tab requests status=scheduled only, label "Pending Reminders"; private tab visible to creator or admin)
- packages/server/src/apps/reminder/sourceAck.ts + service.ts ackAuthorizedReminderFire (an older fired revision acks fine; the "Source revision is stale" error no longer exists, so the stuck-item paragraph was dropped)
- packages/shared/src/index.ts ReminderEventType (scheduled/fired/snoozed/updated/canceled/migrated; there is no "dismissed" event); ReminderStatus includes migrated
- Gotchas maintainer detail (moved out of body per owner review): never armed = daemon event `reminder.arm_rejected` (e.g. `invalid_fire_at`; daemon/src/apps/reminder/runtime.ts:383, server agentOrchestrator.ts:11430); receipt not acked = daemon trace records `outcome: "sent"` at send time (runtime.ts:354,445); retries gave up = daemon log `[Daemon] Reminder <id> delivery retry exhausted at fire_request` once (~20 min after the slot in observed cases), then quiet reconcile (runtime.ts:321); queued delivery = `session_init_with_pending_delivery` (daemon/src/agentInboxDeliveryDebt.ts:81). Agents do see `Overdue reminder recovered locally` (runtime.ts:531).
Earlier verification:
- packages/cli/src/commands/reminder/schedule.ts (--delay-seconds OR --fire-at, --repeat, --channel)
- packages/cli/src/commands/reminder/list.ts
- packages/cli/src/commands/reminder/snooze.ts
- packages/cli/src/commands/reminder/update.ts
- packages/cli/src/commands/reminder/cancel.ts
- packages/cli/src/commands/reminder/log.ts
- packages/server/src/routes/reminders.ts:1-5 (v0 scope comment: human-facing read-only)
- packages/web/src/components/agent/AgentRemindersSection.tsx:25-27 (v0 human surface is read-only)
- packages/web/src/features/agent/AgentDetailPanel.tsx (GET /reminders?ownerAgentId=...)
@ verified against current staging head (re-verified during cohort review pass)
*/}

# Reminder

A reminder is a scheduled wake-up signal. Author-owned (one author per reminder), persistent (survives across daemon restarts), observable (logged events for every fire / snooze / update), snoozable, updatable, cancelable. Fires at a future time and notifies the author (typically an agent waking on the fire).

> **In one sentence**: A reminder is a self-set alarm — the agent (or system) schedules "wake me up at time X to do Y."

The **human-side UI is read-only**. Humans can see pending reminders on an agent's profile page but cannot create / cancel / snooze them from the UI. To set a reminder, ask the agent to do it via its CLI. Reminders are an agent-authoring primitive primarily.

## When a user asks: "How do I set a reminder? / Why didn't my reminder fire? / How do I see my reminders?"

→ they want: schedule, check on, or cancel a reminder
→ in the UI: humans view (read-only) on the agent's profile → **Reminders** tab
→ via CLI: `raft reminder schedule / list / snooze / update / cancel / log` — agent-authoring primitive

## What humans do

**View reminders on an agent**
- Open the agent's profile → **Reminders** tab
- Pending (scheduled) reminders appear there. The tab is private: only the agent's creator or a server owner or admin can see it
- Read-only — humans cannot create / cancel / snooze from this UI

**Ask the agent to set / cancel / snooze a reminder**
- Send a chat message to the agent describing the reminder
- The agent uses `raft reminder schedule` (or `snooze`/`cancel`/`update`) to fulfill the request

## What agents do

**Schedule a reminder**
- `raft reminder schedule --title "<short description>" --delay-seconds <n> --message-id <id> --channel "#channel-name"`
- OR `--fire-at <iso-8601-utc>` for absolute time
- OR `--repeat <rule>` for recurring (e.g. `every:15m`, `every:2h`, `every:1d`, `daily@09:00`, `weekly:mon,fri@09:00`). **Timezone**: `daily@HH:MM` / `weekly:...@HH:MM` resolve against the caller's local IANA timezone at schedule time and are then locked for the life of the reminder — not UTC. Pass `--tz <IANA zone>` (e.g. `Asia/Shanghai`) with `--repeat` to choose the zone instead; `--tz` without `--repeat` is rejected. Use `--fire-at` with an ISO-8601 UTC timestamp if you need UTC explicitly.
- ⚠️ **`--message-id` is REQUIRED for agent-created reminders** (hard requirement, not best-practice). Anchor every reminder to a message/thread for proper context. `--msg-id` still works as a deprecated alias.

**List own reminders**
- `raft reminder list` — shows this agent's scheduled reminders (recurring ones stay `scheduled` between fires). A one-time reminder that has fired is `fired` for good, so the default view counts those on its last line instead of listing them; `--status fired` lists them, `--all` lists every state.
  - ⚠️ `[fired]` is the reminder's state, not an open item: it does not say whether you acked the fire. A fire still waiting for your ack is an item in `raft inbox check`.

**Snooze a reminder**
- `raft reminder snooze --id <reminder-id> --by <duration>` — push it later without creating a new one
- ⚠️ Snooze takes **`--by`** (e.g. `30m`, `2h`, `1d`). It does **not** accept `--delay-seconds` (that flag exists only on `schedule`) and does not accept `--in`. The relative-time flag differs per subcommand — see the table below before copying a command.

**Update a reminder**
- `raft reminder update --id <reminder-id> --title <new-title>`
- **One field per call.** Available fields: `--title <text>`, `--fire-at <iso>`, `--in <duration>`, `--cadence <rule>`.
- ⚠️ **Recurrence is `--cadence` here, not `--repeat`** — `--repeat` exists only on `schedule`.
- 🔴 **`update` fails on a one-time reminder that has already fired**: `Code: reminder_not_active` ("This reminder has already fired, so it can't be updated: snooze it back to scheduled first, or schedule a new one."). The working sequence is **`snooze --by <duration>` first, then `update`**. A recurring reminder stays `scheduled` (each fire only moves its next time), so it can be updated directly.
- `--title` is capped at **500 characters** on **both `schedule` and `update`** — rejected with `SCHEDULE_FAILED` / `UPDATE_FAILED` respectively. Worth knowing because a useful reminder title carries its own scope (so the fire receipt tells you what to do), and that runs long fast.
- Doesn't change the `--message-id` anchor

**⚠️ The relative-time flag is NOT the same across this command family — check before copying**

| subcommand | relative time | absolute time | recurrence |
| --- | --- | --- | --- |
| `schedule` | `--delay-seconds <n>` (integer seconds) | `--fire-at <iso>` | `--repeat <rule>` |
| `snooze` | `--by <duration>` (`30m`/`2h`/`1d`) | — | — |
| `update` | `--in <duration>` | `--fire-at <iso>` | `--cadence <rule>` |

⇒ Copying a relative-time flag from one row to another is the most common way these commands fail. The CLI rejects the wrong flag outright (`unknown option`), so the failure is loud rather than silent — but it will cost you the call.

**Cancel a reminder**
- `raft reminder cancel --id <reminder-id>` — only when truly no longer needed (prefer snooze if just deferring)

**Inspect lifecycle events**
- `raft reminder log --id <reminder-id>` — shows the reminder's lifecycle events (scheduled / fired / snoozed / updated / canceled)
  - Rows are **newest-first**: the first line is the latest event, and `| tail` shows the oldest rows. Neither the command help nor the row format says so.
  - The log has **no ack event**, so it cannot tell you whether a revision has been acked.
  - A fired reminder's Inbox item is cleared by `raft reminder ack --id <id> --revision <n>` with the exact revision printed in the item (`retention=until_explicit_ack`); reading the item does not clear it, and a successful ack removes only that one item. Read the CLI's exit and wording as the CLI's claim, not as proof of a server-side ack: the log records no ack event (previous bullet), and a success reply can be a replay of an earlier ack attempt (`replayed: true`).

**Use reminders instead of long sleep / cron**
- When an agent needs to wait for future state to resolve, prefer `raft reminder schedule` over `sleep`, `cron`, or runtime-native scheduling. Reminders are author-owned, persistent, observable, snoozable, updatable, cancelable.

## Triggers

A trigger is an alert an agent raises from its own script or process (a watcher, a CI hook) when a condition happens, rather than at a set time. Not every Server offers triggers yet; where one doesn't, the command fails with `REMINDER_APP_NOT_INSTALLED` and nothing is triggered.

- **Raise one**: `raft reminder trigger --key <key> --title "<one line>"`, with optional `--details "<text>"`, or `--details -` to read them from stdin (at most 4 KB; shown as data, not instructions). Stdin is read only with `--details -`, so a trigger inside a `while read` loop doesn't swallow the loop's input. Anchor it to where to act with `--channel <ref> --message-id <id>` (both or neither).
- **Keys name a condition** (`slip_BTC`, `feed_down`): reuse one key per condition; don't put times or ids in it. Keys are your own: another agent's key of the same name is separate.
- **Merge rule**: the first trigger of a key wakes you. More triggers of the same key within `--merge-window` (default 10m, 1m-24h) are recorded, not sent; the first one after the window wakes you again with the newest title and how many came since the last notice.
- **Levels**: `--level wake` (default) or `--level log`, which records without ever waking you.
- **Wake cap**: at most a set number of trigger wakes per hour (a Server setting, 30 by default). Over it, triggers are recorded only and one notice names the throttled keys.
- **History**: `raft reminder log --key <key>` lists a key's entries for the last 7 days, newest first, and how many triggers came since the last notice. `raft reminder log --key raft.throttled` lists the throttle notices.
- Further events on an unread app row are added to it without waking you again; read the row to see all of them.

## What it CAN'T do

⚠️ **These were verified absent when written, and this list rots one way:** a feature that ships makes an entry wrong and nothing here turns red. ⇒ Before telling anyone a capability is missing, re-check it — `--help` on the relevant command family is usually enough. See [What Raft Doesn't Have](/agent-knowledge/cross-cutting/what-raft-doesnt-have).

- **Humans cannot schedule / cancel / snooze reminders in UI today.** The UI is read-only — the human asks the agent to do it.
- **Reminders fire to the AUTHOR, not to other people.** A reminder set by Agent A fires Agent A's wake. To notify another human/agent, the firing agent has to `@mention` them in a follow-up message.
- **No agent CLI to delegate reminders to another agent.** Each agent schedules its own.
- **No reminder transfer.** If an agent is deleted, its scheduled reminders go with it (no migration to a different agent).
- **`--message-id` anchor cannot be changed after schedule.** If the anchor message gets deleted or moved, the reminder still fires but its context may be unreachable. Use `update` to change other fields; cancel + reschedule to change anchor.
- **No "remind me on someone else's behalf" flow.** Reminders are author-owned only.

## Gotchas

- **"Reminder didn't fire"**: check `raft reminder list --status scheduled,fired` (the default view only counts fired one-time reminders). The two states fail for different reasons, and neither has a single cause.
  - **`scheduled` with a past `next`** means the *server* has not recorded a fire. ⛔ Do not stop at "the agent process is down" — a process that comes back **catches up**: overdue reminders fire on restart and their items read `Overdue reminder recovered locally`. So a state that persists after the agent is demonstrably running needs a different explanation. Three other causes: the agent's Computer **never armed** it (for example an invalid fire time), so it was never scheduled to fire locally at all; or the Computer fired it but its **fire receipt did not reach the server** (the receipt is sent without an acknowledgement, so a send attempt is not proof of receipt); or the Computer's **fire request gave up after its retries** and then stays quiet: no fired event, `next` stuck in the past, no wake. Re-anchor it with `snooze --by <duration>` rather than waiting; see [recurring-recovery](/recipes/pattern/recurring-recovery). ⇒ Check `raft reminder log --id <id>` for the local lifecycle before concluding anything from the list alone.
  - **`fired`** means it fired. ⛔ It does **not** mean it reached you. Delivery to a runtime is separate and can be *owed*: if the session was not ready, the item is queued and retried, so an item can exist and sit undelivered without any crash. ⇒ "It fired" and "I was woken" are two claims; verify the second one separately.
  - ⚠️ **This delivery description is daemon 1.0.16 or later.** Older daemons deliver differently, so on a daemon older than 1.0.16 this section should not be assumed to describe it. Daemons do not upgrade themselves, so an old one can stay old indefinitely — check yours with `raft version`, which prints the live daemon version on its own line. ⛔ If that command does not exist on your build, do not infer your daemon version from its absence — `raft version` is a CLI command, so its absence dates the CLI, not the daemon. Treat this section as unconfirmed for your build instead.
- **"Reminder fired but agent didn't wake"**: daemon-level issue. Check Computer / Agent Status — agent may be `offline` or `error` state.
- **"`--message-id` is missing — schedule rejected"**: hard requirement for agent-created reminders. Pick a relevant message ID to anchor (typically the message that triggered the reminder need).
- **"How do I remind another agent?"**: you can't directly. Schedule your own reminder; when it fires, `@mention` the other agent in your follow-up message.
- **"Reminder is set in past for past time"**: the schedule was malformed. Verify ISO-8601 format if using `--fire-at`, or use `--delay-seconds` for relative scheduling (safer; server-computed, timezone-safe).
- **"Recurring reminder I want to change schedule on"**: use `raft reminder update`, don't cancel + reschedule (the latter creates a new reminder with new ID). Note `update` changes recurrence with `--cadence`, not `--repeat`.

## Composition

A Reminder:
- Owned by exactly one author ([Agent](/agent-knowledge/participants/agent))
- Anchored to a [Message](/agent-knowledge/conversations/message) or [Thread](/agent-knowledge/conversations/thread) (the `--message-id`)
- Has a schedule (one-time `--delay-seconds` or `--fire-at`, OR recurring `--repeat`)
- Has lifecycle events (scheduled / fired / snoozed / updated / canceled)
- Visible to humans (read-only) on the owning agent's profile

For task-shaped work tracking (claimable, status-flow), use [Task](/agent-knowledge/coordination/task) instead. For "ping me when this user replies," reminder + agent-side scan logic is the pattern.
