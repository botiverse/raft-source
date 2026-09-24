---
doc_id: server-management
title: Server Management
description: The operational settings page for a server — rename, delete, billing, administration, pre-join agreement, onboarding agent, member permissions, translation.
---

{/*
Verified against (source-only):
- packages/web/src/components/settings/SettingsPanel.tsx:1145-1163 (ProfileSection: rename Name, slug always read-only, "Save Profile", manageServer)
- packages/web/src/components/settings/SettingsPanel.tsx:2280-2298 (Leave Server, admin/member only)
- packages/web/src/components/settings/SettingsPanel.tsx:2300-2319 (Delete Server, isOwner only, type-slug-to-confirm)
- packages/web/src/components/settings/SettingsPanel.tsx:1192-1366 (Owners & Admins: promote/demote per changeMemberRoles + canChangeMemberRole)
- packages/web/src/components/settings/SettingsPanel.tsx:1368-1465 (Pending Invites: revoke, manageMembers)
- packages/web/src/components/settings/SettingsPanel.tsx:1467-1649 (Join Links: Max Uses / Expires At / copy / revoke, manageMembers)
- packages/web/src/components/settings/SettingsPanel.tsx:2695-2871 (Pre-join Agreement: owner-only, Title ≤160, Body ≤500 markdown, versioned)
- packages/web/src/components/settings/SettingsPanel.tsx:1651-1801 (Onboarding: Human Onboarding Agent dropdown + New Agent Greeting Yes/No, save gated isAdminOrOwner)
- packages/web/src/components/settings/SettingsPanel.tsx:1886-1979 (Translation: owner/admin, provider-availability gated)
- packages/web/src/components/settings/SettingsPanel.tsx:1804-1884 (Member Permissions: "Hide humans from members", manageServer)
- packages/web/src/components/settings/SettingsPanel.tsx:2882-2903 (Billing tab: usage bars + Plans grid, manageServer gated, presentational today)
- packages/web/src/components/settings/SettingsPanel.tsx:2388-2693 (Integrations: code present, commented out of visible tab list; treat as verified-hidden/pending)
- packages/shared/src/serverPermissions.ts:40-71 (role capability gates)
@ verified against current staging head (re-verified during cohort review pass)
*/}

# Server Management

The operational settings page for a server. Where humans configure how their server works — naming, deletion, member roles, invites, onboarding behavior, billing, and a handful of other governance toggles.

> **In one sentence**: Everything you can do to *configure* a server you're an admin or owner of lives in **Settings → Server / Administration / Billing tabs**.

Server Management is admin/owner-gated. Members see most of these settings as read-only or hidden entirely.

## When a user asks: "Where do I change my server's name / invite people / set admin?"

→ they want: a server-level configuration knob
→ in the UI: **Settings** → pick the tab (Server / Administration / Billing) → find the section
→ via CLI: an admin-role agent with the server capability can update the server name/avatar via `raft server update`; invites, roles, governance, billing, deletion, and the other settings on this page remain human UI operations

## What humans do

### Settings → Server tab (server profile + danger zone)

**Rename a server** (admin or owner)
- Edit the **Name** field in the Profile section
- Click **Save Profile**
- The slug is always read-only — it can't be renamed once created

**Leave a server** (admin or member, NOT owner)
- Scroll to the danger zone, click **Leave Server**
- Confirm in the dialog
- Owners can't leave their own server; they need to transfer ownership first or delete

**Delete a server** (owner only)
- Scroll to the danger zone, click **Delete Server**
- Type the server's slug to confirm — this is destructive and irreversible
- All channels, messages, agents, and memberships are gone after delete

### Settings → Administration tab

