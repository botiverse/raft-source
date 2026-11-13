// Closed-server purge (design "Purging closed servers 30 days after closing"
// v6): the hourly job, its `count` mode, and the run around `delete` mode
// (closedServerPurgeDelete.ts, which deletes).
//
// Who: servers with `kind = 'normal'` closed (`deleted_at`) more than 30 days
// ago (closedServerPurgeEligibleSql, the one predicate both modes use).
//
// Gate: the feature flag `closed_server_purge` (server randomization unit),
// evaluated for each closed server. On with no variant, or variant `count`:
// counted, nothing deleted. Variant `delete` from a rule naming that server
// (reason `server_rule`), and only that: purged (closedServerPurgeDelete.ts),
// the flag evaluated again right before the server is claimed and before
// every batch. `delete` from anywhere else (the default variant, a
// percentage, audience or plan rule) is counted, not purged, and logged: an
// irreversible delete is never rolled out by a broad rule. Missing, disabled,
// kill switch, off for that server, or any other variant: not touched.
//
// `count`: every read runs in a READ ONLY transaction, on the read replica
// (getSearchDb), each under SET LOCAL statement_timeout. In production a run
// with no separate replica stops before reading (`replica_unavailable`);
// elsewhere (dev, tests) it reads the primary. For each server, what a purge would clear:
// - channels, excluding joint projections (the server's
//   joint_channel_servers.local_channel_id: their content lives in the
//   joint_storage server) and migration receipt channels (kept, v1), and the
//   threads and task conversations under either (`parent_channel_id`);
// - messages, counted channel by channel on idx_messages_channel_created_at,
//   MESSAGE_CHUNK rows a statement (messages.server_id has no index);
// - attachments (rows; distinct objects and their bytes per channel chunk,
//   an upper bound: an object can also be held elsewhere) and tasks of those
//   channels;
// - object_events by server_id (idx_object_events_server_seq), in chunks;
// - each table the finish's server_rows step clears (rows_<table>), with the
//   same scope as the delete (closedServerPurgeRowScope: kept channels' rows
//   and rows a kept row names excluded), at most ROW_COUNT_CAP each;
// - the apps the server owns: own_apps_deletable (never shared:
//   closedServerPurgeFinish.ts ownAppNeverSharedSql) and own_apps_kept (the
//   rest: published or shared); and channels_bridged, the channels the
//   purge clears whose bridge rows it deletes first;
// - each first-party app's own count (FirstPartyApp.purgeServer, `count`).
//
// `delete`: on the primary, servers not yet purged, each claimed with a lease
// (purge_lease_until / purge_lease_token on servers) and resumed at its
// purge_state; see closedServerPurgeDelete.ts for the steps. After its rows
// are deleted (`rows_deleted`) the finish (closedServerPurgeFinish.ts) runs
// under the same claim: hosted runtimes, the WeChat bridge, the classified
// server rows, credentials revoked at their providers, the system uninstall
// of every app install, the Slack bridge, and the agents' tombstones; with
// every step done it is `done` and purged_at is set. A step that must wait (a
// provider revoke that failed, an agent mid-migration) keeps the server in
// `rows_deleted`, purged_at NULL, tried again a day later. Before every
// batch the run checks its guards and stops when one trips: the run's wall
// time and quiet times, at most MESSAGE_CAP_PER_RUN messages a run (one run
// an hour: 20,000 an hour), and the CDC slot `slock_dist_cdc_slot` read with
// replicationSlotMonitor's query (retained WAL over 64 MB pauses, i.e. ends
// the run, and later runs wait until it is under 32 MB again; over 250 MB, or
// wal_status not `reserved`, stops), and an rw_overloaded this process saw in
// the last 5 minutes. A slot that doesn't exist stops the run in production
// (DEPLOYMENT_ENV=production: a renamed or dropped slot must not turn the
// guard off) and is no reading elsewhere (dev, staging, tests).
//
// Telemetry: one `closed_server_purge.count.server` per server counted, one
// `closed_server_purge.delete.server` per server the run worked on, one
// `closed_server_purge.run.finished` per run
// (docs/observability/reading-telemetry.md). Ids and numbers only, never a
// name or content.
//
// When: from the hourly maintenance. At most one run per CLAIM_TTL across
// replicas (a Redis claim, like the onboarding funnel; one process without
// Redis), RUN_BUDGET_MS of wall time a run, never in a quiet time (06-10Z,
// 20-24Z, :00-:05 every hour), checked again before every server and every
// delete batch. Delete comes first in a run; the count pass gets the rest.
// The count pass walks servers by id and resumes from a cursor; after a full
// pass the next starts PASS_REST later. A statement timeout or lock timeout
// (57014 / 55P03) ends the run; the next run tries again. In the delete, a
// server's own error (a timeout too) backs that server off a day, so the
// next run starts past it; a timeout still ends the run, any other error
// goes on to the next server.
import { and, asc, eq, gt, inArray, isNull, lte, or, sql } from "drizzle-orm";
import { asServerId, currentDate, type ServerId } from "@botiverse/raft-shared";
import { firstPartyApps } from "../apps/firstPartyApps";
import { getDb, getSearchDb, type Database, type DatabaseExecutor } from "../db/index";
import { REPLICATION_SLOT_QUERY } from "../db/replicationSlotMonitor";
import { agentMigrationReceiptChannels, attachmentObjects, attachments, channels, jointChannelServers, servers, tasks } from "../db/schema";
import type { FirstPartyApp } from "../platform/apps";
import { getRedis, isRedisAvailable } from "../redis";
import { REPLICA_ID } from "../replicaRouter";
import { isRisingWaveOverloadSeenWithin } from "../routes/rwStaleRead";
import { errorClassOf, recordTraceEvent } from "../tracing/semanticTrace";
import {
  CLOSED_SERVER_PURGE_AFTER_MS,
  ClosedServerPurgeRunStop,
  closedServerPurgeCutoff,
  isPurgeTimeout,
  closedServerPurgeEligibleSql,
  closedServerPurgeOpenSql,
  keptChannelsOf,
  LOCK_TIMEOUT,
  MESSAGE_BATCH_START,
  purgeClosedServer,
  sqlstateOf,
  STATEMENT_TIMEOUT,
  type ClosedServerPurgeGuardStop,
  type ClosedServerPurgeHooks,
  type ClosedServerPurgeRunContext,
  type ClosedServerPurgeServerResult,
} from "./closedServerPurgeDelete";
import { closedServerPurgeRowScope, ownAppNeverSharedSql, type ClosedServerPurgeFinishStep } from "./closedServerPurgeFinish";
import { closedServerPurgeRowDeletes } from "./closedServerPurgeClassification";
import type { ClosedServerPurgeRevokers } from "./closedServerPurgeRevoke";
import { CLOSED_SERVER_PURGE_FEATURE_FLAG_KEY, evaluateFeatureFlags, getFeatureFlag } from "./featureFlagService";

