// Computer credential service — manages `sk_computer_*` runtime principals
// per `rfcs/034-slock-credential-rfc.zh.html#section-credential-model`.
//
// Slice-1 minimal stub. One row in `computers` per Computer host attachment.
// Tao's Phase 1 work owns the canonical attach/detach UX flow; this module
// will be reconciled with that shape when Phase 1 lands.
//
// Hot-path auth lookup: prefix-indexed (O(1) by `idx_computers_prefix_active`,
// the partial index that excludes revoked rows). Verify follows: a
// constant-time HMAC compare when the row has `api_key_hmac` and
// AGENT_API_KEY_HMAC_SECRET is set; otherwise, or when that compare fails,
// argon2id, and an argon2 success stores the current HMAC.
//
// Key isolation invariant (base RFC §1.4 runner key isolation): the raw
// `sk_computer_*` value lives ONLY in the Computer host's private storage.
// This module returns the raw key exactly once at attach time; subsequent
// reads return the row WITHOUT it.

import { randomBytes, timingSafeEqual } from "node:crypto";
import argon2 from "argon2";
import { timedArgon2Verify, type Argon2VerifyStats } from "./argon2VerifyStats";
import { DeviceSessionRevokedError, lockLiveSessionFamily } from "./sessionService";
import { and, eq, isNull, isNotNull, lt, or, sql } from "drizzle-orm";
import { DEPRECATED_GRAVATAR_HASH, asMachineId } from "@botiverse/raft-shared";
import { getDb } from "../db/index";
import { computers, deviceLoginGrants, machines, serverMembers, servers, users } from "../db/schema";
import type { DatabaseTransaction } from "../db/index";
import { registerMachine, getMachine, generateMachineKeyMaterial, acquireMachineCreateLock } from "./machineService";
import { lockActorMembershipRow, ServerMembershipRevokedError } from "../lib/actorMembershipFence";
import { actorHasServerCapabilityInServer, getActorServerRoleInServer, actorRoleHasServerCapability } from "../lib/actorPermissions";
import { computeAgentApiKeyHmac } from "./agentCredentialService";
import { computerCredentialVerifyTotal } from "../metrics";

const COMPUTER_API_KEY_PREFIX_LENGTH = 16;
const COMPUTER_RAW_KEY_BYTES = 32;

export function isComputerApiKey(token: string): boolean {
  return token.startsWith("sk_computer_");
}

export function extractComputerApiKeyPrefix(apiKey: string): string {
  return apiKey.slice(0, COMPUTER_API_KEY_PREFIX_LENGTH);
}

/**
 * Return the set of `machines.id` values that are presented by an active
 * (non-revoked) managed Computer on this server — i.e. machine rows that
 * an `sk_computer_*` attachment links to via `computers.machineId`. Used
 * by the machine read model to label run-kind (Computer vs raw daemon)
 * without any new daemon-reported field. Batched: one query per list.
 */
export async function getComputerLinkedMachineIds(serverId: string): Promise<Set<string>> {
  return new Set((await getComputerLinkedMachineAttachers(serverId)).keys());
}

export async function getComputerLinkedMachineAttachers(serverId: string): Promise<Map<string, string | null>> {
  const db = getDb();
  const rows = await db
    .select({
      machineId: computers.machineId,
      attachedByUserId: computers.attachedByUserId,
    })
    .from(computers)
    .where(
      and(
        eq(computers.serverId, serverId),
        isNull(computers.revokedAt),
        isNotNull(computers.machineId),
      ),
    );
  const attachers = new Map<string, string | null>();
  for (const row of rows) {
    if (row.machineId) attachers.set(row.machineId, row.attachedByUserId);
  }
  return attachers;
}

export interface ComputerCreatorSummary {
  type: "human";
  id: string;
  name: string;
  displayName: string | null;
  avatarUrl: string | null;
  /** @deprecated Always ""; kept for older clients (DEPRECATED_GRAVATAR_HASH). */
  gravatarHash: string;
}

