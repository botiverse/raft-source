// Product events — typed write-side for the `product_events` table.
//
// **Owners:** @Dozy (schema + product event contract) + @meichen (data /
// query / dashboard). Decided 2026-05-13 in #proj-permission:13b42cc0.
//
// This file is the *only* approved write path into `product_events`. All
// callers must go through a typed helper here. Do NOT call `db.insert(productEvents)`
// directly from anywhere else — the DB check constraints will reject
// unknown subject_type / event_type values, but the typed helpers are what
// keep the shape contract sane (metadata schema, low-cardinality fields,
// no raw content / PII).
//
// **Adding a new feature:** propose a new typed helper here (e.g.
// `recordReactionEvent`), then extend the check constraints in `schema.ts`
// + write a migration to widen the whitelist. Don't ship one without the
// other.
//
// **Failure mode:** event-write failures must never break the underlying
// product flow. We log + swallow at the helper boundary so a stuck DB
// doesn't take down the action-card execute path. Funnel data is
// best-effort by design.

import { sql } from "drizzle-orm";
import { getDb, type DatabaseTransaction } from "../db/index.js";
import { productEvents } from "../db/schema.js";

/**
 * Action-card-specific event type. Mirrors the day-1 whitelist enforced by
 * the `product_events_event_type_whitelist` check constraint. Keep in sync
 * if either side changes.
 */
export type ActionCardEventType =
  | "action_card.open"
  | "action_card.dismiss"
  | "action_card.execute_attempt"
  | "action_card.execute_success"
  | "action_card.execute_fail"
  | "action_card.expired";

export type OnboardingWizardEventType =
  | "onboarding_wizard.step_shown"
  | "onboarding_wizard.primary_clicked"
  | "onboarding_wizard.skip_clicked"
  | "onboarding_wizard.dismissed"
  | "onboarding_wizard.completed"
  | "onboarding_wizard.error";

export type OnboardingWizardStepId =
  | "add-computer"
  | "detect-runtime"
  | "create-agent"
  | "referral-source"
  | "invite-teammates"
  | "join-community";

export type ActorType = "human" | "agent" | "system";

export type EventSource = "web" | "server" | "cron";

/**
 * Low-cardinality error bucket for `execute_fail` events. Funnel SQL groups
 * by this. Keep the value set tiny — every value here becomes a column in a
 * dashboard pivot.
 */
export type ActionCardErrorClass =
  | "validation"
  | "permission"
  | "not_found"
  | "conflict"
  | "network"
  | "unknown";

/**
 * Metadata shape for action_card.* events. Keep all fields low-cardinality
 * and aggregable. Free-text, message bodies, channel names, prompts, file
 * paths, raw stack traces / caught error messages, etc. must NOT land here.
 *
 * Per Leiysky/Dozy/meichen review (2026-05-13 #proj-permission:13b42cc0
 * msg=086dc014/9d0f10bd/3ce7cb05): no raw `error_message` even truncated —
 * caught text can carry user input, payload fragments or DB error strings.
 *
 * - `action_type`: copy of the underlying `action.type` at the time of the
 *   event (`channel:create` / `agent:create` / `channel:add_member` /
 *   `integration:approve_agent_login` /
 *   `integration:register_app` / `integration:update_app_registration`).
 *   Always derived server-side from the validated card metadata; client-
 *   supplied values are ignored. Denormalized so funnel queries don't have
 *   to join `action_cards` for the most common dimension.
 * - `dismiss_reason`: 'close_button' | 'esc' | 'backdrop' | 'route_change'
 *   — best-effort signal; null if frontend can't tell.
 * - `error_class`: short categorical bucket for `execute_fail`. SQL groups
 *   by this. NOT a raw error message.
 * - `error_code`: low-cardinality categorical code (e.g. ActionCardError
 *   `code` like `STATE_MISMATCH`, `WRONG_SERVER`). Optional refinement
 *   below `error_class`. Bounded length defensively.
 * - `http_status`: integer HTTP status if applicable. Useful as a coarse
 *   secondary dimension for `error_class=unknown`.
 * - `latency_ms`: optional client-measured duration (e.g. dialog dwell,
 *   submit roundtrip). Reserved.
 */
export interface ActionCardEventMetadata {
  action_type?: "channel:create" | "agent:create" | "channel:add_member" | "integration:approve_agent_login" | "integration:install_marketplace_app" | "integration:register_app" | "integration:update_app_registration" | "integration:recover_app_owner";
  dismiss_reason?: "close_button" | "esc" | "backdrop" | "route_change";
  error_class?: ActionCardErrorClass;
  error_code?: string;
  http_status?: number;
  latency_ms?: number;
}

