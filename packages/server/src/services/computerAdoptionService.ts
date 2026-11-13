// Computer adoption service — task #39 PR-J1 (RFC v0.8 v8.2 §5.11 / §10.13).
//
// One-time migration from legacy `sk_machine_*` to a fresh `sk_computer_*`
// principal. Authority depends on the selector: raw-key adoption proves
// possession of the old key; fingerprint adoption selects a row from the
// caller's user-scoped legacy roster; daemon-id adoption lets a Server actor
// with `registerMachines` select a row on that Server, their own or another
// member's (audited as `computer.legacy_adopted_by_other`; the member is
// told). On success, the machine
// row is marked migrated, a fresh Computer attachment is minted, and the
// legacy key is immediately invalidated (in-memory + behind a
// `legacyKeyMigratedAt` DB flag the WS / internal auth paths consult — Phase 3).
//
// Atomic adoption commit (§5.11.3): legacy key resolve, machine mark,
// Computer row create/restore, and `sk_computer_*` mint all happen in a
// single DB transaction. The `UPDATE ... WHERE legacy_key_migrated_at IS
// NULL RETURNING id` pattern is the concurrency guard — at most one caller
// wins; the loser sees no row and returns `legacy_machine_key_migrated`.
//
// Outcomes per §10.13:
//   - 201  ok                            valid authority + adoption/resume
//   - 401  legacy_key_invalid            unknown/wrong-server/malformed key
//   - 409  legacy_machine_key_migrated   key matches but machine already migrated
//   - 403  not_authorized                user not a member of the machine's server
//   - 403  requires_admin                 member lacks registerMachines
//   - 404  legacy_machine_not_found       daemon-id row absent from target Server
//   - 500  internal                      unexpected
//
// Raw key hygiene (§3.3.1): the raw `sk_machine_*` is read into memory once
// for argon2.verify and discarded. NEVER persisted, NEVER logged.

import { and, eq, isNull } from "drizzle-orm";
import argon2 from "argon2";
import { getDb, type DatabaseExecutor, type DatabaseTransaction } from "../db/index";
import { computers, deviceLoginGrants, machines, servers, sessionFamilies, users } from "../db/schema";
import { clearAuthCache, extractApiKeyPrefix } from "./machineService";
import { DeviceSessionRevokedError, lockLiveSessionFamily } from "./sessionService";
import { generateComputerApiKeyMaterial } from "./computerCredentialService";
import { isMember } from "./serverService";
import { actorHasServerCapabilityInServer, actorRoleHasServerCapability, getActorServerRoleInServer } from "../lib/actorPermissions";
import { FencedAuthorizationDeniedError, ServerMembershipRevokedError, withActorMembershipFence } from "../lib/actorMembershipFence";
import { fenceMachinePrincipalConnections } from "../replicaRouter";
import type { ServerRole } from "@botiverse/raft-shared";
import { recordIntegrationAuditEvent, serverAuditContextMetadata } from "./integrationAuditService";
import { sanitizeClientName } from "./deviceAuthService";
import { sendComputerKeyReplacedByOtherEmail, sendLegacyMachineMovedEmail } from "./emailService";

export type AdoptLegacyResult =
  | {
      ok: true;
      apiKey: string;        // raw sk_computer_* — returned exactly once
      computerId: string;
      machineId: string;
      serverId: string;
      resumed: boolean;
      /**
       * Set when this adoption retired the old key of a machine another
       * member had added (`machines.user_id`): that member, for the notice
       * the route sends them.
       */
      movedMachineAddedByUserId?: string;
      /**
       * Set when this call replaced the key of a live Computer that someone
       * else's key ran (a resume by an owner or admin): that person and the
       * name the Computer had, for the notice the route sends them. Then
       * `movedMachineAddedByUserId` is not set: the machine already had a
       * Computer, so nothing was moved.
       */
      replacedKeyOf?: { userId: string; computerName: string };
    }
  | {
      ok: false;
      code:
        | "legacy_key_invalid"
        | "legacy_machine_key_migrated"
        | "legacy_machine_not_found"
        | "not_authorized"
        | "requires_admin"
        | "session_revoked"
        | MigrateTokenRefusal;
    };

/** Why a computer_migrate grant's token could not be redeemed by this adoption. */
export type MigrateTokenRefusal = "migrate_token_invalid" | "migrate_token_expired" | "migrate_token_consumed";

/**
 * A computer_migrate grant's migrate token, redeemed by this adoption (the
 * caller passes the approver as `userId`). Checked and consumed in the
 * adoption's transaction: approved, unexpired, for the machine's server and
 * this approver, not used. The key records the grant, never a session family.
 */