/**
 * Resolve active Computer attachers to the same server-scoped public identity
 * shape used by Agent creator links. A departed/deleted attacher intentionally
 * resolves to no creator instead of leaking a raw audit id.
 */
export async function getComputerLinkedMachineCreators(
  serverId: string,
): Promise<Map<string, ComputerCreatorSummary>> {
  const db = getDb();
  const rows = await db
    .select({
      machineId: computers.machineId,
      id: users.id,
      name: users.name,
      displayName: users.displayName,
      avatarUrl: users.avatarUrl,
    })
    .from(computers)
    .innerJoin(serverMembers, and(
      eq(serverMembers.serverId, computers.serverId),
      eq(serverMembers.userId, computers.attachedByUserId),
    ))
    .innerJoin(users, eq(users.id, serverMembers.userId))
    .where(and(
      eq(computers.serverId, serverId),
      isNull(computers.revokedAt),
      isNotNull(computers.machineId),
      isNotNull(computers.attachedByUserId),
    ));

  const creators = new Map<string, ComputerCreatorSummary>();
  for (const row of rows) {
    if (!row.machineId) continue;
    creators.set(row.machineId, {
      type: "human",
      id: row.id,
      name: row.name,
      displayName: row.displayName,
      avatarUrl: row.avatarUrl,
      gravatarHash: DEPRECATED_GRAVATAR_HASH,
    });
  }
  return creators;
}

export interface ComputerLookupResult {
  computerId: string;
  serverId: string;
  name: string;
  // The linked `machines` row this Computer presents as to the orchestrator.
  // Lookup fails closed (`computer_machine_unlinked`) when the link is missing,
  // so an authorized result always carries a live same-server machine.
  machineId: string;
}

/** HTTP and daemon handshakes share the same live credential decision. */
export async function findComputerByApiKey(apiKey: string): Promise<ComputerLookupResult | null> {
  if (!isComputerApiKey(apiKey)) return null;
  const result = await findComputerByApiKeyWithReason(apiKey);
  return result.ok ? result.computer : null;
}

export type ComputerAuthDenyReason =
  | "computer_not_found"
  | "computer_revoked"
  | "computer_machine_unlinked"
  | "computer_key_hash_mismatch"
  | "server_not_found";

export type ComputerAuthResolution =
  | { ok: true; computer: ComputerLookupResult }
  | { ok: false; reason: ComputerAuthDenyReason };

/** Prefix lookup + key proof (HMAC, else argon2 storing the HMAC), followed by live authorization. Re-read
 * after the proof so a deletion/revocation/rotation during verification cannot
 * resurrect a stale Computer. Orphaned pre-fix keys require user-authenticated
 * reattachment; they cannot retain server-wide credential minting authority.
 * `computer_machine_unlinked` is the wire reason the Computer client already
 * treats as terminal (`packages/computer/src/health.ts`), so it must stay. */
