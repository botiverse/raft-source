import { eq, and, inArray, isNotNull, isNull, lt, or, sql, asc } from "drizzle-orm";
import { createHash, randomBytes } from "node:crypto";
import argon2 from "argon2";
import { timedArgon2Verify, type Argon2VerifyStats } from "./argon2VerifyStats";
import { getDb, type DatabaseExecutor } from "../db/index";
import { agentCredentials, computers, machines, servers, agents, agentMigrations, agentRuntimeProfiles } from "../db/schema";
import { withServerLock, acquireServerLock } from "./planService";
import { FencedAuthorizationDeniedError, lockActorMembershipRow } from "../lib/actorMembershipFence";
import { actorRoleHasServerCapability } from "../lib/actorPermissions";
import { lockLiveSessionFamily } from "./sessionService";
import { PLAN_CONFIG, currentDate, getEffectiveLimits, type DeviceClass, type DaemonInstallKind, type HostProvider, type MachineId, type ServerPlan } from "@botiverse/raft-shared";
import { untracedDbQuery, type DbQueryTracer } from "../tracing/dbQueryTrace";
import { agentFindableBy, type AgentFinder } from "./agentMemberListPolicy";

/** Extract a short prefix from an API key for indexed DB lookup. */
export function extractApiKeyPrefix(apiKey: string): string {
  return apiKey.slice(0, 20);
}

// sha256(apiKey).slice(0,16) — stable identity shared with the on-disk
// legacy daemon `owner.json` (`packages/daemon/src/machineLock.ts`
// `apiKeyFingerprint`). RFC v9.9 §X.2 picker intersects local
// `owner.json.apiKeyFingerprint` with the server roster on this column.
// SECRET REDLINE: derived from raw apiKey, treat as sensitive identity.
// Never log; only return from authenticated user+server scoped endpoints.
export function extractApiKeyFingerprint(apiKey: string): string {
  return createHash("sha256").update(apiKey).digest("hex").slice(0, 16);
}

// Cache only the expensive proof that a key matches a particular hash. Mutable
// authorization state must be read from the database on every request, including
// after an in-flight argon2 verification; local invalidation cannot fence peers.
const authCache = new Map<string, { machineId: string; apiKeyHash: string; expiresAt: number }>();
const AUTH_CACHE_TTL = 5 * 60 * 1000; // 5 minutes

/** Clear all cached auth entries for a specific machine (call on delete/key rotate). */
export function clearAuthCache(machineId: string) {
  for (const [key, entry] of authCache) {
    if (entry.machineId === machineId) authCache.delete(key);
  }
}

export type MachineKeyMaterial = {
  apiKey: string;
  apiKeyHash: string;
  apiKeyPrefix: string;
  apiKeyFingerprint: string;
};

/** Generates a raw `sk_machine_*` key and its stored hash. argon2 is slow: never call this while holding row locks. */
export async function generateMachineKeyMaterial(): Promise<MachineKeyMaterial> {
  const apiKey = `sk_machine_${randomBytes(32).toString("hex")}`;
  return {
    apiKey,
    apiKeyHash: await argon2.hash(apiKey),
    apiKeyPrefix: extractApiKeyPrefix(apiKey),
    apiKeyFingerprint: extractApiKeyFingerprint(apiKey),
  };
}

declare const machineCreateLockBrand: unique symbol;

/**
 * Opaque proof that the machines advisory lock (namespace 2) is held on a specific transaction for a specific Server.
 * The token carries no readable state: the transaction and Server id live in `machineCreateLocks`, keyed by the token's
 * identity and written only by acquireMachineCreateLock. A spread copy, a raw cast or any other fabricated object is not
 * a key in that map, so registerMachine refuses it before writing anything. Construction is enrolled in
 * scripts/ci/check-branded-mint-sites.ts: `as MachineCreateLock` is allowed only in this file.
 */
export type MachineCreateLock = { readonly [machineCreateLockBrand]: true };

const machineCreateLocks = new WeakMap<object, { tx: DatabaseExecutor; serverId: string }>();

