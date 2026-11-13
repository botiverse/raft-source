import { eq, sql } from "drizzle-orm";
import type { Database, DatabaseExecutor, DatabaseTransaction } from "../db/index";
import { slackVerifiedIngressRollout } from "../db/schema";
import { SLACK_BOT_WAKE_INDEX } from "./slackBotWakeIndexContract";
import { SLACK_INBOUND_HEAD_INDEX } from "./slackVerifiedIngressIndexContract";
import { SLACK_INGRESS_POLICY_FENCE_BODY, SLACK_INGRESS_ROW_FENCE_BODY,
  SLACK_INGRESS_TRUNCATE_FENCE_BODY } from "./slackVerifiedIngressRolloutSql";
import { SLACK_VERIFIED_INGRESS_FENCE_KEY, SLACK_VERIFIED_INGRESS_PROTOCOL, SLACK_VERIFIED_INGRESS_BASE_PROTOCOL,
  SlackIngressRolloutUnavailable, type SlackIngressReleaseRecord,
  type SlackIngressRolloutMode } from "./slackVerifiedIngressRolloutContracts";

type Rollout = typeof slackVerifiedIngressRollout.$inferSelect;

async function readPolicy(executor: DatabaseExecutor, lock: boolean): Promise<Rollout> {
  const query = executor.select().from(slackVerifiedIngressRollout)
    .where(eq(slackVerifiedIngressRollout.id, 1)).limit(1);
  const [state] = lock ? await query.for("share") : await query;
  if (!state) throw new SlackIngressRolloutUnavailable("fence_missing");
  if (state.minimumWriterProtocol > SLACK_VERIFIED_INGRESS_PROTOCOL) {
    throw new SlackIngressRolloutUnavailable("unsupported_protocol");
  }
  return state;
}

function mode(state: Rollout): SlackIngressRolloutMode {
  return state.minimumWriterProtocol === 0 ? "legacy"
    : state.consumersEnabled ? "verified_active" : "verified_paused";
}

const EXPECTED_TRIGGERS = [
  ["external_inbound_events", "slack_ingress_normalized_writer_fence", 31, "slack_ingress_writer_fence_v1", SLACK_INGRESS_ROW_FENCE_BODY],
  ["slack_verified_ingress_events", "slack_ingress_raw_writer_fence", 31, "slack_ingress_writer_fence_v1", SLACK_INGRESS_ROW_FENCE_BODY],
  ["slack_verified_ingress_rollout", "slack_ingress_policy_floor_fence", 27, "slack_ingress_policy_fence_v1", SLACK_INGRESS_POLICY_FENCE_BODY],
  ["slack_verified_ingress_rollout", "slack_ingress_policy_truncate_fence", 34, "slack_ingress_policy_fence_v1", SLACK_INGRESS_POLICY_FENCE_BODY],
  ["external_inbound_events", "slack_ingress_normalized_truncate_fence", 34, "slack_ingress_truncate_fence_v1", SLACK_INGRESS_TRUNCATE_FENCE_BODY],
  ["slack_verified_ingress_events", "slack_ingress_raw_truncate_fence", 34, "slack_ingress_truncate_fence_v1", SLACK_INGRESS_TRUNCATE_FENCE_BODY],
] as const;

/** Check the actual enforced trigger, event mask, relation and function body. A name alone proves nothing. */
export async function assertSlackIngressFenceInstalled(executor: DatabaseExecutor): Promise<void> {
  const result = await executor.execute<{
    tableName: string; triggerName: string; eventMask: number; enabled: string; functionName: string; body: string;
  }>(sql`SELECT c.relname AS "tableName", t.tgname AS "triggerName", t.tgtype AS "eventMask",
    t.tgenabled AS enabled, p.proname AS "functionName", p.prosrc AS body
    FROM pg_trigger t JOIN pg_class c ON c.oid = t.tgrelid
    JOIN pg_namespace n ON n.oid = c.relnamespace
    JOIN pg_proc p ON p.oid = t.tgfoid JOIN pg_namespace pn ON pn.oid = p.pronamespace
    WHERE n.nspname = 'public' AND pn.nspname = 'public' AND NOT t.tgisinternal
      AND c.relname IN ('external_inbound_events', 'slack_verified_ingress_events', 'slack_verified_ingress_rollout')`);
  for (const [table, name, mask, functionName, body] of EXPECTED_TRIGGERS) {
    const matching = result.rows.filter(row => row.tableName === table && row.triggerName === name
      && row.eventMask === mask && (row.enabled === "O" || row.enabled === "A")
      && row.functionName === functionName && row.body.trim() === body.trim());
    if (matching.length !== 1) throw new SlackIngressRolloutUnavailable("fence_missing");
  }
}

