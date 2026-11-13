import { and, asc, count, eq, isNull, min, sql } from "drizzle-orm";
import { clearClockInterval, currentDate, noopTracer, setClockInterval, type Tracer } from "@botiverse/raft-shared";
import { getDb } from "../db/index";
import { marketplaceReviewOutbox } from "../db/schema";
import { marketplaceReviewOutboxOldestUndeliveredAgeSeconds, marketplaceReviewOutboxUndeliveredRows } from "../metrics";
import { emitRemovedAppBots, type AppBotRemovalRuntime } from "../routes/appBotRemovalBroadcast";
import { recordTraceEvent, withTraceRoot } from "../tracing/semanticTrace";
import { announcePermissionUpdatesCommitted } from "./listChangedRealtime";

// What follows a marketplace review decision outside the database
// (#proj-apps:#50). The decision functions (marketplace_decide_publish_review,
// marketplace_approve_permission_review) write one marketplace_review_outbox
// row per side effect in the decision's own transaction. App Admin calls them
// through its app_admin_* entries straight against Postgres (Raft's own review
// routes were removed, #proj-apps task #19). This module sends the rows, as
// those routes did after their commit:
//
//   app_bot_removed             an offline approval removed this bot:
//                               `agent:deleted` to server:<id>, the
//                               credential revocation signal, its held
//                               activity forgotten (emitRemovedAppBots)
//   permission_updates_changed  `permission-updates:changed` to server:<id>
//
// The bot's credentials were already revoked by the decision itself; the
// signal only closes streams that were open (they re-validate against the
// database at their next heartbeat anyway).
//
// Delivery is at least once and in order per App: one App's rows go in `seq`
// order under a transaction-scoped advisory lock on the App, each marked
// delivered in that transaction after it is sent, and a row that fails stops
// its App's later rows until it goes. A crash between a send and the commit
// sends it again, which each kind tolerates (clients re-read; streams
// re-validate). Every replica polls every 5 s.

/** Advisory lock class ("MRVO"); the object id is hashtext(client_id). */
export const MARKETPLACE_REVIEW_OUTBOX_LOCK_CLASS = 0x4d52564f;
const DEFAULT_INTERVAL_MS = 5_000;
/** Apps per poll, oldest first, and rows per App per pass. */
const DEFAULT_APP_BATCH = 20;
const DEFAULT_ROW_BATCH = 200;

export type MarketplaceReviewOutboxRow = typeof marketplaceReviewOutbox.$inferSelect;

/** Where each kind of row is sent. A sink that throws leaves the row (and its App's later rows) for the next pass. */
export type MarketplaceReviewSideEffectSinks = {
  appBotRemoved(bot: { serverId: string; agentId: string }): Promise<void>;
  permissionUpdatesChanged(serverId: string): void;
};

/** The production sinks: the same calls the review routes made after their commit. */
export function marketplaceReviewSideEffectSinks(runtime: AppBotRemovalRuntime): MarketplaceReviewSideEffectSinks {
  return {
    appBotRemoved: (bot) => emitRemovedAppBots(runtime, [bot]),
    permissionUpdatesChanged: (serverId) => announcePermissionUpdatesCommitted([serverId]),
  };
}

async function deliver(row: MarketplaceReviewOutboxRow, sinks: MarketplaceReviewSideEffectSinks): Promise<void> {
  if (row.kind === "app_bot_removed") {
    if (!row.agentId) throw new Error("MARKETPLACE_REVIEW_OUTBOX_BOT_WITHOUT_AGENT");
    await sinks.appBotRemoved({ serverId: row.serverId, agentId: row.agentId });
    return;
  }
  if (row.kind === "permission_updates_changed") {
    sinks.permissionUpdatesChanged(row.serverId);
    return;
  }
  throw new Error(`MARKETPLACE_REVIEW_OUTBOX_UNKNOWN_KIND:${String(row.kind)}`);
}

export type MarketplaceReviewOutboxAppResult = { clientId: string; delivered: number; failed: number; busy: boolean };

/**
 * One App's undelivered rows, oldest first, under the App's advisory lock:
 * each is sent, then marked delivered in this transaction; the first that
 * fails records its error and ends the pass for this App. An App another
 * replica is draining is skipped as busy.
 */
