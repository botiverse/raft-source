import type { Server as SocketServer } from "socket.io";
import { and, eq, sql } from "drizzle-orm";
import { clearClockInterval, noopTracer, setClockInterval, type Tracer } from "@botiverse/raft-shared";
import { getDb } from "../db";
import {
  linkCardAttempts, linkCardHandleUses, linkCardOperations, linkCardPreparedActions, linkCardUpdateTokens, linkCardViews, servers, type LinkCardOperationState,
} from "../db/schema";
import { recordTraceEvent, withTraceRoot } from "../tracing/semanticTrace";
import { recordIntegrationAuditEvent } from "./integrationAuditService";
import { linkCardReceiptHints, noLinkCardReceiptHints, type LinkCardReceiptHints } from "./linkCardReceiptHints";

// Interactive link card sweeps (protocol v3.2.3 §5.3.4, §7.3, §13.3; RFC 076
// §5.2). Every one is idempotent: each decision is re-made under the row's own
// lock (deadline) or inside the UPDATE / DELETE statement itself (views,
// reconciliation, trims), so a restart, a repeat or two replicas sweeping at
// once give the same result (Tenny 52bb9eb4). They only finish what was
// already started (§13.5). A sweep that moves an operation hints its viewer after the commit.

export type LinkCardDeadlineSweep = { due: number; failedNotSent: number; unknown: number; skipped: number };

/**
 * Closes `sent` operations past their first-send deadline. Under the
 * operation's row lock, the one the dispatch transaction takes, so exactly one
 * of them wins:
 * - no execute dispatch record: proved never sent -> failed_not_sent, audited
 *   as link_card.operation_first_send_expired (no token, URL or body);
 * - a dispatch record (the sender stopped before applying an answer, or found
 *   the deadline passed when signing): it may have been sent, and no execute
 *   JWT outlives the deadline -> unknown, then status (C2c).
 * The attempt is read in its own statement after the lock, so a dispatch that
 * committed while the sweep waited is seen.
 */
export async function sweepLinkCardFirstSendDeadlines(limit = 100, hints: LinkCardReceiptHints = noLinkCardReceiptHints): Promise<LinkCardDeadlineSweep> {
  const due = await getDb().select({ operationId: linkCardOperations.operationId }).from(linkCardOperations)
    .where(and(eq(linkCardOperations.state, "sent"), sql`${linkCardOperations.firstSendDeadline} <= clock_timestamp()`))
    .orderBy(linkCardOperations.firstSendDeadline).limit(limit);
  const summary: LinkCardDeadlineSweep = { due: due.length, failedNotSent: 0, unknown: 0, skipped: 0 };
  for (const { operationId } of due) {
    const swept = await getDb().transaction(async (tx): Promise<{ next: "failed_not_sent" | "unknown"; viewerId: string; serverId: string; receiptRevision: number } | null> => {
      const locked = await tx.execute<{ state: LinkCardOperationState; past: boolean; server_id: string; action_id: string; provider_kind: string; provider_key: string }>(sql`
        SELECT state, clock_timestamp() >= first_send_deadline AS past, server_id, action_id, provider_kind, provider_key
        FROM ${linkCardOperations} WHERE operation_id = ${operationId} FOR UPDATE`);
      const row = locked.rows[0];
      if (!row || row.state !== "sent" || row.past !== true) return null;
      const [dispatched] = await tx.select({ jti: linkCardAttempts.jti }).from(linkCardAttempts)
        .where(and(eq(linkCardAttempts.operationId, operationId), eq(linkCardAttempts.phase, "execute"))).limit(1);
      const next = dispatched ? "unknown" : "failed_not_sent";
      const [moved] = await tx.update(linkCardOperations).set({ state: next, receiptRevision: sql`${linkCardOperations.receiptRevision} + 1`, updatedAt: sql`now()` })
        .where(and(eq(linkCardOperations.operationId, operationId), eq(linkCardOperations.state, "sent")))
        .returning({ viewerId: linkCardOperations.viewerId, serverId: linkCardOperations.serverId, receiptRevision: linkCardOperations.receiptRevision });
      if (!moved) return null;
      if (next === "failed_not_sent") {
        // Server rows are soft-deleted, but a hard-deleted one must not block the close.
        const [server] = await tx.select({ id: servers.id }).from(servers).where(eq(servers.id, row.server_id));
        await recordIntegrationAuditEvent({
          serverId: server?.id ?? null, eventType: "link_card.operation_first_send_expired", outcome: "success", source: "system",
          actor: { type: "system" }, target: { type: "link_card_operation", id: operationId },
          metadata: { operationId, actionId: row.action_id, providerKind: row.provider_kind, providerKey: row.provider_key },
        }, tx);
      }
      return { next, ...moved };
    });
    if (swept) hints({ viewerId: swept.viewerId, serverId: swept.serverId, operationId, receiptRevision: swept.receiptRevision });
    if (swept?.next === "failed_not_sent") summary.failedNotSent += 1;
    else if (swept?.next === "unknown") summary.unknown += 1;
    else summary.skipped += 1;
  }
  return summary;
}