async function assertSlackIngressIndex(executor: DatabaseExecutor, expected: typeof SLACK_INBOUND_HEAD_INDEX): Promise<void> {
  const result = await executor.execute<{
    isUnique: boolean; isValid: boolean; isReady: boolean; plainBtree: boolean; keyCount: number;
    columns: string[]; predicate: string | null;
  }>(sql`SELECT i.indisunique AS "isUnique", i.indisvalid AS "isValid", i.indisready AS "isReady",
      (i.indexprs IS NULL AND am.amname = 'btree') AS "plainBtree", i.indnkeyatts AS "keyCount",
      array_agg(a.attname::text ORDER BY k.ordinality) AS columns,
      pg_get_expr(i.indpred, i.indrelid) AS predicate
    FROM pg_class idx JOIN pg_namespace n ON n.oid = idx.relnamespace
    JOIN pg_am am ON am.oid = idx.relam
    JOIN pg_index i ON i.indexrelid = idx.oid JOIN pg_class tbl ON tbl.oid = i.indrelid
    JOIN LATERAL unnest(i.indkey) WITH ORDINALITY AS k(attnum, ordinality) ON true
    JOIN pg_attribute a ON a.attrelid = tbl.oid AND a.attnum = k.attnum
    WHERE n.nspname = 'public' AND tbl.relname = ${expected.table}
      AND idx.relname = ${expected.name}
    GROUP BY i.indisunique, i.indisvalid, i.indisready, i.indpred, i.indrelid, (i.indexprs IS NULL), am.amname, i.indnkeyatts`);
  const row = result.rows[0];
  if (result.rows.length !== 1 || !row || row.isUnique !== expected.unique
    || row.isValid !== true || row.isReady !== true || row.plainBtree !== true
    || row.keyCount !== expected.columns.length || !Array.isArray(row.columns)
    || row.columns.join("\0") !== expected.columns.join("\0")
    || row.predicate !== expected.predicate) {
    throw new SlackIngressRolloutUnavailable("index_not_ready");
  }
}

export async function assertSlackIngressIndexReady(executor: DatabaseExecutor): Promise<void> {
  return assertSlackIngressIndex(executor, SLACK_INBOUND_HEAD_INDEX);
}

export async function assertSlackBotWakeIndexReady(executor: DatabaseExecutor): Promise<void> {
  return assertSlackIngressIndex(executor, SLACK_BOT_WAKE_INDEX);
}

/** Actual DB state, never an environment assertion that old HTTP instances have drained. */
export async function readSlackIngressRollout(db: Database): Promise<{ mode: SlackIngressRolloutMode; generation: number }> {
  const state = await readPolicy(db, false);
  if (state.minimumWriterProtocol > 0) await assertSlackIngressFenceInstalled(db);
  return { mode: mode(state), generation: state.generation };
}

/**
 * Optimistic admission cutover: no connection or shared lock is held across
 * verification, crypto or legacy work. Legacy writes racing activation are
 * rejected by the DB triggers; even a legacy discard must finish before a
 * final read still observes protocol zero. Otherwise Slack must retry through
 * durable custody. The sticky floor prevents an ABA transition back to legacy.
 * Holding a separate fence connection here would exhaust small pools and can
 * deadlock a nested receive against a queued exclusive operator lock.
 */
