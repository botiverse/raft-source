// Closed-server purge, `delete` mode: clearing one closed server for good
// (design "Purging closed servers 30 days after closing" v6, "What is
// cleared, and how" and "Running it safely"). Irreversible: every step
// here deletes production data. The run that calls it (closedServerPurge.ts)
// reaches it only for a server the `closed_server_purge` flag gives the
// variant `delete` through a rule naming that server, never by default; the
// flag is evaluated again before every batch (ctx.stillDelete), so a kill
// switch or a changed rule stops the purge at the next batch.
//
// Who: exactly the servers count mode counts (closedServerPurgeEligibleSql:
// `kind = 'normal'`, closed more than 30 days ago), not yet purged.
//
// Lease: a run claims a server (purge_lease_until, purge_lease_token on
// servers; SKIP LOCKED, so two runs never wait on each other), and every
// batch transaction first takes the server row FOR NO KEY UPDATE and checks
// that the lease is still this run's, that the server is still eligible
// (a server reopened since the claim is not touched, and its purge_state is
// cleared so a later close starts again from the apps) and not purged. Each
// batch is one short transaction under SET LOCAL lock_timeout 2s and
// statement_timeout 10s; the run's guards (budget, quiet times, message cap,
// CDC slot, RisingWave) are checked before every batch.
//
// One server's failure is that server's: any error in its steps (a
// statement or lock timeout, an app refusing, a foreign key outside the
// channel step) backs the server off for PURGE_ERROR_RETRY_MS (lease pushed
// out, no token; purge_state stays the step, so the retry resumes there) and
// the run goes on to the next server; a timeout still ends the run (the
// primary is under load), but the next run starts past that server. Only an
// error of the run itself (its guard reading, the flag's) leaves the server
// as it was, its lease released.
//
// Progress: servers.purge_state is the step the server is on; every step is
// idempotent (it deletes what is still there), so a crash or a stop resumes
// at the step and simply finds less. Kept throughout (keptChannelsOf):
// joint projections, migration receipt channels, `joint` channels, a channel
// a joint channel names as canonical, and every channel under one of those:
// other servers still see what is in them. The steps, in order:
//  1. apps: each first-party app's purgeServer(`delete`) until nothing is
//     left, told the kept channels (keepChannelIds): an app object homed in
//     one stays (Artifacts: its items and, by cascade, all their parts;
//     bytes are left to the app's own jobs).
//  2. channels: channel by channel, children (threads, task conversations)
//     before their parent, the kept ones skipped. For each channel:
//     messages in batches by (created_at, id), each batch one transaction
//     that removes the batch's attachments' holds
//     (removeAttachmentObjectHoldsWithExecutor), deletes those attachment
//     rows (their preview cache and comment refs by cascade), clears
//     tasks.message_id, deletes the messages (translations, reactions,
//     mentions, timeline, inbox facts, notification outbox, saves, action
//     cards by cascade; search is in-row) and then queues each object nothing
//     refers to any more for the attachment GC, an object with a copy in the
//     old CDN bucket like any other (owner decision, 2026-11-10: the old
//     bucket is treated as gone; this job sends it nothing). So an object's
//     bytes are only ever deleted (by runAttachmentLifecycleSweep) after the
//     commit that removed every row derived from it; an object still held
//     elsewhere (a forwarded copy has its own hold) is not queued. Then the
//     channel's remaining attachments, workflow instances, tasks (only those
//     whose conversation is gone), lounge row, external invites and connect
//     requests, and the channel row (the rest of its rows go by cascade).
//     A channel ever bound to a bridge (Slack) first loses its bridge rows,
//     leaves first (closedServerPurgeBridgeBlockers.ts: bindings in any
//     state, inbound events, deliveries, links, facts), ROW_BATCH rows a
//     batch (a delivery partition with its deliveries in one), then is
//     cleared like any other. A channel this version can't clear is left as
//     it is and counted: a Guest's channel (server_members.guest_channel_id: the
//     membership is kept, and freeing a Guest's channel is a product
//     decision), refused by any other foreign key (23503: the batch rolls
//     back), or with a child left.
//     Then the server goes to `blocked` and is retried a day later; the
//     steps after the channels wait for it.
//  3. object_events: the server's object events by server_id in batches,
//     each with the object_inbox_states of the same objects.
//  4. agents: the server's agents' agent_activity_summary_v2 rows.
//  5. scrub: the tombstone's name and avatar; the slug stays reserved; the
//     avatars are in the old CDN bucket (avatars/server-<id>/,
//     avatars/<id>/) and are not deleted, only counted
//     (old_bucket_avatars_skipped); then `rows_deleted`, purged_at still
//     NULL.
//  6. rows_deleted: the finish (closedServerPurgeFinish.ts), in the same
//     claim: hosted runtimes, the WeChat bridge, the classified server rows,
//     credential revokes, the system uninstall of every app install, the
//     Slack bridge, the agents' tombstones. When every step is done:
//     purged_at and `done`; while one waits (a failed provider revoke, an
//     agent mid-migration), the server stays in `rows_deleted` and waits
//     PURGE_FINISH_RETRY_MS (lease, no token), so a server an earlier
//     version left there is picked up the same way.
// Never deleted: the servers row, billing and audit rows, migration receipt
// channels, joint channels.
import { randomUUID } from "node:crypto";
import { and, asc, eq, gt, inArray, isNotNull, isNull, lt, lte, ne, or, sql, type SQL } from "drizzle-orm";
import type { ServerId } from "@botiverse/raft-shared";
import type { Database, DatabaseExecutor } from "../db/index";
import {
  agentLounges,
  agentMigrationReceiptChannels,
  attachments,
  channelExternalInvites,
  channels,
  channelServerConnectRequests,
  jointChannels,
  jointChannelServers,
  messages,
  serverMembers,
  servers,
  tasks,
  workflowInstances,
} from "../db/schema";
import type { FirstPartyApp } from "../platform/apps";
import {
  claimObjectGcIfUnreferencedWithExecutor,
  resolveAttachmentLifecycleDatabaseNow,
} from "./attachmentLifecycleService";
import { removeAttachmentObjectHoldsWithExecutor } from "./attachmentObjectHoldService";
import { errorClassOf } from "../tracing/semanticTrace";
import { channelHasBridgeRows, clearChannelBridgeRows } from "./closedServerPurgeBridgeBlockers";
import { CLOSED_SERVER_PURGE_FINISH_STEPS, finishClosedServerPurge, type ClosedServerPurgeFinishStep } from "./closedServerPurgeFinish";
import type { ClosedServerPurgeRevokers } from "./closedServerPurgeRevoke";