export async function findComputerByApiKeyWithReason(
  apiKey: string,
  argon2Stats?: Argon2VerifyStats,
): Promise<ComputerAuthResolution> {
  const db = getDb();
  const prefix = extractComputerApiKeyPrefix(apiKey);
  const candidates = await db
    .select({
      id: computers.id,
      serverId: computers.serverId,
      name: computers.name,
      apiKeyHash: computers.apiKeyHash,
      apiKeyHmac: computers.apiKeyHmac,
      machineId: computers.machineId,
      revokedAt: computers.revokedAt,
    })
    .from(computers)
    .where(eq(computers.apiKeyPrefix, prefix));
  if (candidates.length === 0) return { ok: false, reason: "computer_not_found" };

  // Same secret as sk_agent_* keys (#9577); null when it is unset, and then
  // every row verifies with argon2 exactly as before.
  const presentedHmac = computeAgentApiKeyHmac(apiKey);
  let revokedHashMatch = false;
  for (const row of candidates) {
    let verified = false;
    const storedHmac = presentedHmac && row.apiKeyHmac ? Buffer.from(row.apiKeyHmac) : null;
    if (storedHmac && presentedHmac && storedHmac.length === presentedHmac.length && timingSafeEqual(storedHmac, presentedHmac)) {
      verified = true;
      if (argon2Stats) argon2Stats.hmacMatches = (argon2Stats.hmacMatches ?? 0) + 1;
      computerCredentialVerifyTotal.inc({ path: "hmac", outcome: "matched" });
    } else {
      // No HMAC on the row, or it does not match. A mismatch is a wrong key,
      // or an HMAC written under a secret that has since changed; argon2 tells
      // them apart, so a changed or re-created secret degrades to argon2 and
      // heals itself instead of turning every stored HMAC into a 401.
      try {
        verified = await timedArgon2Verify(row.apiKeyHash, apiKey, argon2Stats);
      } catch {
        verified = false;
      }
      // `argon2_rehmac`: the stored HMAC was from an older secret. A burst of
      // these after a secret change shows the load went back to argon2.
      const rehmac = verified && storedHmac !== null;
      if (rehmac && argon2Stats) argon2Stats.hmacRewrites = (argon2Stats.hmacRewrites ?? 0) + 1;
      computerCredentialVerifyTotal.inc({
        path: rehmac ? "argon2_rehmac" : "argon2",
        outcome: verified ? "matched" : "not_matched",
      });
      // Store the HMAC right after the proof, before the revoked / unlinked /
      // deleted-server checks below: a key that keeps getting rejected for
      // one of those reasons (e.g. its server was deleted) pays argon2 once,
      // not on every reconnect.
      if (verified && presentedHmac) await storeComputerApiKeyHmac(row.id, row.apiKeyHash, presentedHmac);
    }
    if (!verified) continue;
    const [current] = await db.select().from(computers).where(and(
      eq(computers.id, row.id), eq(computers.apiKeyHash, row.apiKeyHash),
    )).limit(1);
    if (!current) continue;
    if (current.revokedAt) {
      revokedHashMatch = true;
      continue;
    }
    if (!current.machineId) return { ok: false, reason: "computer_machine_unlinked" };
    const [machine] = await db.select({ id: machines.id }).from(machines).where(and(
      eq(machines.id, current.machineId), eq(machines.serverId, current.serverId),
    )).limit(1);
    if (!machine) return { ok: false, reason: "computer_machine_unlinked" };
    const [serverRow] = await db
      .select({ id: servers.id })
      .from(servers)
      .where(and(eq(servers.id, row.serverId), isNull(servers.deletedAt)));
    if (!serverRow) return { ok: false, reason: "server_not_found" };
    return {
      ok: true,
      computer: {
        computerId: row.id,
        serverId: row.serverId,
        name: row.name,
        machineId: current.machineId,
      },
    };
  }
  if (revokedHashMatch) return { ok: false, reason: "computer_revoked" };
  return { ok: false, reason: "computer_key_hash_mismatch" };
}

/**
 * How often one computer's `last_used_*` triple is written at most. Every
 * authenticated computer request calls `recordComputerUse`; a computer whose
 * agents all reconnect at once (30+ runner-credential requests in a few
 * seconds) made every server instance update the same row, queueing on its
 * row lock for seconds while holding a pool connection. Nothing reads these
 * columns in real time, so a minute of staleness costs nothing.
 */
export const COMPUTER_USE_WRITE_INTERVAL_MS = 60_000;
const COMPUTER_USE_RECENT_LIMIT = 10_000;
const recentComputerUseWrites = new Map<string, number>();

/** Test seam: forget which computers this process has written recently. */
export function resetComputerUseWriteCacheForTests(): void {
  recentComputerUseWrites.clear();
}

/**
 * Best-effort observability triple write, at most once per
 * COMPUTER_USE_WRITE_INTERVAL_MS per computer. Within the interval this
 * process skips the database entirely; across instances the WHERE clause
 * makes every write but the first a no-op that changes no row. Failure does
 * not affect the request path; always called via `void recordComputerUse(...)`.
 */
