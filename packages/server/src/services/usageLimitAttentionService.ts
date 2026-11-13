import {
  SERVER_SYSTEM_ATTENTION_CONTRACT_VERSION,
  type RuntimeAccountUsageProvider,
  type RuntimeAccountUsageSnapshot,
  type ServerSystemAttentionResponse,
} from "@botiverse/raft-shared";
import { and, desc, eq, gte, inArray, isNotNull, isNull, or, sql, type SQL } from "drizzle-orm";

import { getDb, type DatabaseExecutor } from "../db/index";
import { agentFindableBy } from "./agentMemberListPolicy";
import {
  agents,
  machines,
  serverMembers,
  systemAttentionIncidents,
  systemAttentionReceipts,
} from "../db/schema";

/**
 * An active incident is resolved only by a later snapshot from the same Computer, so
 * one that stops reporting (offline, account changed, Agents moved) would stay active
 * forever. Receivers treat such an incident as stale and stop seeing it; a later
 * `limit_reached` snapshot refreshes the row (update_active) and makes it live again.
 */
// Past its window reset by this much without a fresh limit_reached snapshot: the limit has almost surely reset.
export const USAGE_LIMIT_STALE_AFTER_RESET_MS = 60 * 60 * 1000;
// No reset time known and no limit_reached snapshot for this long: nothing is still confirming the limit.
export const USAGE_LIMIT_STALE_WITHOUT_RESET_MS = 24 * 60 * 60 * 1000;

/** Whether an active incident is stale at `now`: the in-memory twin of `liveIncidentWhere`. */
export function isUsageLimitIncidentStale(
  incident: { resetsAt: Date | null; lastObservedAt: Date },
  now: Date,
): boolean {
  return incident.resetsAt
    ? incident.resetsAt.getTime() < now.getTime() - USAGE_LIMIT_STALE_AFTER_RESET_MS
    : incident.lastObservedAt.getTime() < now.getTime() - USAGE_LIMIT_STALE_WITHOUT_RESET_MS;
}

/** The rows of an active incident a receiver may still see at `now` (see the thresholds above). */
function liveIncidentWhere(now: Date): SQL {
  return or(
    and(
      isNotNull(systemAttentionIncidents.resetsAt),
      gte(systemAttentionIncidents.resetsAt, new Date(now.getTime() - USAGE_LIMIT_STALE_AFTER_RESET_MS)),
    ),
    and(
      isNull(systemAttentionIncidents.resetsAt),
      gte(systemAttentionIncidents.lastObservedAt, new Date(now.getTime() - USAGE_LIMIT_STALE_WITHOUT_RESET_MS)),
    ),
  )!;
}

export function runtimeProviderForAgentRuntime(runtime: string): RuntimeAccountUsageProvider | null {
  if (runtime === "kimi-sdk") return "kimi";
  return runtime === "claude" || runtime === "codex" || runtime === "kimi" || runtime === "grok" || runtime === "antigravity"
    ? runtime
    : null;
}

export type UsageLimitTransition =
  | { action: "ignore" }
  | { action: "activate"; generation: number }
  | { action: "update_active" }
  // The active incident went stale (hidden from receivers) and the limit is hit again: resolve
  // it and activate a new generation, so earlier seen/dismiss receipts do not hide the new one.
  | { action: "reactivate"; generation: number }
  | { action: "resolve" };

export function planUsageLimitTransition(input: {
  latest: {
    state: "active" | "resolved";
    activationGeneration: number;
    lastObservedAt: Date;
    resetsAt: Date | null;
  } | null;
  observedAt: Date;
  windowStatus: "ok" | "limit_reached" | "parse_unavailable";
  /** Server time, the same clock receivers' reads judge staleness by. */
  now: Date;
}): UsageLimitTransition {
  if (input.windowStatus === "parse_unavailable") return { action: "ignore" };
  if (input.latest && input.observedAt.getTime() <= input.latest.lastObservedAt.getTime()) {
    return { action: "ignore" };
  }
  if (input.windowStatus === "limit_reached") {
    const generation = (input.latest?.activationGeneration ?? 0) + 1;
    if (input.latest?.state !== "active") return { action: "activate", generation };
    return isUsageLimitIncidentStale(input.latest, input.now)
      ? { action: "reactivate", generation }
      : { action: "update_active" };
  }
  return input.latest?.state === "active" ? { action: "resolve" } : { action: "ignore" };
}

function identityLockKey(input: {
  serverId: string;
  machineId: string;
  provider: RuntimeAccountUsageProvider;
  accountKeyHash: string;
  windowKey: string;
}): string {
  return [
    "usage-limit-attention-v1",
    input.serverId,
    input.machineId,
    input.provider,
    input.accountKeyHash,
    input.windowKey,
  ].join(":");
}

