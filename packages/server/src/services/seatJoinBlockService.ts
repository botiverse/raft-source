// Join links that can't let someone in (task #10 #proj-commercial, behind
// pro_seat_add). When a signed-in person opens an invite or join link while the
// server's Pro seats are full, their page says the owners were told and posts
// POST /api/invites/seat-blocked: one `seat_join_blocks` row. The server's
// owners and admins, and whoever made the link, then see it in the
// notification center (GET /api/servers/:id/seat-join-blocks) and add a seat,
// or ask an owner for one (a `join` seat request). It goes once they join,
// once there's a seat again, or after SEAT_REQUEST_TTL_MS; an ended row is
// deleted RESOLVED_SEAT_JOIN_BLOCK_RETENTION_MS later. Contract:
// docs/contracts/seat-limits.md.
import { and, count, desc, eq, inArray, lt, notExists, sql } from "drizzle-orm";
import { alias } from "drizzle-orm/pg-core";
import {
  PRO_SEAT_ADD_FEATURE_FLAG_KEY,
  SEAT_REQUEST_TTL_MS,
  getBillingCapacityLimitState,
  type SeatJoinBlock,
  type SeatJoinBlocksResponse,
  type SeatJoinSeatUsage,
} from "@botiverse/raft-shared";
import { getDb, type DatabaseExecutor } from "../db/index";
import { seatJoinBlocks, serverMembers, users } from "../db/schema";
import { getActorServerRoleInServer } from "../lib/actorPermissions";
import { refreshSubscriptionForServerIfStale } from "./billingService";
import { normalizeEmail } from "./emailNormalization";
import { evaluateFeatureFlag } from "./featureFlagService";
import { findLiveInvite } from "./inviteService";
import { announceSeatJoinBlocksChanged } from "./listChangedRealtime";
import { getServerBillingEntitlement, getServerBillingUsage } from "./planService";
import * as serverService from "./serverService";

/** Active notices one server keeps at once; past it, a turned-away person isn't recorded (no flood of notices). */
export const MAX_ACTIVE_SEAT_JOIN_BLOCKS = 20;

/** How long an ended row is kept (it is read by nothing) before the sweep deletes it. */
export const RESOLVED_SEAT_JOIN_BLOCK_RETENTION_MS = 30 * 24 * 60 * 60 * 1000;

export type SeatJoinBlockResolvedReason = "joined" | "room" | "expired";

/**
 * The seats when a Pro server's seats leave no room for one more person (Pro
 * seats, not a plan's member cap, since a seat is what the owners can add),
 * else null. Read from the local projection; never asks Stripe, never writes.
 */
async function fullSeats(serverId: string, executor: DatabaseExecutor = getDb()): Promise<SeatJoinSeatUsage | null> {
  const entitlement = await getServerBillingEntitlement(executor, serverId);
  const seats = entitlement.capacity.maxUniversalSeats;
  if (seats === -1) return null;
  const usage = await getServerBillingUsage(executor, serverId);
  const state = getBillingCapacityLimitState(entitlement.capacity, usage, "human");
  return state.reached && state.limitType === "universal" ? { seats, humans: usage.humans, agents: usage.agents } : null;
}

async function outOfSeatsForAPerson(serverId: string, executor: DatabaseExecutor = getDb()): Promise<boolean> {
  return await fullSeats(serverId, executor) !== null;
}

/**
 * Records that `userId` couldn't join through `token` because the seats are
 * full (POST /api/invites/seat-blocked). Null for a token that doesn't let
 * anyone in. `recorded` is false when nothing was written: the flag is off,
 * they're a member already, the invite isn't theirs or takes no seat, there's
 * a seat after all, or the server has MAX_ACTIVE_SEAT_JOIN_BLOCKS already.
 * The inviter is the token's link or invite, never the request's. Through a
 * second link the first row stays.
 */