/** How long an `accepted` or `unknown` operation may wait for its result (RFC 076 §5.2; protocol §8.1, §13.3). */
export const LINK_CARD_RECONCILIATION_AFTER_HOURS = 24;

/**
 * `accepted` or `unknown` 24 hours after it was sent (its `created_at`: the
 * operation is written and moved to `sent` in one transaction) ->
 * `needs_reconciliation`. One conditional UPDATE: the age and state are
 * checked in the statement itself, so an operation a status or terminal
 * update moved meanwhile is left alone, and a repeat moves nothing. From
 * there a status the App answers with a terminal state, a terminal update
 * within its token's life, or a person (resolved_manually) closes it; the
 * record is never deleted and the intent never replayed. Returns how many moved.
 */
export async function sweepLinkCardReconciliation(limit = 100, hints: LinkCardReceiptHints = noLinkCardReceiptHints): Promise<number> {
  const moved = await getDb().execute<{ operation_id: string; viewer_id: string; server_id: string; receipt_revision: number }>(sql`
    UPDATE ${linkCardOperations} o
       SET state = 'needs_reconciliation', receipt_revision = o.receipt_revision + 1, updated_at = now()
     WHERE o.operation_id IN (SELECT operation_id FROM ${linkCardOperations}
                               WHERE state IN ('accepted', 'unknown')
                                 AND created_at <= clock_timestamp() - make_interval(hours => ${LINK_CARD_RECONCILIATION_AFTER_HOURS})
                               ORDER BY created_at LIMIT ${limit})
       AND o.state IN ('accepted', 'unknown')
       AND o.created_at <= clock_timestamp() - make_interval(hours => ${LINK_CARD_RECONCILIATION_AFTER_HOURS})
    RETURNING o.operation_id, o.viewer_id, o.server_id, o.receipt_revision`);
  for (const row of moved.rows) {
    hints({ viewerId: row.viewer_id, serverId: row.server_id, operationId: row.operation_id, receiptRevision: Number(row.receipt_revision) });
  }
  return moved.rows.length;
}

export type LinkCardTrimSweep = { handleUses: number; preparedActions: number; updateTokens: number };

/**
 * Deletes what RFC 076 §5.2 lets go, and nothing else:
 * - handle uses, once the handle has expired ("swept after the handle expires");
 * - prepared records, once expired ("immutable once written; swept after expiry");
 * - update tokens: an unconsumed one once expired (it can never be used), a
 *   consumed one with its receipt once its operation's terminal detail is
 *   past 24 hours ("receipt kept until the operation detail is trimmed";
 *   "terminal detail kept 24 h"). The receipt is the only terminal detail
 *   Raft holds: no toast, code or card is ever stored.
 * Operations, request mappings and attempts are kept (an `unknown` or
 * `needs_reconciliation` operation is never swept), and so are view rows (the
 * view sweep). Each expiry is given five more minutes, the margin the view
 * sweep uses, so no execute or update still deciding by a credential can race
 * its delete (they compare expiry with the database clock under row locks; a
 * handle use deleted the instant it expired could let a transaction that
 * passed its expiry check a moment earlier use the handle again). The
 * conditions are in each DELETE itself.
 */
export async function trimLinkCardRecords(limit = 500): Promise<LinkCardTrimSweep> {
  const uses = await getDb().execute<{ handle_sha256: string }>(sql`
    DELETE FROM ${linkCardHandleUses}
     WHERE handle_sha256 IN (SELECT handle_sha256 FROM ${linkCardHandleUses}
                              WHERE expires_at < clock_timestamp() - interval '5 minutes' ORDER BY expires_at LIMIT ${limit})
       AND expires_at < clock_timestamp() - interval '5 minutes'
    RETURNING handle_sha256`);
  const prepared = await getDb().execute<{ prepared_action_id: string }>(sql`
    DELETE FROM ${linkCardPreparedActions}
     WHERE prepared_action_id IN (SELECT prepared_action_id FROM ${linkCardPreparedActions}
                                   WHERE expires_at < clock_timestamp() - interval '5 minutes' ORDER BY expires_at LIMIT ${limit})
       AND expires_at < clock_timestamp() - interval '5 minutes'
    RETURNING prepared_action_id`);
  const trimmable = sql`t.expires_at < clock_timestamp() - interval '5 minutes'
    AND (t.consumed_update_id IS NULL
         OR EXISTS (SELECT 1 FROM ${linkCardOperations} o
                     WHERE o.operation_id = t.operation_id
                       AND o.state IN ('done', 'refused', 'failed_not_sent', 'resolved_manually')
                       AND o.updated_at < clock_timestamp() - interval '24 hours'))`;
  const tokens = await getDb().execute<{ token_sha256: string }>(sql`
    DELETE FROM ${linkCardUpdateTokens} t
     WHERE t.token_sha256 IN (SELECT t.token_sha256 FROM ${linkCardUpdateTokens} t WHERE ${trimmable} LIMIT ${limit})
       AND ${trimmable}
    RETURNING t.token_sha256`);
  return { handleUses: uses.rows.length, preparedActions: prepared.rows.length, updateTokens: tokens.rows.length };
}

