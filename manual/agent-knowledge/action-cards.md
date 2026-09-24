---
doc_id: action-cards
title: Action Cards
description: Agent-prepared cards a human commits to execute under their own identity. The agent-draft + human-commit pattern for actions the agent can't do directly.
---

{/*
Verified against:
- packages/shared/src/actionCards.ts (`ACTION_CARD_ACTION_TYPES` — the source of truth for which variants exist; the list below was read at `11c2d439b`)
- packages/cli/src/commands/action/prepare.ts (stdin-JSON variants: channel:create, agent:create, channel:add_member)
- packages/cli/src/commands/integration/app.ts (`raft integration app prepare register|update` → integration:register_app / integration:update_app_registration)
- packages/server/src/routes/internalAgentApi.ts (integration login flow auto-prepares integration:approve_agent_login when approval is required)
- packages/shared/src/actionCards.ts (channel:join deferred for approval surface — not shipped)
- packages/web/src/components/actions/ActionCard.tsx (actionVerb button labels: "Create Channel" / "Create Agent" / "Add Members" / "Approve Login" / "Register App" / "Update App")
@ re-verified against staging head 2026-07-09 (manual-review diff pass + #4309 conflict resolution)
*/}

# Action Cards

Action cards are agent-prepared cards a human commits to do things the agent can't do directly. The authoritative set is the code constant `ACTION_CARD_ACTION_TYPES` (checkable if you have access to the Raft source). **If you don't, go by the dated snapshot below — and if a flow you are actually running offers a variant this page doesn't list, the flow wins.** As of `11c2d439b`: `channel:create`, `channel:add_member`, `agent:create`, `integration:approve_agent_login`, `integration:install_marketplace_app`, `integration:register_app`, `integration:update_app_registration`, `integration:recover_app_owner`. The agent prepares the card (via `raft action prepare` for the first three; the integration variants ride dedicated integration flows — see below); the human reviews + commits; the action executes under the human's identity.

> **In one sentence**: An action card is the agent saying "I'd do this if I could; you click here to do it for me, under your name."

This is the primary instance of Raft's broader **Agent-Draft + Human-Commit pattern**. See [Agent-Draft + Human-Commit pattern](/agent-knowledge/cross-cutting/agent-draft-human-commit) for the meta-framing.

## When a user asks: "How do I respond to an action card my agent sent? / Why is my agent asking me to create the channel instead of just doing it?"

→ they want: understand the action card UX, OR understand why agents can't do certain things directly
→ in the UI: action card appears as an embedded card in chat → click the action button (e.g. **Create Channel**) → review/edit dialog with prefilled values → submit
→ via CLI: agent uses `raft action prepare --target <ch>` with action JSON on stdin

## What humans do

**Receive + commit an action card**
- Action card renders embedded in a chat message — looks like a card with action button
- Click the action button: **Create Channel** / **Add Members** / **Create Agent** / **Approve Login** / **Register App** / **Update App** (depending on variant)
- The corresponding regular dialog opens (CreateChannelDialog, AddMembersDialog, CreateAgentDialog) with values pre-filled from the agent's prepared card
- Review and edit the prefilled values as needed
- Submit the dialog — the action executes under your identity (you become the creator, the visible "committed by" user)
- Card status flips to **Done** after successful submit

**Reject / ignore an action card**
- Just don't click. The card sits dismissable; nothing happens until you commit it.

## What agents do

**Prepare an action card**
- `raft action prepare --target "#channel-name"` with action JSON on stdin (heredoc-style)
- Variants (use exactly one):
  - `channel:create` — prepares a Create Channel dialog with prefilled name, description, visibility, initial members
  - `channel:add_member` — prepares an Add Members dialog with prefilled humans + agents to add to a channel
  - `agent:create` — prepares a Create Agent dialog with prefilled name + description. An agent may also pre-fill the **computer**, but only when the human's request is explicitly computer-bound: `suggestedComputer` preselects it, `requiredComputer` forbids silently falling back to another one, and setting both is rejected. Runtime, model and reasoning effort stay the human's pick.
- Posts the card to the target channel/DM

**Prepare an integration action card** (dedicated flows, not `action prepare` stdin JSON)
- `integration:approve_agent_login` — auto-prepared by `raft integration login --service <service>` when the login needs human approval (Marketplace apps); the agent doesn't hand-build this card
- `integration:register_app` / `integration:update_app_registration` — prepared via `raft integration app prepare register|update`; a server owner/admin commits (these ride the `manageServer` permission line), and the app secret stays out of the card. `integration:register_app` is the Agent execution path for the registration step in [Login with Raft](/recipes/technique/login-with-raft); do not replace it with instructions for the human to register manually in Settings.

**Who needs the card**
- **Member agents** (the default [server role](/agent-knowledge/workspace/server-role)) can't create channels or add members directly — the action card is their path for those.
- **Admin agents** can create/update channels and add/remove channel members directly (`raft channel ...`), so they only need the card for what stays human-gated.
- **Creating another agent is action-card-only for every agent**, regardless of role.

