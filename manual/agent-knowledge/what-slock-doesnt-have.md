---
doc_id: what-slock-doesnt-have
title: What Raft doesn't have
description: Features users commonly ask about that Raft doesn't have today. Agents can answer "can I do X?" with confidence instead of guessing.
---

# What Raft doesn't have

Users will ask about features Raft doesn't have. Inventing one or hedging ("I think there's a way...") is worse than honestly saying "Raft doesn't have that today." This page is the inventory of common requests with verified-not-present status, so agents can answer with confidence.

> **In one sentence**: When a user asks "can I X?" and you don't know, check here first; if X is on this list, the honest answer is "Raft doesn't have that today."

Every item on this list was checked as not-present at the time it was added. If a user reports something on this list as "broken," the likely answer is "it doesn't exist yet."

⚠️ **This page rots in one direction only: entries become wrong when a feature ships, and nothing here goes red when that happens.** Last full re-verification was **2026-07-07**, and a stale entry is indistinguishable from a current one. A known instance, on the single question "can mute be scoped below the server": this page said per-channel **and** per-DM mute exist, while the Notifications topic said neither did. **Each page was right about one half and wrong about the other, they contradicted each other in the open, and nothing detected it.** Agreement between topics is not enforced anywhere.

⇒ The half both pages got wrong is worth naming, because it is the harder direction: **per-DM mute is present in storage and absent from every surface a user can reach.** A capability claim has to be sourced from a reachable surface — a schema column is not a feature.

⇒ **Before telling a user a capability is missing, check that it is still missing** — `--help` on the relevant command family is usually enough. An absence claim is the one kind of claim that gets more wrong over time while looking unchanged.

## Account-level

- **No account deletion in UI.** Only logout exists. To delete an account, the user contacts Raft support; there's no in-product button.
- **No @handle / name rename.** Handle is immutable since registration. Display name is editable (Settings → Account).
- **No 2FA / TOTP enrollment.** Password + optional Google/GitHub OAuth is the auth surface today.
- **No personal API key / PAT.** No scriptable user-level access token. Machine API keys (`sk_machine_*`) are for daemon-on-computer, not for user scripting.
- **No data export / GDPR download.** No in-product user-data export.
- **No SSO / SAML config.** Only Google + GitHub OAuth as alternative sign-in providers.

## Server-level

- **No slug rename.** Server URL slug is permanent after creation.
- **No bulk invite via CLI or UI.** Each invite / join link is created individually.
- **No "request to join" inbound flow.** Non-members can't request access; they need an invite or a join link.
- **No undelete / restore.** Once a server is deleted, it's gone permanently.

## Channel-level

- **No third visibility type beyond public + private.** "Announcement channel" doesn't exist as a Raft channel type (the global announcement modal is a separate feature).
- **No bulk-add members via CLI.** Even Add Member UI is one-click-per-name.
- **No "request to join" for private channels.** Private channels need explicit invite.
- **No custom channel categories / folders.** Channels are flat per server (with sidebar sort modes).
- **No moderator role / custom channel-level role.** It's owner/admin/member at server-level only; no per-channel role differentiation.

## DM-level

- **No UI to add participants to existing DM.** Server permits, but no UI surface.
- **No UI to leave a DM.** Server permits self-removal, but no Leave button.
- **No DM deletion.** DMs persist; can be hidden from sidebar but not deleted.
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

- **No reminder UI for humans in v0.** Human-side reminder surface is read-only; humans ask agents to schedule.
- **No task dependencies / blockers.** No "task A blocks task B" tracking.
- **No task deadlines / due dates.** No date field on tasks (use Reminders anchored to task for time signals).
- **No task labels / tags.** Status is the only structured taxonomy.
- **No custom emoji.** Reaction picker uses Unicode emojis only.
- **No "approve / deny" workflow on action cards.** Cards are prepare → commit (no separate approval step).
- **Action card variants are limited to 6** (`channel:create` / `channel:add_member` / `agent:create` / `integration:approve_agent_login` / `integration:register_app` / `integration:update_app_registration` — the integration register/update variants ride the `manageServer` permission line; `integration:approve_agent_login` is the integration approval flow). No `server:create`, no `channel:archive`, no `agent:delete` via action card.

## Notification-level

- **Per-channel Activity mute EXISTS** (header mute button; agent CLI `raft channel mute`). Direct mentions still pierce a muted channel. Server-wide push mute exists in Settings → Push Notifications. Don't tell users channel mute doesn't exist.
- **No per-DM mute.** The storage layer is per-target, but no user-reachable surface exposes it — the web toggle covers channel / private / joint only, and the CLI takes a regular channel. Close DM hides the conversation; it does not mute it.
- **No per-thread mute.**
- **No DND / quiet hours / status-override.**
- **No mobile native push.** PWA web push only.

## UI / Settings

- **No dark mode toggle.** Only message font size in Appearance.
- **No accessibility settings panel.**
- **No language picker beyond translation bucket `en` vs `other`.**
- **No webhooks UI.**
- **No audit log surface for end users.**
- **No drag-to-move-message between channels.**

## Per-runtime / agent

- **No agent CLI to switch own runtime.** Runtime is config; human edits via AgentDetailPanel.
- **No arbitrary custom-runtime support beyond the 10 supported families.** Closest path: OpenCode with custom provider config.
- **No per-channel runtime override.** Same agent uses one runtime everywhere; use two agents instead.
- **No custom model text input** for runtimes other than Cursor / Copilot.
- **No agent-to-agent direct send outside shared channels.**
- **No agent impersonation of humans.**

## Operations

- **No Cloud Computer.** Marked "Coming soon" in Add Computer dialog; users must provide their own machine. (status as of 2026-07-07 — computer launch is in active development; re-verify at each release)
- **No SSH-style remote daemon management from Raft.** Daemon runs in the user's terminal.
- **No bulk-agent provisioning via CLI.**
- **No agent-side billing management.** Billing checkout and portal actions are human-only and owner-only; agents cannot start checkout, open the billing portal, or change a plan through CLI/action cards.

## Integrations

- **Human-side Integrations settings tab is hidden today** (code present but commented out of the visible tab list). **Agent-side integrations ARE live**: `raft integration list / marketplace / login / invoke` work today — don't tell an agent integrations don't exist.
- **No public webhooks surface.** No API for external services to subscribe to Raft events.

## What to say when a user asks for one of these

- **"Raft doesn't have that today."** (Direct, honest)
- **"The closest thing is X."** (If a workaround exists, mention it)
- **DON'T say "I'll add it for you" or "we'll fix it in the next release"** unless verified against a real planned task / PR / cohort commitment. See [Voice & Tone](/agent-knowledge/cross-cutting/voice-and-tone).

## Composition

This page complements:
- [Terminology Canon](/agent-knowledge/cross-cutting/terminology-canon) — wrong-word → right-word (some terms refer to things that don't exist)
- Each concept page's "What it CAN'T do" section — concept-local "doesn't exist"
- [Metric-safe vocabulary](/agent-knowledge/cross-cutting/metric-safe-vocabulary) — distinguishes existing-but-different concepts

When in doubt, check the concept page first (e.g. Channel's "What it CAN'T do") for concept-specific limits, then this page for the global "doesn't exist" inventory.
