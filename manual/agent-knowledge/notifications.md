---
doc_id: notifications
title: Notifications
description: How attention reaches you outside the app. Three distinct surfaces — browser push subscription, notification levels (per server and per channel, plus mute, pause and quiet hours), and in-app notification center. Don't conflate them with Inbox.
---

{/*
Verified against:
- packages/server/src/routes/push.ts (/push/vapid-key, /push/subscribe, /push/test, /push/prompt-events)
- packages/server/src/services/pushService.ts
- packages/web/src/features/settings/notifications/NotificationsTabContent.tsx (Settings › Notifications: components/settings/notifications/NotificationSettingsSection.tsx = ThisDeviceCard, PauseAndScheduleCard, ContentCard, ServersCard)
- packages/web/src/i18n/messages/en.ts (`settings.notifications.mainDescription`: push coverage line; `settings.notifications.pause.*`, `quiet.*`, `preview.*`, `sound.*`, `mobileDelay.*`, `servers.*`, `test.send`; `notifications.level.*`)
- docs/contracts/notifications.md §1.1 levels + mute, §1.2 what notifies + quiet + followedThreadReplies (Replies in threads I follow, ContentCard.tsx), §1.3 mobileDelay; packages/server/src/services/notifications/policy.ts, dispatcher.ts, mobileDeferral.ts
- packages/server/src/routes/notificationLevels.ts (server and channel levels)
- packages/server/src/services/systemEventNotificationService.ts, apps/reminder/firedNotification.ts (Raft Desktop notifications: decided by the server, same audience as push; no flag. Reminder App notifications are not in the body: reminder_app is off by default)
- packages/web/src/notifications/desktopNative/notificationGate.ts (Raft Desktop shows nothing while its window is in front and in use)
- packages/web/src/components/settings/notifications/ServersCard.tsx (Servers card: every server's level + customized channels + Reset to Default; CurrentServerNotificationsCard = On {server} › Notifications level row)
- packages/web/src/components/notifications/NotificationLevelMenu.tsx (server: All new messages / Only what involves me / Nothing; channel: All new messages / Only what involves me / Mute), used by ChannelPreferencesSection.tsx and SidebarRowContextMenu.tsx
- packages/server/src/db/schema.ts (serverPushMode on serverMembers: all / mentions / none, default all)
- packages/shared/src/activityMute.ts (which conversations a person can Activity-mute: channels, and a DM with an App)
- packages/web/src/components/message/NotificationActivationBanner.tsx (in-app banner nudge to enable push — the successor surface after OwnerOnboardingModal was removed)
- packages/web/src/components/layout/useSystemNotifications.tsx (what the top-bar bell lists)
- packages/web/src/components/settings/notifications/ThisDeviceCard.tsx (Raft Desktop shows its own desktop-notifications card instead of the web-push buttons) and packages/web/src/features/settings/about/AboutSection.tsx (Mobile app)
- packages/web/src/pages/MobileDownloadChooserPage.tsx (/download); packages/server/src/services/pushService.ts (APNs push for iOS, no flag)
@ verified against current staging head (re-verified during cohort review pass)
@ re-verified against staging 1883339e9 on 2026-10-28 (public-docs audit): bell contents, server-mute helper text, mobile app push, desktop card
Android (FCM) and iOS mobile push are not flagged (the old mobile_push_fcm_v0 flag is retired and its code read was removed).
- packages/server/src/services/notifications/presence.ts (which devices alert: docs/contracts/notifications.md §1.3)
DM mute for a DM with an App is staging behaviour (not flagged); it ships with this manual.
@ re-verified against staging 6bfd74e0fe on 2026-11-03 (manual drift): unified notifications (#12135, #12214, #12218, #12231, #12258, #12264) replaced Mute this server with levels; added pause / quiet hours, phone delay, preview / sound, per-channel level; mute now silences @mentions too
*/}

# Notifications

Notifications is how attention reaches a user **outside the app** — push to the browser, notification levels and mute, in-app notification badge. It's distinct from [Inbox](/agent-knowledge/coordination/inbox), which is the in-app attention aggregation.

> **In one sentence**: Notifications = the way Raft pings you when you're not looking at it; Inbox = what you see when you ARE looking at it.

Three distinct surfaces — agents must not conflate them when answering user questions:

1. **Browser push subscription** — opt-in per-browser web push (what it sends follows your notification levels)
2. **Notification levels** — per server (All new messages / Only what involves me / Nothing) and per channel (All new messages / Only what involves me / Mute), plus account-wide pause and quiet hours (per-user settings, the same on every device)
3. **In-app notification center / bell** (top bar) — account and server alerts: App permission updates, joint-channel invites, usage and plan limits, a Computer offline or needing attention, install prompts, replies to your feedback. Distinct from Inbox attention

## When a user asks: "How do I turn on / off / mute notifications?"

→ they want: configure the push experience
→ in the UI: **Settings** → **Notifications** tab → Enable/Disable Push Notifications (in a browser; Raft Desktop shows its own desktop notification settings there); **Settings** → **On {server}** → **Notifications** → the server's level (All new messages / Only what involves me / Nothing); a channel's own level is in its ⋯ settings or its sidebar menu (**Notifications** ▸)
→ via CLI: agents can't configure a user's **push** settings; humans only. ⚠️ Do not read this as "agents cannot mute anything" — per-channel Activity mute (`raft channel mute` / `unmute`) is an agent command. See below.

## What humans do

**Enable push notifications** (per-browser, opt-in)
- Settings → Notifications tab → click **Enable Push Notifications** (in a browser; in Raft Desktop this tab shows desktop notification settings instead)
- Browser prompts for notification permission → grant
- Status badge shows `Enabled` / `Ready to enable` / `Denied` / `Disabled`
- Coverage, as the UI states it: **"What notifies you follows your levels below; a muted channel or DM doesn't notify you at all."** A muted channel or DM (only a DM with an App can be muted) pushes nothing, @mentions included; they still show in Activity

**Test push**
- Settings → Notifications → **Send Test Notification** — fires a test notification so user can verify it works

**Disable push**
- Settings → Notifications → **Disable Push Notifications**

**Set a server's or a channel's level** (per-account state, the same on web, desktop and mobile)
- A server: Settings → **On {server}** group → **Notifications**, or the **Servers** card on the personal Notifications page (one row per server). Choices: **All new messages** (the default), **Only what involves me** (DMs, @mentions, replies in threads you follow, tasks assigned to you or status changes on tasks you created, are assigned or follow, reminders, agents asking for you), **Nothing** (the old "mute this server": nothing from it notifies, @mentions included)
- A channel: its ⋯ settings sheet or its sidebar right-click menu → **Notifications**: **All new messages** / **Only what involves me** / **Mute**. A channel's own choice beats the server's, so a channel set to All new messages still notifies while its server is at Nothing. A DM with an App has only Mute / Unmute
- The Servers card lists each server's customized channels; **Reset to Default** puts a channel back on the server's level

**Pause and quiet hours** (account-wide, every device)
- Settings → Notifications → **Pause notifications**: for 30 minutes, 1 hour, 2 hours, until tomorrow 9:00, or a custom time; **Resume** ends it early
- **Quiet hours**: a daily start and end time when nothing alerts on any device; badges still update

**Content and phone**
- **Notification preview** (Sender and message / Sender only / Hidden) and **Sound**, on every device
- **While I'm on a computer, notify my phone**: Right away / Once I'm not active on a computer (default) / after 1, 2, 5 or 10 minutes away
- **Replies in threads I follow** (on by default): turn it off and a reply in a thread or task you follow notifies you only when it @mentions you. The thread stays followed and in Activity with its unread count; task status changes and tasks assigned to you still notify

**Mobile app**
- Raft has a mobile app with native push: **Settings** → **About** → **Mobile app**, or the `/download` page. Turn notifications on in the app.

**Raft Desktop**
- Raft Desktop shows system notifications for every server you are in, not just the open one: the same messages as push (your levels, mutes, pause and quiet hours apply), plus task updates on threads you follow, tasks assigned to you, and an agent that needs you.
- It shows nothing while its window is in front and you are using it; notifications resume when you switch away, minimize it, or step away.

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

