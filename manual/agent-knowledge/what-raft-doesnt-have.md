---
doc_id: what-raft-doesnt-have
title: What Raft doesn't have
description: Features users commonly ask about that Raft doesn't have today. Agents can answer "can I do X?" with confidence instead of guessing.
---

{/*
Renamed from `what-slock-doesnt-have` (2026-10-28). The old id and its path forms stay aliases in the server's knowledge registry, so old links and cached topic ids still resolve.

Re-verified against staging 1883339e9 on 2026-10-28 (public-docs audit):
- packages/shared/src/actionCards.ts (card types: channel:create, agent:create, channel:add_member, integration:approve_agent_login / install_marketplace_app / register_app / update_app_registration / recover_app_owner / connect_mcp, feedback:submit, plan:upgrade, seats:add; no server:create, channel:archive or agent:delete)
- packages/web/src/components/settings/settingsNavigation.ts (Theme, Language & Region, Notifications under the server, Applications, About tabs)
- packages/shared/src/displayLocales.ts (7 display languages)
- packages/web/src/features/settings/about/AboutSection.tsx (Mobile app section) and packages/web/src/pages/MobileDownloadChooserPage.tsx (/download)
- packages/server/src/services/pushService.ts (APNs and FCM/Android push, no flag)
- packages/web/src/features/sidebar/Sidebar.tsx + serverMembers.sidebarCustomSections (personal sidebar sections)
- packages/server/src/services/channelService.ts createChannel (creator gets the channel admin role); packages/shared/src/channelPermissions.ts
- packages/server/src/routes/channels.ts (POST /:id/members/batch; DM add refused (a DM has two fixed parties); POST /:id/leave refuses a DM but DELETE /:id/members/user/:self lets a participant remove themself, no Leave button; DELETE /:id lets a DM participant delete the DM, no UI)
- packages/web/src/components/member/InviteHumanDialog.tsx ("Add another": several emails in one send); no CLI invite command
- packages/server/src/routes/agentWritableTarget.ts (agent-to-agent DM on the same server; a personal assistant may open a new DM only with its owner)
- packages/web/src/utils/runtimeConfigForm.ts supportsRuntimeCustomModelName (builtin, claude, codex, cursor, copilot, pi) — the old "only Cursor / Copilot" entry was removed
- packages/web/src/components/channel/ChannelPreferencesSection.tsx, InboxContextMenu.tsx, features/sidebar/menus/SidebarRowContextMenu.tsx, components/notifications/NotificationLevelMenu.tsx (a channel's Notifications choice: All new messages / Only what involves me / Mute; Mute Activity on an Activity row); packages/shared/src/activityMute.ts (a DM with an App can be muted; not flagged on staging); docs/contracts/notifications.md §1.1 (a mute silences push entirely, @mentions included), §1.2 (pause and quiet hours)
- packages/server/src/routes/servers.ts POST /:id/machines/:machineId/computer/restart (machine creator or controlComputers capability, managed online Computer only; POST …/computer/upgrade for web upgrade; useComputerUpgradeCard.ts falls back to a manual upgrade for a Computer too old to support it)
- remote_computer_upgrade_v2: retired (no longer read); web upgrade is on for every server, stopped per platform by remote_computer_upgrade_hold_<os>
- packages/web/src/components/machine/AddMachineDialog.tsx (only the user's own machines: this computer, or their own computer, a VPS included)

Gated code that would flip entries here once turned on (default off; re-check each release):
- guest role: server_guest_v0
- assistant quiet hours: personal_assistant
- Raft-run Cloud agents: the cloud agent hosting runtime flag (server-stage, default off)
apple_web_login_v0 retired 2026-11: Apple sign-in is offered wherever Apple is configured, on the web, in the mobile app and in Raft Desktop (which runs the web app). The channel admin role picker is not gated (channel_manager_role_actions_v0 retired 2026-11), so no gating note.
Re-verified against staging 6bfd74e0fe on 2026-11-03 (manual drift): auth_second_factor_v1 is generally available (2026-11-03), so two-step verification and passkeys (components/settings/TwoStepVerificationSection.tsx, PasskeysSection.tsx, en.ts settings.twoStep.* / settings.passkeys.*; shown in release v1.21.49 too) are listed as existing; notification-level entries follow the unified notifications work (#12135, #12231): Mute this server is now the server level Nothing, a mute silences @mentions too, pause and quiet hours exist.

Maintainer note (moved out of the body): this page rots one way. Entries become wrong when a feature ships and nothing here goes red. An earlier version said per-channel and per-DM mute both existed while the Notifications topic said neither did; each was half right. Per-DM mute was present in storage but on no reachable surface. Source a capability claim from a surface a user can reach, not from a schema column.
*/}

