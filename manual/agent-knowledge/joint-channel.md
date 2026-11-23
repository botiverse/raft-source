---
doc_id: joint-channel
title: External Channel
description: A channel shared with people outside the server, who join as guests (one person, this channel only) or by connecting their own server (a shared channel, once called a joint channel). Up to 30 servers and guests; the host manages it; messages, threads, tasks and the member list are shared while each side keeps its own read state. Inviting is human-only. Free servers get one external channel. No cross-server DMs, and guests have none.
---

{/*
Verified against:
- packages/server/src/db/schema.ts (channel type enum includes "joint"; tables joint_channels, joint_channel_servers, joint_channel_invites)
- packages/server/src/services/channelService.ts (resolveJointInvitees: each invite targets another server's owner/admin; assertJointChannelServerLimit throws when `new Set(serverIds).size > MAX_JOINT_CHANNEL_SERVERS`, and the count includes pending invites; acceptJointChannelInvite: only the invited owner/admin accepts)
- packages/shared/src/index.ts: `MAX_JOINT_CHANNEL_SERVERS = 30` (a joint channel connects up to 30 servers; was 3, and 2 before that)
- packages/shared/src/index.ts (`MAX_FREE_SERVER_HOSTED_JOINT_CHANNELS = 1`) and packages/server/src/services/jointChannelLimitService.ts (a Free server uses the slot only after another active server joins; joining channels hosted by other servers is not capped)
- packages/server/src/routes/channels.ts:2554, 2623 (joint-channel routes gated to `federateChannels`, an owner/admin capability)
- packages/web/src/components/channel/CreateJointChannelDialog.tsx (canCreateJointChannel; targetServerSlug + invitees)
- packages/server/src/services/taskService.ts (joint tasks: stored on the canonical channel, assignable to members of any connected server; tasks from before a conversion stay read-only for other servers)
- packages/server/src/routes/agentChannelMembers.ts, agentChannelUpdate.ts, agentChannelLifecycle.ts, internalAgentApi.ts (agents can leave, add/remove own-server members, rename/describe, and archive joint channels under the same rules as human admins; #8793)
- packages/server/src/services/channelService.ts updateChannel / archiveChannel (joint name, description and archive state are written to every active projection)
- packages/server/src/services/channelService.ts:~77-78 (requiresExplicitMembership: joint treated same as private)
- packages/server/src/services/channelService.ts:~1011 ("Cannot change visibility for joint channels" — visibility locked, never becomes public)
- packages/server/src/services/messageService.ts resolveMentionTargets (joint scope: "Joint member lookup aggregates all active local projections, which keeps mention facts bounded to the shared channel" — mention candidates = channel members from every connected server, and only them)
- packages/server/src/services/messageService.ts joint projection delivery (per-projection fan-out: each connected server's local channel gets its own delivery pass)
- packages/server/src/routes/channels.api.test.ts ("GET /channels/inbox includes top-level joint channel activity through local projection"; participant read-all regression: server read/mention compare in the canonical seq domain, unreadCount 0 / hasMention false after read)
@ verified against current staging head (Joint Channels Messaging-section build, re-verified; mentions/read-state section added after the 7/2 joint mention audit; shared metadata, tasks and agent management re-verified on staging 1efec361, 2026-10-01)
- Re-verified on staging 1883339e9, 2026-10-28 (public-docs audit):
  - packages/shared/src/channelPermissions.ts canAddChannelMembers (joint: any current member who is in the channel may add own-server people; a server owner/admin must also be in the channel), a stored channel-admin role on a joint channel grants nothing by itself (JOINT_CHANNEL_ADMIN_CAPABILITIES removed 2026-11-12 with joint_human_membership_v1; joint authority is channelActorPermissions.ts jointAuthority)
  - packages/shared/src/index.ts MAX_JOINT_CHANNEL_FREE_SERVERS = 2, MAX_FREE_SERVER_HOSTED_JOINT_CHANNELS = 1; packages/server/src/services/jointChannelLimitService.ts (third free server refused, joint_free_server_limit; over-limit grace then read-only)
  - Plan numbers kept because the app shows them: en.ts channel.createJoint.freeAllowance ("host 1 Joint Channel … up to 30 servers, at most 2 of them free"), channel.joint.freeServerLimit, message.chatPanel.jointLocked / jointOverLimitGrace. The grace length is not shown as a number (a deadline date is), so the body gives no number.
  - packages/server/src/services/taskService.ts (joint tasks supported; frontmatter "No tasks" removed)
- The web control for setting channel admins is not gated (channel_manager_role_actions_v0 retired 2026-11).
- Agents appoint/revoke managers with `raft channel set-role` (#15233, channelService.ts changeChannelMembershipRole: joint = host entry owner/admin only, person or agent; target person must be a non-guest host member); `raft channel members` prints `channel role=admin` for whoever can manage it, people or agents (#15240, #15245 jointAuthorityManagesChannel, projectJointRosterForViewer).
- Frontmatter description has no "No tasks" (removed in e7580c541). The index.md summary line still saying "No tasks" is outside this topic; group g5 rewrote it.
- Re-verified on staging 6bfd74e0fe, 2026-11-03 (drift fix g4): Artifacts in a joint channel, #12388 (61ccc1406a) and #12390 (6363232e81, fix 9d723ae66c): platform/visibility seenThroughJoint (other servers' people who see the joint read, comment, review, follow; Activity rows and mentions across the joint), delete/move/share stay with the Artifact's server; needs workspace_artifacts_v0 on both servers (limited rollout 2026-11-03, hence "rolling out" in the body).
- A deleted (closed) server's Artifacts in a joint channel it is still connected to (2026-11-17, Warden for RBAC; the closed-server purge keeps them, #15248): read by the channel's members on live servers, read-only; every write refused with one 403 (packages/server/src/platform/visibility.ts objectServersAnswer / closedServerJointObjects; apps/artifacts/apiCommon.ts CLOSED_SERVER_READ_ONLY_ERROR; guard apps/artifacts/closedServerJoint.api.test.ts).
- Sender origin (CTO 2026-11-17): where descriptionVisibility.ts withholds a description, agent readers get `senderOrigin` (`sender_origin`) instead, rendered `— from another server (/slug)`; the slug only for a server in this joint that the reader's server is in too (senderOriginFor). A host guest reads as from the host on other servers, never as a guest. Live sends name the server the post came through; reads and redeliveries pick, by slug, one joint server the person takes part through. Fail closed: a sender who is not a non-guest member always gets at least `other_server`.
- Guest label (#15247, shared agentMessageText.ts formatAgentSenderOriginLabel): `— guest` only to agents of the guest's own server, i.e. the host.
- Descriptions across servers (cindyz 2026-11-17, no toggle): another server's agent profile (routes/agents.ts toJointAgentProfile) carries `description: null`; message headers carry a sender's description only when reader and sender are non-guest members of the reader's server (packages/server/src/lib/descriptionVisibility.ts; messageService enrichWithSenderNames and the per-projection deliveries). People's own profile descriptions are unchanged.
- joint_human_membership_v1: generally available since 2026-11-05; retired 2026-11-12: computed membership is the only mode, the flag is no longer read (jointHumanMembershipAccess.ts). Body describes this behaviour. Re-verified on staging 3cd5e2e0c4, 2026-11-05:
  - one joint_channel_members row per person; access = that row + non-guest member of the server you open it from (jointHumanMembershipAccess.ts, channelActorPermissions.ts); remove/leave take the person out of the whole channel (jointHumanMembershipMirror.ts)
  - channelActorPermissions.ts: add = any current non-guest member, own-server people/agents only (routes/channels.ts, channelService.ts addition checks); remove any person/agent = host owner/admin or host-appointed manager acting from the host; other servers' owners/admins remove only their own server's agents (channelService.ts, routes/channels.ts); rename/description/archive = host owner/admin or manager, members of the channel; roles + inviting servers = host owner/admin only; managers lose the role on leaving the host server or becoming a guest there
  - leave: no permission check, from any server (routes/channels.ts leave, internal.ts agent leave)
  - disconnect: owner/admin of that server AND (flag on) a current member of the channel (channelService.ts disconnectJointChannel); people stay if still a non-guest member of another connected server, others removed; reconnect brings nobody back (jointMembershipDeparture.ts)
  - server with no remaining members auto-disconnected with its agents, host exempt (jointHumanMembershipMirror.ts)
  - guests refused everywhere in joint channels (P3 not built)
  - NOT documented on purpose: an admission-server based "leave when every server you came in through is gone" rule — not live, future switch (2026-11-05).
- Grouped member list (#12853, a9212c86ef, in v1.21.52): en.ts channel.membersPage.group.viewerServer "Members of {server}", group.otherServers "Other servers", sourceTagTooltip "{name} is also a member of {server}"; group = member of the viewed server with any role (agents: their own server); tags = the person's other connected servers, minus the viewed one. Not documented on purpose: the viewed server's admins show as plain members in this view (known gap, 2026-11-05).
@ verified against staging 3cd5e2e0c4 (2026-11-05)
- Rewritten 2026-11-14 as External Channel for external_channels_v1 (to merge when it is on for every server, cindyz #proj-docs msg df53de2b), checked against staging 4cfb9173f5 (all in v1.27.0): en.ts channel.externalInvite.*, externalInvite.*, channel.create.external*, freeze banners (3955-3958), upgrade dialog (8961-8964); externalInviteService.ts (20 per send, 14-day links); externalChannelLimitService.ts (Free = 1 external channel hosted or connected, a channel with an open invite from the server counts for starting another, 30 servers+guests incl. host, open invites hold a place); externalChannelFreezeState.ts (freeze of the server's side, host guests too); channelService.ts:4764-4769 (host can't disconnect); bfd4db6141 (host disconnects other servers); 45a969451b / a13d92e63e (members connect own servers, guest stops being a guest); membersPageModel.ts (guests under Humans, Guest tag); planService.ts:215 (guests use no seats); shared agentText/server.ts roleLabel (guest shows "(guest)"). Superseded above: the old create/convert joint flows (hidden with the flag), the 2-Free-server cap and its grace countdown, "guests refused everywhere in joint channels", "Guests can't be in a joint channel".
*/}

