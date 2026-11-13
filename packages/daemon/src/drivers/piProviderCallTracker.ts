import { randomUUID } from "node:crypto";
import { isBuiltInRuntimeProviderId } from "@botiverse/raft-shared";
import type { RuntimeProviderCallSnapshot } from "./types";

/**
 * Task #1310: passive facts about each Pi provider call, so a stalled turn can
 * say whether a model call was still open and how far it had got.
 *
 * One record is one `ModelRuntime.stream` / `streamSimple` call on a physical
 * model. A call may hold several network attempts inside the SDK (WebSocket
 * retries, SSE fallback, HTTP retries), so nothing here counts attempts or
 * names a transport. The tracker only observes: it never changes a payload, a
 * callback's return value or exception, or how the stream is consumed.
 */

/** The highest stage this call has been observed to reach; not where the current network attempt is. */
export type PiProviderCallPhase = "started" | "headers" | "streaming";
export type PiProviderCallOutcome = "completed" | "error" | "aborted" | "sync_throw" | "result_rejected" | "abandoned" | "unknown";
/** Time-window attribution only: whether the call started inside a compaction window. Not causal. */
export type PiProviderCallContext = "compaction" | "outside_compaction" | "unknown";
export type PiProviderCallErrorClass = "provider_http" | "unknown";

const KNOWN_APIS = new Set([
  "openai-completions",
  "mistral-conversations",
  "openai-responses",
  "azure-openai-responses",
  "openai-codex-responses",
  "anthropic-messages",
  "bedrock-converse-stream",
  "google-generative-ai",
  "google-vertex",
  "pi-messages",
]);
/** pi-coding-agent routes a virtual model by calling streamSimple again with the physical one. */
const VIRTUAL_MODEL_API = "pi-virtual";

export interface PiProviderCallEnded {
  call_context: PiProviderCallContext;
  api: string;
  provider: string;
  outcome: PiProviderCallOutcome;
  phase: PiProviderCallPhase;
  http_responses_seen: number;
  last_http_status?: number;
  error_class?: PiProviderCallErrorClass;
  duration_ms_bucket: string;
  ms_to_headers_bucket?: string;
  ms_to_first_event_bucket?: string;
}


interface CallRecord {
  readonly id: string;
  readonly api: string;
  readonly provider: string;
  readonly startedAt: number;
  context: PiProviderCallContext;
  phase: PiProviderCallPhase;
  httpResponses: number;
  lastHttpStatus?: number;
  headersAt?: number;
  firstEventAt?: number;
  lastEventAt?: number;
}

type ProviderCallModel = { api?: unknown; provider?: unknown };
type ProviderCallOptions = {
  onResponse?: (response: { status?: unknown }, model: never) => unknown;
  onProviderStreamEvent?: (data: unknown, model: never) => unknown;
};
type ProviderCallStream = { result(): Promise<unknown> };

export class PiProviderCallTracker {
  private readonly open = new Map<string, CallRecord>();
  private compactionOpen = false;

  constructor(
    private readonly emitEnded: (ended: PiProviderCallEnded) => void,
    private readonly now: () => number = Date.now,
  ) {}

  /**
   * Run one provider call with observation hooks chained in front of the
   * caller's own. The returned stream is the SDK's, untouched.
   */
  observe<O, S extends ProviderCallStream>(model: ProviderCallModel, options: O, invoke: (options: O) => S): S {
    if (model.api === VIRTUAL_MODEL_API) return invoke(options);
    const record = this.start(model);
    const caller = (options ?? {}) as ProviderCallOptions;
    const observed = {
      ...options,
      onResponse: tap(caller.onResponse, (response) => this.noteHeaders(record, response)),
      onProviderStreamEvent: tap(caller.onProviderStreamEvent, () => this.noteStreamEvent(record)),
    } as O;
    let stream: S;
    try {
      stream = invoke(observed);
    } catch (error) {
      this.end(record.id, "sync_throw");
      throw error;
    }
    let result: Promise<unknown>;
    try {
      result = Promise.resolve(stream.result());
    } catch {
      this.end(record.id, "result_rejected");
      return stream;
    }
    // A separate promise from the event iterator: reading it adds no consumer.
    result.then(
      (message) => this.end(record.id, outcomeOf(message)),
      () => this.end(record.id, "result_rejected"),
    ).catch(() => { /* An unavailable sink must not surface as an unhandled rejection. */ });
    return stream;
  }

  noteCompactionStarted(): void {
    this.compactionOpen = true;
    // A call already open cannot be placed on either side of the window.
    for (const record of this.open.values()) record.context = "unknown";
  }

  noteCompactionEnded(): void {
    this.compactionOpen = false;
  }