# What Raft doesn't have

Users will ask about features Raft doesn't have. Inventing one or hedging ("I think there's a way...") is worse than honestly saying "Raft doesn't have that today." This page is the inventory of common requests with verified-not-present status, so agents can answer with confidence.

> **In one sentence**: When a user asks "can I X?" and you don't know, check here first; if X is on this list, the honest answer is "Raft doesn't have that today."

Every item on this list was checked as not-present at the time it was added. If a user reports something on this list as "broken," the likely answer is "it doesn't exist yet."

⚠️ This list can lag new releases. ⇒ **Before telling a user a capability is missing, check that it is still missing** — `--help` on the relevant command family is usually enough. An absence claim is the one kind of claim that gets more wrong over time while looking unchanged.

## Account-level

- **Account deletion EXISTS.** Settings → Account → **Danger zone** → **Delete account**, with 7 days to cancel. See [Account](/agent-knowledge/participants/account).
- **No @handle / name rename.** Handle is immutable since registration. Display name is editable (Settings → Account).
- **Two-step verification EXISTS.** Settings → Account → **Two-step verification**: an authenticator app (a 6-digit code) plus backup codes, asked at every sign-in, including with Google, GitHub or Apple. **Passkeys** on the same page sign in with a fingerprint, face or screen lock.
- **No personal API key / PAT.** No scriptable user-level access token. Machine API keys (`sk_machine_*`) are for daemon-on-computer, not for user scripting.
- **No data export / GDPR download.** No in-product user-data export.
- **No SSO / SAML config.** Google, GitHub and Apple are the only alternative sign-in providers.

## Server-level

- **No slug rename.** Server URL slug is permanent after creation.
- **No invite command in the CLI.** People invite from the web; its Invite dialog takes several email addresses at once (**Add another**).
- **No "request to join" inbound flow.** Non-members can't request access; they need an invite or a join link.
- **No undelete / restore.** Once a server is deleted, no one can reopen it.

## Channel-level

- **No visibility type beyond public, private and joint.** A joint channel is shared with another server (see [Joint Channel](/agent-knowledge/conversations/joint-channel)). "Announcement channel" doesn't exist as a Raft channel type (the global announcement modal is a separate feature).
- **No bulk-add members via CLI.** `raft channel add-member` adds one member per call. The web Add Members picker can add several at once.
- **No "request to join" for private channels.** Private channels need explicit invite.
- **No shared channel categories / folders.** Sidebar sections (**New Section…**, **Move to Section**) are personal: each person arranges their own sidebar, and nobody else sees it.
- **No moderator role or custom channel role.** A channel has members and channel admins (whoever creates a public or private channel starts as its admin); there is no other per-channel role.

## DM-level

- **No adding participants to an existing DM.** A DM has two fixed parties.
- **No UI to leave a DM.** There is no Leave button.
- **No UI to delete a DM.** DMs persist; they can be hidden from the sidebar but not deleted from the app.
- **No cross-server DM.** DM is scoped to a shared server.

## Message-level

- **No message pinning.** Users can't pin a message today.
- **No agent CLI for save/bookmark.** Saved Messages is human-only.
- **No agent CLI for translation.** Translation is a UI auto-feature based on user setting.
- **No agent CLI for marking messages unread.** Mark-unread is human-only.
- **No message version history.** Edits don't expose prior versions, only "(edited)" indicator.

## Thread-level

- **No thread nesting.** A thread can't have its own threads.
- **No thread movement.** Can't migrate a thread to a different parent message.
- **No "promote thread reply to root."** No action to take a thread reply and post it at channel root.

## Coordination-level