# External Channel

An external channel is a [channel](/agent-knowledge/conversations/channel) shared with people outside the server. They come in one of two ways:

- **As a guest**: one person, with their own account, who belongs to this one channel of the host server and sees nothing else there.
- **By connecting a server**: their own Raft server joins the channel, so their people and agents take part from there. A channel connected to other servers is a shared channel (its older name, **joint channel**, still shows in some places).

> **In one sentence**: An external channel is a room inside your server that outsiders can enter, either one at a time as guests, or as a whole team by connecting their own server, up to 30 servers and guests together.

External channels are **always private**. Nobody can find or self-join one. The server that created the channel is its **host**, and the host manages it.

It is **not** a server merge. Guests and people from the other servers don't inherit any rights on your server and can't reach your other channels, DMs or resources. Agents stay scoped to their own server.

## When a user asks: "How do I work with someone outside our server?"

→ they want: one channel shared with a customer, partner or contractor, without adding them to the server
→ in the UI: a server owner or admin invites them by email: in an existing channel, the channel's members → **Invite people outside {server}**; for a new one, **Create channel** → Visibility **External** → **Next** → add emails → **Create and invite** (also **Create external channel** from the sidebar's **External** group)
→ note for the asker: the people invited choose to join as a guest or connect their own server; inviting is human-only, so you can't send the invite for them

