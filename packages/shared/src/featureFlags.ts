import { SLACK_BRIDGE_PRODUCT_FEATURE_FLAG_KEYS as SHARED_SLACK_BRIDGE_PRODUCT_FEATURE_FLAG_KEYS } from "../feature-flag-taxonomy";

/**
 * Migrating an agent to Raft hosted (task #16), on top of Pro and
 * antiproton_hosted_runtime. Server-stage, default off, no rules: it
 * opens per server once the whole flow (completion included) has shipped.
 */
export const AGENT_MIGRATION_HOSTED_FEATURE_FLAG_KEY = "agent_migration_hosted_v0";
export const PROVIDER_CONNECTIONS_FEATURE_FLAG_KEY = "provider_connections_v0";
/** Hosted agent runtime on antiproton (raft-agent-provider.v1). Server-stage, default off. */
export const ANTIPROTON_HOSTED_RUNTIME_FEATURE_FLAG_KEY = "antiproton_hosted_runtime";
/** Computer-scoped provider probes (Phase 2A). Server-stage, default off. */
/** Wave 3: launch enforcement on matching fresh Computer receipts + legacy probe retirement. */
export const SERVER_LABS_UI_FEATURE_FLAG_KEY = "server_labs_ui_v0";
export const SERVER_GUEST_FEATURE_FLAG_KEY = "server_guest_v0";
/**
 * External channel invites (#wg-rbac:#16): a Server owner or admin invites
 * people outside the Server to a channel by email. Evaluated on the host
 * Server (the channel's). Not seeded; missing = off. While off, every
 * external-invite route answers 404 except the host's list and revoke (plan
 * §2a: an open invite is never stranded); existing relations stay.
 */
export const EXTERNAL_CHANNELS_FEATURE_FLAG_KEY = "external_channels_v1";
/**
 * Agent Lounge v0 (#proj-chat:#15): one public conversation per agent where
 * every non-guest human of the Server talks with that agent. Other agents may
 * read it but never take part. Server-scoped, not seeded; missing = off, and
 * while off the open route answers 404.
 */
export const AGENT_LOUNGE_FEATURE_FLAG_KEY = "agent_lounge_v0";
/**
 * Emergency hold of web Computer upgrades for one platform (10-24, #proj-o11y:ae66286a).
 * Server-scoped; missing = not held, so shipping it
 * changes nothing. On for a server: its Computers on that OS get no Upgrade button and no
 * Server-sent upgrade (policy reason `platform_held`); the page shows the manual commands, and
 * an upgrade request is refused with `COMPUTER_UPGRADE_PAUSED_FOR_PLATFORM`.
 */
export const REMOTE_COMPUTER_UPGRADE_PLATFORM_HOLD_FEATURE_FLAG_KEYS = {
  linux: "remote_computer_upgrade_hold_linux",
  macos: "remote_computer_upgrade_hold_macos",
  windows: "remote_computer_upgrade_hold_windows",
} as const;
/** "Same physical machine" grouping of Computers: the Server asks for, stores and shows a per-server host hash. Server-scoped, default off. */
export const COMPUTER_HOST_IDENTITY_FEATURE_FLAG_KEY = "computer_host_identity_v0";
/**
 * View Context (agentContextView.ts): a person can open the model context an
 * agent message was produced from. Server-scoped, default off; missing = off.
 * The Server also needs a Computer advertising `agent-context-view:v0`.
 */
export const AGENT_CONTEXT_VIEW_FEATURE_FLAG_KEY = "agent_context_view_v0";
/**
 * Emergency stop for the Computer version floor (COMPUTER_MIN_SUPPORTED_VERSION
 * / COMPUTER_MIN_VERSION_ENFORCE_AT on the server): past the deadline, agents
 * on older Computers are held only while this is on. Global; missing = off.
 */
export const COMPUTER_VERSION_ENFORCEMENT_FEATURE_FLAG_KEY = "computer_version_enforcement";
export const PUBLIC_SERVER_FEATURE_FLAG_KEY = "public_server_v0";
/** Public server SEO: indexing master switch for the search API (raft.build pages and sitemap). Default off. */
export const PUBLIC_SERVER_SEARCH_INDEX_FEATURE_FLAG_KEY = "public_server_search_index_v0";
/**
 * App prompt text consent (task #4, #proj-apps): an app's name, description
 * and When to use reach a Server's agents only as the revision its admin
 * confirmed, and a published app's edits wait for marketplace review.
 * Server-scoped, default off. While off for a Server it behaves as before:
 * agents read the app's current text and every change counts as confirmed.
 */
