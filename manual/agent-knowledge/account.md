---
doc_id: account
title: Account
description: A human's global Raft identity. Carries email, password, sign-in providers, notification preferences. Per-account, not per-server. Includes deleting the account (7 days to cancel).
---

{/*
Body does NOT mention personal assistants or guests (2026-11-05: limited rollout; re-add when generally available).
Verified against:
- packages/web/src/features/settings/account/AccountSection.tsx (Avatar / Display Name / Username read-only / Email / Connected accounts / Change Password)
- packages/web/src/components/auth/RegisterPage.tsx (email + password + legal consent) → EmailVerificationPage → AccountIdentitySetupPage (Username, Display name, Profile picture); order in App.tsx
- packages/web/src/features/settings/account/AccountSignOutSection.tsx (Sign Out)
- packages/web/src/features/settings/notifications/NotificationsTabContent.tsx → packages/web/src/components/settings/notifications/NotificationSettingsSection.tsx (This device / Pause and schedule / Content / Servers cards; #12135, #12264)
- packages/web/src/features/sidebar/Sidebar.tsx settings groups (On {server} → Theme incl. "Light and dark", Notifications → this server's level, ServersCard CurrentServerNotificationsCard)
- packages/web/src/features/settings/language-region/LanguageRegionSection.tsx (Display language, Translation mode Auto/Manual/Off, Translation target, Default view Translated/Original/Bilingual, Timezone, Time format)
- packages/web/src/features/settings/appearance/AppearanceSection.tsx (Light/Dark/System card only with no server or on the public page; font size, Live agent activity, Show agent model, Hide empty sidebar sections)
- packages/server/src/routes/auth.ts:582 (name is immutable — set at registration only)
- packages/cli/src/commands/auth/whoami.ts + packages/shared/src/agentApiContract.ts agentApiAgentContextResponseSchema (local context + serverConfirmed, agent incl. serverRole, server, capabilities = credential scopes; --prompt)
- packages/cli/src/commands/agent/login.ts (`login` saves an existing token; `login start` / `login wait` = device-code flow that asks for an agent key (agent_key grant) and saves it, no session, then revokes the key the profile held before with that key; --profile-slug only names the saved profile)
- packages/cli/src/commands/agent/logout.ts (`raft --profile <slug> agent logout`: the profile's key revokes itself, then its credential file is removed; kept if the server could not revoke it)
- packages/server/src/routes/auth.ts GET /auth/providers (a provider is enabled exactly when it is configured, same list for every platform); packages/web/src/hooks/useAuthProviders.ts (Login, Register and Settings → Account Connected accounts list enabled providers)
- apple_web_login_v0 retired 2026-11: Apple sign-in / account linking is offered wherever Apple is configured. Raft Desktop runs the web app, which lists providers via /auth/providers (web) and signs in through /auth/mobile/oauth/start, so Desktop offered Apple before too
@ re-verified against staging 1883339e9 on 2026-10-28 (public-docs audit fixes: app URL, sign-up steps, Username label, notification wording, Language & Region controls, theme location, whoami fields, agent login)
- packages/web/src/components/settings/TwoStepVerificationSection.tsx + PasskeysSection.tsx (en.ts settings.twoStep.*, settings.passkeys.*; LoginPage "Sign In with a Passkey") — auth_second_factor_v1 is generally available (2026-11-03), so no rollout note
- en.ts settings.account.deviceLoginNotice / pages.resetPassword.deviceLoginNotice (password change or reset signs out everywhere and revokes device-login Computers and agent credentials) — #12000
- packages/server/src/services/assistantOwnerSettingsService.ts + agentApiContract assistantOwnerSettingsUpdate (PATCH /assistant/owner-settings: theme, themeDecor, displayLanguage, preferredTimezone; audited; settings.assistantChanges list) — #12363; personal_assistant is a limited rollout, so rollout note in the body
- account_deletion_v0 is generally available (2026-11-09), shipped in v1.21.61, so no rollout note. Delete account: features/settings/account/DeleteAccountSection.tsx (Danger zone row), AccountDeletionChecklist.tsx, pages/AccountDeletionRequestedPage.tsx, AccountDeletionPendingPage.tsx, en.ts accountDeletion.* / machine.othersAgents.* / machine.forceUnbind.*; server routes/accountDeletion.ts (409 sole_owner_servers, others_agents_on_computers; 403 account_deletion_pending during the grace period), services/accountDeletion/requests.ts (ACCOUNT_DELETION_GRACE_DAYS default 7; at request: every session, Computer key and agent key revoked, agents stopped, subscriptions cancel at period end, email with a one-time cancel link), reauth.ts (second factor; else password or a sign-in in the last 10 minutes; else an emailed code), cleanup.ts (hourly: servers handed over or closed, disposeAgentsOfDeletedUser, profile scrubbed to "Deleted user", Computers deleted, Login with Raft consents and tokens revoked, server.member_removed reason account_deleted). Support can request it for someone: docs/operations/ops-account-deletion.md. Personal assistants are archived (not in the body, see the first note).
@ re-verified against staging 6bfd74e0fe on 2026-11-03 (manual drift: two-step verification and passkeys, rebuilt Notifications tab, server notification level, password change sign-out, assistant owner settings)
*/}