/** Takes the machines advisory lock on the caller's transaction exactly once and returns the token registerMachine needs. */
export async function acquireMachineCreateLock(tx: DatabaseExecutor, serverId: string): Promise<MachineCreateLock> {
  await acquireServerLock(tx, serverId, 2);
  const token = Object.freeze(Object.create(null)) as MachineCreateLock;
  machineCreateLocks.set(token, { tx, serverId });
  return token;
}

/** Resolves a token issued by acquireMachineCreateLock for `serverId`; throws for anything else. */
function resolveMachineCreateLock(token: MachineCreateLock, serverId: string): DatabaseExecutor {
  const held = typeof token === "object" && token !== null ? machineCreateLocks.get(token) : undefined;
  if (!held) {
    throw new Error("registerMachine: not a machine create lock issued by acquireMachineCreateLock");
  }
  if (held.serverId !== serverId) {
    throw new Error("registerMachine: the machine create lock was acquired for a different Server");
  }
  return held.tx;
}

export async function registerMachine(
  serverId: string,
  userId: string,
  name: string,
  options: {
    /**
     * Join the caller's transaction, which already holds the machines advisory lock for this Server (single acquisition
     * point). A handle for another Server is refused.
     */
    machineCreateLock?: MachineCreateLock;
    /**
     * Task #93 line G: re-authorize the registering human under a share lock on their own `server_members` row inside
     * the create transaction (advisory lock → member row → insert), so a removal or demotion that commits first leaves
     * zero registered Machines.
     */
    capability?: "registerMachines";
    /** Pre-generated key material, so a caller that already holds locks never hashes inside them. */
    material?: MachineKeyMaterial;
    /**
     * The registering person's web (full) session family, when that session
     * registers (POST /api/servers/:id/machines): fenced live in the create
     * transaction and recorded on the key, so a security revoke of that
     * session discards it (webSessionIssuedKeys.ts). Never set by an attach,
     * whose machine key is discarded.
     */
    webSessionFamilyId?: string | null;
  } = {},
) {
  // Generate API key outside the lock (argon2 is slow, don't hold the lock during hashing)
  const { apiKey, apiKeyHash, apiKeyPrefix, apiKeyFingerprint } = options.material ?? await generateMachineKeyMaterial();

  // Atomic quota check + insert under advisory lock (namespace 2 = machines)
  const lockedTx = options.machineCreateLock ? resolveMachineCreateLock(options.machineCreateLock, serverId) : undefined;
  const register = async (tx: DatabaseExecutor) => {
    if (options.capability) {
      const lockedRole = await lockActorMembershipRow(tx, serverId, userId, "share");
      if (!actorRoleHasServerCapability(lockedRole, options.capability)) {
        throw new FencedAuthorizationDeniedError("forbidden");
      }
    }
    if (options.webSessionFamilyId) await lockLiveSessionFamily(tx, options.webSessionFamilyId, userId);
    // Check plan quota
    const [serverRow] = await tx.select({ plan: servers.plan }).from(servers).where(eq(servers.id, serverId));
    const plan = (serverRow?.plan as ServerPlan) || "free";
    const limits = getEffectiveLimits(plan);
    if (limits.maxMachines !== -1) {
      const [countRow] = await tx.select({ count: sql<number>`count(*)::int` }).from(machines).where(eq(machines.serverId, serverId));
      const count = countRow?.count ?? 0;
      if (count >= limits.maxMachines) {
        throw new Error(`Machine limit reached (${count}/${limits.maxMachines} on ${PLAN_CONFIG[plan].displayName} plan). Upgrade for more.`);
      }
    }

    const [newMachine] = await tx.insert(machines).values({
      serverId,
      userId,
      name,
      apiKeyHash,
      apiKeyPrefix,
      apiKeyFingerprint,
      keyIssuedByWebSessionFamilyId: options.webSessionFamilyId ?? null,
    }).returning();

    return newMachine;
  };
  const machine = lockedTx
    ? await register(lockedTx)
    : await withServerLock(serverId, 2, register);

  return { machine, apiKey };
}

