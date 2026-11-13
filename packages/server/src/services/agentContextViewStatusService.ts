import { and, eq, isNull, sql } from "drizzle-orm";
import {
  AGENT_CONTEXT_VIEW_DEFAULT_RETENTION_DAYS,
  DAEMON_CAPABILITY_AGENT_CONTEXT_VIEW_V0,
  agentContextViewRuntimeCapabilities,
  type AgentContextViewStatus,
  type AgentContextViewStatusDetails,
  type AgentContextViewStatusReason,
} from "@botiverse/raft-shared";
import { getDb } from "../db/index";
import { machines, serverMembers, users } from "../db/schema";
import type { AgentOrchestrator } from "./agentOrchestrator";

type ContextViewStatusOrchestrator = Pick<
  AgentOrchestrator,
  "getMachineStatus" | "machineAdvertisesCapability" | "getAgentContextViewAvailability"
>;

/**
 * The agent's Computer and its owner, the owner only while a current member
 * of the agent's Server and not retired (the same rule as
 * findAgentsBoundToMachines). Also what a context view failure names.
 */
export async function loadAgentComputer(machineId: string, serverId: string) {
  const [row] = await getDb()
    .select({
      id: machines.id,
      name: machines.name,
      ownerId: users.id,
      ownerName: sql<string | null>`coalesce(${users.displayName}, ${users.name})`,
    })
    .from(machines)
    .leftJoin(users, and(
      eq(users.id, machines.userId),
      isNull(users.retiredAt),
      sql`exists (select 1 from ${serverMembers} where ${serverMembers.serverId} = ${serverId} and ${serverMembers.userId} = ${users.id})`,
    ))
    .where(eq(machines.id, machineId))
    .limit(1);
  if (!row) return null;
  return {
    computer: { id: row.id, name: row.name },
    computerOwner: row.ownerId ? { id: row.ownerId, name: row.ownerName ?? "" } : null,
  };
}

/**
 * Whether a context view can be opened for the agent now (GET
 * /api/agents/:id/context-view/status). The caller has already checked the
 * flag and the caller's access. The availability report counts only when it
 * came from the agent's current Computer.
 */
export async function resolveAgentContextViewStatus(
  agent: { id: string; serverId: string; runtime: string; machineId: string | null },
  orchestrator: ContextViewStatusOrchestrator,
): Promise<AgentContextViewStatus> {
  const found = agent.machineId ? await loadAgentComputer(agent.machineId, agent.serverId) : null;
  const base: AgentContextViewStatusDetails = {
    runtime: agent.runtime,
    computer: found?.computer ?? null,
    computerOwner: found?.computerOwner ?? null,
    retainedSince: null,
    retentionDays: AGENT_CONTEXT_VIEW_DEFAULT_RETENTION_DAYS,
  };
  const unavailable = (reason: AgentContextViewStatusReason, fields = base): AgentContextViewStatus =>
    ({ state: "unavailable", reason, ...fields });
  const machineId = agent.machineId;
  if (!machineId) return unavailable("no_computer");
  if (!found) return unavailable("offline");
  if (await orchestrator.getMachineStatus(machineId) !== "online") return unavailable("offline");
  if (!await orchestrator.machineAdvertisesCapability(machineId, DAEMON_CAPABILITY_AGENT_CONTEXT_VIEW_V0)) {
    return unavailable("old_daemon");
  }
  for (const capability of agentContextViewRuntimeCapabilities(agent.runtime)) {
    if (!await orchestrator.machineAdvertisesCapability(machineId, capability)) return unavailable("old_daemon");
  }
  const record = await orchestrator.getAgentContextViewAvailability(agent.id);
  if (!record || record.machineId !== machineId) return unavailable("no_session");
  const { report } = record;
  const reported: typeof base = {
    ...base,
    runtime: report.runtime,
    retainedSince: report.retainedSince,
    retentionDays: report.retentionDays ?? AGENT_CONTEXT_VIEW_DEFAULT_RETENTION_DAYS,
  };
  if (!report.supported) return unavailable(report.unsupportedReason ?? "unsupported_runtime", reported);
  return { state: "available", ...reported };
}