export { CLOSED_SERVER_PURGE_AFTER_MS, CLOSED_SERVER_PURGE_FEATURE_FLAG_KEY, closedServerPurgeEligibleSql };
export const CLOSED_SERVER_PURGE_SERVER_EVENT = "closed_server_purge.count.server";
export const CLOSED_SERVER_PURGE_DELETE_SERVER_EVENT = "closed_server_purge.delete.server";
export const CLOSED_SERVER_PURGE_RUN_EVENT = "closed_server_purge.run.finished";

const RUN_BUDGET_MS = 5 * 60_000;
const CLAIM_TTL_SECONDS = 50 * 60;
const PASS_REST_SECONDS = 23 * 3600;
const CURSOR_TTL_SECONDS = 7 * 24 * 3600;
const SERVER_PAGE = 50;
const CHANNEL_CHUNK = 500;
const MESSAGE_CHUNK = 5_000;
const OBJECT_EVENT_CHUNK = 5_000;
/** A server_rows table is counted up to this many rows (a lower bound at the cap). */
export const ROW_COUNT_CAP = 100_000;
/** At most this many messages deleted a run; one run an hour (design: ≤ 20,000 messages per hour). */
export const MESSAGE_CAP_PER_RUN = 20_000;

/** The CDC slot whose retained WAL the delete watches (NotZZ's thresholds, design "Slow down or stop"). */
export const CDC_SLOT_NAME = "slock_dist_cdc_slot";
const MB = 1024 * 1024;
export const SLOT_PAUSE_BYTES = 64 * MB;
export const SLOT_RESUME_BYTES = 32 * MB;
export const SLOT_STOP_BYTES = 250 * MB;
export const RW_OVERLOAD_WINDOW_MS = 5 * 60_000;

/** What the flag says for one closed server. */
export type ClosedServerPurgeMode = "off" | "count" | "delete";

/**
 * The flag's answer for a closed server: only the variant `delete` from a
 * rule naming the server (`server_rule`) deletes; `delete` from any other
 * rule or the default counts (closedServerPurgeDeleteNotServerRule).
 */
export function closedServerPurgeModeOf(evaluation: { enabled: boolean; variant?: string; reason?: string }): ClosedServerPurgeMode {
  if (!evaluation.enabled) return "off";
  if (evaluation.variant === undefined || evaluation.variant === "count") return "count";
  if (evaluation.variant === "delete") return evaluation.reason === "server_rule" ? "delete" : "count";
  return "off";
}

/** `delete` asked for by something other than a rule naming the server: counted instead (closedServerPurgeModeOf). */
export const closedServerPurgeDeleteNotServerRule = (evaluation: { enabled: boolean; variant?: string; reason?: string }) =>
  evaluation.enabled && evaluation.variant === "delete" && evaluation.reason !== "server_rule";

/** The quiet time `now` falls in (design, "Quiet times"), or null. */
export function closedServerPurgeQuietTime(now: Date): "rw_peak" | "release_window" | "hourly_stall" | null {
  const hour = now.getUTCHours();
  if (hour >= 6 && hour < 10) return "rw_peak";
  if (hour >= 20) return "release_window";
  if (now.getUTCMinutes() < 5) return "hourly_stall";
  return null;
}

/** What the delete's guards read before a batch. `slot` is null when the CDC slot doesn't exist. */
export interface ClosedServerPurgeGuardReading {
  slot: { retainedWalBytes: number | null; walStatus: string | null } | null;
  /** The slot must exist (production): its absence stops the run rather than lift the guard. */
  slotRequired?: boolean;
  rwOverloadedRecently: boolean;
}

