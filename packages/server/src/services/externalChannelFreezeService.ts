/**
 * Writes of the free plan's external channel freeze (behind
 * external_channels_v1; the rule and the read side are in
 * externalChannelFreezeState).
 *
 * A server is over while the flag is on for it, it is free (freeServerIds)
 * and it is in more than one external channel. Over: it has a
 * server_external_freezes row whose freeze_at is set once, when first seen
 * over (now: a downgrade or a new external channel gets no grace), and never
 * moved later or earlier. Not over: no row, so the server can write again at
 * once. The servers already over at launch get their grace from a one-off
 * backfill (scripts/external-freeze-launch-backfill.ts); until it has run,
 * nothing here creates a row (rows are still deleted), so a launch cannot
 * freeze them before the backfill gives them their 14 days.
 *
 * Reconciled in the same transaction as every change of a server's external
 * channels (a Guest bound or removed, a joint connection or disconnection, an
 * archive, unarchive or delete), on a billing change, and by the periodic
 * sweep (the backstop for anything else: a deleted server, a plan change
 * outside billing sync, an account deletion).
 *
 * Lock order: ADMISSION_LOCK_ORDER rule 4 (planService). The freeze row is
 * written by primary key (an upsert or a delete; never the servers row),
 * after the transaction's admission, ns-3, joint lifecycle and membership
 * locks and before the joint row lock. Several servers in server-id order.
 * A path that can make a server over holds its admission lock (the sweep and
 * the billing hook take it first, in their own short transaction per
 * server); the others only delete, and only the row version they locked.
 */
import { createHash } from "node:crypto";
import { and, eq, inArray, isNull, sql } from "drizzle-orm";
import { getDb, type DatabaseExecutor } from "../db/index";
import { externalFreezeLaunchBackfill, jointChannelServers, servers, serverExternalFreezes } from "../db/schema";
import {
  countExternalChannelsOfServer,
  externalChannelsFlagOnFor,
} from "./externalChannelFreezeState";
import { freeServerIds } from "./jointChannelLimitService";
import { acquireServerAdmissionLocks } from "./planService";
import { isInTransaction } from "../db/ambientTransaction";

/** The grace the servers already over at launch get (from the launch time). */
export const EXTERNAL_FREEZE_LAUNCH_GRACE_MS = 14 * 24 * 60 * 60 * 1000;

const SWEEP_PAGE_SIZE = 200;

let backfillMissingLogged = false;

/** Whether the launch backfill has run (its marker row exists). */
export async function externalFreezeLaunchBackfillDone(executor: DatabaseExecutor): Promise<boolean> {
  const [row] = await executor.select({ id: externalFreezeLaunchBackfill.id }).from(externalFreezeLaunchBackfill).limit(1);
  if (row) return true;
  if (!backfillMissingLogged) {
    backfillMissingLogged = true;
    console.warn("[ExternalFreeze] The launch backfill (scripts/external-freeze-launch-backfill.ts) has not run: no server is frozen until it has.");
  }
  return false;
}

/** Test-only: log the missing backfill again. */
export function __resetExternalFreezeBackfillLogForTests(): void {
  backfillMissingLogged = false;
}

/** Adjust one server's count for a change this transaction has not written yet (reconcileExternalFreezesForJointConnect). */
type CountAdjustment = { exceptChannelId?: string | null; plus?: number };

/**
 * The servers among these the rule applies to: not deleted, flag on (unless
 * `ignoreFlag`: the launch backfill, which counts the servers over before the
 * flag is on) and free. In server-id order.
 */
async function eligibleServerIds(
  executor: DatabaseExecutor,
  serverIds: readonly string[],
  now: Date,
  options: { ignoreFlag?: boolean } = {},
): Promise<string[]> {
  const ids = serverIds.length === 0 ? [] : (await executor.select({ id: servers.id }).from(servers)
    .where(and(inArray(servers.id, [...new Set(serverIds)]), isNull(servers.deletedAt)))).map((row) => row.id).sort();
  const flagOn = options.ignoreFlag ? new Set(ids) : await externalChannelsFlagOnFor(executor, ids);
  const free = await freeServerIds(executor, ids.filter((id) => flagOn.has(id)), now);
  return ids.filter((id) => flagOn.has(id) && free.has(id));
}