export async function listMachines(
  serverId: string,
  opts: { traceQuery?: DbQueryTracer } = {},
) {
  const db = getDb();
  const traceQuery = opts.traceQuery ?? untracedDbQuery;
  return traceQuery(
    "machines.list_by_server",
    () => db.select({
      id: machines.id,
      serverId: machines.serverId,
      userId: machines.userId,
      name: machines.name,
      description: machines.description,
      apiKeyPrefix: machines.apiKeyPrefix,
      runtimes: machines.runtimes,
      hostname: machines.hostname,
      os: machines.os,
      deviceClass: machines.deviceClass,
      hostProvider: machines.hostProvider,
      osRelease: machines.osRelease,
      osId: machines.osId,
      osIdLike: machines.osIdLike,
      installKind: machines.installKind,
      daemonVersion: machines.daemonVersion,
      computerVersion: machines.computerVersion,
      computerVersionReportedAt: machines.computerVersionReportedAt,
      lastHeartbeat: machines.lastHeartbeat,
      createdAt: machines.createdAt,
      ownerUserId: machines.ownerUserId,
    }).from(machines).where(eq(machines.serverId, serverId)).orderBy(asc(machines.createdAt)),
    (rows) => ({
      row_count: rows.length,
    }),
  );
}

/**
 * Each machine's live agents, as `finder` may find them: another person's
 * personal assistant is not counted (agentFindableBy), so a Computer's count
 * does not tell anyone else that it hosts one.
 */
export async function countActiveAgentsByMachine(
  serverId: string,
  finder: AgentFinder,
  opts: { traceQuery?: DbQueryTracer } = {},
): Promise<Map<string, number>> {
  const db = getDb();
  const traceQuery = opts.traceQuery ?? untracedDbQuery;
  const rows = await traceQuery(
    "machines.agent_counts_by_server",
    () => db
      .select({
        machineId: agents.machineId,
        count: sql<number>`count(*)::int`,
      })
      .from(agents)
      .where(and(eq(agents.serverId, serverId), isNull(agents.deletedAt), isNotNull(agents.machineId), agentFindableBy(finder)))
      .groupBy(agents.machineId),
    (result) => ({ row_count: result.length }),
  );
  return new Map(rows.map((row) => [row.machineId!, Number(row.count) || 0]));
}

/**
 * Count only agents whose lifecycle status is currently `active`.
 *
 * The older `countActiveAgentsByMachine` name predates the stopped/inactive
 * distinction and counts every non-deleted assignment. Machine notification
 * severity is operational impact, so stopped/inactive agents must not turn an
 * offline warning into an error.
 */
export async function countRunningAgentsByMachine(
  serverId: string,
  finder: AgentFinder,
  opts: { traceQuery?: DbQueryTracer } = {},
): Promise<Map<string, number>> {
  const db = getDb();
  const traceQuery = opts.traceQuery ?? untracedDbQuery;
  const rows = await traceQuery(
    "machines.running_agent_counts_by_server",
    () => db
      .select({
        machineId: agents.machineId,
        count: sql<number>`count(*)::int`,
      })
      .from(agents)
      .where(and(
        eq(agents.serverId, serverId),
        eq(agents.status, "active"),
        isNull(agents.deletedAt),
        isNotNull(agents.machineId),
        // As countActiveAgentsByMachine: another person's assistant is not counted.
        agentFindableBy(finder),
      ))
      .groupBy(agents.machineId),
    (result) => ({ row_count: result.length }),
  );
  return new Map(rows.map((row) => [row.machineId!, Number(row.count) || 0]));
}

export async function getMachine(machineId: MachineId) {
  const db = getDb();
  const [machine] = await db.select().from(machines).where(eq(machines.id, machineId));
  return machine || null;
}

export async function renameMachine(machineId: string, name: string) {
  const db = getDb();
  const [updated] = await db.update(machines).set({ name }).where(eq(machines.id, machineId)).returning();
  return updated;
}

