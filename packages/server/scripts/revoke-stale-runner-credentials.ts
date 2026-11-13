#!/usr/bin/env -S node --import=@oxc-node/core/register
/**
 * One-time cleanup: revoke Computer runner credentials (`sk_agent_*` minted
 * per runner launch) that no process can still hold.
 *
 * A daemon mints a credential for every runner launch
 * (POST /internal/computer/runners/:agentId/credentials, name
 * `runner:<runtime>:<first 8 of agent id>`) and keeps the raw key only in its
 * own memory; it revokes it (`managed_runner_launch_ended`) when the launch
 * ends. A crash, kill or lost DELETE skips that, so these rows pile up, still
 * live, on a long-running deployment. They are not reachable by anyone without
 * the raw key, but each is a valid bearer secret and a row in the partial
 * index every agent-authenticated request reads.
 *
 * Revoked (`revoked_reason = 'runner_credential_stale'`, revoked_by_user_id
 * NULL, no revocation broadcast) is a credential (alias `c`) that is
 *   - a runner credential: `issued_via = 'computer'`, name `runner:*`, live,
 *     no person recorded (`created_by_user_id IS NULL`), and not a cloud
 *     runtime's credential (`agent_runtime_provisions.credential_id`);
 *   - stale: `coalesce(last_used_at, created_at)` older than --days (default
 *     30, minimum 7; last_used_at is written at most once a minute per key
 *     while it is used, so a running runner is never stale);
 *   - and not on a live Machine: its agent is deleted (or gone), has no
 *     Machine (`agents.daemon_id` NULL), or that Machine's
 *     `daemons.last_heartbeat` is NULL or older than --heartbeat-hours
 *     (default 24).
 * Every credential of a non-deleted agent whose Machine heartbeated within the
 * window is deferred, whatever `agents.status` says and whichever of its
 * credentials is newest: a running process may hold an OLDER key (a rebind
 * keeps the launch's key and discards the one it minted), and `inactive` does
 * not prove that no process holds one. The daemon's reconcile on reconnect
 * clears those later. The whole rule is re-evaluated inside every UPDATE, so a
 * use, or a Machine coming back, between the dry-run and the apply (or during
 * the walk) is respected.
 *
 * Size: agent_credentials can hold millions of rows and has no index on
 * issued_via, name or last_used_at. Like the issued_via backfill, the script
 * walks the primary key once in fixed slices (`id > <last> ORDER BY id LIMIT
 * --batch`) and applies the rule within each slice, one short transaction per
 * slice (lock_timeout 2s, statement_timeout 30s, bounded retry). The
 * live-Machine check is a primary-key lookup on agents and daemons, done only
 * for stale candidates. Idempotent: a revoked credential no longer matches.
 *
 * Usage (defaults to dry-run: the same walk, read-only, counting, no writes):
 *   RUNNER_CREDENTIALS_READ_DATABASE_URL=... pnpm --filter @botiverse/raft-server ops:revoke-stale-runner-credentials -- \
 *     --environment production [--dry-run] [--days 30] [--heartbeat-hours 24]
 *   RUNNER_CREDENTIALS_WRITE_DATABASE_URL=... pnpm --filter @botiverse/raft-server ops:revoke-stale-runner-credentials -- \
 *     --environment production --apply --approval-reference <Raft message link> --run-id <id> --sleep-ms 100 \
 *     [--batch 1000] [--start-after <credential id>] [--max-batches N] [--progress-every 100]
 * No DATABASE_URL fallback: dry-run reads the READ url, --apply the WRITE url.
 * In production a dry-run refuses a primary (pg_is_in_recovery() must be true)
 * and --apply refuses a replica. Flags never grant production authority; the
 * runbook (docs/operations/stale-runner-credentials.md) says who approves.
 *
 * Output: [STALE_RUNNER_CREDENTIALS_START]; with --apply one
 * [STALE_RUNNER_CREDENTIALS_RECEIPT] per slice (revoked count and id range);
 * [STALE_RUNNER_CREDENTIALS_PROGRESS] periodically; at the end
 * [STALE_RUNNER_CREDENTIALS_DONE] or [STALE_RUNNER_CREDENTIALS_STOPPED] and
 * [STALE_RUNNER_CREDENTIALS_RESUME] --start-after <id>; and
 * [STALE_RUNNER_CREDENTIALS_SUMMARY] (JSON). Ctrl-C stops after the current
 * slice (exit 130).
 *
 * --mode deleted-agents (the default is --mode runner-stale, all of the above):
 * revokes every live credential, of any issued_via (computer, human, app,
 * provision, unknown, NULL), whose agent is deleted (`agents.deleted_at` set)
 * or missing, and the same agents' unused bootstrap tokens (`target_agent_id`,
 * `revoked_at` and `consumed_at` NULL). `revoked_reason = 'agent_deleted'`,
 * revoked_by_user_id NULL, no broadcast. Agents deleted before #9618
 * (2026-10-13, archive-on-delete revokes both) kept them; authentication
 * already refuses them through the `deleted_at` join, after verifying the key.
 * It walks agent_credentials, then agent_bootstrap_tokens, by primary key with
 * the same slices, timeouts, retry, guards, flags and receipts; --start-after
 * is an id of the --start-phase table (credentials | bootstrap-tokens), and
 * --max-batches counts both phases. --days / --heartbeat-hours are refused.
 * Every UPDATE re-checks the rule. Log tags are [DELETED_AGENT_CREDENTIALS_*]
 * with a `phase=` field; RESUME prints the whole resume flags. The summary
 * splits each phase by issued_via and by agents deleted before / on or after
 * DELETED_AGENT_SPLIT_AT (on or after = a delete path that does not revoke),
 * and lists up to MAX_LATE_AGENT_IDS of those agents.
 */
import "dotenv/config";
import { setTimeout as sleep } from "node:timers/promises";
import { pathToFileURL } from "node:url";
import pg from "pg";

/** The subset of pg.Client / PGlite this script uses. */
export interface Queryable {
  query<T>(text: string, params?: unknown[]): Promise<{ rows: T[] }>;
}

export const REVOKED_REASON = "runner_credential_stale";
export const MIN_DAYS = 7;

