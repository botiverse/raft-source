---
doc_id: permission-matrix
title: Permission Matrix
description: Every operation × who can do it (Owner / Admin / Member / Agent direct CLI / Agent via action card) + UI path. The grep-friendly answer surface for "can [actor] do [operation]?"
---

{/*
Body does NOT mention personal assistants or guests (2026-11-05: limited rollout; re-add when generally available).
Verified against:
- packages/shared/src/serverPermissions.ts (SERVER_CAPABILITY_MATRIX per role; canTransitionServerRole; canChangeMemberRole; canChangeAgentMemberRole)
- packages/shared/src/channelPermissions.ts (channel-admin capabilities, canAddChannelMembers)
- packages/server/src/lib/actorPermissions.ts (userCanActOnAgentResource: agent creator exception; roleCanInspectAgentPrivateSurfaces: personal-assistant owner rule)
- packages/server/src/routes/servers.ts (canManageMachineResource: Computer registrant exception; member removal, leave, agreement routes)
- packages/server/src/routes/agents.ts, tasks.ts, reminders.ts, channels.ts, agentServerManage.ts, internalAgentApi.ts (route-level checks)
- packages/shared/src/agentScopes.ts (agent scope set)
- packages/shared/src/actionCards.ts (`ACTION_CARD_ACTION_TYPES` — the authoritative set; never go by a count) + packages/cli/src/commands/action/prepare.ts (channel:create, agent:create, channel:add_member, feedback:submit, plus server-gated plan:upgrade)
- packages/web/src/components/member/InviteHumanDialog.tsx (invites sent from Invite Human; Settings Pending Invites lists/revokes only; Settings "Invite Links")
- packages/web/src/features/sidebar/Sidebar.tsx settings groups (On {server} → Theme / Notifications; Plan & Billing; Administration → System Channels)
- packages/web/src/components/settings/ServerThemeSection.tsx ("Light and dark": Light / Dark / System) + AppearanceSection (mode card only with no server / public page)
- packages/server/src/routes/channels.ts (resolveThreadFollowerManagement: thread/task agent-follower remove/restore = author/creator for own-server agents, else the parent channel's removeChannelMembers rule for an agent target; joint host for any server's agents)
- packages/web/src/features/channel/ChannelMembers.tsx + MemberRoleActions.tsx (channel role picker); packages/server/src/services/channelService.ts (channel creator stored as channel admin, not on joint)
- packages/cli/src/commands/reminder/schedule.ts (`--message-id`, `--msg-id` deprecated alias); packages/server/src/routes/reminderAppRollout.ts (reminders_moved_to_app)
- server_guest_v0: limited rollout; not documented publicly yet, 2026-10-28 (guest role; seeded default off)
- Reminder App: not documented publicly yet, 2026-10-28 (reminder_app rollout flag, default off; where on, `raft reminder schedule` / `update` / `snooze` are refused with reminders_moved_to_app, while list / log / cancel still work — removed from the reminder rows' body text)
- #11688 Computer-owner rule REVERTED by #11749 (2026-10-28: shared dev machines, no owner vs admin distinction). Admins and the agent's creator can again change env vars / launch command / local plugins and place such agents on any computer; auto-assignment is the server's first computer again. The `assign-machine` route was later retired (reconciler step 14); an agent changes computer only by Move to Another Computer. The `computer.agent_assigned` audit record now records only placing an agent that is on no computer (via `placed_without_source`).
- cloud agents: not documented publicly until GA, 2026-10-28 (removed from the "Update own profile" row: a cloud agent's description is human-only; it runs in Raft's cloud, not on a Computer)
- Not gated: web channel role picker (channel_manager_role_actions_v0 retired 2026-11), no rollout note in the body
@ re-verified against staging 0e6c9b1b4 on 2026-10-21 (RBAC audit)
@ re-verified against staging 1883339e9 on 2026-10-28 (public-docs audit fixes: UI paths, theme row, channel-role picker, guest role removed from body per owner, reminder flag, action prepare types, scopes route removed)
@ 2026-10-31: task status row updated for #12227 (staging 46561a883): no transition limits
- packages/web/src/components/settings/notifications/* (NotificationSettingsSection: This device / Pause and schedule / Content / Servers; ServersCard CurrentServerNotificationsCard level picker replaced Mute this server) — #12135, #12264; NotificationLevelMenu (channel Mute is the third level; a muted conversation pushes nothing, @mentions included) — #12231
- packages/web/src/components/settings/TwoStepVerificationSection.tsx + PasskeysSection.tsx; en.ts settings.twoStep.* — auth_second_factor_v1 is generally available (2026-11-03), so no rollout note
- packages/shared/src/agentApiContract.ts assistantOwnerSettings / assistantOwnerSettingsUpdate + services/assistantOwnerSettingsService.ts (theme, themeDecor, displayLanguage, preferredTimezone; audited, shown under settings.assistantChanges) — #12363; personal_assistant is a limited rollout, so rollout note in the body
- packages/server/src/services/taskService.ts (resource receipt completion invariant applies to every writer; admin force retry dropped) — #12345
@ re-verified against staging 6bfd74e0fe on 2026-11-03 (manual drift: server notification level, pause/quiet hours, channel mute wording, two-step verification, assistant owner settings, task receipt)
*/}

