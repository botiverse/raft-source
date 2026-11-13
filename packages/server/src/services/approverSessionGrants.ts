// What a web session approved through one-time device-login grants
// (deviceLoginGrantService.ts): a Computer attached with the grant's attach
// token (`device_login_grants.consumed_computer_id`, whose key records the
// grant in `computers.key_issued_by_grant_id`) and an agent key minted for the
// grant (`consumed_agent_credential_id`). The grant records the approving
// session's family (`approver_session_family_id`, written at POST
// /api/auth/device/approve under a fence on that family).
//
// A stolen web session can approve a grant for the thief's machine. So a
// SECURITY revoke of the session also revokes what it approved: a password
// change or reset, an account deletion request and the account's retirement
// (every family of the person),
// and a device login's "this wasn't me" link (that one family). A plain
// logout, an expired session and the push capability revoke never do, so
// signing out of a browser never knocks a machine offline. (Unlike
// deviceSessionKeys.ts, where the keys a device session holds go with it for
// any revoke.)
//
// A person-wide trigger covers every family of theirs that is revoked, the
// ones signed out earlier included: otherwise a thief could sign the stolen
// session out right after approving to keep what it approved past a password
// change. Only revoked families are ever followed, and grants with no family
// (approved before the column existed, or by a legacy token with no family)
// never are. One family is exempt: the session that changed the password
// (it gave the current password, so it is the person). Its family is revoked
// `password_changed` instead of `revoke_all` (sessionService), the trigger
// names it (`exemptFamilyId`), and the repair below reads the reason, so it
// keeps it too; a later password change or reset takes it like any other.
//
// Each trigger runs it after its revoke commits; hourly maintenance repairs
// one that failed in between ("security-revoked", below: it reads the revoke
// from state, so it never reaches a family only signed out).
//
// Order: first the families' still-unused approved grants are expired, so
// nothing new can be issued from them (an attach locks its grant FOR UPDATE
// and a key mint claims it with a conditional UPDATE, so either that commits
// first and what it issued is found below, or it finds the grant expired);
// then each live Computer is revoked in its own transaction with
// computerKeyRevocation (its runner credentials too), and the live agent keys
// in one, all audited; connections and open streams are closed after commit.
// Idempotent: a second run revokes only what is still live.

import { currentDate } from "@botiverse/raft-shared";
import { and, eq, exists, gt, gte, inArray, isNotNull, isNull, ne, or, sql, type SQL } from "drizzle-orm";
import { alias } from "drizzle-orm/pg-core";
import { getDb } from "../db/index";
import { agentCredentials, agents, computers, deviceLoginGrants, sessionFamilies, users } from "../db/schema";
import { revokeComputerKeyInTransaction, type ApproverSessionRevokeTrigger } from "./computerKeyRevocation";
import { closeDeviceSessionKeys, type DeviceSessionKeyReach } from "./deviceSessionKeys";
import { newAuditOperationId, recordIntegrationAuditEvent } from "./integrationAuditService";
import type { SecurityRevokeTally } from "./securityRevokeNotice";
import { PASSWORD_CHANGED_REVOKED_REASON } from "./sessionService";

export type { ApproverSessionRevokeTrigger };

export const APPROVER_SESSION_REVOKED_REASON = "approver_session_revoked";

/**
 * One family (a revoke link), every family of one person (a password change,
 * the account's retirement; but `exemptFamilyId`, the session that changed the
 * password), or every security-revoked family (maintenance).
 */
export type ApproverSessionScope = { familyId: string } | { userId: string; exemptFamilyId?: string | null } | "security_revoked";

export interface ApproverSessionRevokeResult {
  expiredGrants: number;
  computers: number;
  credentials: number;
}

const unique = (values: Array<string | null | undefined>): string[] =>
  [...new Set(values.filter((value): value is string => Boolean(value)))];

const laterRevokeAll = alias(sessionFamilies, "later_revoke_all");

/**
 * A family whose revoke was a security revoke, read from state (what the
 * triggers write): a device login's revoke link (`device_login_revoked`), the
 * account's retirement (`users.retired_at`), or a password change or reset at
 * or after the family's revoke (it revokes every live family `revoke_all`, the
 * changing session's `password_changed`, all with one timestamp; a family
 * signed out before it counts too, see above). The changing session's own
 * family is exempt from its own change (same timestamp) and taken only by a
 * strictly later one.
 */