export interface MigrateGrantRedemption {
  id: string;
  tokenLookupHash: Buffer;
}

type MatchedLegacyMachine = {
  id: string;
  serverId: string;
  userId: string | null;
  legacyKeyMigratedAt: Date | null;
  name: string;
};

export async function adoptLegacyMachine(input: {
  userId: string;
  legacyApiKey: string;
  name?: string;
  /** A device login's session family, when that session adopts: recorded on the key and fenced live. */
  deviceSessionFamilyId?: string | null;
  /** The person's own web (full) session family, when that session adopts: recorded on the key in its own column and fenced live. */
  webSessionFamilyId?: string | null;
}): Promise<AdoptLegacyResult> {
  // Auth middleware (packages/server/src/middleware/auth.ts) accepts both
  // sk_machine_* and the older sk_daemon_* prefix for backward compat, so a
  // real legacy daemon in the wild may be running on either. Accept both
  // here so the adoption path can migrate every legacy machine, not just the
  // sk_machine_* slice.
  if (
    !input.legacyApiKey.startsWith("sk_machine_") &&
    !input.legacyApiKey.startsWith("sk_daemon_")
  ) {
    return { ok: false, code: "legacy_key_invalid" };
  }

  // Resolve the legacy key directly against the DB — must NOT consult the
  // in-memory auth cache here. The cache exists to skip argon2 on hot-path
  // auth; using it during adoption would allow a stale entry to satisfy the
  // verify after some other actor has already marked the row migrated.
  const db = getDb();
  const prefix = extractApiKeyPrefix(input.legacyApiKey);
  const candidates = await db
    .select({
      id: machines.id,
      serverId: machines.serverId,
      userId: machines.userId,
      apiKeyHash: machines.apiKeyHash,
      legacyKeyMigratedAt: machines.legacyKeyMigratedAt,
      name: machines.name,
    })
    .from(machines)
    .where(eq(machines.apiKeyPrefix, prefix));

  let matchedMachine: MatchedLegacyMachine | null = null;
  for (const row of candidates) {
    try {
      if (await argon2.verify(row.apiKeyHash, input.legacyApiKey)) {
        matchedMachine = {
          id: row.id,
          serverId: row.serverId,
          userId: row.userId,
          legacyKeyMigratedAt: row.legacyKeyMigratedAt,
          name: row.name,
        };
        break;
      }
    } catch {
      continue;
    }
  }
  if (!matchedMachine) {
    return { ok: false, code: "legacy_key_invalid" };
  }

  return adoptMatchedLegacyMachine({
    userId: input.userId,
    matchedMachine,
    name: input.name,
    deviceSessionFamilyId: input.deviceSessionFamilyId ?? null,
    webSessionFamilyId: input.webSessionFamilyId ?? null,
    allowAlreadyMigratedResume: false,
    rosterSelected: false,
  });
}

export async function adoptLegacyMachineByFingerprint(input: {
  userId: string;
  serverSlug: string;
  legacyMachineId: string;
  apiKeyFingerprint: string;
  name?: string;
  /** A device login's session family, when that session adopts: recorded on the key and fenced live. */
  deviceSessionFamilyId?: string | null;
  /** The person's own web (full) session family, when that session adopts: recorded on the key in its own column and fenced live. */
  webSessionFamilyId?: string | null;
  grant?: MigrateGrantRedemption;
}): Promise<AdoptLegacyResult> {
  if (!/^[a-f0-9]{16}$/i.test(input.apiKeyFingerprint)) {
    return { ok: false, code: "legacy_key_invalid" };
  }

  const db = getDb();
  const [serverRow] = await db
    .select({ id: servers.id })
    .from(servers)
    .where(and(eq(servers.slug, input.serverSlug), isNull(servers.deletedAt)));
  if (!serverRow || !(await isMember(serverRow.id, input.userId))) {
    return { ok: false, code: "not_authorized" };
  }
  const [matchedMachine] = await db
    .select({
      id: machines.id,
      serverId: machines.serverId,
      userId: machines.userId,
      legacyKeyMigratedAt: machines.legacyKeyMigratedAt,
      name: machines.name,
    })
    .from(machines)
    .where(
      and(
        eq(machines.id, input.legacyMachineId),
        eq(machines.userId, input.userId),
        eq(machines.serverId, serverRow.id),
        eq(machines.apiKeyFingerprint, input.apiKeyFingerprint),
      ),
    );
  if (!matchedMachine) {
    return { ok: false, code: "legacy_key_invalid" };
  }

  return adoptMatchedLegacyMachine({
    userId: input.userId,
    matchedMachine,
    name: input.name,
    deviceSessionFamilyId: input.deviceSessionFamilyId ?? null,
    webSessionFamilyId: input.webSessionFamilyId ?? null,
    allowAlreadyMigratedResume: true,
    rosterSelected: true,
    grant: input.grant ?? null,
  });
}