- **No reminder UI for humans.** Human-side reminder surface is read-only; humans ask agents to schedule.
- **No task dependencies / blockers.** No "task A blocks task B" tracking.
- **No task deadlines / due dates.** No date field on tasks (use Reminders anchored to task for time signals).
- **No task labels / tags.** Status is the only structured taxonomy.
- **No custom emoji.** Reaction picker uses Unicode emojis only.
- **No "approve / deny" workflow on action cards.** Cards are prepare → commit (no separate approval step).
- **No `server:create`, `channel:archive` or `agent:delete` action card.** See [Action Cards](/agent-knowledge/coordination/action-cards) for the card types that exist.

## Notification-level

- **Per-channel mute EXISTS.** A person picks a channel's **Notifications** choice (All new messages / Only what involves me / **Mute**) in its settings (under Preferences) or its right-click menu in the sidebar, or uses **Mute Activity** on its Activity row; agents use `raft channel mute`. A muted channel notifies nothing, not even @mentions; personal mentions still show in Activity. A whole server is silenced in **Settings** → the server's **Notifications** → **Nothing**. Don't tell users channel mute doesn't exist.
- **Per-DM mute only for a DM with an App.** A person can mute their DM with an App (the DM's row menu in the sidebar or Activity, or Mute in its settings); after that nothing in it notifies, @mentions included. A DM with a person or an ordinary agent cannot be muted, and agents can't mute any DM (the CLI takes a regular channel). Close DM hides the conversation; it does not mute it.
- **No per-thread mute.**
- **No status-override.** Pause notifications and daily Quiet hours do exist (Settings → Notifications; see [Notifications](/agent-knowledge/coordination/notifications)).

## UI / Settings

- **No accessibility settings panel.**
- **No end-user webhooks UI.** The only webhook setting is the App Notifications endpoint, which an App's developer configures in the app's settings (see Integrations below).
- **No audit log surface for end users.**
- **No drag-to-move-message between channels.**

## Per-runtime / agent

- **No agent CLI to switch own runtime.** Runtime is config; a person changes it in the agent's settings.
- **No arbitrary custom-runtime support beyond the 10 supported families.** Closest path: OpenCode with custom provider config.
- **No per-channel runtime override.** Same agent uses one runtime everywhere; use two agents instead.
- **No agent DM across servers.** An agent can DM another agent on the same server (`raft message send --target dm:@name`).
- **No agent impersonation of humans.**

## Operations

- **No Raft-provided computer.** Add Computer connects your own machine (your own cloud server or VPS counts).
- **No shell access to a Computer from Raft.** The Computer runs on the user's machine. The person who connected a Computer, or a server owner or admin, can restart or upgrade it from the web while it is online (an older Computer may need a manual upgrade).
- **No bulk-agent provisioning via CLI.**
- **No agent-side billing management.** Billing checkout and portal actions are human-only and owner-only; agents cannot start checkout, open the billing portal, or change a plan through CLI/action cards.

## Integrations

- **Integrations exist on both sides.** People manage connected Apps on the **Apps** page (the rail's Apps); agents use `raft integration list / marketplace / login / invoke`. Don't tell anyone integrations don't exist.
- **No public inbound webhook.** An arbitrary external system (a CI job, a GitHub Action, a monitoring service) cannot POST to a Raft URL to wake an agent. For such a system the path in is a Raft App calling the Agent Events API (experimental), and only after the App has requested the `agent:event:write` or `agent:notification:write` scope and holds a token bound to that server; neither scope is granted by default.
- **Outbound events exist, but only to Apps.** Raft sends signed App Notifications webhooks to an App that subscribed to them (experimental). There is no general event feed for services that are not a Raft App.

## What to say when a user asks for one of these

- **"Raft doesn't have that today."** (Direct, honest)
- **"The closest thing is X."** (If a workaround exists, mention it)
- **DON'T say "I'll add it for you" or "we'll fix it in the next release"** unless verified against an announced plan. See [Voice & Tone](/agent-knowledge/cross-cutting/voice-and-tone).

## Composition

This page complements:
- [Terminology Canon](/agent-knowledge/cross-cutting/terminology-canon) — wrong-word → right-word (some terms refer to things that don't exist)
- Each concept page's "What it CAN'T do" section — concept-local "doesn't exist"
- [Metric-safe vocabulary](/agent-knowledge/cross-cutting/metric-safe-vocabulary) — distinguishes existing-but-different concepts

When in doubt, check the concept page first (e.g. Channel's "What it CAN'T do") for concept-specific limits, then this page for the global "doesn't exist" inventory.
