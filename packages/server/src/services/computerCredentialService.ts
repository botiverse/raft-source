// Computer credential service — manages `sk_computer_*` runtime principals
// per `rfcs/034-slock-credential-rfc.zh.html#section-credential-model`.
//
// Slice-1 minimal stub. One row in `computers` per Computer host attachment.
// Tao's Phase 1 work owns the canonical attach/detach UX flow; this module
// will be reconciled with that shape when Phase 1 lands.
//
// Hot-path auth lookup: prefix-indexed (O(1) by `idx_computers_prefix_active`,
// the partial index that excludes revoked rows). Argon2id verify follows.
//
// Key isolation invariant (base RFC §1.4 runner key isolation): the raw
// `sk_computer_*` value lives ONLY in the Computer host's private storage.
// This module returns the raw key exactly once at attach time; subsequent
// reads return the row WITHOUT it.

import { createHash, randomBytes } from "node:crypto";
import argon2 from "argon2";
import { and, eq, isNull, isNotNull } from "drizzle-orm";
import { asMachineId } from "@botiverse/raft-shared";
import { getDb } from "../db/index.js";
import { computers, machines, serverMembers, servers, users } from "../db/schema.js";
import { registerMachine, getMachine } from "./machineService.js";
import { actorHasServerCapabilityInServer, getActorServerRoleInServer } from "../lib/actorPermissions.js";

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
      email: users.email,
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
      gravatarHash: createHash("sha256").update(row.email.trim().toLowerCase()).digest("hex"),
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

/** Prefix lookup + argon2 proof, followed by live authorization. Re-read
 * after argon2 so a deletion/revocation/rotation during verification cannot
 * resurrect a stale Computer. Orphaned pre-fix keys require user-authenticated
 * reattachment; they cannot retain server-wide credential minting authority.
 * `computer_machine_unlinked` is the wire reason the Computer client already
 * treats as terminal (`packages/computer/src/health.ts`), so it must stay. */
export async function findComputerByApiKeyWithReason(
  apiKey: string,
): Promise<ComputerAuthResolution> {
  const db = getDb();
  const prefix = extractComputerApiKeyPrefix(apiKey);
  const candidates = await db
    .select({
      id: computers.id,
      serverId: computers.serverId,
      name: computers.name,
      apiKeyHash: computers.apiKeyHash,
      machineId: computers.machineId,
      revokedAt: computers.revokedAt,
    })
    .from(computers)
    .where(eq(computers.apiKeyPrefix, prefix));
  if (candidates.length === 0) return { ok: false, reason: "computer_not_found" };

  let revokedHashMatch = false;
  for (const row of candidates) {
    let verified = false;
    try {
      verified = await argon2.verify(row.apiKeyHash, apiKey);
    } catch {
      continue;
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
 * Best-effort observability triple write. Failure does not affect the
 * request path; always called via `void recordComputerUse(...)`.
 */
export async function recordComputerUse(input: {
  computerId: string;
  ip: string | null;
  userAgent: string | null;
}): Promise<void> {
  try {
    const db = getDb();
    await db
      .update(computers)
      .set({
        lastUsedAt: new Date(),
        lastUsedIp: input.ip,
        lastUsedUserAgent: input.userAgent,
      })
      .where(eq(computers.id, input.computerId));
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
  apiKeyPrefix: string;
}> {
  const apiKey = `sk_computer_${randomBytes(COMPUTER_RAW_KEY_BYTES).toString("hex")}`;
  const apiKeyHash = await argon2.hash(apiKey);
  return {
    apiKey,
    apiKeyHash,
    apiKeyPrefix: extractComputerApiKeyPrefix(apiKey),
  };
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
  | { ok: false; error: "not_authorized" | "requires_admin" | "computer_name_collision" };

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
async function ensureComputerMachine(
  computerId: string,
  serverId: string,
  userId: string,
  name: string,
): Promise<string> {
  const db = getDb();
  const [c] = await db
    .select({ machineId: computers.machineId })
    .from(computers)
    .where(eq(computers.id, computerId));
  if (c?.machineId) {
    const existingMachine = await getMachine(asMachineId(c.machineId));
    if (existingMachine) return c.machineId;
  }
  const { machine } = await registerMachine(serverId, userId, name);
  await db
    .update(computers)
    .set({ machineId: machine.id })
    .where(eq(computers.id, computerId));
  return machine.id;
}

export async function attachComputer(input: {
  userId: string;
  serverSlug: string;
  name: string;
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

  // Name is display-only. A duplicate live display name from the same
  // attaching user is ambiguous, so fail closed instead of treating the name
  // as identity proof and rotating the existing credential.
  const [existing] = await db
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

  const material = await generateComputerApiKeyMaterial();

  const [row] = await db
    .insert(computers)
    .values({
      serverId: server.id,
      name: input.name,
      apiKeyHash: material.apiKeyHash,
      apiKeyPrefix: material.apiKeyPrefix,
      attachedByUserId: input.userId,
    })
    .returning({ id: computers.id });

  const machineId = await ensureComputerMachine(row.id, server.id, input.userId, input.name);

  return {
    ok: true,
    apiKey: material.apiKey,
    serverMachineId: row.id,
    machineId,
    serverId: server.id,
    serverSlug: server.slug,
    resumed: false,
  };
}
