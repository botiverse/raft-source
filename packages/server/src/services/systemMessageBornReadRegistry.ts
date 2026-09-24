import type { SystemMessageInboxFactProducer } from "./messageService.js";

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
  // The migrated agent is the intended reader; keep the completed receipt unread.
  "agent.migration_completed_receipt": "notify-exclude",
  "agent.migration_canceled_receipt": "notify-exclude",
  "agent.migration_failed_receipt": "notify-exclude",
  "channel.agent_membership": "born-read",
  "channel.human_membership": "born-read",
  "channel.rename": "born-read",
  "channel.archive": "born-read",
  "channel.unarchive": "born-read",
  "task.created_summary": "born-read",
  "task.assignment_receipt": "born-read",
  "task.converted_summary": "born-read",
  // Task status transitions are a collaboration signal (like task.created_summary):
  // recorded for the thread audience, born-read for the actor who moved the task.
  // Product ruling #9 (Tenny): born-read, not skip.
  "task.lifecycle_thread": "born-read",

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
