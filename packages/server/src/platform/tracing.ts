// Platform entry point: an app's spans in the request's trace (Tracing V2,
// docs/observability/raft-tracing-v2-contract.md). A span wraps real work
// with its duration as a child of the active span (the HTTP request's, or an
// app span's around it), under core's tracer and its sinks; outside a traced
// request it just runs the work. An operation's count goes to core's
// metrics (countAppOperation). Name spans `server.<app id>.<operation>`.
// Attributes are fixed values, counts, buckets and outcome codes only: never
// content, titles, names, paths, ids of content or free text.
import type { TraceAttributes } from "@botiverse/raft-shared";
import { appOperationsTotal } from "../metrics";
import { recordTraceEvent, withTraceChildSpan, type TraceChildSpanOutcome } from "../tracing/semanticTrace";

export type AppSpanOutcome<T> = TraceChildSpanOutcome<T>;

/**
 * Run `work` in the span `name` with `attrs` at its start; `outcome` adds
 * attributes at its end (from the result, or the error it threw, which
 * also sets `error_class` and an error status) and, for work that answers a
 * failure rather than throwing it, the status (`statusOf`). Every span ends
 * with `duration_ms`.
 */
export function withAppSpan<T>(name: string, attrs: TraceAttributes, work: () => Promise<T>, outcome?: AppSpanOutcome<T>): Promise<T> {
  return withTraceChildSpan(name, { surface: "server", kind: "internal", attrs }, work, outcome);
}

/**
 * Record a point-in-time fact of an app (`server.<app id>.<event>`) as a
 * trace event: on the active span when there is one, else on its own. The
 * same attribute rules as spans.
 */
export function recordAppEvent(name: string, attrs: TraceAttributes): void {
  recordTraceEvent(name, attrs);
}

/**
 * Count one of an app's operations in core's metrics
 * (`slock_app_operations_total{app, operation, outcome}`). `app` is the
 * app's id; `operation` and `outcome` are fixed strings in the app's code
 * (never content, ids or free text), so the series stay few.
 */
export function countAppOperation(app: string, operation: string, outcome: string): void {
  appOperationsTotal.inc({ app, operation, outcome });
}

/** A byte count as a coarse bucket, so a span tells sizes apart without saying one exactly. */
export function byteSizeBucket(bytes: number): string {
  if (bytes <= 0) return "0";
  if (bytes < 10 * 1024) return "<10KiB";
  if (bytes < 100 * 1024) return "10-100KiB";
  if (bytes < 1024 * 1024) return "100KiB-1MiB";
  if (bytes < 10 * 1024 * 1024) return "1-10MiB";
  return ">=10MiB";
}

/** A count as a coarse bucket (files, references). */
export function countBucket(count: number): string {
  if (count <= 0) return "0";
  if (count === 1) return "1";
  if (count <= 5) return "2-5";
  if (count <= 20) return "6-20";
  if (count <= 100) return "21-100";
  return ">100";
}
