import {
  clearClockTimeout,
  currentTimeMs,
  isTraceEventRowV2CompatibleSchemaFingerprint,
  setClockTimeout,
  TRACE_EVENT_ROW_V2_SCHEMA_FINGERPRINT,
  TRACE_EVENT_ROW_V2_TABLE,
} from "@botiverse/raft-shared";
import {
  EventBufferMetrics,
  type EventBufferDropReason,
  type EventBufferQueueMetricState,
  type EventBufferRejectReason,
} from "./metrics.js";

export type EventBufferRow = Record<string, unknown>;

export interface EventBufferEnvelope {
  table: string;
  schemaFingerprint: string;
  rows: readonly EventBufferRow[];
}

export type EventBufferExportResult =
  | { outcome: "committed"; committedRows: number }
  | { outcome: "rate_limited"; retryAfterMs?: number }
  | { outcome: "failed" };

export interface EventBufferExporter {
  export(envelope: EventBufferEnvelope): Promise<EventBufferExportResult>;
}

export interface EventBufferOptions {
  exporter: EventBufferExporter;
  maxQueueRows: number;
  maxQueueBytes: number;
  maxBatchRows: number;
  /** Sum of JSON-encoded row payload bytes; excludes wire-envelope framing. */
  maxBatchBytes: number;
  maxBatchAgeMs: number;
  maxQps: number;
  rateLimitBackoffMs?: number;
  maxRateLimitBackoffMs?: number;
  metrics?: EventBufferMetrics;
  now?: () => number;
}

export type EventBufferEnqueueReceipt =
  | {
    state: "queued";
    durability: "memory_only";
    acceptedRows: number;
    rejectedRows: number;
    acceptedBytes: number;
    queueDepthRows: number;
    committedRows: 0;
  }
  | { state: "rejected"; reason: EventBufferRejectReason };

export type EventBufferDrainReceipt =
  | { state: "drained"; pendingRows: 0 }
  | {
    state: "timed_out";
    pendingRows: number;
    droppedRows: number;
    abandonedInFlightRows: number;
  };

interface QueueEntry {
  row: EventBufferRow;
  bytes: number;
  enqueuedAtMs: number;
}

const DEFAULT_RATE_LIMIT_BACKOFF_MS = 1_000;
const DEFAULT_MAX_RATE_LIMIT_BACKOFF_MS = 30_000;
const MAX_QPS = 3;

export class EventBuffer {
  readonly metrics: EventBufferMetrics;
  private readonly options: Required<Omit<EventBufferOptions, "metrics" | "now">>;
  private readonly exporter: EventBufferExporter;
  private readonly now: () => number;
  private readonly bucket: SingleTokenBucket;
  private readonly queue: QueueEntry[] = [];
  private queuedBytes = 0;
  private inFlight: QueueEntry[] = [];
  private worker: Promise<void> | null = null;
  private accepting = true;
  private draining = false;
  private abandonInFlight = false;
  private blockedUntilMs = 0;
  private rateLimitStreak = 0;
  private readonly wakeWaiters = new Set<() => void>();
  private readonly emptyWaiters = new Set<() => void>();

  constructor(options: EventBufferOptions) {
    validateOptions(options);
    this.exporter = options.exporter;
    this.metrics = options.metrics ?? new EventBufferMetrics();
    this.now = options.now ?? currentTimeMs;
    this.options = {
      exporter: options.exporter,
      maxQueueRows: options.maxQueueRows,
      maxQueueBytes: options.maxQueueBytes,
      maxBatchRows: options.maxBatchRows,
      maxBatchBytes: options.maxBatchBytes,
      maxBatchAgeMs: options.maxBatchAgeMs,
      maxQps: options.maxQps,
      rateLimitBackoffMs: options.rateLimitBackoffMs ?? DEFAULT_RATE_LIMIT_BACKOFF_MS,
      maxRateLimitBackoffMs: options.maxRateLimitBackoffMs ?? DEFAULT_MAX_RATE_LIMIT_BACKOFF_MS,
    };
    this.bucket = new SingleTokenBucket(options.maxQps, this.now());
  }

