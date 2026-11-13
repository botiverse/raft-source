import { Client, type AppendStream, type AppendStreamBuilder } from "scopedb";
import {
  assertTraceEventRowV2TableSchema,
  classifyScopeDbAppendFailure,
  currentTimeMs,
  encodeTraceEventRowV2AppendRecord,
  TRACE_EVENT_ROW_V2_SCHEMA_RECHECK_MS,
  traceEventRowV2SchemaCheckSkipReason,
  type TraceEventRowV2SchemaCheckSkipReason,
  traceEventRowV2SchemaFieldsFromCatalog,
  type CompletedTraceSpan,
  traceEventRowForRecord,
  traceSpanFactRowForSpan,
  type TraceEventRow,
  type TraceEventRowResource,
  type TraceEventRecord,
  type TraceSink,
  type TraceSpanFactRecord,
} from "@botiverse/raft-shared";

import type { ScopeDbPersistenceTier } from "../services/scopeDbSdkPolicy";

export interface ScopeDbTraceEventSinkOptions extends TraceEventRowResource {
  endpoint: string;
  token: string;
  batchSize?: number;
  flushIntervalMs?: number;
  flushJitterMs?: number;
  maxQueueSize?: number;
  validateLiveSchema?: boolean;
  client?: Pick<Client, "table">;
  onError?: (err: Error) => void;
  /** Operational warnings that are not export failures (a skipped schema check). */
  warn?: (message: string) => void;
  observer?: ScopeDbTraceEventSinkObserver;
}

export const TRACE_EVENT_SCOPEDB_PERSISTENCE_TIER: ScopeDbPersistenceTier = "decision_support";

/**
 * `shutdown`: rows still queued (e.g. a re-queued throttled backlog) when
 * shutdown's drain stops at a failed batch.
 */
export type ScopeDbTraceEventSinkDropReason = "queue_full" | "export_error" | "encode_error" | "shutdown";

/**
 * Stream bounds, from the SDK's long-lived telemetry recipe: a flush (and so
 * shutdown) settles within ~30 s instead of the SDK default 5-minute batch
 * budget, which would hold the single-flight flush while the outer queue
 * sheds. Longer throttling is ridden out by the sink's own re-queue backoff.
 */
const STREAM_ATTEMPT_TIMEOUT_MS = 10_000;
const STREAM_MAX_ELAPSED_MS = 30_000;
const STREAM_MAX_RETRIES = 2;
/** Upper bound for the sink's re-queue backoff and for an honoured Retry-After. */
const MAX_REQUEUE_BACKOFF_MS = 60_000;
export type ScopeDbTraceEventSinkFlushOutcome = "success" | "error";

export interface ScopeDbTraceEventSinkObserver {
  setQueueSize(size: number): void;
  recordFlush(outcome: ScopeDbTraceEventSinkFlushOutcome, atMs: number): void;
  recordRowsExported(count: number): void;
  recordRowsDropped(reason: ScopeDbTraceEventSinkDropReason, count: number): void;
  /** The live schema check could not read the catalog and was skipped (once per skip window). */
  recordSchemaCheckSkipped?(reason: TraceEventRowV2SchemaCheckSkipReason, details: ScopeDbTraceEventSinkSchemaCheckSkip): void;
}

/** What a skipped live schema check saw: the catalog read's HTTP status (when it had one) and the skip window. */
export interface ScopeDbTraceEventSinkSchemaCheckSkip {
  httpStatus?: number;
  recheckMs: number;
}

export class ScopeDbTraceEventSink implements TraceSink {
  private readonly client: Pick<Client, "table">;
  private readonly resource: TraceEventRowResource;
  private readonly batchSize: number;
  private readonly flushIntervalMs: number;
  private readonly flushJitterMs: number;
  private readonly maxQueueSize: number;
  private readonly validateLiveSchema: boolean;
  private readonly onError: (err: Error) => void;
  private readonly warn: (message: string) => void;
  // Until then the live schema check is skipped (the catalog could not be read).
  private schemaCheckSkippedUntilMs = 0;
  // One warning per skip reason for this sink (one sink per process).
  private readonly warnedSchemaCheckSkips = new Set<TraceEventRowV2SchemaCheckSkipReason>();
  private readonly observer?: ScopeDbTraceEventSinkObserver;
  private readonly queue: TraceEventRow[] = [];
  private stream: AppendStream | null = null;
  private flushTimer: ReturnType<typeof setTimeout> | null = null;
  private flushing = false;
  private flushPromise: Promise<void> | null = null;
  private schemaValidationPromise: Promise<void> | null = null;
  private droppedCount = 0;
  // Consecutive throttled/unavailable flushes (one backoff episode).
  private throttledAttempts = 0;
  // While Date.now() is before this, the head of the queue is a re-queued
  // batch: nothing flushes early (no batch-size fast path, no shorter timer);
  // only the backoff timer does.
  private backoffUntilMs = 0;
  private closing = false;
  private lastFlushFailed = false;

