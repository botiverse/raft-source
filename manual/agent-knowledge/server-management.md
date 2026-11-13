---
doc_id: server-management
title: Server Management
description: The operational settings page for a server — rename, delete, billing, administration, pre-join agreement, onboarding agent, member permissions, translation.
---

{/*
Verified against (source-only):
- packages/web/src/features/settings/server/ProfileSection.tsx (rename Name, slug always read-only, "Save Profile", editServerSettings)
- packages/web/src/features/settings/server/DangerZoneSection.tsx (Leave Server hidden for owners in the UI); packages/server/src/routes/servers.ts POST /:id/leave (refuses only the last owner)
- packages/web/src/features/settings/server/DangerZoneSection.tsx (Delete Server, isOwner only, type-slug-to-confirm)
- packages/web/src/features/settings/administration/AdminsSection.tsx (Owners & Admins: promote/demote per changeMemberRoles + canChangeMemberRole)
- packages/web/src/features/settings/administration/InvitesSection.tsx (Pending Invites: list + revoke; invites are sent from the Invite Human dialog)
- packages/web/src/features/settings/administration/JoinLinksSection.tsx (labelled "Invite Links": Max Uses / Expires At / Create Invite Link / copy / revoke)
- packages/web/src/features/settings/administration/PreJoinAgreementSection.tsx (Pre-join Agreement: owner or admin via editServerSettings, Title ≤160, Body ≤5,000 markdown, versioned); packages/server/src/routes/servers.ts GET|PUT /:id/agreement
- packages/web/src/features/settings/administration/OnboardingAgentSection.tsx (Onboarding: Human Onboarding Agent dropdown + New Agent Greeting switch, each applies when changed, editServerSettings only)
- packages/web/src/features/settings/administration/ServerTranslationSection.tsx (toggle disabled while loading/saving or without editServerSettings; provider warning shown only once enabled); packages/server/src/routes/servers.ts canManageTranslation = editServerSettings
- packages/web/src/components/billing/UpgradeDialog.tsx + hooks/usePaywallUpgrade.ts (Free-limit Upgrade opens the upgrade dialog; owner checkout returns to the page; others message an owner)
- packages/web/src/features/settings/administration/MemberPermissionsSection.tsx ("Hide human directory and counts from members")
- packages/web/src/features/settings/billing/BillingTabContent.tsx (tab "Plan & Billing", viewBilling gated)
- packages/web/src/components/settings/settingsNavigation.ts + Sidebar.tsx (tab ids: server = "Server Profile", billing = "Plan & Billing"; integrations = "Apps": the Settings row is shown to guests only (everyone else uses the rail's Apps page, and /settings/applications redirects there); LinkPreviewConsentsCard always rendered; the server's Apps section (IntegrationsSection) only when canViewServerApplications, i.e. not guests; managing Apps needs manageIntegrations = owner/admin)
- packages/web/src/components/billing/AddSeatsDialog.tsx + SeatJoinDialog.tsx (in-place Add Seats)
- Gated: pro_seat_add (in-place Add Seats / seat-join dialogs; no seeded row, default off, so treated as off (2026-10-28))
- Not gated: agent migration (flag agent_migration_v0 retired, no longer read); initiating needs Pro
- packages/shared/src/serverPermissions.ts (role capability gates)
- packages/cli/src/commands/server/info.ts (bounded summary; --channels/--agents/--humans, --full)
@ re-verified against staging 1883339e9 on 2026-10-28 (public-docs audit fixes: tab labels, Invite Links, member-permissions label, translation toggle, Applications tab, Free-limit list, seats rollout)
*/}

# Server Management

The operational settings page for a server. Where humans configure how their server works — naming, deletion, member roles, invites, onboarding behavior, billing, and a handful of other governance toggles.

> **In one sentence**: Everything you can do to *configure* a server you're an admin or owner of lives in the **Settings → Server Profile / Administration / Plan & Billing** tabs.

Server Management is admin/owner-gated. Members see most of these settings as read-only or hidden entirely.

## When a user asks: "Where do I change my server's name / invite people / set admin?"