export async function updateMachine(
  machineId: string,
  fields: { name?: string; description?: string | null },
  options: { executor?: DatabaseExecutor } = {},
) {
  const db = options.executor ?? getDb();
  const [updated] = await db.update(machines).set(fields).where(eq(machines.id, machineId)).returning();
  return updated;
}

/** What a `ready` says about the machine, validated; null = unknown or an older daemon. */
export interface MachineHostFacts {
  deviceClass: DeviceClass | null;
  hostProvider: HostProvider | null;
  osRelease: string | null;
  osId: string | null;
  osIdLike: string[] | null;
  installKind: DaemonInstallKind | null;
  nodeOnPath: boolean | null;
}

export async function updateMachineRuntimes(
  machineId: string,
  runtimes: string[],
  hostname?: string,
  os?: string,
  daemonVersion?: string | null,
  host?: MachineHostFacts,
) {
  const db = getDb();
  await db.update(machines).set({
    runtimes,
    ...(hostname !== undefined ? { hostname } : {}),
    ...(os !== undefined ? { os } : {}),
    ...(host ? { deviceClass: host.deviceClass, hostProvider: host.hostProvider, osRelease: host.osRelease, osId: host.osId, osIdLike: host.osIdLike, installKind: host.installKind, nodeOnPath: host.nodeOnPath } : {}),
    ...(daemonVersion !== undefined ? { daemonVersion } : {}),
  }).where(eq(machines.id, machineId));
  if (daemonVersion !== undefined) {
    clearAuthCache(machineId);
  }
}

const COMPUTER_VERSION_REPORT_REFRESH_MS = 24 * 60 * 60 * 1000;

/**
 * Persist the last Computer version a machine reported.
 *
 * This is inventory telemetry, not an online-status signal. Repeated reports
 * of the same version refresh at most once per 24 hours, while a version
 * change is recorded immediately.
 */
export async function recordMachineComputerVersion(
  machineId: string,
  rawComputerVersion: string | null | undefined,
  reportedAt = currentDate(),
): Promise<boolean> {
  const computerVersion = rawComputerVersion?.trim();
  if (!computerVersion) return false;

  const db = getDb();
  const refreshBefore = new Date(reportedAt.getTime() - COMPUTER_VERSION_REPORT_REFRESH_MS);
  const updated = await db
    .update(machines)
    .set({
      computerVersion,
      computerVersionReportedAt: reportedAt,
    })
    .where(and(
      eq(machines.id, machineId),
      or(
        sql`${machines.computerVersion} IS DISTINCT FROM ${computerVersion}`,
        isNull(machines.computerVersionReportedAt),
        lt(machines.computerVersionReportedAt, refreshBefore),
      ),
    ))
    .returning({ id: machines.id });
  return updated.length > 0;
}

export async function updateHeartbeat(machineId: string) {
  const db = getDb();
  await db.update(machines).set({
    lastHeartbeat: new Date(),
  }).where(eq(machines.id, machineId));
}

/**
 * `webSessionFamilyId`: the web (full) session family issuing the new key
 * (recorded so a security revoke of that session discards it,
 * webSessionIssuedKeys.ts); the caller fences it live in its transaction.
 * Whatever issued the old key no longer holds the new one.
 */
export async function regenerateApiKey(machineId: string, options: { executor?: DatabaseExecutor; webSessionFamilyId?: string | null } = {}) {
  const db = options.executor ?? getDb();
  const apiKey = `sk_machine_${randomBytes(32).toString("hex")}`;
  const apiKeyHash = await argon2.hash(apiKey);
  const apiKeyPrefix = extractApiKeyPrefix(apiKey);
  const apiKeyFingerprint = extractApiKeyFingerprint(apiKey);
  await db.update(machines).set({
    apiKeyHash,
    apiKeyPrefix,
    apiKeyFingerprint,
    keyIssuedByWebSessionFamilyId: options.webSessionFamilyId ?? null,
    // The exposed key is no longer the key (#proj-raft-computer task #38).
    credentialExposureFoundAt: null,
  }).where(eq(machines.id, machineId));
  // Evict only after the new hash is written, so a concurrent auth cannot re-cache the old key. Inside a caller's
  // transaction the caller must evict after that transaction commits.
  if (!options.executor) clearAuthCache(machineId);
  return apiKey;
}

