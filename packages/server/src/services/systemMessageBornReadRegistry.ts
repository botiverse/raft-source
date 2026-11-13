import type { SystemMessageInboxFactProducer } from "./messageService";

/**
 * Born-read classification registry for system-message / persisted-fact producers.
 *
 * ## Why this exists (anti-regression forced declaration)
 *
 * `broadcastSystemMessage` records a fact with `senderType:"system"`, so the
 * ordinary receiver===sender born-read shortcut can never fire for the human or
 * agent who actually caused the message. That made every self-caused system
 * message (I add a member, I create a task, I join a channel) show up UNREAD in
 * my own Activity. The fix threads the real `causalActor` down to the unread
 * gate for the born-read producers below.
 *
 * The risk with a per-call-site fix is drift: a NEW system-message producer is
 * added and silently regresses (its actor's own row is unread again), or an
 * onboarding-style notice is wrongly born-read and vanishes for the reader who
 * needed it. This registry closes that gap by forcing every production producer
 * to declare its born-read policy.
 *
 * The `satisfies Record<ProductionSystemMessageProducer, ...>` below is the gate:
 * adding a new literal to `SystemMessageInboxFactProducer` fails `tsc` (missing
 * key) until it is classified here. The accompanying contract test
 * (`systemMessageBornReadRegistry.test.ts`) re-asserts completeness at runtime
 * and pins the critical classifications.
 *
 * ## Classifications
 *
 * - `born-read`   — self-caused system message. The producing call site passes
 *                   `causalActor`; the actor's own inbox row is written
 *                   `unreadEligible=false` while every other receiver stays
 *                   unread. (channel/task/join structural notices.)
 * - `skip`        — no inbox fact is recorded at all (`inboxFactPolicy.mode:"skip"`).
 *                   Lifecycle churn and zero-audience notices.
 * - `notify-exclude` — recorded as unread, deliberately NOT born-read: the actor
 *                   IS the intended reader and must still see it unread
 *                   (onboarding instructions to the joiner). Do NOT pass
 *                   `causalActor` for these.
 * - `real-sender` — not a `broadcastSystemMessage` producer. Recorded through
 *                   `recordInboxFactsForPersistedMessages` carrying the message's
 *                   own real (non-"system") sender, so the actor is already
 *                   born-read by the ordinary receiver===sender shortcut with no
 *                   `causalActor` needed.
 */
export type SystemMessageBornReadClassification =
  | "born-read"
  | "skip"
  | "notify-exclude"
  | "real-sender";

/**
 * All non-test producers. `test.*` producers are exercised only by tests and are
 * intentionally excluded from the forced-declaration registry.
 */
export type ProductionSystemMessageProducer = Exclude<
  SystemMessageInboxFactProducer,
  `test.${string}`
>;

export const SYSTEM_MESSAGE_BORN_READ_CLASSIFICATION = {
  // Self-caused system messages: actor born-read, everyone else unread.
  "agent.join_channel": "born-read",
  // The human who changed the role reads it; the agent gets it unread.
  "agent.server_role_changed": "born-read",
  // The owner must fix the agent's credential or model. Born-read for the
  // agent (the causal actor): it is not for the agent, and an unread fact
  // would be carried into its next start as a message to act on.
  "agent.runtime_action_required": "born-read",
  // The migrated agent is the intended reader; keep the completed receipt unread.
  "agent.migration_completed_receipt": "notify-exclude",
  "agent.migration_canceled_receipt": "notify-exclude",
  "agent.migration_failed_receipt": "notify-exclude",
  "agent.migration_aborted_receipt": "notify-exclude",
  // An official app's due reminder in the agent's private dm:@reminders; the
  // agent is the only and intended reader, so it stays unread.
  "app.agent_reminder": "notify-exclude",
  "channel.agent_membership": "born-read",
  "channel.human_membership": "born-read",
  "channel.rename": "born-read",
  // Setting, replacing or removing a channel's announcement (channel_announcement_v0): the actor reads it.
  "channel.announcement": "born-read",
  "channel.archive": "born-read",
  "channel.joint_disconnect": "born-read",
  "channel.joint_connect": "born-read",
  "channel.unarchive": "born-read",
  "task.created_summary": "born-read",
  "task.assignment_receipt": "born-read",
  "task.converted_summary": "born-read",
  // Task status transitions are a collaboration signal (like task.created_summary):
  // recorded for the thread audience, born-read for the actor who moved the task.
  // Product ruling #9 (Tenny): born-read, not skip.
  "task.lifecycle_thread": "born-read",
  // A hosted Cindy's Day-2 recap wake (the server fires it, no Computer):
  // unread for her, born-read for the owner whose thread it lands in.
  "onboarding.hosted_recap_wake": "born-read",
  // Action-card result reply in the card thread: @mentions the preparing
  // agent (unread for it); born-read for the human who executed the card.
  "action_card.result_reply": "born-read",
  // RFC 077 PR 2b: the receipt of a message an assistant sent as its owner,
  // in their DM. Caused by the assistant (born-read for it); unread for the owner.
  "assistant.delegated_receipt": "born-read",
  // An admin stopped someone's assistant: unread for the owner, in their DM
  // with it; born-read for the admin who stopped it (not normally a reader).
  "assistant.stopped_by_admin": "born-read",

  // No fact recorded (mode:"skip"): lifecycle churn / zero-audience.
  "channel.self_unfollow_thread": "skip",
  "task.deleted_summary": "skip",

  // Recorded and intentionally kept unread for the actor (the joiner is the
  // intended reader). Never pass causalActor for these.
  "onboarding.owner_instruction": "notify-exclude",
  "onboarding.owner_opener_v2_ledger": "notify-exclude",
  "onboarding.member_instruction": "notify-exclude",
  "onboarding.all_channel_unlock": "notify-exclude",
  "onboarding.cross_channel_hint": "notify-exclude",
  // A Slack Bridge pair paused on its first blocked send. No human caused it
  // at that moment; the configurer it mentions must see it unread.
  "slack_bridge.binding_paused": "notify-exclude",
  // A notice to a server's owners and admins in their own DM with themselves
  // (#13746; retired by #wg-rbac:#42, no longer sent, kept for the rows it
  // wrote): someone else, often on another server, caused it.
  "server.admin_notice": "notify-exclude",
  // WeChat was bound to the owner's assistant (wechatBridgeService). The owner
  // scanned, but the notice is for the case they did not: it stays unread.
  "assistant.wechat_connected": "notify-exclude",
  // The WeChat bridge's token went stale (iLink -14; wechatBridgeWorker). No
  // one caused it; the owner must see it unread to reconnect.
  "assistant.wechat_reconnect_required": "notify-exclude",
  // Not broadcastSystemMessage — real sender already drives the born-read gate.
  "action_card.carrier": "real-sender",
  "task.body": "real-sender",
  // Provider projections are persisted chat messages, not system notices. Their
  // immutable external projection identity is carried through the ordinary
  // persisted-message fact path; no causalActor system-message exception applies.
  "external_projection.inbound": "real-sender",
} satisfies Record<ProductionSystemMessageProducer, SystemMessageBornReadClassification>;