export async function recordSeatJoinBlock(token: string, userId: string): Promise<{ recorded: boolean } | null> {
  const invite = await findLiveInvite(token);
  if (!invite) return null;
  const notRecorded = { recorded: false };
  // An email invite is its address's own (as accepting it is); a Guest's takes no seat.
  if (invite.kind === "email") {
    if (invite.role === "guest") return notRecorded;
    const [user] = await getDb().select({ email: users.email }).from(users).where(eq(users.id, userId)).limit(1);
    if (!user || !invite.invitedEmail || normalizeEmail(user.email) !== normalizeEmail(invite.invitedEmail)) return notRecorded;
  }
  const flag = await evaluateFeatureFlag({ key: PRO_SEAT_ADD_FEATURE_FLAG_KEY, serverId: invite.serverId, userId });
  if (!flag.enabled) return notRecorded;
  if (await serverService.isMember(invite.serverId, userId)) return notRecorded;
  // As accepting would: a missed Stripe webhook doesn't keep the seats full.
  await refreshSubscriptionForServerIfStale(invite.serverId);
  if (!await outOfSeatsForAPerson(invite.serverId)) return notRecorded;

  return getDb().transaction(async (tx) => {
    // Serializes this server's records, so the cap holds under concurrent opens.
    await tx.execute(sql`select pg_advisory_xact_lock(hashtext(${`seat_join_blocks:${invite.serverId}`}))`);
    const [mine] = await tx.select({ id: seatJoinBlocks.id }).from(seatJoinBlocks)
      .where(and(eq(seatJoinBlocks.serverId, invite.serverId), eq(seatJoinBlocks.userId, userId), eq(seatJoinBlocks.state, "active")))
      .limit(1);
    if (mine) return { recorded: true };
    const [active] = await tx.select({ n: count() }).from(seatJoinBlocks)
      .where(and(eq(seatJoinBlocks.serverId, invite.serverId), eq(seatJoinBlocks.state, "active")));
    if ((active?.n ?? 0) >= MAX_ACTIVE_SEAT_JOIN_BLOCKS) return notRecorded;
    const inserted = await tx.insert(seatJoinBlocks)
      .values({ serverId: invite.serverId, userId, inviterUserId: invite.inviterUserId })
      // The partial unique index (one active row per person) is the backstop.
      .onConflictDoNothing()
      .returning({ id: seatJoinBlocks.id });
    if (inserted.length > 0) announceSeatJoinBlocksChanged([invite.serverId]);
    return { recorded: true };
  });
}

/**
 * Who a full link turned away, for `viewerUserId`'s notification center (GET
 * /api/servers/:id/seat-join-blocks): owners and admins see everyone, anyone
 * else the people their own link or invite turned away. Only while the seats
 * are still full, and never someone who has joined since. With them the seats
 * (bought and taken), which a member can't read from billing: the numbers a
 * seat refusal gives them. Reads only: a stale row is resolved where joining
 * or seats happen, not here.
 */
export async function listSeatJoinBlocks(serverId: string, viewerUserId: string): Promise<SeatJoinBlocksResponse> {
  const none: SeatJoinBlocksResponse = { blocks: [] };
  const flag = await evaluateFeatureFlag({ key: PRO_SEAT_ADD_FEATURE_FLAG_KEY, serverId, userId: viewerUserId });
  if (!flag.enabled) return none;
  const role = await getActorServerRoleInServer(serverId, "user", viewerUserId);
  if (!role || role === "guest") return none;
  const db = getDb();
  const usage = await fullSeats(serverId, db);
  if (!usage) return none;

  const inviters = alias(users, "seat_join_block_inviters");
  const rows = await db.select({
    id: seatJoinBlocks.id,
    userId: seatJoinBlocks.userId,
    name: users.name,
    displayName: users.displayName,
    inviterUserId: seatJoinBlocks.inviterUserId,
    inviterName: inviters.name,
    inviterDisplayName: inviters.displayName,
    createdAt: seatJoinBlocks.createdAt,
  }).from(seatJoinBlocks)
    .innerJoin(users, eq(users.id, seatJoinBlocks.userId))
    .leftJoin(inviters, eq(inviters.id, seatJoinBlocks.inviterUserId))
    .where(and(
      eq(seatJoinBlocks.serverId, serverId),
      eq(seatJoinBlocks.state, "active"),
      role === "owner" || role === "admin" ? undefined : eq(seatJoinBlocks.inviterUserId, viewerUserId),
      notExists(db.select({ one: sql`1` }).from(serverMembers)
        .where(and(eq(serverMembers.serverId, seatJoinBlocks.serverId), eq(serverMembers.userId, seatJoinBlocks.userId)))),
    ))
    .orderBy(desc(seatJoinBlocks.createdAt))
    .limit(MAX_ACTIVE_SEAT_JOIN_BLOCKS);
  if (rows.length === 0) return none;
  return {
    usage,
    blocks: rows.map((row): SeatJoinBlock => ({
      id: row.id,
      userId: row.userId,
      name: row.displayName || row.name,
      inviterUserId: row.inviterUserId,
      inviterName: row.inviterUserId ? row.inviterDisplayName || row.inviterName : null,
      createdAt: row.createdAt.toISOString(),
    })),
  };
}

/**
 * `userId`'s active notice on `serverId` while they are still waiting to join
 * (not a member since), else null: what a `join` seat request needs when it
 * is asked (who may ask). Once asked, whether a seat is still needed is
 * stillNeedsSeatToJoin's: the notice may end while the owner pays.
 */
