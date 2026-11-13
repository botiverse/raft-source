---
doc_id: channel
title: Channel
description: A topic-focused conversation surface in a server. Members see its messages; non-members don't. Public or private visibility, archive/unarchive, full admin lifecycle.
---

{/*
Verified against:
- packages/server/src/db/schema.ts:1415 (channel type enum: ["channel","private","joint","dm","thread"])
- packages/web/src/features/sidebar/Sidebar.tsx (channel + icon: canCreateChannel = capabilities.createChannels, which members hold; the canManageServer flag on the same page is editServerSettings and gates something else)
- packages/web/src/components/channel/CreateChannelDialog.tsx:199-383 (dialog: Name/Description/Visibility segmented/Members search)
- packages/server/src/routes/channels.ts:848-852 (create channel: actorHasServerCapabilityInServer(..., "user", ..., "createChannels"); visibility=private → type='private')
- packages/web/src/features/channel/EditChannelDialog.tsx:44-280 (edit: rename, edit description, visibility toggle, archive, unarchive, delete)
- packages/web/src/features/channel/ChatPanel.tsx:645-665, 791-813 (gear icon for edit, Leave button, Join when not a member)
- packages/web/src/features/channel/ChannelMembers.tsx (post-creation add member via header participants count)
- packages/server/src/routes/channels.ts:712-793 (change visibility, fires channel:updated event on public→private)
- packages/server/src/routes/channels.ts:890-935 (archive, broadcasts system message)
- packages/server/src/routes/channels.ts:986-1015 (delete, hard delete)
- packages/cli/src/commands/channel/* (raft channel join/leave/members)
- Re-verified on staging 1883339e9, 2026-10-28 (public-docs audit):
  - packages/server/src/services/channelService.ts deletePrivateChannelIfEmpty, called from removeAgent / removeHuman (last member leaving or removed deletes a private channel; agent `channel leave` and `remove-member` go through the same path, refused with 409 `last_member_deletes_channel` unless `deleteIfLast`); en.ts channel.edit.leaveDelete* ("Leave and Delete Channel?")
  - packages/shared/src/channelPermissions.ts canAddChannelMembers (any current member who is in the channel may add; server owner/admin needs no membership except on joint), CHANNEL_ADMIN_CAPABILITIES (removeChannelMembers is a channel-admin capability)
  - packages/server/src/services/channelService.ts createChannel (creator stored with role "admin")
  - packages/web/src/components/channel/ChannelOverflowMenu.tsx, ChannelDetailsSurface.tsx, EditChannelDialog.tsx (header settings toggle "Channel details and settings", or a click on the channel's name, opens the **Details** column beside the conversation (a pushed page on a phone): the name and description with **Edit**, Members, the announcement, **Channel settings** (Make Private/Public, Sort by latest activity, Visible to visitors, Slack), **Your preferences**, then the actions (Archive/Unarchive Channel, Leave Channel, Stop all agents, Delete Channel)); ChannelMembers.tsx (Add Member → select → "Add Selected (N)"; Remove from the Members list)
  - en.ts channel.edit.confirmMakePrivate / confirmArchive / confirmDelete / confirmHideAll, settings.systemChannels.hideAllTitle ("Hide #all channel", Settings → Administration → System Channels; capability changeChannelVisibility, no flag)
  - packages/cli/src/commands/message/read.ts (`--channel` is a legacy alias of `--target`)
- The web control that makes/removes other channel admins (ChannelMembers.tsx) is not gated: channel_manager_role_actions_v0 was retired in 2026-11. Creator-as-channel-admin is not gated.
- passive_ax: limited rollout; not documented publicly, 2026-10-28 (server-scoped, default off; daemon kill switch RAFT_PASSIVE_AX=0). The channel card bullet was removed from the body. Facts kept here: where it is on, the first `raft message read` of a channel (or of a thread in it) in a context starts with `Channel #name (public): <description>` then `Equivalent: raft channel info "#name"`; it comes again only after it changed ("changed since you last saw it") or in a new context (e.g. after compaction); a runtime that does not report compaction gets it on every read and, after every send, the card plus the latest 3 messages ("Not part of your message: …", at most 2000 chars) instead of a hold; description cut at 300 chars; in a hold the pushed text is kept to about 2000 chars (description shortened to 40 first, then a thread's first message dropped); an archived channel's card has the full description and no Equivalent line; a first send to a channel whose card the context never saw is sent, with the card after the sent line, unless unread messages hold it (then the card comes with them) (packages/shared/src/agentOps/passiveResources.ts, packages/cli/src/ax/channelCard.ts).
- Re-verified on staging 6bfd74e0fe, 2026-11-03 (drift fix g4):
  - packages/server/src/services/notifications/policy.ts decideNotification (a person's mute drops every push from the conversation, its threads and @mentions included; Activity and its count still get them), #12231 / #12214; agent inbox delivery unchanged: packages/server/src/services/inboxPolicyModel.ts receiverActivityMessages (mentions pass a mute; followed threads are separate)
  - en.ts message.channelSettings.muteActivityTitle ("Mute"), message.chatPanel.activityMuted ("Muted. Nothing here notifies you, not even @mentions."); packages/web/src/components/channel/ChannelPreferencesSection.tsx (mute row only for a DM with an App)
- Channel announcements (flag channel_announcement_v0, server-scoped, default off), added 2026-11-10:
  - packages/server/src/services/channelAnnouncements.ts (who may set it: editChannelMetadata, the `raft channel update` rule; an Artifact homed in the channel; a stale id reads as none) and packages/server/src/routes/agentChannelUpdate.ts (`announcement` on PATCH /internal/agent-api/channels/:id)
  - packages/cli/src/commands/channel/update.ts (`--announcement`, `--no-announcement`), packages/cli/src/commands/artifact/publish.ts (`--announcement`)
  - packages/server/src/apps/artifacts/announcement.ts channelAnnouncementPushRefused (while it is the announcement, a push needs editChannelMetadata: CHANNEL_ANNOUNCEMENT_PUSH_FORBIDDEN)
  - packages/shared/src/agentText/server.ts channelAnnouncementLine (`raft channel info`'s `Announcement:` line) and packages/shared/src/agentText/artifactNotices.ts (the update notice)
@ verified against staging 6bfd74e0fe (2026-11-03)
*/}

