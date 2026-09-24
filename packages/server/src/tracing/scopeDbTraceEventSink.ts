import { Client, type IngestStream, type IngestStreamBuilder } from "scopedb";
import {
  assertTraceEventRowV2TableSchema,
  currentTimeMs,
  TRACE_EVENT_ROW_V2_INGEST_STATEMENT,
  type CompletedTraceSpan,
  traceEventRowForRecord,
  traceSpanFactRowForSpan,
  type TraceEventRow,
  type TraceEventRowResource,
  type TraceEventRecord,
  type TraceSink,
  type TraceSpanFactRecord,
} from "@botiverse/raft-shared";

import type { ScopeDbPersistenceTier } from "../services/scopeDbSdkPolicy.js";

export interface ScopeDbTraceEventSinkOptions extends TraceEventRowResource {
  endpoint: string;
  token: string;
  batchSize?: number;
  flushIntervalMs?: number;
  flushJitterMs?: number;
  maxQueueSize?: number;
  validateLiveSchema?: boolean;
  client?: Pick<Client, "ingestStream" | "table">;
  onError?: (err: Error) => void;
  observer?: ScopeDbTraceEventSinkObserver;
}

export const TRACE_EVENT_SCOPEDB_PERSISTENCE_TIER: ScopeDbPersistenceTier = "decision_support";

export type ScopeDbTraceEventSinkDropReason = "queue_full" | "export_error";
export type ScopeDbTraceEventSinkFlushOutcome = "success" | "error";

export interface ScopeDbTraceEventSinkObserver {
  setQueueSize(size: number): void;
  recordFlush(outcome: ScopeDbTraceEventSinkFlushOutcome, atMs: number): void;
  recordRowsExported(count: number): void;
  recordRowsDropped(reason: ScopeDbTraceEventSinkDropReason, count: number): void;
}

export class ScopeDbTraceEventSink implements TraceSink {
  private readonly client: Pick<Client, "ingestStream" | "table">;
  private readonly resource: TraceEventRowResource;
  private readonly batchSize: number;
  private readonly flushIntervalMs: number;
  private readonly flushJitterMs: number;
  private readonly maxQueueSize: number;
  private readonly validateLiveSchema: boolean;
  private readonly onError: (err: Error) => void;
  private readonly observer?: ScopeDbTraceEventSinkObserver;
  private readonly queue: TraceEventRow[] = [];
  private stream: IngestStream | null = null;
  private flushTimer: ReturnType<typeof setTimeout> | null = null;
  private flushing = false;
  private flushPromise: Promise<void> | null = null;
  private schemaValidationPromise: Promise<void> | null = null;
  private droppedCount = 0;

  constructor(options: ScopeDbTraceEventSinkOptions) {
    // Persistence tier: decision_support. The outer fail-aside queue may shed
    // rows and process crashes may lose memory, so this stream improves retry
    // lifecycle but never upgrades observations to authoritative durability.
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

    if (this.queue.length >= this.batchSize) {
      void this.flush();
      return;
    }
    this.scheduleFlush();
  }

  recordSpanFact(record: TraceSpanFactRecord): void {
    this.enqueue(traceSpanFactRowForSpan(record.span, this.resource));

    if (this.queue.length >= this.batchSize) {
      void this.flush();
      return;
    }
    this.scheduleFlush();
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

  getDroppedCount(): number {
    return this.droppedCount;
  }

  async shutdown(): Promise<void> {
    if (this.flushTimer) {
      clearTimeout(this.flushTimer);
      this.flushTimer = null;
    }
    if (this.flushPromise) await this.flushPromise;
    await this.flush();
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
    const rows = this.queue.splice(0, this.batchSize);
    this.observer?.setQueueSize(this.queue.length);
    try {
      await this.exportRows(rows);
      this.observer?.recordRowsExported(rows.length);
      this.observer?.recordFlush("success", currentTimeMs());
    } catch (err) {
      this.droppedCount += rows.length;
      this.observer?.recordRowsDropped("export_error", rows.length);
      this.observer?.recordFlush("error", currentTimeMs());
      this.onError(err instanceof Error ? err : new Error(String(err)));
    } finally {
      this.flushing = false;
      this.flushPromise = null;
      if (this.queue.length > 0) this.scheduleFlush();
    }
  }

  private scheduleFlush(): void {
    if (this.flushTimer) return;
    this.flushTimer = setTimeout(() => {
      this.flushTimer = null;
      void this.flush();
    }, jitteredFlushDelayMs(this.flushIntervalMs, this.flushJitterMs));
    this.flushTimer.unref?.();
  }

  private async exportRows(rows: readonly TraceEventRow[]): Promise<void> {
    if (rows.length === 0) return;
    if (this.validateLiveSchema) await this.ensureLiveSchemaCompatible();
    const stream = this.getStream();
    try {
      for (const row of rows) {
        await stream.send(row);
      }
      await stream.flush();
    } catch (err) {
      await this.resetStreamAfterFailure();
      throw err;
    }
  }

  private async ensureLiveSchemaCompatible(): Promise<void> {
    if (!this.schemaValidationPromise) {
      this.schemaValidationPromise = this.client.table("trace_events_v2")
        .withSchema("raft")
        .tableSchema({ signal: AbortSignal.timeout(5_000) })
        .then((schema) => {
          assertTraceEventRowV2TableSchema(schema.fields().map((field) => ({
            name: field.name(),
            dataType: field.dataType(),
          })));
        })
        .catch((error) => {
          this.schemaValidationPromise = null;
          throw error;
        });
    }
    await this.schemaValidationPromise;
  }

  private getStream(): IngestStream {
    if (!this.stream) {
      this.stream = this.buildStream();
    }
    return this.stream;
  }

  private buildStream(): IngestStream {
    return this.configureStreamBuilder(this.client.ingestStream(TRACE_EVENT_ROW_V2_INGEST_STATEMENT)).build();
  }

  private configureStreamBuilder(builder: IngestStreamBuilder): IngestStreamBuilder {
    return builder
      .flushInterval(this.flushIntervalMs)
      .channelCapacity(this.batchSize);
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