export async function drainMarketplaceReviewOutboxApp(input: {
  clientId: string;
  sinks: MarketplaceReviewSideEffectSinks;
  rowBatchSize?: number;
}): Promise<MarketplaceReviewOutboxAppResult> {
  const { clientId, sinks } = input;
  return getDb().transaction(async (tx) => {
    const lock = await tx.execute<{ acquired: boolean }>(
      sql`SELECT pg_catalog.pg_try_advisory_xact_lock(${MARKETPLACE_REVIEW_OUTBOX_LOCK_CLASS}, pg_catalog.hashtext(${clientId})) AS acquired`,
    );
    if (lock.rows[0]?.acquired !== true) return { clientId, delivered: 0, failed: 0, busy: true };
    const rows = await tx.select().from(marketplaceReviewOutbox)
      .where(and(eq(marketplaceReviewOutbox.clientId, clientId), isNull(marketplaceReviewOutbox.deliveredAt)))
      .orderBy(asc(marketplaceReviewOutbox.seq))
      .limit(input.rowBatchSize ?? DEFAULT_ROW_BATCH);
    let delivered = 0;
    let failed = 0;
    for (const row of rows) {
      try {
        await deliver(row, sinks);
      } catch (error) {
        await tx.update(marketplaceReviewOutbox).set({
          attempts: row.attempts + 1,
          lastError: (error instanceof Error ? error.message : String(error)).slice(0, 500),
        }).where(eq(marketplaceReviewOutbox.id, row.id));
        failed += 1;
        break;
      }
      await tx.update(marketplaceReviewOutbox).set({
        deliveredAt: currentDate(),
        attempts: row.attempts + 1,
        lastError: null,
      }).where(eq(marketplaceReviewOutbox.id, row.id));
      delivered += 1;
    }
    return { clientId, delivered, failed, busy: false };
  });
}

export type MarketplaceReviewOutboxDrainSummary = { apps: number; busy: number; delivered: number; failed: number };

/** One poll: the Apps with undelivered rows, the one waiting longest first, each drained if no one else is. */
export async function drainMarketplaceReviewOutbox(input: {
  sinks: MarketplaceReviewSideEffectSinks;
  appBatchSize?: number;
  rowBatchSize?: number;
}): Promise<MarketplaceReviewOutboxDrainSummary> {
  const first = min(marketplaceReviewOutbox.seq);
  const pending = await getDb().select({ clientId: marketplaceReviewOutbox.clientId, first })
    .from(marketplaceReviewOutbox)
    .where(isNull(marketplaceReviewOutbox.deliveredAt))
    .groupBy(marketplaceReviewOutbox.clientId)
    .orderBy(asc(first))
    .limit(input.appBatchSize ?? DEFAULT_APP_BATCH);
  const summary: MarketplaceReviewOutboxDrainSummary = { apps: 0, busy: 0, delivered: 0, failed: 0 };
  for (const { clientId } of pending) {
    summary.apps += 1;
    try {
      const result = await drainMarketplaceReviewOutboxApp({ clientId, sinks: input.sinks, rowBatchSize: input.rowBatchSize });
      if (result.busy) summary.busy += 1;
      summary.delivered += result.delivered;
      summary.failed += result.failed;
    } catch (error) {
      // This App's pass rolled back (its rows stay undelivered); the others still go.
      summary.failed += 1;
      console.error("[MarketplaceReviewOutbox] App drain failed:", { clientId, error: error instanceof Error ? error.message : String(error) });
    }
  }
  return summary;
}

/** The oldest undelivered row at the last successful read (null: none), so a failed read keeps the age growing. */
let oldestUndeliveredAt: Date | null = null;

/** Sets the backlog gauges from the table; on a failed read the age still advances from the last oldest row seen. */
export async function reportMarketplaceReviewOutboxBacklog(now: () => number = Date.now): Promise<void> {
  try {
    const [row] = await getDb().select({ rows: count(), oldest: min(marketplaceReviewOutbox.createdAt) })
      .from(marketplaceReviewOutbox)
      .where(isNull(marketplaceReviewOutbox.deliveredAt));
    oldestUndeliveredAt = row?.oldest ? new Date(row.oldest) : null;
    marketplaceReviewOutboxUndeliveredRows.set(Number(row?.rows ?? 0));
  } finally {
    const ageSeconds = oldestUndeliveredAt ? Math.max(0, (now() - oldestUndeliveredAt.getTime()) / 1000) : 0;
    marketplaceReviewOutboxOldestUndeliveredAgeSeconds.set(Math.round(ageSeconds));
  }
}

export function resetMarketplaceReviewOutboxBacklogForTests(): void {
  oldestUndeliveredAt = null;
  marketplaceReviewOutboxOldestUndeliveredAgeSeconds.reset();
  marketplaceReviewOutboxUndeliveredRows.reset();
}

/** A delivered row is deleted this many days after its `delivered_at`; an undelivered one is never deleted. */
export const MARKETPLACE_REVIEW_OUTBOX_RETENTION_DAYS = 30;
export const MARKETPLACE_REVIEW_OUTBOX_RETENTION_BATCH_SIZE = 500;
/** One hourly tick stops starting batches after this long. */
export const MARKETPLACE_REVIEW_OUTBOX_RETENTION_BUDGET_MS = 20_000;
/** Pause between batches. */
export const MARKETPLACE_REVIEW_OUTBOX_RETENTION_PAUSE_MS = 100;

export type MarketplaceReviewOutboxRetentionResult = {
  deleted: number;
  batches: number;
  durationMs: number;
  yielded: boolean;
};