/** Prefix-indexed key verification with live authorization state on every call. */
export async function findMachineByApiKey(apiKey: string, argon2Stats?: Argon2VerifyStats) {
  const db = getDb();
  const cached = authCache.get(apiKey);
  if (cached && cached.expiresAt > Date.now()) {
    const [machine] = await db.select().from(machines).where(and(
      eq(machines.id, cached.machineId),
      eq(machines.apiKeyHash, cached.apiKeyHash),
    )).limit(1);
    if (machine) return machine;
    authCache.delete(apiKey);
    return null;
  }

  const prefix = extractApiKeyPrefix(apiKey);
  const fingerprint = extractApiKeyFingerprint(apiKey);
  const candidates = await db.select().from(machines).where(or(
    eq(machines.apiKeyPrefix, prefix), isNull(machines.apiKeyPrefix),
  ));
  for (const candidate of candidates) {
    let valid: boolean;
    try {
      valid = await timedArgon2Verify(candidate.apiKeyHash, apiKey, argon2Stats);
    } catch {
      continue;
    }
    if (!valid) continue;
    // Rotation, adoption or deletion can commit while argon2 is running. Never
    // authorize or backfill from the snapshot taken before that await.
    const [machine] = await db.select().from(machines).where(and(
      eq(machines.id, candidate.id), eq(machines.apiKeyHash, candidate.apiKeyHash),
    )).limit(1);
    if (!machine) return null;
    if (machine.apiKeyPrefix === null || machine.apiKeyFingerprint === null) {
      await db.update(machines).set({ apiKeyPrefix: prefix, apiKeyFingerprint: fingerprint })
        .where(and(eq(machines.id, machine.id), eq(machines.apiKeyHash, machine.apiKeyHash)));
    }
    authCache.set(apiKey, {
      machineId: machine.id, apiKeyHash: machine.apiKeyHash,
      expiresAt: Date.now() + AUTH_CACHE_TTL,
    });
    return machine;
  }
  return null;
}

/**
 * Returns the agents whose runner credentials the deletion revoked; the caller
 * broadcasts the revocation per agent after its transaction commits so open
 * streams close.
 */