/** A live runner credential a Computer minted (alias given), not a cloud runtime's. */
export function runnerCandidate(alias: string): string {
  return `${alias}.issued_via = 'computer'
    AND ${alias}.name ~ '^runner:'
    AND ${alias}.revoked_at IS NULL
    AND ${alias}.created_by_user_id IS NULL
    AND NOT EXISTS (SELECT 1 FROM agent_runtime_provisions AS p WHERE p.credential_id = ${alias}.id)`;
}

export function stale(alias: string, days: number): string {
  assertWholeNumber(days, "days");
  return `coalesce(${alias}.last_used_at, ${alias}.created_at) < now() - make_interval(days => ${days})`;
}

/**
 * The agent is not deleted and its Machine heartbeated within the window: a
 * process there may hold any of its keys (deferred, never revoked). A missing
 * agent row, a NULL daemon_id or a NULL last_heartbeat all make this false.
 */
export function onLiveMachine(alias: string, heartbeatHours: number): string {
  assertWholeNumber(heartbeatHours, "heartbeatHours");
  return `EXISTS (
      SELECT 1 FROM agents AS a JOIN daemons AS d ON d.id = a.daemon_id
      WHERE a.id = ${alias}.agent_id AND a.deleted_at IS NULL
        AND d.last_heartbeat > now() - make_interval(hours => ${heartbeatHours})
    )`;
}

/** The full rule; the UPDATE re-checks all of it. */
export function revocable(alias: string, days: number, heartbeatHours: number): string {
  return `${runnerCandidate(alias)} AND ${stale(alias, days)} AND NOT ${onLiveMachine(alias, heartbeatHours)}`;
}

function assertWholeNumber(value: number, name: string): void {
  if (!Number.isInteger(value) || value < 1) throw new Error(`${name} must be a positive integer`);
}

export interface Options {
  batchSize: number;
  sleepMs: number;
  days: number;
  heartbeatHours: number;
  lockTimeout: string;
  statementTimeout: string;
  maxAttempts: number;
  write: boolean;
  runId: string | null;
  startAfter: string | null;
  maxBatches: number | null;
  progressEvery: number;
  shouldStop: () => boolean;
  log: (line: string) => void;
}

export const DEFAULT_OPTIONS: Options = {
  batchSize: 1000,
  sleepMs: 0,
  days: 30,
  heartbeatHours: 24,
  lockTimeout: "2s",
  statementTimeout: "30s",
  maxAttempts: 5,
  write: false,
  runId: null,
  startAfter: null,
  maxBatches: null,
  progressEvery: 100,
  shouldStop: () => false,
  log: (line) => console.log(line),
};

/** Counts over the credentials the rule revokes (dry-run: would revoke). */
export interface Counts {
  /** Live runner credentials (stale or not). */
  candidates: number;
  /** Of those, stale. */
  stale: number;
  /** Stale, but deferred: the agent is not deleted and its Machine is live. */
  deferredLiveMachine: number;
  /** stale - deferredLiveMachine, as classified. */
  toRevoke: number;
  /** Age (since last use, or creation if never used) of toRevoke: below 60 days, 60-120, 120 and more. */
  ageBelow60d: number;
  age60To120d: number;
  age120dPlus: number;
  neverUsed: number;
  used: number;
}

export interface SliceResult {
  lastId: string | null;
  scanned: number;
  counts: Counts;
  firstToRevokeId: string | null;
  lastToRevokeId: string | null;
  agentIds: string[];
  serverIds: string[];
  /** Agents / servers with a deferred credential in the slice. */
  deferredAgentIds: string[];
  deferredServerIds: string[];
  /** --apply only: what the UPDATE revoked after re-checking the rule. */
  revoked: number;
  firstRevokedId: string | null;
  lastRevokedId: string | null;
}

function zeroCounts(): Counts {
  return { candidates: 0, stale: 0, deferredLiveMachine: 0, toRevoke: 0, ageBelow60d: 0, age60To120d: 0, age120dPlus: 0, neverUsed: 0, used: 0 };
}

interface ClassifiedRow {
  candidates: number;
  stale: number;
  deferred_live_machine: number;
  to_revoke: number;
  age_below_60d: number;
  age_60_120d: number;
  age_120d_plus: number;
  never_used: number;
  first_id: string | null;
  last_id: string | null;
  agent_ids: string[];
  server_ids: string[];
  deferred_agent_ids: string[];
  deferred_server_ids: string[];
}

