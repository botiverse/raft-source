// A person's own sign-ins (routes/mySessions.ts, GET/DELETE /api/me/sessions,
// POST /api/me/sessions/revoke-others): list their live `full` session
// families (web, desktop, mobile) and sign other ones out.
//
// Only `full` families are listed or revoked here. Device families (Raft
// Computer, the raft CLI) are not sign-ins the person sees here: revoking one
// also revokes what it holds (deviceSessionKeys.ts), which is the Computers
// page's business.
//
// Two reasons, chosen by the person, never defaulted:
//   - `sign_out`: logout-like (`user_signed_out`). What the session issued or
//     approved keeps working, as after a logout. A family signed out this way
//     leaves the list: it can't be upgraded to `lost_device` later from here
//     (a password change still reaches it).
//   - `lost_device`: a security revoke. One family `user_revoked`, every
//     other one `user_revoked_others`; after commit the security-revoke
//     cascade (securityRevokeCascade.ts) revokes what the session(s) approved
//     through one-time grants (approverSessionGrants.ts) and issued themselves
//     (webSessionIssuedKeys.ts), with a notice email; for "every other one"
//     that is every revoked family of the person but the one asking, the ones
//     signed out earlier included (like a password change). Both reasons are
//     in securityRevokedFamily(), so maintenance repairs a cascade that failed
//     after the revoke committed.
//
// Lock order is every family revoker's: the person's `users` row FOR UPDATE
// first, then the families. After commit, Socket is told for each revoked
// family (revokeSocketAccess). Each revoke is audited
// (`account.session_revoked`, the person as actor).
//
// The client platform and version shown are the client's own claims
// (sessionClient.ts): display only, never read by any check here.

import { currentDate } from "@botiverse/raft-shared";
import { and, desc, eq, gt, isNull, max, notExists, sql } from "drizzle-orm";
import { getDb, type DatabaseExecutor } from "../db/index";
import { agentCredentials, computers, deviceLoginGrants, machines, sessionFamilies, sessions } from "../db/schema";
import { revokeSocketAccess } from "../socket/accessRevocation";
import { recordIntegrationAuditEvent } from "./integrationAuditService";
import { runSecurityRevokeCascade } from "./securityRevokeCascade";
import type { SessionClient } from "./sessionClient";
import {
  lockActiveUser,
  revokeOtherWebSessionFamiliesInTransaction,
  revokeSessionFamilyInTransaction,
  USER_REVOKED_OTHERS_REVOKED_REASON,
  USER_REVOKED_REASON,
  USER_SIGNED_OUT_REVOKED_REASON,
} from "./sessionService";

export const MY_SESSION_REVOKE_REASONS = ["sign_out", "lost_device"] as const;
export type MySessionRevokeReason = (typeof MY_SESSION_REVOKE_REASONS)[number];

export function parseMySessionRevokeReason(raw: unknown): MySessionRevokeReason | null {
  return typeof raw === "string" && (MY_SESSION_REVOKE_REASONS as readonly string[]).includes(raw) ? raw as MySessionRevokeReason : null;
}

/** What `lost_device` would turn off: live Computers (and legacy machine keys) and agent keys the session(s) approved or issued. */
export type LostDeviceReach = { computers: number; agentKeys: number };

export type MySession = {
  id: string;
  /** The client's own claims (display only); null when unknown (a sign-in from before they were recorded). */
  platform: string | null;
  version: string | null;
  createdAt: string;
  lastActiveAt: string;
  current: boolean;
  secondFactorVerified: boolean;
  lostDeviceReach: LostDeviceReach;
};

export type MySessionList = { sessions: MySession[]; othersLostDeviceReach: LostDeviceReach };

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * Per family of the person: the live Computers / legacy machines and agent
 * keys it approved (one-time grants) or issued itself, by id, so "every
 * other one" counts each once. Read only; the cascade itself decides at
 * revoke time.
 */