function securityRevokedFamily(): SQL {
  return or(
    eq(sessionFamilies.revokedReason, "device_login_revoked"),
    exists(getDb().select({ id: users.id }).from(users)
      .where(and(eq(users.id, sessionFamilies.userId), isNotNull(users.retiredAt)))),
    exists(getDb().select({ id: laterRevokeAll.id }).from(laterRevokeAll)
      .where(and(
        eq(laterRevokeAll.userId, sessionFamilies.userId),
        inArray(laterRevokeAll.revokedReason, ["revoke_all", PASSWORD_CHANGED_REVOKED_REASON]),
        or(
          and(gte(laterRevokeAll.revokedAt, sessionFamilies.revokedAt), sql`${sessionFamilies.revokedReason} is distinct from ${PASSWORD_CHANGED_REVOKED_REASON}`),
          gt(laterRevokeAll.revokedAt, sessionFamilies.revokedAt),
        ),
      ))),
  )!;
}

/** The revoked families in scope: the only ones whose grants are followed. */
export function revokedFamilyInScope(scope: ApproverSessionScope): SQL | undefined {
  return and(
    isNotNull(sessionFamilies.revokedAt),
    scope === "security_revoked"
      ? securityRevokedFamily()
      : "familyId" in scope
        ? eq(sessionFamilies.id, scope.familyId)
        : and(eq(sessionFamilies.userId, scope.userId), scope.exemptFamilyId ? ne(sessionFamilies.id, scope.exemptFamilyId) : undefined),
  );
}

/**
 * Revokes every live Computer key and agent key a grant approved by a revoked
 * family in scope issued, after that family's revoke has committed. One
 * Computer's failure doesn't stop the others: all run, then the first error is
 * thrown.
 */
