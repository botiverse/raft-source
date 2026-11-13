/**
 * RFC 071 part 3 — the server half of the daemon's runtime
 * outcome outbox: commit, then acknowledge.
 *
 * The daemon (packages/daemon/src/runtimeOutcomeOutbox.ts) keeps every
 * evidence frame until the server acknowledges it with `agent:outcome:ack`
 * naming its `(daemonInstanceId, clientSeq)`, and resends it otherwise. Two
 * rules here:
 *  - the state change a frame makes and the per-(agent, daemon instance)
 *    watermark that marks it done are ONE compare-and-set (the watermark is a
 *    field of the terminal-failure breaker record); a replay at or below the
 *    watermark is acknowledged again and never applied again;
 *  - the ack is sent only after that write succeeded. A failed write sends
 *    nothing, so the daemon resends and the frame is judged again.
 *
 * Every frame class is handled (part 3, second slice): applied, or committed
 * as lost evidence (`needs_manual` until a human start) when its effect
 * cannot be known. Only a frame with no identity to acknowledge is held. A
 * frame is never acknowledged without its commit.
 *
 * Dormant: the server advertises `agent:runtime-outcome-ack-v1` (the only
 * thing that makes a daemon send outbox frames) only when
 * `RUNTIME_OUTCOME_ACK_ENABLED` is true, and it is false.
 */
import {
  AGENT_START_NOT_SPAWNED_REASONS,
  type AgentStartNotSpawnedReason,
  SERVER_CAPABILITY_RUNTIME_OUTCOME_ACK_V1,
  SERVER_CAPABILITY_START_SPAWN_ERROR_V1,
  type MachineToServerMessage,
  type ServerToMachineMessage,
  SERVER_CAPABILITY_RUNTIME_DETECTION_ASYNC_V1,
  SERVER_CAPABILITY_RUNTIME_AUTH_V1,
  SERVER_CAPABILITY_RUNTIME_AUTH_V2,
  SERVER_CAPABILITY_RUNTIME_CREDENTIALS_CHANGED_V1,
  SERVER_CAPABILITY_RUNTIME_READINESS_V1,
  SERVER_CAPABILITY_AGENT_SEND_INTENT_V1,
  SERVER_CAPABILITY_TURN_ENDED_V1,
  SERVER_CAPABILITY_TASK_WRITE_LANDING_V1,
  SERVER_CAPABILITY_SERVER_FEATURES_V1,
  SERVER_CAPABILITY_STICKY_FAILURE_REASONS_V1,
  SERVER_CAPABILITY_IDLE_TASK_REMINDER_V1,
  SERVER_CAPABILITY_MIGRATION_BACKUP_IGNORE_SOURCES_V1,
  SERVER_CAPABILITY_MIGRATION_USER_IGNORE_RECEIPT_V1,
  SERVER_CAPABILITY_MIGRATION_SOURCE_DRAIN_PROGRESS_V1,
  SERVER_CAPABILITY_RUNTIME_ACCOUNT_USAGE_LIMIT_RESETS_V1,
  SERVER_CAPABILITY_RUNTIME_ACCOUNT_USAGE_WINDOW_SCOPE_V1,
  SERVER_CAPABILITY_RUNTIME_ACCOUNT_USAGE_WINDOW_SCOPE_V2,
} from "@botiverse/raft-shared";
import type { TerminalOutboxFrame, TerminalOutboxFrameInput } from "./terminalFailureBreaker";

/**
 * The single switch. While false the server neither advertises
 * `agent:runtime-outcome-ack-v1` in `machine:context` nor handles outbox
 * frames, so no daemon engages the outbox against it.
 */
export const RUNTIME_OUTCOME_ACK_ENABLED = false;

/**
 * Capabilities the server puts on `machine:context`. Empty while the switch is off.
 *
 * task #365: `agent:start-spawn-error-v1` only ever WITH the ack capability.
 * It tells the daemon to stop reporting a proven never-created spawn as a
 * crash and to send it as an outbox `not_spawned: spawn_error` instead; the
 * outbox flows only to a server that acks. Advertised alone, the daemon would
 * drop the crash report (the live #1119 protection) into a paused outbox and
 * no backoff would apply anywhere.
 */