async function reachByFamily(db: DatabaseExecutor, userId: string): Promise<{ computers: Array<[string, string]>; keys: Array<[string, string]> }> {
  const own = eq(sessionFamilies.userId, userId);
  const [grantComputers, issuedComputers, issuedMachines, grantKeys, issuedKeys] = await Promise.all([
    db.select({ familyId: sessionFamilies.id, id: computers.id })
      .from(deviceLoginGrants)
      .innerJoin(sessionFamilies, eq(sessionFamilies.id, deviceLoginGrants.approverSessionFamilyId))
      .innerJoin(computers, and(eq(computers.id, deviceLoginGrants.consumedComputerId), eq(computers.keyIssuedByGrantId, deviceLoginGrants.id)))
      .where(and(own, isNull(computers.revokedAt))),
    db.select({ familyId: sessionFamilies.id, id: computers.id })
      .from(computers)
      .innerJoin(sessionFamilies, eq(sessionFamilies.id, computers.keyIssuedByWebSessionFamilyId))
      .where(and(own, isNull(computers.revokedAt))),
    db.select({ familyId: sessionFamilies.id, id: machines.id })
      .from(machines)
      .innerJoin(sessionFamilies, eq(sessionFamilies.id, machines.keyIssuedByWebSessionFamilyId))
      .where(and(own, isNull(machines.legacyKeyMigratedAt),
        notExists(db.select({ id: computers.id }).from(computers).where(eq(computers.machineId, machines.id))))),
    db.select({ familyId: sessionFamilies.id, id: agentCredentials.id })
      .from(deviceLoginGrants)
      .innerJoin(sessionFamilies, eq(sessionFamilies.id, deviceLoginGrants.approverSessionFamilyId))
      .innerJoin(agentCredentials, eq(agentCredentials.id, deviceLoginGrants.consumedAgentCredentialId))
      .where(and(own, isNull(agentCredentials.revokedAt))),
    db.select({ familyId: sessionFamilies.id, id: agentCredentials.id })
      .from(agentCredentials)
      .innerJoin(sessionFamilies, eq(sessionFamilies.id, agentCredentials.issuedByWebSessionFamilyId))
      .where(and(own, isNull(agentCredentials.revokedAt))),
  ]);
  const pairs = (rows: Array<{ familyId: string; id: string }>) => rows.map((row): [string, string] => [row.familyId, row.id]);
  return {
    computers: [...pairs(grantComputers), ...pairs(issuedComputers), ...pairs(issuedMachines)],
    keys: [...pairs(grantKeys), ...pairs(issuedKeys)],
  };
}

function reachOf(pairs: { computers: Array<[string, string]>; keys: Array<[string, string]> }, include: (familyId: string) => boolean): LostDeviceReach {
  const count = (list: Array<[string, string]>) => new Set(list.filter(([familyId]) => include(familyId)).map(([, id]) => id)).size;
  return { computers: count(pairs.computers), agentKeys: count(pairs.keys) };
}

/**
 * The person's live `full` sign-ins (not revoked, not retired, with an
 * unexpired refresh row), newest activity first. The current one
 * (`currentFamilyId`) never shows an unknown client: what the asking request
 * says fills in, and is stored when the family had none.
 */