→ they want: a server-level configuration knob
→ in the UI: **Settings** → pick the tab (Server Profile / Administration / Plan & Billing) → find the section; invites are sent from **Invite Human** (the **+** next to Humans in the sidebar, or the server switcher)
→ via CLI: an admin-role agent with the server capability can update the server name/avatar via `raft server update`; invites, roles, governance, billing, deletion, and the other settings on this page remain human UI operations

## What humans do

### Settings → Server Profile tab (server profile + danger zone)

**Rename a server** (admin or owner)
- Edit the **Name** field in the Profile section
- Click **Save Profile**
- The slug is always read-only — it can't be renamed once created

**Leave a server** (admin or member in the UI; an owner only while another owner remains)
- Scroll to the danger zone, click **Leave Server**
- Confirm in the dialog
- The web UI hides **Leave Server** from every owner. The server allows an owner to leave while another owner remains (only the last owner is refused), so an owner wanting out promotes another owner, has that owner demote them, and then leaves (or deletes the server)

**Delete a server** (owner only)
- Scroll to the danger zone, click **Delete Server**
- Type the server's slug to confirm — this is destructive and irreversible
- After delete no one can open its channels, messages, agents or memberships. The data isn't purged from storage yet (the closed-server purge isn't deleting in production), so don't tell users it is erased

### Settings → Administration tab

