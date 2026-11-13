#!/usr/bin/env -S node --import=@oxc-node/core/register
/**
 * Backfill agent_credentials.issued_via / issued_by_machine_id (migration 0401,
 * #wg-rbac): classify every credential created before the column existed.
 *
 * Size: production ~4.65M rows (~4.63M `runner:` credentials), staging ~600k.
 * Every agent-authenticated request reads this table, so the script runs
 * outside the deploy transaction and walks the primary key ONCE in fixed
 * slices: `id > <last> ORDER BY id LIMIT --batch` fixes a slice, then every
 * rule below runs, in priority order, restricted to `id > lo AND id <= hi`.
 * Each slice is one short transaction (lock_timeout 2s, statement_timeout
 * 30s, bounded retry on lock / statement timeout), so the work per batch is
 * bounded by the slice size no matter how many rows still need a change (no
 * per-rule re-scan of the whole, possibly bloated, table). Each rule only
 * touches rows it still applies to: idempotent, and a re-run over classified
 * data changes nothing.
 *
 * Rules, first match wins:
 *   1. provision  credential referenced by agent_runtime_provisions. Also
 *                 corrects rows the 0401 insert trigger classed 'human' or
 *                 'unknown' during rollout (an older build links the provision
 *                 after the insert). Clears created_by_user_id: no person
 *                 issued it.
 *   2. human      credential consumed from a bootstrap token (and not
 *                 provision-referenced): issued_via 'human' with the token's
 *                 issuer as created_by_user_id, whatever the trigger wrote.
 *   3. human      created_by_user_id is set.
 *   4. computer   daemon runner name `runner:<runtime>:<first 8 of agent id>`;
 *                 issued_by_machine_id = the agent's current Machine
 *                 (agents.daemon_id; the minting Machine was never recorded).
 *   5. app        `app-bot:<oauth client id>` on that App's Bot agent
 *                 (app_bot_bindings -> oauth_client_installs.client_id).
 *   6. unknown    anything still NULL. Expected to include production's ~15.6k
 *                 `opencli:*` rows (the May-July issuance path recorded no
 *                 issuer): 'unknown' is the correct class for them.
 *
 * A run that walks to the end of the table finishes with the verification
 * queries (--apply exits non-zero if any fails; --verify runs only them):
 *   (a) no provision row names an issuer
 *   (b) every provision-referenced credential is 'provision'
 *   (c) no computer row names an issuer
 *   (d) no row has a NULL issued_via
 *   (e) every credential referenced by agent_bootstrap_tokens.consumed_credential_id
 *       is 'human' with created_by_user_id = the token's issued_by_user_id
 * A partial run (--max-batches, or SIGINT/SIGTERM) skips them and prints the
 * resume point instead.
 *
 * Usage (defaults to dry-run: the same slice walk, counting per rule, no writes):
 *   DATABASE_URL=... pnpm --filter @botiverse/raft-server db:backfill-agent-credential-issued-via -- [--dry-run]
 *   DATABASE_URL=... pnpm --filter @botiverse/raft-server db:backfill-agent-credential-issued-via -- --apply \
 *     [--batch 1000] [--sleep-ms 0] [--start-after <credential id>] [--max-batches N] [--progress-every 100]
 *   DATABASE_URL=... pnpm --filter @botiverse/raft-server db:backfill-agent-credential-issued-via -- --verify
 *
 *   --batch           rows per id slice (1..10000, default 1000)
 *   --sleep-ms        pause after every slice (required in production, see below)
 *   --start-after     resume: only ids greater than this one
 *   --max-batches     stop after N slices (prints the resume id)
 *   --progress-every  a progress line every N slices: slices, rows scanned, rows
 *                     changed per rule, last id, elapsed, slowest slice
 * Output: [ISSUED_VIA_BACKFILL_PROGRESS] periodically; at the end
 * [ISSUED_VIA_BACKFILL_DONE], or [ISSUED_VIA_BACKFILL_STOPPED] followed by
 * [ISSUED_VIA_BACKFILL_RESUME] --start-after <id>. Ctrl-C (SIGINT) stops
 * cleanly after the current slice (exit 130); a second Ctrl-C aborts at once
 * (the open slice rolls back; resume from the last printed id).
 *
 * Rows inserted while the walk runs are classified by the 0401 insert trigger;
 * an older build's provision / bootstrap link written after its insert (the
 * rollout window) is corrected by the re-run in step 1 of the contract plan.
 *
 * Where it runs:
 *   - Staging: as a post-migration step of staging deploys. The step list for
 *     staging comes from the GitHub variable
 *     AWS_SERVER_POST_MIGRATION_STEPS_JSON_STAGING, which replaces
 *     scripts/deploy/aws-server-post-migration-steps.json when set; that file
 *     is also production's fallback, so the step is NOT added there.
 *     tygg adds this entry to the staging variable's array ONLY once this
 *     version of the script is on staging (a deploy of an older SHA would fail
 *     the step: the script or its flags do not exist there):
 *       {"name":"Backfill agent_credentials.issued_via","command":["pnpm","--filter","@botiverse/raft-server","db:backfill-agent-credential-issued-via","--","--apply","--sleep-ms","20"]}
 *     and removes it again once the contract PR lands; until then every
 *     staging deploy re-walks the whole table (a no-op write-wise, but a full
 *     scan).
 *   - Production: a gated production write. Never from the shared
 *     post-migration step list. After the release carrying 0401 is fully
 *     rolled out, with release-owner approval (tygg / artin), through
 *     Arkbriar's release flow:
 *       1. --dry-run (read-only; per-rule counts, timing per slice). The
 *          steps are disjoint (first match wins), so on the same data the
 *          per-rule counts equal what --apply will change. Expect a small
 *          drift only from rows written between the two runs (new inserts
 *          classified by the trigger, rollout-window provision/bootstrap
 *          links). A large or unexplained difference is worth stopping for;
 *          the verification at the end is the real check.
 *       2. --apply --sleep-ms 100 --max-batches 200 (about 25 s), with
 *          AndyLok reporting every minute in DM: replica lag, agent-auth route
 *          p99 and errors, pool_connect_failed, deadlocks/lock timeouts. If
 *          lag stayed < 1 s and auth latency did not move, continue with
 *          --apply --sleep-ms 50 --start-after <printed id> (whole run
 *          ~6-9 min). Stop (Ctrl-C; it finishes the current slice and prints
 *          the resume id) on ANY of:
 *            - replica lag > 5 s for 30 s straight, or > 15 s once
 *              (replica-backed reads such as inbox/unread show stale data);
 *            - a 40P01 deadlock or a lock timeout on agent_credentials. The
 *              script retries these itself (up to 5 times) and logs
 *              [ISSUED_VIA_BACKFILL_RETRY]; stop on the first such line;
 *            - a jump in pool_connect_failed or in agent-auth 401/5xx.
 *          Resume after recovery with --start-after <printed id>, optionally
 *          a larger --sleep-ms or a smaller --batch.
 *       3. The run that reaches the end prints the verification results;
 *          --verify re-checks at any time.
 *       4. Afterwards: VACUUM (ANALYZE) agent_credentials. The rewrite
 *          leaves ~2 GB of dead row versions (the table is ~2.3 GB with
 *          indexes) and roughly as much WAL.
 *     Thresholds agreed with AndyLok (o11y) on 2026-10-21.
 *
 * Contract plan (a later PR, after --verify passes in every environment):
 *   1. Re-run --apply (picks up rollout-window rows), then --verify.
 *   2. Contract migration, each statement bounded by SET LOCAL lock_timeout:
 *        ALTER TABLE agent_credentials VALIDATE CONSTRAINT agent_credentials_issued_by_machine_id_daemons_id_fk;
 *        ALTER TABLE agent_credentials VALIDATE CONSTRAINT agent_credentials_issued_via_check;
 *        ALTER TABLE agent_credentials ADD CONSTRAINT agent_credentials_issued_via_not_null CHECK (issued_via IS NOT NULL) NOT VALID;
 *        ALTER TABLE agent_credentials VALIDATE CONSTRAINT agent_credentials_issued_via_not_null;
 *        ALTER TABLE agent_credentials ALTER COLUMN issued_via SET NOT NULL;  -- proven by the validated check: no scan
 *        ALTER TABLE agent_credentials DROP CONSTRAINT agent_credentials_issued_via_not_null;  -- now redundant
 *        DROP TRIGGER agent_credentials_issued_via_legacy_writer ON agent_credentials;
 *        DROP FUNCTION agent_credentials_issued_via_legacy_writer();
 *      (VALIDATE takes SHARE UPDATE EXCLUSIVE: reads and writes continue.)
 *      schema.ts: issuedVia .notNull(); the check drops its `IS NULL OR`.
 *   3. Simplify revokeAgentCredentialsIssuedBy to
 *      `issued_via = 'human' AND created_by_user_id = <leaver>` (drop the
 *      bootstrap-token join and the provider-held exclusion).
 *   4. tygg removes the staging post-migration entry above.
 */