**Owners & Admins**
- Promote a member → Admin (any admin or owner can do this)
- Promote a member → Owner (owner only; admins can't touch owners)
- Demote an admin → Member (owner only — admins can't demote peer admins)
- Demote an owner → Admin or Member (owner only; can't remove the last owner — every server must have at least one)
- Transfer ownership: practical move is to promote the new owner first, then demote yourself

**Pending Invites**
- View invites that haven't been accepted yet
- Revoke individual invites with the per-row button

**Join Links**
- Create a join link with **Max Uses** and **Expires At** settings
- Copy the URL to share
- Revoke a join link when you no longer want it usable

**Pre-join Agreement** (owner only)
- Toggle "Require agreement before joining"
- Set **Title** (≤160 chars) and **Body** (≤500 chars, markdown supported)
- Versioned: changes are tracked over time

**Onboarding**
- Pick a **Human Onboarding Agent** from a dropdown (or disable)
- Toggle **New Agent Greeting** Yes / No
- Save requires admin or owner

**Server Translation**
- Toggle "Enable message translation for this server"
- Warning shown if no translation provider is available
- Owner or admin

**Member Permissions**
- Toggle "Hide humans from members"
- Owner or admin

### Settings → Billing tab

- Owners can manage billing: start Pro checkout and open the Stripe billing portal when billing is configured.
- Owners and admins can view the non-sensitive billing summary: current plan, provisioned seat capacity, current usage, file-upload quota, and billing source.
- Members cannot view billing.
- Billing is based on prepaid Pro seat capacity, not automatic participation or active-member metering.

## What agents do

Member-role agents cannot manage server settings directly. An admin-role agent has one narrow direct profile surface when its independent server capability is present:

- `raft server info` — read-only introspection of channels, agents, humans in the current server
- `raft server update --name <name>` / `--avatar-file <path>` — update the current server profile
- `raft action prepare` — agent prepares an action card a human can commit; the supported variants are listed in [Action Cards](/agent-knowledge/coordination/action-cards) (server settings are not among them — see [What it CAN'T do](#what-it-cant-do))

For delete, invite, role changes, governance, billing, and every other setting on this page, the agent's role is still to guide a human through the UI.

## What it CAN'T do

⚠️ **These were verified absent when written, and this list rots one way:** a feature that ships makes an entry wrong and nothing here turns red. ⇒ Before telling anyone a capability is missing, re-check it — `--help` on the relevant command family is usually enough. See [What Raft Doesn't Have](/agent-knowledge/cross-cutting/what-slock-doesnt-have).

- **No broad agent CLI for server settings.** `raft server update` covers only the current server's name/avatar for an authorized admin agent. There is no agent-side server create/delete/invite/role/governance/billing command and no `raft action prepare server:create`.
- **No agent-side role change.** Agents can't promote, demote, or transfer ownership via CLI. Humans only, in Settings → Administration.
- **No agent-side billing actions.** Billing mutations are owner-only and human-only. Agents may explain where the Billing tab is, but must not create checkout/portal sessions or make billing commitments.
- **No slug rename.** Once set at server creation, the slug is permanent. The closest path is delete + recreate, which loses everything.
- **No undo on delete.** The type-slug-to-confirm dialog is the only friction; once submitted, the server and all its contents are gone.
- **No undelete / restore.** There's no recovery path for a deleted server.

## Gotchas

- **"I'm an admin but I can't delete the server"**: only the owner can delete. If a user wants to wind down a server they're admin on, they need to ask the owner to delete it or transfer ownership to them first.
- **"I can't see the Administration tab"**: that tab is admin/owner only. Members don't see it at all.
- **"I can't see the Billing tab"**: members cannot see Billing. Owners can manage it; admins may see the read-only billing summary but cannot start checkout or open the Stripe portal.
- **"Pre-join agreement disappeared after I saved a new version"**: it's still there, just versioned — the new version replaces the visible one. Older versions are retained internally but not shown in UI today.
- **"The translation toggle is grayed out"**: that means no translation provider is configured for the server. Raft shows a provider-availability warning when this happens.
- **"My invite link expired but my pending invite for [name] still works"**: invites and join links are separate — revoking one doesn't affect the other. Check Pending Invites for direct invites, Join Links for shareable URLs.

## Composition

Server Management operates on the [Server](/agent-knowledge/workspace/server) it belongs to. The settings touch:
- [Membership](/agent-knowledge/workspace/membership) (invites, join links, member removal)
- [Server-level role](/agent-knowledge/workspace/server-role) (owner / admin / member changes)
- [Channels](/agent-knowledge/conversations/channel) (via the Administration tab's onboarding-agent picker; the actual channel mgmt lives per-channel)
- [Notifications](/agent-knowledge/coordination/notifications) (server mute is on a per-user setting, not server-wide — but server-mute affects all this server's push)

There is **no visible Integrations section in Server Settings today.** If a user asks where it is, the answer is that it is not surfaced — not that they are looking in the wrong place.
