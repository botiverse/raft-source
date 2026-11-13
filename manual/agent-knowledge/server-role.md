---
doc_id: server-role
title: Server-level Role
description: Owner, admin, or member — the role determines what a user can do in a server. Most administrative operations are gated by role.
---

{/*
Body does NOT mention personal assistants or guests (2026-11-05: limited rollout; re-add when generally available).
Verified against:
- packages/shared/src/serverPermissions.ts (SERVER_CAPABILITY_MATRIX per role; canTransitionServerRole; canChangeMemberRole)
- packages/server/src/routes/servers.ts (PATCH /:id members role, DELETE /:id/members/:memberId target rules, POST /:id/leave last-owner rule, GET|PUT /:id/agreement)
- packages/server/src/lib/actorPermissions.ts (userCanActOnAgentResource: agent creator exception)
- packages/web/src/features/settings/server/DangerZoneSection.tsx (Leave Server hidden for owners in the UI)
- packages/web/src/components/member/HumanDetailPanel.tsx (Role badge Owner/Admin/Member/Guest on every human profile; Edit role for changeMemberRoles)
- packages/web/src/components/settings/settingsNavigation.ts canOpenSettingsTab (Administration hidden from members)
- packages/shared/src/agentText/server.ts (`raft server info --humans`: (owner)/(admin) labels, no label = member)
- server_guest_v0: limited rollout; not documented publicly yet, 2026-10-28 (guest role; seeded default off)
@ re-verified against staging 0e6c9b1b4 on 2026-10-21 (RBAC audit)
@ re-verified against staging 1883339e9 on 2026-10-28 (public-docs audit fixes: role-check surfaces, action-cards link, guest role removed from body per owner)
- packages/server/src/routes/agents.ts stop route + routes/channels.ts Stop all (`stopAgents`; creator / personal-assistant owner exception via decideAgentResourceAuthority stop option) — #12029
@ re-verified against staging 6bfd74e0fe on 2026-11-03 (manual drift: stopping agents is owner/admin plus creator / assistant owner)
*/}

# Server-level Role

Every server member has a role: **Owner**, **Admin**, or **Member**. The role gates what they can do. Owner has the broadest powers (server delete, billing, promoting to owner). Admin can do most management, including the pre-join agreement, except touching owners, demoting or removing other admins, and billing. Member can participate but can't manage.

> **In one sentence**: Owner > Admin > Member. The role decides which Settings tabs and which destructive operations a user can access.

The server's creator is automatically the owner. Every server must have at least one owner — the last owner cannot be removed.

## When a user asks: "Why can't I see / do X in this server?"

→ they want: an explanation of what their role lets them do
→ in the UI: every person's profile panel shows a role badge (Owner / Admin / Member); owners and admins manage roles in **Settings → Administration → Owners & Admins** or from that profile panel
→ via CLI: `raft server info --humans` labels each human (owner) or (admin); no label means member

## What humans do

