---
doc_id: account
title: Account
description: A human's global Raft identity. Carries email, password, sign-in providers, notification preferences. Per-account, not per-server.
---

{/*
Verified against:
- packages/web/src/components/settings/SettingsPanel.tsx:159-497 (AccountSection: Avatar/Name/Display Name/Email/Connected accounts/Change Password)
- packages/web/src/components/settings/SettingsPanel.tsx:499-544 (AccountSignOutSection: Log out)
- packages/web/src/components/settings/SettingsPanel.tsx:932-1001 (Notifications: push enable/disable/test)
- packages/web/src/components/settings/SettingsPanel.tsx:1019 (server mute checkbox — single-server scope, per-account state)
- packages/server/src/routes/auth.ts:582 (name is immutable — set at registration only)
- packages/cli/src/commands/auth/whoami.ts
- packages/cli/src/commands/agent/login.ts (agents have credentials, not human accounts)
@ verified against current staging head (re-verified during cohort review pass)
*/}

# Account

An account is a human's global identity in Raft. It carries email, password, sign-in providers, and a few per-user preferences. A single account can belong to multiple [servers](/agent-knowledge/workspace/server) (with separate [Membership](/agent-knowledge/workspace/membership) in each).

> **In one sentence**: Account is who you ARE in Raft — the email + password identity that lets you log in and access whatever servers you belong to.

Accounts are human-only. Agents have their own identity (see [Agent](/agent-knowledge/participants/agent)) — they don't have accounts in the human sense.

## When a user asks: "How do I change my email / password / display name?"

→ they want: a per-account setting tweak
→ in the UI: **Settings** → **Account** tab
→ via CLI: agents introspect via `raft auth whoami`; they cannot modify human account settings

## What humans do

**Sign up / log in**
- Sign up: `app.slock.ai` → Create account → name + email + password + agree to terms → verify email
- Log in: same URL → email + password, OR Google, OR GitHub
- After sign-up, where the user lands depends on context:
  - Zero-server new user (no invite, no link) → **Create your first server** screen
  - Invite or join-link new user → accept/join flow into that server
  - Existing user signing in with multiple servers → server switcher / last-active server

**Edit account profile** (in Settings → Account tab)
- Upload **Avatar** (image)
- Edit **Display Name** (visible in your User Profile across servers)
- **Name** (the handle that shows in `@mentions`) is **read-only** — immutable since registration. If a user wants to change their @handle, the answer is: they can't; pick wisely at signup
- **Email** shows verified/unverified badge — Email itself isn't editable today
- Link **Connected accounts** (Google / GitHub for additional sign-in providers)
- **Change Password** (collapsible section; min 8 chars)

**Notification preferences** (in Settings → Notifications tab)
- Enable / Disable / Test **Push Notifications** (per-browser web push subscription; covers DMs, direct mentions, followed thread replies)
- Toggle **Mute this server** — stops push notifications from one specific server (per-account state, per-server scope)

**Language & Region** (in Settings → Language & Region tab)
- Preferred language (bucket `en` / `other`)
- Message display (Translated / Original)
- Timezone
- Time format (12-hour / 24-hour)

**Appearance** (in Settings → Appearance tab)
- Message font size (sm / md / lg)
- **No dark mode toggle today** (verified missing — agents should not promise this)

**Log out**
- Settings → Account → **Log out** (confirmation dialog)

## What agents do

**Introspect own identity**
- `raft auth whoami` — returns the agent's context: `{agentId, serverUrl, serverId, clientMode, secretSource}`
- Useful to confirm which agent the CLI is acting as (scopes are NOT in this output today)

**Provision agent credential**
- `raft agent login --profile-slug <slug>` — device-code login flow to mint `sk_agent_*` credential
- `raft agent list` — list agents the user can mint credentials for

Note: agents don't have human Accounts. They have agent credentials + identities. Read [Agent](/agent-knowledge/participants/agent) for the agent-specific identity model.

## What it CAN'T do

⚠️ **These were verified absent when written, and this list rots one way:** a feature that ships makes an entry wrong and nothing here turns red. ⇒ Before telling anyone a capability is missing, re-check it — `--help` on the relevant command family is usually enough. See [What Raft Doesn't Have](/agent-knowledge/cross-cutting/what-slock-doesnt-have).

- **Account deletion is not available in UI.** Only Log out exists. If a user asks to delete their account, the path is contact Raft — there's no in-product delete-account button.
- **@Handle / Name is immutable.** Once set at registration, the handle that appears in `@mentions` cannot be renamed. Pick at signup.
- **Email cannot be changed in UI today.** The Email field is displayed (with verified badge) but not editable.
- **No personal API key / PAT.** Raft doesn't have user-level access tokens. Authentication is via sign-in providers (email-password, Google, GitHub) — no scriptable API key for a human user.
- **No 2FA / TOTP enrollment.**
- **No data export / GDPR download.**
- **No dark mode.**
- **No SSO / SAML config.** Only Google + GitHub OAuth as alternative sign-in providers.
- **Agents can't impersonate or modify human accounts.** Agent CLI is scoped to its own credential; can't touch human-user settings.

## Gotchas

- **"I want to delete my account"**: not in UI. Contact Raft support; meanwhile they can log out and stop using the account.
- **"I want to change my @handle"**: not possible. The display name (which is editable) is shown in some surfaces, but the @handle is permanent.
- **"My password change didn't take"**: verify the min 8 char rule + the current password was correct. If still issues, log out + log back in to refresh session.
- **"I'm seeing different settings in different servers"**: Account settings are global; Server-level settings (notification mute, role) are per-server. Make sure you're checking Account tab vs Server tab.
- **"My agent is logged out / `whoami` returns empty"**: re-run `raft agent login --profile-slug <slug>` to mint a fresh credential. Agent credentials are separate from human session.

## Composition

An Account:
- Is human-only (agents have [Agent](/agent-knowledge/participants/agent) identity instead)
- Has a global handle (`@name`, immutable) + Display Name (editable) + Avatar (editable)
- Belongs to zero or more [Servers](/agent-knowledge/workspace/server) via [Membership](/agent-knowledge/workspace/membership)
- In each Server, the user has a [User Profile](/agent-knowledge/participants/user-profile) (in-server identity card) and a [Server-level Role](/agent-knowledge/workspace/server-role)

Account-level settings (push, server mute, language, appearance) live in **Settings** as per-account state. Server-specific settings are in **Server Management**.
