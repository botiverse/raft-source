import { randomUUID } from "node:crypto";
import type { TraceAttributes } from "@botiverse/raft-shared";
import { addTraceEvent } from "../tracing/semanticTrace.js";

// Design note: this file defines the canonical lifecycle event and projection
// trace envelope documented in rfcs/031-agent-lifecycle-event-model-rfc.zh.html
// (source discussion: #proj-runtime:4dbe9aa7).
//
// Keep this module limited to low-level event identity, projection trace row
// shape, sanitization, and reserved trace attribute rules. It must not decide
// lifecycle product semantics such as "Stopped" vs "Interrupted" vs
// wake-eligible; those rules belong in agentLifecycleReducer.ts. It must not
// translate legacy daemon/server payloads; that compatibility layer belongs in
// legacyAgentLifecycleAdapter.ts. It must not perform DB writes, live activity
// broadcasts, wake-lock updates, or Activity Log persistence; those side effects
// belong in agentLifecycleProjectionWriter.ts.
//
// Identity rules are intentionally split because these ids answer different
// questions and substituting one for another breaks retries, dedupe, or trace
// joins:
// - lifecycleEventId identifies one canonical lifecycle event envelope.
// - correlationId groups events/projections/traces from one product incident or
//   operation, e.g. one daemon restart window affecting many agents.
// - idempotencyKey dedupes event ingestion/replay for the same canonical event.
// - dedupeKey is projection-specific idempotency for a user-visible projection
//   row, e.g. one Activity Log item per agent for one incident; it is carried on
//   projection traces / DB rows, not on the event itself.
// - traceId/spanId/requestId are observation identifiers from tracing or HTTP
//   layers. They are never lifecycle identity and must not be used as lifecycle
//   event id, correlation id, idempotency key, or projection dedupe key.

export const AGENT_LIFECYCLE_EVENT_TRACE_NAME = "agent.lifecycle.event";
export const AGENT_LIFECYCLE_PROJECTION_TRACE_NAME = "agent.lifecycle.projection";

export const lifecycleProjectionKinds = [
  "db_status",
  "wake_eligibility",
  "live_activity",
  "activity_log",
] as const;

export type AgentLifecycleActor = "human" | "agent" | "daemon" | "server" | "system" | "external";
export type AgentLifecycleSource =
  | "api"
  | "daemon"
  | "external_cli"
  | "ready_reconcile"
  | "runtime"
  | "scheduler"
  | "server"
  | "web";

export type AgentLifecycleEventType =
  | "activity_changed"
  | "daemon_shutdown"
  | "daemon_upgrade_started"
  | "external_agent_signal"
  | "machine_disconnected"
  | "manual_start_requested"
  | "manual_stop_requested"
  | "migration_aborted"
  | "migration_completed"
  | "migration_started"
  | "ready_reconciled"
  | "runtime_crashed"
  | "runtime_interrupted"
  | "runtime_profile_control_changed"
  | "runtime_ready"
  | "runtime_spawned";

export type AgentLifecycleReason =
  | "daemon_ready"
  | "daemon_restart"
  | "daemon_upgrade"
  | "external_activity"
  | "external_login"
  | "external_logout"
  | "computer_machine_unlinked"
  | "heartbeat_timeout"
  | "lazy_wake"
  | "machine_disconnect"
  | "manual_start"
  | "manual_stop"
  | "migration_abort"
  | "migration_arrived"
  | "migration_pending"
  | "migration_prepare"
  | "missing_running_agent"
  | "runtime_crash"
  | "runtime_exit"
  | "runtime_idle"
  | "runtime_starting"
  | "runtime_working"
  | "token_refresh";

export type AgentLifecycleProjectionKind = typeof lifecycleProjectionKinds[number];
export type AgentLifecycleProjectionOutcome = "applied" | "deduped" | "dropped" | "error" | "skipped";

export type LowCardinalityTraceValue = boolean | number | string | null | undefined;
export type AgentLifecycleTraceAttrs = Record<string, LowCardinalityTraceValue>;

export interface AgentLifecycleEvent {
  readonly lifecycleEventId: string;
  readonly serverId: string;
  readonly agentId: string;
  readonly machineId?: string;
  readonly launchId?: string;
  readonly eventType: AgentLifecycleEventType;
  readonly actor: AgentLifecycleActor;
  readonly source: AgentLifecycleSource;
  readonly reason: AgentLifecycleReason;
  readonly correlationId: string;
  readonly idempotencyKey: string;
  readonly producerFactId: string;
  readonly occurredAt: string;
  readonly attrs?: AgentLifecycleTraceAttrs;
}

export interface CreateAgentLifecycleEventInput {
  readonly serverId: string;
  readonly agentId: string;
  readonly machineId?: string;
  readonly launchId?: string;
  readonly eventType: AgentLifecycleEventType;
  readonly actor: AgentLifecycleActor;
  readonly source: AgentLifecycleSource;
  readonly reason: AgentLifecycleReason;
  readonly correlationId?: string;
  readonly idempotencyKey?: string;
  readonly occurredAt?: Date | string;
  readonly attrs?: AgentLifecycleTraceAttrs;
}

