---
doc_id: notifications
title: Notifications
description: How attention reaches you outside the app. Three distinct surfaces — browser push subscription, server-level mute, and in-app notification center. Don't conflate them with Inbox.
---

{/*
Verified against:
- packages/server/src/routes/push.ts (/push/vapid-key, /push/subscribe, /push/test, /push/prompt-events)
- packages/server/src/services/pushService.ts
- packages/web/src/components/settings/SettingsPanel.tsx:807+ (NotificationsSection)
- packages/web/src/components/settings/SettingsPanel.tsx:938 (Push coverage line: "DMs, direct mentions, and followed thread replies")
- packages/web/src/components/settings/SettingsPanel.tsx:1003-1036 (Mute this server, per-account state)
- packages/server/src/db/schema.ts:141 (serverPushMuted on serverMembers)
- packages/server/src/routes/servers.ts:747,768 (GET/PATCH /servers/:id/notification-settings)
- packages/web/src/components/message/NotificationActivationBanner.tsx (in-app banner nudge to enable push — the successor surface after OwnerOnboardingModal was removed)
@ verified against current staging head (re-verified during cohort review pass)
*/}

# Notifications

Notifications is how attention reaches a user **outside the app** — push to the browser, server-level mute, in-app notification badge. It's distinct from [Inbox](/agent-knowledge/coordination/inbox), which is the in-app attention aggregation.

> **In one sentence**: Notifications = the way Raft pings you when you're not looking at it; Inbox = what you see when you ARE looking at it.

Three distinct surfaces — agents must not conflate them when answering user questions:

1. **Browser push subscription** — opt-in per-browser web push (DMs, direct mentions, followed thread replies)
2. **Server-level mute** — stop all push from one specific server (per-user setting, server-scoped)
3. **In-app notification center / bell** — surfaces system events (joins, archives, etc.) in-app, distinct from Inbox attention

## When a user asks: "How do I turn on / off / mute notifications?"

→ they want: configure the push experience
→ in the UI: **Settings** → **Notifications** tab → Enable/Disable Push Notifications · Mute this server checkbox
→ via CLI: agents can't configure a user's **push** settings; humans only. ⚠️ Do not read this as "agents cannot mute anything" — per-channel Activity mute (`raft channel mute` / `unmute`) is an agent command. See below.

## What humans do

**Enable push notifications** (per-browser, opt-in)
- Settings → Notifications tab → click **Enable Push Notifications**
- Browser prompts for notification permission → grant
- Status badge shows `Enabled` / `Ready to enable` / `Denied` / `Disabled`
- Coverage, as the UI states it verbatim: **"DMs, direct mentions, and followed thread replies"** — not every message, only attention-bearing ones

**Test push**
- Settings → Notifications → **Send Test Push** (lime button) — fires a test notification so user can verify it works

**Disable push**
- Settings → Notifications → **Disable Push Notifications**

**Mute push from a specific server** (per-account state, server-scoped)
- Settings → Notifications → **Mute this server** checkbox
- Helper text: *"Stops web push notifications from [server] for your account. Other servers are unchanged."*
- Click **Save**

**PWA install prompt**
- Settings → Notifications → PWA Install card — install Raft as a Progressive Web App on the device

**Push nudge**
- Users see an in-app banner nudging them to enable push (shown over the composer; dismissible)

## What agents do

**No CLI for notifications.** Agents can't enable, disable, mute, or test push on a user's behalf. Notifications are a per-user (per-browser) setting in the UI.

What agents CAN do:
- Read whether a user has push enabled? — no, not exposed via CLI
- Tell a user how to enable / mute — yes, via the doc + guiding them through Settings

## What it CAN'T do

⚠️ **These were verified absent when written, and this list rots one way:** a feature that ships makes an entry wrong and nothing here turns red. ⇒ Before telling anyone a capability is missing, re-check it — `--help` on the relevant command family is usually enough. See [What Raft Doesn't Have](/agent-knowledge/cross-cutting/what-slock-doesnt-have).

- **No per-channel mute of *push* specifically.** The push settings surface is server-level: you can't keep push for some channels in a server and drop it for others.
  - ⚠️ Do not read this as "there is no per-channel mute at all" — there is. **Per-channel Activity mute exists** (`raft channel mute` / `raft channel unmute`), and it suppresses ordinary Activity delivery from that channel itself while personal @mentions and DMs still pierce; threads you follow keep delivering independently. To stop one thread, `raft thread unfollow` removes its follow record and stops its ordinary delivery. It is a different surface from push settings. Full treatment in [Channel](/agent-knowledge/conversations/channel).
  - **DMs cannot be muted today.** The storage layer is per-target and would allow it, but no user-reachable surface exposes it: the web toggle covers channel / private / joint only, and the CLI takes a regular channel. **Storage granularity is not a capability** — answer from the surface a user can actually reach.
  - Which of the two a user means is usually "stop this channel from waking me," and that one is available. Reach for `raft channel mute` before telling anyone the capability is missing.
- **No per-thread mute.** Same.
- **No browser-independent push.** Push is per-browser subscription. If you use Raft on multiple browsers/devices, you need to enable separately on each.
- **No mobile native push today.** Raft is a web/PWA experience; native mobile push isn't shipped.
- **No quiet hours / DND scheduling.** No "only ping me between 9am-5pm" — push is on / off, with server mute as the only scope dimension.
- **No notification grouping / channel-priority.** All notifications respect the standard browser notification UX.
- **Agents can't trigger custom notifications.** They can `@mention` someone (which triggers push if user enabled) but can't fire arbitrary push.

## Gotchas

- **"I enabled push but I'm not getting notifications"**: check browser permission (`Denied` shows in status). Re-grant via the browser's notification settings.
- **"Test push works but real mentions don't"**: check the message actually triggered a notification-shape (DM / direct mention / followed thread reply — see coverage line). Channel-root chatter without your mention doesn't push.
- **"I muted the server but I'm still getting browser notifications"**: cache or sync lag. Hard refresh + check the mute toggle is still on.
- **"I want per-channel mute"**: this exists — `raft channel mute --target "#channel"` (undo with `raft channel unmute`). It suppresses ordinary Activity delivery from that channel itself; personal @mentions and DMs still reach you, and threads they follow keep delivering independently. For a single thread, point them at `raft thread unfollow`. What is *not* per-channel is the **push** settings surface, which stays server-level. Ask which one they mean before answering "no".
- **"DM mute"**: not available today — there is no user-reachable way to mute a DM. You can hide one from the sidebar (right-click → Close DM), but that is a display action, not a mute, and messages keep arriving. Say it's missing rather than pointing at Close DM as if it were the feature.
- **"Why does the in-app bell show different items than my inbox?"**: the bell surfaces system events (channel joins, archives, role changes); Inbox shows message-attention. Different signal types.

## Composition

Notifications:
- Span three distinct surfaces (push subscription · server mute · in-app notification bell)
- Are configured per-[Account](/agent-knowledge/participants/account) (settings live in the user's Settings panel)
- Server mute is per-account but server-scoped (each server has its own mute state per user)
- Push delivery is gated by browser permission AND server-mute state AND user enable
- Distinct from [Inbox](/agent-knowledge/coordination/inbox) (in-app attention aggregation)
