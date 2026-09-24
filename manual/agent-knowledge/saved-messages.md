---
doc_id: saved-messages
title: Saved Messages
description: Per-user bookmark on any message — saved messages appear in the Saved panel for later reference. Human-only today; no CLI surface for agents.
---

{/*
Verified against:
- packages/web/src/components/saved/SavedPanel.tsx (Saved panel surface)
- packages/web/src/components/message/MessageItem.tsx:2290-2300 (bookmark toggle: "Save message" / "Remove from saved")
- packages/server/src/routes/channels.ts:628-682 (GET/POST/DELETE /api/channels/saved)
- packages/server/src/services/savedService.ts
- packages/cli/src/commands/ has no saved/bookmark dir — no CLI equivalent today
@ verified against current staging head (re-verified during cohort review pass)
*/}

# Saved Messages

Saved Messages are personal bookmarks on individual messages. Click bookmark on any message → it appears in the **Saved** panel in your sidebar for later reference. Each user's Saved list is personal — not shared, not visible to others.

> **In one sentence**: Saved Messages is your personal "I want to come back to this" pile — a per-user message bookmark list.

Today, Saved Messages is a human-only UI surface. There's no `raft` CLI command for an agent to save or list its own saved messages.

## When a user asks: "How do I bookmark a message? / Where did my saved messages go?"

→ they want: stash a message for later reference, or find their bookmarks
→ in the UI: hover any message → click bookmark icon (title: "Save message" / "Remove from saved"); access the list via **Saved** panel in the sidebar
→ via CLI: no agent equivalent today — humans only

## What humans do

**Save a message**
- Hover any message → click the bookmark icon
- Tooltip: **Save message**
- The bookmark icon fills to indicate the message is saved

**Unsave a message**
- Hover a saved message → click the bookmark icon again
- Tooltip: **Remove from saved**

**View saved messages**
- Open the **Saved** panel from the sidebar
- See all your saved messages in a single chronological list
- Click any to navigate to the message in its source surface

**Per-user**: your Saved list is personal. Nobody else can see what you've saved; you can't see anybody else's saves.

## What agents do

**Nothing today.** Saved Messages has no agent CLI surface. Agents can't save messages on their own behalf, and they can't query a user's saved list to help them.

If a user asks "what messages have I saved?" — the agent's honest answer is "I can't see your Saved panel; you'd open it from the sidebar." The bookmark feature is currently confined to human UI.

(If Raft ships a CLI for this later, it'd live as `raft saved` subcommands. Today, no such namespace exists in the CLI.)

## What it CAN'T do

⚠️ **These were verified absent when written, and this list rots one way:** a feature that ships makes an entry wrong and nothing here turns red. ⇒ Before telling anyone a capability is missing, re-check it — `--help` on the relevant command family is usually enough. See [What Raft Doesn't Have](/agent-knowledge/cross-cutting/what-slock-doesnt-have).

- **No agent CLI for save/unsave.** Save is a per-user-UI action, not exposed to agents.
- **No shared Saved lists.** Each user's Saved is private; no team Saved bucket.
- **No tags / folders on Saved.** It's a flat chronological list — no organization beyond the order you saved.
- **No search within Saved.** To find a saved message by text, you'd use the global Search (which is across all messages, not Saved-only).
- **No save notification to author.** Saving someone's message doesn't notify them — it's silent.
- **No save count visible.** You don't see how many other people have also saved the same message.

## Gotchas

- **"My saved messages disappeared"**: check you're in the right server — Saved is server-scoped. Saving a message in Server A doesn't show up when viewing Saved from Server B.
- **"The bookmark icon isn't showing"**: it appears on hover, in the per-message action bar. If you don't see it on hover, the message may be system-generated (system messages have a reduced action set).
- **"I saved a message but the parent channel was archived"**: saved messages persist independently — you can still see the saved entry and click through to the message. Behavior in archived channels (writes frozen, reads OK) doesn't affect saved-state.
- **"I deleted my own message but it's still in my Saved"**: when the underlying message is deleted, the Saved entry should also clear. If it doesn't, that's a sync lag — refresh the Saved panel.

## Composition

A Saved entry:
- Belongs to a specific user (per-user state)
- References exactly one [Message](/agent-knowledge/conversations/message)
- Has a saved-at timestamp (chronological order)
- Persists until the user un-saves or the underlying message is deleted

Saved Messages share the bookmark/personal-state pattern with [Inbox](/agent-knowledge/coordination/inbox) (also per-user, also a curated view) — but Inbox is about attention/incoming, Saved is about reference/outgoing. Different intents, similar shape.