export function serverMachineContextCapabilities(enabled: boolean = RUNTIME_OUTCOME_ACK_ENABLED): string[] {
  // task #1268: ready-before-detection is always offered; the daemon decides
  // per connection (header pre-read, machine:context authoritative).
  // Agent typing line: `agent:send_intent` is always accepted and shown.
  // `agent:turn:ended` is always read (a completed first turn settles unread
  // the agent owes nothing in, unowedReadBacklog.ts). `server:features:request`
  // is always answered (shared featuresChanged.ts). Task writes are always
  // checked by landing (agentWriteLanding.ts). Runtime auth reports are read
  // for every runtime, an unknown one ignored (shared runtimeAuth.ts). The
  // idle task reminder route is always there; its per-server flag decides
  // whether it reminds (services/idleTaskReminderService.ts). Migration
  // control manifests may carry `excludedIgnoredBySource` (shared agentMigration.ts).
  // The start-failure reasons of reconciler step 12 are always counted
  // (wakeCrashLoopBreaker.ts). Usage snapshots may carry an account's
  // `limitResetsAvailable` and each window's `scope`, a `models` one
  // included (V2; shared runtimeAccountUsage.ts). A Computer's
  // `machine:runtime_credentials:changed` is always read (agentOrchestrator.ts).
  return enabled
    ? [SERVER_CAPABILITY_RUNTIME_OUTCOME_ACK_V1, SERVER_CAPABILITY_START_SPAWN_ERROR_V1, SERVER_CAPABILITY_RUNTIME_DETECTION_ASYNC_V1, SERVER_CAPABILITY_AGENT_SEND_INTENT_V1, SERVER_CAPABILITY_RUNTIME_AUTH_V1, SERVER_CAPABILITY_RUNTIME_AUTH_V2, SERVER_CAPABILITY_TURN_ENDED_V1, SERVER_CAPABILITY_SERVER_FEATURES_V1, SERVER_CAPABILITY_TASK_WRITE_LANDING_V1, SERVER_CAPABILITY_IDLE_TASK_REMINDER_V1, SERVER_CAPABILITY_MIGRATION_BACKUP_IGNORE_SOURCES_V1, SERVER_CAPABILITY_MIGRATION_USER_IGNORE_RECEIPT_V1, SERVER_CAPABILITY_MIGRATION_SOURCE_DRAIN_PROGRESS_V1, SERVER_CAPABILITY_STICKY_FAILURE_REASONS_V1, SERVER_CAPABILITY_RUNTIME_ACCOUNT_USAGE_LIMIT_RESETS_V1, SERVER_CAPABILITY_RUNTIME_ACCOUNT_USAGE_WINDOW_SCOPE_V1, SERVER_CAPABILITY_RUNTIME_ACCOUNT_USAGE_WINDOW_SCOPE_V2, SERVER_CAPABILITY_RUNTIME_CREDENTIALS_CHANGED_V1, SERVER_CAPABILITY_RUNTIME_READINESS_V1]
    : [SERVER_CAPABILITY_RUNTIME_DETECTION_ASYNC_V1, SERVER_CAPABILITY_AGENT_SEND_INTENT_V1, SERVER_CAPABILITY_RUNTIME_AUTH_V1, SERVER_CAPABILITY_RUNTIME_AUTH_V2, SERVER_CAPABILITY_TURN_ENDED_V1, SERVER_CAPABILITY_SERVER_FEATURES_V1, SERVER_CAPABILITY_TASK_WRITE_LANDING_V1, SERVER_CAPABILITY_IDLE_TASK_REMINDER_V1, SERVER_CAPABILITY_MIGRATION_BACKUP_IGNORE_SOURCES_V1, SERVER_CAPABILITY_MIGRATION_USER_IGNORE_RECEIPT_V1, SERVER_CAPABILITY_MIGRATION_SOURCE_DRAIN_PROGRESS_V1, SERVER_CAPABILITY_STICKY_FAILURE_REASONS_V1, SERVER_CAPABILITY_RUNTIME_ACCOUNT_USAGE_LIMIT_RESETS_V1, SERVER_CAPABILITY_RUNTIME_ACCOUNT_USAGE_WINDOW_SCOPE_V1, SERVER_CAPABILITY_RUNTIME_ACCOUNT_USAGE_WINDOW_SCOPE_V2, SERVER_CAPABILITY_RUNTIME_CREDENTIALS_CHANGED_V1, SERVER_CAPABILITY_RUNTIME_READINESS_V1];
}