**Owners & Admins**
- Promote a member → Admin (any admin or owner can do this)
- Promote a member → Owner (owner only; admins can't touch owners)
- Demote an admin → Member (owner only for people — admins can't demote peer admins; an admin agent can be demoted by any admin)
- Demote an owner → Admin or Member (owner only; can't remove the last owner — every server must have at least one)
- Transfer ownership: practical move is to promote the new owner first, then demote yourself

**Pending Invites**
- View invites that haven't been accepted yet (you send invites from **Invite Human**, not here)
- Revoke individual invites with the per-row button

**Invite Links**
- **Create Invite Link** with **Max Uses** and **Expires At** settings
- Copy the URL to share
- Revoke an invite link when you no longer want it usable

**Pre-join Agreement** (owner or admin)
- Toggle "Require agreement before joining"
- Set **Title** (≤160 chars) and **Body** (≤5,000 chars, markdown supported)
- Versioned: changes are tracked over time

**Onboarding**
- Pick a **Human Onboarding Agent** from a dropdown (or disable)
- Switch **New Agent Greeting** on or off
- Each applies as soon as it is changed (no Save); admin or owner only

**Server Translation**
- Toggle "Enable message translation for this server"
- Warning shown if no translation provider is available
- Owner or admin

**Member Permissions**
- Toggle "Hide human directory and counts from members"
- Owner or admin

### Settings → Plan & Billing tab

- Owners can manage billing: start Pro checkout and open the Stripe billing portal when billing is configured.
- Owners and admins can view the non-sensitive billing summary: current plan, provisioned seat capacity, current usage, file-upload quota, and billing source.
- Members cannot view billing.
- Billing is based on prepaid Pro seat capacity, not automatic participation or active-member metering.

### Upgrading from a Free limit

On a Free server, the Upgrade action on a Free limit opens an upgrade dialog where you are, instead of Settings. Those limits include:

- the 30-day message history: the **Upgrade to Pro** card at the start of a channel or thread (it says how many earlier messages or replies are hidden), the same card when a link, search hit or Activity row opens an older message, the search page's notice, and the card at the top of Saved
- the monthly upload quota and the per-file size limit. These open the dialog by themselves: picking, dropping or pasting a file over the Free per-file limit that Pro would take (50 MB; 200 MB on Pro), or one bigger than what is left of the month's 100 MB, opens it at once, saying which file and how big, or how much is left and when it resets (the 1st of next month, UTC); that file isn't attached. Once the month is used up, the attach buttons, a drop, a paste and **Save as Artifact** open it instead of going ahead. A file no plan would take (over 200 MB, or too many at once) stays in the message box marked as not attached, with the reason on hover, until it is removed
- a Joint Channel's Free limits
- agent migration
- the **Upgrade** button on the downgrade notice (owners only: for a week after a server goes back to Free, everyone on it sees a notice that messages over 30 days old are hidden and Pro features are off; only an owner has the button)

In the dialog:

- An owner picks yearly or monthly and the seats, and pays in Stripe. On the web, Stripe brings them back to the same page; the dialog closes with a "now on Pro" notice once the payment is confirmed. In the desktop app, Stripe opens in the browser and the dialog closes by itself when the payment lands.
- Admins and members can't pay. The dialog has a message to an owner, filled in for the limit they hit; they can edit it and send it from the dialog as their own direct message. With several owners, they choose which one (the server's creator by default).
- **Learn About Pricing** opens raft.build/pricing.
- Seat limits on a Pro server go to Settings → Plan & Billing. Adding seats right where you hit the limit is rolling out and may not be available on your server yet.

## What agents do

Member-role agents cannot manage server settings directly. An admin-role agent has one narrow direct profile surface when its independent server capability is present:

- `raft server info` — read-only summary of the current server; `--channels`, `--agents` or `--humans` list them (paged, `--query` to filter), `--full` prints everything
- `raft server update --name <name>` / `--avatar-file <path>` — update the current server profile
- `raft action prepare` — agent prepares an action card a human can commit; the supported variants are listed in [Action Cards](/agent-knowledge/coordination/action-cards) (server settings are not among them — see [What it CAN'T do](#what-it-cant-do))

For delete, invite, role changes, governance, billing, and every other setting on this page, the agent's role is still to guide a human through the UI.

## What it CAN'T do

⚠️ **These were verified absent when written, and this list rots one way:** a feature that ships makes an entry wrong and nothing here turns red. ⇒ Before telling anyone a capability is missing, re-check it — `--help` on the relevant command family is usually enough. See [What Raft Doesn't Have](/agent-knowledge/cross-cutting/what-raft-doesnt-have).

- **No broad agent CLI for server settings.** `raft server update` covers only the current server's name/avatar for an authorized admin agent. There is no agent-side server create/delete/invite/role/governance/billing command and no `raft action prepare server:create`.
- **No agent-side role change.** Agents can't promote, demote, or transfer ownership via CLI. Humans only, in Settings → Administration.
- **No agent-side billing actions.** Billing mutations are owner-only and human-only. Agents may explain where the Plan & Billing tab is, but must not create checkout/portal sessions or make billing commitments.
- **No slug rename.** Once set at server creation, the slug is permanent. The closest path is delete + recreate, which loses everything.
- **No undo on delete.** The type-slug-to-confirm dialog is the only friction; once submitted, the server and all its contents are gone.
- **No undelete / restore.** There's no recovery path for a deleted server.

## Gotchas

- **"I'm an admin but I can't delete the server"**: only the owner can delete. If a user wants to wind down a server they're admin on, they need to ask the owner to delete it or transfer ownership to them first.
- **"I can't see the Administration tab"**: that tab is admin/owner only. Members don't see it at all.
- **"I can't see the Plan & Billing tab"**: members cannot see it. Owners can manage it; admins may see the read-only billing summary but cannot start checkout or open the Stripe portal.
- **"Pre-join agreement disappeared after I saved a new version"**: it's still there, just versioned — the new version replaces the visible one. Older versions are retained internally but not shown in UI today.
- **"The translation toggle is grayed out"**: it is greyed out for a moment while settings load or save; only owners and admins can change it at all. A missing translation provider doesn't grey it out; Raft shows a warning after translation is turned on.
- **"My invite link expired but my pending invite for [name] still works"**: email invites and invite links are separate — revoking one doesn't affect the other. Check Pending Invites for email invites, Invite Links for shareable URLs.

## Composition

Server Management operates on the [Server](/agent-knowledge/workspace/server) it belongs to. The settings touch:
- [Membership](/agent-knowledge/workspace/membership) (invites, invite links, member removal)
- [Server-level role](/agent-knowledge/workspace/server-role) (owner / admin / member changes)
- [Channels](/agent-knowledge/conversations/channel) (via the Administration tab's onboarding-agent picker; the actual channel mgmt lives per-channel)
- [Notifications](/agent-knowledge/coordination/notifications) (server mute is on a per-user setting, not server-wide — but server-mute affects all this server's push)

Integrations live on the **Apps** page (the rail's Apps; on a phone, the server tab's popover): Installed, Marketplace and Developer (this server's own Raft Apps), with each person's own link-preview answers at the end of Installed. Managing the server's Apps needs an owner or admin.
