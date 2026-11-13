// Per-Computer revoke (device-auth design v2 §3.1 step 6, §6 item 2): one
// Computer's key goes, with every runner credential (`sk_agent_*`) its machine
// minted (`agent_credentials.issued_by_machine_id`), and their open streams and
// the Computer's own connection are closed after commit. The person's other
// Computers, their sessions and their own keys are untouched. Like a device
// session's revoke (deviceSessionKeys.ts), it is a soft revoke: the machine
// and its agents stay, and the machine reconnects only with a new attach.
//
// Four ways in: the one-time link mailed with "You added X to Y" (a grant's
// attach, `computer_revoke_tokens`), POST
// /api/servers/:id/machines/:machineId/revoke-computer-key for someone who may
// remove that machine, and POST /internal/computer/detach, where the Computer
// revokes its own key (`raft-computer detach <server>`); and a security revoke
// of the web session that approved the Computer's grant (approverSessionGrants.ts)
// or that attached or adopted it (webSessionIssuedKeys.ts); and the end of the
// attacher's membership of the Computer's server (serverService.ts
// removeMemberInTransaction: removed, or left; accountDeletion/requests.ts:
// the account's deletion asked). Each revoke is
// audited: the Computer's key (`computer.key_revoked`) and each credential
// (`agent_credential.revoked`), with how (`via`) and, from the web, who.
//
// Lock order: the Computer row first (UPDATE), then the credentials. A runner
// mint in flight holds its Computer row FOR SHARE until it commits
// (routes/internalComputer.ts), so it either commits first and its credential
// is revoked here, or it finds the key revoked and mints nothing.

import { randomBytes } from "node:crypto";
import type { ServerRole } from "@botiverse/raft-shared";
import { currentDate } from "@botiverse/raft-shared";
import { and, eq, gt, isNull, lte, ne } from "drizzle-orm";
import { getDb, type DatabaseExecutor } from "../db/index";
import { agentCredentials, agents, computerRevokeTokens, computers } from "../db/schema";
import { computeTokenLookupHash } from "./agentCredentialService";
import { closeDeviceSessionKeys, type DeviceSessionKeyReach } from "./deviceSessionKeys";
import { newAuditOperationId, recordIntegrationAuditEvent, serverAuditContextMetadata } from "./integrationAuditService";

export const COMPUTER_KEY_REVOKED_REASON = "computer_key_revoked";

/**
 * Who revoked it: whoever holds the mailed link (it acts for the person it was
 * mailed to), a person on the web, the Computer itself with its own key
 * (`detach`: no person is named; the event's target is that Computer), or the
 * system after a security revoke of the web session that approved the grant
 * the key came from (`approver_session_revoked`, approverSessionGrants.ts) or
 * that attached or adopted it itself (`web_session_revoked`,
 * webSessionIssuedKeys.ts).
 */
/**
 * The security revokes of a web session that reach what it approved (approverSessionGrants.ts); `repair` is maintenance's.
 * `account_deletion_requested`: the person asked to delete the account (services/accountDeletion), which revokes every family `revoke_all`.
 * `second_factor_recovered`: an email recovery of two-step verification finished (services/secondFactor/recovery.ts), which revokes every family `revoke_all` before the new sign-in.
 */
export type ApproverSessionRevokeTrigger = "password_change" | "password_reset" | "account_retired" | "account_deletion_requested" | "second_factor_recovered" | "device_login_revoked" | "repair";

export type ComputerKeyRevoker =
  | { via: "revoke_link" }
  | { via: "detach" }
  | { via: "approver_session_revoked"; grantId: string; trigger: ApproverSessionRevokeTrigger }
  | { via: "web_session_revoked"; trigger: ApproverSessionRevokeTrigger }
  | { via: "web"; userId: string; actorRole: ServerRole }
  /**
   * The person who attached it is no longer a member of its server: removed by
   * `actorUserId` (an owner or admin), or left (`actorUserId` is themselves),
   * or asked to delete their account, which ends every membership
   * (`account_deleted`; accountDeletion/requests.ts; `actorUserId` is
   * themselves, or the human accountable for an operator-submitted request,
   * `--accountable-user-id` in scripts/request-account-deletion.ts). No actor: the system ended the membership.
   */
  | { via: "member_removed"; actorUserId: string | null; actorRole: ServerRole | null; departureReason: MemberDepartureReason };

/** Why the membership a `member_removed` revoke goes with ended. */
export type MemberDepartureReason = "removed" | "left" | "account_deleted";

export type RevokeComputerKeyResult = {
  /** False when the key was already revoked (by anything); what it minted is still revoked if live. */
  revoked: boolean;
  reach: DeviceSessionKeyReach;
  /** Set only by the call that revoked it: the agents bound to that machine went offline (computerDetachedNotices.ts). */
  detached: DetachedComputer | null;
};

export type DetachedComputer = { machineId: string; serverId: string; computerName: string };

const revokedByUserIdOf = (by: ComputerKeyRevoker): string | null =>
  by.via === "web" ? by.userId : by.via === "member_removed" ? by.actorUserId : null;