export async function revokeWhatRevokedSessionsApproved(
  scope: ApproverSessionScope,
  trigger: ApproverSessionRevokeTrigger,
  now = currentDate(),
  tally?: SecurityRevokeTally,
): Promise<ApproverSessionRevokeResult> {
  const db = getDb();
  const families = db.select({ id: sessionFamilies.id }).from(sessionFamilies).where(revokedFamilyInScope(scope));

  // Nothing more may be issued from them.
  const expired = await db
    .update(deviceLoginGrants)
    .set({ status: "expired" })
    .where(and(eq(deviceLoginGrants.status, "approved"), inArray(deviceLoginGrants.approverSessionFamilyId, families)))
    .returning({ id: deviceLoginGrants.id });

  // From the grants (indexed by family) to what they issued, by primary key.
  const liveComputers = await db
    .select({ computerId: computers.id, grantId: deviceLoginGrants.id, userId: sessionFamilies.userId, serverId: computers.serverId })
    .from(deviceLoginGrants)
    .innerJoin(sessionFamilies, eq(sessionFamilies.id, deviceLoginGrants.approverSessionFamilyId))
    .innerJoin(computers, and(eq(computers.id, deviceLoginGrants.consumedComputerId), eq(computers.keyIssuedByGrantId, deviceLoginGrants.id)))
    .where(and(isNull(computers.revokedAt), revokedFamilyInScope(scope)));

  const failures: unknown[] = [];
  const operationId = newAuditOperationId();
  let revokedComputers = 0;
  for (const live of liveComputers) {
    try {
      const result = await db.transaction((tx) => revokeComputerKeyInTransaction(tx, {
        computerId: live.computerId,
        by: { via: "approver_session_revoked", grantId: live.grantId, trigger },
        now,
        operationId,
      }));
      if (result?.revoked) {
        revokedComputers += 1;
        tally?.computer(live.userId, live.serverId);
      }
      if (result) await closeDeviceSessionKeys(result.reach);
    } catch (err) {
      console.error(`[device-login] revoking Computer ${live.computerId} after its approver's session was revoked failed:`, err);
      failures.push(err);
    }
  }

  let revokedCredentials = 0;
  try {
    const credentials = await db.transaction(async (tx) => {
      const live = await tx
        .select({ credentialId: agentCredentials.id, grantId: deviceLoginGrants.id, approverUserId: deviceLoginGrants.approverUserId, familyUserId: sessionFamilies.userId })
        .from(deviceLoginGrants)
        .innerJoin(sessionFamilies, eq(sessionFamilies.id, deviceLoginGrants.approverSessionFamilyId))
        .innerJoin(agentCredentials, eq(agentCredentials.id, deviceLoginGrants.consumedAgentCredentialId))
        .where(and(isNull(agentCredentials.revokedAt), revokedFamilyInScope(scope)));
      if (live.length === 0) return [];
      const grantOf = new Map(live.map((row) => [row.credentialId, row]));
      const revoked = await tx
        .update(agentCredentials)
        .set({ revokedAt: now, revokedReason: APPROVER_SESSION_REVOKED_REASON })
        .where(and(inArray(agentCredentials.id, [...grantOf.keys()]), isNull(agentCredentials.revokedAt)))
        .returning({ credentialId: agentCredentials.id, agentId: agentCredentials.agentId });
      const agentIds = unique(revoked.map((credential) => credential.agentId));
      const serverOfAgent = new Map(agentIds.length === 0 ? [] : (await tx
        .select({ id: agents.id, serverId: agents.serverId })
        .from(agents)
        .where(inArray(agents.id, agentIds))).map((agent) => [agent.id, agent.serverId]));
      for (const credential of revoked) {
        const grant = grantOf.get(credential.credentialId)!;
        // The system revokes it, for the person whose session approved it.
        const person = grant.approverUserId ? { type: "human" as const, id: grant.approverUserId } : null;
        await recordIntegrationAuditEvent({
          serverId: serverOfAgent.get(credential.agentId) ?? null,
          eventType: "agent_credential.revoked",
          outcome: "success",
          source: "system",
          actor: { type: "system" },
          requester: person,
          subject: person,
          target: { type: "agent_credential", id: credential.credentialId },
          metadata: {
            agentId: credential.agentId,
            credentialId: credential.credentialId,
            reason: APPROVER_SESSION_REVOKED_REASON,
            via: "approver_session_revoked",
            grantId: grant.grantId,
            trigger,
            operationId,
          },
        }, tx);
      }
      return revoked.map((credential) => ({
        ...credential,
        userId: grantOf.get(credential.credentialId)!.familyUserId,
        serverId: serverOfAgent.get(credential.agentId) ?? null,
      }));
    });
    revokedCredentials = credentials.length;
    for (const credential of credentials) tally?.key(credential.userId, credential.serverId);
    await closeDeviceSessionKeys({ agentIds: unique(credentials.map((credential) => credential.agentId)), machineIds: [] });
  } catch (err) {
    console.error("[device-login] revoking agent keys after their approver's session was revoked failed:", err);
    failures.push(err);
  }

  if (failures.length > 0) throw failures[0];
  return { expiredGrants: expired.length, computers: revokedComputers, credentials: revokedCredentials };
}

/**
 * Everything one family's grants issued, revoked or not: what closing reaches,
 * for a used revoke link whose first click's fan-out may have failed (the
 * Computers' machines, the agents of the keys the grants minted and of the
 * runner credentials those machines minted).
 */
export async function approvedGrantReach(familyId: string): Promise<DeviceSessionKeyReach> {
  const db = getDb();
  const grants = await db
    .select({ computerId: deviceLoginGrants.consumedComputerId, credentialId: deviceLoginGrants.consumedAgentCredentialId })
    .from(deviceLoginGrants)
    .where(eq(deviceLoginGrants.approverSessionFamilyId, familyId));
  const computerIds = unique(grants.map((grant) => grant.computerId));
  const credentialIds = unique(grants.map((grant) => grant.credentialId));
  const machineIds = computerIds.length === 0 ? [] : unique((await db
    .select({ machineId: computers.machineId })
    .from(computers)
    .where(and(inArray(computers.id, computerIds), isNotNull(computers.keyIssuedByGrantId)))).map((row) => row.machineId));
  const agentIds = credentialIds.length === 0 && machineIds.length === 0 ? [] : unique((await db
    .select({ agentId: agentCredentials.agentId })
    .from(agentCredentials)
    .where(or(
      credentialIds.length > 0 ? inArray(agentCredentials.id, credentialIds) : undefined,
      machineIds.length > 0 ? inArray(agentCredentials.issuedByMachineId, machineIds) : undefined,
    ))).map((row) => row.agentId));
  return { agentIds, machineIds };
}