export interface AgentLifecycleEventFactoryOptions {
  readonly createId?: (kind: "correlation" | "event") => string;
  readonly now?: () => Date;
}

export interface AgentLifecycleProjectionTraceRow {
  readonly lifecycleEventId: string;
  readonly correlationId: string;
  readonly idempotencyKey: string;
  readonly producerFactId: string;
  readonly dedupeKey?: string;
  readonly serverId: string;
  readonly agentId: string;
  readonly machineId?: string;
  readonly launchId?: string;
  readonly eventType: AgentLifecycleEventType;
  readonly actor: AgentLifecycleActor;
  readonly reason: AgentLifecycleReason;
  readonly source: AgentLifecycleSource;
  readonly projectionKind: AgentLifecycleProjectionKind;
  readonly outcome: AgentLifecycleProjectionOutcome;
  readonly occurredAt: string;
  readonly skippedReason?: string;
  readonly attrs?: AgentLifecycleTraceAttrs;
}

export interface CreateAgentLifecycleProjectionInput {
  readonly projectionKind: AgentLifecycleProjectionKind;
  readonly outcome: AgentLifecycleProjectionOutcome;
  readonly dedupeKey?: string;
  readonly occurredAt?: Date | string;
  readonly skippedReason?: string;
  readonly attrs?: AgentLifecycleTraceAttrs;
}

const DISALLOWED_ATTR_KEY_PATTERNS = [
  /(^|_)(body|content|details?|message|prompt|raw|stack|stderr|stdout|text)(_|$)/i,
  /(^|_)(authorization|cookie|secret|token)(_|$)/i,
];
const RESERVED_TRACE_ATTR_KEYS = new Set([
  "actor",
  "agent_id",
  "correlation_id",
  "dedupe_key",
  "event_type",
  "idempotency_key",
  "lifecycle_event_id",
  "launch_id",
  "machine_id",
  "occurred_at",
  "outcome",
  "producer_fact_id",
  "projection_kind",
  "projection_skipped_reason",
  "reason",
  "server_id",
  "source",
]);

export function createAgentLifecycleEvent(
  input: CreateAgentLifecycleEventInput,
  options: AgentLifecycleEventFactoryOptions = {},
): AgentLifecycleEvent {
  const createId = options.createId ?? ((kind: "correlation" | "event") => `lifecycle_${kind}_${randomUUID()}`);
  const occurredAt = normalizeTimestamp(input.occurredAt ?? options.now?.() ?? new Date());
  const correlationId = input.correlationId ?? createId("correlation");
  const eventWithoutIdempotency = {
    ...input,
    correlationId,
    occurredAt,
  };
  const idempotencyKey = input.idempotencyKey ?? buildAgentLifecycleIdempotencyKey(eventWithoutIdempotency);

  return {
    lifecycleEventId: createId("event"),
    serverId: input.serverId,
    agentId: input.agentId,
    ...(input.machineId ? { machineId: input.machineId } : {}),
    ...(input.launchId ? { launchId: input.launchId } : {}),
    eventType: input.eventType,
    actor: input.actor,
    source: input.source,
    reason: input.reason,
    correlationId,
    idempotencyKey,
    producerFactId: buildAgentLifecycleProducerFactId(idempotencyKey),
    occurredAt,
    ...(input.attrs ? { attrs: sanitizeLifecycleTraceAttrs(input.attrs) } : {}),
  };
}

export function buildAgentLifecycleIdempotencyKey(input: {
  readonly serverId: string;
  readonly agentId: string;
  readonly machineId?: string;
  readonly launchId?: string;
  readonly eventType: AgentLifecycleEventType;
  readonly reason: AgentLifecycleReason;
  readonly correlationId: string;
}): string {
  // Event ingest idempotency is separate from durable projection dedupe.
  // Projection dedupe keys must be supplied by the semantic operation/window
  // that owns the write, e.g. stop command id or daemon restartWindowId.
  return [
    "agent_lifecycle",
    input.serverId,
    input.agentId,
    input.eventType,
    input.reason,
    input.machineId ?? "no_machine",
    input.launchId ?? "no_launch",
    input.correlationId,
  ].join(":");
}

export function buildAgentLifecycleProducerFactId(idempotencyKey: string): string {
  // Producer facts are the lineage bridge from a canonical lifecycle event to
  // every projection it causes. Use idempotency, not trace IDs, so retries join.
  // Daemon process generations belong only to activity sequence dedupe and
  // must never enter this content-derived lifecycle identity; otherwise the
  // same canonical lifecycle event could double-ingest after a daemon restart.
  return `agent_lifecycle_fact:${idempotencyKey}`;
}

