import { AsyncLocalStorage } from "node:async_hooks";
import type { TraceAttributes } from "@botiverse/raft-shared";
import { recordTraceEvent } from "../tracing/semanticTrace";

/**
 * Per-statement totals for one unit of batched database work, for callers whose
 * statements run on a raw tx.execute and leave no db.query span. Without them
 * "why does this batch take 40 ms per row" (#proj-data:#4, Ray, 11-02) can only
 * be inferred. Written as one event when the unit ran long or issued many
 * statements, so a quick single-row claim stays silent. Only statement hashes
 * reach the event, never text or parameters.
 */
const SLOW_UNIT_MS = 1_000;
const MANY_STATEMENTS = 10;
const MAX_REPORTED = 30;

interface StatementTotal {
  count: number;
  totalMs: number;
  maxMs: number;
  errors: number;
}

const statsStore = new AsyncLocalStorage<Map<string, StatementTotal>>();

/** Called by the instrumented client for every statement; undefined when nothing is collecting. */
export function beginStatementStat(hashOf: () => string): ((err?: unknown) => void) | undefined {
  const stats = statsStore.getStore();
  if (!stats) return undefined;
  const startMs = Date.now();
  const hash = hashOf();
  return (err) => {
    const elapsedMs = Date.now() - startMs;
    const total = stats.get(hash) ?? { count: 0, totalMs: 0, maxMs: 0, errors: 0 };
    total.count += 1;
    total.totalMs += elapsedMs;
    total.maxMs = Math.max(total.maxMs, elapsedMs);
    if (err) total.errors += 1;
    stats.set(hash, total);
  };
}

export async function withStatementStats<T>(
  unit: string,
  work: () => Promise<T>,
  resultAttrs?: (result: T) => TraceAttributes,
): Promise<T> {
  const stats = new Map<string, StatementTotal>();
  const startMs = Date.now();
  let extraAttrs: TraceAttributes = {};
  try {
    const result = await statsStore.run(stats, work);
    if (resultAttrs) extraAttrs = resultAttrs(result);
    return result;
  } finally {
    const durationMs = Date.now() - startMs;
    const totals = [...stats.entries()];
    const statementCount = totals.reduce((sum, [, total]) => sum + total.count, 0);
    if (durationMs >= SLOW_UNIT_MS || statementCount >= MANY_STATEMENTS) {
      const reported = totals
        .sort(([, left], [, right]) => right.totalMs - left.totalMs)
        .slice(0, MAX_REPORTED)
        .map(([sqlHash, total]) => ({
          sql_hash: sqlHash,
          count: total.count,
          total_ms: total.totalMs,
          max_ms: total.maxMs,
          ...(total.errors > 0 ? { errors: total.errors } : {}),
        }));
      const attrs: TraceAttributes = {
        event_kind: "db_statement_stats",
        unit,
        duration_ms: durationMs,
        statement_count: statementCount,
        distinct_statement_count: totals.length,
        statements: JSON.stringify(reported),
        ...extraAttrs,
      };
      recordTraceEvent("db.statement_stats", attrs);
    }
  }
}