export async function findWaitingSeatJoinBlock(serverId: string, userId: string): Promise<{ inviterUserId: string | null } | null> {
  const [row] = await getDb().select({ inviterUserId: seatJoinBlocks.inviterUserId }).from(seatJoinBlocks)
    .where(and(eq(seatJoinBlocks.serverId, serverId), eq(seatJoinBlocks.userId, userId), eq(seatJoinBlocks.state, "active")))
    .limit(1);
  if (!row || await serverService.isMember(serverId, userId)) return null;
  return row;
}

/**
 * Whether someone a `join` seat request is for still needs a seat, asked
 * before the owner pays (GET seat-request) and when they complete it: not a
 * member of the server, and their latest notice didn't end because they
 * joined. A notice that ended `room` (the Stripe sync ends every notice once
 * a seat is bought, often the very seat the owner is paying for) or `expired`
 * (say, while the owner paid) still needs one: they open the link again.
 */
export async function stillNeedsSeatToJoin(serverId: string, userId: string): Promise<boolean> {
  if (await serverService.isMember(serverId, userId)) return false;
  const [latest] = await getDb().select({ resolvedReason: seatJoinBlocks.resolvedReason }).from(seatJoinBlocks)
    .where(and(eq(seatJoinBlocks.serverId, serverId), eq(seatJoinBlocks.userId, userId)))
    .orderBy(desc(seatJoinBlocks.createdAt))
    .limit(1);
  return latest?.resolvedReason !== "joined";
}

/** Ends `userId`'s active notice on `serverId` (conditional on `active`, so it ends once); true when one ended. */
export async function resolveSeatJoinBlock(
  input: { serverId: string; userId: string; reason: SeatJoinBlockResolvedReason },
  executor: DatabaseExecutor = getDb(),
): Promise<boolean> {
  const ended = await executor.update(seatJoinBlocks)
    .set({ state: "resolved", resolvedAt: new Date(), resolvedReason: input.reason })
    .where(and(eq(seatJoinBlocks.serverId, input.serverId), eq(seatJoinBlocks.userId, input.userId), eq(seatJoinBlocks.state, "active")))
    .returning({ id: seatJoinBlocks.id });
  if (ended.length > 0) announceSeatJoinBlocksChanged([input.serverId]);
  return ended.length > 0;
}

/**
 * The seats changed (the Stripe sync in billingService): if there's a seat for
 * a person now, every active notice on the server ends `room`; the people they
 * were about open the link again. Cheap when there are none: one indexed read.
 */
export async function resolveSeatJoinBlocksWithRoom(serverId: string): Promise<number> {
  const db = getDb();
  const [any] = await db.select({ id: seatJoinBlocks.id }).from(seatJoinBlocks)
    .where(and(eq(seatJoinBlocks.serverId, serverId), eq(seatJoinBlocks.state, "active")))
    .limit(1);
  if (!any || await outOfSeatsForAPerson(serverId, db)) return 0;
  const ended = await db.update(seatJoinBlocks)
    .set({ state: "resolved", resolvedAt: new Date(), resolvedReason: "room" })
    .where(and(eq(seatJoinBlocks.serverId, serverId), eq(seatJoinBlocks.state, "active")))
    .returning({ id: seatJoinBlocks.id });
  if (ended.length > 0) announceSeatJoinBlocksChanged([serverId]);
  return ended.length;
}

/**
 * The seat request sweep's part (hourly): ends notices active past
 * SEAT_REQUEST_TTL_MS (the same 7 days as a request), and deletes rows ended
 * more than RESOLVED_SEAT_JOIN_BLOCK_RETENTION_MS ago, a batch at a time.
 */
export async function sweepSeatJoinBlocks(now = Date.now()): Promise<{ expired: number; deleted: number }> {
  const db = getDb();
  const expired = await db.update(seatJoinBlocks)
    .set({ state: "resolved", resolvedAt: new Date(now), resolvedReason: "expired" })
    .where(and(eq(seatJoinBlocks.state, "active"), lt(seatJoinBlocks.createdAt, new Date(now - SEAT_REQUEST_TTL_MS))))
    .returning({ id: seatJoinBlocks.id, serverId: seatJoinBlocks.serverId });
  // Ended rows only: deleting rows that had already ended changes no list.
  announceSeatJoinBlocksChanged(expired.map((row) => row.serverId));
  const old = db.select({ id: seatJoinBlocks.id }).from(seatJoinBlocks)
    .where(and(eq(seatJoinBlocks.state, "resolved"), lt(seatJoinBlocks.resolvedAt, new Date(now - RESOLVED_SEAT_JOIN_BLOCK_RETENTION_MS))))
    .limit(1000);
  const deleted = await db.delete(seatJoinBlocks).where(inArray(seatJoinBlocks.id, old)).returning({ id: seatJoinBlocks.id });
  return { expired: expired.length, deleted: deleted.length };
}