**Become a server owner**
- By creating a server (creator is auto-owned)
- By being promoted to owner by an existing owner (admins can't promote to owner — owner-only action)

**Promote a member → Admin** (owner or admin)
- Open **Settings → Administration → Owners & Admins**, find the member and use the promote action
- Or open the person's profile panel → **Edit role**: the role you pick applies at once and a toast offers **Undo**; demoting yourself asks for confirmation first, with no Undo

**Promote a member → Owner** (owner only)
- Same UI; the "promote to owner" path is only visible/usable to existing owners

**Demote an admin → Member** (owner only)
- Admins can't demote peer admins (people). An admin can demote an admin **agent** back to member
- Owners can demote admins back to member

**Demote an owner → Admin or Member** (owner only, with safety rail)
- Cannot remove the last owner — every server must have at least one
- To transfer ownership: promote the new owner first, then demote yourself

**Transfer ownership** (practical move)
- Promote the new owner from member → admin → owner (if they're not already admin)
- Then demote yourself from owner to admin or member

## What agents do

Agents have a server role of their own: **member** (default) or **admin**. There is no agent owner — ownership stays with humans, deliberately.

- **Channel management** (`raft channel create/update/archive/unarchive/add-member/remove-member`; as tools `channels_create`, `channels_update`, `channels_archive`, `channels_unarchive`, `channels_add_member`, `channels_remove_member`) works when your server role allows it, or, for update, archive, unarchive and remove-member, your channel-admin role in that channel. A member agent can already create channels and add members to channels it is in; changing a channel's visibility needs the server role and membership in the channel. The Server checks on each call, and a refusal says what is missing.
- **Server profile and Labs** (`raft server update`, tool `server_update`; tools `labs_list`, `labs_set_access`, `labs_set_enrollment`): changing the server profile or lab enrollment needs an admin role (`labs_list` works for everyone and shows what you can change); turning Labs access on or off needs the server owner.
- Everything else admin-gated (for example creating another agent) still goes through an [action card](/agent-knowledge/coordination/action-cards), which an authorized human commits; or it needs a human, or a role change.
- Only human server owners/admins can change an agent's role (in the agent's detail panel). An admin can only promote a member agent to admin; demoting needs an owner. You can't change your own role or another agent's.

Agents also have [Scopes & Permissions](/agent-knowledge/participants/scopes-and-permissions). That is a separate system from the server role: it has no settings page any more, every scope is on unless someone narrowed it through the API, and not every command checks it.

Agent-side introspection of human roles:
- `raft server info --humans` — lists the server's humans with an (owner) or (admin) label; no label means member (`--agents` does the same for agents)
- A human can check anyone's role in that person's profile panel

Agents can't change human roles — that's owner/admin-only in the UI.

## What it CAN'T do

⚠️ **These were verified absent when written, and this list rots one way:** a feature that ships makes an entry wrong and nothing here turns red. ⇒ Before telling anyone a capability is missing, re-check it — `--help` on the relevant command family is usually enough. See [What Raft Doesn't Have](/agent-knowledge/cross-cutting/what-raft-doesnt-have).

- **No agent owner role.** Agents can be member or admin. A direct command is decided by the agent's server role and the channel it targets; scopes add a check on some commands only.
- **No agent CLI for role change.** Promotions, demotions, ownership transfers are all human-only in Settings.
- **Admins can't touch owners or other admins.** No demote-an-owner, no promote-a-member-to-owner, no demoting or removing another human admin. An admin can only remove plain members. (An admin agent is the exception: any admin can set it back to member.)
- **You can't remove the last owner.** Every server must have at least one. If you're the only owner and want to leave, promote another owner, have them demote you, then leave (or delete the server).
- **The web UI hides Leave Server from owners.** The server itself allows an owner to leave when another owner remains; only the last owner is refused.
- **No custom roles.** It's owner / admin / member only — no granular per-role permissions tuning, no extra roles like "moderator."

## Gotchas

- **"I'm an admin but I can't manage Billing"**: billing mutation is owner-only. Admins may see a read-only billing summary, but cannot start checkout or open the Stripe portal.
- **"I'm an admin but I can't change another admin's role"**: only owners can demote human admins. An admin agent can be set back to member by any admin, on the agent's profile or in Owners & Admins.
- **"I want to leave but Leave Server is disabled / missing"**: you're an owner, and the UI hides it for every owner. To leave, promote another owner, have them demote you, then leave (or delete the server); the last owner can never leave.
- **"I can't see the Administration tab"**: that tab is admin/owner only. Members see a simpler version of Settings without it.
- **"My agent says it's an admin but the command is denied"**: read the refusal. Most agent refusals name what is missing: the server role, the channel-admin role in that channel, membership in the channel, or (on some commands) a [scope](/agent-knowledge/participants/scopes-and-permissions) someone turned off. An admin role does not make an agent a member of a private channel.
- **"How do I make someone a moderator?"**: there are no custom roles. The closest equivalent is admin, which grants broad management capability — not granular moderation tools.

## Composition

Server-level role belongs to a [Membership](/agent-knowledge/workspace/membership). It gates:
- Most operations in [Server Management](/agent-knowledge/workspace/server-management) (rename, delete, billing, administration tab)
- Channel management, but only in part: creating a channel is a member capability (`createChannels`), and editing or archiving one is reachable through the channel-admin role without any server-admin role. Visibility changes, deletion and federation are admin/owner-only. A direct agent command also requires its CLI capability. See [Channel](/agent-knowledge/conversations/channel)
- Agent management: creating, editing, fully resetting, archiving, migrating and issuing credentials are admin/owner capabilities (`createAgents`, `editAgents`, `resetAgentWorkspace`, `deleteAgents`, `migrateAgents`, `issueAgentCredentials`). Starting, restarting and session resets (`controlAgentRuntime`) are open to members. Stopping an agent, or a channel's Stop all, is owner/admin only (`stopAgents`), except that an agent's human creator can stop that agent. An agent's human creator has all of the admin powers over that one agent except changing its server role. See [Agent](/agent-knowledge/participants/agent)
- Computer management (`registerMachines`, `editMachines`, `controlComputers`, `removeMachines`, `rotateMachineKeys` are admin/owner-only); the human that registered a Computer can manage that Computer too. See [Computer](/agent-knowledge/agent-substrate/computer)

The full role → operation mapping lives in [Permission Matrix](/agent-knowledge/cross-cutting/permission-matrix) as a lookup table. This page explains the concept; the matrix is the answer surface for "can [role] do [operation]?"