const DAY_MS = 24 * 3_600_000;
/** A server is purged this long after it was closed. */
export const CLOSED_SERVER_PURGE_AFTER_MS = 30 * DAY_MS;

/**
 * The servers a purge is for, count and delete alike: `kind = 'normal'`,
 * closed (`deleted_at`) before `cutoff` (now - CLOSED_SERVER_PURGE_AFTER_MS).
 */
export function closedServerPurgeEligibleSql(cutoff: Date): SQL {
  return and(eq(servers.kind, "normal"), isNotNull(servers.deletedAt), lt(servers.deletedAt, cutoff))!;
}

export const closedServerPurgeCutoff = (now: Date) => new Date(now.getTime() - CLOSED_SERVER_PURGE_AFTER_MS);

export const STATEMENT_TIMEOUT = "10s";
export const LOCK_TIMEOUT = "2s";
/** How long a claim holds a server: longer than a run (5 minutes) and its last batch. */
export const PURGE_LEASE_MS = 10 * 60_000;
/** How long a `blocked` server waits before it is tried again. */
export const PURGE_BLOCKED_RETRY_MS = DAY_MS;
/** How long a `rows_deleted` server with a finish step not done waits before it is tried again. */
export const PURGE_FINISH_RETRY_MS = DAY_MS;
/** How long a server whose purge failed (its own error) waits before it is tried again. */
export const PURGE_ERROR_RETRY_MS = DAY_MS;
const APP_BATCH = 100;
const CHANNEL_PAGE = 500;
const ROW_BATCH = 1_000;
/** Adaptive message batches (AndyLok): start at 200, double under 1 s (cap 1,000), halve over 3 s. */
export const MESSAGE_BATCH_START = 200;
const MESSAGE_BATCH_MAX = 1_000;
const MESSAGE_BATCH_MIN = 25;
const SCRUBBED_SERVER_NAME = "Closed server";

export type ClosedServerPurgeState = "apps" | "channels" | "object_events" | "agents" | "scrub" | "blocked" | "rows_deleted" | "done";

/**
 * A server the delete may still work on: not purged and not `done`
 * (`rows_deleted` is open: the finish picks it up). Candidates, the claim and
 * every batch's re-check use it.
 */
export function closedServerPurgeOpenSql(): SQL {
  return and(isNull(servers.purgedAt), or(isNull(servers.purgeState), ne(servers.purgeState, "done")))!;
}

/** Why a run stopped before the work ran out (thrown by the run's guard). */
export type ClosedServerPurgeGuardStop =
  | "budget"
  | "quiet_time"
  | "message_cap"
  | "slot_paused"
  | "slot_stopped"
  | "slot_wal_status"
  | "slot_missing"
  | "rw_overloaded";