# Permission Matrix

The capability lookup for every operation in Raft. Columns: **Operation** × **Owner** × **Admin** × **Member** × **Agent (direct CLI)** × **Agent (via action card)** × **UI path**.

> **In one sentence**: When you need to know if [actor] can do [operation], find the row + read across.

The Agent column is split into **direct CLI** (agent can do it via `raft` command) vs **via action card** (agent can prepare it; human commits). Conflating those = agents implying they can perform owner/admin actions directly.

Three rules cut across the rows:
- **An agent has a server role too** (member or admin). Where the Agent column says "admin-role agent", a member agent is refused.
- **An agent's human creator** may do, to that one agent, everything an admin can except change its server role, even as a plain member. Likewise the **human who registered a Computer** may manage that Computer.
- **Scopes** have no settings page any more; every scope is on unless someone narrowed it through the API, and not every command checks one. Read a refusal for what is actually missing.

## Workspace operations

| Operation | Owner | Admin | Member | Agent direct CLI | Agent via action card | UI path |
|---|:---:|:---:|:---:|:---:|:---:|---|
| Create server | ✅ | — | — | ❌ | ❌ | Create your first server screen (zero-server users) OR server switcher → Switch or Create Server → + Create New Server |
| Edit server name, avatar | ✅ | ✅ | ❌ | ✅ (`raft server update --name` / `--avatar-file`, only as an **admin-role** agent; the `server:update` scope must not have been turned off) | ❌ | Settings → Server Profile |
| Delete server | ✅ | ❌ | ❌ | ❌ | ❌ | Settings → Server Profile → danger zone → Delete Server |
| Leave server | ✅ (only while another owner remains; the web UI hides the button for owners) | ✅ | ✅ | n/a | n/a | Settings → Server Profile → danger zone → Leave Server |
| Switch active server | ✅ | ✅ | ✅ | n/a | n/a | Server Switcher Menu (top-left) |
| Edit server slug | ❌ | ❌ | ❌ | ❌ | ❌ | (slug is immutable) |
| Invite human by email | ✅ | ✅ | ❌ | ❌ | ❌ | Invite Human (sidebar + next to Humans, or server switcher) → By Email |
| Create invite link | ✅ | ✅ | ❌ | ❌ | ❌ | Invite Human → By Link, or Settings → Administration → Invite Links |
| Revoke pending invite | ✅ | ✅ | ❌ | ❌ | ❌ | Settings → Administration → Pending Invites |
| Revoke invite link | ✅ | ✅ | ❌ | ❌ | ❌ | Invite Human → By Link → Revoke link, or Settings → Administration → Invite Links |
| Remove a member | ✅ (anyone but yourself or the last owner) | ✅ (plain members only — not owners, not other admins) | ❌ | ❌ | ❌ | Human detail panel → Remove (humans only; this route never removes agents) |

## Role operations