export async function deleteMachine(
  machineId: string,
  options: { executor?: DatabaseExecutor } = {},
): Promise<{ revokedCredentialAgentIds: string[] }> {
  const db = options.executor ?? getDb();
  let revokedCredentialAgentIds: string[] = [];

  await db.transaction(async (tx) => {
    // Serialize deletion with migration creation. Migration creation takes the
    // same machine row lock before persisting its historical machine IDs.
    const [machine] = await tx
      .select({ id: machines.id })
      .from(machines)
      .where(eq(machines.id, machineId))
      .for("update")
      .limit(1);
    if (!machine) return;

    // Block deletion if any active agents are still assigned to this machine.
    const assignedAgents = await tx
      .select({ id: agents.id })
      .from(agents)
      .where(and(eq(agents.machineId, machineId), isNull(agents.deletedAt)))
      .limit(1);
    if (assignedAgents.length > 0) {
      throw new MachineDeleteConflictError(
        "MACHINE_HAS_ASSIGNED_AGENTS",
        "Cannot delete computer while it has agents assigned. Remove or migrate all agents first.",
      );
    }

    const [activeMigration] = await tx
      .select({ id: agentMigrations.id })
      .from(agentMigrations)
      .where(and(
        or(
          eq(agentMigrations.sourceMachineId, machineId),
          eq(agentMigrations.targetMachineId, machineId),
        ),
        inArray(agentMigrations.state, ["provisioning", "prep", "ready", "in_transit", "arriving", "starting"]),
      ))
      .limit(1);
    if (activeMigration) {
      throw new MachineDeleteConflictError(
        "MACHINE_HAS_ACTIVE_MIGRATION",
        "Cannot delete computer while an agent migration is in progress. Wait for it to finish or abort it first.",
      );
    }

    const referencesMachine = or(
      eq(agentRuntimeProfiles.machineId, machineId),
      eq(agentRuntimeProfiles.baselineMachineId, machineId),
      eq(agentRuntimeProfiles.pendingBeforeMachineId, machineId),
      eq(agentRuntimeProfiles.pendingAfterMachineId, machineId),
    );

    const deletedAgentProfileRefs = await tx
      .select({ agentId: agentRuntimeProfiles.agentId })
      .from(agentRuntimeProfiles)
      .innerJoin(agents, eq(agentRuntimeProfiles.agentId, agents.id))
      .where(and(referencesMachine, isNotNull(agents.deletedAt)));

    if (deletedAgentProfileRefs.length > 0) {
      await tx
        .delete(agentRuntimeProfiles)
        .where(inArray(agentRuntimeProfiles.agentId, deletedAgentProfileRefs.map((row) => row.agentId)));
    }

    // A completed Computer migration can leave one of two source-machine
    // references behind even though `agents.machineId` already points at the
    // target:
    //
    // 1. A legacy completed move left a stable profile as the last observation
    //    from the source, with no pending state to preserve.
    // 2. The target reported a daemon release notice, whose pending-before
    //    snapshot still names the source Computer.
    //
    // Both references are stale with respect to the completed migration. Do
    // not make a human start/ack every migrated Agent merely to delete the old
    // Computer. The first shape is a rebuildable cache row only when it is
    // stable; a pending release notice or migration is durable user-visible
    // state and must continue to block. The second shape is only a historical
    // machine pointer inside an otherwise-live notice. Keep every other
    // runtime-profile reference fail-closed.
    const completedMoves = await tx
      .select({
        agentId: agentMigrations.agentId,
        targetMachineId: agentMigrations.targetMachineId,
      })
      .from(agentMigrations)
      .where(and(
        eq(agentMigrations.sourceMachineId, machineId),
        eq(agentMigrations.state, "completed"),
      ));
    const completedMoveTargetsByAgent = new Map<string, Set<string>>();
    for (const row of completedMoves) {
      // A move to hosted leaves the agent on no machine; nothing to match.
      if (!row.targetMachineId) continue;
      const targets = completedMoveTargetsByAgent.get(row.agentId) ?? new Set<string>();
      targets.add(row.targetMachineId);
      completedMoveTargetsByAgent.set(row.agentId, targets);
    }

    if (completedMoveTargetsByAgent.size > 0) {
      const activeProfileRows = await tx
        .select({
          agentId: agentRuntimeProfiles.agentId,
          assignedMachineId: agents.machineId,
          profileMachineId: agentRuntimeProfiles.machineId,
          baselineMachineId: agentRuntimeProfiles.baselineMachineId,
          pendingBeforeMachineId: agentRuntimeProfiles.pendingBeforeMachineId,
          pendingAfterMachineId: agentRuntimeProfiles.pendingAfterMachineId,
          migrationStatus: agentRuntimeProfiles.migrationStatus,
          pendingKind: agentRuntimeProfiles.pendingKind,
        })
        .from(agentRuntimeProfiles)
        .innerJoin(agents, eq(agentRuntimeProfiles.agentId, agents.id))
        .where(and(referencesMachine, isNull(agents.deletedAt)));

      const staleProfileAgentIds: string[] = [];
      const historicalPendingBeforeAgentIds: string[] = [];
      for (const row of activeProfileRows) {
        if (
          !row.assignedMachineId
          || row.assignedMachineId === machineId
          || !completedMoveTargetsByAgent.get(row.agentId)?.has(row.assignedMachineId)
        ) continue;

        if (row.profileMachineId === machineId) {
          if (row.migrationStatus === "stable" && row.pendingKind === null) {
            staleProfileAgentIds.push(row.agentId);
          }
          continue;
        }

        if (
          row.pendingBeforeMachineId === machineId
          && row.baselineMachineId !== machineId
          && row.pendingAfterMachineId !== machineId
        ) {
          historicalPendingBeforeAgentIds.push(row.agentId);
        }
      }

      if (staleProfileAgentIds.length > 0) {
        await tx
          .delete(agentRuntimeProfiles)
          .where(inArray(agentRuntimeProfiles.agentId, staleProfileAgentIds));
      }
      if (historicalPendingBeforeAgentIds.length > 0) {
        await tx
          .update(agentRuntimeProfiles)
          .set({ pendingBeforeMachineId: null })
          .where(and(
            inArray(agentRuntimeProfiles.agentId, historicalPendingBeforeAgentIds),
            eq(agentRuntimeProfiles.pendingBeforeMachineId, machineId),
          ));
      }
    }

    const activeProfileRefs = await tx
      .select({ agentId: agentRuntimeProfiles.agentId })
      .from(agentRuntimeProfiles)
      .innerJoin(agents, eq(agentRuntimeProfiles.agentId, agents.id))
      .where(and(referencesMachine, isNull(agents.deletedAt)))
      .limit(1);
    if (activeProfileRefs.length > 0) {
      throw new MachineDeleteConflictError(
        "MACHINE_HAS_ACTIVE_RUNTIME_PROFILE",
        "Cannot delete computer while runtime profiles still reference active agents. Remove or migrate related agents first.",
      );
    }

    // Revoke before ON DELETE SET NULL loses the Computer's machine identity.
    // Keep the receipt in the same transaction as the deletion.
    await tx.update(computers).set({ revokedAt: currentDate(), revokedReason: "machine_deleted" })
      .where(and(eq(computers.machineId, machineId), isNull(computers.revokedAt)));
    // The same for the runner credentials this Machine minted: once
    // issued_by_machine_id is cleared nothing can tell them apart, and an
    // agent that moved to another Machine keeps authenticating with them.
    const revoked = await tx.update(agentCredentials)
      .set({ revokedAt: currentDate(), revokedReason: "machine_deleted" })
      .where(and(eq(agentCredentials.issuedByMachineId, machineId), isNull(agentCredentials.revokedAt)))
      .returning({ agentId: agentCredentials.agentId });
    revokedCredentialAgentIds = [...new Set(revoked.map((row) => row.agentId))];
    await tx.delete(machines).where(eq(machines.id, machineId));
  });

  clearAuthCache(machineId);
  return { revokedCredentialAgentIds };
}