  enqueue(envelope: EventBufferEnvelope): EventBufferEnqueueReceipt {
    this.metrics.recordIngressAttempt();
    const rejected = this.validateEnvelope(envelope);
    if (rejected) return this.reject(rejected);

    let entries: QueueEntry[];
    try {
      entries = envelope.rows.map((row) => ({
        row,
        bytes: encodedBytes(row),
        enqueuedAtMs: this.now(),
      }));
    } catch {
      return this.reject("invalid_envelope");
    }
    const acceptedEntries = entries.filter((entry) => entry.bytes <= this.options.maxBatchBytes);
    const rejectedRows = entries.length - acceptedEntries.length;
    if (rejectedRows > 0) this.metrics.recordIngressRejectedRows("row_too_large", rejectedRows);
    if (acceptedEntries.length === 0) return this.reject("row_too_large");
    const acceptedBytes = acceptedEntries.reduce((sum, entry) => sum + entry.bytes, 0);
    if (
      this.pendingRows() + acceptedEntries.length > this.options.maxQueueRows
      || this.pendingBytes() + acceptedBytes > this.options.maxQueueBytes
    ) {
      return this.reject("queue_full");
    }

    this.queue.push(...acceptedEntries);
    this.queuedBytes += acceptedBytes;
    this.metrics.recordAccepted(acceptedEntries.length);
    this.wake();
    this.ensureWorker();
    return {
      state: "queued",
      durability: "memory_only",
      acceptedRows: acceptedEntries.length,
      rejectedRows,
      acceptedBytes,
      queueDepthRows: this.pendingRows(),
      committedRows: 0,
    };
  }

  reject(reason: EventBufferRejectReason): Extract<EventBufferEnqueueReceipt, { state: "rejected" }> {
    this.metrics.recordRejected(reason);
    return { state: "rejected", reason };
  }

  queueMetrics(): EventBufferQueueMetricState {
    const oldestAt = Math.min(
      this.queue[0]?.enqueuedAtMs ?? Number.POSITIVE_INFINITY,
      this.inFlight[0]?.enqueuedAtMs ?? Number.POSITIVE_INFINITY,
    );
    return {
      depthRows: this.pendingRows(),
      depthBytes: this.pendingBytes(),
      oldestAgeMs: Number.isFinite(oldestAt) ? Math.max(0, this.now() - oldestAt) : 0,
    };
  }

  renderPrometheusMetrics(): string {
    return this.metrics.renderPrometheus(this.queueMetrics());
  }

  async drain(timeoutMs: number): Promise<EventBufferDrainReceipt> {
    if (!Number.isFinite(timeoutMs) || timeoutMs < 0) {
      throw new Error("timeoutMs must be a non-negative finite number");
    }
    this.accepting = false;
    this.draining = true;
    this.wake();
    this.ensureWorker();
    if (this.pendingRows() === 0) return { state: "drained", pendingRows: 0 };

    const drained = await Promise.race([
      this.waitForEmpty().then(() => true),
      delay(timeoutMs).then(() => false),
    ]);
    if (drained) return { state: "drained", pendingRows: 0 };

    const droppedRows = this.queue.length;
    const abandonedInFlightRows = this.inFlight.length;
    const pendingRows = droppedRows + abandonedInFlightRows;
    this.metrics.recordDropped("drain_timeout", droppedRows);
    this.metrics.recordOutcomeUnknown("abandoned_in_flight", abandonedInFlightRows);
    this.queue.length = 0;
    this.queuedBytes = 0;
    this.abandonInFlight = true;
    this.inFlight = [];
    this.wake();
    this.notifyEmpty();
    return { state: "timed_out", pendingRows, droppedRows, abandonedInFlightRows };
  }

  async waitUntilIdle(): Promise<void> {
    if (this.pendingRows() === 0) return;
    await this.waitForEmpty();
  }