/**
 * Deletes free view rows idle for 15 minutes, the 10-minute handle lifetime
 * plus 5 minutes (protocol §7.3, normative). The conditions are in the
 * DELETE itself, never only in the scan: a row a new execute claimed after the
 * scan (it moves updated_at and sets the pending operation) is left alone.
 * Free = no pending operation, or a terminal one (lazy release). A valid
 * handle for the same nonce may rebuild a swept row; it starts empty, so "one
 * pending operation per view" still holds.
 */
export async function sweepLinkCardViews(limit = 500): Promise<number> {
  const deleted = await getDb().execute<{ view_nonce: string }>(sql`
    DELETE FROM ${linkCardViews} v
     WHERE v.view_nonce IN (SELECT view_nonce FROM ${linkCardViews}
                             WHERE updated_at < clock_timestamp() - interval '15 minutes'
                             ORDER BY updated_at LIMIT ${limit})
       AND v.updated_at < clock_timestamp() - interval '15 minutes'
       AND (v.pending_operation_id IS NULL
            OR EXISTS (SELECT 1 FROM ${linkCardOperations} o
                        WHERE o.operation_id = v.pending_operation_id
                          AND o.state IN ('done', 'refused', 'failed_not_sent', 'resolved_manually')))
    RETURNING v.view_nonce`);
  return deleted.rows.length;
}

export interface LinkCardSweepWorkerOptions {
  tracer?: Tracer;
  intervalMs?: number;
  batchSize?: number;
  /** Receipt hints go out through it (RFC 076 §6.8); none without one. */
  io?: SocketServer | null;
}

export interface LinkCardSweepWorkerHandle {
  tick(): Promise<void>;
  stop(): void;
}

/**
 * Runs every sweep once a minute (the deadline is 10 minutes, so an operation
 * is closed at most about a minute late). Idle ticks leave no trace; a tick
 * with work emits `server.link_card.sweep` with counts only.
 */
export function startLinkCardSweepWorker(opts: LinkCardSweepWorkerOptions = {}): LinkCardSweepWorkerHandle {
  const tracer = opts.tracer ?? noopTracer;
  const batchSize = opts.batchSize ?? 100;
  const hints = linkCardReceiptHints(opts.io);
  let running = false;
  let stopped = false;

  const tick = async () => {
    if (running || stopped) return;
    running = true;
    try {
      const deadlines = await sweepLinkCardFirstSendDeadlines(batchSize, hints);
      const views = stopped ? 0 : await sweepLinkCardViews(batchSize * 5);
      const reconciled = stopped ? 0 : await sweepLinkCardReconciliation(batchSize, hints);
      const trimmed = stopped ? { handleUses: 0, preparedActions: 0, updateTokens: 0 } : await trimLinkCardRecords(batchSize * 5);
      if (!deadlines.due && !views && !reconciled && !trimmed.handleUses && !trimmed.preparedActions && !trimmed.updateTokens) return;
      await withTraceRoot(tracer, "server.link_card.sweep_tick", { surface: "server", kind: "internal" }, async () => {
        recordTraceEvent("server.link_card.sweep", {
          deadline_due: deadlines.due, failed_not_sent: deadlines.failedNotSent, unknown: deadlines.unknown, skipped: deadlines.skipped, views_deleted: views,
          needs_reconciliation: reconciled, handle_uses_deleted: trimmed.handleUses, prepared_deleted: trimmed.preparedActions, update_tokens_deleted: trimmed.updateTokens,
        }, tracer);
      });
    } catch (error) {
      console.error("[LinkCardSweep] sweep failed", error instanceof Error ? error.name : "unknown");
    } finally {
      running = false;
    }
  };

  const handle = setClockInterval(() => void tick(), opts.intervalMs ?? 60_000);
  if (typeof handle === "object" && handle && "unref" in handle && typeof handle.unref === "function") handle.unref();
  return { tick, stop() { stopped = true; clearClockInterval(handle); } };
}