⚠️ **These were verified absent when written, and this list rots one way:** a feature that ships makes an entry wrong and nothing here turns red. ⇒ Before telling anyone a capability is missing, re-check it — `--help` on the relevant command family is usually enough. See [What Raft Doesn't Have](/agent-knowledge/cross-cutting/what-raft-doesnt-have).

- ⚠️ **Per-channel notification control EXISTS — do not answer "no".** A person sets each channel to **All new messages** / **Only what involves me** / **Mute** (its ⋯ settings or sidebar menu → **Notifications**). Mute stops all notifications from that channel, @mentions included; personal @mentions still show in Activity.
  - An agent mutes a channel for itself with `raft channel mute` / `raft channel unmute`: it suppresses ordinary Activity delivery from that channel while personal @mentions and DMs still reach the agent; threads it follows keep delivering independently. To stop one thread, `raft thread unfollow` removes its follow record and stops its ordinary delivery. Full treatment in [Channel](/agent-knowledge/conversations/channel).
  - **Only a DM with an App can be muted.** A person mutes it from the DM's row menu (sidebar or Activity) or **Mute** in its settings; nothing in it notifies after that, @mentions included. A DM with a person or an ordinary agent cannot be muted, and agents can't mute DMs (the CLI takes a regular channel). **Storage granularity is not a capability** — answer from the surface a user can actually reach.
- **No per-thread mute.** A thread has no level of its own: following it is what notifies, and unfollowing it (or `raft thread unfollow` for an agent) leaves only @mentions of you. To stop alerts from every followed thread at once while keeping them in Activity, turn off **Replies in threads I follow** (Settings → Notifications); @mentions still notify.
- **Web push is per browser.** Enable it separately in each browser; the mobile app and Raft Desktop have their own notification settings.
- **No notification grouping / channel-priority.** All notifications respect the standard browser notification UX.
- **Agents can't trigger custom notifications.** They can `@mention` someone (which triggers push if user enabled) but can't fire arbitrary push.

## Gotchas

- **"I enabled push but I'm not getting notifications"**: check browser permission (`Denied` shows in status). Re-grant via the browser's notification settings.
- **"Test push works but real mentions don't"**: check the message actually triggered a notification-shape (DM / direct mention / followed thread reply — see coverage line). An ordinary channel message without your mention doesn't push only when that channel (or its server) is set to Only what involves me; at the default, All new messages, it does. Also check Pause and Quiet hours.
- **"I stopped getting browser notifications while Raft Desktop is open"** / **"my phone was quiet while I was at my computer"**: by design. A notification alerts only on the devices the person is actively using (keyboard or mouse input within the last 3 minutes; the mobile app in the foreground), so the same message does not ring everywhere. When they use none of them, every device alerts, except that browser notifications yield to Raft Desktop while it is running. For the phone, **While I'm on a computer, notify my phone** (Settings → Notifications) changes this: Right away, or after 1, 2, 5 or 10 minutes away from the computer. The Settings test notification is never skipped.
- **"I set the server to Nothing but I'm still getting notifications"**: a channel with its own level (All new messages or Only what involves me) still notifies; the server's row in the **Servers** card lists those channels, and **Reset to Default** puts one back on the server's level. A security notice (for example, someone asked to reset your two-step verification) always notifies, whatever the level, pause or quiet hours. Otherwise cache or sync lag: hard refresh and check the level is still Nothing. A server at Nothing also stops counting toward the app badge.
- **"I want per-channel mute"**: this exists. A person picks **Mute** (or Only what involves me) under the channel's **Notifications** in its ⋯ settings or sidebar menu; Mute silences its notifications entirely, @mentions included. An agent mutes a channel for itself with `raft channel mute --target "#channel"` (undo with `raft channel unmute`). For a single thread, point them at `raft thread unfollow`.
- **"DM mute"**: only for a DM with an App — right-click its row (sidebar or Activity) → Mute, or Mute in the DM's settings; Unmute undoes it. A DM with a person or an ordinary agent can't be muted. You can hide one from the sidebar (right-click → Close DM), but that is a display action, not a mute, and messages keep arriving. Say it's missing for those DMs rather than pointing at Close DM as if it were the feature.
- **"Why does the in-app bell show different items than my inbox?"**: the bell shows account and server alerts (App permission updates, joint-channel invites, usage and plan limits, Computers offline or needing attention, install prompts); Inbox shows message-attention. Different signal types.

## Composition

Notifications:
- Span three distinct surfaces (push subscription · notification levels, mute, pause and quiet hours · in-app notification bell)
- Are configured per-[Account](/agent-knowledge/participants/account) (settings live in the user's Settings panel)
- Levels are per-account: each server has its own level per user, and a channel's own level beats it
- Push delivery is gated by browser permission AND the effective level (and mute) AND pause / quiet hours AND user enable; only the devices the user is actively using alert (all of them when none is in use; browsers yield to a running Raft Desktop)
- Distinct from [Inbox](/agent-knowledge/coordination/inbox) (in-app attention aggregation)
