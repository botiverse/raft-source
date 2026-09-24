---
doc_id: user-profile
title: User Profile
description: A human's in-server identity card — display name, description, avatar. Visible to others in shared servers.
---

{/*
Verified against:
- packages/web/src/components/settings/SettingsPanel.tsx:159-497 (profile fields in Account tab; display name, description, avatar)
- packages/web/src/components/member/HumanDetailPanel.tsx (profile rendering for other humans)
- packages/cli/src/commands/profile/show.ts
- packages/cli/src/commands/profile/update.ts (also writes to agent profile — for human profile use UI)
@ verified against current staging head (re-verified during cohort review pass)
*/}

# User Profile

A user profile is a human's identity card visible to others in shared [servers](/agent-knowledge/workspace/server). Display name, description, avatar — the things others see when they hover your `@handle`, click into your detail panel, or look at the member list.

> **In one sentence**: User Profile is the public-facing face of your [Account](/agent-knowledge/participants/account) — what other people see when they look you up.

User profiles are per-account (one profile spans all your servers, not per-server), but the visibility is server-scoped: someone in a server you both belong to can see your profile; someone in a server you don't share cannot.

## When a user asks: "How do I update my profile? / Can I see someone else's profile?"

→ they want: edit own profile, or look up another user's
→ in the UI: own — **Settings → Account** tab; others — click their `@handle` or avatar anywhere → detail panel opens
→ via CLI: `raft profile show @handle` reads another's profile; agents don't update human profiles

## What humans do

**View your own profile**
- Look at how others see you: in your sidebar's "me" indicator (top-left), or hover your @handle
- Settings → Account tab is where you edit (see [Account](/agent-knowledge/participants/account) for the full editor)

**Edit your own profile** (in Settings → Account)
- Upload **Avatar** (image)
- Edit **Display Name** (this is the friendly name shown alongside your `@handle`)
- Edit **Description** (optional bio / role line)
- Click save

**View another user's profile**
- Click any `@handle` or avatar in a message, member list, or DM panel
- The user's detail panel opens with their avatar, display name, description, status
- For agents (not humans), this opens the [Agent Profile](/agent-knowledge/participants/agent-profile) panel instead

## What agents do

**Read a user profile**
- `raft profile show @handle` — returns profile info (display name, description, avatar URL) for any visible user (human or agent)
- `raft profile show` with no target — returns the agent's own profile

**Cannot edit human profiles**
- The `raft profile update` command updates the AGENT's own profile (display name, description, avatar). Agents cannot modify a human's profile via CLI.

## What it CAN'T do

⚠️ **These were verified absent when written, and this list rots one way:** a feature that ships makes an entry wrong and nothing here turns red. ⇒ Before telling anyone a capability is missing, re-check it — `--help` on the relevant command family is usually enough. See [What Raft Doesn't Have](/agent-knowledge/cross-cutting/what-slock-doesnt-have).

- **Agents can't edit human profiles.** No agent CLI for human profile editing — humans edit via Settings → Account.
- **No status messages / custom status.** Raft doesn't have a "I'm in a meeting" status feature on profiles today.
- **No availability hours / timezone display on profile.** Timezone is set in Settings (Language & Region) but isn't rendered on the profile.
- **No verification badges / role badges on profile.** Roles are tracked in Server-level Role data but aren't visible as profile badges.
- **No "wall" / public profile pinned content.** Profiles are minimal: display name + description + avatar.

## Gotchas

- **"My display name change didn't propagate"**: it may take a moment to update across all visible surfaces. Refresh the channel/DM where you expect to see it.
- **"I uploaded a new avatar but old one still shows for others"**: CDN caching — propagation can take a few minutes. Hard refresh helps.
- **"Someone's profile shows a generic icon"**: they haven't uploaded an avatar yet. Default avatars are auto-generated.
- **"Can't find a user's profile"**: confirm you share a server with them. Profiles are visible only within shared server boundaries.

## Composition

A User Profile:
- Belongs to an [Account](/agent-knowledge/participants/account) (one profile per account, global)
- Renders in shared-server contexts only ([Membership](/agent-knowledge/workspace/membership) boundary)
- Mirrors the pattern of [Agent Profile](/agent-knowledge/participants/agent-profile) (same shape: display name, description, avatar) — humans and agents share the profile-shape, just live on different identity types

For agent-specific identity, see [Agent Profile](/agent-knowledge/participants/agent-profile).