export async function adoptLegacyMachineByDaemonId(input: {
  userId: string;
  serverSlug: string;
  daemonId: string;
  name?: string;
  /** A device login's session family, when that session adopts: recorded on the key and fenced live. */
  deviceSessionFamilyId?: string | null;
  /** The person's own web (full) session family, when that session adopts: recorded on the key in its own column and fenced live. */
  webSessionFamilyId?: string | null;
  /**
   * A migrate token adopts as its approver, under the same rule as a session:
   * their own legacy machine, or another member's when they hold
   * `registerMachines` on the server at adoption time (read under the fence,
   * so a role lost since the approval is refused with `requires_admin`).
   * It moves old daemons only: a machine with a live Computer someone else
   * attached answers `legacy_machine_key_migrated` (adoptMatchedLegacyMachine).
   */
  grant?: MigrateGrantRedemption;
}): Promise<AdoptLegacyResult> {
  const db = getDb();
  const [serverRow] = await db
    .select({ id: servers.id })
    .from(servers)
    .where(and(eq(servers.slug, input.serverSlug), isNull(servers.deletedAt)));
  if (!serverRow || !(await isMember(serverRow.id, input.userId))) {
    return { ok: false, code: "not_authorized" };
  }
  const canRegisterMachines = await actorHasServerCapabilityInServer(
    serverRow.id,
    "user",
    input.userId,
    "registerMachines",
  );
  const [matchedMachine] = await db
    .select({
      id: machines.id,
      serverId: machines.serverId,
      userId: machines.userId,
      legacyKeyMigratedAt: machines.legacyKeyMigratedAt,
      name: machines.name,
    })
    .from(machines)
    .where(
      and(
        eq(machines.id, input.daemonId),
        eq(machines.serverId, serverRow.id),
      ),
    );
  if (!matchedMachine) {
    return { ok: false, code: canRegisterMachines ? "legacy_machine_not_found" : "requires_admin" };
  }
  if (
    matchedMachine.userId !== input.userId
    && !canRegisterMachines
  ) {
    return { ok: false, code: "requires_admin" };
  }

  return adoptMatchedLegacyMachine({
    userId: input.userId,
    matchedMachine,
    name: input.name,
    deviceSessionFamilyId: input.deviceSessionFamilyId ?? null,
    webSessionFamilyId: input.webSessionFamilyId ?? null,
    allowAlreadyMigratedResume: true,
    rosterSelected: true,
    grant: input.grant ?? null,
  });
}

/**
 * Locks a computer_migrate grant for redeeming its token in this adoption's
 * transaction (FOR UPDATE: a concurrent adoption with the same token waits,
 * then sees it consumed). Null when it may be redeemed; otherwise why not.
 */
async function lockRedeemableMigrateGrant(
  tx: DatabaseTransaction,
  grant: MigrateGrantRedemption,
  expected: { serverId: string; userId: string },
): Promise<MigrateTokenRefusal | null> {
  const [row] = await tx
    .select({
      kind: deviceLoginGrants.kind,
      status: deviceLoginGrants.status,
      serverId: deviceLoginGrants.serverId,
      approverUserId: deviceLoginGrants.approverUserId,
      expiresAt: deviceLoginGrants.expiresAt,
    })
    .from(deviceLoginGrants)
    .where(and(eq(deviceLoginGrants.id, grant.id), eq(deviceLoginGrants.attachTokenLookupHash, grant.tokenLookupHash)))
    .for("update");
  if (!row || row.kind !== "computer_migrate") return "migrate_token_invalid";
  if (row.status === "consumed") return "migrate_token_consumed";
  if (row.status !== "approved" || !row.expiresAt || row.expiresAt.getTime() <= Date.now()) return "migrate_token_expired";
  if (row.serverId !== expected.serverId || row.approverUserId !== expected.userId) return "migrate_token_invalid";
  return null;
}