/** One id slice in its own transaction: fix (afterId, lastId], classify it, and with write revoke within it. */
export async function runSlice(
  db: Queryable,
  afterId: string | null,
  options: Pick<Options, "batchSize" | "days" | "heartbeatHours" | "lockTimeout" | "statementTimeout" | "write">,
): Promise<SliceResult> {
  await db.query(options.write ? "BEGIN" : "BEGIN READ ONLY");
  try {
    await db.query(
      `SELECT set_config('lock_timeout', $1, true), set_config('statement_timeout', $2, true), set_config('jit', 'off', true)`,
      [options.lockTimeout, options.statementTimeout],
    );
    const { rows: [bounds] } = await db.query<{ last_id: string | null; scanned: number }>(
      `WITH slice AS (
         SELECT id FROM agent_credentials ${afterId === null ? "" : "WHERE id > $2::uuid"} ORDER BY id LIMIT $1
       )
       SELECT (SELECT id::text FROM slice ORDER BY id DESC LIMIT 1) AS last_id, (SELECT count(*) FROM slice)::int AS scanned`,
      afterId === null ? [options.batchSize] : [options.batchSize, afterId],
    );
    const lastId = bounds?.last_id ?? null;
    if (lastId === null) {
      await db.query("COMMIT");
      return { lastId: null, scanned: 0, counts: zeroCounts(), firstToRevokeId: null, lastToRevokeId: null, agentIds: [], serverIds: [], deferredAgentIds: [], deferredServerIds: [], revoked: 0, firstRevokedId: null, lastRevokedId: null };
    }
    const range = afterId === null ? `c.id <= $1::uuid` : `c.id <= $1::uuid AND c.id > $2::uuid`;
    const params = afterId === null ? [lastId] : [lastId, afterId];
    // AND evaluates left to right, so the agent/Machine lookup runs only for stale candidates.
    const { rows: [row] } = await db.query<ClassifiedRow>(
      `WITH classified AS (
         SELECT c.id, c.agent_id, c.created_at, c.last_used_at, f.is_candidate, f.is_stale,
           f.is_stale AND ${onLiveMachine("c", options.heartbeatHours)} AS deferred
         FROM agent_credentials AS c
         CROSS JOIN LATERAL (
           SELECT ${runnerCandidate("c")} AS is_candidate,
             (${runnerCandidate("c")}) AND ${stale("c", options.days)} AS is_stale
         ) AS f
         WHERE ${range}
       ),
       revoke AS (
         SELECT k.*, now() - coalesce(k.last_used_at, k.created_at) AS age
         FROM classified AS k WHERE k.is_stale AND NOT k.deferred
       )
       SELECT
         (SELECT count(*) FROM classified WHERE is_candidate)::int AS candidates,
         (SELECT count(*) FROM classified WHERE is_stale)::int AS stale,
         (SELECT count(*) FROM classified WHERE deferred)::int AS deferred_live_machine,
         (SELECT count(*) FROM revoke)::int AS to_revoke,
         (SELECT count(*) FROM revoke WHERE age < interval '60 days')::int AS age_below_60d,
         (SELECT count(*) FROM revoke WHERE age >= interval '60 days' AND age < interval '120 days')::int AS age_60_120d,
         (SELECT count(*) FROM revoke WHERE age >= interval '120 days')::int AS age_120d_plus,
         (SELECT count(*) FROM revoke WHERE last_used_at IS NULL)::int AS never_used,
         (SELECT min(id::text) FROM revoke) AS first_id,
         (SELECT max(id::text) FROM revoke) AS last_id,
         (SELECT coalesce(array_agg(DISTINCT agent_id::text), '{}') FROM revoke) AS agent_ids,
         (SELECT coalesce(array_agg(DISTINCT a.server_id::text), '{}') FROM revoke JOIN agents AS a ON a.id = revoke.agent_id) AS server_ids,
         (SELECT coalesce(array_agg(DISTINCT agent_id::text), '{}') FROM classified WHERE deferred) AS deferred_agent_ids,
         (SELECT coalesce(array_agg(DISTINCT a.server_id::text), '{}') FROM classified AS k JOIN agents AS a ON a.id = k.agent_id WHERE k.deferred) AS deferred_server_ids`,
      params,
    );
    const counts: Counts = {
      candidates: row?.candidates ?? 0,
      stale: row?.stale ?? 0,
      deferredLiveMachine: row?.deferred_live_machine ?? 0,
      toRevoke: row?.to_revoke ?? 0,
      ageBelow60d: row?.age_below_60d ?? 0,
      age60To120d: row?.age_60_120d ?? 0,
      age120dPlus: row?.age_120d_plus ?? 0,
      neverUsed: row?.never_used ?? 0,
      used: (row?.to_revoke ?? 0) - (row?.never_used ?? 0),
    };
    let revoked = 0;
    let firstRevokedId: string | null = null;
    let lastRevokedId: string | null = null;
    if (options.write) {
      const { rows: [result] } = await db.query<{ n: number; first_id: string | null; last_id: string | null }>(
        `WITH revoked AS (
           UPDATE agent_credentials AS c
           SET revoked_at = now(), revoked_reason = '${REVOKED_REASON}', revoked_by_user_id = NULL
           WHERE ${range} AND ${revocable("c", options.days, options.heartbeatHours)}
           RETURNING c.id
         )
         SELECT count(*)::int AS n, min(id::text) AS first_id, max(id::text) AS last_id FROM revoked`,
        params,
      );
      revoked = result?.n ?? 0;
      firstRevokedId = result?.first_id ?? null;
      lastRevokedId = result?.last_id ?? null;
    }
    await db.query("COMMIT");
    return {
      lastId,
      scanned: bounds!.scanned,
      counts,
      firstToRevokeId: row?.first_id ?? null,
      lastToRevokeId: row?.last_id ?? null,
      agentIds: row?.agent_ids ?? [],
      serverIds: row?.server_ids ?? [],
      deferredAgentIds: row?.deferred_agent_ids ?? [],
      deferredServerIds: row?.deferred_server_ids ?? [],
      revoked,
      firstRevokedId,
      lastRevokedId,
    };
  } catch (error) {
    await db.query("ROLLBACK").catch(() => undefined);
    throw error;
  }
}

function isRetryable(error: unknown): boolean {
  const code = (error as { code?: string } | null)?.code;
  // lock_not_available, query_canceled (statement_timeout), deadlock, serialization (incl. replica recovery conflict)
  return code === "55P03" || code === "57014" || code === "40P01" || code === "40001";
}

/** What every mode's slice reports to the walk. */
interface WalkSlice {
  lastId: string | null;
  scanned: number;
}

/** One primary-key walk over one table; the mode supplies the slice and the totals. */
interface WalkSpec<S extends WalkSlice> {
  /** Log tag prefix, e.g. STALE_RUNNER_CREDENTIALS. */
  tag: string;
  /** Extra leading fields of the RETRY / RECEIPT / report lines (e.g. `phase=x `). */
  prefix?: string;
  slice(afterId: string | null): Promise<S>;
  /** Fold a slice into the mode's totals. */
  add(slice: S): void;
  /** --apply: the receipt fields after `slice_last=<id> `. */
  receipt(slice: S): string;
  /** The mode's counts in the report line, between `scanned=` and `last_id=`. */
  status(): string;
}

interface WalkState {
  completed: boolean;
  lastId: string | null;
  batches: number;
  scanned: number;
}

type WalkOptions = Pick<Options, "write" | "runId" | "startAfter" | "maxBatches" | "batchSize" | "sleepMs" | "progressEvery" | "maxAttempts" | "shouldStop" | "log">;

/**
 * Walks one table by primary key in fixed slices from `options.startAfter`: bounded
 * retry per slice, a receipt per slice with --apply, progress lines, and a stop
 * after the current slice on --max-batches or shouldStop. Prints the final
 * DONE / STOPPED line; the caller prints RESUME and SUMMARY.
 */