export const APP_PROMPT_TEXT_CONSENT_FEATURE_FLAG_KEY = "app_prompt_text_consent";
/**
 * Workspace Artifacts (docs/development/workspace-artifacts.md): Artifacts as a
 * native Raft object (metadata and permissions in the `app_artifacts` schema).
 * No longer a rollout flag: the Server answers this key by whether its
 * deployment runs Artifacts (object storage and the content origin
 * configured), the same for every server, and never from Feature Flag Admin.
 * Clients keep evaluating the key to know whether to show Artifacts; where the
 * answer is off, Artifact links stay plain links and nothing of it is shown.
 */
export const WORKSPACE_ARTIFACTS_FEATURE_FLAG_KEY = "workspace_artifacts_v0";
/**
 * Interactive link cards (RFC 076 §9). Retired on the server
 * (#raft-architecture:#32): the batched read always sends version 2 to a
 * card.v2 client whose App declared it, and prepare and execute are never
 * gated. Only the web still reads this key, to choose the batched read over
 * the GET; its Feature Flag Admin row stays on until the web stops reading it.
 */
export const INTERACTIVE_LINK_CARDS_FEATURE_FLAG_KEY = "interactive_link_cards";
/**
 * Adding Pro seats in place (task #10, #proj-commercial). Server-scoped,
 * default off; a missing flag or an evaluation failure reads as off. On: when
 * Create Agent, Invite or Guest → member runs out of seats, an owner adds
 * seats in a dialog and the action carries on. Off: the at-limit notice and
 * the link to Plan & Billing, as before.
 */
export const PRO_SEAT_ADD_FEATURE_FLAG_KEY = "pro_seat_add";
/**
 * Prepaid Pro paid once with Alipay (task #19, #proj-commercial;
 * docs/billing/prepaid-pro.md): an owner buys 1 or 12 months of Pro for a
 * Server, no auto-renewal. Server-scoped, default off; a missing flag or an
 * evaluation failure reads as off. Gates the offer and starting a prepaid
 * checkout only: time already paid for keeps granting Pro until it runs out,
 * and a paid checkout is recorded, whatever this says.
 */
export const PRO_PREPAID_FEATURE_FLAG_KEY = "pro_prepaid";
// `action_card_spec` (action cards rendered from `presentation.card`) has no
// constant: nothing in this repo reads it. The server builds and sends the
// card whatever it says, and the web renders every card from its spec. The
// App and older desktop builds still evaluate it by key to decide whether to
// render the card, so its row in Feature Flag Admin stays on; do not delete
// the row while they do.

/**
 * Mobile Activity inbox in place (#triage:#245): the mobile client updates
 * Activity rows in place and reconciles with an inbox read sent as
 * `X-Raft-Fetch-Reason: inplace_reconcile`. User-scoped (evaluated per user),
 * default off, no rules (migration 0679); the server reads it nowhere.
 */
export const MOBILE_INBOX_INPLACE_FEATURE_FLAG_KEY = "mobile_inbox_inplace_v0";

export const SLACK_BRIDGE_FEATURE_FLAG_KEYS = {
  master: "slack_bridge_v0",
  // Retained as legacy identifiers for mixed-version rollout; no current runtime gate.
  attachmentTransfer: "slack_attachment_transfer",
  reactionSync: "slack_reaction_sync",
} as const;

/**
 * Product capabilities are the only Slack Bridge flags that should be shown
 * in a user-facing Feature Flag Admin surface. Internal implementation fuses
 * remain code-owned and fail-closed, but are not operator-facing products.
 */
export const SLACK_BRIDGE_PRODUCT_FEATURE_FLAG_KEYS = SHARED_SLACK_BRIDGE_PRODUCT_FEATURE_FLAG_KEYS;

export const SLACK_BRIDGE_INTERNAL_FEATURE_FLAG_KEYS = [] as const;

export type SlackBridgeProductFeatureFlagKey =
  (typeof SLACK_BRIDGE_PRODUCT_FEATURE_FLAG_KEYS)[keyof typeof SLACK_BRIDGE_PRODUCT_FEATURE_FLAG_KEYS];

export function isSlackBridgeProductFeatureFlagKey(
  key: string,
): key is SlackBridgeProductFeatureFlagKey {
  return (Object.values(SLACK_BRIDGE_PRODUCT_FEATURE_FLAG_KEYS) as string[]).includes(key);
}

export type SlackBridgeFeatureFlagKey =
  (typeof SLACK_BRIDGE_FEATURE_FLAG_KEYS)[keyof typeof SLACK_BRIDGE_FEATURE_FLAG_KEYS];