async function isOver(executor: DatabaseExecutor, serverId: string, adjust: CountAdjustment | undefined): Promise<boolean> {
  const count = await countExternalChannelsOfServer(executor, serverId, { exceptChannelId: adjust?.exceptChannelId }) + (adjust?.plus ?? 0);
  return count > 1;
}

/** Which of `serverIds` are over (see the module comment); unlocked, for the sweep's pre-filter and the backfill. */
async function overServerIds(
  executor: DatabaseExecutor,
  serverIds: readonly string[],
  now: Date,
  options: { ignoreFlag?: boolean } = {},
): Promise<Set<string>> {
  const over = new Set<string>();
  for (const serverId of await eligibleServerIds(executor, serverIds, now, options)) {
    if (await isOver(executor, serverId, undefined)) over.add(serverId);
  }
  return over;
}

export type ExternalFreezeWrite = "frozen" | "kept" | "cleared" | "none";

type ExternalFreezeProbe = (event: { serverId: string; phase: "start" | "counted"; over: boolean }) => Promise<void> | void;
let externalFreezeProbeForTests: ExternalFreezeProbe | null = null;

/** Test-only: called when a reconcile starts on a server (before anything is read), and after it has counted it, before it writes. */
export function __setExternalFreezeProbeForTests(probe: ExternalFreezeProbe | null): void {
  if (process.env.NODE_ENV !== "test") throw new Error("external freeze probes are test-only");
  externalFreezeProbeForTests = probe;
}

/**
 * One server: its freeze row locked first (by key; the version seen, if
 * any), then everything that decides it read under that lock (deleted or
 * not, the flag, free or paid, the count), then written. Nothing read
 * before the lock decides a write: a reconcile that waited for the lock
 * sees what it waited for (a downgrade that wrote a row, an accept that made
 * the server over). A delete removes only the row version this locked, so a
 * row another transaction makes after the lock is never deleted.
 */
async function reconcileOne(
  executor: DatabaseExecutor,
  serverId: string,
  now: Date,
  options: { adjust?: CountAdjustment; backfillDone: () => Promise<boolean>; clearOnly?: boolean },
): Promise<ExternalFreezeWrite> {
  await externalFreezeProbeForTests?.({ serverId, phase: "start", over: false });
  const locked = await executor.execute<{ version: string }>(sql`
    SELECT xmin::text AS version FROM server_external_freezes WHERE server_id = ${serverId}::uuid FOR UPDATE
  `);
  const version = locked.rows[0]?.version ?? null;
  const eligible = (await eligibleServerIds(executor, [serverId], now)).length === 1;
  const over = eligible && await isOver(executor, serverId, options.adjust);
  await externalFreezeProbeForTests?.({ serverId, phase: "counted", over });
  if (!over) {
    if (version === null) return "none";
    const deleted = await executor.execute<{ server_id: string }>(sql`
      DELETE FROM server_external_freezes WHERE server_id = ${serverId}::uuid AND xmin::text = ${version} RETURNING server_id
    `);
    return deleted.rows.length > 0 ? "cleared" : "none";
  }
  if (options.clearOnly || !await options.backfillDone()) return "none";
  // COALESCE keeps the first freeze time; the upsert still locks the row by its key.
  const [row] = await executor.insert(serverExternalFreezes)
    .values({ serverId, freezeAt: now, createdAt: now, updatedAt: now })
    .onConflictDoUpdate({
      target: serverExternalFreezes.serverId,
      set: { freezeAt: sql`COALESCE(${serverExternalFreezes.freezeAt}, excluded.freeze_at)` },
    })
    .returning({ inserted: sql<boolean>`(xmax = 0)` });
  return row?.inserted ? "frozen" : "kept";
}

