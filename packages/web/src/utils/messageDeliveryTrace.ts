/**
 * Web client message-delivery telemetry (WS metrics PR 2; #raft-botiverse-deployment:ed82a70e).
 *
 * Two fire-and-forget `otel.logs` events via `emitWebEvent`, with closed string
 * sets and numeric counters/durations only (no messageId, channelId, userId or
 * serverId in attributes):
 *
 * - `slock.web.message_receive` (sampled at 5%): end-to-end client receive lag
 *   (`now - Date.parse(createdAt)`) on the first socket arrival of a live
 *   `message:new` or `thread:updated` frame. Paired with server-side
 *   `slock_message_push_lag_seconds` (slock #15216) to separate server lag from
 *   network + client lag; `clock_skew` marks negative raw deltas.
 * - `slock.web.sync_gap_recovered`: missed messages recovered after the fact by
 *   `GET /messages/sync` (`syncGap`, deduplicated by message id — raw global
 *   `seq` jumps are never counted) or Socket.IO `sync:resume:response`. Routine
 *   0-message checks are skipped.
 */
import { emitWebEvent } from "./webAuthTrace";

export const MESSAGE_RECEIVE_EVENT = "slock.web.message_receive" as const;
export const SYNC_GAP_RECOVERED_EVENT = "slock.web.sync_gap_recovered" as const;
export const MESSAGE_RECEIVE_SAMPLE_RATE = 0.05;

export type LiveReceiveSocketEvent = "message:new" | "thread:updated";
export type MessageSenderKind = "user" | "agent" | "system" | "external_projection" | "unknown";
export type PageVisibilityKind = "visible" | "hidden" | "unknown";
export type SyncGapSource = "messages_sync" | "sync_resume";
export type SyncGapOutcome = "read" | "failed";

const SENDER_KINDS: ReadonlySet<string> = new Set(["user", "agent", "system", "external_projection"]);

type Emitter = typeof emitWebEvent;

export interface MessageDeliveryTraceTestOverrides {
  emitter?: Emitter | null;
  sampleRate?: number | null;
  random?: (() => number) | null;
  now?: (() => number) | null;
  visibility?: (() => string | undefined) | null;
}

let emitter: Emitter = emitWebEvent;
let sampleRate: number = MESSAGE_RECEIVE_SAMPLE_RATE;
let randomFn: () => number = Math.random;
let nowFn: () => number = Date.now;
let visibilityFn: () => string | undefined = () =>
  typeof document === "undefined" ? undefined : document.visibilityState;

/** Test seam (deterministic clock, sampling, visibility and event capture). */
export function __setMessageDeliveryTraceForTest(overrides: MessageDeliveryTraceTestOverrides | null): void {
  emitter = overrides?.emitter ?? emitWebEvent;
  sampleRate = typeof overrides?.sampleRate === "number" ? overrides.sampleRate : MESSAGE_RECEIVE_SAMPLE_RATE;
  randomFn = overrides?.random ?? Math.random;
  nowFn = overrides?.now ?? Date.now;
  visibilityFn =
    overrides?.visibility ?? (() => (typeof document === "undefined" ? undefined : document.visibilityState));
}

function readVisibility(): PageVisibilityKind {
  try {
    const v = visibilityFn();
    if (v === "visible" || v === "hidden") return v;
  } catch {
    // Ignore DOM access errors.
  }
  return "unknown";
}

function normalizeSenderKind(raw: unknown): MessageSenderKind {
  return typeof raw === "string" && SENDER_KINDS.has(raw) ? (raw as MessageSenderKind) : "unknown";
}

/**
 * Record sampled client receive lag for a newly accepted socket frame.
 * Never throws; skips malformed/missing `createdAt` and unselected samples.
 */
export function reportLiveMessageReceive(
  msg: { createdAt?: unknown; senderType?: unknown } | null | undefined,
  event: LiveReceiveSocketEvent,
): void {
  try {
    if (!msg || typeof msg.createdAt !== "string") return;
    if (sampleRate <= 0 || (sampleRate < 1 && randomFn() >= sampleRate)) return;
    const createdMs = Date.parse(msg.createdAt);
    if (!Number.isFinite(createdMs)) return;
    const rawLagMs = nowFn() - createdMs;
    if (!Number.isFinite(rawLagMs)) return;
    emitter(MESSAGE_RECEIVE_EVENT, {
      event: event === "thread:updated" ? "thread:updated" : "message:new",
      lag_ms: Math.round(Math.max(0, rawLagMs)),
      clock_skew: rawLagMs < 0,
      sender_kind: normalizeSenderKind(msg.senderType),
      visibility: readVisibility(),
    });
  } catch {
    // Telemetry must never throw into socket message handling.
  }
}

/**
 * Record a `GET /messages/sync` (`syncGap`) result when it actually recovered
 * missing messages (`recoveredCount > 0`) or failed. Routine 0-message reads
 * caused by server-global `seq` jumps in other channels are skipped.
 */
export function reportMessagesSyncGap(
  recoveredCount: number,
  outcome: "read" | "failed" | "abandoned",
  hadPendingHole: boolean,
): void {
  try {
    const count = Number.isFinite(recoveredCount) ? Math.max(0, Math.trunc(recoveredCount)) : 0;
    if (outcome === "abandoned") return;
    if (outcome === "read" && count === 0) return;
    emitter(SYNC_GAP_RECOVERED_EVENT, {
      source: "messages_sync",
      recovered_count: count,
      outcome,
      had_pending_hole: Boolean(hadPendingHole),
      has_more: false,
      horizon_reset: false,
      visibility: readVisibility(),
    });
  } catch {
    // Telemetry must never throw into gap recovery.
  }
}

/**
 * Record a Socket.IO `sync:resume:response` catch-up when it brought back
 * missing messages, overflowed one page (`hasMore`), or hit a horizon reset.
 */
export function reportSyncResumeGap(
  recoveredCount: number,
  hasMore?: boolean,
  horizonReset?: boolean,
): void {
  try {
    const count = Number.isFinite(recoveredCount) ? Math.max(0, Math.trunc(recoveredCount)) : 0;
    const more = Boolean(hasMore);
    const reset = Boolean(horizonReset);
    if (count === 0 && !more && !reset) return;
    emitter(SYNC_GAP_RECOVERED_EVENT, {
      source: "sync_resume",
      recovered_count: count,
      outcome: "read",
      had_pending_hole: false,
      has_more: more,
      horizon_reset: reset,
      visibility: readVisibility(),
    });
  } catch {
    // Telemetry must never throw into reconnect resume handling.
  }
}