import "dotenv/config";
import { setTimeout as sleep } from "node:timers/promises";
import { pathToFileURL } from "node:url";
import pg from "pg";

/** The subset of pg.Client / PGlite this script uses. */
export interface Queryable {
  query<T>(text: string, params?: unknown[]): Promise<{ rows: T[] }>;
}

export interface BackfillStep {
  name: string;
  /** Rows (alias `c`) this step still changes; false once applied, so re-runs are no-ops. */
  predicate: string;
  /** SET list for `UPDATE agent_credentials AS c`. */
  set: string;
}

const PROVISION_REFERENCED = `EXISTS (SELECT 1 FROM agent_runtime_provisions AS p WHERE p.credential_id = c.id)`;
const BOOTSTRAP_CONSUMED = `EXISTS (SELECT 1 FROM agent_bootstrap_tokens AS t WHERE t.consumed_credential_id = c.id)`;
const BOOTSTRAP_ISSUER = `(
        SELECT t.issued_by_user_id FROM agent_bootstrap_tokens AS t
        WHERE t.consumed_credential_id = c.id ORDER BY t.id LIMIT 1
      )`;

/** In priority order: within a slice they run in this order, so the first rule that applies wins. */
export const BACKFILL_STEPS: readonly BackfillStep[] = [
  {
    name: "provision",
    predicate: `${PROVISION_REFERENCED}
      AND (c.issued_via IS DISTINCT FROM 'provision' OR c.created_by_user_id IS NOT NULL OR c.issued_by_machine_id IS NOT NULL)`,
    set: `issued_via = 'provision', created_by_user_id = NULL, issued_by_machine_id = NULL`,
  },
  {
    name: "human (bootstrap token)",
    predicate: `${BOOTSTRAP_CONSUMED} AND NOT ${PROVISION_REFERENCED}
      AND (c.issued_via IS DISTINCT FROM 'human' OR c.created_by_user_id IS DISTINCT FROM ${BOOTSTRAP_ISSUER}
        OR c.issued_by_machine_id IS NOT NULL)`,
    set: `issued_via = 'human', created_by_user_id = ${BOOTSTRAP_ISSUER}, issued_by_machine_id = NULL`,
  },
  {
    name: "human",
    predicate: `c.issued_via IS NULL AND c.created_by_user_id IS NOT NULL`,
    set: `issued_via = 'human'`,
  },
  {
    name: "computer",
    predicate: `c.issued_via IS NULL AND c.created_by_user_id IS NULL
      AND c.name ~ '^runner:[^:]+:[0-9a-f]{8}$' AND right(c.name, 8) = left(c.agent_id::text, 8)`,
    set: `issued_via = 'computer', issued_by_machine_id = (SELECT a.daemon_id FROM agents AS a WHERE a.id = c.agent_id)`,
  },
  {
    name: "app",
    predicate: `c.issued_via IS NULL AND c.created_by_user_id IS NULL
      AND EXISTS (
        SELECT 1 FROM app_bot_bindings AS b
        JOIN oauth_client_installs AS i ON i.id = b.install_id
        WHERE b.agent_id = c.agent_id AND c.name = 'app-bot:' || i.client_id::text
      )`,
    set: `issued_via = 'app'`,
  },
  {
    name: "unknown",
    predicate: `c.issued_via IS NULL`,
    set: `issued_via = 'unknown'`,
  },
];