export async function listMySessions(userId: string, currentFamilyId: string, requestClient: SessionClient, now = currentDate()): Promise<MySessionList> {
  const db = getDb();
  const rows = await db
    .select({
      id: sessionFamilies.id,
      platform: sessionFamilies.clientPlatform,
      version: sessionFamilies.clientVersion,
      createdAt: sessionFamilies.createdAt,
      lastActiveAt: sessionFamilies.lastActiveAt,
      newestRefreshAt: max(sessions.createdAt),
      secondFactorVerifiedAt: sessionFamilies.secondFactorVerifiedAt,
    })
    .from(sessionFamilies)
    .innerJoin(sessions, and(eq(sessions.familyId, sessionFamilies.id), gt(sessions.expiresAt, now)))
    .where(and(
      eq(sessionFamilies.userId, userId),
      eq(sessionFamilies.scope, "full"),
      isNull(sessionFamilies.revokedAt),
      isNull(sessionFamilies.retiredAt),
    ))
    .groupBy(sessionFamilies.id)
    .orderBy(desc(sessionFamilies.createdAt));

  const current = rows.find((row) => row.id === currentFamilyId);
  if (current && ((!current.platform && requestClient.platform) || (!current.version && requestClient.version))) {
    // Backfill (display only): a family from before the columns, or signed in by a redirect that sent no headers.
    await db.update(sessionFamilies).set({
      clientPlatform: sql`coalesce(${sessionFamilies.clientPlatform}, ${requestClient.platform}::text)`,
      clientVersion: sql`coalesce(${sessionFamilies.clientVersion}, ${requestClient.version}::text)`,
    }).where(and(eq(sessionFamilies.id, currentFamilyId), eq(sessionFamilies.userId, userId)));
  }

  const reach = await reachByFamily(db, userId);
  const list = rows.map((row): MySession => {
    const isCurrent = row.id === currentFamilyId;
    const lastActive = row.lastActiveAt ?? row.newestRefreshAt ?? row.createdAt;
    return {
      id: row.id,
      platform: row.platform ?? (isCurrent ? requestClient.platform : null),
      version: row.version ?? (isCurrent ? requestClient.version : null),
      createdAt: row.createdAt.toISOString(),
      // The current request is activity too.
      lastActiveAt: (isCurrent ? now : new Date(lastActive)).toISOString(),
      current: isCurrent,
      secondFactorVerified: row.secondFactorVerifiedAt !== null,
      lostDeviceReach: reachOf(reach, (familyId) => familyId === row.id),
    };
  });
  list.sort((a, b) => Number(b.current) - Number(a.current) || b.lastActiveAt.localeCompare(a.lastActiveAt));
  return { sessions: list, othersLostDeviceReach: reachOf(reach, (familyId) => familyId !== currentFamilyId) };
}

export type RevokeMySessionResult = { result: "revoked"; cascade: MySessionCascade } | { result: "current" } | { result: "not_found" };

async function auditRevoke(tx: DatabaseExecutor, input: {
  userId: string; currentFamilyId: string; revoked: string[]; reason: MySessionRevokeReason; scope: "one" | "others";
}): Promise<void> {
  await recordIntegrationAuditEvent({
    serverId: null,
    eventType: "account.session_revoked",
    outcome: "success",
    source: "web",
    actor: { type: "human", id: input.userId },
    subject: { type: "human", id: input.userId },
    target: { type: "user", id: input.userId },
    metadata: {
      sessionFamilyId: input.currentFamilyId,
      revokedSessionFamilyIds: input.revoked,
      reason: input.reason,
      scope: input.scope,
      signedOutSessionCount: input.revoked.length,
    },
  }, tx);
}

/** After commit: Socket drops the revoked families' connections. Logged, not thrown: the revoke stands. */
async function evict(userId: string, familyIds: readonly string[]): Promise<void> {
  for (const familyId of familyIds) {
    try {
      await revokeSocketAccess({ userId, familyId });
    } catch (err) {
      console.error(`[my-sessions] evicting signed-out sign-in ${familyId} failed:`, err);
    }
  }
}

/**
 * Whether a write's `lost_device` cascade finished: `done`, `pending` (it
 * failed after the revoke committed; the hourly repair will do it, reading the
 * stored reason, securityRevokedFamily), or `none` (`sign_out`: no cascade).
 */
export type MySessionCascade = "done" | "pending" | "none";

let runCascade = runSecurityRevokeCascade;
/** Tests: make the cascade fail (or restore it with null). */
export function __setMySessionsCascadeForTests(run: typeof runSecurityRevokeCascade | null): void {
  runCascade = run ?? runSecurityRevokeCascade;
}

/**
 * After commit, `lost_device` only. `repairable`: a revoke in this write
 * stored a reason the repair reads, so a failure is `pending` (logged); with
 * none (revoke-others that revoked nothing new) nothing would ever retry it,
 * so the failure is thrown to the caller.
 */