function notSpawnedReason(value: unknown): AgentStartNotSpawnedReason | null {
  return (AGENT_START_NOT_SPAWNED_REASONS as readonly unknown[]).includes(value) ? value as AgentStartNotSpawnedReason : null;
}

/**
 * Every outbox entry type: the four evidence frames and the two markers. The
 * daemon sends at most one in flight per agent (stop-and-wait, resend backoff
 * from 5 s), so the sender bounds their volume. They are never in the
 * orchestrator's ingress rate-limited list: a rate-limit drop would either
 * stall the agent's queue until a resend or, if acknowledged, lose the
 * evidence. (`agent:runtime:outcome_unreliable` is a best-effort notice, not
 * an outbox entry, and is rate limited.)
 */
export const RUNTIME_OUTCOME_OUTBOX_MESSAGE_TYPES: ReadonlySet<MachineToServerMessage["type"]> = new Set<MachineToServerMessage["type"]>([
  "agent:runtime:outcome",
  "agent:process_spawned",
  "agent:process_exited",
  "agent:start:outcome",
  "agent:runtime:outcome_gap",
  "agent:runtime:outcome_cross_instance_unknown",
]);

export type RuntimeOutcomeOutboxMessage = Extract<MachineToServerMessage, {
  type:
    | "agent:runtime:outcome"
    | "agent:process_spawned"
    | "agent:process_exited"
    | "agent:start:outcome"
    | "agent:runtime:outcome_gap"
    | "agent:runtime:outcome_cross_instance_unknown";
}>;

export function isRuntimeOutcomeOutboxMessage(msg: MachineToServerMessage): msg is RuntimeOutcomeOutboxMessage {
  return RUNTIME_OUTCOME_OUTBOX_MESSAGE_TYPES.has(msg.type);
}

/**
 * Why a frame is held (not applied, not acknowledged; the daemon keeps it and
 * resends). Only a frame without a usable identity: an ack must name
 * `(daemonInstanceId, clientSeq)` or a `gapId`, so nothing else is possible.
 */
export type RuntimeOutcomeHoldReason = "malformed_identity";

/** A daemon outbox marker (gap or cross-instance), normalised. */
export interface RuntimeOutcomeMarkerFrame {
  gapId: string;
  takeoverEpoch: number;
  critical: boolean;
}

export type RuntimeOutcomeOutboxPlan =
  | { kind: "apply"; frame: TerminalOutboxFrame; ack: Extract<ServerToMachineMessage, { type: "agent:outcome:ack" }> }
  | { kind: "marker"; marker: RuntimeOutcomeMarkerFrame; ack: Extract<ServerToMachineMessage, { type: "agent:outcome:ack" }> }
  | { kind: "hold"; reason: RuntimeOutcomeHoldReason };

function isSeq(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
}

function isId(value: unknown): value is string {
  return typeof value === "string" && value.length > 0;
}

function isIdList(value: unknown): value is string[] {
  return Array.isArray(value) && value.every(isId);
}

function isCount(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
}

/**
 * A gap folds frames of one daemon instance; it is critical unless every
 * folded frame was a `turn_completed` (a lost E2 only delays a recovery).
 * Counts that cannot be read count as critical.
 */
function gapIsCritical(counts: unknown): boolean {
  if (!counts || typeof counts !== "object") return true;
  const c = counts as Record<string, unknown>;
  const critical = [c.e1, c.spawned, c.exited, c.startOutcome];
  if (!critical.every(isCount) || !isCount(c.turnCompleted)) return true;
  return (critical as number[]).some((n) => n > 0);
}