export async function recordComputerUse(input: {
  computerId: string;
  ip: string | null;
  userAgent: string | null;
}, now: number = Date.now()): Promise<void> {
  const lastWrite = recentComputerUseWrites.get(input.computerId);
  if (lastWrite !== undefined && now - lastWrite < COMPUTER_USE_WRITE_INTERVAL_MS) return;
  if (recentComputerUseWrites.size >= COMPUTER_USE_RECENT_LIMIT) recentComputerUseWrites.clear();
  recentComputerUseWrites.set(input.computerId, now);
  try {
    const db = getDb();
    await db
      .update(computers)
      .set({
        lastUsedAt: new Date(now),
        lastUsedIp: input.ip,
        lastUsedUserAgent: input.userAgent,
      })
      .where(and(
        eq(computers.id, input.computerId),
        or(
          isNull(computers.lastUsedAt),
          lt(computers.lastUsedAt, sql`now() - make_interval(secs => ${COMPUTER_USE_WRITE_INTERVAL_MS / 1000})`),
        ),
      ));
  } catch {
    // Swallow — observability writes must not impact auth latency / success.
  }
}

/**
 * Generate a fresh raw `sk_computer_*` key + its argon2id hash + the
 * prefix for indexed lookup. Returns the raw key ONLY to the caller;
 * never persists it in raw form.
 *
 * Slice-1 has no public attach endpoint that calls this — Tao's Phase 1
 * owns the UX flow. Test fixtures / seed scripts that need a Computer
 * row should call this helper directly and write the row + hash.
 */
export async function generateComputerApiKeyMaterial(): Promise<{
  apiKey: string;
  apiKeyHash: string;
  /** Null when the HMAC secret is unset. Every write of `apiKeyHash` writes this too, so a rotation never leaves the old key's HMAC behind. */
  apiKeyHmac: Buffer | null;
  apiKeyPrefix: string;
}> {
  const apiKey = `sk_computer_${randomBytes(COMPUTER_RAW_KEY_BYTES).toString("hex")}`;
  const apiKeyHash = await argon2.hash(apiKey);
  return {
    apiKey,
    apiKeyHash,
    apiKeyHmac: computeAgentApiKeyHmac(apiKey),
    apiKeyPrefix: extractComputerApiKeyPrefix(apiKey),
  };
}

// A row verified by argon2 stores its HMAC (filling a missing one, or
// replacing one from an older secret) so later lookups skip argon2. The write
// is conditional on the hash just verified: a rotation that landed during the
// verify must not receive the old key's HMAC. Best-effort.
async function storeComputerApiKeyHmac(computerId: string, apiKeyHash: string, apiKeyHmac: Buffer): Promise<void> {
  try {
    await getDb()
      .update(computers)
      .set({ apiKeyHmac })
      .where(and(eq(computers.id, computerId), eq(computers.apiKeyHash, apiKeyHash)));
  } catch (err) {
    console.warn("[ComputerCredential] api_key_hmac backfill failed", {
      computerId,
      error: err instanceof Error ? err.message : String(err),
    });
  }
}

/**
 * task #30 PR-B 3/n — user-authenticated Computer attach (RFC v0.8
 * contract v3 §6/§9). Called from `POST /api/computer/attach` AFTER a
 * `raft-computer login` user session. Establishes this machine's
 * `sk_computer_*` Computer attachment for ONE server.
 *
 * NOT a runner-credential mint (that is sk_agent_* via the sk_computer-
 * gated /internal surface). This issues the Computer principal itself,
 * authorized by a logged-in user who is a member of the target server.
 *
 * User-facing attach identifies the server by slug. The service resolves
 * slug → canonical serverId at the trust boundary; DB rows and local
 * Computer state remain serverId-keyed so server rename does not break
 * isolation/layout.
 *
 * Computer name is a display label only. This endpoint never resumes or
 * rotates an existing Computer by `(serverId, attachedByUserId, name)`.
 * Local idempotency/proof-resume is handled by the CLI before calling this
 * endpoint, using `runner.state.json` + the still-valid `sk_computer_*`
 * key. Without that proof, a duplicate live display name for the same
 * attaching user is reported as `computer_name_collision`; a separately
 * revoked row is skipped and a fresh one may be created. Rows are NEVER
 * deleted, so revoked rows remain as audit history.
 *
 * Stable, zero-enumeration failure: non-member / missing / deleted server
 * all collapse to `not_authorized` (no signal whether the server exists).
 *
 * Role gate: attaching a Computer mints a machine principal, so it requires
 * the `manageMachines` capability (owner / admin only — member is denied).
 * A member who lacks the capability gets the distinct `requires_admin` code:
 * this is not an enumeration leak (the caller already knows they are a
 * member) and lets the CLI tell them to ask an admin instead of a blank 403.
 */