async function adoptMatchedLegacyMachine(input: {
  userId: string;
  matchedMachine: MatchedLegacyMachine;
  name?: string;
  /** Recorded on the Computer's key (insert or rotation): the family whose revoke revokes it. */
  deviceSessionFamilyId: string | null;
  /** Recorded on the Computer's key in its own column: the web session whose security revoke revokes it (webSessionIssuedKeys.ts). */
  webSessionFamilyId: string | null;
  allowAlreadyMigratedResume: boolean;
  /**
   * Fingerprint / daemon-id selection (no key possession). A registrant without `registerMachines` is then
   * limited to a machine that never had a Computer, or to rotating a Computer they attached themselves.
   */
  rosterSelected: boolean;
  /** A computer_migrate grant redeemed by this adoption: consumed with it, and recorded on the key. */
  grant?: MigrateGrantRedemption | null;
}): Promise<AdoptLegacyResult> {
  const db = getDb();
  const { matchedMachine } = input;

  // The server must still be live and the calling user must be a member of it
  // WITH the registerMachines capability (owner / admin). Raw-key adoption uses
  // key possession as machine authority; fingerprint adoption uses the
  // server's user-scoped legacy roster; daemon-id adoption uses the Server's
  // registerMachines capability and a row bound to that Server. All three still
  // mint a fresh sk_computer_* Computer attachment, so — like
  // /api/computer/attach — they
  // require the same role gate (tygg 2026-06-05 #wg-raft-computer): a plain
  // member must not adopt a legacy machine into a Computer attachment and so
  // bypass the attach gate. A member lacking the capability gets the distinct
  // `requires_admin` code (not an enumeration leak — they know they belong).
  // The registrant exception for roster selection covers only a machine that
  // never had a Computer, or resuming a Computer the registrant attached
  // (registrantMayAdoptBySelection).
  const [serverRow] = await db
    .select({ id: servers.id })
    .from(servers)
    .where(and(eq(servers.id, matchedMachine.serverId), isNull(servers.deletedAt)));
  if (!serverRow) {
    return { ok: false, code: "not_authorized" };
  }
  // Cheap pre-check so non-members and plain members are refused before any argon2 work. It is not the authority:
  // the fenced transaction below re-evaluates both under the member-row lock.
  const preRole = await getActorServerRoleInServer(matchedMachine.serverId, "user", input.userId);
  if (!preRole) {
    return { ok: false, code: "not_authorized" };
  }
  if (!actorRoleHasServerCapability(preRole, "registerMachines")) {
    if (matchedMachine.userId !== input.userId) {
      return { ok: false, code: "requires_admin" };
    }
    if (input.rosterSelected && !(await registrantMayAdoptBySelection(db, matchedMachine, input.userId))) {
      return { ok: false, code: "requires_admin" };
    }
  }
  // Task #91: membership, the registrant-or-`registerMachines` authority and every adoption write run in one fenced
  // transaction — the caller's member row is share-locked first, and the CAS UPDATE below then locks the machine row.
  // Key material is generated before the fence so argon2 hashing never runs while those locks are held. Auth-cache
  // eviction and connection fencing are effects and run only after commit.
  const material = await generateComputerApiKeyMaterial();
  const desiredName = sanitizeAdoptedName(input.name, matchedMachine.name);

  type FencedAdoption =
    | { kind: "requires_admin" }
    | { kind: "grant_refused"; code: MigrateTokenRefusal }
    | { kind: "migrated" }
    | { kind: "adopted"; computerId: string; serverId: string; resumed: boolean; clearLegacyAuthCache: boolean; rotatedFrom?: { userId: string; computerName: string } };

  // A resume that rotates a Computer whose key someone else holds takes it
  // over from them (an owner or admin with a session; a migrate token never
  // gets here, see mayRotate): audited as computer.key_rotated, and they are
  // told. Read before the rotation: who holds the key, and the name they know.
  type LiveComputer = {
    id: string; serverId: string; name: string; attachedByUserId: string | null;
    keyIssuedBySessionFamilyId: string | null; keyIssuedByWebSessionFamilyId: string | null; keyIssuedByGrantId: string | null;
  };
  const liveComputerColumns = {
    id: computers.id, serverId: computers.serverId, name: computers.name, attachedByUserId: computers.attachedByUserId,
    keyIssuedBySessionFamilyId: computers.keyIssuedBySessionFamilyId, keyIssuedByWebSessionFamilyId: computers.keyIssuedByWebSessionFamilyId, keyIssuedByGrantId: computers.keyIssuedByGrantId,
  };
  /**
   * Whose key a live Computer runs with now: whoever last issued it (the
   * session that rotated or attached it; else the approval that did; else
   * whoever attached it). `attachedByUserId` alone would name the first
   * person forever, so the same takeover would be announced on every retry.
   */
  const keyHolderUserId = async (tx: DatabaseTransaction, computer: LiveComputer): Promise<string | null> => {
    const familyId = computer.keyIssuedBySessionFamilyId ?? computer.keyIssuedByWebSessionFamilyId;
    if (familyId) {
      const [family] = await tx.select({ userId: sessionFamilies.userId }).from(sessionFamilies).where(eq(sessionFamilies.id, familyId));
      if (family) return family.userId;
    } else if (computer.keyIssuedByGrantId) {
      const [grantRow] = await tx.select({ approverUserId: deviceLoginGrants.approverUserId }).from(deviceLoginGrants).where(eq(deviceLoginGrants.id, computer.keyIssuedByGrantId));
      if (grantRow?.approverUserId) return grantRow.approverUserId;
    }
    return computer.attachedByUserId;
  };
  const rotatedFrom = async (tx: DatabaseTransaction, computer: LiveComputer) => {
    const holder = await keyHolderUserId(tx, computer);
    return holder && holder !== input.userId ? { rotatedFrom: { userId: holder, computerName: computer.name } } : {};
  };

  // A machine another member added (`machines.user_id`; not the Computer owner
  // of computerOwnerService), moved by an owner or admin: audited in the
  // adoption's commit, and that member is told (the route sends the notice).
  const machineAddedByUserId = matchedMachine.userId && matchedMachine.userId !== input.userId ? matchedMachine.userId : null;

  const adoptInFence = async (tx: DatabaseTransaction, lockedRole: ServerRole): Promise<FencedAdoption> => {
    const canRegisterMachines = actorRoleHasServerCapability(lockedRole, "registerMachines");
    if (!canRegisterMachines) {
      if (matchedMachine.userId !== input.userId) {
        return { kind: "requires_admin" };
      }
      // Checked before any write, so refusing here leaves nothing to roll back.
      if (input.rosterSelected && !(await registrantMayAdoptBySelection(tx, matchedMachine, input.userId))) {
        return { kind: "requires_admin" };
      }
    }
    // Rotating a live Computer in place hands its key to the caller: without `registerMachines`, only a
    // Computer the caller attached. A migrate token never rotates anyone else's, whatever the approver's role.
    const mayRotate = (computer: { attachedByUserId: string | null }) =>
      (canRegisterMachines && !input.grant) || !input.rosterSelected || computer.attachedByUserId === input.userId;
    // A migrate token moves an old daemon over. By its id it would also reach a machine that already has a
    // live Computer (moved earlier, or attached the normal way): rotating that would hand the Computer to
    // whoever holds the token, so an owner or admin tricked into approving a code would give away any Computer
    // on the server. Refused as already migrated, before any write. The approver's own earlier move (a setup
    // retry) attached its Computer themselves and still resumes.
    if (input.grant) {
      const live = await tx
        .select({ attachedByUserId: computers.attachedByUserId })
        .from(computers)
        .where(and(eq(computers.machineId, matchedMachine.id), isNull(computers.revokedAt)));
      if (live.some((computer) => computer.attachedByUserId !== input.userId)) return { kind: "migrated" };
    }
    const fencedFamilyId = input.deviceSessionFamilyId ?? input.webSessionFamilyId;
    if (fencedFamilyId) await lockLiveSessionFamily(tx, fencedFamilyId, input.userId);

    // Raw-key replay remains a hard "already migrated" outcome so old machine
    // credentials cannot be reused. Roster-selected adoption is different: the
    // logged-in user may be retrying setup after server-side adoption committed
    // but local state did not finish. In that case rotate and return the
    // existing linked Computer attachment instead of forcing a legacy key.
    if (matchedMachine.legacyKeyMigratedAt) {
      if (!input.allowAlreadyMigratedResume) {
        return { kind: "migrated" };
      }
      const [existing] = await tx
        .select(liveComputerColumns)
        .from(computers)
        .where(and(eq(computers.machineId, matchedMachine.id), isNull(computers.revokedAt)));
      if (!existing) {
        return { kind: "migrated" };
      }
      if (!mayRotate(existing)) {
        return { kind: "requires_admin" };
      }
      // The original migration already set `legacy_key_migrated_at` and ran
      // same-action auth-cache invalidation. Resume only rotates the Computer
      // credential, so there is no legacy auth cache left to clear here.
      const rotated = await tx
        .update(computers)
        .set({
          apiKeyHash: material.apiKeyHash,
          apiKeyHmac: material.apiKeyHmac,
          apiKeyPrefix: material.apiKeyPrefix,
          name: desiredName,
          // The key follows whoever holds it now: this call's session family
          // or approval, and nothing of the previous holder's. A grant id left
          // behind would let the previous holder's security revoke take a key
          // they no longer hold.
          keyIssuedBySessionFamilyId: input.deviceSessionFamilyId,
          keyIssuedByWebSessionFamilyId: input.webSessionFamilyId,
          keyIssuedByGrantId: input.grant?.id ?? null,
        })
        // A revoke that landed since the read above wins: nothing to resume.
        .where(and(eq(computers.id, existing.id), isNull(computers.revokedAt)))
        .returning({ id: computers.id })
        .then((rows) => rows.length > 0);
      if (!rotated) return { kind: "migrated" };
      await recordAdoptionResumeRotation(tx, { userId: input.userId, actorRole: lockedRole, machineId: matchedMachine.id, computer: existing, computerName: desiredName });
      return { kind: "adopted", computerId: existing.id, serverId: existing.serverId, resumed: true, clearLegacyAuthCache: false, ...(await rotatedFrom(tx, existing)) };
    }

    // Concurrency guard — atomic mark + select. Only the first caller to
    // flip legacy_key_migrated_at IS NULL → now() gets a row back; later
    // callers (same key, concurrent) see no row and we collapse them to
    // `legacy_machine_key_migrated`.
    const markRows = await tx
      .update(machines)
      // The old key is retired here, so a credential exposure it had (#38) is over.
      .set({ legacyKeyMigratedAt: new Date(), credentialExposureFoundAt: null })
      .where(
        and(
          eq(machines.id, matchedMachine.id),
          isNull(machines.legacyKeyMigratedAt),
        ),
      )
      .returning({ id: machines.id });
    if (markRows.length === 0) {
      return { kind: "migrated" };
    }

    // Resume: a still-live (not revoked) Computer attachment already linked
    // to this machineId — rotate its credential in place rather than
    // leaking a duplicate live attachment. This is defensive: in the
    // expected flow no prior Computer row exists for a legacy machine.
    const [existing] = await tx
      .select(liveComputerColumns)
      .from(computers)
      .where(
        and(
          eq(computers.machineId, matchedMachine.id),
          isNull(computers.revokedAt),
        ),
      );

    if (existing) {
      // The machine row is already marked above: throw so the transaction rolls back.
      if (!mayRotate(existing)) throw new FencedAuthorizationDeniedError("forbidden");
      const rotated = await tx
        .update(computers)
        .set({
          apiKeyHash: material.apiKeyHash,
          apiKeyHmac: material.apiKeyHmac,
          apiKeyPrefix: material.apiKeyPrefix,
          name: desiredName,
          // The key follows whoever holds it now: this call's session family
          // or approval, and nothing of the previous holder's. A grant id left
          // behind would let the previous holder's security revoke take a key
          // they no longer hold.
          keyIssuedBySessionFamilyId: input.deviceSessionFamilyId,
          keyIssuedByWebSessionFamilyId: input.webSessionFamilyId,
          keyIssuedByGrantId: input.grant?.id ?? null,
        })
        // A revoke that landed since the read above wins: the machine gets a fresh Computer below instead.
        .where(and(eq(computers.id, existing.id), isNull(computers.revokedAt)))
        .returning({ id: computers.id })
        .then((rows) => rows.length > 0);
      if (rotated) {
        await recordAdoptionResumeRotation(tx, { userId: input.userId, actorRole: lockedRole, machineId: matchedMachine.id, computer: existing, computerName: desiredName });
        return { kind: "adopted", computerId: existing.id, serverId: existing.serverId, resumed: true, clearLegacyAuthCache: true, ...(await rotatedFrom(tx, existing)) };
      }
    }

    const [row] = await tx
      .insert(computers)
      .values({
        serverId: matchedMachine.serverId,
        name: desiredName,
        apiKeyHash: material.apiKeyHash,
        apiKeyHmac: material.apiKeyHmac,
        apiKeyPrefix: material.apiKeyPrefix,
        attachedByUserId: input.userId,
        machineId: matchedMachine.id,
        keyIssuedBySessionFamilyId: input.deviceSessionFamilyId,
        keyIssuedByWebSessionFamilyId: input.webSessionFamilyId,
        keyIssuedByGrantId: input.grant?.id ?? null,
      })
      .returning({ id: computers.id });

    return { kind: "adopted", computerId: row.id, serverId: matchedMachine.serverId, resumed: false, clearLegacyAuthCache: true };
  };

  let outcome: FencedAdoption;
  try {
    const grant = input.grant ?? null;
    outcome = await withActorMembershipFence(matchedMachine.serverId, input.userId, async (tx, lockedRole): Promise<FencedAdoption> => {
      // Checked before any write; consumed below only when the adoption succeeds.
      if (grant) {
        const refused = await lockRedeemableMigrateGrant(tx, grant, { serverId: matchedMachine.serverId, userId: input.userId });
        if (refused) return { kind: "grant_refused", code: refused };
      }
      const adopted = await adoptInFence(tx, lockedRole);
      // `clearLegacyAuthCache`: this call retired the old key. A resume of an
      // adoption that already committed (a setup retry) is not a second move.
      // A machine that already had a live Computer was not moved: its key was replaced (computer.key_rotated).
      if (machineAddedByUserId && adopted.kind === "adopted" && adopted.clearLegacyAuthCache && !adopted.resumed) {
        await recordIntegrationAuditEvent({
          serverId: adopted.serverId,
          eventType: "computer.legacy_adopted_by_other",
          outcome: "success",
          source: "cli",
          actor: { type: "human", id: input.userId },
          subject: { type: "human", id: machineAddedByUserId },
          target: { type: "computer", id: adopted.computerId },
          metadata: {
            machineId: matchedMachine.id,
            machineName: matchedMachine.name,
            computerId: adopted.computerId,
            computerName: desiredName,
            machineAddedByUserId,
            via: grant ? "migrate_grant" : "session",
            ...(grant ? { grantId: grant.id } : {}),
            ...serverAuditContextMetadata({ actorRole: lockedRole }),
          },
        }, tx);
      }
      if (grant && adopted.kind === "adopted") {
        await tx
          .update(deviceLoginGrants)
          .set({ status: "consumed", consumedAt: new Date(), consumedComputerId: adopted.computerId })
          .where(and(eq(deviceLoginGrants.id, grant.id), eq(deviceLoginGrants.status, "approved")));
      }
      return adopted;
    });
  } catch (err) {
    // Removal committed first: identical to "not a member" before the fence existed.
    if (err instanceof ServerMembershipRevokedError) {
      return { ok: false, code: "not_authorized" };
    }
    if (err instanceof FencedAuthorizationDeniedError) {
      return { ok: false, code: "requires_admin" };
    }
    if (err instanceof DeviceSessionRevokedError) {
      return { ok: false, code: "session_revoked" };
    }
    // Never include the raw key or its prefix in error surface.
    console.error("computerAdoption.adopt error:", err);
    throw err;
  }

  if (outcome.kind === "requires_admin") {
    return { ok: false, code: "requires_admin" };
  }
  if (outcome.kind === "grant_refused") {
    return { ok: false, code: outcome.code };
  }
  if (outcome.kind === "migrated") {
    return { ok: false, code: "legacy_machine_key_migrated" };
  }

  // Same-action cache invalidation (§5.11.3): legacy key must fail on
  // the very next auth attempt — no TTL window. The Phase 3 auth path
  // also consults `legacy_key_migrated_at` so a fresh DB read rejects;
  // clearing the cache eliminates the in-process gap.
  if (outcome.clearLegacyAuthCache) {
    clearAuthCache(matchedMachine.id);
  }
  await fenceMachinePrincipalConnections(matchedMachine.id, "legacy_machine");

  return {
    ok: true,
    apiKey: material.apiKey,
    computerId: outcome.computerId,
    machineId: matchedMachine.id,
    serverId: outcome.serverId,
    resumed: outcome.resumed,
    ...(outcome.rotatedFrom
      ? { replacedKeyOf: outcome.rotatedFrom }
      : machineAddedByUserId && outcome.clearLegacyAuthCache && !outcome.resumed ? { movedMachineAddedByUserId: machineAddedByUserId } : {}),
  };
}