export class ClosedServerPurgeRunStop extends Error {
  constructor(readonly reason: ClosedServerPurgeGuardStop) {
    super(`closed-server purge stopped: ${reason}`);
    this.name = "ClosedServerPurgeRunStop";
  }
}

/** The lease is gone or the server is no longer eligible: this run stops touching it. */
class LeaseCheckFailed extends Error {
  constructor(readonly outcome: "lease_lost" | "not_eligible") {
    super(outcome);
  }
}

/** The flag no longer gives this server `delete`: this run stops touching it. */
class FlagTurnedOff extends Error {}

/** An error of the run's own checks (guard reading, flag), not of the server: it doesn't back the server off. */
class RunCheckFailed extends Error {
  constructor(readonly original: unknown) {
    super("closed-server purge run check failed");
  }
}

const STATEMENT_TIMEOUT_SQLSTATE = "57014";
const LOCK_TIMEOUT_SQLSTATE = "55P03";
/** A statement or lock timeout: the run's stop rule, as in count mode. */
export const isPurgeTimeout = (sqlstate: string) => sqlstate === STATEMENT_TIMEOUT_SQLSTATE || sqlstate === LOCK_TIMEOUT_SQLSTATE;

export function sqlstateOf(error: unknown): string {
  let current: unknown = error;
  for (let depth = 0; current && depth < 5; depth += 1) {
    const code = (current as { code?: unknown }).code;
    if (typeof code === "string" && /^[0-9A-Z]{5}$/.test(code)) return code;
    current = (current as { cause?: unknown }).cause;
  }
  return "";
}

const FOREIGN_KEY_VIOLATION = "23503";

export interface ClosedServerPurgeRunContext {
  writer: Database;
  clock: () => Date;
  apps: readonly FirstPartyApp[];
  /** Throws ClosedServerPurgeRunStop when the run must stop; awaited before every batch. */
  beforeBatch: () => Promise<void>;
  /** Whether the flag still gives this server `delete`; asked before every batch, after beforeBatch. */
  stillDelete: (serverId: ServerId) => Promise<boolean>;
  /** What the run may still delete (shared by its servers). */
  messagesLeft: number;
  /** The adaptive message batch size, carried across servers. */
  messageBatch: number;
  /** Test seam: the rows a bridge-clearing batch deletes from one table (default ROW_BATCH). */
  bridgeRowBatch?: number;
  hooks?: ClosedServerPurgeHooks;
  /** The finish's steps (default CLOSED_SERVER_PURGE_FINISH_STEPS). */
  finishSteps?: readonly ClosedServerPurgeFinishStep[];
  /** The provider revoke calls the finish makes (closedServerPurgeRevoke.ts). */
  revokers?: ClosedServerPurgeRevokers;
}

/** Test seams: called at the named points of a server's purge. */
export interface ClosedServerPurgeHooks {
  afterClaim?(serverId: ServerId): Promise<void>;
  /** In every batch's transaction, after the lease check, before its work; `state` is the step. */
  inBatch?(serverId: ServerId, state: ClosedServerPurgeState): Promise<void>;
}

/**
 * `done`: purged (purged_at set); `rows_deleted`: a finish step is not done,
 * the server waits PURGE_FINISH_RETRY_MS; `failed`: this server's own error,
 * the server backed off PURGE_ERROR_RETRY_MS; `flag_off`: the flag stopped
 * giving it `delete`.
 */
export type ClosedServerPurgeOutcome = "done" | "rows_deleted" | "blocked" | "failed" | "flag_off" | "stopped" | "lease_lost" | "not_eligible" | "not_claimed";

export interface ClosedServerPurgeServerResult {
  serverId: ServerId;
  outcome: ClosedServerPurgeOutcome;
  /** purge_state after this run's work on it. */
  state: ClosedServerPurgeState | null;
  /** purge_state the claim found (resumed at), null when not claimed. */
  claimedState?: ClosedServerPurgeState | null;
  stopReason?: ClosedServerPurgeGuardStop;
  /** `failed`: the error's class and SQLSTATE (empty when it has none). */
  errorClass?: string;
  sqlstate?: string;
  counts: Record<string, number>;
}

const rowsOf = <T>(result: unknown) => (result as { rows: T[] }).rows;
const snake = (key: string) => key.replace(/[A-Z]/g, (c) => `_${c.toLowerCase()}`).replace(/[^a-z0-9_]/g, "_");

/**
 * Purge one closed server as far as this run gets. Never throws for the
 * server's own sake: a lost lease, a server no longer eligible (its progress
 * cleared), the flag turned off, the run's stop (outcome `stopped`, with its
 * reason: the caller ends the run) and the server's own error (`failed`:
 * backed off PURGE_ERROR_RETRY_MS; the caller ends the run on a timeout) are
 * answers. Only an error of the run's own checks is rethrown, the lease
 * released.
 */