export const VERIFICATION_QUERIES: Readonly<Record<string, string>> = {
  "(a) no provision row names an issuer":
    `SELECT count(*)::int AS n FROM agent_credentials WHERE issued_via = 'provision' AND created_by_user_id IS NOT NULL`,
  "(b) every provision-referenced credential is provision":
    `SELECT count(*)::int AS n FROM agent_runtime_provisions AS p JOIN agent_credentials AS c ON c.id = p.credential_id WHERE c.issued_via IS DISTINCT FROM 'provision'`,
  "(c) no computer row names an issuer":
    `SELECT count(*)::int AS n FROM agent_credentials WHERE issued_via = 'computer' AND created_by_user_id IS NOT NULL`,
  "(d) no row has a NULL issued_via":
    `SELECT count(*)::int AS n FROM agent_credentials WHERE issued_via IS NULL`,
  "(e) every bootstrap-consumed credential is human, issued by the token's issuer":
    `SELECT count(*)::int AS n FROM agent_bootstrap_tokens AS t JOIN agent_credentials AS c ON c.id = t.consumed_credential_id
     WHERE c.issued_via IS DISTINCT FROM 'human' OR c.created_by_user_id IS DISTINCT FROM t.issued_by_user_id`,
};

export interface BatchOptions {
  /** Rows per id slice. */
  batchSize: number;
  /** Pause after every slice. */
  sleepMs: number;
  lockTimeout: string;
  statementTimeout: string;
  maxAttempts: number;
  /** false: count what each step would change (dry-run), write nothing. */
  write: boolean;
  /** Resume point: only ids greater than this. null = from the start. */
  startAfter: string | null;
  /** Stop after this many slices (null = run to the end). */
  maxBatches: number | null;
  /** A progress line every this many slices. */
  progressEvery: number;
  /** Polled between slices; true = stop after the current slice (SIGINT). */
  shouldStop: () => boolean;
  log: (line: string) => void;
}