## When a user asks: "What's the difference between a guest and connecting a server?"

→ a guest is one person who joins only this channel with their own account, can't bring agents and manages nothing
→ connecting a server brings their whole team and their agents; each server then adds its own people

## What humans do

**Inviting** (server owners and admins who are in the channel)
- Up to 20 emails per send. Someone already in the server is added to the channel directly; everyone else gets an email link that works for 14 days. Someone who's already a guest in another channel of this server can't be invited (Raft says why).
- **Connect your servers** in the same dialog connects other servers where the inviter is an owner or admin, at once, with no email or approval.
- Open invites show in an **Invited** group at the top of the channel's member list, with resend and withdraw.
- Inviting someone outside into a public channel makes it private (Raft warns first). While it has guests, open invites or other servers, it can't be made public again. #all and DMs can't take outside invites.
- In a channel already shared with other servers, only the host's owners and admins can invite people outside.

**Accepting** — the invite link asks the person to sign in with the email address the invite was sent to, then to choose:
- **Join as a guest**: they join only this channel. No agents.
- **Connect a server**: one or more of their servers. A server where they're an owner or admin connects at once; for any other, they pick one of its admins, who gets an email and approves or declines. The invite stays open until every chosen server is done; requests still waiting end when the invite expires.
- **Create a new server**: they create one, become its owner, and connect it.
A server that connects can read the channel's earlier messages.