export async function withSlackIngressAdmissionFence<T>(input: {
  fenceDb: Database; run: (mode: SlackIngressRolloutMode) => Promise<T>;
}): Promise<T> {
  const initial = await readSlackIngressRollout(input.fenceDb);
  const result = await input.run(initial.mode);
  if (initial.mode === "legacy" && (await readSlackIngressRollout(input.fenceDb)).mode !== "legacy") {
    throw new SlackIngressRolloutUnavailable("admission_changed");
  }
  return result;
}

/** Every durable mutation declares its protocol transaction-locally, before domain locks. */
export async function withSlackIngressProtocol<T>(input: {
  db: Database; purpose: "receive" | "claim" | "settle";
  run: (tx: DatabaseTransaction) => Promise<T>;
}): Promise<T> {
  return input.db.transaction(async tx => {
    await tx.execute(sql`SELECT pg_advisory_xact_lock_shared(${SLACK_VERIFIED_INGRESS_FENCE_KEY.toString()}::bigint)`);
    const state = await readPolicy(tx, true);
    if (state.minimumWriterProtocol === 0) throw new SlackIngressRolloutUnavailable("not_enabled");
    if (input.purpose === "claim" && !state.consumersEnabled) throw new SlackIngressRolloutUnavailable("paused");
    await assertSlackIngressFenceInstalled(tx);
    if (input.purpose === "claim") await assertSlackIngressIndexReady(tx);
    await tx.execute(sql`SELECT set_config('raft.slack_ingress_protocol', ${String(state.minimumWriterProtocol)}, true)`);
    return input.run(tx);
  });
}

/** Human-only operator entry point. The release record is evidence to review, not automatic fleet detection. */
export async function setSlackIngressConsumption(input: {
  db: Database; enabled: boolean; expectedGeneration: number; releaseRecord?: SlackIngressReleaseRecord; now: Date;
}): Promise<{ mode: SlackIngressRolloutMode; generation: number }> {
  if (!Number.isSafeInteger(input.expectedGeneration) || input.expectedGeneration <= 0 || !Number.isFinite(input.now.getTime())) {
    throw new Error("Invalid Slack ingress rollout operation");
  }
  return input.db.transaction(async tx => {
    await tx.execute(sql`SELECT set_config('lock_timeout', '1s', true)`);
    await tx.execute(sql`SELECT set_config('statement_timeout', '5s', true)`);
    await tx.execute(sql`SELECT pg_advisory_xact_lock(${SLACK_VERIFIED_INGRESS_FENCE_KEY.toString()}::bigint)`);
    // Old writers do not hold the advisory fence. Drain their real table locks
    // before locking/updating policy, so they cannot cycle against this change.
    await tx.execute(sql`LOCK TABLE external_inbound_events, slack_verified_ingress_events IN ACCESS EXCLUSIVE MODE`);
    const [state] = await tx.select().from(slackVerifiedIngressRollout)
      .where(eq(slackVerifiedIngressRollout.id, 1)).limit(1).for("update");
    if (!state || state.generation !== input.expectedGeneration) throw new Error("Slack ingress rollout changed; read it again");
    if (state.minimumWriterProtocol > SLACK_VERIFIED_INGRESS_PROTOCOL) {
      throw new SlackIngressRolloutUnavailable("unsupported_protocol");
    }
    await assertSlackIngressFenceInstalled(tx);
    if (input.enabled) {
      if (!input.releaseRecord) throw new Error("Human verification of the full-fleet release record is required");
      await assertSlackIngressIndexReady(tx);
    }
    const [next] = await tx.update(slackVerifiedIngressRollout).set({
      minimumWriterProtocol: input.enabled ? Math.max(SLACK_VERIFIED_INGRESS_BASE_PROTOCOL, state.minimumWriterProtocol) : state.minimumWriterProtocol,
      consumersEnabled: input.enabled, generation: state.generation + 1,
      releaseRecord: input.releaseRecord ?? state.releaseRecord, updatedAt: input.now,
    }).where(eq(slackVerifiedIngressRollout.id, 1)).returning();
    if (!next) throw new Error("Slack ingress rollout was not persisted");
    return { mode: mode(next), generation: next.generation };
  });
}