export const DEFAULT_BATCH_OPTIONS: BatchOptions = {
  batchSize: 1000,
  sleepMs: 0,
  lockTimeout: "2s",
  statementTimeout: "30s",
  maxAttempts: 5,
  write: true,
  startAfter: null,
  maxBatches: null,
  progressEvery: 100,
  shouldStop: () => false,
  log: (line) => console.log(line),
};

export interface SliceResult {
  /** Highest id in the slice; null when no rows are left after `afterId`. */
  lastId: string | null;
  /** Rows in the slice. */
  scanned: number;
  /** Rows each step changed (or, dry-run, would change) in the slice. */
  changed: Record<string, number>;
}

function zeroCounts(): Record<string, number> {
  return Object.fromEntries(BACKFILL_STEPS.map((step) => [step.name, 0]));
}

/**
 * One id slice, in its own transaction: the next `batchSize` rows by primary
 * key after `afterId` fix the slice (afterId, lastId]; then every step, in
 * priority order, updates only the rows of that slice it applies to. The work
 * per slice is bounded by its size, however few rows still need a change.
 * Dry-run (write: false) counts per step instead, each row under the first
 * step that applies to it.
 */
export async function runSlice(
  db: Queryable,
  afterId: string | null,
  options: Pick<BatchOptions, "batchSize" | "lockTimeout" | "statementTimeout" | "write">,
): Promise<SliceResult> {
  const changed = zeroCounts();
  await db.query("BEGIN");
  try {
    // jit off: the correlated issuer lookup inflates cost estimates past
    // jit_above_cost, and compiling then costs more than the slice's work.
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
      return { lastId: null, scanned: 0, changed };
    }
    const range = afterId === null ? `c.id <= $1::uuid` : `c.id <= $1::uuid AND c.id > $2::uuid`;
    const params = afterId === null ? [lastId] : [lastId, afterId];
    if (options.write) {
      for (const step of BACKFILL_STEPS) {
        const { rows: [row] } = await db.query<{ n: number }>(
          `WITH updated AS (
             UPDATE agent_credentials AS c SET ${step.set}
             WHERE ${range} AND ${step.predicate}
             RETURNING 1
           ) SELECT count(*)::int AS n FROM updated`,
          params,
        );
        changed[step.name] = row?.n ?? 0;
      }
    } else {
      const cases = BACKFILL_STEPS.map((step, index) => `WHEN ${step.predicate} THEN ${index}`).join("\n          ");
      const { rows } = await db.query<{ step: number; n: number }>(
        `SELECT step, count(*)::int AS n FROM (
           SELECT CASE
          ${cases}
           END AS step
           FROM agent_credentials AS c WHERE ${range}
         ) AS classified
         WHERE step IS NOT NULL GROUP BY step`,
        params,
      );
      for (const row of rows) changed[BACKFILL_STEPS[row.step]!.name] = row.n;
    }
    await db.query("COMMIT");
    return { lastId, scanned: bounds!.scanned, changed };
  } catch (error) {
    await db.query("ROLLBACK").catch(() => undefined);
    throw error;
  }
}