async function walk<S extends WalkSlice>(options: WalkOptions, spec: WalkSpec<S>): Promise<WalkState> {
  const started = Date.now();
  const prefix = spec.prefix ?? "";
  let afterId = options.startAfter;
  const state: WalkState = { completed: false, lastId: options.startAfter, batches: 0, scanned: 0 };
  const mode = options.write ? "apply" : "dry-run";
  const report = (tag: string) => options.log(`[${tag}] ${prefix}mode=${mode} batches=${state.batches} scanned=${state.scanned} `
    + `${spec.status()} last_id=${state.lastId ?? "-"} elapsed=${((Date.now() - started) / 1000).toFixed(1)}s`);
  for (;;) {
    if (options.maxBatches !== null && state.batches >= options.maxBatches) break;
    if (options.shouldStop()) break;
    let result: S | undefined;
    for (let attempt = 1; ; attempt++) {
      try {
        result = await spec.slice(afterId);
        break;
      } catch (error) {
        if (!isRetryable(error) || attempt >= options.maxAttempts) throw error;
        options.log(`[${spec.tag}_RETRY] ${prefix}after=${afterId ?? "-"} attempt=${attempt} reason=${(error as Error).message}`);
        // Backoff before retrying the same slice (lock or statement timeout).
        await sleep(Math.min(1000 * attempt, 5000));
      }
    }
    if (result.lastId === null) {
      state.completed = true;
      break;
    }
    state.batches += 1;
    state.scanned += result.scanned;
    spec.add(result);
    if (options.write) {
      options.log(`[${spec.tag}_RECEIPT] ${prefix}run_id=${options.runId} slice_after=${afterId ?? "-"} slice_last=${result.lastId} ${spec.receipt(result)}`);
    }
    afterId = state.lastId = result.lastId;
    if (state.batches % options.progressEvery === 0) report(`${spec.tag}_PROGRESS`);
    if (result.scanned < options.batchSize) {
      state.completed = true;
      break;
    }
    // Pacing between slices for replica lag and autovacuum (--sleep-ms).
    if (options.sleepMs > 0) await sleep(options.sleepMs);
  }
  report(state.completed ? `${spec.tag}_DONE` : `${spec.tag}_STOPPED`);
  return state;
}

export interface RunResult {
  completed: boolean;
  lastId: string | null;
  batches: number;
  scanned: number;
  counts: Counts;
  /** Distinct agents / servers of the credentials to revoke. */
  agents: number;
  servers: number;
  /** Distinct agents / servers of the deferred credentials. */
  deferredAgents: number;
  deferredServers: number;
  firstToRevokeId: string | null;
  lastToRevokeId: string | null;
  /** --apply only. */
  revoked: number;
  firstRevokedId: string | null;
  lastRevokedId: string | null;
}

const minId = (a: string | null, b: string | null) => (a === null ? b : b === null || a < b ? a : b);
const maxId = (a: string | null, b: string | null) => (a === null ? b : b === null || a > b ? a : b);

/** Walks agent_credentials by primary key in fixed slices from `startAfter`. */
export async function run(db: Queryable, options: Options = DEFAULT_OPTIONS): Promise<RunResult> {
  if (options.write && !options.runId) throw new Error("a write run needs a run id");
  let revoked = 0;
  const counts = zeroCounts();
  const agents = new Set<string>();
  const servers = new Set<string>();
  const deferredAgents = new Set<string>();
  const deferredServers = new Set<string>();
  let firstToRevokeId: string | null = null;
  let lastToRevokeId: string | null = null;
  let firstRevokedId: string | null = null;
  let lastRevokedId: string | null = null;
  const mode = options.write ? "apply" : "dry-run";
  const { completed, lastId, batches, scanned } = await walk<SliceResult>(options, {
    tag: "STALE_RUNNER_CREDENTIALS",
    slice: (afterId) => runSlice(db, afterId, options),
    add(result) {
      for (const key of Object.keys(counts) as (keyof Counts)[]) counts[key] += result.counts[key];
      for (const agentId of result.agentIds) agents.add(agentId);
      for (const serverId of result.serverIds) servers.add(serverId);
      for (const agentId of result.deferredAgentIds) deferredAgents.add(agentId);
      for (const serverId of result.deferredServerIds) deferredServers.add(serverId);
      firstToRevokeId = minId(firstToRevokeId, result.firstToRevokeId);
      lastToRevokeId = maxId(lastToRevokeId, result.lastToRevokeId);
      if (options.write) {
        revoked += result.revoked;
        firstRevokedId = minId(firstRevokedId, result.firstRevokedId);
        lastRevokedId = maxId(lastRevokedId, result.lastRevokedId);
      }
    },
    receipt: (result) => `revoked=${result.revoked} first_id=${result.firstRevokedId ?? "-"} last_id=${result.lastRevokedId ?? "-"}`,
    status: () => `candidates=${counts.candidates} stale=${counts.stale} deferred_live_machine=${counts.deferredLiveMachine} `
      + `deferred_agents=${deferredAgents.size} deferred_servers=${deferredServers.size} to_revoke=${counts.toRevoke}`
      + `${options.write ? ` revoked=${revoked}` : ""} agents=${agents.size} servers=${servers.size}`,
  });
  if (!completed && lastId !== null) options.log(`[STALE_RUNNER_CREDENTIALS_RESUME] --start-after ${lastId}`);
  const result: RunResult = {
    completed, lastId, batches, scanned, counts, agents: agents.size, servers: servers.size,
    deferredAgents: deferredAgents.size, deferredServers: deferredServers.size,
    firstToRevokeId, lastToRevokeId, revoked, firstRevokedId, lastRevokedId,
  };
  options.log(`[STALE_RUNNER_CREDENTIALS_SUMMARY] ${JSON.stringify({ mode, runId: options.runId, days: options.days, heartbeatHours: options.heartbeatHours, ...result })}`);
  return result;
}

// --mode deleted-agents ----------------------------------------------------

export const DELETED_AGENT_REVOKED_REASON = "agent_deleted";
/**
 * #9618 (archive-on-delete revokes credentials and unused bootstrap tokens)
 * merged 2026-10-13. A match deleted before this was left by the old delete; one
 * deleted on or after it points to a delete path that does not revoke (or to a
 * delete on the 13th before the deploy).
 */