/**
 * Producers that pass `causalActor` at their call site. Kept as an explicit
 * derived set so the contract test can assert the born-read wiring stays aligned
 * with the registry.
 */
export function isBornReadProducer(
  producer: ProductionSystemMessageProducer,
): boolean {
  return SYSTEM_MESSAGE_BORN_READ_CLASSIFICATION[producer] === "born-read";
}

/**
 * The `born-read` producers — the subset whose call site MUST pass `causalActor`.
 * Derived from the classification registry (single source of truth), so adding a
 * producer and classifying it `born-read` updates this automatically. Used to
 * build the compile-time discriminated union on `broadcastSystemMessage`'s
 * `inboxFactPolicy`.
 */
export type RequiresCausalActorProducer = {
  [P in ProductionSystemMessageProducer]:
    (typeof SYSTEM_MESSAGE_BORN_READ_CLASSIFICATION)[P] extends "born-read" ? P : never;
}[ProductionSystemMessageProducer];

/**
 * Which system-message producers are notification events (every transport,
 * through the notification outbox: services/notifications/enqueue.ts).
 * Same forced declaration as the born-read registry: a new producer fails
 * `tsc` until it is classified here. `none`: the message counts as unread
 * activity and notifies only the people it @mentions (design D10); a
 * `real-sender` producer above notifies like any message.
 *
 * - `task_status`           — task thread followers; plus the task creator and
 *                             human assignee; never the actor.
 * - `task_assigned`         — the personal-attention target (the assignee).
 * - `agent_action_required` — the human in the owner↔agent DM.
 *
 * A persisted message whose producer is no longer listed (e.g. the retired
 * `agent.tool_stuck` owner notice) classifies as `none`.
 */
export type SystemMessageNotificationEvent =
  | "task_status"
  | "task_assigned"
  | "agent_action_required"
  | "none";

export const SYSTEM_MESSAGE_NOTIFICATION_EVENT = {
  "agent.join_channel": "none",
  "agent.server_role_changed": "none",
  "agent.runtime_action_required": "agent_action_required",
  "agent.migration_completed_receipt": "none",
  "agent.migration_canceled_receipt": "none",
  "agent.migration_failed_receipt": "none",
  "agent.migration_aborted_receipt": "none",
  // The reminder's agent is the reader; the human creator is notified from the
  // fire path instead (reminderFiredNotification).
  "app.agent_reminder": "none",
  "channel.agent_membership": "none",
  "channel.human_membership": "none",
  "channel.rename": "none",
  // Like a rename: unread activity (a muted channel's stays out), no push (tygg, #proj-chat:#29).
  "channel.announcement": "none",
  "channel.archive": "none",
  "channel.joint_disconnect": "none",
  "channel.joint_connect": "none",
  "channel.unarchive": "none",
  "task.created_summary": "none",
  "task.assignment_receipt": "task_assigned",
  "task.converted_summary": "none",
  "task.lifecycle_thread": "task_status",
  "onboarding.hosted_recap_wake": "none",
  "action_card.result_reply": "none",
  "assistant.delegated_receipt": "none",
  "assistant.stopped_by_admin": "none",
  "assistant.wechat_connected": "none",
  "assistant.wechat_reconnect_required": "none",
  "channel.self_unfollow_thread": "none",
  "task.deleted_summary": "none",
  "onboarding.owner_instruction": "none",
  "onboarding.owner_opener_v2_ledger": "none",
  "onboarding.member_instruction": "none",
  "onboarding.all_channel_unlock": "none",
  "onboarding.cross_channel_hint": "none",
  "action_card.carrier": "none",
  "task.body": "none",
  "external_projection.inbound": "none",
  // Reaches the configurer as a personal mention in the channel's inbox.
  "slack_bridge.binding_paused": "none",
  // Retired (#wg-rbac:#42): it notified through its own `system_notice` outbox row.
  "server.admin_notice": "none",
} satisfies Record<ProductionSystemMessageProducer, SystemMessageNotificationEvent>;

export function systemMessageNotificationEvent(producer: string): SystemMessageNotificationEvent {
  return (SYSTEM_MESSAGE_NOTIFICATION_EVENT as Record<string, SystemMessageNotificationEvent | undefined>)[producer] ?? "none";
}
