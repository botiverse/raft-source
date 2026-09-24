import { eq, and, inArray, isNotNull, isNull, lt, or, sql, asc } from "drizzle-orm";
import { createHash, randomBytes } from "node:crypto";
import argon2 from "argon2";
import { getDb } from "../db/index.js";
import { computers, machines, servers, agents, agentMigrations, agentRuntimeProfiles } from "../db/schema.js";
import { withServerLock } from "./planService.js";
import { PLAN_CONFIG, currentDate, getEffectiveLimits, type MachineId, type ServerPlan } from "@botiverse/raft-shared";
import { untracedDbQuery, type DbQueryTracer } from "../tracing/dbQueryTrace.js";

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

export async function registerMachine(serverId: string, userId: string, name: string) {
  // Generate API key outside the lock (argon2 is slow, don't hold the lock during hashing)
  const apiKey = `sk_machine_${randomBytes(32).toString("hex")}`;
  const apiKeyHash = await argon2.hash(apiKey);
  const apiKeyPrefix = extractApiKeyPrefix(apiKey);
  const apiKeyFingerprint = extractApiKeyFingerprint(apiKey);

  // Atomic quota check + insert under advisory lock (namespace 2 = machines)
  const machine = await withServerLock(serverId, 2, async (tx) => {
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
    }).returning();

    return newMachine;
  });

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
      daemonVersion: machines.daemonVersion,
      lastHeartbeat: machines.lastHeartbeat,
      createdAt: machines.createdAt,
    }).from(machines).where(eq(machines.serverId, serverId)).orderBy(asc(machines.createdAt)),
    (rows) => ({
      row_count: rows.length,
    }),
  );
}

export async function countActiveAgentsByMachine(
  serverId: string,
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
      .where(and(eq(agents.serverId, serverId), isNull(agents.deletedAt), isNotNull(agents.machineId)))
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
) {
  const db = getDb();
  const [updated] = await db.update(machines).set(fields).where(eq(machines.id, machineId)).returning();
  return updated;
}

export async function updateMachineRuntimes(
  machineId: string,
  runtimes: string[],
  hostname?: string,
  os?: string,
  daemonVersion?: string | null,
) {
  const db = getDb();
  await db.update(machines).set({
    runtimes,
    ...(hostname !== undefined ? { hostname } : {}),
    ...(os !== undefined ? { os } : {}),
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

export async function regenerateApiKey(machineId: string) {
  const db = getDb();
  clearAuthCache(machineId);
  const apiKey = `sk_machine_${randomBytes(32).toString("hex")}`;
  const apiKeyHash = await argon2.hash(apiKey);
  const apiKeyPrefix = extractApiKeyPrefix(apiKey);
  const apiKeyFingerprint = extractApiKeyFingerprint(apiKey);
  await db.update(machines).set({ apiKeyHash, apiKeyPrefix, apiKeyFingerprint }).where(eq(machines.id, machineId));
  return apiKey;
}

/** Prefix-indexed key verification with live authorization state on every call. */
export async function findMachineByApiKey(apiKey: string) {
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
      valid = await argon2.verify(candidate.apiKeyHash, apiKey);
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

export async function deleteMachine(machineId: string) {
  const db = getDb();

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
    await tx.delete(machines).where(eq(machines.id, machineId));
  });

  clearAuthCache(machineId);
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