  private validateEnvelope(envelope: EventBufferEnvelope): EventBufferRejectReason | null {
    if (!this.accepting) return "shutting_down";
    if (envelope.table !== TRACE_EVENT_ROW_V2_TABLE) return "table_not_allowed";
    if (!isTraceEventRowV2CompatibleSchemaFingerprint(envelope.schemaFingerprint)) return "schema_mismatch";
    if (envelope.rows.length === 0 || envelope.rows.some((row) => !isRow(row))) {
      return "invalid_envelope";
    }
    return null;
  }

  private ensureWorker(): void {
    if (this.worker || this.queue.length === 0) return;
    this.worker = this.runWorker().finally(() => {
      this.worker = null;
      if (this.queue.length > 0 && !this.abandonInFlight) this.ensureWorker();
      this.notifyEmpty();
    });
  }

  private async runWorker(): Promise<void> {
    while (this.queue.length > 0 && !this.abandonInFlight) {
      const waitMs = this.waitBeforeNextAttemptMs();
      if (waitMs > 0) {
        await this.waitForWakeOrDelay(waitMs);
        continue;
      }

      this.bucket.consume(this.now());
      const batch = this.takeBatch();
      this.inFlight = batch;
      this.metrics.recordExportAttempt(batch.length);
      let result: EventBufferExportResult;
      try {
        result = await this.exporter.export({
          table: TRACE_EVENT_ROW_V2_TABLE,
          schemaFingerprint: TRACE_EVENT_ROW_V2_SCHEMA_FINGERPRINT,
          rows: batch.map((entry) => entry.row),
        });
      } catch {
        result = { outcome: "failed" };
      }
      if (this.abandonInFlight) {
        this.inFlight = [];
        break;
      }
      this.handleExportResult(batch, result);
      this.inFlight = [];
      this.notifyEmpty();
    }
  }

  private waitBeforeNextAttemptMs(): number {
    const now = this.now();
    if (this.blockedUntilMs > now) return this.blockedUntilMs - now;
    const tokenWait = this.bucket.waitMs(now);
    if (tokenWait > 0) return tokenWait;
    if (this.draining || this.batchThresholdReached()) return 0;
    const oldestAt = this.queue[0]?.enqueuedAtMs ?? now;
    return Math.max(0, oldestAt + this.options.maxBatchAgeMs - now);
  }

  private batchThresholdReached(): boolean {
    return this.queue.length >= this.options.maxBatchRows
      || this.queuedBytes >= this.options.maxBatchBytes;
  }

  private takeBatch(): QueueEntry[] {
    const batch: QueueEntry[] = [];
    let bytes = 0;
    while (batch.length < this.options.maxBatchRows && this.queue.length > 0) {
      const next = this.queue[0]!;
      if (batch.length > 0 && bytes + next.bytes > this.options.maxBatchBytes) break;
      this.queue.shift();
      this.queuedBytes -= next.bytes;
      batch.push(next);
      bytes += next.bytes;
    }
    return batch;
  }

  private handleExportResult(batch: QueueEntry[], result: EventBufferExportResult): void {
    if (result.outcome === "committed" && result.committedRows === batch.length) {
      this.metrics.recordCommitted(batch.length);
      this.rateLimitStreak = 0;
      this.blockedUntilMs = 0;
      return;
    }
    if (result.outcome === "rate_limited") {
      this.metrics.recordRateLimited();
      this.queue.unshift(...batch);
      this.queuedBytes += batch.reduce((sum, entry) => sum + entry.bytes, 0);
      this.rateLimitStreak += 1;
      const exponentialBackoff = Math.min(
        this.options.maxRateLimitBackoffMs,
        this.options.rateLimitBackoffMs * (2 ** (this.rateLimitStreak - 1)),
      );
      const retryAfterMs = result.retryAfterMs ?? 0;
      const requestedBackoff = Number.isFinite(retryAfterMs) && retryAfterMs > 0
        ? Math.min(this.options.maxRateLimitBackoffMs, retryAfterMs)
        : 0;
      this.blockedUntilMs = this.now() + Math.max(exponentialBackoff, requestedBackoff);
      return;
    }
    const reason: EventBufferDropReason = result.outcome === "committed"
      ? "commit_mismatch"
      : "export_failure";
    this.metrics.recordDropped(reason, batch.length);
    this.rateLimitStreak = 0;
    this.blockedUntilMs = 0;
  }