export interface OnboardingWizardEventMetadata {
  step_id: OnboardingWizardStepId;
  wizard_version: string;
  session_id: string;
  action?: string;
  result?: string;
  reason?: string;
  latency_ms?: number;
}

export interface RecordActionCardEventArgs {
  /**
   * Canonical action card id (`action_cards.id`). Per Dozy + meichen 2026-
   * 05-13 (msg=9d0f10bd / msg=174ba78c) `subject_id` is the product entity,
   * NOT the carrier message id — funnel SQL joins as
   * `product_events.subject_id = action_cards.id`. The carrier message id
   * is reachable via `action_cards.message_id` when needed.
   */
  cardId: string;
  eventType: ActionCardEventType;
  /** Null for system-emitted events (e.g. future TTL `expired` from cron). */
  actor?: { type: ActorType; id: string | null } | null;
  source?: EventSource;
  /** At-most-once write within (cardId, eventType) when set. */
  idempotencyKey?: string;
  metadata?: ActionCardEventMetadata;
}

export interface RecordOnboardingWizardEventArgs {
  /** Current workspace/server id. This is the `subject_id` grain. */
  serverId: string;
  eventType: OnboardingWizardEventType;
  actor: { type: "human"; id: string };
  source?: Extract<EventSource, "web" | "server">;
  /** At-most-once write within (serverId, eventType) when set. */
  idempotencyKey?: string;
  metadata: OnboardingWizardEventMetadata;
}

export interface RecordSecondAgentCreatedEventArgs {
  /** Workspace/server in which the durable second-agent milestone occurred. */
  serverId: string;
  /** The newly inserted agent that made the server's all-time ordinal equal 2. */
  secondAgentId: string;
  /** Human who committed the create-agent operation. */
  actorUserId: string;
  /** Reuse the agent row's database timestamp so the event and fact agree exactly. */
  occurredAt: Date;
}

const ONBOARDING_WIZARD_STEPS = new Set<OnboardingWizardStepId>([
  "add-computer",
  "detect-runtime",
  "create-agent",
  "referral-source",
  "invite-teammates",
  "join-community",
]);

const MAX_EVENT_FIELD_LENGTH = 64;

function cleanShortField(value: string | undefined): string | undefined {
  if (typeof value !== "string") return undefined;
  const trimmed = value.trim();
  return trimmed ? trimmed.slice(0, MAX_EVENT_FIELD_LENGTH) : undefined;
}

/**
 * Record an action-card lifecycle event. Best-effort: failures are logged
 * and swallowed so a wobbly DB doesn't take down the underlying product
 * flow. Callers should NOT await the result for correctness.
 */
export async function recordActionCardEvent(
  args: RecordActionCardEventArgs,
): Promise<void> {
  try {
    const db = getDb();
    // Defensive cap on `error_code` length — should always be a short
    // categorical code, but bound it so a buggy caller can't dump arbitrary
    // text into the funnel.
    const meta: ActionCardEventMetadata = { ...(args.metadata ?? {}) };
    if (typeof meta.error_code === "string" && meta.error_code.length > 64) {
      meta.error_code = meta.error_code.slice(0, 64);
    }

    await db
      .insert(productEvents)
      .values({
        subjectType: "action_card",
        subjectId: args.cardId,
        eventType: args.eventType,
        actorType: args.actor?.type ?? null,
        actorId: args.actor?.id ?? null,
        source: args.source ?? "server",
        idempotencyKey: args.idempotencyKey ?? null,
        metadata: meta as unknown as object,
      })
      // Idempotency: if a unique violation fires on (subject_id, event_type,
      // idempotency_key) we silently drop — the event is already recorded.
      // The partial unique index only triggers when idempotency_key is
      // non-null, so events without a key always insert.
      .onConflictDoNothing();
  } catch (err) {
    console.error(
      `[productEvents] failed to record ${args.eventType} for card ${args.cardId}:`,
      err,
    );
  }
}

/**
 * Record onboarding wizard interaction events. Best-effort: failures are
 * swallowed so analytics cannot block onboarding. Push-notification prompts
 * intentionally remain in `web_push_prompt_events`; this helper only covers
 * core wizard step interactions.
 */