export class UsageLimitAttentionService {
  constructor(private readonly now: () => Date = () => new Date()) {}

  async ingest(
    machineId: string,
    snapshot: RuntimeAccountUsageSnapshot,
    executor: DatabaseExecutor = getDb(),
  ): Promise<void> {
    const [machine] = await executor
      .select({ serverId: machines.serverId })
      .from(machines)
      .where(eq(machines.id, machineId));
    if (!machine) return;

    const machineAgents = await executor
      .select({ id: agents.id, runtime: agents.runtime })
      .from(agents)
      .where(and(eq(agents.serverId, machine.serverId), eq(agents.machineId, machineId), isNull(agents.deletedAt)));
    const affectedAgentIds = machineAgents
      .filter((agent) => runtimeProviderForAgentRuntime(agent.runtime) === snapshot.provider)
      .map((agent) => agent.id)
      .sort();

    const observedAt = new Date(snapshot.collectedAt);
    for (const account of snapshot.accounts) {
      for (const window of account.windows) {
        if (window.status === "parse_unavailable") continue;
        // A group of models' quota (Antigravity's "Gemini Models"): while the
        // account is not rate limited it still runs the other groups' models,
        // so one group used up is not "<provider> used up" for every agent on
        // it. Once OAR says it is (every group used up, no credits left), the
        // groups' windows say so and when they reset.
        if (window.scope?.kind === "models" && account.health !== "rate_limited") continue;
        if (window.status === "limit_reached" && affectedAgentIds.length === 0) continue;
        await executor.transaction(async (tx) => {
          const identity = {
            serverId: machine.serverId,
            machineId,
            provider: snapshot.provider,
            accountKeyHash: account.accountKey,
            windowKey: window.id,
          };
          await tx.execute(sql`SELECT pg_advisory_xact_lock(hashtextextended(${identityLockKey(identity)}, 0))`);
          const [latest] = await tx
            .select()
            .from(systemAttentionIncidents)
            .where(and(
              eq(systemAttentionIncidents.serverId, identity.serverId),
              eq(systemAttentionIncidents.machineId, identity.machineId),
              eq(systemAttentionIncidents.kind, "usage_limit_reached"),
              eq(systemAttentionIncidents.provider, identity.provider),
              eq(systemAttentionIncidents.accountKeyHash, identity.accountKeyHash),
              eq(systemAttentionIncidents.windowKey, identity.windowKey),
            ))
            .orderBy(desc(systemAttentionIncidents.activationGeneration))
            .limit(1);

          const transition = planUsageLimitTransition({
            latest: latest ?? null,
            observedAt,
            windowStatus: window.status,
            now: this.now(),
          });
          if (transition.action === "ignore") return;

          if (transition.action === "reactivate") {
            // resolvedAt = its last observation: the last time the limit was confirmed. The
            // recovery itself was never observed, so no later time is claimed (and it precedes
            // the new incident's activatedAt). Resolved first: one active row per identity.
            await tx.update(systemAttentionIncidents).set({
              state: "resolved",
              resolvedAt: latest.lastObservedAt,
              updatedAt: new Date(),
            }).where(eq(systemAttentionIncidents.id, latest.id));
          }

          if (transition.action === "update_active" || transition.action === "activate" || transition.action === "reactivate") {
            const resetsAt = window.resetsAt ? new Date(window.resetsAt) : null;
            if (transition.action === "update_active") {
              await tx.update(systemAttentionIncidents).set({
                affectedAgentIds,
                lastObservedAt: observedAt,
                resetsAt,
                updatedAt: new Date(),
              }).where(eq(systemAttentionIncidents.id, latest.id));
              return;
            }
            await tx.insert(systemAttentionIncidents).values({
              ...identity,
              kind: "usage_limit_reached",
              activationGeneration: transition.generation,
              affectedAgentIds,
              activatedAt: observedAt,
              lastObservedAt: observedAt,
              resetsAt,
            });
            return;
          }

          if (transition.action === "resolve" && latest?.state === "active") {
            await tx.update(systemAttentionIncidents).set({
              state: "resolved",
              resolvedAt: observedAt,
              lastObservedAt: observedAt,
              updatedAt: new Date(),
            }).where(eq(systemAttentionIncidents.id, latest.id));
          }
        });
      }
    }
  }