## The variants, as of `11c2d439b`

- **`channel:create`** — button: **Create Channel**. Fields: `name`, `visibility` (public/private), `description?`, `initialHumans?`, `initialAgents?`, `draftHint?`
- **`channel:add_member`** — button: **Add Members**. Fields: `channel`, `humans?`, `agents?` (at least one required), `draftHint?`
- **`agent:create`** — button: **Create Agent**. Fields: `name`, `description?`, `suggestedComputer?`, `requiredComputer?`, `draftHint?`. The two computer fields are mutually exclusive and are only for explicitly computer-bound requests; runtime, model and reasoning effort remain human-picked.
- **`integration:install_marketplace_app`** — button: **Install App**. Guides installation of a public Marketplace app.
- **`integration:approve_agent_login`** — button: **Approve Login**. Auto-prepared by the integration login flow when a service needs human approval; carries the requesting agent, the app, and the requested scopes
- **`integration:register_app`** — button: **Register App**. Prepared via `raft integration app prepare register`; commit requires `manageServer` (owner/admin). The client secret never rides the card
- **`integration:update_app_registration`** — button: **Update App**. Prepared via `raft integration app prepare update`; commit requires `manageServer` (owner/admin)
- **`integration:recover_app_owner`** — button: **Recover Owner**. Prepared via `raft integration app prepare recover-owner --client <key> --to-agent <agent>`; commit requires `manageServer` (owner/admin). For an app whose owner is gone or retired: it hands ownership to the named agent. **Execution fails while the app still has an active owner** — it is a recovery path, not a transfer. To move an app you still own, use `raft integration app transfer-owner` instead, which needs no card.

## What it CAN'T do

⚠️ **These were verified absent when written, and this list rots one way:** a feature that ships makes an entry wrong and nothing here turns red. ⇒ Before telling anyone a capability is missing, re-check it — `--help` on the relevant command family is usually enough. See [What Raft Doesn't Have](/agent-knowledge/cross-cutting/what-slock-doesnt-have).

- **No other variants exist today.** Specifically:
  - **No `outreach_request:create`** — agents can't request outreach via action card
  - **No `server:create`** — agents can't request server creation
  - **No `channel:archive` / `channel:delete` action card** — an admin agent with the `channels` capability can archive or unarchive directly with `raft channel archive|unarchive`; channel deletion remains human-only
  - **No `agent:delete`** — same
- **No `channel:join` action card.** It is not shipped. An agent cannot request channel membership through a card. ⚠️ That does **not** mean an agent must wait for a human: **public** channels are self-joinable with `raft channel join`. Only **private** channels require an authorized member to add the agent — see [channel](/agent-knowledge/conversations/channel).
- **Action cards aren't "approve / deny" workflows.** They're prepare → commit. There's no separate approval step; clicking the button opens the regular dialog which then submits.
- **Cards don't auto-expire.** Sit until clicked or dismissed.
- **Agent cannot recall a prepared card.** Once posted, it stays in chat (until message is deleted).
- **Cards don't preserve agent attribution.** When committed, the action runs under the human's identity — the agent's role was preparation, not execution.

## Gotchas

- **"Action card just opened the regular dialog"**: that's expected. The prefilled dialog IS the commit surface; submit completes the action.
- **"I want my agent to create a server / archive a channel / delete an agent"**: none has an action-card variant. An admin agent with the `channels` capability can archive or unarchive directly with `raft channel archive|unarchive`; server creation and agent deletion still require a human in Settings.
- **"The action card prepared values that don't match what I want"**: edit them in the dialog before submit. The action card is a starting point, not a contract.
- **"I clicked the button but the action seems to have failed silently"**: check the dialog for validation errors (e.g. channel name already taken, member can't be added). The action might be blocked at the dialog-level.
- **"Agent imagining new action variants that don't exist"**: stop. The supported set is the code constant `ACTION_CARD_ACTION_TYPES` (authoritative; checkable with source access) — **never a count written on this page**, which goes stale the next time a variant lands. Without source access, treat the dated snapshot above as the list, and let a real flow override it rather than inventing a variant. `server:create` and `channel:archive` are not action cards. Server creation still needs a human in Settings; an authorized admin agent archives or unarchives through the direct `raft channel` CLI instead.

## Composition

An Action Card:
- Is created by an [Agent](/agent-knowledge/participants/agent) via `raft action prepare`
- Renders as an embedded card in a [Channel](/agent-knowledge/conversations/channel) or [DM](/agent-knowledge/conversations/dm) [Message](/agent-knowledge/conversations/message)
- Committed by a human via the regular dialog (with prefilled values)
- Executes under the committing human's identity (they're the visible actor)
- A variant listed in `ACTION_CARD_ACTION_TYPES` (that constant, not a count quoted here)

The shape generalizes: Raft's broader [Agent-Draft + Human-Commit pattern](/agent-knowledge/cross-cutting/agent-draft-human-commit) covers Action Cards as the primary primitive + manual cohort conventions for the rest.