const unique = (values: Array<string | null | undefined>): string[] =>
  [...new Set(values.filter((value): value is string => Boolean(value)))];

/**
 * Revokes one Computer's key and every live credential its machine minted,
 * in the caller's transaction, and audits each. Null when there is no such
 * Computer. Idempotent: on a Computer already revoked it revokes the machine's
 * still-live credentials minted before that revoke (a repair), unless another
 * live Computer now holds that machine (those are its credentials, not this
 * key's).
 */
export async function revokeComputerKeyInTransaction(
  tx: DatabaseExecutor,
  input: { computerId: string; by: ComputerKeyRevoker; now?: Date; operationId?: string },
): Promise<RevokeComputerKeyResult | null> {
  const now = input.now ?? currentDate();
  const [justRevoked] = await tx
    .update(computers)
    .set({
      revokedAt: now,
      revokedReason: COMPUTER_KEY_REVOKED_REASON,
      revokedByUserId: revokedByUserIdOf(input.by),
    })
    .where(and(eq(computers.id, input.computerId), isNull(computers.revokedAt)))
    .returning({ id: computers.id, name: computers.name, machineId: computers.machineId, serverId: computers.serverId, attachedByUserId: computers.attachedByUserId, revokedAt: computers.revokedAt });
  const computer = justRevoked ?? (await tx
    .select({ id: computers.id, name: computers.name, machineId: computers.machineId, serverId: computers.serverId, attachedByUserId: computers.attachedByUserId, revokedAt: computers.revokedAt })
    .from(computers)
    .where(eq(computers.id, input.computerId))
    .limit(1))[0];
  if (!computer) return null;

  let machineId = computer.machineId;
  if (!justRevoked && machineId) {
    const [liveHolder] = await tx
      .select({ id: computers.id })
      .from(computers)
      .where(and(eq(computers.machineId, machineId), isNull(computers.revokedAt), ne(computers.id, computer.id)))
      .limit(1);
    if (liveHolder) machineId = null;
  }
  const credentials = machineId
    ? await tx
      .update(agentCredentials)
      .set({ revokedAt: now, revokedReason: COMPUTER_KEY_REVOKED_REASON, revokedByUserId: revokedByUserIdOf(input.by) })
      .where(and(
        eq(agentCredentials.issuedByMachineId, machineId),
        isNull(agentCredentials.revokedAt),
        // A repair reaches only what the machine minted while this key was
        // live: anything minted after the key was revoked came from another
        // key of the machine (a later Computer, a legacy sk_machine_* key), not
        // this one. (The first revoke takes everything: a mint in flight holds
        // the Computer row and commits before it, with an earlier created_at.)
        justRevoked || !computer.revokedAt ? undefined : lte(agentCredentials.createdAt, computer.revokedAt),
      ))
      .returning({ credentialId: agentCredentials.id, agentId: agentCredentials.agentId })
    : [];

  const operationId = input.operationId ?? newAuditOperationId();
  // From the web, the person who did it; through the link, the system acting
  // for the person it was mailed to (like a device login's revoke link); on a
  // detach, the machine itself from its command line (source cli, no person;
  // the audit actor kinds are human/agent/system, so it is a system actor and
  // the revoked Computer, the target, is the one that asked).
  // A membership's end: whoever removed them (or they, leaving), as the removal's own audit names them.
  const webActor = input.by.via === "web"
    ? { userId: input.by.userId, actorRole: input.by.actorRole }
    : input.by.via === "member_removed" && input.by.actorUserId ? { userId: input.by.actorUserId, actorRole: input.by.actorRole } : null;
  const audit = webActor
    ? {
      outcome: "success" as const,
      source: "web" as const,
      actor: { type: "human" as const, id: webActor.userId },
      requester: computer.attachedByUserId ? { type: "human" as const, id: computer.attachedByUserId } : null,
      context: serverAuditContextMetadata({ actorRole: webActor.actorRole, operationId }),
    }
    : {
      outcome: "success" as const,
      source: input.by.via === "detach" ? "cli" as const : "system" as const,
      actor: { type: "system" as const },
      // A detach is asked for by no person; naming who attached it would read as if they asked.
      requester: input.by.via !== "detach" && computer.attachedByUserId ? { type: "human" as const, id: computer.attachedByUserId } : null,
      context: serverAuditContextMetadata({ operationId }),
    };
  const { context, ...event } = audit;
  const cause = input.by.via === "approver_session_revoked"
    ? { grantId: input.by.grantId, trigger: input.by.trigger }
    : input.by.via === "web_session_revoked" ? { trigger: input.by.trigger }
    : input.by.via === "member_removed" ? { departureReason: input.by.departureReason } : {};
  if (justRevoked) {
    await recordIntegrationAuditEvent({
      ...event,
      serverId: computer.serverId,
      eventType: "computer.key_revoked",
      target: { type: "computer", id: computer.id },
      metadata: { computerId: computer.id, computerName: computer.name, machineId: computer.machineId, reason: COMPUTER_KEY_REVOKED_REASON, via: input.by.via, revokedCount: credentials.length, ...cause, ...context },
    }, tx);
  }
  const agentIds = unique(credentials.map((credential) => credential.agentId));
  const serverOfAgent = new Map<string, string>();
  for (const agentId of agentIds) {
    const [agent] = await tx.select({ serverId: agents.serverId }).from(agents).where(eq(agents.id, agentId));
    if (agent) serverOfAgent.set(agentId, agent.serverId);
  }
  for (const credential of credentials) {
    await recordIntegrationAuditEvent({
      ...event,
      serverId: serverOfAgent.get(credential.agentId) ?? computer.serverId,
      eventType: "agent_credential.revoked",
      target: { type: "agent_credential", id: credential.credentialId },
      metadata: { agentId: credential.agentId, credentialId: credential.credentialId, reason: COMPUTER_KEY_REVOKED_REASON, computerId: computer.id, via: input.by.via, ...cause, ...context },
    }, tx);
  }
  // A repair whose machine another live Computer holds now closes nothing of it.
  return {
    revoked: Boolean(justRevoked),
    reach: { agentIds, machineIds: machineId ? [machineId] : [] },
    detached: justRevoked && machineId ? { machineId, serverId: computer.serverId, computerName: computer.name } : null,
  };
}

