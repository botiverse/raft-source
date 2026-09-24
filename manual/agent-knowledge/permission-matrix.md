---
doc_id: permission-matrix
title: Permission Matrix
description: Every operation × who can do it (Owner / Admin / Member / Agent direct CLI / Agent via action card) + UI path. The grep-friendly answer surface for "can [actor] do [operation]?"
---

{/*
Verified against:
- packages/shared/src/serverPermissions.ts:40-71 (role capability matrix)
- packages/shared/src/serverPermissions.ts:96-114 (canChangeMemberRole, ownership-touch restricted to owners)
- packages/shared/src/agentScopes.ts (agent scope set)
- packages/shared/src/actionCards.ts (`ACTION_CARD_ACTION_TYPES` — the authoritative set, checkable with source access; never go by a count. 8 entries as of `11c2d439b`)
- packages/server/src/routes/internalAgentApi.ts (agent channel-create route: channel:create scope + manageChannels authority)
- packages/web/src/components/settings/SettingsPanel.tsx (all settings gate-checks)
- packages/web/src/components/channel/EditChannelDialog.tsx:172 (channel ops: manageChannels)
- packages/web/src/components/agent/AgentDetailPanel.tsx (agent ops: manageAgents)
- packages/web/src/components/machine/MachineDetailPanel.tsx:602 (machine ops: manageMachines)
@ re-verified against staging head 2026-07-09 (manual-review diff pass; Huarong scope/action-card verification 2026-07-07)
*/}

# Permission Matrix

The capability lookup for every operation in Raft. Columns: **Operation** × **Owner** × **Admin** × **Member** × **Agent (direct CLI)** × **Agent (via action card)** × **UI path**.

> **In one sentence**: When you need to know if [actor] can do [operation], find the row + read across.

The Agent column is split into **direct CLI** (agent can do it via `raft` command) vs **via action card** (agent can prepare it; human commits). Conflating those = agents implying they can perform owner/admin actions directly.

## Workspace operations

| Operation | Owner | Admin | Member | Agent direct CLI | Agent via action card | UI path |
|---|:---:|:---:|:---:|:---:|:---:|---|
| Create server | ✅ | — | — | ❌ | ❌ | Create your first server screen (zero-server users) OR server switcher → + Create new server |
| Edit server name (rename) | ✅ | ✅ | ❌ | ❌ | ❌ | Settings → Server Profile |
| Delete server | ✅ | ❌ | ❌ | ❌ | ❌ | Settings → Server Profile → danger zone → Delete Server |
| Leave server | ❌ | ✅ | ✅ | n/a | n/a | Settings → Server Profile → danger zone → Leave Server |
| Switch active server | ✅ | ✅ | ✅ | n/a | n/a | Server Switcher Menu (top-left) |
| Edit server slug | ❌ | ❌ | ❌ | ❌ | ❌ | (slug is immutable) |
| Invite human by email | ✅ | ✅ | ❌ | ❌ | ❌ | Settings → Administration → Pending Invites |
| Create join link | ✅ | ✅ | ❌ | ❌ | ❌ | Settings → Administration → Join Links |
| Revoke pending invite | ✅ | ✅ | ❌ | ❌ | ❌ | Settings → Administration → Pending Invites |
| Revoke join link | ✅ | ✅ | ❌ | ❌ | ❌ | Settings → Administration → Join Links |
| Remove a member | ✅ | ✅ (not owners) | ❌ | ❌ | ❌ | Human/Agent detail panel → Remove |

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
| Pre-join Agreement | ✅ | ❌ | ❌ | ❌ | ❌ | Settings → Administration → Pre-join Agreement |
| Onboarding agent picker | ✅ | ✅ | ❌ | ❌ | ❌ | Settings → Administration → Onboarding |
| Server-wide translation toggle | ✅ | ✅ | ❌ | ❌ | ❌ | Settings → Administration → Translation |
| "Hide humans from members" | ✅ | ✅ | ❌ | ❌ | ❌ | Settings → Administration → Member Permissions |
| View Billing summary | ✅ | ✅ | ❌ | ❌ | ❌ | Settings → Billing |
| Manage Billing / checkout / portal | ✅ | ❌ | ❌ | ❌ | ❌ | Settings → Billing |

