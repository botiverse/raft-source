// What a person's own web (full) session issued directly, recorded with that
// session's family at issue time:
//   - agent keys it minted (POST /api/agents/:id/credentials) and the bootstrap
//     tokens it issued (POST /api/agents/:id/bootstrap-tokens), whose family is
//     copied onto the key they are exchanged for
//     (`agent_credentials.issued_by_web_session_family_id`,
//     `agent_bootstrap_tokens.issued_by_web_session_family_id`);
//   - Computer keys it attached or adopted (POST /api/computer/attach and
//     adopt-legacy with that session; `computers.key_issued_by_web_session_family_id`);
//   - legacy `sk_machine_*` keys it registered or rotated (POST
//     /api/servers/:id/machines, .../rotate-key; `daemons.key_issued_by_web_session_family_id`).
//
// A stolen web session can do all of these for the thief. So, like what the
// session approved through one-time grants (approverSessionGrants.ts), a
// SECURITY revoke of the session also revokes them: a password change or
// reset and the account's retirement (every revoked family of the person, the
// ones signed out earlier included), and a device login's revoke link (that
// one family; a device family never issues here, see below). A plain logout,
// an expired session and the push capability revoke never do, so signing out
// of a browser never knocks a machine offline. The same scopes and the same
// "security-revoked" reading of state as approverSessionGrants.ts
// (revokedFamilyInScope); hourly maintenance repairs a run that failed after
// its revoke committed.
//
// These columns are not the device-session ones (`issued_by_session_family_id`,
// `key_issued_by_session_family_id`, deviceSessionKeys.ts), which follow ANY
// revoke of a device login's session: only a `full` session is recorded here
// (sessionService.webSessionFamilyOf), only a `device` one there.
//
// Completeness: every issue above fences its live family in its transaction
// (sessionService.lockLiveSessionFamily), so a revoke either commits first
// (nothing is issued) or waits for the issue to commit, and this, which runs
// after the revoke commits, sees what it wrote. A bootstrap token exchanged
// later is claimed with `revoked_at IS NULL`: the tokens are revoked first
// here, so an exchange either commits first (its key is revoked below) or
// finds the token revoked.
//
// Order: pending bootstrap tokens are revoked (nothing new can be exchanged);
// then each live Computer is revoked in its own transaction with
// computerKeyRevocation (its runner credentials too); each legacy machine's key
// is discarded in its own transaction (replaced by one nobody holds, as a
// rotation does, with the runner credentials the machine minted; the machine
// and its agents stay, and its owner rotates the key to reconnect); then the
// live agent keys in one. The keys are audited (a pending bootstrap token's
// revoke is not, like a grant's expiry in approverSessionGrants.ts: it issued
// nothing); connections and open streams are closed after commit, best effort
// (a failed drop is not retried, as with rotate-key). Idempotent: a second run
// revokes only what is still live.
//
// The session that changed the password is exempt (approverSessionGrants.ts,
// revokedFamilyInScope): what it issued keeps working.

import { currentDate } from "@botiverse/raft-shared";
import { and, eq, inArray, isNull, notExists } from "drizzle-orm";
import { getDb } from "../db/index";
import { agentBootstrapTokens, agentCredentials, agents, computers, machines, sessionFamilies } from "../db/schema";
import { revokedFamilyInScope, type ApproverSessionRevokeTrigger, type ApproverSessionScope } from "./approverSessionGrants";
import { revokeComputerKeyInTransaction } from "./computerKeyRevocation";
import { closeDeviceSessionKeys } from "./deviceSessionKeys";
import { newAuditOperationId, recordIntegrationAuditEvent } from "./integrationAuditService";
import { clearAuthCache, generateMachineKeyMaterial } from "./machineService";
import type { SecurityRevokeTally } from "./securityRevokeNotice";

export const WEB_SESSION_REVOKED_REASON = "web_session_revoked";

export interface WebSessionIssuedRevokeResult {
  bootstrapTokens: number;
  computers: number;
  machines: number;
  credentials: number;
}

const unique = (values: Array<string | null | undefined>): string[] =>
  [...new Set(values.filter((value): value is string => Boolean(value)))];

/** The system revokes it, for the person whose session issued it. */
function systemFor(userId: string | null) {
  const person = userId ? { type: "human" as const, id: userId } : null;
  return { outcome: "success" as const, source: "system" as const, actor: { type: "system" as const }, requester: person, subject: person };
}