export async function purgeClosedServer(ctx: ClosedServerPurgeRunContext, serverId: ServerId): Promise<ClosedServerPurgeServerResult> {
  const counts: Record<string, number> = {};
  const add = (key: string, n: number) => {
    counts[key] = (counts[key] ?? 0) + n;
  };
  const token = randomUUID();
  const result: ClosedServerPurgeServerResult = { serverId, outcome: "not_claimed", state: null, counts };

  const claimed = await claim(ctx, serverId, token);
  if (!claimed) return result;
  result.state = claimed;
  result.claimedState = claimed;
  let state: ClosedServerPurgeState = claimed;

  /** One batch: its own transaction, the lease and eligibility checked under the server row's lock first. */
  const batch = async <T>(work: (tx: DatabaseExecutor) => Promise<T>): Promise<T> => {
    let deleteStill: boolean;
    try {
      await ctx.beforeBatch();
      deleteStill = await ctx.stillDelete(serverId);
    } catch (error) {
      if (error instanceof ClosedServerPurgeRunStop) throw error;
      throw new RunCheckFailed(error);
    }
    if (!deleteStill) throw new FlagTurnedOff();
    return ctx.writer.transaction(async (tx) => {
      await tx.execute(sql.raw(`SET LOCAL statement_timeout = '${STATEMENT_TIMEOUT}'`));
      await tx.execute(sql.raw(`SET LOCAL lock_timeout = '${LOCK_TIMEOUT}'`));
      const now = ctx.clock();
      const [held] = await tx.select({ id: servers.id }).from(servers)
        .where(and(
          eq(servers.id, serverId),
          eq(servers.purgeLeaseToken, token),
          gt(servers.purgeLeaseUntil, now),
          closedServerPurgeOpenSql(),
          closedServerPurgeEligibleSql(closedServerPurgeCutoff(now)),
        ))
        .for("no key update");
      if (!held) {
        const [mine] = await tx.select({ id: servers.id }).from(servers)
          .where(and(eq(servers.id, serverId), eq(servers.purgeLeaseToken, token), gt(servers.purgeLeaseUntil, now)));
        throw new LeaseCheckFailed(mine ? "not_eligible" : "lease_lost");
      }
      await ctx.hooks?.inBatch?.(serverId, state);
      const [walBefore] = rowsOf<{ lsn: string }>(await tx.execute(sql`SELECT pg_current_wal_lsn()::text AS lsn`));
      const answer = await work(tx);
      const [wal] = rowsOf<{ bytes: number | string }>(await tx.execute(sql`SELECT pg_wal_lsn_diff(pg_current_wal_lsn(), ${walBefore!.lsn}::pg_lsn)::float8 AS bytes`));
      add("wal_bytes", Math.max(0, Number(wal?.bytes ?? 0)));
      add("batches", 1);
      return answer;
    });
  };
  const setState = (tx: DatabaseExecutor, next: ClosedServerPurgeState) =>
    tx.update(servers).set({ purgeState: next }).where(eq(servers.id, serverId));

  try {
    await ctx.hooks?.afterClaim?.(serverId);
    // What other servers still see, kept by every step (header).
    const kept = await batch((tx) => keptChannelsOf(tx, serverId));

    if (state === "apps") {
      for (const app of ctx.apps) {
        if (!app.purgeServer) continue;
        for (;;) {
          const answer = await batch((executor) => app.purgeServer!(serverId, { executor, limit: APP_BATCH, mode: "delete", keepChannelIds: kept.all }));
          for (const [key, n] of Object.entries(answer.counts)) add(`app_${snake(app.id)}_${snake(key)}`, n);
          if (!answer.remaining) break;
        }
      }
      state = "channels";
      await batch((tx) => setState(tx, state));
    }

    if (state === "channels") {
      const blocked = await purgeChannels(ctx, serverId, kept, batch, add);
      if (blocked) {
        state = "blocked";
        await batch((tx) => tx.update(servers).set({
          purgeState: "blocked",
          purgeLeaseUntil: new Date(ctx.clock().getTime() + PURGE_BLOCKED_RETRY_MS),
          purgeLeaseToken: null,
        }).where(eq(servers.id, serverId)));
        result.outcome = "blocked";
        result.state = state;
        return result;
      }
      state = "object_events";
      await batch((tx) => setState(tx, state));
    }

    if (state === "object_events") {
      for (;;) {
        const n = await batch(async (tx) => {
          const chunk = rowsOf<{ id: string; object_kind: string; object_id: string }>(await tx.execute(sql`
            SELECT id::text, object_kind, object_id FROM object_events
             WHERE server_id = ${serverId} ORDER BY seq LIMIT ${ROW_BATCH}`));
          if (chunk.length === 0) return 0;
          const pairs = [...new Map(chunk.map((row) => [`${row.object_kind}\u0000${row.object_id}`, row])).values()];
          const states = rowsOf<unknown>(await tx.execute(sql`
            DELETE FROM object_inbox_states
             WHERE server_id = ${serverId}
               AND (object_kind, object_id) IN (${sql.join(pairs.map((row) => sql`(${row.object_kind}, ${row.object_id})`), sql`, `)})
            RETURNING 1`));
          add("object_inbox_states_deleted", states.length);
          const deleted = rowsOf<unknown>(await tx.execute(sql`
            DELETE FROM object_events WHERE id IN (${sql.join(chunk.map((row) => sql`${row.id}::uuid`), sql`, `)}) RETURNING 1`));
          add("object_events_deleted", deleted.length);
          return chunk.length;
        });
        if (n < ROW_BATCH) break;
      }
      state = "agents";
      await batch((tx) => setState(tx, state));
    }

    if (state === "agents") {
      for (;;) {
        const n = await batch(async (tx) => {
          const deleted = rowsOf<unknown>(await tx.execute(sql`
            DELETE FROM agent_activity_summary_v2 WHERE id IN (
              SELECT summary.id FROM agent_activity_summary_v2 summary
                JOIN agents agent ON agent.id = summary.agent_id
               WHERE agent.server_id = ${serverId}
               LIMIT ${ROW_BATCH})
            RETURNING 1`));
          add("agent_activity_summaries_deleted", deleted.length);
          return deleted.length;
        });
        if (n < ROW_BATCH) break;
      }
      state = "scrub";
      await batch((tx) => setState(tx, state));
    }

    if (state === "scrub") {
      await batch(async (tx) => {
        const [avatars] = rowsOf<{ n: number }>(await tx.execute(sql`
          SELECT ((SELECT count(*) FROM servers WHERE id = ${serverId} AND avatar_url IS NOT NULL)
                + (SELECT count(*) FROM agents WHERE server_id = ${serverId} AND avatar_url IS NOT NULL))::int AS n`));
        add("old_bucket_avatars_skipped", Number(avatars?.n ?? 0));
        const now = ctx.clock();
        await tx.update(servers).set({
          name: SCRUBBED_SERVER_NAME,
          avatarUrl: null,
          // The lease stays: the finish goes on under it.
          purgeState: "rows_deleted",
          updatedAt: now,
        }).where(eq(servers.id, serverId));
      });
      state = "rows_deleted";
    }

    // The finish (header, step 6): purged_at only when every step is done.
    const finished = await finishClosedServerPurge({ serverId, batch, add, clock: ctx.clock, keepChannelIds: kept.all, revokers: ctx.revokers }, ctx.finishSteps ?? CLOSED_SERVER_PURGE_FINISH_STEPS);
    if (finished) {
      await batch((tx) => {
        const now = ctx.clock();
        return tx.update(servers).set({ purgeState: "done", purgedAt: now, purgeLeaseUntil: null, purgeLeaseToken: null, updatedAt: now })
          .where(eq(servers.id, serverId));
      });
      state = "done";
    } else {
      await batch((tx) => tx.update(servers).set({
        purgeLeaseUntil: new Date(ctx.clock().getTime() + PURGE_FINISH_RETRY_MS),
        purgeLeaseToken: null,
      }).where(eq(servers.id, serverId)));
    }
    result.outcome = state === "done" ? "done" : "rows_deleted";
    result.state = state;
    return result;
  } catch (error) {
    result.state = state;
    // Each write below is best effort: if it fails, the lease runs out on its own (PURGE_LEASE_MS).
    const settle = async (what: string, write: () => Promise<unknown>) => {
      try {
        await write();
      } catch (writeError) {
        console.warn(`[ClosedServerPurge] could not ${what} ${serverId}:`, writeError instanceof Error ? writeError.name : "unknown");
      }
    };
    if (error instanceof LeaseCheckFailed) {
      result.outcome = error.outcome;
      if (error.outcome === "not_eligible") {
        // Reopened (or closed again less than 30 days ago): its progress goes, so a later close starts again from the apps.
        result.state = null;
        await settle("clear the progress of", () => ctx.writer.update(servers)
          .set({ purgeState: null, purgeLeaseUntil: null, purgeLeaseToken: null })
          .where(and(eq(servers.id, serverId), eq(servers.purgeLeaseToken, token), closedServerPurgeOpenSql())));
      } else {
        // Not ours any more: release only what is still ours.
        await settle("release the lease on", () => release(ctx, serverId, token));
      }
      return result;
    }
    if (error instanceof ClosedServerPurgeRunStop) {
      // The run stops here; the server resumes at its state in a later run.
      result.outcome = "stopped";
      result.stopReason = error.reason;
      await settle("release the lease on", () => release(ctx, serverId, token));
      return result;
    }
    if (error instanceof FlagTurnedOff) {
      result.outcome = "flag_off";
      await settle("release the lease on", () => release(ctx, serverId, token));
      return result;
    }
    if (error instanceof RunCheckFailed) {
      await settle("release the lease on", () => release(ctx, serverId, token));
      throw error.original;
    }
    // The server's own error: it waits, the run goes on without it (header).
    result.outcome = "failed";
    result.errorClass = errorClassOf(error);
    result.sqlstate = sqlstateOf(error);
    await settle("back off", () => ctx.writer.update(servers)
      .set({ purgeLeaseUntil: new Date(ctx.clock().getTime() + PURGE_ERROR_RETRY_MS), purgeLeaseToken: null })
      .where(and(eq(servers.id, serverId), eq(servers.purgeLeaseToken, token))));
    return result;
  }
}