/**
 * Selection-based adoption by the machine's registrant without `registerMachines`. A machine not yet migrated
 * qualifies only if it never had a Computer (revoked or not): a Computer attached through /api/computer/attach
 * also leaves `legacyKeyMigratedAt` NULL, and once revoked it reconnects only through a new attach. A migrated
 * machine qualifies for resume only when its live Computer (if any) was attached by the caller.
 */
async function registrantMayAdoptBySelection(
  q: DatabaseExecutor,
  machine: Pick<MatchedLegacyMachine, "id" | "legacyKeyMigratedAt">,
  userId: string,
): Promise<boolean> {
  if (!machine.legacyKeyMigratedAt) {
    const [anyComputer] = await q
      .select({ id: computers.id })
      .from(computers)
      .where(eq(computers.machineId, machine.id))
      .limit(1);
    return !anyComputer;
  }
  const [live] = await q
    .select({ attachedByUserId: computers.attachedByUserId })
    .from(computers)
    .where(and(eq(computers.machineId, machine.id), isNull(computers.revokedAt)))
    .limit(1);
  return !live || live.attachedByUserId === userId;
}

/**
 * A resumed adoption rotates the live Computer's key: audited in the adoption
 * transaction. The key is never recorded; whoever attached the Computer is the
 * requester.
 */