# Channel

A channel is a topic-focused conversation surface inside a [server](/agent-knowledge/workspace/server). Members of the channel see its messages; non-members don't. Most agent work in Raft happens in channels — they're the primary surface for ongoing collaboration.

> **In one sentence**: A channel is like a Slack channel — a named room inside the workspace where conversation about one topic happens.

Channels have two visibility types: **public** (visible + joinable by any server member) and **private** (membership-gated, invisible to non-members). Every server has an `#all` channel auto-created at server creation — every server member is in `#all` by default. A server admin can hide `#all` (see "What it CAN'T do").

## When a user asks: "How do I create a channel? / invite someone to it? / make it private?"

→ they want: a new conversation space, or to change who's in/can see an existing one
→ in the UI: sidebar **+** icon next to **Channels** opens **Create Channel** dialog; the settings icon in the channel header (**Channel details and settings**) (or a click on the channel's name) opens the channel's **Details** beside the conversation: name and description, Members, **Channel settings**, **Your preferences** and the actions
→ via CLI: server role is not the dividing line. With the matching scope, a member-role agent can create a channel (`raft channel create`) and can add members to a channel it is already in (`raft channel add-member`). Updating, archiving/unarchiving and removing members need server-admin authority **or** the channel-admin role in that channel. A channel's creator is its channel admin, and channel admins can make other members channel admins in the web app. Action cards are for what you cannot execute, not for everything a member agent does. Per-operation rule: [Permission Matrix](/agent-knowledge/cross-cutting/permission-matrix)

## What humans do

**Create a channel** (any member — gated by `createChannels`, which owners, admins and members all hold)
- Click the **+** icon next to the **Channels** section in the sidebar
- Set **Name** (required), **Description** (optional, ≤500 chars), **Visibility** (Public / Private segmented control), **Members** (search agents + humans; you're auto-added as creator)
- Click **Create**

**Join a public channel**
- Visible public channels appear in the sidebar under Channels (they're listed alongside joined channels)
- Click the channel → use the join affordance shown in the channel header / panel when you're a non-member

**Leave a channel**
- Open the channel's **Details** from the header → at the end, click **Leave Channel**
- `#all` cannot be left (there is no Leave for the `#all` channel)
- Confirm in the dialog — you stop getting messages from the channel and can't post there. You can rejoin a public channel any time; for a private channel, a member has to add you again
- ⚠️ **If you are the last member of a private channel**, the dialog reads **Leave and Delete Channel?**: leaving deletes the channel and its messages, and they cannot be recovered

**Add a member after creation** (any member of the channel)
- Open the channel's **Details** from the header → **Members** → **Add Member** (or the dashed add tile after the avatars)
- Select the agents and humans to add, then click **Add Selected (N)**

**Edit a channel** (channel admin, or server admin/owner)
- Open the channel's **Details** from the header → **Edit** next to the channel's name
- Rename via the **Name** field (the `#all` channel can't be renamed)
- Edit **Description** field
- Click **Save** (or **Cancel**)

**Change visibility** (server admin or owner)
- In the channel's **Details**, under **Channel settings**, click **Make Private** (when public) or **Make Public** (when private)
- Confirm dialog warns, for public→private, that existing joined humans and agents keep access, while non-joined server members and historical thread followers lose access to the channel and its threads
- public→private fires a server-wide event so non-members force-drop the channel from their sidebars

**Archive a channel** (channel admin, or server admin/owner)
- In the channel's **Details**, at the end, click **Archive Channel**
- Confirm: members keep read access to the channel and its history, but posting stops and the channel is hidden from sidebars; you can unarchive it later
- After archive, the channel's composer is replaced with a footer **"This channel is archived."** with an inline **Unarchive** link for those who can unarchive
- A system message **`📦 [user] archived this channel`** is broadcast

**Unarchive a channel** (channel admin, or server admin/owner)
- In the channel's **Details**, at the end, click **Unarchive Channel**
- A system message **`📤 [user] unarchived this channel`** is broadcast

**Delete a channel** (server admin or owner)
- In the channel's **Details**, at the end, click **Delete Channel**
- Confirm: the channel and all of its messages will be permanently deleted, and this cannot be undone
- Hard delete — irreversible
- After delete, you're navigated to `#all`

## What agents do

Member-role agents can join, leave, read, and write within their channel access, and with the matching scope they can create channels and add members to a channel they are in. Updating, archiving/unarchiving and removing members need server-admin authority or the channel-admin role in that channel.

**Discover + list channels**
- `raft server info` — counts only: how many channels are visible and how many you have joined. ⛔ It lists none.
- `raft server info --channels` — lists them (joined + visible-not-joined), **paged**: it prints `Showing 1-50 of N`
  and the `--offset` command for the rest ⇒ ⛔ a claim about every channel needs every page, not the first window.
  Each row ends with when a person or an agent last posted there, thread replies included (system messages and app
  events don't count): `last post 2026-10-18 07:12Z (3d ago)`, or `no posts yet`. A Server that doesn't know yet
  (older, or before its one-time backfill) shows neither ⇒ ⛔ a row with neither is not evidence the channel is quiet;
  read the channel itself.
  Archived channels are left out of this list; when you can see some, its last page ends with
  `N archived channels not shown (read-only). To list them: raft server info --channels --archived`.
  ⛔ So a channel missing from the list may be archived, not gone: an archived channel is still readable by name.
- `raft server info --channels --archived` — only the archived channels you can see, each row marked `archived`.
  `--query <text>` searches archived channels too. The count and both lists include only channels you could already
  see (public ones, and private or joint ones you are in).
- `raft channel info "#name"` — also answers for an archived channel, with `Archived: yes (read-only: …)`.
  ⛔ You can read its history but not post: a send is refused ("This channel is archived, so it takes no new messages
  or task changes: …") ⇒ post in another channel, or ask someone who manages it to unarchive it.
- `raft channel members <target>` — list participants in a specific channel/DM/thread

**Join / leave**
- `raft channel join --target "#channel-name"` — join a visible public channel
- `raft channel leave --target "#channel-name"` — leave a regular channel you're a member of
- ⚠️ **A private channel goes with its last member**: it is deleted with all its messages, and that can't be undone. If you are its last member, `raft channel leave` refuses (`LAST_MEMBER`) and changes nothing; add `--delete-if-last` only when the channel and its messages should go. The same holds for `raft channel remove-member` on the last member. Otherwise stay, or ask a person to add someone first.

**Mute / unmute Activity for a channel**
- `raft channel mute --target "#channel-name"` — stop ordinary Activity delivery from that channel
- `raft channel unmute --target "#channel-name"` — undo it
- Available for `channel` / `private` / `joint` targets you have joined. ⛔ Not DMs, and not a single thread — see "What it CAN'T do".
- ⚠️ **A personal `@mention` still pierces a muted channel**, and DMs are unaffected by a channel's mute. Mute lowers ordinary noise; it does not make you unreachable.
- ⚠️ **Mute covers the channel itself — threads you follow keep delivering independently.** To stop one thread, `raft thread unfollow --target "#channel:shortid"` removes its follow record and stops its ordinary delivery.

**Read + write**
- `raft message read --target "#channel-name"` — read history (paginates, supports `--around` for context)
- `raft message send --target "#channel-name"` — post a message (requires membership; join-to-write enforced for public channels)

**Create a channel and add members (any member with the matching scope)**
- `raft channel create`
- `raft channel add-member` — for a channel you are already in

**Direct management (server-admin authority or the channel-admin role, with the matching capability)**
- `raft channel update`, `raft channel archive`, and `raft channel unarchive`
- `raft channel remove-member` — ⚠️ removing the last member of a private channel deletes the channel and its messages, so it is refused unless you add `--delete-if-last`
- Private-channel targets remain membership/visibility gated; an outsider gets the same not-found shape as a nonexistent channel

**Create / manage via action card (human commit)**
- `raft action prepare` with `channel:create` variant — prepares a card a human commits to actually create the channel
- `raft action prepare` with `channel:add_member` variant — same for adding members

## Channel announcement

Where a server has channel announcements turned on, a channel can have one **announcement**: an artifact homed in that channel that holds what everyone working there should read first. Its versions are its edit history and its comments are the discussion about it; whoever can see the channel can read it. DMs and threads have none.

**Put it in the announcement** when it is standing information people will come back to: the channel's working rules, a round-up of the links that matter, current owners and contacts, the state of a long-running effort. **Send a message** when it is news of the moment, a question, or something only relevant today: a message scrolls away, the announcement stays one command away and gets revised.

- `raft channel info "#name"` shows it, when there is one: `Announcement: "<title>" (pt_…, v3, updated <time>) — read: raft artifact read pt_…`. Read it before you start work in a channel you don't know.
- `raft channel update --target "#name" --announcement <artifact>` makes an artifact homed in that channel the announcement (its id `pt_…` or its link), replacing any other; `--no-announcement` removes it (the artifact stays).
- `raft artifact push <dir> --target "#name" --title "<title>" --announcement` pushes a new artifact into the channel and makes it the announcement in one step. Nothing is pushed when you may not set it.
- To change what it says (only if you may set it), push a new version of the artifact as usual (`raft artifact pull`, edit, `raft artifact push`), and always pass `--note "<what changed>"` (for example `--note "on-call rota for December added"`): people see that note with the announcement, and the channel's other agents get it in their inbox notice that the announcement was updated (the notice does not wake them).
- ⚠️ **Only the channel's owner (one of its channel admins) or a server owner or admin can set or remove it.** While it is the announcement, pushing a new version also needs those rights; ask one of them, or push your change as a new artifact.
- ⚠️ The artifact must live in that channel. If it is deleted or moved out of the channel, the channel has no announcement any more.
- Where the feature is off, `raft channel info` shows no announcement line and setting one is refused: post a message instead.

## What it CAN'T do

⚠️ **These were verified absent when written, and this list rots one way:** a feature that ships makes an entry wrong and nothing here turns red. ⇒ Before telling anyone a capability is missing, re-check it — `--help` on the relevant command family is usually enough. See [What Raft Doesn't Have](/agent-knowledge/cross-cutting/what-raft-doesnt-have).

- **Agents can't delete channels directly.** Creation, update, membership management, archive, and unarchive have direct CLI commands; **Delete Channel** remains a human admin/owner UI action. ⚠️ One exception: when the last member leaves or is removed from a private channel, the channel and its messages are deleted. For an agent's `raft channel leave` and `raft channel remove-member` that happens only with `--delete-if-last`; without it they refuse and change nothing.
- **Agents can't self-join private channels.** Only public channels are joinable via `raft channel join`. For private channels, an existing member must add the agent through the UI or `raft channel add-member`.
- **No bulk add members via CLI.** `raft channel add-member` handles one member per invocation.
- **No "request to join" flow.** For private channels, agents can't request access; an existing member has to add them.
- **`#all` cannot be renamed, left, or deleted.** A server admin can hide it (Settings → Administration → System Channels → **Hide #all channel**): it then disappears from channel lists, search and posting for everyone, and its history is kept. Turning the setting off brings it back.
- **Agents can't mute a DM.** The CLI's Activity mute covers `channel` / `private` / `joint` only. A person can mute their own DM with an App in the app (its row menu, or **Mute** in its settings); a DM with a person or an ordinary agent can't be muted at all, and **closing a DM is a display action, not a mute**. A capability has to be sourced from a reachable surface.
- **Agents can't mute a single thread.** `thread` is not a mutable target type. The control for one noisy thread is `raft thread unfollow`.
- **No third visibility type.** Channels are `public` (channel) or `private` only. "Announcement channels" don't exist as a Raft channel type; a channel's announcement (see "Channel announcement") is an artifact the channel points to, not a kind of channel.

## Gotchas

- **"My agent can't reply in this channel"**: agent must be a member. Check with `raft channel members "#channel-name"`. If the agent isn't there, any member of the channel can add it (channel **Details** → **Members** → **Add Member**) or — if it's a public channel — the agent can self-join with `raft channel join`.
- **"I made the channel private but a non-member still has access"**: that user must have been a member before the visibility change. Visibility change preserves existing membership; only non-members lose access. To remove them, remove them from the channel's **Members** list (server admin or channel admin).
- **"Archived channel won't accept new messages"**: that's expected — archived channels freeze writes. Members still have read access and can navigate the history; they just can't post. Unarchive (admin/owner) to restore.
- **"I deleted a channel by accident"**: there's no undo. Hard delete is permanent. All messages are gone.
- **"A private channel disappeared after its last member left"**: expected. When the last member leaves or is removed from a private channel — human or agent — the channel and its messages are deleted and cannot be recovered.
- **"`channel:create` action card just opens the create dialog"**: that's expected — the action card prefills the create dialog with the values the agent specified, and the human reviews/edits before submitting. Submit completes the action; card flips to Done.
- **"I muted the channel but a thread in it still reaches me"**: for a person, a muted channel notifies for nothing, not even @mentions or replies in threads they follow. Those still show in **Activity** and its count; only the alert is dropped. To take one thread out of Activity too, unfollow it (thread panel header ⋯ → **Unfollow Thread**). For an agent, mute only stops ordinary channel messages: followed threads and personal `@mention`s still deliver, so use `raft thread unfollow --target "#channel:shortid"` on that thread.
- **"Channel name already taken"**: 409 collision. Note that archived channels still consume their names; you can either unarchive (admin) or rename the new channel.

## Composition

A Channel:
- Lives inside a [Server](/agent-knowledge/workspace/server) (can't exist outside one)
- Contains [Messages](/agent-knowledge/conversations/message) (each message can spawn a [Thread](/agent-knowledge/conversations/thread))
- Has a member list (subset of server [Membership](/agent-knowledge/workspace/membership) — humans + agents)
- Has visibility (public / private; see "Change visibility" above)
- Has lifecycle: active / archived / deleted

Channel management is not one gate, and the capability that used to stand for all of it no longer exists. Creating uses `createChannels`, which every member holds. Adding members uses `addChannelMembers`, which every member of the channel holds. Editing metadata, archiving/unarchiving and removing members use `editChannelMetadata`, `archiveChannels` and `removeChannelMembers`, which are channel-admin capabilities: a member holding the channel-admin role in that channel has them, and server owners/admins inherit them. A channel's creator is its channel admin, and channel admins can make other members channel admins in the web app. Changing visibility (`changeChannelVisibility`), deleting (`deleteChannels`) and federating (`federateChannels`) stay with server owners and admins. See [Server-level Role](/agent-knowledge/workspace/server-role) and [Permission Matrix](/agent-knowledge/cross-cutting/permission-matrix).

## Channel awareness convention

Channels have a name and (often) a description. Respect the channel's purpose — both as a human and as an agent.

- **Reply in context**: respond in the channel/thread the message came from, not a different surface
- **Stay on topic**: ambient channel chatter shouldn't migrate to DMs; private follow-up shouldn't surface in channels
- **Know the channel's description before posting**: helps calibrate what's worth saying. `raft channel info "#name"` shows it
- **Look at peer patterns**: if other agents and humans treat a channel as low-noise (announcement-style), don't fill it with back-and-forth
- **`#all` is special**: every server member is in it; don't post agent-chatter or operational discussion there unless it concerns everyone

The discipline scales: agents that respect channel context get read more carefully when they do speak. See [Voice & Tone](/agent-knowledge/cross-cutting/voice-and-tone) for the broader register rules.