/**
 * Re-evaluate these servers and write each one's freeze row (see the module
 * comment), in server-id order, in the caller's transaction. A path that
 * can make a server over holds that server's admission lock (taken first);
 * the others only take external channels away (`clearOnly`), and
 * reconcileOne keeps them from deleting a row another transaction just made.
 */
export async function reconcileServerExternalFreezes(
  executor: DatabaseExecutor,
  serverIds: readonly string[],
  now: Date,
  options: {
    adjust?: ReadonlyMap<string, CountAdjustment>;
    /**
     * The change can only take external channels away (a Guest removed, a
     * disconnection, an archive, a delete): delete rows, never create one.
     * These paths hold no admission lock, and creating a row is left to the
     * paths that hold the server's (an admission, the sweep, the billing
     * hook), whose count cannot go stale before their write.
     */
    clearOnly?: boolean;
  } = {},
): Promise<Map<string, ExternalFreezeWrite>> {
  const ids = [...new Set(serverIds)].sort();
  const writes = new Map<string, ExternalFreezeWrite>();
  if (ids.length === 0) return writes;
  let done: boolean | undefined;
  const backfillDone = async () => (done ??= await externalFreezeLaunchBackfillDone(executor));
  for (const serverId of ids) {
    writes.set(serverId, await reconcileOne(executor, serverId, now, {
      adjust: options.adjust?.get(serverId), backfillDone, clearOnly: options.clearOnly,
    }));
  }
  return writes;
}

export async function reconcileServerExternalFreeze(
  executor: DatabaseExecutor,
  serverId: string,
  now: Date,
  options: { clearOnly?: boolean } = {},
): Promise<ExternalFreezeWrite> {
  return (await reconcileServerExternalFreezes(executor, [serverId], now, options)).get(serverId) ?? "none";
}

/** Active, non-deleted servers of a joint with their local channels. */
async function activeJointServers(executor: DatabaseExecutor, jointChannelId: string): Promise<Array<{ serverId: string; localChannelId: string }>> {
  return executor
    .select({ serverId: jointChannelServers.serverId, localChannelId: jointChannelServers.localChannelId })
    .from(jointChannelServers)
    .innerJoin(servers, eq(servers.id, jointChannelServers.serverId))
    .where(and(eq(jointChannelServers.jointChannelId, jointChannelId), eq(jointChannelServers.status, "active"), isNull(servers.deletedAt)));
}

/**
 * Servers are about to get an active projection of the top-level joint
 * `parentJointId` (a joint invite accept, a batch of them, an external
 * invite's connection). Called before the accept takes the joint row lock
 * (ADMISSION_LOCK_ORDER rule 4), so the projections are not written yet:
 * each server is counted as it will be once they are, the joint counting
 * once for every connecting and every active server when it then has two or
 * more. The accept's own writes and checks follow in the same transaction;
 * if one refuses, this rolls back with it.
 */
export async function reconcileExternalFreezesForJointConnect(
  executor: DatabaseExecutor,
  input: { parentJointId: string; connectingServerIds: readonly string[]; now: Date },
): Promise<void> {
  const active = await activeJointServers(executor, input.parentJointId);
  const after = new Set([...active.map((row) => row.serverId), ...input.connectingServerIds]);
  const plus = after.size >= 2 ? 1 : 0;
  const adjust = new Map<string, CountAdjustment>(active.map((row) => [row.serverId, { exceptChannelId: row.localChannelId, plus }]));
  for (const serverId of input.connectingServerIds) if (!adjust.has(serverId)) adjust.set(serverId, { plus });
  await reconcileServerExternalFreezes(executor, [...adjust.keys()], input.now, { adjust });
}

/**
 * After a change to the channel (a joint disconnection): its server and,
 * for a joint, every server active in it.
 */
export async function reconcileExternalFreezesForChannel(
  executor: DatabaseExecutor,
  input: { serverId: string; jointChannelId?: string | null; now: Date; clearOnly?: boolean },
): Promise<void> {
  const ids = new Set([input.serverId]);
  if (input.jointChannelId) for (const row of await activeJointServers(executor, input.jointChannelId)) ids.add(row.serverId);
  await reconcileServerExternalFreezes(executor, [...ids], input.now, { clearOnly: input.clearOnly });
}