  async listForReceiver(
    serverId: string,
    userId: string,
    executor: DatabaseExecutor = getDb(),
  ): Promise<ServerSystemAttentionResponse> {
    const generatedAt = this.now();
    const [membership] = await executor
      .select({ role: serverMembers.role })
      .from(serverMembers)
      .where(and(eq(serverMembers.serverId, serverId), eq(serverMembers.userId, userId)));
    if (membership?.role !== "owner" && membership?.role !== "admin") {
      return this.emptyResponse(generatedAt);
    }

    const rows = await executor
      .select({
        incident: systemAttentionIncidents,
        machineName: machines.name,
        seenAt: systemAttentionReceipts.seenAt,
        dismissedAt: systemAttentionReceipts.dismissedAt,
      })
      .from(systemAttentionIncidents)
      .innerJoin(machines, eq(machines.id, systemAttentionIncidents.machineId))
      .leftJoin(systemAttentionReceipts, and(
        eq(systemAttentionReceipts.incidentId, systemAttentionIncidents.id),
        eq(systemAttentionReceipts.userId, userId),
      ))
      .where(and(
        eq(systemAttentionIncidents.serverId, serverId),
        eq(systemAttentionIncidents.state, "active"),
        liveIncidentWhere(generatedAt),
        isNull(systemAttentionReceipts.dismissedAt),
      ))
      .orderBy(desc(systemAttentionIncidents.activatedAt));

    // Every owner and admin reads these, but a personal assistant is found only
    // by its owner (agentFindableBy): the stored ids keep it, the reader's list
    // does not, unless the reader is its owner.
    const affectedIds = [...new Set(rows.flatMap(({ incident }) => incident.affectedAgentIds))];
    const hidden = new Set(affectedIds.length === 0 ? [] : (await executor
      .select({ id: agents.id })
      .from(agents)
      .where(and(inArray(agents.id, affectedIds), sql`not ${agentFindableBy({ userId })}`)))
      .map((row) => row.id));

    const notifications = rows.map(({ incident, machineName, seenAt }) => ({
      id: incident.id,
      kind: "usage_limit_reached" as const,
      severity: "warning" as const,
      state: "active" as const,
      activatedAt: incident.activatedAt.toISOString(),
      lastObservedAt: incident.lastObservedAt.toISOString(),
      seenAt: seenAt?.toISOString() ?? null,
      machine: { id: incident.machineId, name: machineName },
      provider: incident.provider,
      windowKey: incident.windowKey,
      resetsAt: incident.resetsAt?.toISOString() ?? null,
      affectedAgentIds: incident.affectedAgentIds.filter((id) => !hidden.has(id)),
    }));
    return {
      contractVersion: SERVER_SYSTEM_ATTENTION_CONTRACT_VERSION,
      generatedAt: generatedAt.toISOString(),
      snapshotMode: "replace",
      unseenCount: notifications.filter((notification) => notification.seenAt === null).length,
      notifications,
    };
  }

  async markSeen(serverId: string, userId: string, incidentId: string, executor: DatabaseExecutor = getDb()): Promise<boolean> {
    return this.writeReceipt(serverId, userId, incidentId, "seen", executor);
  }

  async dismiss(serverId: string, userId: string, incidentId: string, executor: DatabaseExecutor = getDb()): Promise<boolean> {
    return this.writeReceipt(serverId, userId, incidentId, "dismiss", executor);
  }

  private async writeReceipt(
    serverId: string,
    userId: string,
    incidentId: string,
    action: "seen" | "dismiss",
    executor: DatabaseExecutor,
  ): Promise<boolean> {
    const [membership] = await executor
      .select({ role: serverMembers.role })
      .from(serverMembers)
      .where(and(eq(serverMembers.serverId, serverId), eq(serverMembers.userId, userId)));
    if (membership?.role !== "owner" && membership?.role !== "admin") return false;
    const now = this.now();
    // A stale incident is not live for receivers: like a resolved one, no receipt is written.
    const [incident] = await executor.select({ id: systemAttentionIncidents.id })
      .from(systemAttentionIncidents)
      .where(and(
        eq(systemAttentionIncidents.id, incidentId),
        eq(systemAttentionIncidents.serverId, serverId),
        eq(systemAttentionIncidents.state, "active"),
        liveIncidentWhere(now),
      ));
    if (!incident) return false;
    await executor.insert(systemAttentionReceipts).values({
      incidentId,
      userId,
      seenAt: now,
      dismissedAt: action === "dismiss" ? now : null,
      updatedAt: now,
    }).onConflictDoUpdate({
      target: [systemAttentionReceipts.incidentId, systemAttentionReceipts.userId],
      set: action === "dismiss"
        ? { seenAt: sql`COALESCE(${systemAttentionReceipts.seenAt}, ${now})`, dismissedAt: now, updatedAt: now }
        : { seenAt: sql`COALESCE(${systemAttentionReceipts.seenAt}, ${now})`, updatedAt: now },
    });
    return true;
  }

  private emptyResponse(generatedAt: Date): ServerSystemAttentionResponse {
    return {
      contractVersion: SERVER_SYSTEM_ATTENTION_CONTRACT_VERSION,
      generatedAt: generatedAt.toISOString(),
      snapshotMode: "replace",
      unseenCount: 0,
      notifications: [],
    };
  }
}

export const usageLimitAttentionService = new UsageLimitAttentionService();