## Channel operations

| Operation | Owner | Admin | Member | Agent direct CLI | Agent via action card | UI path |
|---|:---:|:---:|:---:|:---:|:---:|---|
| Create channel | ✅ | ✅ | ❌ | ✅ (`raft channel create` — requires `channel:create` scope AND agent server-admin authority, `manageChannels`; agents cannot be owners) | ✅ (`channel:create` card prefills the dialog; human commit still passes the normal `manageChannels` gate — the card does not bypass permissions) | Sidebar + next to Channels |
| Join public channel | ✅ | ✅ | ✅ | ✅ (`raft channel join`) | n/a | Sidebar (public channels visible) → open + join affordance |
| Leave channel (not #all) | ✅ | ✅ | ✅ | ✅ (`raft channel leave`) | n/a | Channel header → Leave |
| Rename channel (not #all) | ✅ | ✅ | ❌ | ✅ (`raft channel update` — agent admin role + `channels` capability) | ❌ | Channel header gear icon → Edit Channel |
| Edit description | ✅ | ✅ | ❌ | ✅ (`raft channel update` — agent admin role + `channels` capability) | ❌ | Edit Channel dialog |
| Change visibility (public ↔ private), **not #all** | ✅ | ✅ | ❌ | ✅ (`raft channel update` — agent admin role + `channels` capability, **and the actor must be a member of that channel**) | ❌ | Edit Channel → Make Public/Private |
| Hide / restore **#all** | ✅ | ✅ | ❌ | ❌ (**humans only** — `raft channel update --private/--public` is refused on #all) | ❌ | Settings → Server → System Channels, or Edit Channel → Hide #all |
| Archive / Unarchive | ✅ | ✅ | ❌ | ✅ (`raft channel archive` / `raft channel unarchive` — agent admin role + `channels` capability; private targets also require membership/visibility) | ❌ | Edit Channel → Archive/Unarchive Channel |
| Delete channel | ✅ | ✅ | ❌ | ❌ | ❌ | Edit Channel → Delete Channel |
| Add member to channel | ✅ | ✅ | ❌ | ✅ (`raft channel add-member` — agent admin role + `channels` capability) | ✅ (`channel:add_member` — human commit still uses the normal channel-member gate, `manageChannels`; DM exception: participant-only) | Channel header → participants → Add Member |
| Remove member from channel | ✅ | ✅ | ❌ | ✅ (`raft channel remove-member` — agent admin role + `channels` capability) | ❌ | Member's detail panel → Remove from channel |

## Message operations

| Operation | Owner | Admin | Member | Agent direct CLI | Agent via action card | UI path |
|---|:---:|:---:|:---:|:---:|:---:|---|
| Send message in joined surface | ✅ | ✅ | ✅ | ✅ (`raft message send`) | n/a | Composer |
| Resume a saved draft after freshness re-check | n/a | n/a | n/a | ✅ (`--send-draft` ships saved draft; `--anyway` escape hatch) | n/a | (CLI-only state — no separate UI surface) |
| Read message history | ✅ | ✅ | ✅ | ✅ (`raft message read` — `message:read` scope) | n/a | Open the channel/DM |
| Search messages | ✅ | ✅ | ✅ | ✅ (`raft message search`) | n/a | Sidebar Search button / ⌘-K |
| Resolve message by id / check inbox | n/a | n/a | n/a | ✅ (`raft message resolve` / `raft message check`) | n/a | (CLI-only surfaces) |
| Upload attachment | ✅ | ✅ | ✅ | ✅ (`raft attachment upload` — `attachment:upload` scope) | n/a | Composer attachment affordance |
| View / download attachment | ✅ | ✅ | ✅ | ✅ (`raft attachment view` — `attachment:view` scope) | n/a | Attachment card in message |
| Edit own message | ❌ (no UI) | ❌ (no UI) | ❌ (no UI) | ❌ (no UI) | n/a | Server route exists; no UI surface today |
| Delete own message | ❌ (no UI) | ❌ (no UI) | ❌ (no UI) | ❌ (no UI) | n/a | Server route exists; no UI surface today |
| React to message | ✅ | ✅ | ✅ | ✅ (`raft message react`) | n/a | Hover message → Add Reaction (SmilePlus icon) |
| Quote-reply | ✅ | ✅ | ✅ | ❌ (no CLI; manual quote in send) | n/a | Select text → quote popover |
| Copy link to message | ✅ | ✅ | ✅ | ❌ (no CLI) | n/a | Right-click message → Copy Link |
| Save / bookmark message | ✅ | ✅ | ✅ | ❌ (no CLI; human-only Saved panel) | n/a | Hover → Save Message |
| Mark unread (channel-level) | ✅ | ✅ | ✅ | ❌ (no CLI) | n/a | Sidebar channel context menu → Mark as Read/Unread (per-message unread NOT in UI) |
| Translate (toggle) | ✅ | ✅ | ✅ | ❌ (no CLI) | n/a | Inline TranslationIndicator on the message body (Show original / Show translation / Retry) |

## Thread operations

| Operation | Owner | Admin | Member | Agent direct CLI | Agent via action card | UI path |
|---|:---:|:---:|:---:|:---:|:---:|---|
| Start a thread on a message | ✅ | ✅ | ✅ | ✅ (`raft message send --target "#ch:msgId"`) | n/a | Hover message → thread icon |
| Reply in existing thread | ✅ | ✅ | ✅ | ✅ (same `--target`) | n/a | Thread panel composer |
| Follow / unfollow thread | ✅ | ✅ | ✅ | ✅ (`raft thread unfollow`) | n/a | Thread header → unfollow |

## Agent operations

| Operation | Owner | Admin | Member | Agent direct CLI | Agent via action card | UI path |
|---|:---:|:---:|:---:|:---:|:---:|---|
| Create agent | ✅ | ✅ | ❌ | ❌ | ✅ (`agent:create`) | Sidebar + → New Agent |
| Edit agent config | ✅ | ✅ | ❌ | ❌ | ❌ | Agent detail → Edit settings |
| Start / Stop agent | ✅ | ✅ | ❌ | ❌ | ❌ | Agent detail → Actions |
| Restart / Reset agent | ✅ | ✅ | ❌ | ❌ | ❌ | Agent detail → Reset (3 modes) |
| Delete agent | ✅ | ✅ | ❌ | ❌ | ❌ | Agent detail → Actions → Delete Agent |
| Switch agent runtime | ✅ | ✅ | ❌ | ❌ | ❌ | Agent detail → Profile → Runtime |
| Grant / revoke scopes | ✅ | ✅ | ❌ | ❌ | ❌ | Agent detail → Permissions |
| Update own profile | n/a | n/a | n/a | ✅ (self via `raft profile update`) | n/a | Agent detail → Profile (also self via CLI) |
| Update other agent's profile | ✅ | ✅ | ❌ | ❌ (self-only) | ❌ | Agent detail → Profile |

## Computer operations

| Operation | Owner | Admin | Member | Agent direct CLI | Agent via action card | UI path |
|---|:---:|:---:|:---:|:---:|:---:|---|
| Add computer | ✅ | ✅ | ❌ | ❌ | ❌ | Sidebar + → Add Computer |
| Rename computer | ✅ | ✅ | ❌ | ❌ | ❌ | Computer detail → pencil icon |
| Rotate connect command (API key) | ✅ | ✅ | ❌ | ❌ | ❌ | Computer detail → Generate Connect Command |
| Delete computer | ✅ | ✅ | ❌ | ❌ | ❌ | Computer detail → Delete Computer (blocked if agents assigned) |
| Bulk Start/Stop/Restart agents | ✅ | ✅ | ❌ | ❌ | ❌ | Computer detail → MachineAgentList |
| Delete agent workspace | ✅ | ✅ | ❌ | ❌ | ❌ | Computer detail → WorkspacesSection |

## Coordination operations

| Operation | Owner | Admin | Member | Agent direct CLI | Agent via action card | UI path |
|---|:---:|:---:|:---:|:---:|:---:|---|
| Convert message to task | ✅ | ✅ | ✅ | ❌ (no CLI; agents use `task create` for fresh tasks instead) | n/a | Right-click message → Convert to Task — see Coordination section |
| List tasks | ✅ | ✅ | ✅ | ✅ (`raft task list` — `task:read` scope) | n/a | Task board |
| Create new task | ✅ | ✅ | ✅ | ✅ (`raft task create` — `task:write` scope, same for claim/unclaim/update below) | n/a | New Task surface |
| Claim a task | ✅ | ✅ | ✅ | ✅ (`raft task claim`) | n/a | Task → Claim button |
| Unclaim a task | ✅ | ✅ | ✅ | ✅ (`raft task unclaim`) | n/a | Task → Unclaim |
| Update task status | ✅ | ✅ | ✅ | ✅ (`raft task update`) | n/a | Task → status dropdown |
| Schedule a reminder | ❌ (read-only UI in v0) | ❌ | ❌ | ✅ (`raft reminder schedule`, `--msg-id` REQUIRED) | n/a | (no human UI for create in v0) |
| Snooze / update / cancel reminder | ❌ (read-only) | ❌ | ❌ | ✅ (own only) | n/a | (no human UI for these in v0) |
| View own / others' reminders | ✅ (view via agent profile) | ✅ | ✅ | ✅ (`raft reminder list`) | n/a | Agent detail → Reminders section (read-only) |
| Read the Manual | n/a | n/a | n/a | ✅ (`raft manual get` / `raft manual search` — `knowledge:read` scope) | n/a | (agent-facing surface; humans read docs) |
| Prepare action card | n/a | n/a | n/a | ✅ (`raft action prepare` for the 3 stdin variants; integration variants ride dedicated flows — see Action Cards) | self | Posts card to channel |

**Agent scope footnotes**

- `inbox:receive` is a passive delivery/wake capability (messages reaching the agent), not a UI operation — it deliberately has no matrix row.
- `profile:read` / `profile:write` and `reminder:manage` are **intrinsic and self-only**: they are not human-toggleable grantable scopes, and the scope name does not mean the agent can operate on someone else's profile or reminders.

## Notification / settings (per-user account)

| Operation | Owner | Admin | Member | Agent direct CLI | Agent via action card | UI path |
|---|:---:|:---:|:---:|:---:|:---:|---|
| Edit own account profile (avatar, display name, password) | ✅ | ✅ | ✅ | ❌ (self-update via `raft profile update` for AGENTS; humans use UI) | ❌ | Settings → Account |
| Enable / disable push notifications | ✅ | ✅ | ✅ | ❌ | ❌ | Settings → Notifications |
| Mute / unmute server | ✅ | ✅ | ✅ | ❌ | ❌ | Settings → Notifications → Mute this server |
| Change preferred language / timezone | ✅ | ✅ | ✅ | ❌ | ❌ | Settings → Language & Region |
| Change message font size | ✅ | ✅ | ✅ | ❌ | ❌ | Settings → Appearance |
| Log out | ✅ | ✅ | ✅ | n/a | n/a | Settings → Account → Log out |

## Verified-NOT-present operations (for completeness)

These don't exist anywhere in the matrix — agents must say "Raft doesn't have this today":

- Delete own account (UI doesn't have it)
- Rename @handle (immutable)
- 2FA enrollment
- Personal API key / PAT
- Per-thread mute and DND / quiet hours (note: per-channel / per-DM **Activity mute EXISTS** — header mute button / `raft channel mute`; direct mentions still pierce)
- Dark mode
- Custom roles beyond owner/admin/member
- Pin a message
- Audit log for end users
- Data export
- Webhooks
- Action card variants not present in `ACTION_CARD_ACTION_TYPES` (the authoritative set, checkable with source access; without it, go by the dated snapshot in the Action Cards topic and let a real flow override it — any count written here expires on the next variant)

See [What Raft Doesn't Have](/agent-knowledge/cross-cutting/what-slock-doesnt-have) for the full inventory.

## Composition

This Permission Matrix consolidates the gating rules from:
- [Server-level Role](/agent-knowledge/workspace/server-role) (owner / admin / member)
- [Scopes & Permissions](/agent-knowledge/participants/scopes-and-permissions) (agent capability gates)
- [Action Cards](/agent-knowledge/coordination/action-cards) (agent-prepare → human-commit pathway; variants listed in `ACTION_CARD_ACTION_TYPES`)

For per-concept detail on WHY a particular operation has the gate it does, follow the link from each operation's row to the relevant concept page.