/** Take the server if it is eligible, unpurged and free (or its lease has run out); null when it isn't. */
async function claim(ctx: ClosedServerPurgeRunContext, serverId: ServerId, token: string): Promise<ClosedServerPurgeState | null> {
  return ctx.writer.transaction(async (tx) => {
    await tx.execute(sql.raw(`SET LOCAL statement_timeout = '${STATEMENT_TIMEOUT}'`));
    await tx.execute(sql.raw(`SET LOCAL lock_timeout = '${LOCK_TIMEOUT}'`));
    const now = ctx.clock();
    const [free] = await tx.select({ state: servers.purgeState }).from(servers)
      .where(and(
        eq(servers.id, serverId),
        closedServerPurgeOpenSql(),
        closedServerPurgeEligibleSql(closedServerPurgeCutoff(now)),
        or(isNull(servers.purgeLeaseUntil), lte(servers.purgeLeaseUntil, now)),
      ))
      .for("no key update", { skipLocked: true });
    if (!free) return null;
    // A new purge starts with the apps; a blocked one goes back to its channels.
    const state: ClosedServerPurgeState = free.state === null ? "apps" : free.state === "blocked" ? "channels" : free.state;
    await tx.update(servers).set({
      purgeState: state,
      purgeLeaseUntil: new Date(now.getTime() + PURGE_LEASE_MS),
      purgeLeaseToken: token,
    }).where(eq(servers.id, serverId));
    return state;
  });
}