export class MachineDeleteConflictError extends Error {
  constructor(
    readonly code:
      | "MACHINE_HAS_ASSIGNED_AGENTS"
      | "MACHINE_HAS_ACTIVE_MIGRATION"
      | "MACHINE_HAS_ACTIVE_RUNTIME_PROFILE",
    message: string,
  ) {
    super(message);
    this.name = "MachineDeleteConflictError";
  }
}

/** The last recorded Computer version of a machine (before this connection's `ready` updates it). */
export async function getRecordedMachineComputerVersion(machineId: string): Promise<string | null> {
  const [row] = await getDb()
    .select({ computerVersion: machines.computerVersion })
    .from(machines)
    .where(eq(machines.id, machineId))
    .limit(1);
  return row?.computerVersion ?? null;
}

/**
 * #proj-raft-computer task #38: the daemon found this machine's current key
 * in a legacy file an agent could read. Stored only while `keyFingerprint` is
 * still the stored key and the key has not been retired by the move to a
 * Computer credential; the first finding is kept. True when the row matched.
 */
export async function recordCredentialExposure(
  machineId: string,
  report: { foundAt: Date; keyFingerprint: string },
): Promise<boolean> {
  const db = getDb();
  const rows = await db.update(machines)
    .set({ credentialExposureFoundAt: sql`coalesce(${machines.credentialExposureFoundAt}, ${report.foundAt})` })
    .where(and(
      eq(machines.id, machineId),
      eq(machines.apiKeyFingerprint, report.keyFingerprint),
      isNull(machines.legacyKeyMigratedAt),
    ))
    .returning({ id: machines.id });
  return rows.length > 0;
}