/**
 * The hourly maintenance (server.ts, `prune_delivered_marketplace_review_outbox`):
 * delete rows delivered over the retention window ago, in small batches (by
 * the locked rows' ctid) until none is left or the time budget runs out.
 * Nothing reads a delivered row again. A row still undelivered is never
 * deleted, however old: it is the backlog the gauges and the alert watch, and
 * its App's later rows wait behind it.
 *
 * No index serves delivered rows (idx_marketplace_review_outbox_undelivered
 * holds only the undelivered ones, which this must not touch), so a batch
 * reads the table in order and stops at the batch size. The table holds
 * about the retention window's decisions, a few rows each, plus what is
 * undelivered.
 *
 * Maintenance runs on every replica at once; each batch takes a transaction
 * advisory lock first, and a replica that finds it held stops (`yielded`), so
 * one replica deletes at a time.
 */
export async function pruneDeliveredMarketplaceReviewOutbox(opts: {
  now?: Date;
  batchSize?: number;
  budgetMs?: number;
  pauseMs?: number;
} = {}): Promise<MarketplaceReviewOutboxRetentionResult> {
  const now = opts.now ?? currentDate();
  const cutoff = new Date(now.getTime() - MARKETPLACE_REVIEW_OUTBOX_RETENTION_DAYS * 24 * 60 * 60 * 1000);
  const batchSize = opts.batchSize ?? MARKETPLACE_REVIEW_OUTBOX_RETENTION_BATCH_SIZE;
  const budgetMs = opts.budgetMs ?? MARKETPLACE_REVIEW_OUTBOX_RETENTION_BUDGET_MS;
  const pauseMs = opts.pauseMs ?? MARKETPLACE_REVIEW_OUTBOX_RETENTION_PAUSE_MS;
  const startedAt = Date.now();
  let deleted = 0;
  let batches = 0;
  let yielded = false;
  try {
    for (;;) {
      const ids = await getDb().transaction(async (tx) => {
        const lock = await tx.execute<{ locked: boolean }>(
          sql`SELECT pg_catalog.pg_try_advisory_xact_lock(pg_catalog.hashtext('marketplace_review_outbox.retention')) AS locked`,
        );
        if (!lock.rows[0]?.locked) return null;
        const result = await tx.execute<{ id: string }>(sql`
          DELETE FROM ${marketplaceReviewOutbox}
          WHERE ctid = ANY(ARRAY(
            SELECT outbox.ctid FROM ${marketplaceReviewOutbox} outbox
            WHERE outbox.delivered_at IS NOT NULL
              AND outbox.delivered_at < ${cutoff}
            LIMIT ${batchSize}
            FOR UPDATE SKIP LOCKED))
          RETURNING id`);
        return result.rows;
      });
      if (!ids) {
        yielded = true;
        break;
      }
      batches += 1;
      deleted += ids.length;
      if (ids.length < batchSize || Date.now() - startedAt >= budgetMs) break;
      if (pauseMs > 0) await new Promise((resolve) => setTimeout(resolve, pauseMs));
    }
  } finally {
    recordTraceEvent("marketplace_review_outbox.retention", {
      event_kind: "marketplace_review_outbox_retention",
      deleted,
      batches,
      yielded,
      duration_ms: Date.now() - startedAt,
    });
  }
  return { deleted, batches, durationMs: Date.now() - startedAt, yielded };
}

/** The poll on every replica: drain, then the backlog gauges. */
export function startMarketplaceReviewOutboxWorker(input: {
  sinks: MarketplaceReviewSideEffectSinks;
  intervalMs?: number;
  tracer?: Tracer;
}): { stop(): void } {
  let stopped = false;
  let running = false;
  const tracer = input.tracer ?? noopTracer;
  const tick = async () => {
    if (stopped || running) return;
    running = true;
    try {
      // Each drain is a root span. A failure also records the
      // `server.marketplace_review_outbox.error` event inside it.
      await withTraceRoot(
        tracer,
        "server.marketplace_review_outbox.drain",
        { surface: "server", kind: "internal" },
        () => drainMarketplaceReviewOutbox({ sinks: input.sinks }),
        "server.marketplace_review_outbox.error",
      );
    } catch (error) {
      console.error("[MarketplaceReviewOutbox] drain failed:", error instanceof Error ? error.message : String(error));
    }
    try {
      await reportMarketplaceReviewOutboxBacklog();
    } catch (error) {
      console.warn("[MarketplaceReviewOutbox] backlog read failed:", error instanceof Error ? error.message : String(error));
    } finally {
      running = false;
    }
  };
  const timer = setClockInterval(() => void tick(), input.intervalMs ?? DEFAULT_INTERVAL_MS);
  (timer as { unref?: () => void }).unref?.();
  void tick();
  return {
    stop() {
      stopped = true;
      clearClockInterval(timer);
    },
  };
}
