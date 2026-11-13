#!/usr/bin/env -S node --import=@oxc-node/core/register
/**
 * One-time cleanup: revoke the keys of App Bots that an App
 * deletion left behind, and soft-delete those Bots.
 *
 * Before the fix, deleting an App let its installations go by ON DELETE CASCADE,
 * which only set agents.managed_by_app_install_id to NULL: each installing
 * Server's Bot stayed, with its App-minted key still valid. Since the fix, App
 * deletion uninstalls every Bot, and authentication refuses an `issued_via =
 * 'app'` key whose agent no installation manages. What is left for this script:
 *   - revoke those `issued_via = 'app'` keys too (they already fail to
 *     authenticate; revoking makes the record say so), and
 *   - keys minted before issued_via existed, which the 0401 backfill classed
 *     'unknown' because their installation was already gone: named
 *     `app-bot:<App id>` for an App that no longer exists.
 * In both cases only on an agent no installation manages, and never a key a
 * person issued (`issued_via = 'human'` or `created_by_user_id` set). Each
 * matched agent is soft-deleted, as an uninstall does.
 *
 * Size: agent_credentials can hold millions of rows and has no index on
 * issued_via or name, so a single filtering statement is a full scan that can
 * outlast a statement timeout. Like the issued_via backfill, the
 * script walks the primary key once in fixed slices (`id > <last> ORDER BY id
 * LIMIT --batch`) and applies the rule within each slice, one short transaction
 * per slice (lock_timeout 2s, statement_timeout 30s, bounded retry). Idempotent:
 * a revoked key or a deleted agent no longer matches.
 *
 * Usage (defaults to dry-run: the same walk, counting, no writes):
 *   DATABASE_URL=... pnpm --filter @botiverse/raft-server ops:revoke-orphaned-app-bot-keys -- [--dry-run]
 *   DATABASE_URL=... pnpm --filter @botiverse/raft-server ops:revoke-orphaned-app-bot-keys -- --apply --sleep-ms 50 \
 *     [--batch 1000] [--start-after <credential id>] [--max-batches N] [--progress-every 100]
 * Output: [ORPHANED_APP_BOT_KEYS_PROGRESS], then [ORPHANED_APP_BOT_KEYS_DONE] or
 * [ORPHANED_APP_BOT_KEYS_STOPPED] and [ORPHANED_APP_BOT_KEYS_RESUME] --start-after <id>,
 * and [ORPHANED_APP_BOT_KEYS_ONLINE] when any matched key is online.
 *
 * Online: a matched key seen within EXTERNAL_AGENT_ONLINE_WINDOW_MS (the
 * presence rule; an open wake-hint stream's heartbeat refreshes last_used_at).
 * Revoking stops new connections, not a stream already open, and this script
 * sends no revocation signal: `online` (and the agent ids, up to
 * MAX_ONLINE_AGENT_IDS) says whether some stream still has to be dropped, by a
 * restart or a deploy's rolling restart after --apply.
 * Ctrl-C stops after the current slice (exit 130).
 *
 * On a live deployment: run it once the release with the App deletion fix is
 * live. Run --dry-run first and review the counts, then --apply with
 * --sleep-ms, and stop on sustained replica lag, any lock timeout or deadlock
 * line, or a jump in agent-auth 401/5xx.
 */
import "dotenv/config";
import { setTimeout as sleep } from "node:timers/promises";
import { pathToFileURL } from "node:url";
import pg from "pg";
import { EXTERNAL_AGENT_ONLINE_WINDOW_MS } from "@botiverse/raft-shared";

/** The subset of pg.Client / PGlite this script uses. */
export interface Queryable {
  query<T>(text: string, params?: unknown[]): Promise<{ rows: T[] }>;
}

const APP_ID = `substring(c.name FROM 9)`;
/** An orphaned App Bot's live key (alias `c`, agent `a`). */
export const ORPHANED_APP_BOT_KEY = `c.revoked_at IS NULL
  AND a.deleted_at IS NULL
  AND a.managed_by_app_install_id IS NULL
  AND c.created_by_user_id IS NULL
  AND (
    c.issued_via = 'app'
    OR (
      c.issued_via IS DISTINCT FROM 'human'
      AND c.name ~ '^app-bot:[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
      AND NOT EXISTS (SELECT 1 FROM oauth_clients AS o WHERE o.id::text = ${APP_ID})
    )
  )`;

export interface Options {
  batchSize: number;
  sleepMs: number;
  lockTimeout: string;
  statementTimeout: string;
  maxAttempts: number;
  write: boolean;
  startAfter: string | null;
  maxBatches: number | null;
  progressEvery: number;
  shouldStop: () => boolean;
  log: (line: string) => void;
}