export type AttachComputerResult =
  | { ok: true; apiKey: string; serverMachineId: string; machineId: string; serverId: string; serverSlug: string; resumed: boolean }
  | {
      ok: false;
      error:
        | "not_authorized"
        | "requires_admin"
        | "computer_name_collision"
        | "session_revoked"
        // Attaching with a device-login grant's attach token (`grant` below).
        | "attach_token_invalid"
        | "attach_token_expired"
        | "attach_token_consumed";
    };

/**
 * task #30 PR-F — ensure the Computer is backed by a `machines` (daemons)
 * row so it presents to the orchestrator as a normal machine. Idempotent:
 * reuses the existing link if its machine still exists; otherwise mints a
 * fresh machine row (the generated sk_machine_* is intentionally
 * discarded — the Computer authenticates with its sk_computer_*; the
 * /daemon/connect gate resolves Computer → this linked machine). No
 * orchestrator change, no agent-table change: agents bind to a Computer
 * via the normal `agents.machineId = <this machine id>`.
 */

/**
 * Locks a device-login grant for redeeming its attach token in this attach's
 * transaction (the row lock orders two attaches with the same token: the
 * second sees it consumed). Null when it may be redeemed; otherwise why not.
 */
async function lockRedeemableAttachGrant(
  tx: DatabaseTransaction,
  grant: { id: string; tokenLookupHash: Buffer },
  expected: { serverId: string; userId: string },
): Promise<"attach_token_invalid" | "attach_token_expired" | "attach_token_consumed" | null> {
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
  if (!row || row.kind !== "computer_attach") {
    return "attach_token_invalid";
  }
  if (row.status === "consumed") return "attach_token_consumed";
  if (row.status !== "approved" || !row.expiresAt || row.expiresAt.getTime() <= Date.now()) return "attach_token_expired";
  if (row.serverId !== expected.serverId || row.approverUserId !== expected.userId) return "attach_token_invalid";
  return null;
}