/**
 * Whether a reading stops the run, and whether the slot pause holds after it
 * (`paused`: an earlier reading was over SLOT_PAUSE_BYTES and none since has
 * been under SLOT_RESUME_BYTES).
 */
export function closedServerPurgeGuardVerdict(reading: ClosedServerPurgeGuardReading, paused: boolean): { stop: ClosedServerPurgeGuardStop | null; paused: boolean } {
  let stillPaused = paused;
  const slot = reading.slot;
  if (slot) {
    if (slot.walStatus !== null && slot.walStatus !== "reserved") return { stop: "slot_wal_status", paused: stillPaused };
    const bytes = slot.retainedWalBytes;
    if (bytes !== null) {
      if (bytes > SLOT_STOP_BYTES) return { stop: "slot_stopped", paused: true };
      if (bytes > SLOT_PAUSE_BYTES) return { stop: "slot_paused", paused: true };
      if (bytes < SLOT_RESUME_BYTES) stillPaused = false;
      if (stillPaused) return { stop: "slot_paused", paused: true };
    }
  } else {
    if (reading.slotRequired) return { stop: "slot_missing", paused: stillPaused };
    stillPaused = false;
  }
  if (reading.rwOverloadedRecently) return { stop: "rw_overloaded", paused: stillPaused };
  return { stop: null, paused: stillPaused };
}

/** The production reading: the CDC slot on the primary (replicationSlotMonitor's query), RisingWave from this process. */
async function readGuards(writer: Database): Promise<ClosedServerPurgeGuardReading> {
  const rows = await writer.transaction(async (tx) => {
    await tx.execute(sql.raw(`SET LOCAL statement_timeout = '${STATEMENT_TIMEOUT}'`));
    return (await tx.execute(sql`
      SELECT wal_status, retained_wal_bytes FROM (${sql.raw(REPLICATION_SLOT_QUERY)}) slots
       WHERE slot_name = ${CDC_SLOT_NAME}`)).rows as Array<{ wal_status: string | null; retained_wal_bytes: number | string | null }>;
  });
  const row = rows[0];
  return {
    slot: row ? { walStatus: row.wal_status, retainedWalBytes: row.retained_wal_bytes === null ? null : Number(row.retained_wal_bytes) } : null,
    // Production has the slot (replicationSlotMonitor watches it there): not finding it means a wrong name or a dropped slot.
    slotRequired: process.env.DEPLOYMENT_ENV?.trim() === "production",
    rwOverloadedRecently: isRisingWaveOverloadSeenWithin(RW_OVERLOAD_WINDOW_MS),
  };
}

/** Where the job keeps its claim and its place in the pass. */
export interface ClosedServerPurgeState {
  /** True when this process may run now (no other run within the claim's TTL). */
  claimRun(): Promise<boolean>;
  /** True while the last full pass is resting. */
  passResting(): Promise<boolean>;
  markPassDone(): Promise<void>;
  /** The last server id done in this pass, or null at its start. */
  getCursor(): Promise<string | null>;
  setCursor(serverId: string | null): Promise<void>;
  /** Whether the delete's CDC slot pause holds (see closedServerPurgeGuardVerdict); absent: never held across runs. */
  slotPaused?(): Promise<boolean>;
  setSlotPaused?(paused: boolean): Promise<void>;
}

const CLAIM_KEY = "slock:closed-server-purge:claim";
const CURSOR_KEY = "slock:closed-server-purge:count:cursor";
const PASS_DONE_KEY = "slock:closed-server-purge:count:pass-done";
const SLOT_PAUSED_KEY = "slock:closed-server-purge:delete:slot-paused";

function redisState(): ClosedServerPurgeState {
  const redis = getRedis();
  return {
    async claimRun() {
      return (await redis.set(CLAIM_KEY, REPLICA_ID, "EX", CLAIM_TTL_SECONDS, "NX")) === "OK";
    },
    async passResting() {
      return (await redis.exists(PASS_DONE_KEY)) === 1;
    },
    async markPassDone() {
      await redis.set(PASS_DONE_KEY, "1", "EX", PASS_REST_SECONDS);
      await redis.del(CURSOR_KEY);
    },
    async getCursor() {
      return redis.get(CURSOR_KEY);
    },
    async setCursor(serverId) {
      if (serverId === null) await redis.del(CURSOR_KEY);
      else await redis.set(CURSOR_KEY, serverId, "EX", CURSOR_TTL_SECONDS);
    },
    async slotPaused() {
      return (await redis.exists(SLOT_PAUSED_KEY)) === 1;
    },
    async setSlotPaused(paused) {
      // A week at most: a forgotten pause must not hold the purge for good.
      if (paused) await redis.set(SLOT_PAUSED_KEY, "1", "EX", CURSOR_TTL_SECONDS);
      else await redis.del(SLOT_PAUSED_KEY);
    },
  };
}

/** One process, no Redis (dev, a single replica): the same rules, in memory. */
export function memoryClosedServerPurgeState(clock: () => Date = currentDate): ClosedServerPurgeState {
  let claimedUntil = 0;
  let restingUntil = 0;
  let cursor: string | null = null;
  let slotPaused = false;
  return {
    async claimRun() {
      const now = clock().getTime();
      if (now < claimedUntil) return false;
      claimedUntil = now + CLAIM_TTL_SECONDS * 1000;
      return true;
    },
    async passResting() {
      return clock().getTime() < restingUntil;
    },
    async markPassDone() {
      restingUntil = clock().getTime() + PASS_REST_SECONDS * 1000;
      cursor = null;
    },
    async getCursor() {
      return cursor;
    },
    async setCursor(serverId) {
      cursor = serverId;
    },
    async slotPaused() {
      return slotPaused;
    },
    async setSlotPaused(paused) {
      slotPaused = paused;
    },
  };
}