export function createAgentLifecycleProjectionTraceRows(
  event: AgentLifecycleEvent,
  projections: readonly CreateAgentLifecycleProjectionInput[],
): AgentLifecycleProjectionTraceRow[] {
  return projections.map((projection) => createAgentLifecycleProjectionTraceRow(event, projection));
}

export function createAgentLifecycleProjectionTraceRow(
  event: AgentLifecycleEvent,
  projection: CreateAgentLifecycleProjectionInput,
): AgentLifecycleProjectionTraceRow {
  return {
    lifecycleEventId: event.lifecycleEventId,
    correlationId: event.correlationId,
    idempotencyKey: event.idempotencyKey,
    producerFactId: event.producerFactId,
    ...(projection.dedupeKey ? { dedupeKey: projection.dedupeKey } : {}),
    serverId: event.serverId,
    agentId: event.agentId,
    ...(event.machineId ? { machineId: event.machineId } : {}),
    ...(event.launchId ? { launchId: event.launchId } : {}),
    eventType: event.eventType,
    actor: event.actor,
    reason: event.reason,
    source: event.source,
    projectionKind: projection.projectionKind,
    outcome: projection.outcome,
    occurredAt: normalizeTimestamp(projection.occurredAt ?? event.occurredAt),
    ...(projection.skippedReason ? { skippedReason: projection.skippedReason } : {}),
    ...(projection.attrs ? { attrs: sanitizeLifecycleTraceAttrs(projection.attrs) } : {}),
  };
}

export function toAgentLifecycleEventTraceAttrs(event: AgentLifecycleEvent): TraceAttributes {
  return {
    ...sanitizeLifecycleTraceAttrs(event.attrs),
    lifecycle_event_id: event.lifecycleEventId,
    correlation_id: event.correlationId,
    idempotency_key: event.idempotencyKey,
    producer_fact_id: event.producerFactId,
    event_type: event.eventType,
    actor: event.actor,
    source: event.source,
    reason: event.reason,
    occurred_at: event.occurredAt,
    // These IDs are join keys, not aggregate dimensions.
    server_id: event.serverId,
    agent_id: event.agentId,
    ...(event.machineId ? { machine_id: event.machineId } : {}),
    ...(event.launchId ? { launch_id: event.launchId } : {}),
  };
}

export function toAgentLifecycleProjectionTraceAttrs(row: AgentLifecycleProjectionTraceRow): TraceAttributes {
  return {
    ...sanitizeLifecycleTraceAttrs(row.attrs),
    lifecycle_event_id: row.lifecycleEventId,
    correlation_id: row.correlationId,
    idempotency_key: row.idempotencyKey,
    producer_fact_id: row.producerFactId,
    ...(row.dedupeKey ? { dedupe_key: row.dedupeKey } : {}),
    event_type: row.eventType,
    actor: row.actor,
    source: row.source,
    reason: row.reason,
    projection_kind: row.projectionKind,
    outcome: row.outcome,
    occurred_at: row.occurredAt,
    ...(row.skippedReason ? { projection_skipped_reason: row.skippedReason } : {}),
    // These IDs are join keys, not aggregate dimensions.
    server_id: row.serverId,
    agent_id: row.agentId,
    ...(row.machineId ? { machine_id: row.machineId } : {}),
    ...(row.launchId ? { launch_id: row.launchId } : {}),
  };
}

export function emitAgentLifecycleEventTrace(event: AgentLifecycleEvent): void {
  addTraceEvent(AGENT_LIFECYCLE_EVENT_TRACE_NAME, toAgentLifecycleEventTraceAttrs(event));
}

export function emitAgentLifecycleProjectionTrace(row: AgentLifecycleProjectionTraceRow): void {
  addTraceEvent(AGENT_LIFECYCLE_PROJECTION_TRACE_NAME, toAgentLifecycleProjectionTraceAttrs(row));
}

export function emitAgentLifecycleProjectionTraces(rows: readonly AgentLifecycleProjectionTraceRow[]): void {
  for (const row of rows) {
    emitAgentLifecycleProjectionTrace(row);
  }
}

export function sanitizeLifecycleTraceAttrs(attrs: AgentLifecycleTraceAttrs | undefined): AgentLifecycleTraceAttrs {
  if (!attrs) return {};
  const sanitized: AgentLifecycleTraceAttrs = {};
  for (const [key, value] of Object.entries(attrs)) {
    if (value === undefined || shouldDropTraceAttrKey(key)) continue;
    if (value === null || typeof value === "boolean" || typeof value === "number") {
      sanitized[key] = value;
    } else if (typeof value === "string") {
      sanitized[key] = value.length > 128 ? `${value.slice(0, 125)}...` : value;
    }
  }
  return sanitized;
}

function shouldDropTraceAttrKey(key: string): boolean {
  return RESERVED_TRACE_ATTR_KEYS.has(key) || DISALLOWED_ATTR_KEY_PATTERNS.some((pattern) => pattern.test(key));
}

function normalizeTimestamp(value: Date | string): string {
  return value instanceof Date ? value.toISOString() : new Date(value).toISOString();
}