  constructor(options: ScopeDbTraceEventSinkOptions) {
    // Persistence tier: decision_support. The outer fail-aside queue may shed
    // rows and process crashes may lose memory, so this Append stream improves
    // retry lifecycle but never upgrades observations to authoritative
    // durability.
    this.client = options.client ?? new Client(options.endpoint, { apiKey: options.token });
    this.resource = {
      serviceName: options.serviceName,
      deploymentEnvironment: options.deploymentEnvironment,
      serviceVersion: options.serviceVersion,
      serviceRevision: options.serviceRevision,
      serviceInstanceId: options.serviceInstanceId,
      deploymentInstanceSource: options.deploymentInstanceSource,
      deploymentIdentityState: options.deploymentIdentityState,
      ecsTaskId: options.ecsTaskId,
      ecsTaskFamily: options.ecsTaskFamily,
      ecsTaskRevision: options.ecsTaskRevision,
    };
    this.batchSize = Math.max(1, options.batchSize ?? 128);
    this.flushIntervalMs = Math.max(1, options.flushIntervalMs ?? 1000);
    this.flushJitterMs = Math.max(0, options.flushJitterMs ?? 0);
    this.maxQueueSize = Math.max(this.batchSize, options.maxQueueSize ?? 8192);
    this.validateLiveSchema = options.validateLiveSchema ?? true;
    this.onError = options.onError ?? ((err) => console.warn("[TraceEventRows] ScopeDB export failed:", err.message));
    this.warn = options.warn ?? ((message) => console.warn(message));
    this.observer = options.observer;
    this.observer?.setQueueSize(0);
  }

  record(_span: CompletedTraceSpan): void {
    // Completed spans are represented in ScopeDB only through recordSpanFact().
    // The normal record() path stays a no-op so OTLP remains the canonical span
    // transport and event rows are not duplicated.
  }

  recordEvent(record: TraceEventRecord): void {
    this.enqueue(traceEventRowForRecord(record, this.resource));
    this.afterEnqueue();
  }

  recordSpanFact(record: TraceSpanFactRecord): void {
    this.enqueue(traceSpanFactRowForSpan(record.span, this.resource));
    this.afterEnqueue();
  }

  private afterEnqueue(): void {
    if (this.closing) return;
    if (this.queue.length >= this.batchSize && !this.inBackoff()) {
      void this.flush();
      return;
    }
    this.scheduleFlush();
  }

  private inBackoff(): boolean {
    return Date.now() < this.backoffUntilMs;
  }

  private enqueue(row: TraceEventRow): void {
    if (this.queue.length >= this.maxQueueSize) {
      this.queue.shift();
      this.droppedCount += 1;
      this.observer?.recordRowsDropped("queue_full", 1);
    }
    this.queue.push(row);
    this.observer?.setQueueSize(this.queue.length);
  }

  /** Puts a refused batch back at the head; overflow sheds the oldest rows as queue_full. */
  private requeue(rows: readonly TraceEventRow[]): void {
    this.queue.unshift(...rows);
    const overflow = this.queue.length - this.maxQueueSize;
    if (overflow > 0) {
      this.queue.splice(0, overflow);
      this.droppedCount += overflow;
      this.observer?.recordRowsDropped("queue_full", overflow);
    }
    this.observer?.setQueueSize(this.queue.length);
  }

  getDroppedCount(): number {
    return this.droppedCount;
  }

  async shutdown(): Promise<void> {
    // No re-queue and no new timers from here on. Drain the queue batch by
    // batch (ignoring any backoff: this is the last chance); the first failed
    // batch is counted export_error and ends the drain, and every row still
    // queued is counted as a shutdown drop rather than left in memory at exit.
    this.closing = true;
    if (this.flushTimer) {
      clearTimeout(this.flushTimer);
      this.flushTimer = null;
    }
    if (this.flushPromise) await this.flushPromise;
    while (this.queue.length > 0) {
      await this.flush();
      if (this.lastFlushFailed) break;
    }
    const remaining = this.queue.splice(0);
    if (remaining.length > 0) {
      this.droppedCount += remaining.length;
      this.observer?.recordRowsDropped("shutdown", remaining.length);
      this.observer?.setQueueSize(0);
    }
    await this.shutdownStream();
  }