/**
 * Decide what one outbox message is, without touching state.
 *
 * RFC 071 part 3 (second slice): every frame class is handled; none is held
 * once it has an identity to acknowledge.
 *  - Frames are judged by their own `(daemonInstanceId, clientSeq)`,
 *    whichever daemon instance the connection runs now (old-instance
 *    replay after a daemon restart).
 *  - Markers: committed (lost evidence → needs manual, unless backlog-only or
 *    older than the last human takeover) and acked by `gapId`.
 *  - A frame the server cannot read (unknown `v`, an unknown outcome kind, a
 *    missing field) but whose identity is valid is committed as lost
 *    evidence, never acked bare: holding it would stall the agent's
 *    stop-and-wait queue behind it for good.
 */
export function planRuntimeOutcomeOutboxMessage(msg: RuntimeOutcomeOutboxMessage): RuntimeOutcomeOutboxPlan {
  if (msg.type === "agent:runtime:outcome_gap" || msg.type === "agent:runtime:outcome_cross_instance_unknown") {
    if (!isId(msg.agentId) || !isId(msg.gapId)) return { kind: "hold", reason: "malformed_identity" };
    const ack = { type: "agent:outcome:ack" as const, agentId: msg.agentId, gapId: msg.gapId };
    // An unreadable epoch is treated as current (0 never pre-dates a takeover).
    const takeoverEpoch = isCount(msg.takeoverEpoch) ? msg.takeoverEpoch : Number.MAX_SAFE_INTEGER;
    // The daemon refuses automatic starts on every cross-instance marker; so does the server.
    const critical = msg.type === "agent:runtime:outcome_cross_instance_unknown" || gapIsCritical(msg.counts);
    return { kind: "marker", ack, marker: { gapId: msg.gapId, takeoverEpoch, critical } };
  }
  if (!isId(msg.agentId) || !isId(msg.daemonInstanceId) || !isSeq(msg.clientSeq)) return { kind: "hold", reason: "malformed_identity" };
  const ack = { type: "agent:outcome:ack" as const, agentId: msg.agentId, daemonInstanceId: msg.daemonInstanceId, clientSeq: msg.clientSeq };
  const base = { daemonInstanceId: msg.daemonInstanceId, clientSeq: msg.clientSeq };
  const lost = (reason: string): RuntimeOutcomeOutboxPlan => ({ kind: "apply", ack, frame: { kind: "evidence_lost", ...base, reason } });

  switch (msg.type) {
    case "agent:runtime:outcome": {
      if (msg.v !== 1) return lost("unknown_version");
      if (!isId(msg.launchId) || !msg.outcome) return lost("malformed_outcome");
      const sessionId = typeof msg.sessionId === "string" ? msg.sessionId : null;
      if (msg.outcome.kind === "terminal_failure") {
        if (typeof msg.outcome.fingerprint !== "string" || typeof msg.outcome.failureKind !== "string") return lost("malformed_outcome");
        return {
          kind: "apply",
          ack,
          frame: { kind: "terminal_failure", frame: { ...base, launchId: msg.launchId, sessionId, failureKind: msg.outcome.failureKind, fingerprint: msg.outcome.fingerprint } },
        };
      }
      if (msg.outcome.kind === "turn_completed") {
        const batchId = msg.outcome.catchupBatchId;
        if (batchId !== undefined && !isId(batchId)) return lost("malformed_outcome");
        const renderedRows = isCount(msg.outcome.catchupRenderedRows) ? msg.outcome.catchupRenderedRows : null;
        return {
          kind: "apply",
          ack,
          frame: {
            kind: "turn_completed",
            frame: { ...base, launchId: msg.launchId, sessionId, catchupBatchId: batchId ?? null, catchupRenderedRows: batchId === undefined ? null : renderedRows },
          },
        };
      }
      return lost("unknown_outcome_kind");
    }
    case "agent:process_spawned": {
      if (!isId(msg.launchId) || !isId(msg.processInstanceId)) return lost("malformed_spawned");
      if (msg.supersededLaunchIds !== undefined && !isIdList(msg.supersededLaunchIds)) return lost("malformed_spawned");
      return {
        kind: "apply",
        ack,
        frame: {
          kind: "process_spawned",
          ...base,
          launchId: msg.launchId,
          processInstanceId: msg.processInstanceId,
          supersededLaunchIds: msg.supersededLaunchIds ?? [],
          respawn: msg.respawn === true,
        },
      };
    }
    case "agent:process_exited": {
      if (!isId(msg.processInstanceId) || !isId(msg.launchId)) return lost("malformed_exited");
      if (msg.spawnLaunchId !== null && !isId(msg.spawnLaunchId)) return lost("malformed_exited");
      return {
        kind: "apply",
        ack,
        frame: { kind: "process_exited", ...base, processInstanceId: msg.processInstanceId, spawnLaunchId: msg.spawnLaunchId, launchId: msg.launchId },
      };
    }
    case "agent:start:outcome": {
      if (!isId(msg.launchId) || !msg.result) return lost("malformed_start_outcome");
      if (msg.result.kind === "rebound") {
        if (!isId(msg.result.processInstanceId)) return lost("malformed_start_outcome");
        return { kind: "apply", ack, frame: { kind: "start_rebound", ...base, launchId: msg.launchId, processInstanceId: msg.result.processInstanceId } };
      }
      if (msg.result.kind === "not_spawned") {
        // task #365: the reason decides whether it counts (only `spawn_error`); one this server does not know counts nothing.
        return { kind: "apply", ack, frame: { kind: "start_not_spawned", ...base, launchId: msg.launchId, reason: notSpawnedReason(msg.result.reason) } };
      }
      return lost("malformed_start_outcome");
    }
  }
}