export const DELETED_AGENT_SPLIT_AT = "2026-10-13T00:00:00Z";
export const DELETED_AGENT_PHASES = ["credentials", "bootstrap-tokens"] as const;
export type DeletedAgentPhase = typeof DELETED_AGENT_PHASES[number];
/** Agents deleted on or after the split listed in the summary (to trace their delete path), at most. */
export const MAX_LATE_AGENT_IDS = 50;

/** The agent row of `agentIdSql` is deleted or gone (true for a missing row). */
export function agentGone(agentIdSql: string): string {
  return `NOT EXISTS (SELECT 1 FROM agents AS a WHERE a.id = ${agentIdSql} AND a.deleted_at IS NULL)`;
}

/** A live credential (alias given), any issued_via, of a deleted or missing agent. */
export function deletedAgentCredential(alias: string): string {
  return `${alias}.revoked_at IS NULL AND ${agentGone(`${alias}.agent_id`)}`;
}

/** An unused, unrevoked bootstrap token (alias given) of a deleted or missing agent. */
export function deletedAgentBootstrapToken(alias: string): string {
  return `${alias}.revoked_at IS NULL AND ${alias}.consumed_at IS NULL AND ${agentGone(`${alias}.target_agent_id`)}`;
}

export interface DeletedAgentCounts {
  toRevoke: number;
  /** Of toRevoke: agent deleted before DELETED_AGENT_SPLIT_AT, on or after it, or no agent row. */
  deletedBefore: number;
  deletedOnOrAfter: number;
  agentMissing: number;
  /** Credentials: of toRevoke, used in the last 7 days (some client still presents it). */
  used7d: number;
  /** Bootstrap tokens: of toRevoke, already past their TTL (unusable anyway). */
  expired: number;
}

function zeroDeletedAgentCounts(): DeletedAgentCounts {
  return { toRevoke: 0, deletedBefore: 0, deletedOnOrAfter: 0, agentMissing: 0, used7d: 0, expired: 0 };
}

interface DeletedAgentSlice extends WalkSlice {
  counts: DeletedAgentCounts;
  /** issued_via -> count ("null" for a NULL issued_via); tokens: empty. */
  byIssuedVia: Record<string, number>;
  /** Same, only agents deleted on or after the split. */
  onOrAfterByIssuedVia: Record<string, number>;
  agentIds: string[];
  serverIds: string[];
  lateAgentIds: string[];
  firstToRevokeId: string | null;
  lastToRevokeId: string | null;
  revoked: number;
  firstRevokedId: string | null;
  lastRevokedId: string | null;
}

interface DeletedAgentRow {
  to_revoke: number;
  deleted_before: number;
  deleted_on_or_after: number;
  agent_missing: number;
  used_7d: number;
  expired: number;
  first_id: string | null;
  last_id: string | null;
  agent_ids: string[];
  server_ids: string[];
  late_agent_ids: string[];
  by_issued_via: Record<string, number> | null;
  on_or_after_by_issued_via: Record<string, number> | null;
}

const PHASE_TABLE = {
  credentials: { table: "agent_credentials", agentColumn: "agent_id", rule: deletedAgentCredential },
  "bootstrap-tokens": { table: "agent_bootstrap_tokens", agentColumn: "target_agent_id", rule: deletedAgentBootstrapToken },
} as const;