  /** The runtime instance stops observing: open calls end as `abandoned`. Says nothing about the network. */
  abandonAll(): void {
    for (const id of [...this.open.keys()]) this.end(id, "abandoned");
  }

  snapshot(): RuntimeProviderCallSnapshot {
    let oldest: CallRecord | undefined;
    for (const record of this.open.values()) {
      if (!oldest || record.startedAt < oldest.startedAt) oldest = record;
    }
    if (!oldest) return { openCount: 0 };
    const now = this.now();
    return {
      openCount: this.open.size,
      oldest: {
        phase: oldest.phase,
        callContext: oldest.context,
        ageMs: now - oldest.startedAt,
        ...(oldest.lastEventAt === undefined ? {} : { msSinceLastStreamEvent: now - oldest.lastEventAt }),
      },
    };
  }

  private start(model: ProviderCallModel): CallRecord {
    const context: PiProviderCallContext = this.open.size > 0
      ? "unknown"
      : this.compactionOpen ? "compaction" : "outside_compaction";
    // Concurrent calls make every open call's window ambiguous.
    if (this.open.size > 0) for (const other of this.open.values()) other.context = "unknown";
    const record: CallRecord = {
      id: randomUUID(),
      api: typeof model.api === "string" && KNOWN_APIS.has(model.api) ? model.api : "unknown",
      provider: typeof model.provider === "string" && isBuiltInRuntimeProviderId(model.provider) ? model.provider : "custom",
      startedAt: this.now(),
      context,
      phase: "started",
      httpResponses: 0,
    };
    this.open.set(record.id, record);
    return record;
  }

  private noteHeaders(record: CallRecord, response: { status?: unknown } | undefined): void {
    record.httpResponses += 1;
    const status = response?.status;
    if (typeof status === "number" && Number.isInteger(status) && status >= 100 && status <= 599) record.lastHttpStatus = status;
    record.headersAt ??= this.now();
    if (record.phase === "started") record.phase = "headers";
  }

  private noteStreamEvent(record: CallRecord): void {
    const now = this.now();
    record.firstEventAt ??= now;
    record.lastEventAt = now;
    record.phase = "streaming";
  }

  /** Exactly once per call id: a late result for an ended or abandoned call is ignored. */
  private end(id: string, outcome: PiProviderCallOutcome): void {
    const record = this.open.get(id);
    if (!record) return;
    this.open.delete(id);
    const errorClass: PiProviderCallErrorClass | undefined = outcome === "error"
      ? record.lastHttpStatus !== undefined && record.lastHttpStatus >= 400 ? "provider_http" : "unknown"
      : undefined;
    const ended: PiProviderCallEnded = {
      call_context: record.context,
      api: record.api,
      provider: record.provider,
      outcome,
      phase: record.phase,
      http_responses_seen: record.httpResponses,
      ...(record.lastHttpStatus === undefined ? {} : { last_http_status: record.lastHttpStatus }),
      ...(errorClass ? { error_class: errorClass } : {}),
      duration_ms_bucket: bucketMs(this.now() - record.startedAt),
      ...(record.headersAt === undefined ? {} : { ms_to_headers_bucket: bucketMs(record.headersAt - record.startedAt) }),
      ...(record.firstEventAt === undefined ? {} : { ms_to_first_event_bucket: bucketMs(record.firstEventAt - record.startedAt) }),
    };
    try {
      this.emitEnded(ended);
    } catch { /* An unavailable diagnostic sink must not alter a provider call. */ }
  }
}

/**
 * Observe, then hand the call to the caller's callback unchanged: its return
 * value, sync or async shape and exceptions are the original's. With no
 * original callback this returns undefined, which the SDK already awaits.
 */
function tap<A extends unknown[], R>(
  original: ((...args: A) => R) | undefined,
  observe: (...args: A) => void,
): (...args: A) => R | undefined {
  return (...args: A) => {
    try {
      observe(...args);
    } catch { /* Observation never affects the call. */ }
    return original?.(...args);
  };
}

/** The same buckets as the daemon's stall events, so a call and its stall read on one scale. */
function bucketMs(ms: number): string {
  if (ms < 1_000) return "<1s";
  if (ms < 10_000) return "1-10s";
  if (ms < 60_000) return "10-60s";
  if (ms < 300_000) return "1-5m";
  if (ms < 900_000) return "5-15m";
  if (ms < 3_600_000) return "15-60m";
  return ">60m";
}

function outcomeOf(message: unknown): PiProviderCallOutcome {
  const stopReason = (message as { stopReason?: unknown } | null | undefined)?.stopReason;
  if (stopReason === "aborted") return "aborted";
  if (stopReason === "error") return "error";
  if (stopReason === "stop" || stopReason === "length" || stopReason === "toolUse") return "completed";
  return "unknown";
}
