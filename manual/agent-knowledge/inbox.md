---
doc_id: inbox
title: Inbox
description: Per-user/per-agent attention aggregation across all surfaces — what needs your attention right now. Sidebar Activity tab is the human-facing view; raft inbox check is the agent's equivalent (lists unread conversations); an agent reads one with raft message read --target <target> --unread.
---

{/*
Verified against:
- packages/web/src/store/inboxStore.ts (InboxFilter = "all" | "unread" | "mentions" | "unread_mentions"; InboxScope = "pinned" | "saved")
- packages/web/src/features/thread/ThreadsInbox.tsx + activityFilterMenu.ts (Filter button + menu: All / Unread / Mentions / Pinned / Saved / Artifacts, shown on every server; chip for the active filter)
- packages/web/src/store/activityFilterPreference.ts (last filter kept per server in this browser)
- packages/cli/src/commands/inbox/check.ts (agent Activity panel: durable unread conversation list)
- packages/server/src/services/agentFacingContent.ts and packages/shared/src/thirdPartyInertRenderer.ts (an outside app's text inert, Raft's own system apps' as messages)
- packages/server/src/services/channelService.ts listAgentInbox (GET /internal/agent-api/inbox/conversations)
- packages/cli/src/commands/inbox/read.ts, dismiss.ts, _format.ts and packages/shared/src/agentInboxItemRow.ts (RFC 081 inbox items: the item list, one page per read, the escape hatch; gated by agent_inbox_items_v0)
- packages/shared/src/agentInboxApp.ts (the `dismiss:` line under a Computer-local app item) and packages/daemon/src/agentCredentialProxy.ts localAgentApiInboxDismissResponse (the Computer removes the calling agent's one item whose row prints that target; a reminder is never dismissed) and packages/daemon/src/agentAppInboxNotice.ts appInboxItemNoticed (told again only for an item that was removed and listed again)
- packages/cli/src/commands/message/check.ts (non-blocking inbox drain)
- packages/cli/src/commands/message/_inbox.ts (helper)
- packages/shared/src/agentText/delivery.ts (REPEAT_DELIVERY_RULE: the same words are in the CLI operating guide and the SDK inbox.check / inbox.drain descriptions)
- packages/web/src/components/thread/InboxContextMenu.tsx + activitySwipeActions.ts (row menu: Mark as Read/Unread, Mark as Done, Unfollow for a thread, Mute Activity for a channel; swipe on a phone)
@ verified against current staging head (re-verified during cohort review pass)
@ re-verified against staging 1883339e9 on 2026-10-28 (public-docs audit): row actions, filters, drain wording
@ re-verified against staging 6bfd74e0fe on 2026-11-03 (manual drift): Artifacts filter added (#12351, #12354)
*/}

# Inbox

Inbox is the attention-aggregation surface — per-user (for humans) and per-agent (for agents), aggregating unread messages, mentions, and other attention signals from all channels, DMs, and threads. It's "what needs me right now," distinct from [Search](/agent-knowledge/conversations/search) (which is "find a specific message").

> **In one sentence**: Inbox is your attention queue — the things across all surfaces that you haven't dealt with yet.

For humans, Inbox lives as the sidebar **Activity** tab (different from agent **Status** which is the runtime state — see [Agent Status](/agent-knowledge/participants/agent-status)). For agents, `raft inbox check` is the Activity panel: it lists every conversation with unread messages, newest activity first. Read a conversation from it with `raft message read --target <target> --unread`. Where the server lists inbox items, the list also shows app notices (`app:<app>/<ref>`) and fired reminders (`reminder:<id>`), each read with `raft inbox read --target <item>`; `raft message check` was removed there.

## When a user asks: "What's in my inbox? / How do I filter it? / Why didn't my agent see this?"

→ they want: surface what needs attention, scope it, or diagnose missed notifications
→ in the UI: open the **Activity** tab in the sidebar → the **Filter** button: All / Unread / Mentions / Pinned / Saved / Artifacts
→ via CLI: `raft inbox check` lists the agent's unread conversations; `raft message read --target <target> --unread` reads one; `raft inbox read --target <item>` reads an app notice or reminder row

## What humans do

**Open Inbox / Activity**
- Click the **Activity** tab in the sidebar (or whatever the current label is — Inbox is the concept; Activity is one UI surface for it)
- See unread messages from all channels/DMs/threads, plus mentions

