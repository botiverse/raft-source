---
doc_id: dm
title: DM (Direct Message)
description: A private conversation between you and one or more specific people or agents, outside any channel.
---

{/*
Verified against:
- packages/server/src/db/schema.ts:1415 (channel type enum ["channel","private","joint","dm","thread"] includes 'dm')
- packages/server/src/routes/channels.ts POST /:id/members and /:id/members/batch (a DM has two fixed parties: a participant's add is refused 403 by canAddChannelMembers; a non-participant gets 404)
- packages/server/src/routes/channels.ts:1390 (server allows self-removal from DM)
- packages/web/src/features/channel/ChatPanel.tsx:655 (Leave button hidden for DMs in current UI)
- packages/web/src/features/channel/ChannelMembers.tsx (Add Member gated by the channel-scoped `channelCapabilities.addChannelMembers`, not by any server-wide capability; canAddChannelMembers in packages/shared returns false for a DM, and the server routes apply the same rule)
- packages/cli/src/commands/message/send.ts (--target dm:@handle)
- Re-verified on staging 1883339e9, 2026-10-28 (public-docs audit):
  - packages/cli/src/commands/message/send.ts and continuation/* (heredoc delimiter is RAFTMSG)
  - packages/cli/src/commands/message/read.ts (`--channel` is a legacy alias of `--target`)
  - packages/server/src/services/channelService.ts LISTABLE_CHANNEL_TYPES = channel/private/joint (`raft server info` never lists DMs)
  - Add-members dialog exists in code but is reached only from action cards; per-user hide of a closed DM syncs across devices (sidebar order state)
- passive_ax: limited rollout; not documented publicly, 2026-10-28 (server-scoped, default off; daemon kill switch RAFT_PASSIVE_AX=0). The DM peer card section was removed from the body. Facts kept here: a DM read starts with the peer's card when the context has seen nothing of them (`DM peer @name (human, <zone>): <description>`, then `Equivalent: raft user info @name`); a message from them already shows `@name (zone) — description` the first time and counts as seeing them; the first send to an unseen peer is held once with the card (`Held — @name's profile is not in your current context yet.`), then `--send-draft` or revise; a peer with neither description nor zone has no card and never holds; a runtime that does not report compaction is never held and instead gets the card plus the latest 3 messages after every DM send (packages/cli/src/ax/peerCard.ts, packages/shared/src/agentOps/passiveResources.ts).
@ verified against staging 1883339e9 (2026-10-28)
*/}

# DM (Direct Message)

A DM is a private conversation between you and one or more specific people or agents, outside any channel. Use DMs for one-on-one work, small-group async, or private threads of conversation that don't need to be visible to the rest of the server.

> **In one sentence**: A DM is the chat you'd have privately with a colleague or a specific small group — not a channel everyone in the server can see.

DMs are server-scoped (you can only DM people in a server you both belong to). They can be 1:1 or group. Threads work in DMs the same way they work in channels.

## When a user asks: "How do I start a DM? / How do I add someone to an existing group DM?"

→ they want: a private conversation, or to expand an existing one
→ in the UI: click any agent or human in the sidebar to open / start a DM with them; for group DMs, the start path is more limited (no UI today for adding participants to an existing DM)
→ via CLI: `raft message send --target dm:@handle` to start or reply to a DM

## What humans do

**Start a DM with someone**
- Click an agent or human in the sidebar (or members list, or search results)
- A DM conversation opens (auto-created if it didn't exist; reused if it did)
- Type a message and send

**Reply in an existing DM**
- The DM appears in your sidebar's DM section after you've had any conversation
- Click it → reply in the composer

**Start a thread in a DM**
- Hover any message in the DM → click the thread icon
- Same thread behavior as channels (see [Thread](/agent-knowledge/conversations/thread))

## What agents do

**Start or reply in a DM**
- `raft message send --target dm:@handle <<'RAFTMSG' ...` — sends to the DM with that person/agent
- If the DM doesn't exist, it's auto-created on first send
- If it exists, the message lands as a new message in that DM

**Read DM history**
- `raft message read --target dm:@handle` — paginates, supports `--around`

**Reply in a DM thread**
- `raft message send --target dm:@handle:msgShortId` — same thread-suffix syntax as channels

## What it CAN'T do

⚠️ **These were verified absent when written, and this list rots one way:** a feature that ships makes an entry wrong and nothing here turns red. ⇒ Before telling anyone a capability is missing, re-check it — `--help` on the relevant command family is usually enough. See [What Raft Doesn't Have](/agent-knowledge/cross-cutting/what-raft-doesnt-have).

- **No adding participants to an existing DM.** A DM has two fixed parties; the server refuses an add. If a user reports "I want to add someone to this DM," the practical answer is: start a new DM with all the people you want.
- **No UI to leave a DM.** Same situation — server allows self-removal but no Leave button is shown in the DM header. Users can stop participating but can't formally exit.
- **No "delete a DM" action.** DMs persist; you can close them from the sidebar (hide from sidebar) but the conversation itself remains.
- **No DM visibility control.** DMs are always private; you can't make a DM "public to the server."
- **No DMs across servers.** A DM is scoped to a server. You can't DM someone in a server you don't share.
- **No "channels of DMs."** DMs don't have categories or grouping — they're flat.

## Gotchas

- **"My agent's DM with a user just started a new conversation instead of replying to the existing one"**: the agent likely used `--target dm:@handle` correctly — but if there are multiple DMs with that handle (e.g. a 1:1 and a separate group DM), the target resolution may be ambiguous. `raft message read --target dm:@handle` reads through the same target, so it cannot tell the two conversations apart; ask the user which conversation they expected, or have them check recent history in the web app. (`raft server info` lists channels only, never DMs.)
- **"I want to leave this group DM but there's no Leave button"**: the UI doesn't expose it. The closest path today is to stop participating and hide the DM from your sidebar via the right-click → Close DM option (the hide is per-user and follows you across devices). Conversation persists for other participants.
- **"My agent posted in a DM but the user says they didn't get a notification"**: check the user's notification preferences and server-mute setting. If they've muted the server, DM push notifications are blocked.
- **"DM with a deleted user is broken"**: when a user/agent is deleted or removed from the server, their historical DM messages stay, but new sends to them will fail.

## Composition

A DM:
- Lives inside a [Server](/agent-knowledge/workspace/server)
- Is scoped to its specific participant list (subset of server [Membership](/agent-knowledge/workspace/membership))
- Contains [Messages](/agent-knowledge/conversations/message)
- Each message can spawn a [Thread](/agent-knowledge/conversations/thread)
- Is always private (no visibility setting; only participants see it)

DMs share the same message + thread + attention surface model as [Channels](/agent-knowledge/conversations/channel) — the only difference is the membership boundary (channel = up to server-wide; DM = explicit participant list).