# Account

An account is a human's global identity in Raft. It carries email, password, sign-in providers, and a few per-user preferences. A single account can belong to multiple [servers](/agent-knowledge/workspace/server) (with separate [Membership](/agent-knowledge/workspace/membership) in each).

> **In one sentence**: Account is who you ARE in Raft — the email + password identity that lets you sign in and access whatever servers you belong to.

Accounts are human-only. Agents have their own identity (see [Agent](/agent-knowledge/participants/agent)) — they don't have accounts in the human sense.

## When a user asks: "How do I change my email / password / display name?"

→ they want: a per-account setting tweak
→ in the UI: **Settings** → **Account** tab
→ via CLI: agents introspect via `raft auth whoami`; they cannot modify human account settings

## What humans do

**Sign up / sign in**
- Sign up: `app.raft.build` → Create account → email + password + agree to terms → verify email → pick a **Username** (your @handle) and **Display name**, and optionally a profile picture
- Sign in: same URL → email + password, OR Google, OR GitHub, OR Apple, OR a passkey added in Settings → Account → Passkeys
- After sign-up, where the user lands depends on context:
  - Zero-server new user (no invite, no link) → **Create your first server** screen
  - Invite or join-link new user → accept/join flow into that server
  - Existing user signing in with multiple servers → server switcher / last-active server

**Edit account profile** (in Settings → Account tab)
- Upload **Avatar** (image)
- Edit **Display Name** (visible in your User Profile across servers)
- **Username** (the handle that shows in `@mentions`) is **read-only** — immutable since registration. If a user wants to change their @handle, the answer is: they can't; pick wisely at signup
- **Email** shows verified/unverified badge — Email itself isn't editable today
- Link **Connected accounts** (Google / GitHub / Apple as additional sign-in providers)
- **Change Password** (collapsible section; min 8 chars). Changing (or resetting) the password signs you out everywhere and stops Computers and agent credentials set up through a device login (Raft Computer, the raft CLI); log in on them again
- **Passkeys** and **Two-step verification**: turn on a second step at every sign-in (including Google, GitHub or Apple) with an authenticator app's 6-digit code, plus one-time backup codes
- Turning two-step verification on or off, making new backup codes, or removing a passkey signs you out on your other browsers and devices, but keeps the one you did it on, and leaves Computers and the raft CLI connected. Adding a passkey signs nobody out. A password change is stricter on purpose (it may follow a leaked password): it signs out every session, including the one that changed it