async function release(ctx: ClosedServerPurgeRunContext, serverId: ServerId, token: string): Promise<void> {
  await ctx.writer.update(servers).set({ purgeLeaseUntil: null, purgeLeaseToken: null })
    .where(and(eq(servers.id, serverId), eq(servers.purgeLeaseToken, token)));
}

type Batch = <T>(work: (tx: DatabaseExecutor) => Promise<T>) => Promise<T>;
type Add = (key: string, n: number) => void;

interface ChannelRow {
  id: string;
  parentChannelId: string | null;
  type: string;
}

/** The channels the purge keeps (header): roots by why, and every kept channel (roots, `joint` channels, what is under them). */
export interface KeptChannels {
  joint: ReadonlySet<string>;
  receipt: ReadonlySet<string>;
  all: string[];
}

export async function keptChannelsOf(tx: DatabaseExecutor, serverId: ServerId): Promise<KeptChannels> {
  const joint = (await tx.select({ id: jointChannelServers.localChannelId }).from(jointChannelServers)
    .where(eq(jointChannelServers.serverId, serverId))).map((row) => row.id);
  const receipt = (await tx.select({ id: agentMigrationReceiptChannels.channelId }).from(agentMigrationReceiptChannels)
    .where(eq(agentMigrationReceiptChannels.serverId, serverId))).map((row) => row.id);
  const canonical = (await tx.select({ id: jointChannels.canonicalChannelId }).from(jointChannels)
    .innerJoin(channels, eq(channels.id, jointChannels.canonicalChannelId))
    .where(eq(channels.serverId, serverId))).map((row) => row.id);
  const roots = [...new Set([...joint, ...canonical, ...receipt])];
  // isKept's rule as one query: a `joint` channel, a root, or a channel under a root.
  const all = (await tx.select({ id: channels.id }).from(channels)
    .where(and(
      eq(channels.serverId, serverId),
      roots.length > 0
        ? or(eq(channels.type, "joint"), inArray(channels.id, roots), inArray(channels.parentChannelId, roots))
        : eq(channels.type, "joint"),
    ))).map((row) => row.id);
  return { joint: new Set([...joint, ...canonical]), receipt: new Set(receipt), all };
}