export const DEFAULT_OPTIONS: Options = {
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
  lastId: string | null;
  scanned: number;
  /** Keys revoked (dry-run: would be). */
  keys: number;
  /** Agents soft-deleted (dry-run: would be). */
  agents: number;
  /** Of those keys, the ones online (seen within EXTERNAL_AGENT_ONLINE_WINDOW_MS), by agent. */
  onlineAgentIds: string[];
}

/** How many online agent ids a run prints at most; the count is always whole. */
export const MAX_ONLINE_AGENT_IDS = 100;
const ONLINE_SECONDS = EXTERNAL_AGENT_ONLINE_WINDOW_MS / 1000;

/** One id slice in its own transaction: fix (afterId, lastId], then revoke and soft-delete within it. */
export async function runSlice(
  db: Queryable,
  afterId: string | null,
  options: Pick<Options, "batchSize" | "lockTimeout" | "statementTimeout" | "write">,
): Promise<SliceResult> {
  await db.query("BEGIN");
  try {
    await db.query(
      `SELECT set_config('lock_timeout', $1, true), set_config('statement_timeout', $2, true)`,
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
      return { lastId: null, scanned: 0, keys: 0, agents: 0, onlineAgentIds: [] };
    }
    const range = afterId === null ? `c.id <= $1::uuid` : `c.id <= $1::uuid AND c.id > $2::uuid`;
    const params = afterId === null ? [lastId] : [lastId, afterId];
    const matched = `SELECT c.id, c.agent_id, c.last_used_at > now() - make_interval(secs => ${ONLINE_SECONDS}) AS online
      FROM agent_credentials AS c JOIN agents AS a ON a.id = c.agent_id
      WHERE ${range} AND ${ORPHANED_APP_BOT_KEY}`;
    const online = `(SELECT coalesce(array_agg(DISTINCT agent_id::text), '{}') FROM matched WHERE online) AS online_agent_ids`;
    let keys: number;
    let agents: number;
    let onlineAgentIds: string[];
    if (options.write) {
      const { rows: [row] } = await db.query<{ keys: number; agents: number; online_agent_ids: string[] }>(
        `WITH matched AS (${matched}),
         revoked AS (
           UPDATE agent_credentials AS c SET revoked_at = now(), revoked_reason = 'app_deleted'
           FROM matched AS m WHERE c.id = m.id RETURNING c.agent_id
         ),
         deleted AS (
           UPDATE agents AS a SET deleted_at = now(), updated_at = now()
           WHERE a.id IN (SELECT agent_id FROM revoked) AND a.deleted_at IS NULL AND a.managed_by_app_install_id IS NULL
           RETURNING a.id
         )
         SELECT (SELECT count(*) FROM revoked)::int AS keys, (SELECT count(*) FROM deleted)::int AS agents, ${online}`,
        params,
      );
      keys = row?.keys ?? 0;
      agents = row?.agents ?? 0;
      onlineAgentIds = row?.online_agent_ids ?? [];
    } else {
      const { rows: [row] } = await db.query<{ keys: number; agents: number; online_agent_ids: string[] }>(
        `WITH matched AS (${matched})
         SELECT count(*)::int AS keys, count(DISTINCT agent_id)::int AS agents, ${online} FROM matched`,
        params,
      );
      keys = row?.keys ?? 0;
      agents = row?.agents ?? 0;
      onlineAgentIds = row?.online_agent_ids ?? [];
    }
    await db.query("COMMIT");
    return { lastId, scanned: bounds!.scanned, keys, agents, onlineAgentIds };
  } catch (error) {
    await db.query("ROLLBACK").catch(() => undefined);
    throw error;
  }
}

function isRetryable(error: unknown): boolean {
  const code = (error as { code?: string } | null)?.code;
  return code === "55P03" || code === "57014" || code === "40P01" || code === "40001";
}

export interface RunResult {
  completed: boolean;
  lastId: string | null;
  batches: number;
  scanned: number;
  keys: number;
  agents: number;
  /** Agents with an online matched key (summed per slice, like `agents`). */
  online: number;
  /** Up to MAX_ONLINE_AGENT_IDS of them. */
  onlineAgentIds: string[];
}