**Notification preferences** (in Settings → Notifications tab)
- **This device**: in a browser, Enable/Disable notifications; in Raft Desktop, notifications are managed by the system (**Open System Settings**). Both have **Send Test Notification**, and Raft Desktop on Windows or Linux can keep running in the background
- **Pause and schedule**: **Pause notifications** (30 minutes to until tomorrow, or a custom time) and daily **Quiet hours**; both apply on all your devices
- **Content**: **Notification preview** (Sender and message / Sender only / Hidden), **Sound**, and **While I'm on a computer, notify my phone** (right away, once I'm not active, or after 1–10 minutes away)
- **Servers**: each server's level (All new messages / Only what involves me / Nothing) and its customized channels. A muted channel or DM notifies you of nothing, @mentions included

**On {server}** (Settings group for the current server; only you see these)
- **Theme**: how this server looks to you. **Light and dark**: Light, Dark, or System (follows the device); this one choice is saved on this device, not per server. Then the color theme: Raft Yellow (default), Boring Gray (Pro servers only; on a Free server choosing it offers the upgrade), or one of nine avatar-series themes (Bots, Critters, Space, Desk, Food, Quest, Weather, Plants, Spooky). Each server can have its own theme; it follows you to every device. **Pixel art on the frame** turns the series' sprites on the top bar and rail on or off.
- **Notifications**: this server's notification level — All new messages, Only what involves me, or Nothing (per-account state, per-server scope)

**Language & Region** (in Settings → Language & Region tab)
- **Display language** (the app interface)
- **Translation mode** (Auto / Manual / Off) and **Translation target**
- **Default view** for translated messages (Translated / Original / Bilingual)
- Timezone
- Time format (12-hour / 24-hour)

**Appearance** (in Settings → Appearance tab)
- A link to this server's own theme (Settings → On {server} → Theme), where Light / Dark / System lives; Appearance shows that choice itself only when no server is open
- Message font size (sm / md / lg)
- **Live agent activity**, **Show agent model**, **Hide empty sidebar sections**

**Sign out**
- Settings → Account → **Sign Out** (confirmation dialog)

**Delete account** (Settings → Account → **Danger zone** → **Delete account**)
- The page lists what happens to the person's servers, agents, Computers and billing. **Needs action** holds what blocks the request:
  - a server they are the only Owner of that has other members: pick someone and **Make owner**, or delete the server
  - **Other people's agents on your computers**: only each agent's owner can move it. **Notify owner to move it** sends that owner a system reminder (once every 24 hours per agent). If the owner never moves it, that server's owner or an admin can delete it, or on Pro move it. Or **Force unbind and request deletion**: those agents keep their messages and settings, lose their workspace on these Computers, and each owner gets a system notice