/** Billing-change hook (next to reconcileJointsForServer): an upgrade unfreezes at once, a downgrade freezes at once. */
export async function reconcileExternalFreezeForBillingChange(serverId: string, now: Date = new Date()): Promise<ExternalFreezeWrite> {
  // Its own short transaction, never the billing sync's: the admission lock
  // must come first (ADMISSION_LOCK_ORDER rule 1), before any other lock.
  if (isInTransaction()) {
    console.warn(`[ExternalFreeze] Billing change for server ${serverId} reconciled inside a transaction was skipped; the sweep reconciles it.`);
    return "none";
  }
  return reconcileExternalFreezeUnderAdmissionLock(serverId, now);
}

/**
 * A reconcile no change path started (the billing hook, the sweep): its own
 * short transaction, the server's admission lock first, then count and
 * write. Every path that can make the server over holds the same lock, so
 * the count cannot go stale before the write.
 */
async function reconcileExternalFreezeUnderAdmissionLock(serverId: string, now: Date): Promise<ExternalFreezeWrite> {
  return getDb().transaction(async (tx) => {
    await acquireServerAdmissionLocks(tx, [serverId]);
    return reconcileServerExternalFreeze(tx, serverId, now);
  });
}

export type ExternalFreezeSweepResult = { scanned: number; over: number; frozen: number; cleared: number; backfillDone: boolean };

/**
 * Candidates: every server with a freeze row (it may have to go) and every
 * server in an external channel at all (a bound Guest, or an active joint
 * projection). Paginated by server id.
 */
async function candidatePage(afterId: string | null): Promise<string[]> {
  const after = afterId ? sql`server_id > ${afterId}::uuid` : sql`TRUE`;
  // Each branch walks its own server_id index from the cursor.
  const result = await getDb().execute<{ server_id: string }>(sql`
    SELECT server_id FROM (
      (SELECT server_id FROM server_external_freezes WHERE ${after} ORDER BY server_id LIMIT ${SWEEP_PAGE_SIZE})
      UNION
      (SELECT DISTINCT server_id FROM server_members WHERE role = 'guest' AND guest_channel_id IS NOT NULL AND ${after} ORDER BY server_id LIMIT ${SWEEP_PAGE_SIZE})
      UNION
      (SELECT DISTINCT server_id FROM joint_channel_servers WHERE status = 'active' AND ${after} ORDER BY server_id LIMIT ${SWEEP_PAGE_SIZE})
    ) candidates
    ORDER BY server_id
    LIMIT ${SWEEP_PAGE_SIZE}
  `);
  return result.rows.map((row) => row.server_id);
}

/**
 * Periodic backstop: re-evaluates every candidate server, the flag and the
 * plan evaluated per page. Creates missing rows (freeze_at = now) and deletes
 * rows of servers no longer over; never moves a stored freeze_at. Creates
 * nothing before the launch backfill has run.
 */
export async function sweepExternalChannelFreezes(now: Date = new Date()): Promise<ExternalFreezeSweepResult> {
  const db = getDb();
  const backfillDone = await externalFreezeLaunchBackfillDone(db);
  const result: ExternalFreezeSweepResult = { scanned: 0, over: 0, frozen: 0, cleared: 0, backfillDone };
  let afterId: string | null = null;
  for (;;) {
    const page = await candidatePage(afterId);
    if (page.length === 0) break;
    afterId = page[page.length - 1]!;
    result.scanned += page.length;
    const over = await overServerIds(db, page, now);
    result.over += over.size;
    const stored = new Set((await db.select({ serverId: serverExternalFreezes.serverId }).from(serverExternalFreezes)
      .where(inArray(serverExternalFreezes.serverId, page))).map((row) => row.serverId));
    // Each write re-decides in a short transaction of its own, under the
    // server's admission lock, so a change committed since this page was
    // counted is not overwritten with a stale answer.
    for (const serverId of page) {
      if (over.has(serverId) === stored.has(serverId)) continue;
      if (over.has(serverId) && !backfillDone) continue;
      const write = await reconcileExternalFreezeUnderAdmissionLock(serverId, now);
      if (write === "frozen") result.frozen += 1;
      if (write === "cleared") result.cleared += 1;
    }
    if (page.length < SWEEP_PAGE_SIZE) break;
  }
  return result;
}