/** Walks agent_credentials by primary key in fixed slices from `startAfter`. */
export async function run(db: Queryable, options: Options = DEFAULT_OPTIONS): Promise<RunResult> {
  const started = Date.now();
  let afterId = options.startAfter;
  let lastId: string | null = options.startAfter;
  let batches = 0;
  let scanned = 0;
  let keys = 0;
  let agents = 0;
  let online = 0;
  const onlineAgentIds: string[] = [];
  let completed = false;
  const report = (tag: string) => options.log(`[${tag}] mode=${options.write ? "apply" : "dry-run"} batches=${batches} `
    + `scanned=${scanned} keys=${keys} agents=${agents} online=${online} last_id=${lastId ?? "-"} elapsed=${((Date.now() - started) / 1000).toFixed(1)}s`);
  for (;;) {
    if (options.maxBatches !== null && batches >= options.maxBatches) break;
    if (options.shouldStop()) break;
    let result: SliceResult | undefined;
    for (let attempt = 1; ; attempt++) {
      try {
        result = await runSlice(db, afterId, options);
        break;
      } catch (error) {
        if (!isRetryable(error) || attempt >= options.maxAttempts) throw error;
        options.log(`[ORPHANED_APP_BOT_KEYS_RETRY] after=${afterId ?? "-"} attempt=${attempt} reason=${(error as Error).message}`);
        await sleep(Math.min(1000 * attempt, 5000));
      }
    }
    if (result.lastId === null) {
      completed = true;
      break;
    }
    batches += 1;
    scanned += result.scanned;
    keys += result.keys;
    agents += result.agents;
    online += result.onlineAgentIds.length;
    onlineAgentIds.push(...result.onlineAgentIds.slice(0, MAX_ONLINE_AGENT_IDS - onlineAgentIds.length));
    afterId = lastId = result.lastId;
    if (batches % options.progressEvery === 0) report("ORPHANED_APP_BOT_KEYS_PROGRESS");
    if (result.scanned < options.batchSize) {
      completed = true;
      break;
    }
    if (options.sleepMs > 0) await sleep(options.sleepMs);
  }
  report(completed ? "ORPHANED_APP_BOT_KEYS_DONE" : "ORPHANED_APP_BOT_KEYS_STOPPED");
  if (online > 0) {
    options.log(`[ORPHANED_APP_BOT_KEYS_ONLINE] ${online} agent(s) online within ${ONLINE_SECONDS}s; an open stream outlives the revocation `
      + `until a restart: agent_ids=${onlineAgentIds.join(",")}${online > onlineAgentIds.length ? ",…" : ""}`);
  }
  if (!completed && lastId !== null) options.log(`[ORPHANED_APP_BOT_KEYS_RESUME] --start-after ${lastId}`);
  return { completed, lastId, batches, scanned, keys, agents, online, onlineAgentIds };
}

export interface CliOptions {
  apply: boolean;
  batchSize: number;
  sleepMs: number;
  startAfter: string | null;
  maxBatches: number | null;
  progressEvery: number;
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export function parseArgs(argv: readonly string[]): CliOptions {
  const options: CliOptions = { apply: false, batchSize: 1000, sleepMs: 0, startAfter: null, maxBatches: null, progressEvery: 100 };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === "--") continue;
    else if (arg === "--dry-run") options.apply = false;
    else if (arg === "--apply") options.apply = true;
    else if (arg === "--batch") options.batchSize = Number(argv[++i]);
    else if (arg === "--sleep-ms") options.sleepMs = Number(argv[++i]);
    else if (arg === "--start-after") options.startAfter = argv[++i] ?? "";
    else if (arg === "--max-batches") options.maxBatches = Number(argv[++i]);
    else if (arg === "--progress-every") options.progressEvery = Number(argv[++i]);
    else throw new Error(`Unknown argument: ${arg}`);
  }
  if (!Number.isInteger(options.batchSize) || options.batchSize < 1 || options.batchSize > 10_000) throw new Error("--batch must be 1..10000");
  if (!Number.isInteger(options.sleepMs) || options.sleepMs < 0 || options.sleepMs > 60_000) throw new Error("--sleep-ms must be 0..60000");
  if (options.startAfter !== null && !UUID.test(options.startAfter)) throw new Error("--start-after must be a credential id (uuid)");
  if (options.maxBatches !== null && (!Number.isInteger(options.maxBatches) || options.maxBatches < 1)) throw new Error("--max-batches must be a positive integer");
  if (!Number.isInteger(options.progressEvery) || options.progressEvery < 1) throw new Error("--progress-every must be a positive integer");
  return options;
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
    console.log(`[ORPHANED_APP_BOT_KEYS_STOPPING] ${signal}: stopping after the current batch`);
  };
  process.once("SIGINT", () => onSignal("SIGINT"));
  process.once("SIGTERM", () => onSignal("SIGTERM"));
  try {
    if (options.apply && options.sleepMs === 0) {
      console.log("[ORPHANED_APP_BOT_KEYS_WARNING] --sleep-ms 0: no pause between batches (production runs must pass --sleep-ms)");
    }
    const result = await run(client, {
      ...DEFAULT_OPTIONS,
      write: options.apply,
      batchSize: options.batchSize,
      sleepMs: options.sleepMs,
      startAfter: options.startAfter,
      maxBatches: options.maxBatches,
      progressEvery: options.progressEvery,
      shouldStop: () => stopRequested,
    });
    if (!options.apply) console.log("dry-run; pass --apply to write");
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
