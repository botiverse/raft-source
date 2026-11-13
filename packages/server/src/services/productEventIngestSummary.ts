// What became of RFC-067 product events on this replica, in otel.logs.
//
// The per-outcome counter (slock_product_event_ingest_total) is only in AMP,
// which the analytics and o11y owners cannot read. Production had zero rows in
// product.events and nobody could tell "nobody shares" or "flag off" from "no
// store" (AndyLok, Tenny 2026-10-15). So the same counts also go to the trace
// store: one event at startup naming the env pair the writer uses, then one
// event per outcome per window. Counts only, never ids or keys.

import type { ScopeDbAppendFailureClass, Tracer } from "@botiverse/raft-shared";
import type { ProductScopeDbStore } from "./productEventScopeDbWriter";

export const PRODUCT_EVENT_SUMMARY_INTERVAL_MS = 10 * 60_000;

const pending = new Map<string, number>();
// firstMs/lastMs: the window says only how many, and is reported up to 10
// minutes later, so a failure could not be placed against another signal's gap
// (v1.21.32 and v1.21.33 deploys, 2026-10-24: read at the report time).
const failures = new Map<string, { failure: ProductEventWriteFailure; count: number; firstMs: number; lastMs: number }>();

/**
 * One failed ScopeDB write, as bounded fields only (never the error message,
 * which can echo row contents). The `[product-events]` warn has the same class
 * but lands only in CloudWatch, which the analytics and o11y owners cannot
 * read (2026-10-24: 91 rows lost at two deploys, cause unknown).
 */
export interface ProductEventWriteFailure {
  table: "events" | "public_visitors";
  error_class: string;
  /** ScopeDB's own classification (`ScopeDBError.kind`), when the client threw one. */
  kind?: string;
  http_status?: number;
  /** Allowlisted network/TLS code from the error or its cause (`errorCodeOf`). */
  error_code?: string;
  /**
   * `classifyScopeDbAppendFailure` of a failed Append: "throttled" (HTTP 429)
   * and "unavailable" (503) with no client timeout, and "rejected", did not
   * commit; "unknown" (timeout, lost response, other 5xx, network) may have,
   * so its retry can duplicate. Read from the HTTP status, because the SDK
   * reports a plain-body 429/503 as outcome "ambiguous".
   */
  append_failure?: Exclude<ScopeDbAppendFailureClass, "local">;
}
let summary: { tracer: Tracer; store: ProductScopeDbStore; now: () => number; windowStartMs: number; timer: NodeJS.Timeout | null } | null = null;

/** Called beside every slock_product_event_ingest_total increment. */
export function noteProductEventOutcome(outcome: string, count: number): void {
  if (count > 0 && summary) pending.set(outcome, (pending.get(outcome) ?? 0) + count);
}

/** Called for every failed write; the batch is retried, or counted lost after the last attempt. */
export function noteProductEventWriteFailure(failure: ProductEventWriteFailure): void {
  if (!summary) return;
  const key = JSON.stringify(failure);
  const nowMs = summary.now();
  const seen = failures.get(key);
  if (seen) {
    seen.count += 1;
    seen.lastMs = nowMs;
  } else failures.set(key, { failure, count: 1, firstMs: nowMs, lastMs: nowMs });
}

/**
 * `server.product_events.store` once, then every interval one
 * `server.product_events.outcome` per outcome seen in the window and one
 * `server.product_events.write_failed` per kind of failed write, with when the
 * first and last of them happened (none when nothing happened). Shutdown reports the last window too
 * (`flushProductEventsBeforeExit`); a replica killed without one loses it:
 * lower bounds, like the counter.
 */
export function startProductEventIngestSummary(
  tracer: Tracer,
  store: ProductScopeDbStore,
  options: { intervalMs?: number; now?: () => number } = {},
): void {
  if (summary) return;
  const now = options.now ?? Date.now;
  summary = { tracer, store, now, windowStartMs: now(), timer: null };
  tracer.emitEvent("server.product_events.store", { surface: "server", attrs: { store } });
  summary.timer = setInterval(() => flushProductEventIngestSummary(now()), options.intervalMs ?? PRODUCT_EVENT_SUMMARY_INTERVAL_MS);
  summary.timer.unref?.();
}

export function flushProductEventIngestSummary(nowMs: number = Date.now()): void {
  if (!summary) return;
  const windowS = Math.max(0, Math.round((nowMs - summary.windowStartMs) / 1000));
  for (const [outcome, count] of pending) {
    summary.tracer.emitEvent("server.product_events.outcome", {
      surface: "server",
      attrs: { outcome, count, window_s: windowS, store: summary.store },
    });
  }
  pending.clear();
  for (const { failure, count, firstMs, lastMs } of failures.values()) {
    summary.tracer.emitEvent("server.product_events.write_failed", {
      surface: "server",
      attrs: {
        ...failure,
        count,
        first_at: new Date(firstMs).toISOString(),
        last_at: new Date(lastMs).toISOString(),
        window_s: windowS,
        store: summary.store,
      },
    });
  }
  failures.clear();
  summary.windowStartMs = nowMs;
}

/** How long the traces wait for the product rows at shutdown before they flush anyway. */
export const PRODUCT_EVENT_SHUTDOWN_FLUSH_BUDGET_MS = 5_000;

/**
 * Server shutdown: write the queued product rows, then report the last, partial
 * window, then flush the tracer that carries it. Without the last window a
 * replica's final minutes of outcomes (written, lost) never reach otel.logs, so
 * a loss at a deploy shows up only on the replicas that started, never on the
 * ones that stopped (AndyLok, Nova 2026-10-24). A slow write holds the window and
 * the tracer for at most the budget; the rows themselves are still awaited, up
 * to the server's shutdown deadline, as before.
 */
export async function flushProductEventsBeforeExit(deps: {
  flushRows: () => Promise<unknown>;
  shutdownTracer: () => Promise<void>;
  budgetMs?: number;
  now?: () => number;
}): Promise<void> {
  // Never throws or rejects: a sink that fails to build (bad endpoint) must not skip the tracer.
  const rows = Promise.resolve().then(deps.flushRows).catch(() => undefined);
  let timer: ReturnType<typeof setTimeout> | undefined;
  const budget = new Promise<void>((resolve) => {
    timer = setTimeout(resolve, deps.budgetMs ?? PRODUCT_EVENT_SHUTDOWN_FLUSH_BUDGET_MS);
    timer.unref?.();
  });
  const reported = Promise.race([rows, budget]).then(() => {
    clearTimeout(timer);
    if (summary?.timer) clearInterval(summary.timer);
    if (summary) summary.timer = null;
    flushProductEventIngestSummary((deps.now ?? Date.now)());
    return deps.shutdownTracer();
  });
  // A tracer that fails fast must not cut the row write short.
  const [, tracer] = await Promise.allSettled([rows, reported]);
  if (tracer.status === "rejected") throw tracer.reason;
}

/** Test-only. */
export function resetProductEventIngestSummaryForTest(): void {
  if (summary?.timer) clearInterval(summary.timer);
  summary = null;
  pending.clear();
  failures.clear();
}