/** One id slice of one phase in its own transaction: classify it, and with write revoke within it. */
export async function runDeletedAgentSlice(
  db: Queryable,
  phase: DeletedAgentPhase,
  afterId: string | null,
  options: Pick<Options, "batchSize" | "lockTimeout" | "statementTimeout" | "write">,
): Promise<DeletedAgentSlice> {
  const { table, agentColumn, rule } = PHASE_TABLE[phase];
  await db.query(options.write ? "BEGIN" : "BEGIN READ ONLY");
  try {
    await db.query(
      `SELECT set_config('lock_timeout', $1, true), set_config('statement_timeout', $2, true), set_config('jit', 'off', true)`,
      [options.lockTimeout, options.statementTimeout],
    );
    const { rows: [bounds] } = await db.query<{ last_id: string | null; scanned: number }>(
      `WITH slice AS (
         SELECT id FROM ${table} ${afterId === null ? "" : "WHERE id > $2::uuid"} ORDER BY id LIMIT $1
       )
       SELECT (SELECT id::text FROM slice ORDER BY id DESC LIMIT 1) AS last_id, (SELECT count(*) FROM slice)::int AS scanned`,
      afterId === null ? [options.batchSize] : [options.batchSize, afterId],
    );
    const lastId = bounds?.last_id ?? null;
    const empty: DeletedAgentSlice = {
      lastId, scanned: bounds?.scanned ?? 0, counts: zeroDeletedAgentCounts(),
      byIssuedVia: {}, onOrAfterByIssuedVia: {}, agentIds: [], serverIds: [], lateAgentIds: [],
      firstToRevokeId: null, lastToRevokeId: null, revoked: 0, firstRevokedId: null, lastRevokedId: null,
    };
    if (lastId === null) {
      await db.query("COMMIT");
      return empty;
    }
    const range = afterId === null ? `t.id <= $1::uuid` : `t.id <= $1::uuid AND t.id > $2::uuid`;
    const params = afterId === null ? [lastId] : [lastId, afterId];
    const split = `timestamptz '${DELETED_AGENT_SPLIT_AT}'`;
    const issuedVia = phase === "credentials" ? "coalesce(t.issued_via, 'null')" : "NULL::text";
    const used = phase === "credentials" ? "t.last_used_at > now() - interval '7 days'" : "false";
    const expired = phase === "credentials" ? "false" : "t.ttl_expires_at < now()";
    // The agent lookup is a primary-key probe per live row of the slice.
    const { rows: [row] } = await db.query<DeletedAgentRow>(
      `WITH hit AS (
         SELECT t.id, t.${agentColumn} AS agent_id, ${issuedVia} AS issued_via, (${used}) AS used_7d, (${expired}) AS expired,
           a.server_id, a.deleted_at, a.id IS NULL AS missing
         FROM ${table} AS t
         LEFT JOIN agents AS a ON a.id = t.${agentColumn}
         WHERE ${range} AND ${rule("t")}
       )
       SELECT
         (SELECT count(*) FROM hit)::int AS to_revoke,
         (SELECT count(*) FROM hit WHERE deleted_at < ${split})::int AS deleted_before,
         (SELECT count(*) FROM hit WHERE deleted_at >= ${split})::int AS deleted_on_or_after,
         (SELECT count(*) FROM hit WHERE missing)::int AS agent_missing,
         (SELECT count(*) FROM hit WHERE used_7d)::int AS used_7d,
         (SELECT count(*) FROM hit WHERE expired)::int AS expired,
         (SELECT min(id::text) FROM hit) AS first_id,
         (SELECT max(id::text) FROM hit) AS last_id,
         (SELECT coalesce(array_agg(DISTINCT agent_id::text), '{}') FROM hit) AS agent_ids,
         (SELECT coalesce(array_agg(DISTINCT server_id::text), '{}') FROM hit WHERE server_id IS NOT NULL) AS server_ids,
         (SELECT coalesce(array_agg(DISTINCT agent_id::text), '{}') FROM hit WHERE deleted_at >= ${split}) AS late_agent_ids,
         (SELECT json_object_agg(issued_via, n) FROM (SELECT issued_via, count(*)::int AS n FROM hit WHERE issued_via IS NOT NULL GROUP BY 1) AS g) AS by_issued_via,
         (SELECT json_object_agg(issued_via, n) FROM (SELECT issued_via, count(*)::int AS n FROM hit WHERE issued_via IS NOT NULL AND deleted_at >= ${split} GROUP BY 1) AS g) AS on_or_after_by_issued_via`,
      params,
    );
    let revoked = 0;
    let firstRevokedId: string | null = null;
    let lastRevokedId: string | null = null;
    if (options.write) {
      const { rows: [result] } = await db.query<{ n: number; first_id: string | null; last_id: string | null }>(
        `WITH revoked AS (
           UPDATE ${table} AS t
           SET revoked_at = now(), revoked_reason = '${DELETED_AGENT_REVOKED_REASON}', revoked_by_user_id = NULL
           WHERE ${range} AND ${rule("t")}
           RETURNING t.id
         )
         SELECT count(*)::int AS n, min(id::text) AS first_id, max(id::text) AS last_id FROM revoked`,
        params,
      );
      revoked = result?.n ?? 0;
      firstRevokedId = result?.first_id ?? null;
      lastRevokedId = result?.last_id ?? null;
    }
    await db.query("COMMIT");
    return {
      ...empty,
      counts: {
        toRevoke: row?.to_revoke ?? 0,
        deletedBefore: row?.deleted_before ?? 0,
        deletedOnOrAfter: row?.deleted_on_or_after ?? 0,
        agentMissing: row?.agent_missing ?? 0,
        used7d: row?.used_7d ?? 0,
        expired: row?.expired ?? 0,
      },
      byIssuedVia: row?.by_issued_via ?? {},
      onOrAfterByIssuedVia: row?.on_or_after_by_issued_via ?? {},
      agentIds: row?.agent_ids ?? [],
      serverIds: row?.server_ids ?? [],
      lateAgentIds: row?.late_agent_ids ?? [],
      firstToRevokeId: row?.first_id ?? null,
      lastToRevokeId: row?.last_id ?? null,
      revoked,
      firstRevokedId,
      lastRevokedId,
    };
  } catch (error) {
    await db.query("ROLLBACK").catch(() => undefined);
    throw error;
  }
}

export interface DeletedAgentPhaseResult {
  completed: boolean;
  /** The phase did not run (an earlier phase stopped, or --start-phase skipped it). */
  skipped: boolean;
  lastId: string | null;
  batches: number;
  scanned: number;
  counts: DeletedAgentCounts;
  byIssuedVia: Record<string, number>;
  onOrAfterByIssuedVia: Record<string, number>;
  /** Distinct agents / servers of the rows to revoke. */
  agents: number;
  servers: number;
  /** Up to MAX_LATE_AGENT_IDS agents deleted on or after the split, and how many there are. */
  lateAgents: number;
  lateAgentIds: string[];
  firstToRevokeId: string | null;
  lastToRevokeId: string | null;
  /** --apply only. */
  revoked: number;
  firstRevokedId: string | null;
  lastRevokedId: string | null;
}

export interface DeletedAgentsResult {
  completed: boolean;
  credentials: DeletedAgentPhaseResult;
  bootstrapTokens: DeletedAgentPhaseResult;
}

export type DeletedAgentsOptions = Omit<Options, "days" | "heartbeatHours"> & { startPhase?: DeletedAgentPhase };

const addCount = (into: Record<string, number>, from: Record<string, number>) => {
  for (const [key, n] of Object.entries(from)) into[key] = (into[key] ?? 0) + n;
};
const formatCounts = (counts: Record<string, number>) => Object.keys(counts).sort().map((key) => `${key}:${counts[key]}`).join(",") || "-";

/**
 * --mode deleted-agents: walks agent_credentials, then agent_bootstrap_tokens,
 * by primary key, and revokes the live rows of deleted or missing agents.
 * --start-after applies to the start phase; --max-batches counts both phases.
 */