let processState: ClosedServerPurgeState | null = null;
function defaultState(): ClosedServerPurgeState {
  if (isRedisAvailable()) return redisState();
  processState ??= memoryClosedServerPurgeState();
  return processState;
}

/** What one server would lose. Attribute names as recorded. */
export type ClosedServerCounts = Record<string, number>;

export interface ClosedServerPurgeDeps {
  now?: () => Date;
  /** Where the counts are read; defaults to the replica when configured. */
  reader?: Database;
  /** Where `delete` reads its candidates and deletes; defaults to the primary. */
  writer?: Database;
  state?: ClosedServerPurgeState;
  apps?: readonly FirstPartyApp[];
  budgetMs?: number;
  /** Messages a run may delete (default MESSAGE_CAP_PER_RUN). */
  messageCap?: number;
  /** The first message batch's size (default MESSAGE_BATCH_START; adaptive after it). */
  messageBatch?: number;
  /** Test seam: the bridge clearing's rows per batch and table (default the row steps' 1,000). */
  bridgeRowBatch?: number;
  /** The delete's guard reading (default: the CDC slot and RisingWave, readGuards). */
  readGuards?: () => Promise<ClosedServerPurgeGuardReading>;
  hooks?: ClosedServerPurgeHooks;
  /**
   * Whether the count must read a separate read replica (default: in
   * production, DEPLOYMENT_ENV=production). getSearchDb() quietly returns the
   * primary when DATABASE_URL_READ_REPLICA is unset or equals DATABASE_URL, so
   * where a replica is required and there is none the run stops before it
   * reads anything (`replica_unavailable`) instead of counting on the primary.
   */
  replicaRequired?: boolean;
  /** The finish's steps (default CLOSED_SERVER_PURGE_FINISH_STEPS). */
  finishSteps?: readonly ClosedServerPurgeFinishStep[];
  /** The provider revoke calls (server.ts passes the Slack runtime's auth.revoke). */
  revokers?: ClosedServerPurgeRevokers;
}

export type ClosedServerPurgeStopReason =
  | "flag_off"
  | "replica_unavailable"
  | "quiet_time"
  | "claimed_elsewhere"
  | "pass_resting"
  | "pass_done"
  | "budget"
  | "timeout"
  | "error"
  | Exclude<ClosedServerPurgeGuardStop, "budget" | "quiet_time">;

export interface ClosedServerPurgeRunResult {
  /** `on` once the flag is on (each server then gets its own mode). */
  mode: "off" | "on";
  stoppedReason: ClosedServerPurgeStopReason;
  quietTime?: string;
  serversSeen: number;
  serversCounted: number;
  /** Per server counted (complete or not), in order. */
  counted: Array<{ serverId: ServerId; complete: boolean; counts: ClosedServerCounts }>;
  /** Per server the delete worked on (or tried to claim), in order. */
  purged: ClosedServerPurgeServerResult[];
}

class BudgetExhausted extends Error {}

/** A server's delete hit a statement or lock timeout (its error recorded, the server backed off): the run ends. */
class DeleteTimedOut extends Error {}

function snake(key: string): string {
  return key.replace(/[A-Z]/g, (c) => `_${c.toLowerCase()}`).replace(/[^a-z0-9_]/g, "_");
}

/**
 * The hourly maintenance entry. Returns without a query beyond the flag's row
 * while the flag is missing, disabled or killed.
 */