  async flush(): Promise<void> {
    if (this.flushing) {
      if (this.flushPromise) await this.flushPromise;
      return;
    }
    if (this.flushTimer) {
      clearTimeout(this.flushTimer);
      this.flushTimer = null;
    }
    if (this.queue.length === 0) return;

    this.flushing = true;
    this.flushPromise = this.flushOnce();
    await this.flushPromise;
  }

  private async flushOnce(): Promise<void> {
    const batch = this.queue.splice(0, this.batchSize);
    this.observer?.setQueueSize(this.queue.length);
    // Append takes no ScopeQL cast: encode each row for the projection's
    // column types. A row that cannot be encoded (a code bug: rows come from
    // typed producers) is dropped on its own as encode_error instead of
    // making ScopeDB reject, and the sink drop, the whole batch.
    const rows: TraceEventRow[] = [];
    const records: Array<Record<string, unknown>> = [];
    let encodeError: unknown;
    for (const row of batch) {
      try {
        records.push(encodeTraceEventRowV2AppendRecord(row));
        rows.push(row);
      } catch (err) {
        encodeError ??= err;
      }
    }
    if (rows.length < batch.length) {
      this.droppedCount += batch.length - rows.length;
      this.observer?.recordRowsDropped("encode_error", batch.length - rows.length);
      this.onError(encodeError instanceof Error ? encodeError : new Error(String(encodeError)));
    }
    let backoffMs: number | null = null;
    this.lastFlushFailed = false;
    try {
      // A batch whose rows all failed to encode sends nothing, so it leaves
      // any backoff episode as it is.
      if (records.length > 0) {
        await this.exportRecords(records);
        this.throttledAttempts = 0;
        this.backoffUntilMs = 0;
        this.observer?.recordRowsExported(records.length);
        this.observer?.recordFlush("success", currentTimeMs());
      }
    } catch (err) {
      this.lastFlushFailed = true;
      this.observer?.recordFlush("error", currentTimeMs());
      const failure = classifyScopeDbAppendFailure(err);
      if (failure.retryable && !this.closing) {
        // 429/503 (or a temporary rejection) without a client timeout: the
        // server refused and nothing committed. The stream does not replay
        // a plain-body 429/503 (it reports outcome "ambiguous"), so the sink
        // re-queues the batch and backs off instead of dropping it. Timeouts
        // and other unknown outcomes are still dropped, never replayed.
        this.throttledAttempts += 1;
        // One warning per backoff episode, not per attempt.
        if (this.throttledAttempts === 1) this.onError(err instanceof Error ? err : new Error(String(err)));
        this.requeue(rows);
        backoffMs = this.requeueBackoffMs(failure.retryAfterMs);
        this.backoffUntilMs = Date.now() + backoffMs;
      } else {
        this.onError(err instanceof Error ? err : new Error(String(err)));
        this.throttledAttempts = 0;
        this.backoffUntilMs = 0;
        this.droppedCount += rows.length;
        this.observer?.recordRowsDropped("export_error", rows.length);
      }
    } finally {
      this.flushing = false;
      this.flushPromise = null;
      if (backoffMs !== null) {
        // Replace whatever timer events armed while this flush was in flight:
        // the backoff (and Retry-After) decides when the next flush runs.
        if (this.flushTimer) {
          clearTimeout(this.flushTimer);
          this.flushTimer = null;
        }
        this.scheduleFlush(backoffMs);
      } else if (this.queue.length > 0) {
        this.scheduleFlush();
      }
    }
  }

  /** Doubling from the flush interval, at least Retry-After, at most a minute. */
  private requeueBackoffMs(retryAfterMs: number | undefined): number {
    const exponential = jitteredFlushDelayMs(this.flushIntervalMs, this.flushJitterMs)
      * 2 ** Math.min(this.throttledAttempts - 1, 6);
    return Math.min(Math.max(exponential, retryAfterMs ?? 0), MAX_REQUEUE_BACKOFF_MS);
  }

  private scheduleFlush(delayMs: number = jitteredFlushDelayMs(this.flushIntervalMs, this.flushJitterMs)): void {
    if (this.closing || this.flushTimer) return;
    // Never earlier than the current backoff deadline.
    delayMs = Math.max(delayMs, this.backoffUntilMs - Date.now());
    this.flushTimer = setTimeout(() => {
      this.flushTimer = null;
      void this.flush();
    }, delayMs);
    this.flushTimer.unref?.();
  }

  private async exportRecords(records: ReadonlyArray<Record<string, unknown>>): Promise<void> {
    if (records.length === 0) return;
    if (this.validateLiveSchema) await this.ensureLiveSchemaCompatible();
    const stream = this.getStream();
    try {
      for (const record of records) {
        await stream.send(record);
      }
      await stream.flush();
    } catch (err) {
      await this.resetStreamAfterFailure();
      throw err;
    }
  }

