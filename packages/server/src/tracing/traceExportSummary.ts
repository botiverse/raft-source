// What the server's OTLP exporter sent to Telescope, dropped and failed, per
// process per minute, in raft.trace_export_summary.
//
// The exporter drops a batch that fails or takes over 3 s and the oldest item
// when its queue is full; the drops were only in memory and the errors only in
// CloudWatch, which the o11y owner cannot read. At the v1.21.33 deploy
// (2026-10-24 08:45-08:47Z) about 60k spans and logs went missing and the cause
// (ScopeDB rate-limiting Telescope) took a CloudWatch search by someone else.
// So these counts go straight to ScopeDB with a committed Append, never through
// OTLP: when Telescope is the thing failing, a summary sent through it is lost
// with everything else (AndyLok, Tenny, task #14).

import { Client } from "scopedb";
import { encodeScopeDbAppendLine, type ScopeDbAppendColumnType } from "@botiverse/raft-shared";
import { errorClassOf } from "./semanticTrace";
import type { OtlpExportFailure, OtlpExportFailureKind, OtlpExportObserver, OtlpSignal } from "./otlpHttpTraceSink";

export const TRACE_EXPORT_SUMMARY_TABLE = "raft.trace_export_summary";
export const TRACE_EXPORT_SUMMARY_INTERVAL_MS = 60_000;
const WRITE_TIMEOUT_MS = 10_000;
const SHUTDOWN_WRITE_TIMEOUT_MS = 5_000;

const SIGNALS: readonly OtlpSignal[] = ["traces", "logs"];
const FAILURE_KINDS: readonly OtlpExportFailureKind[] = ["timeout", "network", "http_429", "http_4xx", "http_5xx"];

export interface TraceExportSummaryResource {
  serviceName: string;
  serviceVersion?: string | null;
  serviceRevision?: string | null;
  serviceInstanceId?: string | null;
  ecsTaskId?: string | null;
  deploymentEnvironment?: string | null;
}

type KindColumns = {
  [K in OtlpExportFailureKind as `${K}_batches`]: number;
} & {
  [K in OtlpExportFailureKind as `${K}_first_at` | `${K}_last_at`]: string | null;
};

export type TraceExportSummaryRow = KindColumns & {
  window_start: string;
  window_end: string;
  window_s: number;
  signal: OtlpSignal;
  /** Items (spans or log records) Telescope accepted. */
  exported: number;
  exported_batches: number;
  dropped_queue_full: number;
  dropped_export_failed: number;
  failed_batches: number;
  last_http_status: number | null;
  max_queue_depth: number;
  export_ms_max: number;
  /** Times this row's counts failed to be written before they were. */
  self_write_failed: number;
  service_name: string;
  service_version: string | null;
  service_revision: string | null;
  service_instance_id: string | null;
  ecs_task_id: string | null;
  deployment_environment: string | null;
};

interface KindWindow {
  batches: number;
  firstMs: number | null;
  lastMs: number | null;
}

interface SignalWindow {
  exported: number;
  exportedBatches: number;
  droppedQueueFull: number;
  droppedExportFailed: number;
  kinds: Record<OtlpExportFailureKind, KindWindow>;
  lastHttpStatus: number | null;
  lastHttpStatusMs: number;
  maxQueueDepth: number;
  exportMsMax: number;
  selfWriteFailed: number;
}

function emptySignalWindow(): SignalWindow {
  const kinds = {} as Record<OtlpExportFailureKind, KindWindow>;
  for (const kind of FAILURE_KINDS) kinds[kind] = { batches: 0, firstMs: null, lastMs: null };
  return {
    exported: 0,
    exportedBatches: 0,
    droppedQueueFull: 0,
    droppedExportFailed: 0,
    kinds,
    lastHttpStatus: null,
    lastHttpStatusMs: 0,
    maxQueueDepth: 0,
    exportMsMax: 0,
    selfWriteFailed: 0,
  };
}

function emptyWindows(): Record<OtlpSignal, SignalWindow> {
  return { traces: emptySignalWindow(), logs: emptySignalWindow() };
}

function failedBatches(window: SignalWindow): number {
  return FAILURE_KINDS.reduce((sum, kind) => sum + window.kinds[kind].batches, 0);
}

/** Queue depth alone is not activity: an idle minute writes no row. */
function hasActivity(window: SignalWindow): boolean {
  return window.exportedBatches > 0
    || window.droppedQueueFull > 0
    || failedBatches(window) > 0
    || window.selfWriteFailed > 0;
}

function minTime(a: number | null, b: number | null): number | null {
  if (a === null) return b;
  if (b === null) return a;
  return Math.min(a, b);
}

function maxTime(a: number | null, b: number | null): number | null {
  if (a === null) return b;
  if (b === null) return a;
  return Math.max(a, b);
}

