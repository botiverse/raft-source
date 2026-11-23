import { createHash } from "node:crypto";
import { and, asc, eq, inArray, sql } from "drizzle-orm";
import type { AgentConfig } from "@botiverse/raft-shared";
import { getDb, isDatabaseInitialized, type DatabaseExecutor } from "../db/index";
import {
  agents,
  managedMcpAssignments,
  managedMcpServers,
} from "../db/schema";

/**
 * Reconciler step 11b: `agents.config_revision`, the revision of the config
 * the server sends an agent's daemon. Every change that alters that config
 * increments it on the caller's executor, so it commits (or rolls back) with
 * the change itself; the row lock orders concurrent changes, so revisions
 * strictly increase. Returns the agents' new revisions.
 */
export async function bumpAgentConfigRevision(
  executor: DatabaseExecutor,
  agentIds: readonly string[],
): Promise<Map<string, number>> {
  if (agentIds.length === 0) return new Map();
  const rows = await executor.update(agents)
    .set({ configRevision: sql`${agents.configRevision} + 1` })
    .where(inArray(agents.id, [...agentIds]))
    .returning({ id: agents.id, configRevision: agents.configRevision });
  return new Map(rows.map((row) => [row.id, row.configRevision]));
}

/**
 * `AgentConfig.managedMcpFingerprint`: sha256 over the agent's enabled managed
 * MCP assignments (App, allowed tools, Connection choice) and each App's
 * catalog version. Opaque to the daemon, which only compares it.
 */
export async function agentManagedMcpFingerprint(
  serverId: string,
  agentId: string,
  db: DatabaseExecutor = getDb(),
): Promise<string> {
  const rows = await db.select({
    mcpServerId: managedMcpAssignments.mcpServerId,
    allowedTools: managedMcpAssignments.allowedTools,
    connectionMode: managedMcpAssignments.connectionMode,
    boundConnectionId: managedMcpAssignments.boundConnectionId,
    catalogVersion: managedMcpServers.catalogVersion,
  })
    .from(managedMcpAssignments)
    .innerJoin(managedMcpServers, eq(managedMcpServers.id, managedMcpAssignments.mcpServerId))
    .where(and(
      eq(managedMcpAssignments.serverId, serverId),
      eq(managedMcpAssignments.agentId, agentId),
      eq(managedMcpAssignments.enabled, true),
    ))
    .orderBy(asc(managedMcpAssignments.mcpServerId));
  const canonical = rows.map((row) => [
    row.mcpServerId,
    row.allowedTools === null ? null : [...row.allowedTools].sort(),
    row.connectionMode,
    row.boundConnectionId,
    row.catalogVersion,
  ]);
  return createHash("sha256").update(JSON.stringify(canonical)).digest("hex");
}

/** The field as `buildAgentConfig` adds it; nothing without a database (in-memory tests). */
export async function agentConfigRevisionInputs(
  serverId: string,
  agentId: string,
): Promise<Pick<AgentConfig, "managedMcpFingerprint">> {
  if (!isDatabaseInitialized()) return {};
  return { managedMcpFingerprint: await agentManagedMcpFingerprint(serverId, agentId) };
}