export async function attachComputer(input: {
  userId: string;
  serverSlug: string;
  name: string;
  /** A device login's session family, when that session attaches: recorded on the key and fenced live. */
  deviceSessionFamilyId?: string | null;
  /**
   * The person's own web (full) session family, when that session attaches:
   * recorded on the key in its own column (a security revoke of the session
   * revokes it, webSessionIssuedKeys.ts) and fenced live.
   */
  webSessionFamilyId?: string | null;
  /**
   * A device-login grant's attach token, redeemed by this attach (the caller
   * passes the approver as `userId`). Checked and consumed in the attach's
   * transaction: approved, unexpired, for this server and approver, not used.
   * The key records the grant, never a session family.
   */
  grant?: { id: string; tokenLookupHash: Buffer };
}): Promise<AttachComputerResult> {
  const db = getDb();

  // Server must exist + not be soft-deleted, and the user must be a member
  // WITH the manageMachines capability (owner / admin). getMemberRole returns
  // null for nonexistent/deleted servers and non-members, so the liveness +
  // membership check collapses to `not_authorized` (no existence signal). A
  // member who lacks the capability is told `requires_admin` — they already
  // know they are a member, so this is not an enumeration leak.
  const [server] = await db
    .select({ id: servers.id, slug: servers.slug })
    .from(servers)
    .where(and(eq(servers.slug, input.serverSlug), isNull(servers.deletedAt)));
  if (!server) return { ok: false, error: "not_authorized" };
  const role = await getActorServerRoleInServer(server.id, "user", input.userId);
  if (!role) return { ok: false, error: "not_authorized" };
  if (!await actorHasServerCapabilityInServer(server.id, "user", input.userId, "registerMachines")) {
    return { ok: false, error: "requires_admin" };
  }

  // Task #93 line G: both keys are generated before any lock (argon2 is slow). The attach then runs as ONE transaction:
  // machines advisory lock → the attaching human's own `server_members` row (share) → capability re-check → name
  // collision check → Computer insert → Machine register → link. A removal or demotion that commits first is observed
  // under the lock and leaves zero Computers and zero Machines; before this, the two inserts ran without a transaction.
  const material = await generateComputerApiKeyMaterial();
  const machineMaterial = await generateMachineKeyMaterial();

  try {
    return await db.transaction(async (tx): Promise<AttachComputerResult> => {
      const machineCreateLock = await acquireMachineCreateLock(tx, server.id);
      const lockedRole = await lockActorMembershipRow(tx, server.id, input.userId, "share");
      if (!actorRoleHasServerCapability(lockedRole, "registerMachines")) {
        return { ok: false, error: "requires_admin" };
      }
      const fencedFamilyId = input.deviceSessionFamilyId ?? (input.grant ? null : input.webSessionFamilyId ?? null);
      if (fencedFamilyId) await lockLiveSessionFamily(tx, fencedFamilyId, input.userId);
      if (input.grant) {
        const refused = await lockRedeemableAttachGrant(tx, input.grant, { serverId: server.id, userId: input.userId });
        if (refused) return { ok: false, error: refused };
      }

      // Name is display-only. A duplicate live display name from the same
      // attaching user is ambiguous, so fail closed instead of treating the name
      // as identity proof and rotating the existing credential.
      const [existing] = await tx
        .select({ id: computers.id })
        .from(computers)
        .where(
          and(
            eq(computers.serverId, server.id),
            eq(computers.attachedByUserId, input.userId),
            eq(computers.name, input.name),
            isNull(computers.revokedAt),
          ),
        );

      if (existing) return { ok: false, error: "computer_name_collision" };

      const [row] = await tx
        .insert(computers)
        .values({
          serverId: server.id,
          name: input.name,
          apiKeyHash: material.apiKeyHash,
          apiKeyHmac: material.apiKeyHmac,
          apiKeyPrefix: material.apiKeyPrefix,
          attachedByUserId: input.userId,
          keyIssuedBySessionFamilyId: input.grant ? null : input.deviceSessionFamilyId ?? null,
          keyIssuedByWebSessionFamilyId: input.grant ? null : input.webSessionFamilyId ?? null,
          keyIssuedByGrantId: input.grant?.id ?? null,
        })
        .returning({ id: computers.id });

      const { machine } = await registerMachine(server.id, input.userId, input.name, {
        machineCreateLock,
        material: machineMaterial,
      });
      await tx.update(computers).set({ machineId: machine.id }).where(eq(computers.id, row.id));
      if (input.grant) {
        await tx
          .update(deviceLoginGrants)
          .set({ status: "consumed", consumedAt: new Date(), consumedComputerId: row.id })
          .where(and(eq(deviceLoginGrants.id, input.grant.id), eq(deviceLoginGrants.status, "approved")));
      }

      return {
        ok: true,
        apiKey: material.apiKey,
        serverMachineId: row.id,
        machineId: machine.id,
        serverId: server.id,
        serverSlug: server.slug,
        resumed: false,
      };
    });
  } catch (error) {
    // Removal committed first: identical to "not a member" before the transaction existed.
    if (error instanceof ServerMembershipRevokedError) return { ok: false, error: "not_authorized" };
    if (error instanceof DeviceSessionRevokedError) return { ok: false, error: "session_revoked" };
    throw error;
  }
}
