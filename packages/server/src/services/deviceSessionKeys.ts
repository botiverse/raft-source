// What a device login's session handed out: every key that records the
// session's family, namely the agent credentials it minted
// (`agent_credentials.issued_by_session_family_id`), the Computer keys it holds
// (`computers.key_issued_by_session_family_id`, attach or adopt), and the
// runner credentials a Computer minted while that family held its key (stamped
// with the family at mint time, routes/internalComputer.ts). They go with the
// session, however it is revoked: its revoke link, a password change or reset,
// signing out everywhere, the account's retirement, a push revoke capability.
// One rule decides it, revokeKeysOfRevokedDeviceSessions: any key whose family
// is revoked is revoked. Every family revoker runs it after its commit, and
// hourly maintenance runs it over everyone, for a revoker that failed between
// its commit and this. A Computer is soft-revoked (its machine and agents stay;
// it reconnects only with a new attach), like a setup reset, not deleted.
// Audited; open agent streams and machine connections are closed after commit.
//
// It runs in its own transaction after the family's revoke committed, never
// under the revoke's `users` lock (a credential rotation's foreign key to
// `users` would otherwise deadlock with it). That is still complete: a device
// session's writes fence the live family (sessionService.lockLiveSessionFamily),
// so once the family is revoked none can commit; and a runner mint holds its
// Computer row FOR SHARE, which this UPDATE of `computers` waits for before the
// credentials' UPDATE takes its snapshot. Idempotent: running it again revokes
// only what is still live.

import { currentDate } from "@botiverse/raft-shared";
import { and, eq, isNotNull, isNull, type SQL } from "drizzle-orm";
import type { AnyPgColumn } from "drizzle-orm/pg-core";
import { getDb } from "../db/index";
import { agentCredentials, agents, computers, sessionFamilies } from "../db/schema";
import { broadcastAgentCredentialRevocation, dropMachineConnectionEverywhere } from "../replicaRouter";
import { newAuditOperationId, recordIntegrationAuditEvent } from "./integrationAuditService";

export const DEVICE_LOGIN_REVOKED_REASON = "device_login_revoked";

/** What closing after commit reaches: the agents whose credentials the family's keys were, the machines of its Computers. */
export interface DeviceSessionKeyReach {
  agentIds: string[];
  machineIds: string[];
}

const unique = (values: Array<string | null | undefined>): string[] =>
  [...new Set(values.filter((value): value is string => Boolean(value)))];

/** Revokes every still-live key the family handed out, audits each, and returns what closing them reaches. */
async function revokeDeviceSessionKeys(input: { familyId: string; userId: string; sessionRevokedReason: string | null; now: Date }): Promise<DeviceSessionKeyReach> {
  return await getDb().transaction(async (tx) => {
    // Computers first: a runner mint in flight holds its Computer row FOR SHARE until it commits.
    const keys = await tx
      .update(computers)
      .set({ revokedAt: input.now, revokedReason: DEVICE_LOGIN_REVOKED_REASON })
      .where(and(eq(computers.keyIssuedBySessionFamilyId, input.familyId), isNull(computers.revokedAt)))
      .returning({ computerId: computers.id, computerName: computers.name, machineId: computers.machineId, serverId: computers.serverId });
    const credentials = await tx
      .update(agentCredentials)
      .set({ revokedAt: input.now, revokedReason: DEVICE_LOGIN_REVOKED_REASON })
      .where(and(eq(agentCredentials.issuedBySessionFamilyId, input.familyId), isNull(agentCredentials.revokedAt)))
      .returning({ credentialId: agentCredentials.id, agentId: agentCredentials.agentId });
    if (keys.length === 0 && credentials.length === 0) return { agentIds: [], machineIds: [] };

    const serverOfAgent = new Map<string, string>();
    const agentIds = unique(credentials.map((credential) => credential.agentId));
    for (const agentId of agentIds) {
      const [agent] = await tx.select({ serverId: agents.serverId }).from(agents).where(eq(agents.id, agentId));
      if (agent) serverOfAgent.set(agentId, agent.serverId);
    }
    // Whatever revoked the session (a link, a password change, maintenance), the system revokes its keys, for the person it acted for.
    const audit = {
      outcome: "success" as const,
      source: "system" as const,
      actor: { type: "system" as const },
      requester: { type: "human" as const, id: input.userId },
      subject: { type: "human" as const, id: input.userId },
    };
    const operationId = newAuditOperationId();
    for (const credential of credentials) {
      await recordIntegrationAuditEvent({
        ...audit,
        serverId: serverOfAgent.get(credential.agentId) ?? null,
        eventType: "agent_credential.revoked",
        target: { type: "agent_credential", id: credential.credentialId },
        metadata: { agentId: credential.agentId, credentialId: credential.credentialId, reason: DEVICE_LOGIN_REVOKED_REASON, sessionRevokedReason: input.sessionRevokedReason, operationId },
      }, tx);
    }
    for (const key of keys) {
      await recordIntegrationAuditEvent({
        ...audit,
        serverId: key.serverId,
        eventType: "computer.key_revoked",
        target: { type: "computer", id: key.computerId },
        metadata: { computerId: key.computerId, computerName: key.computerName, machineId: key.machineId, reason: DEVICE_LOGIN_REVOKED_REASON, sessionRevokedReason: input.sessionRevokedReason, operationId },
      }, tx);
    }
    return { agentIds, machineIds: unique(keys.map((key) => key.machineId)) };
  });
}

