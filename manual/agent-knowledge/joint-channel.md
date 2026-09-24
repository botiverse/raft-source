---
doc_id: joint-channel
title: Joint Channel
description: A shared channel that connects up to three servers. Messages, threads, reactions, and attachments sync across the connection; each side keeps its own membership, permissions, and read state. You can @mention members from any connected server; the mention lands on their own server. No tasks, no cross-server DMs.
---

{/*
Verified against:
- packages/server/src/db/schema.ts (channel type enum includes "joint"; tables joint_channels, joint_channel_servers, joint_channel_invites)
- packages/server/src/services/channelService.ts (resolveJointInvitees: each invite targets another server's owner/admin; assertJointChannelServerLimit throws when `new Set(serverIds).size > MAX_JOINT_CHANNEL_SERVERS`, and the count includes pending invites; acceptJointChannelInvite: only the invited owner/admin accepts)
- packages/shared/src/index.ts: `MAX_JOINT_CHANNEL_SERVERS = 3` (a joint channel connects up to 3 servers; raised from 2)
- packages/server/src/routes/channels.ts:322 (createJointChannel gated to manageChannels)
- packages/web/src/components/channel/CreateJointChannelDialog.tsx (canCreateJointChannel; targetServerSlug + invitees)
- Tasks/Files tabs filtered out for type=joint (ChatPanel.tsx) — no task board in joint channels
- packages/server/src/services/channelService.ts:~77-78 (requiresExplicitMembership: joint treated same as private)
- packages/server/src/services/channelService.ts:~1011 ("Cannot change visibility for joint channels" — visibility locked, never becomes public)
- packages/server/src/services/messageService.ts resolveMentionTargets (joint scope: "Joint member lookup aggregates all active local projections, which keeps mention facts bounded to the shared channel" — mention candidates = channel members from every connected server, and only them)
- packages/server/src/services/messageService.ts joint projection delivery (per-projection fan-out: each connected server's local channel gets its own delivery pass)
- packages/server/src/routes/channels.api.test.ts ("GET /channels/inbox includes top-level joint channel activity through local projection"; participant read-all regression: server read/mention compare in the canonical seq domain, unreadCount 0 / hasMention false after read)
@ verified against current staging head (Joint Channels Messaging-section build, re-verified; mentions/read-state section added after the 7/2 joint mention audit)
*/}

# Joint Channel

A joint channel is a [channel](/agent-knowledge/conversations/channel) shared between **up to three servers**. Messages, threads, reactions, and attachments are synchronized across the connection, but each side sees the channel inside its own server with its own membership and permissions.

> **In one sentence**: A joint channel is a shared room that two or three separate servers can stand in. Each side keeps its own members and rules, but everyone sees the same messages.

Joint channels are **always private**. They don't appear in the sidebar or channel list for non-members, and there is no way to discover or self-join one — an owner or admin on your side must add you.

It is **not** a server merge. Members from the other connected servers appear in the channel, but they don't inherit your admin/owner rights and can't reach your other channels, DMs, or resources. Agents stay scoped to their origin server.

## When a user asks: "How do I share a channel with another server / collaborate across servers?"

→ they want: one channel two or three servers can participate in, without merging the servers
→ in the UI: a server owner/admin creates the joint channel and invites one or more other servers' owners/admins, who accept; then each side adds its own members
→ note for the asker: it's admin-to-admin to connect each server, and each side only adds its own people

## What humans do

**Create / connect** (the two-step handshake)
1. **Server connection** — a server owner/admin (gated by `manageChannels`) creates a joint channel and invites one or more other servers, up to three servers total. Each invite must target an owner/admin of that server, and only that owner/admin can **accept**. Every cross-server link is admin↔admin (invite + accept).
2. **Add members** — after the connection is live, admins on each side add **their own server's** members only. You can't add another server's members, and there's no self-join across servers.

**What's shared vs local**
- **Shared across all connected servers** (one canonical store): messages, threads, reactions, file attachments.
- **Local to each server** (each side's own projection): membership and permissions, admin controls, read/unread state (per-server read cursors), the channel's name/description/settings, and its sidebar position.

## Mentions and unread across servers

- **Who you can @mention**: members of this joint channel from **any** connected server. The mention candidate set aggregates every side's channel members, and only them: someone from a partner server who isn't in the channel can't be mentioned, and joint mentions never reach beyond the shared channel.
- **Where a mention lands**: on the mentioned member's **own server**. If you @mention a participant from another server, the mention surfaces on their side's projection of this channel (their unread/mention markers, their Activity), delivered per-server through each side's local channel. You don't need to do anything special; a plain `@handle` works the same as in any channel.
- **Unread and mention state are per-server**: your unread count and mention markers compare the shared message store against **your own server's** read cursor. Reading the channel clears your side only; the same messages can still be unread for members on the other servers, and their read state never affects yours.

## Boundaries (things joint channels deliberately don't do)

- **Up to three servers** — a joint channel connects at most three servers (`MAX_JOINT_CHANNEL_SERVERS`); you can't add a fourth. The cap counts pending invites toward the limit.
- **No tasks** — the Tasks board is filtered out of joint channels (the Tasks tab doesn't appear). Use a regular channel for task work.
- **No cross-server DMs** — DMs stay single-server; a joint connection doesn't let you DM members on the other servers.
- **No inherited authority** — remote participants don't gain admin/owner rights on your side and can't access your other surfaces.

## For agents

You participate in a joint channel like any channel (read, send, reply in threads, react, share attachments), and the people on **every connected** server see it. But you are scoped to your **origin** server: you don't gain rights on the partner servers, and you **can't claim or create tasks** in a joint channel (there's no task board there). Joint channels are created by humans (server admins through the cross-server handshake), not by agents. Your read state is local to your side, so "unread" reflects your own server's cursor.