/** An unwritten window folded into the one after it: sums, earliest firsts, latest lasts, maxima. */
function mergeSignalWindow(older: SignalWindow, newer: SignalWindow): SignalWindow {
  const kinds = {} as Record<OtlpExportFailureKind, KindWindow>;
  for (const kind of FAILURE_KINDS) {
    const a = older.kinds[kind];
    const b = newer.kinds[kind];
    kinds[kind] = { batches: a.batches + b.batches, firstMs: minTime(a.firstMs, b.firstMs), lastMs: maxTime(a.lastMs, b.lastMs) };
  }
  const newerStatus = newer.lastHttpStatus !== null && newer.lastHttpStatusMs >= older.lastHttpStatusMs;
  return {
    exported: older.exported + newer.exported,
    exportedBatches: older.exportedBatches + newer.exportedBatches,
    droppedQueueFull: older.droppedQueueFull + newer.droppedQueueFull,
    droppedExportFailed: older.droppedExportFailed + newer.droppedExportFailed,
    kinds,
    lastHttpStatus: newerStatus ? newer.lastHttpStatus : older.lastHttpStatus,
    lastHttpStatusMs: newerStatus ? newer.lastHttpStatusMs : older.lastHttpStatusMs,
    maxQueueDepth: Math.max(older.maxQueueDepth, newer.maxQueueDepth),
    exportMsMax: Math.max(older.exportMsMax, newer.exportMsMax),
    selfWriteFailed: older.selfWriteFailed + newer.selfWriteFailed,
  };
}

function isoOrNull(ms: number | null): string | null {
  return ms === null ? null : new Date(ms).toISOString();
}

function rowOf(
  signal: OtlpSignal,
  window: SignalWindow,
  startMs: number,
  endMs: number,
  resource: TraceExportSummaryResource,
): TraceExportSummaryRow {
  const kindColumns = {} as Record<string, number | string | null>;
  for (const kind of FAILURE_KINDS) {
    kindColumns[`${kind}_batches`] = window.kinds[kind].batches;
    kindColumns[`${kind}_first_at`] = isoOrNull(window.kinds[kind].firstMs);
    kindColumns[`${kind}_last_at`] = isoOrNull(window.kinds[kind].lastMs);
  }
  return {
    window_start: new Date(startMs).toISOString(),
    window_end: new Date(endMs).toISOString(),
    window_s: Math.max(0, Math.round((endMs - startMs) / 1000)),
    signal,
    exported: window.exported,
    exported_batches: window.exportedBatches,
    dropped_queue_full: window.droppedQueueFull,
    dropped_export_failed: window.droppedExportFailed,
    failed_batches: failedBatches(window),
    ...(kindColumns as KindColumns),
    last_http_status: window.lastHttpStatus,
    max_queue_depth: window.maxQueueDepth,
    export_ms_max: window.exportMsMax,
    self_write_failed: window.selfWriteFailed,
    service_name: resource.serviceName,
    service_version: resource.serviceVersion ?? null,
    service_revision: resource.serviceRevision ?? null,
    service_instance_id: resource.serviceInstanceId ?? null,
    ecs_task_id: resource.ecsTaskId ?? null,
    deployment_environment: resource.deploymentEnvironment ?? null,
  };
}

export interface TraceExportSummaryWriter {
  /** Resolves once the rows are committed; rejects otherwise. */
  write(rows: readonly TraceExportSummaryRow[], signal: AbortSignal): Promise<void>;
}

/**
 * Counts the OTLP exporter's outcomes (it is the exporter's observer) and
 * writes one row per signal per window. A window that fails to write is folded
 * into the next one, keeping its start, so no count is lost and the
 * per-kind failure times stay exact; only the granularity of that stretch
 * coarsens (Tenny). No retry queue.
 */
export class TraceExportSummary implements OtlpExportObserver {
  private windows = emptyWindows();
  private windowStartMs: number;
  private writing: Promise<void> | null = null;
  private timer: ReturnType<typeof setInterval> | null = null;

  constructor(
    private readonly writer: TraceExportSummaryWriter,
    private readonly resource: TraceExportSummaryResource,
    private readonly now: () => number = Date.now,
  ) {
    this.windowStartMs = now();
  }

  exported(signal: OtlpSignal, items: number, durationMs: number): void {
    const window = this.windows[signal];
    window.exported += items;
    window.exportedBatches += 1;
    window.exportMsMax = Math.max(window.exportMsMax, durationMs);
  }

  exportFailed(signal: OtlpSignal, items: number, durationMs: number, failure: OtlpExportFailure): void {
    const window = this.windows[signal];
    const atMs = this.now();
    const kind = window.kinds[failure.kind];
    kind.batches += 1;
    kind.firstMs ??= atMs;
    kind.lastMs = atMs;
    window.droppedExportFailed += items;
    window.exportMsMax = Math.max(window.exportMsMax, durationMs);
    if (failure.httpStatus !== undefined) {
      window.lastHttpStatus = failure.httpStatus;
      window.lastHttpStatusMs = atMs;
    }
  }