export * from "./featureFlagRolloutGuardrail";
export * from "./featureFlagClientRules";


/**
 * Task v2 conversations (#wg-task-v2). Server-stage, default off, evaluated
 * for the INITIATING server (the server whose local channel the request came
 * through; for a joint channel that is never the shared joint storage server).
 * On: a created task posts no channel message and owns its own conversation
 * (`channels.type = 'task'`, created with the task; lazily on the first write
 * for a pre-v2 task) and may hang under a chat message (`source_message_id`,
 * CLI `--message-id`). Off (or missing / evaluation failure): creation posts
 * the visible task-title chat message whose thread is the discussion, as
 * before, and a source message is refused with `task_v2_not_enabled`. First
 * enabled for /botiverse and /raft via FFA.
 */
export const TASK_V2_CONVERSATIONS_FEATURE_FLAG_KEY = "task_v2_conversations_v0";
/**
 * The continuation pilot (#wg-ax:#5; owner Sage): a held `raft message send`
 * pauses as a continuation, asking the agent whether to send it as it is,
 * write a new message, not send it, or (once the server suggests it) send it
 * anyway, instead of saving a draft. Server-scoped, default off, no rules; a
 * missing flag or an evaluation failure reads as off. The Server reports it in
 * the agent context (`features.continuationsPilot`), which the CLI reads when
 * a send is held, so turning it on needs no daemon change or agent restart.
 * Rolled out per server, the agents that get it are self-selected: a
 * randomized per-agent rollout waits for an agent randomization unit.
 */
export const CONTINUATIONS_PILOT_FEATURE_FLAG_KEY = "continuations_pilot_v0";
/**
 * Runtimes the continuation pilot leaves on the draft flow, wherever the flag
 * is on. Codex gets a command's exit code and output as one tool result and
 * reads the pause's exit 10 as a failure: on the pilot's first day it mostly
 * sent the message again (a new pause each time), and an unanswered pause
 * keeps neither a sent message nor a draft (#wg-ax:#5). The Server reports
 * the pilot off for them, which also covers a CLI from before its own check.
 */
export const CONTINUATIONS_DRAFT_FLOW_RUNTIMES: ReadonlySet<string> = new Set(["codex"]);
/**
 * Agent read progress: in a channel, DM or thread, the web shows each agent's
 * avatar on the last message it has read and moves it live as the agent
 * reads (agentReadProgress.ts). Server-scoped, default off, no rules; a
 * missing flag or an evaluation failure reads as off. While off a
 * `read_progress:watch` is refused and no `read_progress:updated` is sent.
 * The initial positions come from the channel detail's `peerReadStates`
 * (read receipts, always on).
 */
export const AGENT_READ_PROGRESS_FEATURE_FLAG_KEY = "agent_read_progress_v0";
/**
 * Forum-style channels (#proj-chat:#24): a channel admin can set a regular
 * channel (public or private; not joint, DM, thread or task) to order its
 * top-level messages by latest activity, the message's own time or its latest
 * thread reply, newest at the bottom next to the composer, the same for every
 * member (`channels.thread_sort = 'activity'`). Server-scoped, default off, no
 * rules; a missing flag or an evaluation failure reads as off. Off: PATCH
 * `/channels/:id` refuses `threadSort` with 404, the activity page returns
 * 404, and the web shows every channel in post order whatever its stored
 * setting.
 */
export const CHANNEL_THREAD_SORT_FEATURE_FLAG_KEY = "channel_thread_sort_v0";
/**
 * RFC 081 inbox items (#wg-ax:#17): `GET /inbox/conversations?items=true`
 * lists app items, app fallback items and reminder items beside
 * conversations, and `POST /inbox/read` / `POST /inbox/dismiss` answer.
 * Server-scoped, default off, staged per server; it is also the kill switch.
 * A missing flag or an evaluation failure reads as off. Off: `items=true` is
 * ignored (the conversation-only list, no `rows`), and read and dismiss
 * answer 404 `INBOX_ITEMS_DISABLED`. The launch time (which events are items,
 * what `preLaunch` counts) is the server's `RAFT_INBOX_ITEMS_LAUNCH_AT`, not
 * the flag's.
 */