  /**
   * Only a schema that was read and does not match blocks writes (the
   * mismatch error fails the batch, as before). A catalog that cannot be
   * read, e.g. a write-only key refused with 401/403, skips the check for a
   * while (TRACE_EVENT_ROW_V2_SCHEMA_RECHECK_MS) and the batch is written;
   * Append itself rejects a real mismatch, so this never drops more than
   * blocking would, while blocking would drop every batch.
   */
  private async ensureLiveSchemaCompatible(): Promise<void> {
    if (Date.now() < this.schemaCheckSkippedUntilMs) return;
    if (!this.schemaValidationPromise) {
      const validation = this.client.table("trace_events_v2", { schema: "raft" })
        .catalog()
        .get({ signal: AbortSignal.timeout(5_000) })
        .then(
          (snapshot) => {
            assertTraceEventRowV2TableSchema(traceEventRowV2SchemaFieldsFromCatalog(snapshot.definition));
          },
          (error: unknown) => {
            this.skipSchemaCheck(traceEventRowV2SchemaCheckSkipReason(error), error);
            if (this.schemaValidationPromise === validation) this.schemaValidationPromise = null;
          },
        )
        .catch((error: unknown) => {
          if (this.schemaValidationPromise === validation) this.schemaValidationPromise = null;
          throw error;
        });
      this.schemaValidationPromise = validation;
    }
    await this.schemaValidationPromise;
  }

  private skipSchemaCheck(reason: TraceEventRowV2SchemaCheckSkipReason, error: unknown): void {
    const recheckMs = TRACE_EVENT_ROW_V2_SCHEMA_RECHECK_MS[reason];
    this.schemaCheckSkippedUntilMs = Date.now() + recheckMs;
    const status = (error as { httpStatus?: unknown } | null)?.httpStatus;
    this.observer?.recordSchemaCheckSkipped?.(reason, { ...(typeof status === "number" ? { httpStatus: status } : {}), recheckMs });
    if (this.warnedSchemaCheckSkips.has(reason)) return;
    this.warnedSchemaCheckSkips.add(reason);
    this.warn(`[TraceEventRows] ScopeDB live schema check skipped (${reason}${typeof status === "number" ? `, HTTP ${status}` : ""}): `
      + `writing without it; Append still rejects a real schema mismatch. Re-checking every ${TRACE_EVENT_ROW_V2_SCHEMA_RECHECK_MS[reason] / 1000} s.`);
  }

  private getStream(): AppendStream {
    if (!this.stream) {
      this.stream = this.buildStream();
    }
    return this.stream;
  }

  private buildStream(): AppendStream {
    return this.configureStreamBuilder(this.client.table("trace_events_v2", { schema: "raft" }).appendStream()).build();
  }

  private configureStreamBuilder(builder: AppendStreamBuilder): AppendStreamBuilder {
    // Stop policy (the default): a failed batch makes flush() throw and the
    // sink rebuilds the stream; flushOnce re-queues a refused (429/503) batch
    // and drops anything else as export_error. One batch in flight keeps the
    // 0.2 ingest stream's sequential requests; the SDK defaults to four per
    // stream, which multiplies 429 pressure across replicas. Unknown outcomes
    // are not replayed (SDK default; retryAmbiguous stays off). The attempt,
    // retry and elapsed bounds keep one flush (and shutdown) to ~30 s.
    return builder
      .flushIntervalMs(this.flushIntervalMs)
      .channelCapacity(this.batchSize)
      .maxConcurrentBatches(1)
      .attemptTimeoutMs(STREAM_ATTEMPT_TIMEOUT_MS)
      .maxRetries(STREAM_MAX_RETRIES)
      .maxElapsedTimeMs(STREAM_MAX_ELAPSED_MS);
  }

  private async resetStreamAfterFailure(): Promise<void> {
    const failed = this.stream;
    this.stream = null;
    if (!failed) return;
    try {
      await failed.shutdown();
    } catch {
      // The stream is already fatal/closed on this path. Swallow cleanup errors
      // so fail-aside accounting reports the original export failure.
    }
  }

  private async shutdownStream(): Promise<void> {
    const stream = this.stream;
    this.stream = null;
    if (!stream) return;
    try {
      await stream.shutdown();
    } catch (err) {
      this.observer?.recordFlush("error", currentTimeMs());
      this.onError(err instanceof Error ? err : new Error(String(err)));
    }
  }
}

export function jitteredFlushDelayMs(flushIntervalMs: number, flushJitterMs: number, random = Math.random): number {
  const interval = Math.max(1, flushIntervalMs);
  const jitter = Math.max(0, flushJitterMs);
  return interval + Math.floor(random() * jitter);
}