function isRetryable(error: unknown): boolean {
  const code = (error as { code?: string } | null)?.code;
  // lock_not_available, query_canceled (statement_timeout), deadlock, serialization
  return code === "55P03" || code === "57014" || code === "40P01" || code === "40001";
}

export interface BackfillResult {
  /** True when the walk reached the end of the table. */
  completed: boolean;
  /** Last id processed: pass it as --start-after to resume. null if nothing was processed. */
  lastId: string | null;
  batches: number;
  scanned: number;
  changed: Record<string, number>;
  elapsedMs: number;
}

function formatCounts(counts: Record<string, number>): string {
  return Object.entries(counts).map(([step, n]) => `${step.replace(/[^a-z]+/g, "_").replace(/_$/, "")}=${n}`).join(" ");
}

/**
 * Walks agent_credentials by primary key in fixed slices from
 * `options.startAfter`, applying (or, dry-run, counting) every step within each
 * slice. Stops at the end of the table, after `maxBatches` slices, or when
 * `shouldStop()` turns true; the result's lastId is the resume point.
 */
export async function runBackfill(db: Queryable, options: BatchOptions = DEFAULT_BATCH_OPTIONS): Promise<BackfillResult> {
  const started = Date.now();
  const changed = zeroCounts();
  let afterId = options.startAfter;
  let lastId: string | null = options.startAfter;
  let batches = 0;
  let scanned = 0;
  let slowestMs = 0;
  let slowestOverallMs = 0;
  let completed = false;
  const progress = (tag: string, slowest: number) => {
    options.log(`[${tag}] mode=${options.write ? "apply" : "dry-run"} batches=${batches} scanned=${scanned} ${formatCounts(changed)} `
      + `last_id=${lastId ?? "-"} elapsed=${((Date.now() - started) / 1000).toFixed(1)}s slowest_batch_ms=${slowest}`);
  };
  for (;;) {
    if (options.maxBatches !== null && batches >= options.maxBatches) break;
    if (options.shouldStop()) break;
    let result: SliceResult | undefined;
    const batchStarted = Date.now();
    for (let attempt = 1; ; attempt++) {
      try {
        result = await runSlice(db, afterId, options);
        break;
      } catch (error) {
        if (!isRetryable(error) || attempt >= options.maxAttempts) throw error;
        options.log(`[ISSUED_VIA_BACKFILL_RETRY] after=${afterId ?? "-"} attempt=${attempt} reason=${(error as Error).message}`);
        await sleep(Math.min(1000 * attempt, 5000));
      }
    }
    if (result.lastId === null) {
      completed = true;
      break;
    }
    slowestMs = Math.max(slowestMs, Date.now() - batchStarted);
    slowestOverallMs = Math.max(slowestOverallMs, slowestMs);
    batches += 1;
    scanned += result.scanned;
    for (const [step, n] of Object.entries(result.changed)) changed[step] = (changed[step] ?? 0) + n;
    afterId = lastId = result.lastId;
    if (batches % options.progressEvery === 0) {
      progress("ISSUED_VIA_BACKFILL_PROGRESS", slowestMs); // slowest since the previous progress line
      slowestMs = 0;
    }
    if (result.scanned < options.batchSize) {
      completed = true;
      break;
    }
    if (options.sleepMs > 0) await sleep(options.sleepMs);
  }
  progress(completed ? "ISSUED_VIA_BACKFILL_DONE" : "ISSUED_VIA_BACKFILL_STOPPED", slowestOverallMs); // slowest of the run
  if (!completed && lastId !== null) options.log(`[ISSUED_VIA_BACKFILL_RESUME] --start-after ${lastId}`);
  return { completed, lastId, batches, scanned, changed, elapsedMs: Date.now() - started };
}

/** The verification queries; each must count 0. */
export async function verify(db: Queryable, statementTimeout = "10min"): Promise<Array<{ check: string; count: number; ok: boolean }>> {
  const results = [];
  await db.query("BEGIN READ ONLY");
  try {
    await db.query(`SELECT set_config('statement_timeout', $1, true)`, [statementTimeout]);
    for (const [check, query] of Object.entries(VERIFICATION_QUERIES)) {
      const { rows: [row] } = await db.query<{ n: number }>(query);
      const count = row?.n ?? 0;
      results.push({ check, count, ok: count === 0 });
    }
    await db.query("COMMIT");
  } catch (error) {
    await db.query("ROLLBACK").catch(() => undefined);
    throw error;
  }
  return results;
}