  droppedQueueFull(signal: OtlpSignal, items: number): void {
    this.windows[signal].droppedQueueFull += items;
  }

  queueDepth(signal: OtlpSignal, depth: number): void {
    const window = this.windows[signal];
    if (depth > window.maxQueueDepth) window.maxQueueDepth = depth;
  }

  start(intervalMs: number = TRACE_EXPORT_SUMMARY_INTERVAL_MS): void {
    if (this.timer) return;
    this.timer = setInterval(() => void this.report(), intervalMs);
    this.timer.unref?.();
  }

  /**
   * Closes the window and writes it. While a write is in flight the counts
   * keep accruing in the next window and this call waits for that write.
   */
  report(timeoutMs: number = WRITE_TIMEOUT_MS): Promise<void> {
    if (this.writing) return this.writing;
    const startMs = this.windowStartMs;
    const endMs = this.now();
    const taken = this.windows;
    this.windows = emptyWindows();
    this.windowStartMs = endMs;
    const rows = SIGNALS.filter((signal) => hasActivity(taken[signal]))
      .map((signal) => rowOf(signal, taken[signal], startMs, endMs, this.resource));
    if (rows.length === 0) return Promise.resolve();

    this.writing = this.writer.write(rows, AbortSignal.timeout(timeoutMs)).then(
      () => undefined,
      (err: unknown) => {
        // Error class only: the store's error text may echo row contents.
        console.warn("[trace-export-summary] ScopeDB write failed; folded into the next window:", errorClassOf(err));
        for (const signal of SIGNALS) {
          if (hasActivity(taken[signal])) taken[signal].selfWriteFailed += 1;
          this.windows[signal] = mergeSignalWindow(taken[signal], this.windows[signal]);
        }
        this.windowStartMs = startMs;
      },
    ).finally(() => {
      this.writing = null;
    });
    return this.writing;
  }

  /** Shutdown, after the exporter has flushed: report the last, partial window. */
  async stop(): Promise<void> {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
    if (this.writing) await this.writing;
    await this.report(SHUTDOWN_WRITE_TIMEOUT_MS);
  }
}

const COLUMNS: ReadonlyArray<readonly [keyof TraceExportSummaryRow, ScopeDbAppendColumnType]> = [
  ["window_start", "timestamp"],
  ["window_end", "timestamp"],
  ["window_s", "int"],
  ["signal", "string"],
  ["exported", "int"],
  ["exported_batches", "int"],
  ["dropped_queue_full", "int"],
  ["dropped_export_failed", "int"],
  ["failed_batches", "int"],
  ...FAILURE_KINDS.flatMap((kind) => [
    [`${kind}_batches`, "int"],
    [`${kind}_first_at`, "timestamp"],
    [`${kind}_last_at`, "timestamp"],
  ] as const),
  ["last_http_status", "int"],
  ["max_queue_depth", "int"],
  ["export_ms_max", "int"],
  ["self_write_failed", "int"],
  ["service_name", "string"],
  ["service_version", "string"],
  ["service_revision", "string"],
  ["service_instance_id", "string"],
  ["ecs_task_id", "string"],
  ["deployment_environment", "string"],
];

export const TRACE_EXPORT_SUMMARY_COLUMNS = COLUMNS;

/** One Append NDJSON line: the listed columns only, each encoded for its type. */
export function traceExportSummaryAppendLine(row: TraceExportSummaryRow): string {
  return encodeScopeDbAppendLine(row, COLUMNS);
}

/**
 * Persistence tier: decision_support. Committed one-shot Append (one attempt;
 * the SDK never replays a direct append); a failed write is folded into the
 * next window, and a replica killed without a shutdown loses its open window,
 * so counts are lower bounds. A timed-out append may still have committed, so
 * a folded window can occasionally be counted twice.
 */
export function scopeDbTraceExportSummaryWriter(
  endpoint: string,
  apiKey: string,
  client: Pick<Client, "table"> = new Client(endpoint, { apiKey }),
): TraceExportSummaryWriter {
  return {
    async write(rows, signal) {
      const ndjson = rows.map(traceExportSummaryAppendLine).join("\n");
      const result = await client.table("trace_export_summary", { schema: "raft" }).append(ndjson, { signal });
      if (result.num_rows_inserted !== rows.length) {
        // Not retried: the append committed, so a retry could count rows twice.
        console.warn(`[trace-export-summary] ScopeDB inserted ${result.num_rows_inserted} of ${rows.length} rows`);
      }
    },
  };
}