async function cascade(scope: Parameters<typeof runSecurityRevokeCascade>[0], now: Date, repairable: boolean): Promise<MySessionCascade> {
  try {
    await runCascade(scope, "user_revoked", now);
    return "done";
  } catch (err) {
    if (!repairable) throw err;
    console.error("[my-sessions] revoking what the lost device's session approved or issued failed (the hourly repair retries it):", err);
    return "pending";
  }
}

/**
 * Revokes one of the person's own other live `full` sign-ins. `current` for
 * the asking sign-in itself (sign out instead). `not_found` alike for an id
 * that is not a uuid, unknown, another person's, a device family, or already
 * revoked or retired: the answer never tells them apart.
 */
export async function revokeMySession(input: {
  userId: string; currentFamilyId: string; familyId: string; reason: MySessionRevokeReason; now?: Date;
}): Promise<RevokeMySessionResult> {
  const now = input.now ?? currentDate();
  const { userId, familyId } = input;
  if (!UUID.test(familyId)) return { result: "not_found" };
  if (familyId.toLowerCase() === input.currentFamilyId.toLowerCase()) return { result: "current" };
  const revokedFamilyId = await getDb().transaction(async (tx): Promise<string | null> => {
    if (!(await lockActiveUser(tx, userId))) return null;
    const [family] = await tx.select({ id: sessionFamilies.id }).from(sessionFamilies)
      .where(and(
        eq(sessionFamilies.id, familyId),
        eq(sessionFamilies.userId, userId),
        eq(sessionFamilies.scope, "full"),
        isNull(sessionFamilies.revokedAt),
        isNull(sessionFamilies.retiredAt),
      ))
      .for("update");
    if (!family) return null;
    await revokeSessionFamilyInTransaction(tx, userId, family.id,
      input.reason === "lost_device" ? USER_REVOKED_REASON : USER_SIGNED_OUT_REVOKED_REASON, now);
    await auditRevoke(tx, { userId, currentFamilyId: input.currentFamilyId, revoked: [family.id], reason: input.reason, scope: "one" });
    return family.id;
  });
  if (revokedFamilyId === null) return { result: "not_found" };
  // PostgreSQL accepts UUID letter case; Socket identities use the stored id.
  // Every post-commit effect must name the family the transaction revoked.
  await evict(userId, [revokedFamilyId]);
  return { result: "revoked", cascade: input.reason === "lost_device" ? await cascade({ familyId: revokedFamilyId }, now, true) : "none" };
}

/**
 * Revokes every other live `full` sign-in of the person, keeping the asking
 * one and every device family. Returns the revoked family ids and whether the
 * `lost_device` cascade finished; throws when it failed with nothing newly
 * revoked (no stored reason the hourly repair could retry from).
 */
export async function revokeMyOtherSessions(input: {
  userId: string; currentFamilyId: string; reason: MySessionRevokeReason; now?: Date;
}): Promise<{ revoked: string[]; cascade: MySessionCascade }> {
  const now = input.now ?? currentDate();
  const { userId, currentFamilyId } = input;
  const revoked = await getDb().transaction(async (tx) => {
    const ids = await revokeOtherWebSessionFamiliesInTransaction(tx, userId, currentFamilyId, now,
      input.reason === "lost_device" ? USER_REVOKED_OTHERS_REVOKED_REASON : USER_SIGNED_OUT_REVOKED_REASON);
    await auditRevoke(tx, { userId, currentFamilyId, revoked: ids, reason: input.reason, scope: "others" });
    return ids;
  });
  await evict(userId, revoked);
  if (input.reason !== "lost_device") return { revoked, cascade: "none" };
  // Still run with nothing newly revoked: it reaches sign-ins signed out earlier.
  return { revoked, cascade: await cascade({ userId, exemptFamilyId: currentFamilyId }, now, revoked.length > 0) };
}
