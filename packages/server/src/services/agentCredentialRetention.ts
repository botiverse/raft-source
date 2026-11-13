import { sql, type SQL } from "drizzle-orm";
import { currentDate } from "@botiverse/raft-shared";
import { getDb } from "../db/index";
import { agentCredentials, agentRuntimeProvisions } from "../db/schema";
import { recordTraceEvent } from "../tracing/semanticTrace";

/**
 * Every managed runner launch mints an agent credential (`issued_via =
 * 'computer'`) and revokes it when the launch ends; nothing else ever removes
 * the row, so revoked runner keys were most of agent_credentials (~3.8M of ~5M
 * rows on production, 2026-11-05). A revoked key authenticates nothing; after
 * this many days it is deleted. Other origins (human, app, provision) keep
 * their revoked rows.
 *
 * A renewed runner key is not revoked: its `expires_at` is pulled in to a few
 * minutes out, and auth refuses it from then on. One such row is left per
 * agent per renewal; it is deleted this many days after it expired.
 */
export const AGENT_CREDENTIAL_REVOKED_RETENTION_DAYS = 30;
export const AGENT_CREDENTIAL_RETENTION_BATCH_SIZE = 500;
/** One hourly tick stops starting batches after this long. */
export const AGENT_CREDENTIAL_RETENTION_BUDGET_MS = 20_000;
/** Pause between batches, so auth writes to the table interleave. */
export const AGENT_CREDENTIAL_RETENTION_PAUSE_MS = 100;

export type AgentCredentialRetentionResult = {
  /** Runner keys revoked over the retention window. */
  deleted: number;
  /** Runner keys never revoked whose `expires_at` passed over the retention window ago. */
  deletedExpired: number;
  batches: number;
  durationMs: number;
  yielded: boolean;
};

type RetentionRule = "revoked" | "expired";

/**
 * One batch of a rule's rows, oldest first through its partial index. Each
 * rule's WHERE carries its index's predicate in full, so it can only match
 * runner keys (`issued_via = 'computer'`): revoked ones, or unrevoked ones
 * with a non-NULL `expires_at` before the cutoff (auth refuses any key past
 * its `expires_at`). A row a runtime provision names is left.
 */
function batchSelect(rule: RetentionRule, cutoff: Date, batchSize: number): SQL {
  const unreferenced = sql`NOT EXISTS (
    SELECT 1 FROM ${agentRuntimeProvisions} provision WHERE provision.credential_id = credential.id
  )`;
  if (rule === "revoked") {
    return sql`
      SELECT credential.ctid FROM ${agentCredentials} credential
      WHERE credential.revoked_at IS NOT NULL
        AND credential.issued_via = 'computer'
        AND credential.revoked_at <= ${cutoff}
        AND ${unreferenced}
      ORDER BY credential.revoked_at
      LIMIT ${batchSize}
      FOR UPDATE SKIP LOCKED`;
  }
  return sql`
    SELECT credential.ctid FROM ${agentCredentials} credential
    WHERE credential.expires_at IS NOT NULL
      AND credential.revoked_at IS NULL
      AND credential.issued_via = 'computer'
      AND credential.expires_at < ${cutoff}
      AND ${unreferenced}
    ORDER BY credential.expires_at
    LIMIT ${batchSize}
    FOR UPDATE SKIP LOCKED`;
}

/**
 * Delete runner credentials over the retention window, in small batches (by
 * the locked rows' ctid: no second lookup through the random-uuid primary key)
 * until both rules run out or the time budget does. Two rules, taking turns
 * batch by batch so neither backlog starves the other:
 * - revoked over the window ago, oldest first through
 *   idx_agent_credentials_revoked_computer (`deleted`);
 * - never revoked and expired over the window ago, oldest first through
 *   idx_agent_credentials_expired_computer (`deletedExpired`). A NULL
 *   `expires_at` never expires and is never matched.
 * One a runtime provision still names is left (agent_runtime_provisions.credential_id).
 * A key's agent_inbox_push_registrations go with it (ON DELETE CASCADE).
 * `replaced_by_credential_id` has no foreign key; a dangling one is only
 * read by a renewal of that (already expired) key, which is refused anyway.
 *
 * Maintenance runs on every replica at once; each batch takes a transaction
 * advisory lock first, and a replica that finds it held stops (`yielded`), so
 * one replica deletes at a time.
 */
export async function pruneRevokedRunnerAgentCredentials(opts: {
  now?: Date;
  batchSize?: number;
  budgetMs?: number;
  pauseMs?: number;
} = {}): Promise<AgentCredentialRetentionResult> {
  const now = opts.now ?? currentDate();
  const cutoff = new Date(now.getTime() - AGENT_CREDENTIAL_REVOKED_RETENTION_DAYS * 24 * 60 * 60 * 1000);
  const batchSize = opts.batchSize ?? AGENT_CREDENTIAL_RETENTION_BATCH_SIZE;
  const budgetMs = opts.budgetMs ?? AGENT_CREDENTIAL_RETENTION_BUDGET_MS;
  const pauseMs = opts.pauseMs ?? AGENT_CREDENTIAL_RETENTION_PAUSE_MS;
  const startedAt = Date.now();
  const deletedBy: Record<RetentionRule, number> = { revoked: 0, expired: 0 };
  const pending: RetentionRule[] = ["revoked", "expired"];
  let turn = 0;
  let batches = 0;
  let yielded = false;
  try {
    while (pending.length > 0) {
      const rule = pending[turn % pending.length]!;
      const ids = await getDb().transaction(async (tx) => {
        const lock = await tx.execute<{ locked: boolean }>(
          sql`SELECT pg_try_advisory_xact_lock(hashtext('agent_credentials.retention')) AS locked`,
        );
        if (!lock.rows[0]?.locked) return null;
        const result = await tx.execute<{ id: string }>(sql`
        DELETE FROM ${agentCredentials}
        WHERE ctid = ANY(ARRAY(${batchSelect(rule, cutoff, batchSize)}))
        RETURNING id`);
        return result.rows;
      });
      if (!ids) {
        yielded = true;
        break;
      }
      batches += 1;
      deletedBy[rule] += ids.length;
      if (ids.length < batchSize) pending.splice(pending.indexOf(rule), 1);
      else turn += 1;
      if (pending.length === 0 || Date.now() - startedAt >= budgetMs) break;
      if (pauseMs > 0) await new Promise((resolve) => setTimeout(resolve, pauseMs));
    }
  } finally {
    recordTraceEvent("agent_credentials.retention", {
      event_kind: "agent_credentials_retention",
      deleted: deletedBy.revoked,
      deleted_expired: deletedBy.expired,
      batches,
      yielded,
      duration_ms: Date.now() - startedAt,
    });
  }
  return { deleted: deletedBy.revoked, deletedExpired: deletedBy.expired, batches, durationMs: Date.now() - startedAt, yielded };
}