/** Whose revoked sessions a run looks at: one family, one person's, or everyone's (maintenance only). */
export type RevokedDeviceSessionScope = { familyId: string } | { userId: string } | "everyone";

/**
 * The one place a revoked device session's keys follow it: every family that
 * is revoked (for any reason, the holder's own logout included: otherwise a
 * phished session could sign itself out to keep its keys past the revoke link
 * and a password change) and still has a live key gets those keys revoked,
 * audited and closed. It reads state, not the caller's intent, so a run also
 * repairs one that failed after an earlier revoke committed. Callers run it
 * after their revoke's transaction commits, narrowed to the family or the
 * person they revoked; maintenance runs it over everyone. One family's failure
 * doesn't stop the others: they all run, then the first error is thrown.
 * Returns how many families it found with live keys.
 */
export async function revokeKeysOfRevokedDeviceSessions(
  scope: RevokedDeviceSessionScope,
  now = currentDate(),
): Promise<number> {
  const db = getDb();
  const inScope = scope === "everyone"
    ? undefined
    : "familyId" in scope ? eq(sessionFamilies.id, scope.familyId) : eq(sessionFamilies.userId, scope.userId);
  // Started from the live keys that record a family, not from every revoked
  // family: idx_agent_credentials_live_by_session_family holds only those
  // (revoked runner credentials, one per launch on a device-attached
  // Computer, stay out of it); computers is small.
  const liveKeyOfRevokedFamily = (familyColumn: AnyPgColumn, keyRevokedAt: AnyPgColumn): SQL | undefined => and(
    isNotNull(familyColumn),
    isNull(keyRevokedAt),
    isNotNull(sessionFamilies.revokedAt),
    inScope,
  );
  const family = { familyId: sessionFamilies.id, userId: sessionFamilies.userId, sessionRevokedReason: sessionFamilies.revokedReason };
  const fromCredentials = await db
    .selectDistinct(family)
    .from(agentCredentials)
    .innerJoin(sessionFamilies, eq(sessionFamilies.id, agentCredentials.issuedBySessionFamilyId))
    .where(liveKeyOfRevokedFamily(agentCredentials.issuedBySessionFamilyId, agentCredentials.revokedAt));
  const fromComputers = await db
    .selectDistinct(family)
    .from(computers)
    .innerJoin(sessionFamilies, eq(sessionFamilies.id, computers.keyIssuedBySessionFamilyId))
    .where(liveKeyOfRevokedFamily(computers.keyIssuedBySessionFamilyId, computers.revokedAt));
  const families = new Map([...fromCredentials, ...fromComputers].map((row) => [row.familyId, row]));
  const failures: unknown[] = [];
  for (const row of families.values()) {
    try {
      await closeDeviceSessionKeys(await revokeDeviceSessionKeys({ ...row, now }));
    } catch (err) {
      console.error(`[device-login] revoking the keys of session family ${row.familyId} failed:`, err);
      failures.push(err);
    }
  }
  if (failures.length > 0) throw failures[0];
  return families.size;
}

/** Every key the family handed out, revoked or not: what closing reaches, after the first click and on a used link's retry alike. */
export async function deviceSessionKeyReach(familyId: string): Promise<DeviceSessionKeyReach> {
  const db = getDb();
  const credentials = await db
    .select({ agentId: agentCredentials.agentId })
    .from(agentCredentials)
    .where(eq(agentCredentials.issuedBySessionFamilyId, familyId));
  const keys = await db
    .select({ machineId: computers.machineId })
    .from(computers)
    .where(eq(computers.keyIssuedBySessionFamilyId, familyId));
  return { agentIds: unique(credentials.map((credential) => credential.agentId)), machineIds: unique(keys.map((key) => key.machineId)) };
}

const CLOSE_STEP_TIMEOUT_MS = 2_000;

/** One fan-out step, never longer than CLOSE_STEP_TIMEOUT_MS (a Redis reconnect must not hang the revoke page). */
async function bounded(step: () => Promise<void>, what: string): Promise<void> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    await Promise.race([
      step(),
      new Promise<void>((_, reject) => { timer = setTimeout(() => reject(new Error(`${what} timed out`)), CLOSE_STEP_TIMEOUT_MS); }),
    ]);
  } catch (err) {
    console.error(`[device-login] ${what} failed:`, err);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

/**
 * After commit: close the revoked credentials' open streams and the revoked
 * Computers' connections on every replica. Best effort, bounded and
 * idempotent: a used link runs it again in case a first click's fan-out failed.
 */
export async function closeDeviceSessionKeys(reach: DeviceSessionKeyReach): Promise<void> {
  for (const agentId of reach.agentIds) {
    await bounded(() => broadcastAgentCredentialRevocation(agentId), "credential revocation broadcast");
  }
  for (const machineId of reach.machineIds) {
    await bounded(() => dropMachineConnectionEverywhere(machineId, "credential_revoked"), "machine connection drop");
  }
}