async function recordAdoptionResumeRotation(
  tx: Parameters<typeof recordIntegrationAuditEvent>[1],
  input: { userId: string; actorRole: ServerRole | null; machineId: string; computer: { id: string; serverId: string; attachedByUserId: string | null }; computerName: string },
) {
  await recordIntegrationAuditEvent({
    serverId: input.computer.serverId,
    eventType: "computer.key_rotated",
    outcome: "success",
    source: "cli",
    actor: { type: "human", id: input.userId },
    requester: input.computer.attachedByUserId ? { type: "human", id: input.computer.attachedByUserId } : null,
    target: { type: "computer", id: input.computer.id },
    metadata: {
      computerId: input.computer.id,
      computerName: input.computerName,
      machineId: input.machineId,
      reason: "adoption_resume",
      ...serverAuditContextMetadata({ actorRole: input.actorRole }),
    },
  }, tx);
}

/** Who a notice about `userId`'s machine or Computer on `serverId` may go to: still in the server, account not retired. */
async function noticeRecipient(serverId: string, userId: string, actorUserId: string) {
  if (!(await isMember(serverId, userId))) return null;
  const db = getDb();
  const [person] = await db.select({ email: users.email, name: users.name, displayName: users.displayName, retiredAt: users.retiredAt }).from(users).where(eq(users.id, userId));
  const [actor] = await db.select({ name: users.name, displayName: users.displayName }).from(users).where(eq(users.id, actorUserId));
  const [server] = await db.select({ name: servers.name, slug: servers.slug }).from(servers).where(eq(servers.id, serverId));
  if (!person?.email || person.retiredAt || !actor || !server) return null;
  return {
    email: person.email,
    name: person.displayName || person.name,
    // A member-chosen name: no control or bidi characters in a mail from Raft.
    actorName: sanitizeClientName(actor.displayName || actor.name) ?? "An admin",
    server,
  };
}