export async function runClosedServerPurge(deps: ClosedServerPurgeDeps = {}): Promise<ClosedServerPurgeRunResult> {
  const clock = deps.now ?? currentDate;
  const startedAt = clock();
  const result: ClosedServerPurgeRunResult = { mode: "off", stoppedReason: "flag_off", serversSeen: 0, serversCounted: 0, counted: [], purged: [] };

  const flag = await getFeatureFlag(CLOSED_SERVER_PURGE_FEATURE_FLAG_KEY);
  if (!flag || !flag.enabled || flag.killSwitch) return result;
  result.mode = "on";

  const reader = deps.reader ?? getSearchDb();
  const writer = deps.writer ?? getDb();
  const dbPath = deps.reader ? "injected" : reader === getDb() ? "primary" : "replica";
  let serversPartial = 0;
  let serversSkippedByFlag = 0;
  let serversInDeleteMode = 0;
  let serversDeleteNotServerRule = 0;
  let errorClass: string | undefined;
  let sqlstate = "";
  let lastReading: ClosedServerPurgeGuardReading | null = null;
  /** Servers in `rows_deleted` when the run started (read once the run holds the claim). */
  let rowsDeletedTotal: number | null = null;
  const deleted = { messages: 0, walBytes: 0 };
  const finish = (reason: ClosedServerPurgeStopReason) => {
    result.stoppedReason = reason;
    const outcomes = (outcome: string) => result.purged.filter((entry) => entry.outcome === outcome).length;
    const rowsDeletedMoves = () => result.purged.reduce((n, entry) => {
      const before = entry.claimedState === "rows_deleted";
      const after = entry.outcome !== "not_claimed" && entry.state === "rows_deleted";
      return n + (after && !before ? 1 : 0) - (before && !after ? 1 : 0);
    }, 0);
    recordTraceEvent(CLOSED_SERVER_PURGE_RUN_EVENT, {
      mode: result.mode,
      stopped_reason: reason,
      ...(result.quietTime ? { quiet_time: result.quietTime } : {}),
      db_path: dbPath,
      servers_seen: result.serversSeen,
      servers_counted: result.serversCounted,
      servers_partial: serversPartial,
      servers_skipped_by_flag: serversSkippedByFlag,
      servers_delete_mode: serversInDeleteMode,
      servers_delete_claimed: result.purged.filter((entry) => entry.outcome !== "not_claimed").length,
      // Left in rows_deleted by this run (reached it, or picked up there with a finish step not done).
      servers_rows_deleted: outcomes("rows_deleted"),
      servers_done: outcomes("done"),
      // Every server in `rows_deleted` now (all runs): the count at the start, plus what entered it, less what left it.
      ...(rowsDeletedTotal !== null ? { servers_in_rows_deleted: rowsDeletedTotal + rowsDeletedMoves() } : {}),
      servers_blocked: outcomes("blocked"),
      servers_delete_failed: outcomes("failed"),
      servers_delete_flag_off: outcomes("flag_off"),
      servers_delete_not_server_rule: serversDeleteNotServerRule,
      servers_delete_stopped: outcomes("stopped"),
      servers_delete_not_eligible: outcomes("not_eligible"),
      servers_delete_lease_lost: outcomes("lease_lost"),
      messages_deleted: deleted.messages,
      wal_bytes: deleted.walBytes,
      ...(lastReading?.slot?.retainedWalBytes != null ? { slot_retained_wal_bytes: lastReading.slot.retainedWalBytes } : {}),
      ...(lastReading?.slot?.walStatus ? { slot_wal_status: lastReading.slot.walStatus } : {}),
      ...(lastReading ? { rw_overloaded_recent: lastReading.rwOverloadedRecently } : {}),
      duration_ms: clock().getTime() - startedAt.getTime(),
      // Design, "Storage migration": the purge itself sends nothing to the old bucket (count or delete), so whether its key may delete is not known.
      old_bucket_delete_capability: "unknown",
      ...(errorClass ? { error_class: errorClass } : {}),
      ...(sqlstate ? { sqlstate } : {}),
    });
    return result;
  };

  // No silent fallback to the primary (Tenny, #55): without a separate replica
  // where one is required, stop here, before the claim and before any read.
  const replicaRequired = deps.replicaRequired ?? process.env.DEPLOYMENT_ENV?.trim() === "production";
  if (replicaRequired && dbPath === "primary") return finish("replica_unavailable");

  const quiet = closedServerPurgeQuietTime(startedAt);
  if (quiet) {
    result.quietTime = quiet;
    return finish("quiet_time");
  }
  const state = deps.state ?? defaultState();
  if (!(await state.claimRun())) return finish("claimed_elsewhere");

  const deadline = startedAt.getTime() + (deps.budgetMs ?? RUN_BUDGET_MS);
  const checkTime = () => {
    if (clock().getTime() >= deadline) throw new BudgetExhausted();
    const q = closedServerPurgeQuietTime(clock());
    if (q) {
      result.quietTime = q;
      throw new BudgetExhausted();
    }
  };
  const apps = deps.apps ?? firstPartyApps();

  try {
    await runDeletePhase();
    if (await state.passResting()) return finish("pass_resting");
    if (!(await runCountPhase())) return finish("flag_off");
    return finish("pass_done");
  } catch (error) {
    if (error instanceof BudgetExhausted) return finish(result.quietTime ? "quiet_time" : "budget");
    if (error instanceof ClosedServerPurgeRunStop) return finish(error.reason);
    if (error instanceof DeleteTimedOut) return finish("timeout");
    sqlstate = sqlstateOf(error);
    errorClass = errorClassOf(error);
    if (sqlstate === "57014" || sqlstate === "55P03") return finish("timeout");
    finish("error");
    throw error;
  }

  /** Servers the flag puts in `delete`, not yet purged and not held by another run: purge each as far as the run gets. */
  async function runDeletePhase(): Promise<void> {
    const [inRowsDeleted] = await writer.select({ n: sql<number>`count(*)::int` }).from(servers).where(eq(servers.purgeState, "rows_deleted"));
    rowsDeletedTotal = Number(inRowsDeleted?.n ?? 0);
    let paused = (await state.slotPaused?.()) ?? false;
    const ctx: ClosedServerPurgeRunContext = {
      writer,
      clock,
      apps,
      messagesLeft: deps.messageCap ?? MESSAGE_CAP_PER_RUN,
      messageBatch: deps.messageBatch ?? MESSAGE_BATCH_START,
      bridgeRowBatch: deps.bridgeRowBatch,
      hooks: deps.hooks,
      finishSteps: deps.finishSteps,
      revokers: deps.revokers,
      // Before every batch: a kill switch or a changed rule takes effect at the next batch, not the next server.
      stillDelete: async (serverId) => {
        const [live] = await evaluateFeatureFlags([{ key: CLOSED_SERVER_PURGE_FEATURE_FLAG_KEY, serverId }]);
        return closedServerPurgeModeOf(live!) === "delete";
      },
      beforeBatch: async () => {
        try {
          checkTime();
        } catch (error) {
          if (error instanceof BudgetExhausted) throw new ClosedServerPurgeRunStop(result.quietTime ? "quiet_time" : "budget");
          throw error;
        }
        const reading = await (deps.readGuards ? deps.readGuards() : readGuards(writer));
        lastReading = reading;
        const verdict = closedServerPurgeGuardVerdict(reading, paused);
        if (verdict.paused !== paused) {
          paused = verdict.paused;
          await state.setSlotPaused?.(paused);
        }
        if (verdict.stop) throw new ClosedServerPurgeRunStop(verdict.stop);
      },
    };
    const tally = (entry: ClosedServerPurgeServerResult, serverStarted: number) => {
      result.purged.push(entry);
      deleted.messages += entry.counts.messages_deleted ?? 0;
      deleted.walBytes += entry.counts.wal_bytes ?? 0;
      if (entry.outcome === "not_claimed") return;
      recordTraceEvent(CLOSED_SERVER_PURGE_DELETE_SERVER_EVENT, {
        server_id: entry.serverId,
        outcome: entry.outcome,
        ...(entry.state ? { purge_state: entry.state } : {}),
        ...(entry.stopReason ? { stop_reason: entry.stopReason } : {}),
        ...(entry.errorClass ? { error_class: entry.errorClass } : {}),
        ...(entry.sqlstate ? { sqlstate: entry.sqlstate } : {}),
        duration_ms: clock().getTime() - serverStarted,
        ...entry.counts,
      });
    };

    let cursor: string | null = null;
    for (;;) {
      const now = clock();
      const after: string | null = cursor;
      const page: Array<{ id: string }> = await writer.select({ id: servers.id }).from(servers)
        .where(and(
          closedServerPurgeEligibleSql(closedServerPurgeCutoff(now)),
          closedServerPurgeOpenSql(),
          or(isNull(servers.purgeLeaseUntil), lte(servers.purgeLeaseUntil, now)),
          ...(after ? [gt(servers.id, after)] : []),
        ))
        .orderBy(asc(servers.id))
        .limit(SERVER_PAGE);
      if (page.length === 0) return;
      cursor = page[page.length - 1]!.id;
      const evaluations = await evaluateFeatureFlags(page.map((row) => ({ key: CLOSED_SERVER_PURGE_FEATURE_FLAG_KEY, serverId: row.id })));
      for (const [index, row] of page.entries()) {
        if (closedServerPurgeDeleteNotServerRule(evaluations[index]!)) {
          // Counted by the count pass instead; said once a run, and on the run event.
          if (serversDeleteNotServerRule === 0) console.warn("[ClosedServerPurge] the `delete` variant reached a server other than through a server rule: counted, not purged");
          serversDeleteNotServerRule += 1;
        }
        if (closedServerPurgeModeOf(evaluations[index]!) !== "delete") continue;
        serversInDeleteMode += 1;
        // Again right before the claim: a kill switch or a variant changed since the page was read stops it here.
        const [live] = await evaluateFeatureFlags([{ key: CLOSED_SERVER_PURGE_FEATURE_FLAG_KEY, serverId: row.id }]);
        if (closedServerPurgeModeOf(live!) !== "delete") continue;
        const serverId = asServerId(row.id);
        const serverStarted = clock().getTime();
        const entry = await purgeClosedServer(ctx, serverId);
        tally(entry, serverStarted);
        if (entry.outcome === "stopped") throw new ClosedServerPurgeRunStop(entry.stopReason!);
        if (entry.outcome === "failed") {
          console.warn(`[ClosedServerPurge] delete failed for server ${serverId}, backed off:`, entry.errorClass, entry.sqlstate);
          if (isPurgeTimeout(entry.sqlstate ?? "")) {
            errorClass = entry.errorClass;
            sqlstate = entry.sqlstate ?? "";
            throw new DeleteTimedOut();
          }
        }
      }
    }
  }

  /**
   * The count pass over every eligible server, resuming from its cursor.
   * False when the flag was turned off (disabled, killed or removed) mid-pass:
   * the run then ends at that page with the cursor where it was, so the
   * servers after it are counted when the flag is back, not skipped as
   * "off for this server" and the pass marked done (production 2026-11-10:
   * a kill switch 8 s before the run ended skipped 601 servers).
   */
  async function runCountPhase(): Promise<boolean> {
    let cursor = await state.getCursor();
    for (;;) {
      // The pass's first server in a run always starts, so one that alone outlasts a run can't stall the pass.
      if (result.counted.length > 0) checkTime();
      const live = await getFeatureFlag(CLOSED_SERVER_PURGE_FEATURE_FLAG_KEY);
      if (!live || !live.enabled || live.killSwitch) return false;
      const cutoff = closedServerPurgeCutoff(clock());
      const after = cursor;
      const page = await readOnly(reader, (tx) => tx.select({ id: servers.id }).from(servers)
        .where(and(
          closedServerPurgeEligibleSql(cutoff),
          ...(after ? [gt(servers.id, after)] : []),
        ))
        .orderBy(asc(servers.id))
        .limit(SERVER_PAGE));
      if (page.length === 0) {
        await state.markPassDone();
        return true;
      }
      const evaluations = await evaluateFeatureFlags(page.map((row) => ({ key: CLOSED_SERVER_PURGE_FEATURE_FLAG_KEY, serverId: row.id })));
      for (const [index, row] of page.entries()) {
        result.serversSeen += 1;
        const mode = closedServerPurgeModeOf(evaluations[index]!);
        if (mode !== "count") {
          // Off, or `delete` (the delete phase's): not counted.
          serversSkippedByFlag += 1;
          cursor = row.id;
          await state.setCursor(cursor);
          continue;
        }
        const serverId = asServerId(row.id);
        const serverStarted = clock().getTime();
        const counts: ClosedServerCounts = {};
        let complete = true;
        try {
          await countServer(reader, serverId, apps, counts, checkTime);
        } catch (error) {
          if (!(error instanceof BudgetExhausted)) throw error;
          // A server that alone outlasts a whole run's budget is reported as far as it got, and the pass moves on.
          if (result.counted.length > 0 || result.quietTime) throw error;
          complete = false;
        }
        result.counted.push({ serverId, complete, counts });
        if (complete) result.serversCounted += 1;
        else serversPartial += 1;
        recordTraceEvent(CLOSED_SERVER_PURGE_SERVER_EVENT, {
          server_id: serverId,
          complete,
          duration_ms: clock().getTime() - serverStarted,
          ...counts,
        });
        cursor = row.id;
        await state.setCursor(cursor);
        if (!complete) throw new BudgetExhausted();
      }
    }
  }
}