  private pendingRows(): number {
    return this.queue.length + this.inFlight.length;
  }

  private pendingBytes(): number {
    return this.queuedBytes + this.inFlight.reduce((sum, entry) => sum + entry.bytes, 0);
  }

  private waitForWakeOrDelay(ms: number): Promise<void> {
    return new Promise((resolve) => {
      const timer = setClockTimeout(done, ms);
      const self = this;
      function done() {
        clearClockTimeout(timer);
        self.wakeWaiters.delete(done);
        resolve();
      }
      this.wakeWaiters.add(done);
    });
  }

  private wake(): void {
    for (const waiter of [...this.wakeWaiters]) waiter();
  }

  private waitForEmpty(): Promise<void> {
    return new Promise((resolve) => this.emptyWaiters.add(resolve));
  }

  private notifyEmpty(): void {
    if (this.pendingRows() > 0) return;
    for (const waiter of this.emptyWaiters) waiter();
    this.emptyWaiters.clear();
  }
}

class SingleTokenBucket {
  private tokens = 1;
  private lastRefillMs: number;

  constructor(private readonly ratePerSecond: number, nowMs: number) {
    this.lastRefillMs = nowMs;
  }

  waitMs(nowMs: number): number {
    this.refill(nowMs);
    return this.tokens >= 1 ? 0 : Math.ceil(((1 - this.tokens) / this.ratePerSecond) * 1_000);
  }

  consume(nowMs: number): void {
    this.refill(nowMs);
    this.tokens = Math.max(0, this.tokens - 1);
  }

  private refill(nowMs: number): void {
    const elapsedMs = Math.max(0, nowMs - this.lastRefillMs);
    this.tokens = Math.min(1, this.tokens + ((elapsedMs / 1_000) * this.ratePerSecond));
    this.lastRefillMs = nowMs;
  }
}

function validateOptions(options: EventBufferOptions): void {
  const positiveIntegers = [
    ["maxQueueRows", options.maxQueueRows],
    ["maxBatchRows", options.maxBatchRows],
  ] as const;
  for (const [name, value] of positiveIntegers) {
    if (!Number.isInteger(value) || value <= 0) throw new Error(`${name} must be a positive integer`);
  }
  const positive = [
    ["maxQueueBytes", options.maxQueueBytes],
    ["maxBatchBytes", options.maxBatchBytes],
    ["maxBatchAgeMs", options.maxBatchAgeMs],
    ["maxQps", options.maxQps],
  ] as const;
  for (const [name, value] of positive) {
    if (!Number.isFinite(value) || value <= 0) throw new Error(`${name} must be a positive finite number`);
  }
  if (options.maxQps > MAX_QPS) throw new Error(`maxQps must be <= ${MAX_QPS}`);
  if (options.maxBatchRows > options.maxQueueRows) throw new Error("maxBatchRows must be <= maxQueueRows");
  if (options.maxBatchBytes > options.maxQueueBytes) throw new Error("maxBatchBytes must be <= maxQueueBytes");
  const backoffMs = options.rateLimitBackoffMs ?? DEFAULT_RATE_LIMIT_BACKOFF_MS;
  const maxBackoffMs = options.maxRateLimitBackoffMs ?? DEFAULT_MAX_RATE_LIMIT_BACKOFF_MS;
  if (!Number.isFinite(backoffMs) || backoffMs <= 0) throw new Error("rateLimitBackoffMs must be positive");
  if (!Number.isFinite(maxBackoffMs) || maxBackoffMs < backoffMs) {
    throw new Error("maxRateLimitBackoffMs must be >= rateLimitBackoffMs");
  }
}

function encodedBytes(row: EventBufferRow): number {
  const encoded = JSON.stringify(row);
  if (encoded === undefined) throw new Error("row is not JSON serializable");
  return Buffer.byteLength(encoded);
}

function isRow(value: unknown): value is EventBufferRow {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setClockTimeout(resolve, ms));
}