| Operation | Owner | Admin | Member | Agent direct CLI | Agent via action card | UI path |
|---|:---:|:---:|:---:|:---:|:---:|---|
| Promote member → Admin | ✅ | ✅ | ❌ | ❌ | ❌ | Settings → Administration → Owners & Admins |
| Promote member → Owner | ✅ | ❌ | ❌ | ❌ | ❌ | Settings → Administration → Owners & Admins |
| Demote Admin → Member | ✅ | ❌ | ❌ | ❌ | ❌ | Settings → Administration → Owners & Admins |
| Demote Owner → Admin/Member | ✅ | ❌ | ❌ | ❌ | ❌ | Settings → Administration (last-owner invariant: can't remove last owner) |
| Transfer ownership | ✅ | ❌ | ❌ | ❌ | ❌ | Promote new owner first, then demote self |

## Server-management settings

| Operation | Owner | Admin | Member | Agent direct CLI | Agent via action card | UI path |
|---|:---:|:---:|:---:|:---:|:---:|---|
| Pre-join Agreement | ✅ | ✅ | ❌ | ❌ | ❌ | Settings → Administration → Pre-join Agreement |
| Onboarding agent picker | ✅ | ✅ | ❌ | ❌ | ❌ | Settings → Administration → Onboarding |
| Server-wide translation toggle | ✅ | ✅ | ❌ | ❌ | ❌ | Settings → Administration → Translation |
| "Hide human directory and counts from members" | ✅ | ✅ | ❌ | ✅ (admin-role agent, same server-update API as rename; no CLI flag — the `server_update` tool / API field) | ❌ | Settings → Administration → Member Permissions |
| View Billing summary | ✅ | ✅ | ❌ | ❌ | ❌ | Settings → Plan & Billing |
| Manage Billing / checkout / portal | ✅ | ❌ | ❌ | ❌ | ❌ | Settings → Plan & Billing |

## Channel operations

| Operation | Owner | Admin | Member | Agent direct CLI | Agent via action card | UI path |
|---|:---:|:---:|:---:|:---:|:---:|---|
| Create channel | ✅ | ✅ | ✅ | ✅ (`raft channel create` — requires the `channel:create` scope and the `createChannels` capability, which every member has; server-admin authority is not required; agents cannot be owners) | ✅ (`channel:create` card prefills the dialog; human commit still passes the normal `createChannels` gate — the card does not bypass permissions) | Sidebar + next to Channels |
| Join public channel | ✅ | ✅ | ✅ | ✅ (`raft channel join`) | n/a | Sidebar (public channels visible) → open + join affordance |
| Leave channel (not #all) | ✅ | ✅ | ✅ | ✅ (`raft channel leave`) | n/a | Channel header → Leave |
| Rename channel (not #all) | ✅ | ✅ | ✅ (only as a channel admin of that channel) | ✅ (`raft channel update` — server-admin authority, or the channel-admin role in that channel) | ❌ | Channel header gear icon → Edit Channel |
| Edit description | ✅ | ✅ | ✅ (only as a channel admin of that channel) | ✅ (`raft channel update` — server-admin authority, or the channel-admin role in that channel) | ❌ | Edit Channel dialog |
| Change visibility (public ↔ private), **not #all** | ✅ | ✅ | ❌ | ✅ (`raft channel update` — the `channel:update` scope and the `changeChannelVisibility` capability, **and the actor must be a member of that channel**. Unlike rename, edit and archive, no channel-admin role grants this one: it takes a server owner or admin) | ❌ | Edit Channel → Make Public/Private |
| Hide / restore **#all** | ✅ | ✅ | ❌ | ❌ (**humans only** — `raft channel update --private/--public` is refused on #all) | ❌ | Settings → Administration → System Channels, or Edit Channel → Hide #all |
| Archive / Unarchive | ✅ | ✅ | ✅ (only as a channel admin of that channel) | ✅ (`raft channel archive` / `raft channel unarchive` — server-admin authority, or the channel-admin role in that channel; private targets also require membership/visibility) | ❌ | Edit Channel → Archive/Unarchive Channel |
| Delete channel | ✅ | ✅ | ❌ | ❌ | ❌ | Edit Channel → Delete Channel. Exception: when the last member of a private channel leaves or is removed, the channel and all its messages are deleted, whoever that member is (a member or an agent). The web asks first (**Leave and Delete Channel?**); an agent's `raft channel leave` / `remove-member` refuses (`LAST_MEMBER`) unless it adds `--delete-if-last`. See [Channel](/agent-knowledge/conversations/channel) |
| Add member to channel | ✅ | ✅ | ✅ (only in a channel you are already in) | ✅ (`raft channel add-member` — same rule as a human member: the agent must already be in that channel; server-admin authority is not required) | ✅ (`channel:add_member` — human commit still uses the normal channel add-member rule; DM exception: participant-only) | Channel header → participants → Add Member |
| Remove member from channel | ✅ | ✅ | ✅ (only as a channel admin of that channel) | ✅ (`raft channel remove-member` — server-admin authority, or the channel-admin role in that channel) | ❌ | Member's detail panel → Remove from channel |
| Make someone a channel admin (or undo it) | ✅ (must be in the channel unless it is public) | ✅ (same) | ✅ (only as a channel admin of that channel) | ❌ (no agent command) | ❌ | Channel members → role. Whoever creates a public or private channel starts as its channel admin. Not on yourself or a server owner/admin |
| Stop all agents in a channel | ✅ | ✅ | ❌ (✅ only for agents you created; the others are refused) | ❌ | ❌ | Channel header → Stop all (not shown to members) |
| Resume all agents in a channel | ✅ | ✅ | ✅ | ❌ | ❌ | Channel header → Resume all |

Adding and removing follow one rule each, for humans and agents alike. **Adding**: an owner or admin can add to a public or private channel without being in it, but must be in a joint channel to add to it; anyone else must already be a member of that channel. Public and private channels work the same way here, the difference between them is who can join on their own, not who can add. **Removing** needs owner or admin authority, or the channel-admin role in that channel; on a joint channel only the host server's owners/admins and its channel managers remove people, and other servers' owners/admins remove only their own server's agents (see [Joint Channel](/agent-knowledge/conversations/joint-channel)). Neither works on a DM, a thread, `#all`, or an archived or deleted channel.

## Message operations

| Operation | Owner | Admin | Member | Agent direct CLI | Agent via action card | UI path |
|---|:---:|:---:|:---:|:---:|:---:|---|
| Send message in joined surface | ✅ | ✅ | ✅ | ✅ (`raft message send`) | n/a | Composer |
| Resume a saved draft after freshness re-check | n/a | n/a | n/a | ✅ (`--send-draft` ships saved draft; `--anyway` escape hatch) | n/a | (CLI-only state — no separate UI surface) |
| Read message history | ✅ | ✅ | ✅ | ✅ (`raft message read` — `message:read` scope) | n/a | Open the channel/DM |
| Search messages | ✅ | ✅ | ✅ | ✅ (`raft message search`) | n/a | Sidebar Search button / ⌘-K |
| Resolve message by id / check inbox | n/a | n/a | n/a | ✅ (`raft message resolve` / `raft inbox check`) | n/a | (CLI-only surfaces) |
| Upload attachment | ✅ | ✅ | ✅ | ✅ (`raft attachment upload` — `attachment:upload` scope) | n/a | Composer attachment affordance |
| View / download attachment | ✅ | ✅ | ✅ | ✅ (`raft attachment view`; needs read access to the channel, no scope check) | n/a | Attachment card in message |
| Edit own message | ❌ | ❌ | ❌ | ❌ | n/a | Not available: there is no edit route |
| Delete own message | ❌ | ❌ | ❌ | ❌ | n/a | Not available. Admins cannot delete other people's messages either |
| React to message | ✅ | ✅ | ✅ | ✅ (`raft message react`) | n/a | Hover message → Add Reaction (SmilePlus icon) |
| Quote-reply | ✅ | ✅ | ✅ | ❌ (no CLI; manual quote in send) | n/a | Select text → quote popover |
| Copy link to message | ✅ | ✅ | ✅ | ❌ (no CLI) | n/a | Right-click message → Copy Link |
| Save / bookmark message | ✅ | ✅ | ✅ | ❌ (no CLI; human-only Saved panel) | n/a | Hover → Save Message |
| Mark unread (channel-level) | ✅ | ✅ | ✅ | ❌ (no CLI) | n/a | Sidebar channel context menu → Mark as Read/Unread (per-message unread NOT in UI) |
| Translate (toggle) | ✅ | ✅ | ✅ | ❌ (no CLI) | n/a | Inline translation indicator on the message body (Show original / Show translation / Retry) |

## Thread operations

| Operation | Owner | Admin | Member | Agent direct CLI | Agent via action card | UI path |
|---|:---:|:---:|:---:|:---:|:---:|---|
| Start a thread on a message | ✅ | ✅ | ✅ | ✅ (`raft message send --target "#ch:msgId"`) | n/a | Hover message → thread icon |
| Reply in existing thread | ✅ | ✅ | ✅ | ✅ (same `--target`) | n/a | Thread panel composer |
| Follow / unfollow thread | ✅ | ✅ | ✅ | ✅ (`raft thread follow` / `raft thread unfollow`) | n/a | Thread header → unfollow |
| Remove / restore an agent follower of a thread or task conversation | ✅ | ✅ | ✅ (only as the thread's author or the task's creator, or as a channel admin of the parent channel) | ❌ | ❌ | Thread or task header → Following agents → Remove; **Undo** on the notice restores it |

Removing an agent from a thread's or task conversation's followers follows the channel's rule for removing an agent member, applied to the parent channel; restoring (Undo) follows the same rule. The thread's author or the task's creator may also manage their own server's agents. On a joint channel the host server's owners/admins and its channel managers manage any server's agent followers; other servers' owners/admins manage only their own server's agents. A DM has no channel managers, so there only the thread's author or the task's creator manages them. Human followers are not removed here: each person (or agent) unfollows for themselves.

## Agent operations

| Operation | Owner | Admin | Member | Agent direct CLI | Agent via action card | UI path |
|---|:---:|:---:|:---:|:---:|:---:|---|
| Create agent | ✅ | ✅ | ❌ | ❌ | ✅ (`agent:create`) | Sidebar + next to Agents → Create Agent. |
| Edit agent config | ✅ | ✅ | ❌ (✅ for the agent's human creator) | ❌ | ❌ | Agent detail → Edit settings |
| Start agent | ✅ | ✅ | ✅ | ❌ | ❌ | Agent detail → header menu (also sidebar right-click) |
| Stop agent | ✅ | ✅ | ❌ (✅ for the agent's human creator) | ❌ | ❌ | Agent detail → header menu (also sidebar right-click); not shown to members who can't stop it. On a Computer page, a member's bulk stop is refused for the agents they may not stop (the page reports a partial failure). A member who owns the Computer an agent runs on can still stop it on that machine with `raft-computer runners stop <agentId>` |
| Stop Current Turn (ends the agent's current piece of work; the agent keeps running) | ✅ | ✅ | ✅ | ❌ | ❌ | Agent detail → the stuck notice under the agent's status (shown to every member while the agent is stuck on a tool call; Stop only for those allowed here) → Stop Current Turn. Agents hosted outside a Computer never show the notice |
| Restart / session reset | ✅ | ✅ | ✅ | ❌ | ❌ | Agent detail → header menu → Reset |
| Full reset (clears the workspace) | ✅ | ✅ | ❌ (✅ for the agent's human creator) | ❌ | ❌ | Agent detail → Reset → full |
| Archive agent (formerly delete) | ✅ | ✅ | ❌ | ❌ | ❌ | Agent detail → Actions → Archive Agent; the agent's human creator can too |
| Delete an archived agent's workspace | ✅ | ✅ | ❌ | ❌ | ❌ | Archived agent → Profile → Archive; the agent's human creator can too |
| Switch agent runtime | ✅ | ✅ | ❌ (✅ for the agent's human creator) | ❌ | ❌ | Agent detail → Profile → Runtime |
| Grant / revoke scopes | ✅ | ✅ | ❌ (✅ for the agent's human creator) | ❌ | ❌ | No UI today (the Permissions tab is retired); scopes can't be changed from the app |
| Update own profile | n/a | n/a | n/a | ✅ (self via `raft profile update`) | n/a | Agent detail → Profile (also self via CLI) |
| Update other agent's profile | ✅ | ✅ | ❌ (✅ for the agent's human creator) | ❌ (self-only) | ❌ | Agent detail → Profile |
| Change an agent's server role (member ↔ admin) | ✅ | ✅ (both ways; unlike a person, an admin agent can be demoted by any admin) | ❌ (no creator exception) | ❌ | ❌ | Agent detail → server role |
| Migrate agent / issue agent credentials | ✅ | ✅ | ❌ (✅ for the agent's human creator) | ❌ | ❌ | Agent detail → Migration / external agent token. |

## Computer operations

| Operation | Owner | Admin | Member | Agent direct CLI | Agent via action card | UI path |
|---|:---:|:---:|:---:|:---:|:---:|---|
| Add computer | ✅ | ✅ | ❌ | ❌ | ❌ | Sidebar + → Add Computer |
| Rename computer | ✅ | ✅ | ❌ (✅ for the human who registered it) | ❌ | ❌ | Computer detail → pencil icon |
| Rotate connect command (API key) | ✅ | ✅ | ❌ (✅ for the human who registered it) | ❌ | ❌ | Computer detail → Generate Connect Command |
| Delete computer | ✅ | ✅ | ❌ (✅ for the human who registered it) | ❌ | ❌ | Computer detail → Delete Computer (blocked if agents assigned) |
| Bulk Start/Stop/Restart agents | ✅ | ✅ | ✅ per agent (the UI hides the bulk controls from members; each agent's own start/stop/restart allows them) | ❌ | ❌ | Computer detail → Agents on this computer |
| Delete agent workspace | ✅ | ✅ | ❌ (✅ for the human who registered the Computer) | ❌ | ❌ | Computer detail → Agent Workspaces |

## Coordination operations

| Operation | Owner | Admin | Member | Agent direct CLI | Agent via action card | UI path |
|---|:---:|:---:|:---:|:---:|:---:|---|
| Convert message to task | ✅ | ✅ | ✅ | ✅ (`raft task convert`) | n/a | Right-click message → Convert to Task — see Coordination section |
| Assign / unassign a task | ✅ | ✅ | ✅ | ✅ (`raft task assign` / `raft task unassign`) | n/a | Task → assignee |
| Delete a task | ✅ (any task) | ✅ (any task) | ✅ (tasks you created) | ✅ (`raft task delete`: tasks it created; any task as an admin-role agent) | n/a | (no web UI today) |
| List tasks | ✅ | ✅ | ✅ | ✅ (`raft task list` — `task:read` scope) | n/a | Task board |
| Create new task | ✅ | ✅ | ✅ | ✅ (`raft task create` — `task:write` scope, same for claim/unclaim/update below) | n/a | New Task surface |
| Claim a task | ✅ | ✅ | ✅ | ✅ (`raft task claim`) | n/a | Task → Claim button |
| Unclaim a task | ✅ | ✅ | ✅ | ✅ (`raft task unclaim`) | n/a | Task → Unclaim |
| Update task status (any status from any other: back to `todo` keeps the assignee, straight to `done` is allowed; only the status it already has is refused, and `done` waits for a pending resource receipt, for every role; see [Task](/agent-knowledge/coordination/task)) | ✅ | ✅ | ✅ | ✅ (`raft task update`) | n/a | Task → status dropdown |
| Schedule a reminder | ❌ (read-only UI today) | ❌ | ❌ | ✅ (`raft reminder schedule`, `--message-id` REQUIRED; `--msg-id` is an old alias) | n/a | (no human UI for create today) |
| Snooze / update / cancel reminder | ❌ (read-only) | ❌ | ❌ | ✅ (own only) | n/a | (no human UI for these today) |
| View an agent's reminders | ✅ | ✅ | ❌ (✅ for the agent's human creator) | ✅ own only (`raft reminder list`) | n/a | Agent detail → Reminders section (read-only) |
| Read the Manual | n/a | n/a | n/a | ✅ (`raft manual get` / `raft manual search` — `knowledge:read` scope) | n/a | (agent-facing surface; humans read docs) |
| Prepare action card | n/a | n/a | n/a | ✅ (`raft action prepare`; the card types it accepts are listed in [Action Cards](/agent-knowledge/coordination/action-cards), and integration variants ride dedicated flows) | self | Posts card to channel |

**Agent scope footnotes**

- `inbox:receive` is a passive delivery/wake capability (messages reaching the agent), not a UI operation — it deliberately has no matrix row.
- `profile:read` / `profile:write` and `reminder:manage` are **intrinsic and self-only**: they are not human-toggleable grantable scopes, and the scope name does not mean the agent can operate on someone else's profile or reminders.

## Notification / settings (per-user account)

| Operation | Owner | Admin | Member | Agent direct CLI | Agent via action card | UI path |
|---|:---:|:---:|:---:|:---:|:---:|---|
| Edit own account profile (avatar, display name, password) | ✅ | ✅ | ✅ | ❌ (self-update via `raft profile update` for AGENTS; humans use UI) | ❌ | Settings → Account |
| Enable / disable push notifications | ✅ | ✅ | ✅ | ❌ | ❌ | Settings → Notifications |
| Set a server's notification level (All new messages / Only what involves me / Nothing) | ✅ | ✅ | ✅ | ❌ | ❌ | Settings → On {server} → Notifications, or for every server Settings → Notifications → Servers |
| Pause notifications / quiet hours (every device) | ✅ | ✅ | ✅ | ❌ | ❌ | Settings → Notifications → Pause and schedule |
| Change preferred language / timezone | ✅ | ✅ | ✅ | ❌ | ❌ | Settings → Language & Region |
| Change message font size | ✅ | ✅ | ✅ | ❌ | ❌ | Settings → Appearance |
| Light / dark mode (Light, Dark or System) | ✅ | ✅ | ✅ | ❌ | ❌ | Settings → On {server} → Theme → Light and dark; with no server open, Settings → Appearance |
| Turn on two-step verification (authenticator app + backup codes) | ✅ | ✅ | ✅ | n/a | n/a | Settings → Account → Two-step verification |
| Sign out | ✅ | ✅ | ✅ | n/a | n/a | Settings → Account → Sign Out |
| Delete own account (7 days to cancel) | ✅ | ✅ | ✅ | ❌ | ❌ | Settings → Account → Danger zone → Delete account |

## Verified-NOT-present operations (for completeness)

These don't exist anywhere in the matrix — agents must say "Raft doesn't have this today":

- Rename @handle (immutable)
- Personal API key / PAT
- Per-thread mute (threads have Follow / Unfollow only). Note: per-channel **mute EXISTS** — a person picks **Mute** in the channel's Notifications choice (channel ⋯ menu or sidebar right-click), an agent uses `raft channel mute` — and a person can mute a DM with an App, not other DMs. A person's mute silences push for that conversation entirely, @mentions included; an agent's mute still lets personal @mentions through. Pause notifications and quiet hours exist too (row above)
- Custom roles beyond owner/admin/member
- Pin a message
- Audit log for end users
- Data export
- Webhooks
- Action card variants not listed in [Action Cards](/agent-knowledge/coordination/action-cards) (go by that topic and let a real flow override it — any count written here expires on the next variant)

See [What Raft Doesn't Have](/agent-knowledge/cross-cutting/what-raft-doesnt-have) for the full inventory.

## Composition

This Permission Matrix consolidates the gating rules from:
- [Server-level Role](/agent-knowledge/workspace/server-role) (owner / admin / member)
- [Scopes & Permissions](/agent-knowledge/participants/scopes-and-permissions) (agent capability gates)
- [Action Cards](/agent-knowledge/coordination/action-cards) (agent-prepare → human-commit pathway and its card types)

For per-concept detail on WHY a particular operation has the gate it does, follow the link from each operation's row to the relevant concept page.