/** One short READ ONLY transaction under the job's timeouts. */
async function readOnly<T>(reader: Database, work: (tx: DatabaseExecutor) => PromiseLike<T>): Promise<T> {
  return reader.transaction(async (tx) => {
    await tx.execute(sql`SET TRANSACTION READ ONLY`);
    await tx.execute(sql.raw(`SET LOCAL statement_timeout = '${STATEMENT_TIMEOUT}'`));
    await tx.execute(sql.raw(`SET LOCAL lock_timeout = '${LOCK_TIMEOUT}'`));
    return work(tx);
  });
}

const rowsOf = (result: unknown) => (result as { rows: Array<Record<string, unknown>> }).rows;
const add = (counts: ClosedServerCounts, key: string, n: number) => {
  counts[key] = (counts[key] ?? 0) + n;
};

/** Fill `counts` for one closed server; `checkTime` throws when the run must stop. */
export async function countServer(
  reader: Database,
  serverId: ServerId,
  apps: readonly FirstPartyApp[],
  counts: ClosedServerCounts,
  checkTime: () => void = () => {},
): Promise<void> {
  for (const key of ["channels", "channels_skipped_joint", "channels_skipped_receipt", "messages", "attachments", "attachment_objects", "attachment_bytes", "tasks", "object_events", "apps_failed"]) {
    counts[key] = 0;
  }

  // Apps first, as the purge will (design: before the channel pass).
  for (const app of apps) {
    if (!app.purgeServer) continue;
    checkTime();
    try {
      const answer = await readOnly(reader, (executor) => app.purgeServer!(serverId, { executor, limit: 0, mode: "count" }));
      for (const [key, n] of Object.entries(answer.counts)) counts[`app_${snake(app.id)}_${snake(key)}`] = n;
    } catch (error) {
      const code = sqlstateOf(error);
      if (code === "57014" || code === "55P03") throw error;
      counts.apps_failed! += 1;
      console.warn(`[ClosedServerPurge] ${app.id} count failed for server ${serverId}:`, errorClassOf(error));
    }
  }

  // What the purge skips: joint projections and receipt channels, and what hangs under them.
  checkTime();
  const { joint, receipt } = await readOnly(reader, async (tx) => ({
    joint: new Set((await tx.select({ id: jointChannelServers.localChannelId }).from(jointChannelServers)
      .where(eq(jointChannelServers.serverId, serverId))).map((row) => row.id)),
    receipt: new Set((await tx.select({ id: agentMigrationReceiptChannels.channelId }).from(agentMigrationReceiptChannels)
      .where(eq(agentMigrationReceiptChannels.serverId, serverId))).map((row) => row.id)),
  }));

  let channelCursor: string | null = null;
  for (;;) {
    checkTime();
    const after: string | null = channelCursor;
    const chunk: Array<{ id: string; parentChannelId: string | null }> = await readOnly(reader, (tx) => tx.select({ id: channels.id, parentChannelId: channels.parentChannelId }).from(channels)
      .where(and(eq(channels.serverId, serverId), ...(after ? [gt(channels.id, after)] : [])))
      .orderBy(asc(channels.id))
      .limit(CHANNEL_CHUNK));
    if (chunk.length === 0) break;
    channelCursor = chunk[chunk.length - 1]!.id;
    const kept: string[] = [];
    for (const channel of chunk) {
      const parent = channel.parentChannelId;
      if (joint.has(channel.id) || (parent && joint.has(parent))) counts.channels_skipped_joint! += 1;
      else if (receipt.has(channel.id) || (parent && receipt.has(parent))) counts.channels_skipped_receipt! += 1;
      else kept.push(channel.id);
    }
    if (kept.length === 0) continue;
    counts.channels! += kept.length;

    checkTime();
    await readOnly(reader, async (tx) => {
      const [taskRow] = await tx.select({ n: sql<number>`count(*)::int` }).from(tasks).where(inArray(tasks.channelId, kept));
      add(counts, "tasks", Number(taskRow?.n ?? 0));
      const [attachmentRow] = await tx.select({ n: sql<number>`count(*)::int` }).from(attachments).where(inArray(attachments.channelId, kept));
      add(counts, "attachments", Number(attachmentRow?.n ?? 0));
      const objectIds = tx.selectDistinct({ id: attachments.objectId }).from(attachments).where(inArray(attachments.channelId, kept));
      const [objectRow] = await tx.select({ n: sql<number>`count(*)::int`, bytes: sql<string>`coalesce(sum(${attachmentObjects.sizeBytes}), 0)::text` })
        .from(attachmentObjects).where(inArray(attachmentObjects.id, objectIds));
      add(counts, "attachment_objects", Number(objectRow?.n ?? 0));
      add(counts, "attachment_bytes", Number(objectRow?.bytes ?? 0));
    });

    for (const channelId of kept) {
      checkTime();
      add(counts, "messages", await countChannelMessages(reader, channelId));
    }
  }

  // object_events by server, chunked on (server_id, seq).
  let seqCursor = 0;
  for (;;) {
    checkTime();
    const after = seqCursor;
    const [row] = rowsOf(await readOnly(reader, (tx) => tx.execute(sql`
      SELECT count(*)::int AS n, max(seq)::text AS last FROM (
        SELECT seq FROM object_events WHERE server_id = ${serverId} AND seq > ${after} ORDER BY seq LIMIT ${OBJECT_EVENT_CHUNK}
      ) chunk`)));
    const n = Number(row?.n ?? 0);
    add(counts, "object_events", n);
    if (n < OBJECT_EVENT_CHUNK) break;
    seqCursor = Number(row!.last);
  }

  // The finish's server_rows tables, with the delete's own scope (header).
  checkTime();
  const kept = await readOnly(reader, (tx) => keptChannelsOf(tx, serverId));
  for (const entry of closedServerPurgeRowDeletes()) {
    checkTime();
    const [row] = rowsOf(await readOnly(reader, (tx) => tx.execute(sql`
      SELECT count(*)::int AS n FROM (
        SELECT 1 FROM ${sql.identifier(entry.table)} t WHERE ${closedServerPurgeRowScope(entry, serverId, kept.all)} LIMIT ${ROW_COUNT_CAP}
      ) capped`)));
    counts[`rows_${entry.table}`] = Number(row?.n ?? 0);
  }

  checkTime();
  const [ownApps] = rowsOf(await readOnly(reader, (tx) => tx.execute(sql`
    SELECT (SELECT count(*)::int FROM oauth_clients c WHERE ${ownAppNeverSharedSql(serverId)}) AS deletable,
           (SELECT count(*)::int FROM oauth_clients c WHERE c.server_id = ${serverId}) AS owned`)));
  counts.own_apps_deletable = Number(ownApps?.deletable ?? 0);
  counts.own_apps_kept = Number(ownApps?.owned ?? 0) - counts.own_apps_deletable;
  checkTime();
  const keptIds = kept.all;
  const [bridged] = rowsOf(await readOnly(reader, (tx) => tx.execute(sql`
    SELECT count(DISTINCT channel_id)::int AS n FROM (
      SELECT b.channel_id FROM external_channel_bindings b JOIN channels ch ON ch.id = b.channel_id WHERE ch.server_id = ${serverId}
      UNION ALL
      SELECT e.raft_channel_id FROM external_inbound_events e JOIN channels ch ON ch.id = e.raft_channel_id WHERE ch.server_id = ${serverId}
    ) bound
    ${keptIds.length > 0 ? sql`WHERE channel_id NOT IN (${sql.join(keptIds.map((id) => sql`${id}::uuid`), sql`, `)})` : sql``}`)));
  counts.channels_bridged = Number(bridged?.n ?? 0);
}