export type ExternalFreezeLaunchBackfillResult = {
  mode: "dry-run" | "apply";
  /** Free servers in more than one external channel, the flag ignored. */
  over: number;
  /** Rows written (apply), or that would be (dry-run): over servers without a row. */
  inserted: number;
  /** Over servers that already had a row (left as they are). */
  existing: number;
  freezeAt: string | null;
  /** sha256 of the sorted over server ids, one per line. */
  overIdsSha256: string;
  markerAlreadyPresent: boolean;
};

/** Every server in an external channel at all, paginated (the sweep's candidates without the freeze rows). */
async function allOverServerIgnoringFlag(now: Date): Promise<string[]> {
  const over: string[] = [];
  let afterId: string | null = null;
  for (;;) {
    const page = await candidatePage(afterId);
    if (page.length === 0) break;
    afterId = page[page.length - 1]!;
    over.push(...await overServerIds(getDb(), page, now, { ignoreFlag: true }));
    if (page.length < SWEEP_PAGE_SIZE) break;
  }
  return over.sort();
}

/**
 * The one-off launch backfill (scripts/external-freeze-launch-backfill.ts):
 * every free server over now, counted as the reconcile does but with the
 * flag ignored, gets freeze_at = launchAt + 14 days unless it already has a
 * row; then the marker row lets reconciles and the sweep create rows. Reports
 * counts and a digest only, never ids.
 */
export async function runExternalFreezeLaunchBackfill(input: { apply: boolean; launchAt: Date | null; now?: Date }): Promise<ExternalFreezeLaunchBackfillResult> {
  const now = input.now ?? new Date();
  const overIds = await allOverServerIgnoringFlag(now);
  const db = getDb();
  const [marker] = await db.select({ id: externalFreezeLaunchBackfill.id }).from(externalFreezeLaunchBackfill).limit(1);
  const existingRows = overIds.length === 0 ? [] : await db.select({ serverId: serverExternalFreezes.serverId }).from(serverExternalFreezes)
    .where(inArray(serverExternalFreezes.serverId, overIds));
  const existing = new Set(existingRows.map((row) => row.serverId));
  const freezeAt = input.launchAt ? new Date(input.launchAt.getTime() + EXTERNAL_FREEZE_LAUNCH_GRACE_MS) : null;
  const result: ExternalFreezeLaunchBackfillResult = {
    mode: input.apply ? "apply" : "dry-run",
    over: overIds.length,
    inserted: overIds.filter((id) => !existing.has(id)).length,
    existing: existing.size,
    freezeAt: freezeAt?.toISOString() ?? null,
    overIdsSha256: createHash("sha256").update(overIds.join("\n")).digest("hex"),
    markerAlreadyPresent: !!marker,
  };
  if (!input.apply) return result;
  if (!input.launchAt || !freezeAt) throw new Error("--apply needs --launch-at");
  result.inserted = await db.transaction(async (tx) => {
    let inserted = 0;
    for (let i = 0; i < overIds.length; i += SWEEP_PAGE_SIZE) {
      const rows = await tx.insert(serverExternalFreezes)
        .values(overIds.slice(i, i + SWEEP_PAGE_SIZE).map((serverId) => ({ serverId, freezeAt, createdAt: now, updatedAt: now })))
        .onConflictDoNothing({ target: serverExternalFreezes.serverId })
        .returning({ serverId: serverExternalFreezes.serverId });
      inserted += rows.length;
    }
    await tx.insert(externalFreezeLaunchBackfill)
      .values({ id: 1, launchAt: input.launchAt!, completedAt: now })
      .onConflictDoNothing({ target: externalFreezeLaunchBackfill.id });
    return inserted;
  });
  return result;
}