export async function runDeletedAgents(db: Queryable, options: DeletedAgentsOptions): Promise<DeletedAgentsResult> {
  if (options.write && !options.runId) throw new Error("a write run needs a run id");
  const tag = "DELETED_AGENT_CREDENTIALS";
  const startPhase = options.startPhase ?? "credentials";
  const mode = options.write ? "apply" : "dry-run";
  const phases = {} as Record<DeletedAgentPhase, DeletedAgentPhaseResult>;
  let batches = 0;
  let stopped: DeletedAgentPhase | null = null;
  for (const phase of DELETED_AGENT_PHASES) {
    const counts = zeroDeletedAgentCounts();
    const byIssuedVia: Record<string, number> = {};
    const onOrAfterByIssuedVia: Record<string, number> = {};
    const agents = new Set<string>();
    const servers = new Set<string>();
    const lateAgents = new Set<string>();
    let firstToRevokeId: string | null = null;
    let lastToRevokeId: string | null = null;
    let revoked = 0;
    let firstRevokedId: string | null = null;
    let lastRevokedId: string | null = null;
    const finish = (state: WalkState, skipped: boolean): DeletedAgentPhaseResult => ({
      ...state, skipped, counts, byIssuedVia, onOrAfterByIssuedVia, agents: agents.size, servers: servers.size,
      lateAgents: lateAgents.size, lateAgentIds: [...lateAgents].sort().slice(0, MAX_LATE_AGENT_IDS),
      firstToRevokeId, lastToRevokeId, revoked, firstRevokedId, lastRevokedId,
    });
    const skip = stopped !== null || DELETED_AGENT_PHASES.indexOf(phase) < DELETED_AGENT_PHASES.indexOf(startPhase);
    if (skip) {
      phases[phase] = finish({ completed: false, lastId: null, batches: 0, scanned: 0 }, true);
      continue;
    }
    const state = await walk<DeletedAgentSlice>({
      ...options,
      startAfter: phase === startPhase ? options.startAfter : null,
      maxBatches: options.maxBatches === null ? null : options.maxBatches - batches,
    }, {
      tag,
      prefix: `phase=${phase} `,
      slice: (afterId) => runDeletedAgentSlice(db, phase, afterId, options),
      add(result) {
        for (const key of Object.keys(counts) as (keyof DeletedAgentCounts)[]) counts[key] += result.counts[key];
        addCount(byIssuedVia, result.byIssuedVia);
        addCount(onOrAfterByIssuedVia, result.onOrAfterByIssuedVia);
        for (const agentId of result.agentIds) agents.add(agentId);
        for (const serverId of result.serverIds) servers.add(serverId);
        for (const agentId of result.lateAgentIds) lateAgents.add(agentId);
        firstToRevokeId = minId(firstToRevokeId, result.firstToRevokeId);
        lastToRevokeId = maxId(lastToRevokeId, result.lastToRevokeId);
        if (options.write) {
          revoked += result.revoked;
          firstRevokedId = minId(firstRevokedId, result.firstRevokedId);
          lastRevokedId = maxId(lastRevokedId, result.lastRevokedId);
        }
      },
      receipt: (result) => `revoked=${result.revoked} first_id=${result.firstRevokedId ?? "-"} last_id=${result.lastRevokedId ?? "-"}`,
      status: () => `to_revoke=${counts.toRevoke}${options.write ? ` revoked=${revoked}` : ""} `
        + `deleted_before=${counts.deletedBefore} deleted_on_or_after=${counts.deletedOnOrAfter} agent_missing=${counts.agentMissing} `
        + `${phase === "credentials" ? `used_7d=${counts.used7d}` : `expired=${counts.expired}`} agents=${agents.size} servers=${servers.size} `
        + `late_agents=${lateAgents.size}${phase === "credentials" ? ` issued_via=${formatCounts(byIssuedVia)}` : ""}`,
    });
    batches += state.batches;
    phases[phase] = finish(state, false);
    if (!state.completed) {
      stopped = phase;
      const position = state.lastId === null ? "" : ` --start-after ${state.lastId}`;
      options.log(`[${tag}_RESUME] --mode deleted-agents${phase === "credentials" ? "" : ` --start-phase ${phase}`}${position}`);
    }
  }
  const result: DeletedAgentsResult = {
    completed: stopped === null,
    credentials: phases.credentials,
    bootstrapTokens: phases["bootstrap-tokens"],
  };
  options.log(`[${tag}_SUMMARY] ${JSON.stringify({
    rule: "deleted-agents", mode, runId: options.runId, splitAt: DELETED_AGENT_SPLIT_AT, startPhase, ...result,
  })}`);
  return result;
}

export type Environment = "local" | "staging" | "production";

export const MODES = ["runner-stale", "deleted-agents"] as const;
export type Mode = typeof MODES[number];