/**
 * A channel's messages (soft-deleted ones too: the purge deletes rows), in
 * chunks of MESSAGE_CHUNK on idx_messages_channel_created_at, keyed on
 * (created_at, id) with created_at carried as text so no microsecond is lost.
 */
async function countChannelMessages(reader: Database, channelId: string): Promise<number> {
  return readOnly(reader, async (tx) => {
    let total = 0;
    let after: { createdAt: string; id: string } | null = null;
    for (;;) {
      const keyset = after
        ? sql`AND created_at >= ${after.createdAt}::timestamptz AND (created_at, id) > (${after.createdAt}::timestamptz, ${after.id}::uuid)`
        : sql``;
      const [row] = rowsOf(await tx.execute(sql`
        WITH chunk AS (
          SELECT created_at, id FROM messages WHERE channel_id = ${channelId} ${keyset}
          ORDER BY created_at, id LIMIT ${MESSAGE_CHUNK}
        ), last AS (SELECT created_at, id FROM chunk ORDER BY created_at DESC, id DESC LIMIT 1)
        SELECT (SELECT count(*)::int FROM chunk) AS n, (SELECT created_at::text FROM last) AS created_at, (SELECT id::text FROM last) AS id`));
      const n = Number(row?.n ?? 0);
      total += n;
      if (n < MESSAGE_CHUNK) return total;
      after = { createdAt: String(row!.created_at), id: String(row!.id) };
    }
  });
}