/**
 * Revokes every live key a revoked web session family in scope issued
 * directly, after that family's revoke has committed. One key's failure
 * doesn't stop the others: all run, then the first error is thrown.
 */
export async function revokeWhatRevokedWebSessionsIssued(
  scope: ApproverSessionScope,
  trigger: ApproverSessionRevokeTrigger,
  now = currentDate(),
  tally?: SecurityRevokeTally,
): Promise<WebSessionIssuedRevokeResult> {
  const db = getDb();
  const families = db.select({ id: sessionFamilies.id }).from(sessionFamilies).where(revokedFamilyInScope(scope));
  const operationId = newAuditOperationId();
  const failures: unknown[] = [];

  // Nothing more may be exchanged from them.
  const tokens = await db
    .update(agentBootstrapTokens)
    .set({ revokedAt: now, revokedReason: WEB_SESSION_REVOKED_REASON })
    .where(and(
      isNull(agentBootstrapTokens.consumedAt),
      isNull(agentBootstrapTokens.revokedAt),
      inArray(agentBootstrapTokens.issuedByWebSessionFamilyId, families),
    ))
    .returning({ id: agentBootstrapTokens.id });

  // Computers: each in its own transaction, re-checked under its row lock (an
  // adoption may have rotated the key to another session since the read).
  const liveComputers = await db
    .select({ computerId: computers.id, familyId: sessionFamilies.id, userId: sessionFamilies.userId, serverId: computers.serverId })
    .from(computers)
    .innerJoin(sessionFamilies, eq(sessionFamilies.id, computers.keyIssuedByWebSessionFamilyId))
    .where(and(isNull(computers.revokedAt), revokedFamilyInScope(scope)));
  let revokedComputers = 0;
  for (const live of liveComputers) {
    try {
      const result = await db.transaction(async (tx) => {
        const [still] = await tx
          .select({ id: computers.id })
          .from(computers)
          .where(and(eq(computers.id, live.computerId), eq(computers.keyIssuedByWebSessionFamilyId, live.familyId), isNull(computers.revokedAt)))
          .for("update");
        if (!still) return null;
        return revokeComputerKeyInTransaction(tx, {
          computerId: live.computerId,
          by: { via: "web_session_revoked", trigger },
          now,
          operationId,
        });
      });
      if (result?.revoked) {
        revokedComputers += 1;
        tally?.computer(live.userId, live.serverId);
      }
      if (result) await closeDeviceSessionKeys(result.reach);
    } catch (err) {
      console.error(`[web-session] revoking Computer ${live.computerId} after the session that attached it was revoked failed:`, err);
      failures.push(err);
    }
  }

  // Legacy machines whose sk_machine_* key is still live: not adopted into a
  // Computer (adoption kills the legacy key, and the machine's runner
  // credentials are then the Computer's).
  const noComputer = notExists(db.select({ id: computers.id }).from(computers).where(eq(computers.machineId, machines.id)));
  const liveMachines = await db
    .select({ machineId: machines.id, familyId: sessionFamilies.id, issuerUserId: sessionFamilies.userId })
    .from(machines)
    .innerJoin(sessionFamilies, eq(sessionFamilies.id, machines.keyIssuedByWebSessionFamilyId))
    .where(and(isNull(machines.legacyKeyMigratedAt), noComputer, revokedFamilyInScope(scope)));
  let revokedMachines = 0;
  for (const live of liveMachines) {
    try {
      // argon2 is slow: the replacement key is hashed before any lock, and never returned.
      const discarded = await generateMachineKeyMaterial();
      const reach = await db.transaction(async (tx) => {
        const [machine] = await tx
          .update(machines)
          .set({
            apiKeyHash: discarded.apiKeyHash,
            apiKeyPrefix: discarded.apiKeyPrefix,
            apiKeyFingerprint: discarded.apiKeyFingerprint,
            keyIssuedByWebSessionFamilyId: null,
          })
          // The same family still issued the current key (a rotation since the read issued another).
          .where(and(
            eq(machines.id, live.machineId),
            eq(machines.keyIssuedByWebSessionFamilyId, live.familyId),
            isNull(machines.legacyKeyMigratedAt),
            notExists(tx.select({ id: computers.id }).from(computers).where(eq(computers.machineId, live.machineId))),
          ))
          .returning({ id: machines.id, serverId: machines.serverId, userId: machines.userId });
        if (!machine) return null;
        const credentials = await tx
          .update(agentCredentials)
          .set({ revokedAt: now, revokedReason: WEB_SESSION_REVOKED_REASON })
          .where(and(eq(agentCredentials.issuedByMachineId, machine.id), isNull(agentCredentials.revokedAt)))
          .returning({ credentialId: agentCredentials.id, agentId: agentCredentials.agentId });
        // For the person whose session issued the key (a rotation may be another admin's), not the machine's owner.
        const audit = systemFor(live.issuerUserId);
        await recordIntegrationAuditEvent({
          ...audit,
          serverId: machine.serverId,
          eventType: "computer.key_revoked",
          target: { type: "machine", id: machine.id },
          metadata: { machineId: machine.id, reason: WEB_SESSION_REVOKED_REASON, via: WEB_SESSION_REVOKED_REASON, revokedCount: credentials.length, trigger, operationId },
        }, tx);
        for (const credential of credentials) {
          await recordIntegrationAuditEvent({
            ...audit,
            serverId: machine.serverId,
            eventType: "agent_credential.revoked",
            target: { type: "agent_credential", id: credential.credentialId },
            metadata: { agentId: credential.agentId, credentialId: credential.credentialId, reason: WEB_SESSION_REVOKED_REASON, via: WEB_SESSION_REVOKED_REASON, trigger, operationId },
          }, tx);
        }
        return { agentIds: unique(credentials.map((credential) => credential.agentId)), machineIds: [machine.id], serverId: machine.serverId };
      });
      if (reach) {
        revokedMachines += 1;
        tally?.computer(live.issuerUserId, reach.serverId);
        // After commit, as a rotation does: the old key must fail on its next use.
        clearAuthCache(live.machineId);
        await closeDeviceSessionKeys(reach);
      }
    } catch (err) {
      console.error(`[web-session] discarding machine ${live.machineId}'s key after the session that issued it was revoked failed:`, err);
      failures.push(err);
    }
  }

  let revokedCredentials = 0;
  try {
    const credentials = await db.transaction(async (tx) => {
      const live = await tx
        .select({ credentialId: agentCredentials.id, userId: sessionFamilies.userId })
        .from(agentCredentials)
        .innerJoin(sessionFamilies, eq(sessionFamilies.id, agentCredentials.issuedByWebSessionFamilyId))
        .where(and(isNull(agentCredentials.revokedAt), revokedFamilyInScope(scope)));
      if (live.length === 0) return [];
      const personOf = new Map(live.map((row) => [row.credentialId, row.userId]));
      const revoked = await tx
        .update(agentCredentials)
        .set({ revokedAt: now, revokedReason: WEB_SESSION_REVOKED_REASON })
        .where(and(inArray(agentCredentials.id, live.map((row) => row.credentialId)), isNull(agentCredentials.revokedAt)))
        .returning({ credentialId: agentCredentials.id, agentId: agentCredentials.agentId, createdByUserId: agentCredentials.createdByUserId });
      const agentIds = unique(revoked.map((credential) => credential.agentId));
      const serverOfAgent = new Map(agentIds.length === 0 ? [] : (await tx
        .select({ id: agents.id, serverId: agents.serverId })
        .from(agents)
        .where(inArray(agents.id, agentIds))).map((agent) => [agent.id, agent.serverId]));
      for (const credential of revoked) {
        await recordIntegrationAuditEvent({
          ...systemFor(credential.createdByUserId),
          serverId: serverOfAgent.get(credential.agentId) ?? null,
          eventType: "agent_credential.revoked",
          target: { type: "agent_credential", id: credential.credentialId },
          metadata: {
            agentId: credential.agentId,
            credentialId: credential.credentialId,
            reason: WEB_SESSION_REVOKED_REASON,
            via: WEB_SESSION_REVOKED_REASON,
            trigger,
            operationId,
          },
        }, tx);
      }
      return revoked.map((credential) => ({
        ...credential,
        userId: personOf.get(credential.credentialId) ?? null,
        serverId: serverOfAgent.get(credential.agentId) ?? null,
      }));
    });
    revokedCredentials = credentials.length;
    for (const credential of credentials) tally?.key(credential.userId, credential.serverId);
    await closeDeviceSessionKeys({ agentIds: unique(credentials.map((credential) => credential.agentId)), machineIds: [] });
  } catch (err) {
    console.error("[web-session] revoking agent keys after the session that minted them was revoked failed:", err);
    failures.push(err);
  }

  if (failures.length > 0) throw failures[0];
  return { bootstrapTokens: tokens.length, computers: revokedComputers, machines: revokedMachines, credentials: revokedCredentials };
}