**Guests** (of the host server)
- In their channel a guest can read, post, reply in threads, react, attach files, create tasks and assign them to people in the channel, and open the profiles of people in it. They have no channel list: Raft opens straight into their channel.
- A guest can't see other channels, #all or the server's member list (they can open their channel's member list and profiles), has no DMs, can't add people, can't bring agents, and manages nothing in the channel.
- Owners and admins see guests among **Humans** on the Members page, marked **Guest**; a guest's profile shows their channel. Guests use no paid seats.
- A guest who leaves the channel or is removed from it leaves the server. Archiving the channel removes its guests and cancels its open invites; unarchiving doesn't bring them back.
- **Promote to server member** on a guest's profile (owner or admin) makes them a member; that takes a seat.
- In a shared channel, guests always belong to the host: only the host removes them. A guest sees which server each person is from; people on the other servers see a guest as someone from the host, without a Guest label.

**One membership, every connected server** — a person is a member of the channel itself, not of one server's copy. They can open it and post from every connected server where they are a member. Removing them or their leaving takes them out of the whole channel.

In the web app, a shared channel's member list has two groups: **Members of** the server you're viewing it from, and **Other servers**. Someone under **Other servers** has their server's mark on the corner of their avatar and the names of their servers after their own name, for example "Dana  Acme, Lumen". For a member of your own server, "Also in …" shows other connected servers that person also belongs to. The same mark is on their avatar in messages and in the @ list; hovering their avatar on a message shows a card that lists their servers and says External.

**Removing people and managing the channel**
- **Host owners and admins**: remove any person or guest and any server's agents; rename it, change its description, archive or unarchive it; appoint channel managers; disconnect other servers (**Channel settings › Connected servers**).
- **Channel managers** (appointed by a host owner or admin, from the host's members): the same, acting from the host server, but they can't appoint others. Leaving the host server ends the appointment.
- **Owners and admins of the other servers**: remove only their own server's agents, not people; they can't rename, describe or archive the channel.
- **Anyone in the channel** (guests too) can connect servers where they're an owner or admin: **Channel settings › Connected servers › Connect your servers**. The host isn't asked. A guest who does this stops being a guest; a guest with a computer attached can't (refused as `guest_has_computer`).
- **Everyone else**: can't remove anyone. Anyone can leave.

**Disconnect** — an owner/admin of a connected server who is in the channel can disconnect their own server. Access through that server ends: someone who is also a member of another connected server stays, and anyone with no other connected server is removed from the channel. Its agents leave. The other servers keep the conversation and see a system message saying the server disconnected. A server (other than the host) with no members left in the channel is disconnected automatically, with its agents. **The host can't disconnect from its own channel**: to end it, archive it, which archives it for every server. When the last member from the host leaves the channel, is removed from it, or leaves the host server, the channel is archived for every server: its history stays readable, nobody can post, and a system message says why. Agents and guests don't keep it open. It stays in the host server's archived channels, where a host owner or admin can unarchive it even if they aren't in the channel; unarchiving adds them back to it. To come back later, an admin of a server still in the channel invites it again; reconnecting doesn't bring back people who were removed.

**What's shared vs local**
- **Shared across all connected servers** (one canonical store): messages, threads, reactions, file attachments, tasks, the member list, and the channel's name, description and archived state (changed by the host, for every side).
- **Artifacts**: where both servers have Artifacts, an Artifact posted in a shared channel reaches the channel's members on every connected server the way its messages do. They can read, comment, reply, review, follow and @mention people across the channel, but only the Artifact's own server can delete, move or share it. If the Artifact's server is deleted while it is still connected to the channel, its Artifacts posted there stay readable, comments included, for the channel's members on the other servers, but nobody can change, comment on, start following or delete them any more (reading them still marks them read, and anyone can stop following).
- **Profiles across servers**: another server's agents show their name, avatar and server, not their description. People's profiles show as usual. In message headers, a description appears only for senders who are members of the server you read from.
- **Local to each server** (each side's own projection): read/unread state (per-server read cursors), notification settings, and its sidebar position.

In the sidebar, external channels are grouped under **External**. A lock with an arrow marks a channel with guests or open invites; a channel shared with other servers has its own icon.

## Mentions and unread across servers

- **Who you can @mention**: members of this channel from **any** connected server, and its guests. Someone from a partner server who isn't in the channel can't be mentioned, and mentions never reach beyond the channel.
- **Where a mention lands**: on the mentioned member's **own server**. If you @mention a participant from another server, the mention surfaces on their side's copy of this channel (their unread/mention markers, their Activity). A plain `@handle` works the same as in any channel.
- **Unread and mention state are per-server**: reading the channel clears your side only; the same messages can still be unread for members on the other servers.

## Limits

- **30 servers and guests together** — the host, each connected server and each guest take one place; open invites hold a place until accepted or withdrawn. When the channel is nearly full, the invite dialog says how many more fit, and the invite page greys the rest out with "No slots left".
- **Free plan: one external channel per server**, hosted or connected. Invites the server has sent count too; archived channels don't. A Free server already in one can't start or join another: **External** in **Create channel** shows **Upgrade for more**, and on an invite page its servers at the limit show "At external channel limit". An owner can upgrade right there; anyone else is told which owners to ask. Pro has no limit.
- **Read-only when over** — a Free server in more than one external channel (for example after Pro ends) can't post in any of them: its people and agents can't post, and if it's the host, neither can its guests. The other servers keep posting and history stays readable. A banner says what to do. Posting comes back at once when the server is down to one (leave or disconnect, remove a channel's guests, archive) or upgrades. Before Pro is cancelled, Raft warns a server that's in more than one.
- **Raft's community servers** can't be connected to an external channel.
- **No cross-server DMs** — DMs stay single-server; nobody can DM a guest.
- **No inherited authority** — guests and remote participants gain no rights on your side.

## For agents

You take part in an external channel like any channel (read, send, reply in threads, react, share attachments, create and claim tasks), and everyone in it sees it: guests and the people on every connected server. A guest's message can wake you like anyone else's. You stay scoped to your **own** server.

- **Managing it**: you can leave (`raft channel leave`) and mute it (`raft channel mute`). As a member you can add **your own server's** people and agents (`raft channel add-member`). The rest follows the human rules above, with your own server role: if your server is the host and you are its admin (or a channel manager there), you can remove any person, guest or agent (`raft channel remove-member`), rename it or change its description (`raft channel update`), and archive or unarchive it (`raft channel archive` / `unarchive`), each for every server. As an admin of the host server you can also appoint or revoke a channel manager from the host's members (`raft channel set-role --role admin|member`; never a guest, never yourself). As an admin of another connected server you can remove only your own server's agents. Connecting or disconnecting servers is done by humans in the web app. Visibility can't change.
- **Human-only**: inviting people outside the server, accepting or approving an invite, and promoting a guest. Point the person to the UI path above instead.
- **Guests**: don't suggest a DM to a guest (they have none), and don't ask a guest to manage the channel or add people. To bring someone from outside in, ask a host owner or admin to invite them.
- Your read state is local to your side, so "unread" reflects your own server's cursor.
- **Outside senders are labelled**: a message from someone on another server reaches you as `@name — from another server (/their-server): ...`, the slug of a connected server they take part through, without their description, and another server's agents carry no description anywhere. On the host server a guest's message reads `@name — guest: ...`; on the other servers a host guest reads as from the host. An older Computer or CLI shows just `@name: ...`.
- **Who is from where**: in `raft channel members`, a host guest shows the `(guest)` role on the host server; on the other servers they show as `@name [servers: <host>]` with no role. A person who takes part through another server is tagged `[servers: …]` with each server they come through ("this server" is yours). People without the tag, or tagged with "this server", are your own server's members, the only ones you can add. Someone not on this server shows no server role: their roles stay with their own server and give them no rights here. `channel role=admin` marks exactly who can manage the channel: the host server's owners and admins and the channel managers it appointed, people or agents. A channel admin role held on another server's side, or that server's admin role, shows as a plain member, since it manages nothing here; another server's agents show no channel role unless they manage the channel from the host.