/** Step 2. True when some channel was left (blocked); false when every channel it may clear is gone. */
async function purgeChannels(ctx: ClosedServerPurgeRunContext, serverId: ServerId, kept: KeptChannels, batch: Batch, add: Add): Promise<boolean> {
  const isKept = (channel: ChannelRow): "joint" | "receipt" | null => {
    const parent = channel.parentChannelId;
    if (channel.type === "joint" || kept.joint.has(channel.id) || (parent && kept.joint.has(parent))) return "joint";
    if (kept.receipt.has(channel.id) || (parent && kept.receipt.has(parent))) return "receipt";
    return null;
  };

  let blocked = false;
  // Children (threads, task conversations) first, then top-level channels; keyset on (is top-level, id).
  let after: { top: boolean; id: string } | null = null;
  for (;;) {
    const cursor: { top: boolean; id: string } | null = after;
    const page: ChannelRow[] = await batch((tx) => tx.select({ id: channels.id, parentChannelId: channels.parentChannelId, type: channels.type })
      .from(channels)
      .where(and(
        eq(channels.serverId, serverId),
        ...(cursor ? [sql`((${channels.parentChannelId} IS NULL), ${channels.id}) > (${cursor.top}, ${cursor.id}::uuid)`] : []),
      ))
      .orderBy(sql`(${channels.parentChannelId} IS NULL)`, asc(channels.id))
      .limit(CHANNEL_PAGE));
    if (page.length === 0) break;
    const last = page[page.length - 1]!;
    after = { top: last.parentChannelId === null, id: last.id };
    for (const channel of page) {
      const keep = isKept(channel);
      if (keep) {
        add(`channels_skipped_${keep}`, 1);
        continue;
      }
      const outcome = await purgeChannel(ctx, channel.id, batch, add);
      if (outcome !== "deleted") {
        blocked = true;
        add("channels_blocked", 1);
        add(`channels_blocked_${outcome}`, 1);
      }
    }
  }
  return blocked;
}

type ChannelOutcome = "deleted" | "guest" | "fk" | "child";

async function purgeChannel(ctx: ClosedServerPurgeRunContext, channelId: string, batch: Batch, add: Add): Promise<ChannelOutcome> {
  // A Guest's channel: not cleared by this version (header).
  const blocker = await batch(async (tx) => {
    const [guest] = await tx.select({ userId: serverMembers.userId }).from(serverMembers)
      .where(eq(serverMembers.guestChannelId, channelId)).limit(1);
    return guest ? "guest" as const : null;
  });
  if (blocker) return blocker;

  try {
    // Blockers before messages: a bridge's rows on the channel and its messages.
    if (await batch((tx) => channelHasBridgeRows(tx, channelId))) {
      add("channels_bridge_cleared", 1);
      // ROW_BATCH rows a batch; the run's message cap stops it like the message batches.
      await clearChannelBridgeRows(channelId, batch, add, {
        size: ctx.bridgeRowBatch ?? ROW_BATCH,
        beforeBatch: () => {
          if (ctx.messagesLeft <= 0) throw new ClosedServerPurgeRunStop("message_cap");
        },
      });
    }
    for (;;) {
      for (;;) {
        if (ctx.messagesLeft <= 0) throw new ClosedServerPurgeRunStop("message_cap");
        const size = Math.min(ctx.messageBatch, ctx.messagesLeft);
        const started = performance.now();
        const n = await batch((tx) => deleteMessageBatch(tx, channelId, size, add));
        const ms = performance.now() - started;
        ctx.messagesLeft -= n;
        if (ms < 1_000) ctx.messageBatch = Math.min(MESSAGE_BATCH_MAX, ctx.messageBatch * 2);
        else if (ms > 3_000) ctx.messageBatch = Math.max(MESSAGE_BATCH_MIN, Math.floor(ctx.messageBatch / 2));
        if (n < size) break;
      }
      // "more": attachments (or a late message) are left; every pass goes through the run's guards.
      const done = await batch((tx) => finishChannel(tx, channelId, add));
      if (done !== "more") return done;
    }
  } catch (error) {
    if (sqlstateOf(error) === FOREIGN_KEY_VIOLATION) return "fk";
    throw error;
  }
}

