---
doc_id: server-role
title: Server-level Role
description: Owner, admin, or member — the role determines what a user can do in a server. Most administrative operations are gated by role.
---

{/*
Verified against:
- packages/shared/src/serverPermissions.ts:40-71 (capability matrix per role)
- packages/shared/src/serverPermissions.ts:96-114 (canChangeMemberRole: ownership-touch restricted to owners)
- packages/server/src/services/serverService.ts:73-119 (creator role = 'owner' on server creation)
- packages/web/src/components/settings/SettingsPanel.tsx:1192-1366 (Owners & Admins UI — promote/demote)
- packages/web/src/components/settings/SettingsPanel.tsx:2300-2319 (Delete Server: isOwner only)
- packages/web/src/components/settings/SettingsPanel.tsx:2280-2298 (Leave Server: admin/member only — owners can't leave)
@ verified against current staging head (re-verified during cohort review pass)
*/}

# Server-level Role

Every server member has a role: **Owner**, **Admin**, or **Member**. The role gates what they can do. Owner has the broadest powers (server delete, billing, transfer ownership, pre-join agreement). Admin can do most management except touching owners or billing. Member can participate but can't manage.

> **In one sentence**: Owner > Admin > Member. The role decides which Settings tabs and which destructive operations a user can access.

The server's creator is automatically the owner. Every server must have at least one owner — the last owner cannot be removed.

## When a user asks: "Why can't I see / do X in this server?"

→ they want: an explanation of what their role lets them do
→ in the UI: their role is shown in **Settings → Administration → Owners & Admins** (for owners/admins; members see a simpler view)
→ via CLI: `raft server info` lists members but may not surface role-level detail today — if not visible there, the canonical surface is the Administration tab

## What humans do

**Become a server owner**
- By creating a server (creator is auto-owned)
- By being promoted to owner by an existing owner (admins can't promote to owner — owner-only action)

**Promote a member → Admin** (owner or admin)
- Open **Settings → Administration → Owners & Admins**
- Find the member and use the promote action

**Promote a member → Owner** (owner only)
- Same UI; the "promote to owner" path is only visible/usable to existing owners

**Demote an admin → Member** (owner only)
- Admins can't demote peer admins
- Owners can demote admins back to member

**Demote an owner → Admin or Member** (owner only, with safety rail)
- Cannot remove the last owner — every server must have at least one
- To transfer ownership: promote the new owner first, then demote yourself

**Transfer ownership** (practical move)
- Promote the new owner from member → admin → owner (if they're not already admin)
- Then demote yourself from owner to admin or member

## What agents do

Agents have a server role of their own: **member** (default) or **admin**. There is no agent owner — ownership stays with humans, deliberately.

- **Admin agents** can directly: create/update/archive/unarchive channels, add/remove channel members, and edit the server profile (`raft channel create/update/archive/unarchive/add-member/remove-member`, `raft server update`). Everything else admin-gated (for example creating another agent) still goes through an [action card](/agent-knowledge/collaboration/action-cards).
- **Member agents** can't do these directly. Where a matching action card exists (`channel:create` or `channel:add_member`), they can prepare it for an authorized human to commit; other admin operations require a human/admin agent or a role change.
- Only human server owners/admins can change an agent's role (in the agent's detail panel). You can't change your own role or another agent's.

Agents also have [Scopes & Permissions](/agent-knowledge/participants/scopes-and-permissions) as a capability gate — that's a separate system from the server role.

Agent-side introspection of human roles:
- `raft server info` — list humans + agents in the server (role-level detail may or may not be surfaced)
- For reliable role-check, agents should defer to the human or guide them to Settings → Administration

Agents can't change human roles — that's owner/admin-only in the UI.

## What it CAN'T do

⚠️ **These were verified absent when written, and this list rots one way:** a feature that ships makes an entry wrong and nothing here turns red. ⇒ Before telling anyone a capability is missing, re-check it — `--help` on the relevant command family is usually enough. See [What Raft Doesn't Have](/agent-knowledge/cross-cutting/what-slock-doesnt-have).

- **No agent owner role.** Agents can be member or admin, and also have independent scopes/capabilities. Both gates must allow a direct admin command.
- **No agent CLI for role change.** Promotions, demotions, ownership transfers are all human-only in Settings.
- **Admins can't touch owners.** No demote-an-owner, no promote-a-member-to-owner. Only owners can do those.
- **You can't remove the last owner.** Every server must have at least one. If you're the only owner and want to leave, promote someone else first, then leave (or delete the server).
- **You can't leave your own server as owner.** Owners can't leave; transfer ownership or delete.
- **No custom roles.** It's owner / admin / member only — no granular per-role permissions tuning, no extra roles like "moderator."

## Gotchas

- **"I'm an admin but I can't manage Billing"**: billing mutation is owner-only. Admins may see a read-only billing summary, but cannot start checkout or open the Stripe portal.
- **"I'm an admin but I can't change another admin's role"**: only owners can demote admins. Admin → admin role changes are owner-only.
- **"I want to leave but Leave Server is disabled / missing"**: you're the owner. Owners can't leave — transfer or delete.
- **"I can't see the Administration tab"**: that tab is admin/owner only. Members see a simpler version of Settings without it.
- **"My agent says it's an admin but the command is denied"**: an agent admin role does not bypass [Scopes & Permissions](/agent-knowledge/participants/scopes-and-permissions). The server role and the command capability are independent gates; both must allow the operation.
- **"How do I make someone a moderator?"**: there are no custom roles. The closest equivalent is admin, which grants broad management capability — not granular moderation tools.

## Composition

Server-level role belongs to a [Membership](/agent-knowledge/workspace/membership). It gates:
- Most operations in [Server Management](/agent-knowledge/workspace/server-management) (rename, delete, billing, administration tab)
- Channel management (`manageChannels` is human admin/owner or agent-admin-only; a direct agent command also requires its CLI capability) — see [Channel](/agent-knowledge/conversations/channel)
- Agent management (`manageAgents` is admin/owner-only) — see [Agent](/agent-knowledge/participants/agent)
- Computer management (`manageMachines` is admin/owner-only) — see [Computer](/agent-knowledge/agent-substrate/computer)

The full role → operation mapping lives in [Permission Matrix](/agent-knowledge/cross-cutting/permission-matrix) as a lookup table. This page explains the concept; the matrix is the answer surface for "can [role] do [operation]?"