export interface RuntimeOutcomeOutboxDeps {
  /** One compare-and-set of state + watermark; rejects when nothing was written. */
  applyOutboxFrame(agentId: string, frame: TerminalOutboxFrame, input: TerminalOutboxFrameInput): Promise<{ duplicate: boolean; outcome: string }>;
  /** Commit a marker (no watermark: it is idempotent); rejects when the needed write did not happen. */
  applyOutcomeMarker(agentId: string, marker: RuntimeOutcomeMarkerFrame, input: { nowMs: number }): Promise<{ outcome: string }>;
  send(message: ServerToMachineMessage): Promise<boolean>;
}

export type RuntimeOutcomeOutboxResult =
  | { kind: "held"; reason: RuntimeOutcomeHoldReason }
  /** The write failed: no ack, the daemon resends. */
  | { kind: "commit_failed"; error: unknown }
  /** Committed (or a replay of a committed frame) and the ack was handed to the connection. */
  | { kind: "acked"; duplicate: boolean; outcome: string; sent: boolean };

/**
 * Commit, then acknowledge. The ack is built only from the frame's own
 * identity and is sent strictly after the commit resolved.
 */
export async function ingestRuntimeOutcomeOutboxMessage(
  deps: RuntimeOutcomeOutboxDeps,
  msg: RuntimeOutcomeOutboxMessage,
  input: TerminalOutboxFrameInput,
): Promise<RuntimeOutcomeOutboxResult> {
  const plan = planRuntimeOutcomeOutboxMessage(msg);
  if (plan.kind === "hold") return { kind: "held", reason: plan.reason };
  let committed: { duplicate: boolean; outcome: string };
  try {
    committed = plan.kind === "marker"
      ? { duplicate: false, ...(await deps.applyOutcomeMarker(msg.agentId, plan.marker, { nowMs: input.nowMs })) }
      : await deps.applyOutboxFrame(msg.agentId, plan.frame, {
        nowMs: input.nowMs,
        unreadCeilings: input.unreadCeilings,
        persistedSessionId: input.persistedSessionId,
      });
  } catch (error) {
    return { kind: "commit_failed", error };
  }
  const sent = await deps.send(plan.ack);
  return { kind: "acked", duplicate: committed.duplicate, outcome: committed.outcome, sent };
}