const REVOKE_LINK_TTL_MS = 24 * 60 * 60 * 1000;
const REVOKE_TOKEN_PREFIX = "dvcr_";
const MAX_REVOKE_TOKEN_LENGTH = 100;

export function looksLikeComputerRevokeToken(raw: unknown): raw is string {
  return typeof raw === "string" && raw.startsWith(REVOKE_TOKEN_PREFIX);
}

/** A one-time link that revokes this Computer only. Only its HMAC lookup hash is stored; the raw `dvcr_*` token goes into the email once. */
export async function issueComputerRevokeToken(input: { computerId: string; grantId: string | null }, now = new Date()): Promise<string> {
  const token = `${REVOKE_TOKEN_PREFIX}${randomBytes(32).toString("base64url")}`;
  await getDb().insert(computerRevokeTokens).values({
    computerId: input.computerId,
    deviceLoginGrantId: input.grantId,
    tokenLookupHash: computeTokenLookupHash(token),
    expiresAt: new Date(now.getTime() + REVOKE_LINK_TTL_MS),
  });
  return token;
}

export type RevokeComputerByLinkResult =
  | { ok: true; revoked: "computer"; detached: DetachedComputer | null }
  | { ok: false; error: "revoke_link_invalid" | "revoke_link_used" | "revoke_link_expired" };

/**
 * A Computer's revoke link, used. Single use, 24 hours, and it only revokes
 * that Computer (revokeComputerKeyInTransaction). A used link runs the revoke
 * again (it revokes only what is still live) and closes again, for a first
 * click whose cascade or fan-out failed after its commit, until the link's 24
 * hours are up; it still answers `revoke_link_used`.
 */
export async function revokeComputerByLink(rawToken: unknown, now = new Date()): Promise<RevokeComputerByLinkResult> {
  if (!looksLikeComputerRevokeToken(rawToken) || rawToken.length > MAX_REVOKE_TOKEN_LENGTH) {
    return { ok: false, error: "revoke_link_invalid" };
  }
  const lookupHash = computeTokenLookupHash(rawToken);
  const result = await getDb().transaction(async (tx) => {
    const [link] = await tx
      .update(computerRevokeTokens)
      .set({ usedAt: now })
      .where(and(
        eq(computerRevokeTokens.tokenLookupHash, lookupHash),
        isNull(computerRevokeTokens.usedAt),
        gt(computerRevokeTokens.expiresAt, now),
      ))
      .returning({ computerId: computerRevokeTokens.computerId });
    if (!link) {
      const [existing] = await tx
        .select({ usedAt: computerRevokeTokens.usedAt, expiresAt: computerRevokeTokens.expiresAt, computerId: computerRevokeTokens.computerId })
        .from(computerRevokeTokens)
        .where(eq(computerRevokeTokens.tokenLookupHash, lookupHash));
      if (!existing) return { ok: false as const, error: "revoke_link_invalid" as const, reach: null };
      if (!existing.usedAt) return { ok: false as const, error: "revoke_link_expired" as const, reach: null };
      // A used link repairs only for as long as it could have been used: after
      // 24 hours it is inert, like any expired link.
      if (existing.expiresAt.getTime() <= now.getTime()) return { ok: false as const, error: "revoke_link_used" as const, reach: null };
      const repaired = await revokeComputerKeyInTransaction(tx, { computerId: existing.computerId, by: { via: "revoke_link" }, now });
      return { ok: false as const, error: "revoke_link_used" as const, reach: repaired?.reach ?? null };
    }
    const revoked = await revokeComputerKeyInTransaction(tx, { computerId: link.computerId, by: { via: "revoke_link" }, now });
    return { ok: true as const, reach: revoked?.reach ?? null, detached: revoked?.detached ?? null };
  });
  if (result.reach) await closeDeviceSessionKeys(result.reach);
  return result.ok ? { ok: true, revoked: "computer", detached: result.detached } : { ok: false, error: result.error };
}