export async function recordOnboardingWizardEvent(
  args: RecordOnboardingWizardEventArgs,
): Promise<void> {
  try {
    if (!ONBOARDING_WIZARD_STEPS.has(args.metadata.step_id)) {
      throw new Error(`unsupported onboarding wizard step: ${args.metadata.step_id}`);
    }

    const db = getDb();
    const meta: OnboardingWizardEventMetadata = {
      step_id: args.metadata.step_id,
      wizard_version: cleanShortField(args.metadata.wizard_version) ?? "unknown",
      session_id: cleanShortField(args.metadata.session_id) ?? "unknown",
    };

    const action = cleanShortField(args.metadata.action);
    const result = cleanShortField(args.metadata.result);
    const reason = cleanShortField(args.metadata.reason);
    if (action) meta.action = action;
    if (result) meta.result = result;
    if (reason) meta.reason = reason;
    if (
      typeof args.metadata.latency_ms === "number" &&
      args.metadata.latency_ms >= 0 &&
      args.metadata.latency_ms < 1_000_000
    ) {
      meta.latency_ms = Math.round(args.metadata.latency_ms);
    }

    await db
      .insert(productEvents)
      .values({
        subjectType: "onboarding_wizard",
        subjectId: args.serverId,
        eventType: args.eventType,
        actorType: args.actor.type,
        actorId: args.actor.id,
        source: args.source ?? "web",
        idempotencyKey: args.idempotencyKey ?? null,
        metadata: meta as unknown as object,
      })
      .onConflictDoNothing();
  } catch (err) {
    console.error(
      `[productEvents] failed to record ${args.eventType} for onboarding wizard ${args.serverId}:`,
      err,
    );
  }
}

/**
 * Record the server's second-ever agent creation in the caller's transaction.
 *
 * Unlike interaction telemetry, this event is a durable projection of the
 * agent row and therefore MUST commit atomically with that row. Do not wrap
 * this helper in a best-effort catch: if the event cannot be written, the
 * second agent must not commit without its analytical receipt.
 *
 * The subject grain is the server (one milestone per server). The exact second
 * agent identity is a UUID in metadata, while actor_type/id identifies the
 * human who performed the create. The constant idempotency key makes retries
 * at-most-once for `(server, agent.second_created)`.
 */
export async function recordSecondAgentCreatedEvent(
  tx: DatabaseTransaction,
  args: RecordSecondAgentCreatedEventArgs,
): Promise<void> {
  await tx
    .insert(productEvents)
    .values({
      subjectType: "server",
      subjectId: args.serverId,
      eventType: "agent.second_created",
      actorType: "human",
      actorId: args.actorUserId,
      occurredAt: args.occurredAt,
      source: "server",
      idempotencyKey: "server-second-agent-created-v1",
      metadata: {
        agent_id: args.secondAgentId,
        agent_ordinal: 2,
        scope: "server",
        capture_mode: "live",
        writer: "agent_service.create_agent",
      },
    })
    .onConflictDoNothing();
}

/**
 * Map a thrown error from the action-card execute path to a low-cardinality
 * `error_class` bucket plus optional `error_code` / `http_status` refiners.
 * Used by the execute hook so all `execute_fail` events get a clean
 * dimension to group by. Per Leiysky/Dozy/meichen 2026-05-13: no raw
 * `error_message` — even truncated, caught text can carry user payload
 * fragments or DB error strings, which violates the no-PII / no-raw-content
 * boundary of `product_events`.
 */
export function classifyExecuteError(err: unknown): ActionCardEventMetadata {
  const e = err as { status?: number; code?: string } | null;
  if (!e || typeof e !== "object") return { error_class: "unknown" };

  const out: ActionCardEventMetadata = { error_class: "unknown" };
  if (typeof e.status === "number") out.http_status = e.status;
  if (typeof e.code === "string" && e.code.length > 0) out.error_code = e.code;

  if (e.status === 400 || e.code === "INVALID_PAYLOAD" || e.code === "MALFORMED_ACTION") {
    out.error_class = "validation";
    return out;
  }
  if (e.status === 403 || e.code === "WRONG_SERVER" || e.code === "NOT_A_MEMBER") {
    out.error_class = "permission";
    return out;
  }
  if (e.status === 404) {
    out.error_class = "not_found";
    return out;
  }
  if (e.status === 409) {
    out.error_class = "conflict";
    return out;
  }
  return out;
}

// Re-export the SQL helper for tests that want to count rows.
export { sql };