/**
 * Tells the member who had added a machine that an owner or admin moved it
 * over to a Computer (`AdoptLegacyResult.movedMachineAddedByUserId`). One
 * email, only while they are still in the server and their account is not
 * retired; a member who left gets none (the audit event is the record). Best
 * effort: never fails the adoption.
 */
export async function notifyLegacyMachineMovedByOther(input: {
  serverId: string;
  machineId: string;
  machineAddedByUserId: string;
  movedByUserId: string;
}): Promise<void> {
  try {
    const to = await noticeRecipient(input.serverId, input.machineAddedByUserId, input.movedByUserId);
    const [machine] = await getDb().select({ name: machines.name }).from(machines).where(eq(machines.id, input.machineId));
    if (!to || !machine) return;
    await sendLegacyMachineMovedEmail(to.email, to.name, {
      machineName: sanitizeClientName(machine.name) ?? "(unnamed)",
      movedByName: to.actorName,
      server: to.server,
    });
  } catch (err) {
    console.error("[computer-adoption] moved-by-other notice email failed:", err);
  }
}

/**
 * Tells the person whose key a Computer ran with that an owner or admin
 * replaced it (`AdoptLegacyResult.replacedKeyOf`): their copy stops
 * connecting. One email per takeover (a retry by the new holder replaces
 * their own key and tells nobody), under the same conditions as above.
 * `computerName` is the name it had before: the caller may rename it in the
 * same request.
 */
export async function notifyComputerKeyReplacedByOther(input: {
  serverId: string;
  computerName: string;
  keyHolderUserId: string;
  replacedByUserId: string;
}): Promise<void> {
  try {
    const to = await noticeRecipient(input.serverId, input.keyHolderUserId, input.replacedByUserId);
    if (!to) return;
    await sendComputerKeyReplacedByOtherEmail(to.email, to.name, {
      computerName: sanitizeClientName(input.computerName) ?? "(unnamed)",
      replacedByName: to.actorName,
      server: to.server,
    });
  } catch (err) {
    console.error("[computer-adoption] key-replaced-by-other notice email failed:", err);
  }
}

function sanitizeAdoptedName(supplied: string | undefined, fallback: string): string {
  if (typeof supplied === "string") {
    const trimmed = supplied.trim();
    if (trimmed.length > 0 && trimmed.length <= 200) return trimmed;
  }
  if (fallback.length > 0 && fallback.length <= 200) return fallback;
  return "raft-computer";
}

// Exposed for tests + Phase 3 typing.
export function _isAdoptedMachineRow(row: { legacyKeyMigratedAt: Date | null }): boolean {
  return row.legacyKeyMigratedAt !== null;
}
