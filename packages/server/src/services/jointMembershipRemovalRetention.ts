import { sql } from "drizzle-orm";
import { currentDate } from "@botiverse/raft-shared";
import { getDb } from "../db/index";
import { jointMembershipDepartures, jointMembershipRemovals } from "../db/schema";
import { recordTraceEvent } from "../tracing/semanticTrace";

/**
 * A joint disconnect's per-person rows (joint_membership_removals) record who
 * it removed. Once its cleanup finished (the row's and its departure's
 * completed_at) a row is history only, kept this many days after the
 * departure completed, then deleted. A row of an unfinished departure is a
 * live denial and is never deleted, however old.
 */
export const JOINT_MEMBERSHIP_REMOVAL_RETENTION_DAYS = 90;
export const JOINT_MEMBERSHIP_REMOVAL_RETENTION_BATCH_SIZE = 500;
/** One hourly tick stops starting batches after this long. */
export const JOINT_MEMBERSHIP_REMOVAL_RETENTION_BUDGET_MS = 20_000;
/** Pause between batches. */
export const JOINT_MEMBERSHIP_REMOVAL_RETENTION_PAUSE_MS = 100;

export type JointMembershipRemovalRetentionResult = {
  deleted: number;
  batches: number;
  durationMs: number;
  yielded: boolean;
};

/**
 * The hourly maintenance (server.ts, `prune_completed_joint_membership_removals`):
 * delete removal rows whose departure completed over the retention window ago
 * (a row completes no later than its departure), oldest first, in small
 * batches (by the locked rows' ctid) until none is left or the time budget
 * runs out. No index serves completed_at: the table holds only the window's
 * disconnect history, read in full once a batch.
 *
 * Maintenance runs on every replica at once; each batch takes a transaction
 * advisory lock first, and a replica that finds it held stops (`yielded`), so
 * one replica deletes at a time.
 */
export async function pruneCompletedJointMembershipRemovals(opts: {
  now?: Date;
  batchSize?: number;
  budgetMs?: number;
  pauseMs?: number;
} = {}): Promise<JointMembershipRemovalRetentionResult> {
  const now = opts.now ?? currentDate();
  const cutoff = new Date(now.getTime() - JOINT_MEMBERSHIP_REMOVAL_RETENTION_DAYS * 24 * 60 * 60 * 1000);
  const batchSize = opts.batchSize ?? JOINT_MEMBERSHIP_REMOVAL_RETENTION_BATCH_SIZE;
  const budgetMs = opts.budgetMs ?? JOINT_MEMBERSHIP_REMOVAL_RETENTION_BUDGET_MS;
  const pauseMs = opts.pauseMs ?? JOINT_MEMBERSHIP_REMOVAL_RETENTION_PAUSE_MS;
  const startedAt = Date.now();
  let deleted = 0;
  let batches = 0;
  let yielded = false;
  try {
    for (;;) {
      const ids = await getDb().transaction(async (tx) => {
        const lock = await tx.execute<{ locked: boolean }>(
          sql`SELECT pg_catalog.pg_try_advisory_xact_lock(pg_catalog.hashtext('joint_membership_removals.retention')) AS locked`,
        );
        if (!lock.rows[0]?.locked) return null;
        const result = await tx.execute<{ id: string }>(sql`
          DELETE FROM ${jointMembershipRemovals}
          WHERE ctid = ANY(ARRAY(
            SELECT removal.ctid FROM ${jointMembershipRemovals} removal
            JOIN ${jointMembershipDepartures} departure ON departure.id = removal.departure_id
            WHERE removal.completed_at IS NOT NULL
              AND removal.completed_at < ${cutoff}
              AND departure.completed_at IS NOT NULL
              AND departure.completed_at < ${cutoff}
            ORDER BY removal.completed_at
            LIMIT ${batchSize}
            FOR UPDATE OF removal SKIP LOCKED))
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
    recordTraceEvent("joint_membership_removals.retention", {
      event_kind: "joint_membership_removals_retention",
      deleted,
      batches,
      yielded,
      duration_ms: Date.now() - startedAt,
    });
  }
  return { deleted, batches, durationMs: Date.now() - startedAt, yielded };
}