export interface CliOptions {
  /** runner-stale (default): the stale runner rule. deleted-agents: every live credential and unused bootstrap token of a deleted agent. */
  mode: Mode;
  /** deleted-agents only: the phase to start (resume) in. */
  startPhase: DeletedAgentPhase;
  environment: Environment | null;
  apply: boolean;
  approvalReference: string | null;
  runId: string | null;
  batchSize: number;
  sleepMs: number;
  days: number;
  heartbeatHours: number;
  startAfter: string | null;
  maxBatches: number | null;
  progressEvery: number;
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export function parseArgs(argv: readonly string[]): CliOptions & { environment: Environment } {
  const seen = new Set<string>();
  const options: CliOptions = {
    mode: "runner-stale", startPhase: "credentials",
    environment: null, apply: false, approvalReference: null, runId: null, batchSize: 1000, sleepMs: 0,
    days: DEFAULT_OPTIONS.days, heartbeatHours: DEFAULT_OPTIONS.heartbeatHours, startAfter: null, maxBatches: null, progressEvery: 100,
  };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === "--") continue;
    else if (arg === "--mode") options.mode = (argv[++i] ?? "") as Mode;
    else if (arg === "--start-phase") {
      options.startPhase = (argv[++i] ?? "") as DeletedAgentPhase;
      seen.add("--start-phase");
    } else if (arg === "--environment") options.environment = (argv[++i] ?? "") as Environment;
    else if (arg === "--dry-run") options.apply = false;
    else if (arg === "--apply") options.apply = true;
    else if (arg === "--approval-reference") options.approvalReference = argv[++i] ?? "";
    else if (arg === "--run-id") options.runId = argv[++i] ?? "";
    else if (arg === "--batch") options.batchSize = Number(argv[++i]);
    else if (arg === "--sleep-ms") options.sleepMs = Number(argv[++i]);
    else if (arg === "--days") {
      options.days = Number(argv[++i]);
      seen.add("--days");
    } else if (arg === "--heartbeat-hours") {
      options.heartbeatHours = Number(argv[++i]);
      seen.add("--heartbeat-hours");
    }
    else if (arg === "--start-after") options.startAfter = argv[++i] ?? "";
    else if (arg === "--max-batches") options.maxBatches = Number(argv[++i]);
    else if (arg === "--progress-every") options.progressEvery = Number(argv[++i]);
    else throw new Error(`Unknown argument: ${arg}`);
  }
  const { environment } = options;
  if (!MODES.includes(options.mode)) throw new Error(`--mode must be ${MODES.join(" or ")}`);
  for (const flag of options.mode === "deleted-agents" ? ["--days", "--heartbeat-hours"] : ["--start-phase"]) {
    if (seen.has(flag)) throw new Error(`${flag} is only for --mode ${options.mode === "deleted-agents" ? "runner-stale" : "deleted-agents"}`);
  }
  if (!DELETED_AGENT_PHASES.includes(options.startPhase)) throw new Error(`--start-phase must be ${DELETED_AGENT_PHASES.join(" or ")}`);
  if (environment !== "local" && environment !== "staging" && environment !== "production") {
    throw new Error("--environment must be local, staging or production");
  }
  if (options.apply && !options.approvalReference?.trim()) throw new Error("--apply requires --approval-reference <the human approval message>");
  if (options.apply && !/^[A-Za-z0-9._:-]{1,100}$/.test(options.runId ?? "")) throw new Error("--apply requires --run-id <id> ([A-Za-z0-9._:-], at most 100)");
  if (!options.apply && (options.approvalReference !== null || options.runId !== null)) {
    throw new Error("--approval-reference and --run-id are only for --apply");
  }
  if (!Number.isInteger(options.batchSize) || options.batchSize < 1 || options.batchSize > 10_000) throw new Error("--batch must be 1..10000");
  if (!Number.isInteger(options.sleepMs) || options.sleepMs < 0 || options.sleepMs > 60_000) throw new Error("--sleep-ms must be 0..60000");
  if (!Number.isInteger(options.days) || options.days < MIN_DAYS || options.days > 3650) throw new Error(`--days must be ${MIN_DAYS}..3650`);
  if (!Number.isInteger(options.heartbeatHours) || options.heartbeatHours < 1 || options.heartbeatHours > 24 * 90) throw new Error("--heartbeat-hours must be 1..2160");
  if (options.startAfter !== null && !UUID.test(options.startAfter)) throw new Error("--start-after must be a credential id (uuid)");
  if (options.maxBatches !== null && (!Number.isInteger(options.maxBatches) || options.maxBatches < 1)) throw new Error("--max-batches must be a positive integer");
  if (!Number.isInteger(options.progressEvery) || options.progressEvery < 1) throw new Error("--progress-every must be a positive integer");
  return { ...options, environment };
}

/** Production dry-runs read a replica; production writes go to the primary. */
export function checkEndpoint(environment: Environment, apply: boolean, inRecovery: boolean): string | null {
  if (environment !== "production") return null;
  if (!apply && !inRecovery) return "a production dry-run reads a replica: RUNNER_CREDENTIALS_READ_DATABASE_URL is a primary";
  if (apply && inRecovery) return "--apply writes to the primary: RUNNER_CREDENTIALS_WRITE_DATABASE_URL is a replica";
  return null;
}

async function main(): Promise<void> {
  const options = parseArgs(process.argv.slice(2));
  const deletedAgents = options.mode === "deleted-agents";
  const tag = deletedAgents ? "DELETED_AGENT_CREDENTIALS" : "STALE_RUNNER_CREDENTIALS";
  const variable = options.apply ? "RUNNER_CREDENTIALS_WRITE_DATABASE_URL" : "RUNNER_CREDENTIALS_READ_DATABASE_URL";
  const connectionString = process.env[variable];
  if (!connectionString) throw new Error(`${variable} is required (no DATABASE_URL fallback)`);
  const client = new pg.Client({ connectionString });
  await client.connect();
  let stopRequested = false;
  const onSignal = (signal: string) => {
    stopRequested = true;
    console.log(`[${tag}_STOPPING] ${signal}: stopping after the current batch`);
  };
  process.once("SIGINT", () => onSignal("SIGINT"));
  process.once("SIGTERM", () => onSignal("SIGTERM"));
  try {
    const { rows: [endpoint] } = await client.query<{ replica: boolean; replay_at: Date | null }>(
      `SELECT pg_is_in_recovery() AS replica, pg_last_xact_replay_timestamp() AS replay_at`,
    );
    const refusal = checkEndpoint(options.environment, options.apply, endpoint?.replica === true);
    if (refusal) throw new Error(refusal);
    console.log(`[${tag}_START] ${JSON.stringify({
      ...(deletedAgents ? { rule: "deleted-agents" } : {}),
      mode: options.apply ? "apply" : "dry-run", environment: options.environment, replica: endpoint?.replica ?? null,
      replayAt: endpoint?.replay_at ?? null, approvalReference: options.approvalReference, runId: options.runId,
      ...(deletedAgents
        ? { startPhase: options.startPhase, splitAt: DELETED_AGENT_SPLIT_AT }
        : { days: options.days, heartbeatHours: options.heartbeatHours }),
      batch: options.batchSize, sleepMs: options.sleepMs,
      startAfter: options.startAfter, startedAt: new Date().toISOString(),
    })}`);
    if (options.apply && options.sleepMs === 0) {
      console.log(`[${tag}_WARNING] --sleep-ms 0: no pause between batches (production runs must pass --sleep-ms)`);
    }
    const walkOptions = {
      ...DEFAULT_OPTIONS,
      write: options.apply,
      runId: options.runId,
      batchSize: options.batchSize,
      sleepMs: options.sleepMs,
      days: options.days,
      heartbeatHours: options.heartbeatHours,
      startAfter: options.startAfter,
      maxBatches: options.maxBatches,
      progressEvery: options.progressEvery,
      shouldStop: () => stopRequested,
    };
    const result = deletedAgents
      ? await runDeletedAgents(client, { ...walkOptions, startPhase: options.startPhase })
      : await run(client, walkOptions);
    if (!options.apply) {
      console.log(`dry-run; pass ${deletedAgents ? "--mode deleted-agents " : ""}--apply --approval-reference <message> --run-id <id> to write`);
    }
    if (!result.completed && stopRequested) process.exitCode = 130;
  } finally {
    await client.end();
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((error: unknown) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  });
}