type Mode = "dry-run" | "apply" | "verify";

export interface CliOptions {
  mode: Mode;
  batchSize: number;
  sleepMs: number;
  startAfter: string | null;
  maxBatches: number | null;
  progressEvery: number;
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export function parseArgs(argv: readonly string[]): CliOptions {
  const options: CliOptions = {
    mode: "dry-run",
    batchSize: DEFAULT_BATCH_OPTIONS.batchSize,
    sleepMs: 0,
    startAfter: null,
    maxBatches: null,
    progressEvery: DEFAULT_BATCH_OPTIONS.progressEvery,
  };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === "--") continue;
    else if (arg === "--dry-run") options.mode = "dry-run";
    else if (arg === "--apply") options.mode = "apply";
    else if (arg === "--verify") options.mode = "verify";
    else if (arg === "--batch") options.batchSize = Number(argv[++i]);
    else if (arg === "--sleep-ms") options.sleepMs = Number(argv[++i]);
    else if (arg === "--start-after") options.startAfter = argv[++i] ?? "";
    else if (arg === "--max-batches") options.maxBatches = Number(argv[++i]);
    else if (arg === "--progress-every") options.progressEvery = Number(argv[++i]);
    else throw new Error(`Unknown argument: ${arg}`);
  }
  if (!Number.isInteger(options.batchSize) || options.batchSize < 1 || options.batchSize > 10_000) {
    throw new Error("--batch must be 1..10000");
  }
  if (!Number.isInteger(options.sleepMs) || options.sleepMs < 0 || options.sleepMs > 60_000) {
    throw new Error("--sleep-ms must be 0..60000");
  }
  if (options.startAfter !== null && !UUID.test(options.startAfter)) {
    throw new Error("--start-after must be a credential id (uuid)");
  }
  if (options.maxBatches !== null && (!Number.isInteger(options.maxBatches) || options.maxBatches < 1)) {
    throw new Error("--max-batches must be a positive integer");
  }
  if (!Number.isInteger(options.progressEvery) || options.progressEvery < 1) {
    throw new Error("--progress-every must be a positive integer");
  }
  return options;
}

function printVerification(results: Awaited<ReturnType<typeof verify>>): boolean {
  for (const result of results) {
    console.log(`[ISSUED_VIA_VERIFY_${result.ok ? "OK" : "FAILED"}] ${result.check}: ${result.count}`);
  }
  return results.every((result) => result.ok);
}

async function main(): Promise<void> {
  const options = parseArgs(process.argv.slice(2));
  const connectionString = process.env.DATABASE_URL;
  if (!connectionString) throw new Error("DATABASE_URL is required");
  const client = new pg.Client({ connectionString });
  await client.connect();
  let stopRequested = false;
  const onSignal = (signal: string) => {
    stopRequested = true;
    console.log(`[ISSUED_VIA_BACKFILL_STOPPING] ${signal}: stopping after the current batch (send again to abort now)`);
  };
  process.once("SIGINT", () => onSignal("SIGINT"));
  process.once("SIGTERM", () => onSignal("SIGTERM"));
  try {
    if (options.mode === "verify") {
      if (!printVerification(await verify(client))) process.exitCode = 1;
      return;
    }
    if (options.mode === "apply" && options.sleepMs === 0) {
      console.log("[ISSUED_VIA_BACKFILL_WARNING] --sleep-ms 0: no pause between batches (production runs must pass --sleep-ms)");
    }
    const result = await runBackfill(client, {
      ...DEFAULT_BATCH_OPTIONS,
      write: options.mode === "apply",
      batchSize: options.batchSize,
      sleepMs: options.sleepMs,
      startAfter: options.startAfter,
      maxBatches: options.maxBatches,
      progressEvery: options.progressEvery,
      shouldStop: () => stopRequested,
    });
    if (options.mode === "dry-run") console.log("dry-run; pass --apply to write");
    if (!result.completed) {
      // Partial pass (--max-batches or a signal): verification would only report the rows not yet walked.
      console.log("[ISSUED_VIA_VERIFY_SKIPPED] pass incomplete; resume with the --start-after above");
      if (stopRequested) process.exitCode = 130;
      return;
    }
    if (options.mode === "apply" && !printVerification(await verify(client))) process.exitCode = 1;
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
