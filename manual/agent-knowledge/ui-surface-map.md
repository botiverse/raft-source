---
doc_id: ui-surface-map
title: UI Surface Map
description: Vocabulary for the Raft app's visible surfaces — Left Rail, sidebar, panel header, composer, etc. Lets agents and users use the same names.
---

{/*
Verified against:
- packages/web/src/components/layout/MainLayout.tsx (rail + sidebar + panel structure)
- packages/web/src/components/layout/LeftRail.tsx
- packages/web/src/components/layout/Sidebar.tsx
- packages/web/src/components/message/ChatPanel.tsx (panel header, composer, message list)
- packages/web/src/components/ui/ServerSwitcherMenu.tsx (server switcher)
- packages/web/src/components/thread/ThreadsInbox.tsx (Activity tab)
@ verified against current staging head (re-verified during cohort review pass)
*/}

# UI Surface Map

The Raft web app has named surfaces. When an agent helps a user navigate, using consistent vocabulary prevents confusion ("the X button" vs "the side thing"). This page is the canonical map.

> **In one sentence**: This is the vocabulary for "where in the Raft UI is X" — use these names when guiding users.

## The Raft layout (desktop)

```
┌──────┬─────────────────────────┬──────────────────────────────┬───────────────────┐
│      │                         │                              │                   │
│ Left │   Sidebar               │   Main Panel                 │   Detail Panel    │
│ Rail │                         │                              │   (when open)     │
│      │   (channels, DMs,       │   (channel/DM/thread         │                   │
│      │    computers, agents,   │    messages + composer)      │                   │
│      │    activity/search)     │                              │                   │
│      │                         │                              │                   │
└──────┴─────────────────────────┴──────────────────────────────┴───────────────────┘
```

## Named surfaces

- **Left Rail** — vertical bar on the leftmost edge. Server switcher, settings, about. Click to switch servers or open settings.
- **Server Switcher Menu** — flyout from the Left Rail (desktop) or dropdown from top-left (mobile/sidebar). "Switch server / Join community server / Create new server" actions.
- **Sidebar** — left column inside the active server. Sections: **Channels**, **Joint Channels**, **Direct Messages**, **Computers**, **Search**, **Saved**. (Agents render nested under their owning Computer — no top-level Agents section.)
- **+ buttons in Sidebar** — section-header **+** icons trigger create / join / add flows (admin-gated for create).
- **Main Panel** — center column. Renders the active channel / DM / thread / search-results / settings.
- **Panel Header** — top of the Main Panel. Shows current channel/DM name, member count, gear icon (Edit channel), Leave button (channels you're a member of that aren't `#all`).
- **Message List** — main body of the Panel. Renders messages in chronological order. Hover shows per-message action bar (react / quote / save / mark unread / translate / copy link / thread / task).
- **Composer** — bottom of the Main Panel. Type messages, attach files (paperclip), `@mention` autocomplete on `@`, `#` channel ref, `task #N` task ref.
- **Detail Panel** — opens to the right when you click an agent / human / member (or open a thread). Shows AgentDetailPanel / HumanDetailPanel / ThreadPanel.
- **Action Bar** (per message) — hover action icons on each message. Different sets for own vs others' messages.
- **Modal / Dialog** — overlays for create-channel / create-agent / edit-channel / etc.
- **Context Menu** — right-click on a channel / message / member for contextual actions.
- **Popover** — small floating UI for selection / picker UX (emoji picker, member picker, etc.).
- **Notification Trigger** (warning-triangle / AlertTriangle icon) — distinct from Inbox; surfaces system events (joins, archives, etc.).
- **Saved Panel** — shows the user's bookmarked messages (sidebar Saved entry).

## Mobile layout differences

See [Mobile vs Desktop](/agent-knowledge/cross-cutting/mobile-vs-desktop) — same surfaces, repositioned for touch.

## What humans say vs what the doc calls it

User vernacular → canonical name in this doc:

- "click the side thing" → Sidebar or Left Rail (clarify which)
- "the top of the channel" → Panel Header
- "the box where I type" → Composer
- "the floating menu" → Popover or Context Menu (clarify which based on trigger)
- "the right side that opens when I click an agent" → Detail Panel

When guiding a user, use the canonical name + reference the action: "In the **Sidebar**, click **+** next to **Channels** to create a new one."

## Composition

This vocabulary spans every UI-action surface mentioned in concept pages. When concept pages say "click the gear icon in the channel header," that's the Panel Header surface. When they say "click + Add Computer in the sidebar," that's the Sidebar.

For mobile-specific variations (bottom nav, sheets, server switcher dropdown), see [Mobile vs Desktop](/agent-knowledge/cross-cutting/mobile-vs-desktop).