/** Lock the attachments' objects, remove the attachments' holds and delete the rows; returns the objects to collect. */
async function deleteAttachments(tx: DatabaseExecutor, rows: Array<{ id: string; objectId: string }>, add: Add): Promise<string[]> {
  if (rows.length === 0) return [];
  const objectIds = [...new Set(rows.map((row) => row.objectId))].sort();
  // FOR UPDATE first, as every collector does: a hold added meanwhile either commits first or finds the object gone.
  await tx.execute(sql`SELECT id FROM attachment_objects WHERE id IN (${sql.join(objectIds.map((id) => sql`${id}::uuid`), sql`, `)}) ORDER BY id FOR UPDATE`);
  add("attachment_holds_removed", await removeAttachmentObjectHoldsWithExecutor(tx, rows.map((row) => ({ holderType: "attachment" as const, holderId: row.id, objectId: row.objectId }))));
  const deleted = await tx.delete(attachments).where(inArray(attachments.id, rows.map((row) => row.id))).returning({ id: attachments.id });
  add("attachments_deleted", deleted.length);
  return objectIds;
}

/**
 * Queue each object nothing refers to any more for the GC, one with a copy in
 * the old CDN bucket like any other (header: owner decision, 2026-11-10); an
 * object still held elsewhere (a forwarded copy's own hold) is left. Runs
 * after the rows derived from it are deleted, in the same transaction.
 */
async function collectObjects(tx: DatabaseExecutor, objectIds: string[], add: Add): Promise<void> {
  if (objectIds.length === 0) return;
  const now = await resolveAttachmentLifecycleDatabaseNow(tx);
  for (const objectId of objectIds) {
    const token = await claimObjectGcIfUnreferencedWithExecutor(tx, objectId, now);
    add(token ? "attachment_objects_gc_queued" : "attachment_objects_still_referenced", 1);
  }
}

/** One batch of a channel's oldest messages and what hangs on them. Returns how many messages it deleted. */
async function deleteMessageBatch(tx: DatabaseExecutor, channelId: string, size: number, add: Add): Promise<number> {
  const ids = (await tx.select({ id: messages.id }).from(messages)
    .where(eq(messages.channelId, channelId))
    .orderBy(asc(messages.createdAt), asc(messages.id))
    .limit(size)).map((row) => row.id);
  if (ids.length === 0) return 0;
  const linked = await tx.select({ id: attachments.id, objectId: attachments.objectId }).from(attachments)
    .where(inArray(attachments.messageId, ids));
  const objectIds = await deleteAttachments(tx, linked, add);
  // tasks.message_id has no ON DELETE action (a pre-v2 task's host message).
  await tx.update(tasks).set({ messageId: null }).where(inArray(tasks.messageId, ids));
  const deleted = await tx.delete(messages).where(and(eq(messages.channelId, channelId), inArray(messages.id, ids))).returning({ id: messages.id });
  add("messages_deleted", deleted.length);
  await collectObjects(tx, objectIds, add);
  return deleted.length;
}

/** Once a channel's messages are gone: its other rows, then the row itself. "more" when attachments are left for another batch. */
async function finishChannel(tx: DatabaseExecutor, channelId: string, add: Add): Promise<ChannelOutcome | "more"> {
  const rest = await tx.select({ id: attachments.id, objectId: attachments.objectId }).from(attachments)
    .where(or(eq(attachments.channelId, channelId), eq(attachments.pendingChannelId, channelId)))
    .limit(ROW_BATCH);
  if (rest.length > 0) {
    await collectObjects(tx, await deleteAttachments(tx, rest, add), add);
    return "more";
  }
  // A message that arrived after the message batches (a closed server takes none; a guard all the same).
  const [message] = await tx.select({ id: messages.id }).from(messages).where(eq(messages.channelId, channelId)).limit(1);
  if (message) return "more";
  const [child] = await tx.select({ id: channels.id }).from(channels).where(eq(channels.parentChannelId, channelId)).limit(1);
  if (child) return "child";

  const workflows = await tx.delete(workflowInstances).where(eq(workflowInstances.channelId, channelId)).returning({ id: workflowInstances.id });
  add("workflow_instances_deleted", workflows.length);
  // A task whose conversation channel is still there keeps the channel (its delete would cascade into that conversation).
  const [taskWithConversation] = await tx.select({ id: tasks.id }).from(tasks)
    .innerJoin(channels, eq(channels.taskId, tasks.id))
    .where(eq(tasks.channelId, channelId)).limit(1);
  if (taskWithConversation) return "child";
  const deletedTasks = await tx.delete(tasks).where(eq(tasks.channelId, channelId)).returning({ id: tasks.id });
  add("tasks_deleted", deletedTasks.length);
  await tx.delete(agentLounges).where(eq(agentLounges.channelId, channelId));
  await tx.delete(channelServerConnectRequests).where(eq(channelServerConnectRequests.channelId, channelId));
  await tx.delete(channelExternalInvites).where(eq(channelExternalInvites.channelId, channelId));
  const deleted = await tx.delete(channels).where(eq(channels.id, channelId)).returning({ id: channels.id });
  add("channels_deleted", deleted.length);
  return "deleted";
}