export const AGENT_INBOX_ITEMS_FEATURE_FLAG_KEY = "agent_inbox_items_v0";
/**
 * Reaction notices for agents (#wg-ax:#26): an agent is told when someone else
 * reacts to a message it sent, as one inbox item per message
 * (`app:system.reaction-notices/msg/<message id>`, shared
 * reactionAgentNotice.ts). Server-scoped (the author agent's server), default
 * off, no rules; a missing flag or an evaluation failure reads as off. It
 * only does anything where inbox items are on for that server
 * (`agent_inbox_items_v0` and `RAFT_INBOX_ITEMS_LAUNCH_AT`). Off: a reaction
 * queues nothing, and notices already queued are no longer handed over or
 * listed (the app's delivery guard). The typed `reactions` of the agent API's
 * message envelope are not gated by it.
 */
export const AGENT_REACTION_NOTICES_FEATURE_FLAG_KEY = "agent_reaction_notices_v0";
/**
 * Agent token usage (#proj-o11y:42f2af5c): the server adds each finished
 * turn's `tokens` (ActivityTurnSummary) into agent_usage_daily, and
 * `GET /api/servers/:id/agent-usage` reads it for the agent panel's Usage tab
 * and the Members › Agents usage view. Server-scoped (the agent's server),
 * default off, not seeded; a missing flag or an evaluation failure reads as
 * off. Off: nothing is added (so a server's usage starts the day it is turned
 * on, which the endpoint reports as `since`) and the endpoint answers 404.
 */
export const AGENT_USAGE_FEATURE_FLAG_KEY = "agent_usage_v0";
/**
 * Channel announcements (#proj-chat:#29): a channel's announcement is the one
 * Artifact homed in that channel that the channel's owner (its channel admin)
 * or a Server owner or admin set as its announcement (`channels.
 * announcement_artifact_id`; the rule is editChannelMetadata, the one PATCH
 * `/channels/:id` and `raft channel update` use). Its versions are the edit
 * history and its comments the discussion; who sees it follows the channel.
 * Public, private and joint channels only (a joint's every side shows the
 * same one), never a DM, thread or task. Server-scoped, default off, no rules;
 * a missing flag or an evaluation failure reads as off. Off: no channel
 * payload carries `announcement`, `raft channel info` prints no line, setting
 * one is refused (`channel_announcement_disabled`) and no announcement notice
 * goes to the channel's agents. A stored announcement is kept and shows
 * again once it is on. Needs workspace_artifacts_v0 on as well.
 */
export const CHANNEL_ANNOUNCEMENT_FEATURE_FLAG_KEY = "channel_announcement_v0";
/**
 * Built pixel avatars for people (docs/contracts/human-pixel-avatar.md): the
 * "Build an avatar" entry in the person avatar edit menu (and so the builder,
 * on Settings › Account, your profile and account setup), saving one
 * (`PUT /api/auth/me/avatar-recipe`), and the random built avatar a new
 * account starts with. Server-scoped, default off, no rules; missing = off,
 * and an evaluation failure reads as off.
 * - Web: evaluated for the current server; no current server reads off.
 * - Saving: the account is not a server's, so it is evaluated for the server
 *   the request names (X-Server-Id) when the person is a member of it, and
 *   otherwise as on when it is on for any server the person belongs to.
 *   Off: 404 `HUMAN_AVATAR_BUILDER_DISABLED`, the avatar unchanged.
 * - New accounts: evaluated for the server the account is joining when sign-up
 *   knows it (an SSO connection's server); email and social sign-up know none
 *   and read off. Off: no avatar, the generic person icon, as before.
 * While off the edit menu is Upload a photo only (it offers no removal either
 * way). Never gated: drawing a stored `pixel-human:v1:` avatar (server SVG,
 * web, desktop, mobile), since a person shows in servers where it is off.
 * Full rollout = remove this flag; until then, only SSO sign-ups on flagged
 * servers get an automatic avatar, and onboarding with no current server
 * shows no builder entry.
 */
export const HUMAN_AVATAR_BUILDER_FEATURE_FLAG_KEY = "human_avatar_builder_v0";
/**
 * Claude limit resets from the Computer usage card
 * (docs/contracts/runtime-account-usage.md, "Limit resets (Claude)"): "View
 * available resets" and "Use" per kind, driven on the Computer through
 * Claude Code's own `/limit-reset`. Server-scoped, default off, no rules;
 * missing = off, and an evaluation failure reads as off. Off: the card shows
 * nothing new, the runtime-auth read carries no `claudeLimitResets`, and the
 * limit-reset routes refuse Claude (404 `claude_limit_reset_disabled`).
 * Codex limit resets are not gated by it. On, it still needs a Computer
 * advertising DAEMON_CAPABILITY_RUNTIME_LIMIT_RESET_CLAUDE_KINDS.
 */
export const CLAUDE_LIMIT_RESET_FEATURE_FLAG_KEY = "claude_limit_reset";