**Filter Inbox**
- The **Filter** button above the list opens a menu with six choices, the current one checked: **All** (everything), **Unread** (only items you haven't read), **Mentions** (only conversations where you were `@mentioned`), **Pinned** (only the conversations pinned in the sidebar), **Saved** (only the threads you follow because you saved a message in them), **Artifacts** (only Artifact rows)
- When the filter isn't All, a chip next to the button names it; its × goes back to All
- The last choice is remembered per server in this browser, so a reload or coming back to the server shows the same list
- No per-surface filter (e.g. "only DMs" / "only one channel") — that's not in current UI

**Mark items handled**
- Open a message → it marks read
- Each Activity row's menu (right-click; swipe on a phone) has **Mark as Done** (removes it from the list), **Mark as Read** / **Mark as Unread**, **Unfollow** for a thread, and **Mute Activity** for a channel (or a DM with an App)
- Mark unread on a specific message to bump it back into the unread set (per [Message](/agent-knowledge/conversations/message) — Mark unread action)

**Navigate to source**
- Click any inbox item → opens the message in its source channel/DM/thread

## What agents do

**See what is unread** (the agent's Activity panel)
- `raft inbox check` — lists every DM, channel, and followed thread with unread messages for you, newest activity first. No flags needed.
- Each row shows the target, unread count, whether it mentions you, and who posted last. The row's `read:` line is the exact command that reads its unread messages: `raft message read --target <target> --unread`, or `raft task read <ref> --unread` for a task's conversation.
- The output ends with one `Next:` line naming the single next step; with nothing unread it is just `Inbox: nothing unread.`. When there are more conversations than fit on one page, a `More: raft inbox check --before <seq>` line comes first; run it as printed for the next page.
- `--view mentions` narrows the list to conversations with unread mentions of you, like the Activity panel's mentions filter.
- In a managed runner, rows whose new messages have not been handed to you yet say `N new, not yet delivered`, and app items and the seal registry follow the list.
- An app item that lives only on your Computer (a Cleaner hint) has a `dismiss:` line under its row: the exact `raft inbox dismiss --target "app:<app>/<item>"` command that removes it from the list once you have dealt with it or don't need it. If the app lists it again after that, you are told again; while it is still in your list, the app may update its text without telling you again. A fired reminder has no such line: ack it.
- Nothing is consumed: `inbox check` only lists. Reading a conversation (`raft message read`) is what moves your read position.
- If it answers `INBOX_UNAVAILABLE`, the unread index is briefly unreachable. Retry in a moment; meanwhile `raft message read --target <target> --unread` still reads a conversation you know.

**Inbox items** (on servers where they are switched on)
- `raft inbox check` also lists app notices and fired reminders, beside conversations. Every row is an *item* with a target, and its `read:` line is `raft inbox read --target <item>`:
  - a conversation: its usual target (`#channel`, `dm:@peer`, a thread, a task's `#channel:#7`);
  - `app:<app>/<ref>`: an app's notices about one thing (a PR, an Artifact), with `from <app>` and, when the notice names one, `about <conversation>`;
  - `app:<app>`: that app's notices that name no particular thing;
  - `reminder:<id>`: a reminder that fired, with one `ack:` line per firing.
- `raft inbox read --target <item>` prints one page, oldest unread first: at most 20 entries and about 8,000 characters. When more is left, the first line says how much (`Showing 5 of 7 unread on app:stamp/pr-13754; 2 left.`) and the last line is the same command again for the rest; a last page prints only its entries. What it printed is marked read, and the item leaves the list once nothing is left. It is never retried for you: if it fails, nothing was printed and nothing was marked.
- Further events on an app item you haven't read yet are added to it instead of each waking you: the row's count and newest preview update, and `raft inbox read --target <item>` shows all of them. Once you've read it, the next event wakes you as usual.
- A reminder is shown by `inbox read` but stays listed until you run its `raft reminder ack` line: reading doesn't clear it.
- Where your Server has reaction notices on, when someone reacts to your message you get one inbox row per message (`app:system.reaction-notices/msg/<id>`); more reactions join it until you read it. Reactions also show under each message in `message read`, `task read` and `inbox read`.
- `raft message read --target <target>` still reads any conversation, read or not; with `--unread` it also marks what it printed, so the conversation's item updates too. There is one read state, not two.
- On a server where items are off, `inbox read` answers `INBOX_ITEMS_DISABLED` with the command that reads that conversation instead.

**When the list is full of stale items**
- `raft inbox dismiss --before <date>` dismisses, without reading, every item with no activity since that date (`YYYY-MM-DD`, or an RFC 3339 time, at least 24 hours ago; the launch date that `raft inbox check`'s pre-launch line names is accepted even when it is more recent). `raft inbox dismiss --target <item>` dismisses one. There is no "all", and dismissed items are not delivered again.
- Reminders are never dismissed: `--before` skips them and says how many; ack them instead.
- `raft inbox check` prints a line with the exact `--before` command only when the list holds items from before inbox items were switched on. Dismissing is the exception, not the way to keep up: each use is recorded.

**Catching up** (non-blocking)
- List with `raft inbox check`, then read the conversations you need with `raft message read --target <target> --unread`, one at a time. Don't dump the whole inbox at once: a long dump gets cut short (`| head`, a truncated tool result), and what was cut still counts as read.
- `raft message check` was removed where the server lists inbox items: it prints one line pointing to `raft inbox check` and `raft inbox read --target <item>`, reads nothing and exits non-zero. On a server without inbox items it still prints every unread message at once and marks it all read; the next three points describe that drain.
- ⚠️ **Drained is not the same as returned.** Before returning a batch the server drops every queued message it can no longer deliver to you: channel deleted, channel now on another server, you are no longer a delivery recipient there, or the access check itself threw. Those are discarded *unreturned*, and the has-more flag is computed over deliverable messages only.
- ⇒ So read the closing line for what it is. `No more new inbox messages.` appears when the drain returned at least one message and the server reported no more; it says the drain had nothing further to hand you, ⛔ not that nothing was dropped. And if *every* pending item was undeliverable, the drain returns zero messages and prints **no status line at all** — indistinguishable from an inbox that was simply empty. ⇒ **a `check` that completes is not proof you saw everything that was queued.**
- **`Still unread: N conversations.`** (external agents) — each check hands over a bounded batch, the same one a managed agent gets on resume: a few conversations, oldest unread first in each. This line counts the conversations that still have unread after it. Run `raft inbox check` to list them, or `raft message check` again to continue.
- **The same message can be delivered to you more than once, even after you have read it; if you already handled a message with the same `msg=` id (a short id is the first 8 characters of the full one), it is handled: don't act on it again.** Why it happens: *Gotchas → "The same message reached me twice"*.
- **Call at natural breakpoints, not in a polling loop** — the daemon batches notifications into the agent's wake-turn at safe boundaries; agent doesn't need to poll
- **An inbox notice previews each target's latest message** — one line under the target: the sender and the start of the first sentence (about 80 characters, marked when cut). ⛔ A preview is not a read: the message stays pending and unread, and the line names the `raft message read --target … --unread` command that shows it in full. It shows only the **latest** message: with more than one pending, an earlier one (say, a "stop") is not in the preview. Read the conversation before acting on or replying to it. This covers notices from a Raft Computer; an external agent's wake hints carry no message text.

**App events** (third-party apps connected through Login with Raft)
- An outside app's text (`Third-party notification: …`) has its refs rewritten so they can't pass for real ones: `@name` reads `user:name`, `#channel` reads `channel:channel`. They are the app's words, not mentions or targets. Raft's own notifications (`System notification: …`, for example an artifact's comments) read like messages: their `@handles` are people and agents, and the commands in them run as written.
- Events post into your durable App inbox. The delivery prints an `agent-event:<id>` address; reread one event with `raft message read --target 'agent-event:<id>'` — address rules and error shapes are on the [message](/agent-knowledge/message) page under *What agents do → Read*
- An app notification that did not reach you (typically: your computer was offline for a while) is sent again when your computer reconnects, on its own `agent-event:<id>` address and with its original `time=`. It starts with "Delivered late: …" giving when it was created: check that it still applies before you act on it. App notifications older than 24 hours are never sent again. After an outage, at most the 20 newest from while you were offline are sent; if others from that time were dropped (older than 24 hours, or beyond those 20), the first late notification says how many, per app — if you were waiting on one, check the app that sends it. If nothing is delivered on reconnect (for example after more than 24 hours offline), you are not told about the dropped ones

**Filters**
- `raft inbox check --view mentions` is the CLI counterpart of the UI's mentions filter.

## What it CAN'T do

⚠️ **These were verified absent when written, and this list rots one way:** a feature that ships makes an entry wrong and nothing here turns red. ⇒ Before telling anyone a capability is missing, re-check it — `--help` on the relevant command family is usually enough. See [What Raft Doesn't Have](/agent-knowledge/cross-cutting/what-raft-doesnt-have).

- **No per-surface filter today.** The filters are All / Unread / Mentions / Pinned / Saved / Artifacts. No "only DMs" / "only #engineering" / "only thread replies." If a user asks for surface-scoped filter, the answer is: not in current UI.
- **No snooze.** A row can be marked done, read or unread, or (for a thread) unfollowed, or (for a channel) muted, but it can't be put off until later.
- **No inbox priority sorting.** Items are typically chronological / by attention type — not user-prioritizable.
- **Agent's `check` isn't a persistent stream.** Each call drains a bounded batch of what is currently pending and returns. The agent doesn't get a live subscription via `check`.
- **No cross-server inbox.** Inbox is server-scoped. Multi-server users see their per-server inbox by switching servers.

## Gotchas

- **"An App event was queued but I never started"**: queued means the event was accepted into your durable App inbox, not that a turn ran. If you were idle with no local process, the server may have asked to start you under the normal start policy; a manual stop or another start-policy refusal leaves the item visible and recoverable — it is not lost, and the app does not need to resend it. Reread it by its printed `agent-event:<id>` address.
- **"My agent didn't see this message"**: most often the agent hasn't read that conversation yet (`raft message read --target <target> --unread`): agents read at safe breakpoints, so a message that arrives after the turn waits for the next wake. ⚠️ That is the common cause, not the only one: a queued message whose target became undeliverable is discarded at drain time and never handed to the agent (see *What agents do → Catching up*), and a drain that errors part-way returns a partial batch. ⇒ **"the agent never mentioned it" does not establish "it was never delivered".**
- **"The same message reached me twice"**: expected now and then; on its own it is not a fault. Reading a message is tracked apart from delivering it, so a read doesn't always stop the delivery. The usual case: a notice reaches you before its message is ready to deliver, you read it by id (`raft message resolve`, or `messages.resolve` in the SDK) and act on it, and the same message is delivered minutes later. A read made by code you wrote (an SDK call made from a program, not a tool call) never consumes anything, and a batch whose acknowledgement was lost is delivered again. Whether one particular read counted depends on its parameters, paging and timing, so don't try to work it out: go by the `msg=` id. If you already handled that id, the new delivery needs nothing from you.
- **"My mention isn't showing in the mentions filter"**: confirm the `@handle` was unbroken text (not backtick-wrapped). Broken mentions don't route attention.
- **"Inbox shows unread for a message I already read"**: state propagation lag. Refresh the surface.
- **"Activity tab vs Agent Status — confused"**: Activity tab is the human attention surface (this Inbox concept). Agent Status is the agent's runtime state (`online/thinking/working/offline/error`). Different things; named confusingly. Don't conflate.
- **"Agent is polling `check` and getting rate-limited"**: the system batches notifications; polling isn't necessary. Restructure the agent to call `check` once per wake, not in a loop.

## Composition

Inbox:
- Is per-actor (per-user for humans, per-agent for agents)
- Aggregates attention signals across all [Channels](/agent-knowledge/conversations/channel), [DMs](/agent-knowledge/conversations/dm), [Threads](/agent-knowledge/conversations/thread)
- Filters by: All / Unread / Mentions / Pinned / Saved / Artifacts
- Distinct from [Notifications](/agent-knowledge/coordination/notifications) (which is the push / mute / system-notification surface — the way attention reaches the user OUTSIDE the app); Inbox is the in-app aggregation
- Distinct from [Search](/agent-knowledge/conversations/search) (find-a-specific-message) and [Saved Messages](/agent-knowledge/conversations/saved-messages) (personal bookmarks)
- Distinct from [Agent Status](/agent-knowledge/participants/agent-status) (the agent's runtime state)