- Their own agents, their Computers and the subscriptions they pay for don't block; **The rest happens automatically** shows what becomes of each
- **Verify it's you**: a two-step verification code, passkey or backup code if two-step verification is on; otherwise the password (or nothing, if they signed in within the last 10 minutes); with only Google, GitHub or Apple sign-in, a code sent by email
- **Delete account · Effective {date}**: at once they are signed out on every device, every Computer and agent key stops working (Computers disconnect), their agents stop, and subscriptions they pay for are set to end at the end of the period. An email gives the date and how to cancel
- **7 days to cancel**: sign in and choose **Cancel deletion**, or use the one-time link in the email. Until then the account can only cancel or sign out. Cancelling tries to turn billing back on (the confirmation email lists any subscription to turn back on yourself) and restores nothing else: sign in again on each device, reconnect the Computers and start the agents
- **On the date**: their name shows as "Deleted user" and their profile, avatar and sign-in methods are deleted; messages they sent stay in each server. A server they owned goes to another Owner, else the earliest-joined admin, else the earliest-joined member, and whoever takes it over gets an email; a server with nobody else in it closes, and no one can open its channels and files anymore (the data isn't purged yet, so don't say it's erased). Agents they created go to that server's Owner, stopped, keeping their memory; one that ran on their Computer needs another Computer. Their Computers are deleted, and apps they signed in to with Login with Raft lose access. The email address is free to sign up again, as a new account
- Someone who can't use the page can ask Raft support, which requests it for them with the same 7 days and email

## What agents do

**Introspect own identity**
- `raft auth whoami` — prints the local context (`agentId`, `serverUrl`, `serverId`, `clientMode`, `secretSource`, and the profile if one is used) and what the server confirms for it: `serverConfirmed`, `agent` (including its `serverRole`), `server` (`id` / `slug` / `name`) and `capabilities` (the scopes the credential carries)
- Useful to confirm which agent the CLI is acting as; `raft auth whoami --prompt` prints only the operating guide the server renders for an external agent

**Provision agent credential**
- `raft agent login` — save an agent token you already have (hidden prompt or stdin); it does not mint a new one. `--profile-slug <slug>` only names the saved profile
- `raft agent login start` / `raft agent login wait` — browser device-code flow: a human approves and picks the agent, then `wait` saves the new agent key the approval gives (no sign-in session is kept) and revokes the key the profile held before
- `raft --profile <slug> agent logout` — revoke the profile's agent key on the server and delete the saved credential
- `raft agent list` — list agents the user can mint credentials for

Note: agents don't have human Accounts. They have agent credentials + identities. Read [Agent](/agent-knowledge/participants/agent) for the agent-specific identity model.

## What it CAN'T do

⚠️ **These were verified absent when written, and this list rots one way:** a feature that ships makes an entry wrong and nothing here turns red. ⇒ Before telling anyone a capability is missing, re-check it — `--help` on the relevant command family is usually enough. See [What Raft Doesn't Have](/agent-knowledge/cross-cutting/what-raft-doesnt-have).

- **No undo after the deletion date.** Cancelling works only during the 7 days; after that the account is gone and the email starts a new account.
- **@Handle (Username) is immutable.** Once set at registration, the handle that appears in `@mentions` cannot be renamed. Pick at signup.
- **Email cannot be changed in UI today.** The Email field is displayed (with verified badge) but not editable.
- **No personal API key / PAT.** Raft doesn't have user-level access tokens. Authentication is via sign-in providers (email-password, Google, GitHub, Apple) — no scriptable API key for a human user.
- **No data export / GDPR download.**
- **No SSO / SAML config.** The only alternative sign-in providers are Google, GitHub and Apple.
- **Agents can't impersonate or modify human accounts.** Agent CLI is scoped to its own credential; can't touch human-user settings.

## Gotchas

- **"I want to delete my account"**: Settings → Account → **Danger zone** → **Delete account**, then 7 days to cancel. An agent can't do it for them. If the button is disabled, **Needs action** says why: a server with other members needs a new Owner, or other people's agents are still on their Computers.
- **"I cancelled my deletion but my agents are offline"**: expected. Cancelling doesn't restore keys: sign in again on each device, reconnect the Computers, then start the agents.
- **"I want to change my @handle"**: not possible. The display name (which is editable) is shown in some surfaces, but the @handle is permanent.
- **"My password change didn't take"**: verify the min 8 char rule + the current password was correct. If still issues, sign out + sign back in to refresh session.
- **"I'm seeing different settings in different servers"**: Account settings are global; Server-level settings (theme, notification level, role) are per-server. Make sure you're checking the Account tab vs the **On {server}** group.
- **"My agent is logged out / `whoami` can't confirm it"**: run `raft agent login status`; if the credential is expired or revoked (a recent password change or reset revokes credentials set up through a device login), get a fresh one with `raft agent login start` / `raft agent login wait` (or save a new token with `raft agent login`). Agent credentials are separate from human session.

## Composition

An Account:
- Is human-only (agents have [Agent](/agent-knowledge/participants/agent) identity instead)
- Has a global handle (`@name`, immutable) + Display Name (editable) + Avatar (editable)
- Belongs to zero or more [Servers](/agent-knowledge/workspace/server) via [Membership](/agent-knowledge/workspace/membership)
- In each Server, the user has a [User Profile](/agent-knowledge/participants/user-profile) (in-server identity card) and a [Server-level Role](/agent-knowledge/workspace/server-role)

Account-level settings (notifications, server notification level, language, appearance) live in **Settings** as per-account state. Server-specific settings are in **Server Management**.
