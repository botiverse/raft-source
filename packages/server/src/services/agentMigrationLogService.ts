// The server's agent migration log (GET /api/agent-migrations/log): every move
// of a live agent, for owners and admins. Contract: @botiverse/raft-shared
// agentMigrationLog.ts.
import {
  agentMigrationLogResponseSchema,
  type AgentMigrationLogEntry,
  type AgentMigrationLogFailureKind,
  type AgentMigrationLogOutcome,
  type AgentMigrationLogResponse,
} from "@botiverse/raft-shared";
import { and, desc, eq, getTableColumns, isNull } from "drizzle-orm";
import { getDb } from "../db/index";
import { agentMigrations, agents } from "../db/schema";
import type { AgentMigrationRow } from "./agentMigrationService";
import * as agentService from "./agentService";

/** The newest this many moves are returned; older ones are cut and `truncated` is set. */
export const AGENT_MIGRATION_LOG_LIMIT = 2000;

type Initiator = AgentMigrationLogEntry["initiatedBy"];

export function agentMigrationLogOutcome(state: string): AgentMigrationLogOutcome {
  if (state === "completed") return "completed";
  if (state === "failed" || state === "aborted") return "failed";
  if (state.startsWith("canceled")) return "canceled";
  return "in_progress";
}

/**
 * Turns a failed move's raw code into a reason people can act on. `code` is
 * transportErrorCode ?? failureReason ?? abortReason; `message` is the
 * transportErrorMessage (a ZodError's message names the field that failed).
 */
export function classifyAgentMigrationFailure(
  code: string | null,
  message: string | null,
): AgentMigrationLogFailureKind {
  if (!code) return "other";
  if (code === "JS_ZodError" && message?.includes("includedBytes")) return "too_large";
  if (code.includes("TOO_LARGE") || code.includes("ENTRY_COUNT")) return "too_large";
  // Only the transport itself: an unreachable computer or supervisor (ARCHIVE_COMPUTER_UNREACHABLE,
  // *_SUPERVISOR_UNREACHABLE) is not a lost connection people can retry their way out of.
  if (code.startsWith("FETCH_") || code.includes("OBJECT_STORE_UNREACHABLE") || code === "MIGRATION_TRANSPORT_LOST") return "network";
  return "other";
}

function finiteNumberField(value: unknown, field: string): number | null {
  if (!value || typeof value !== "object") return null;
  const n = (value as Record<string, unknown>)[field];
  return typeof n === "number" && Number.isFinite(n) ? n : null;
}

export function toAgentMigrationLogEntry(row: AgentMigrationRow, initiatedBy: Initiator): AgentMigrationLogEntry {
  const outcome = agentMigrationLogOutcome(row.state);
  const failed = outcome === "failed";
  const ended = row.completedAt ?? row.abortedAt ?? row.canceledAt ?? (failed ? (row.transportLostAt ?? row.transportTeardownAt ?? row.updatedAt) : null);
  const failureCode = failed ? (row.transportErrorCode ?? row.failureReason ?? row.abortReason ?? null) : null;
  return {
    migrationRef: row.supportRef,
    agentId: row.agentId,
    sourceMachineId: row.sourceMachineId,
    sourceMachineName: row.sourceMachineNameSnapshot,
    targetKind: row.targetKind,
    targetMachineId: row.targetMachineId,
    targetMachineName: row.targetMachineNameSnapshot,
    initiatedBy,
    outcome,
    startedAt: row.createdAt.toISOString(),
    endedAt: ended ? ended.toISOString() : null,
    bytes: finiteNumberField(row.transferSummary, "includedBytes") ?? finiteNumberField(row.sourceBuildProgress, "bytes"),
    files: finiteNumberField(row.transferSummary, "includedFileCount") ?? finiteNumberField(row.sourceBuildProgress, "files"),
    failureKind: failed ? classifyAgentMigrationFailure(failureCode, row.transportErrorMessage) : null,
    failureCode,
  };
}

export async function listAgentMigrationLog(
  serverId: string,
  limit: number = AGENT_MIGRATION_LOG_LIMIT,
): Promise<AgentMigrationLogResponse> {
  const rows = await getDb()
    .select(getTableColumns(agentMigrations))
    .from(agentMigrations)
    .innerJoin(agents, eq(agents.id, agentMigrations.agentId))
    .where(and(eq(agentMigrations.serverId, serverId), isNull(agents.deletedAt)))
    .orderBy(desc(agentMigrations.createdAt), desc(agentMigrations.id))
    .limit(limit + 1);
  const truncated = rows.length > limit;
  const kept = rows.slice(0, limit).reverse();

  // One lookup per distinct initiator, not per row; null once they left the server.
  // Sequential: a server has few distinct initiators, and this keeps one pool connection.
  const initiators = new Map<string, Initiator>();
  for (const row of kept) {
    const userId = row.initiatedByUserId;
    if (!userId || initiators.has(userId)) continue;
    const creator = await agentService.getAgentCreator({ serverId, creatorType: "user", creatorId: userId });
    initiators.set(userId, creator ? { id: creator.id, name: creator.name, displayName: creator.displayName ?? null } : null);
  }

  return agentMigrationLogResponseSchema.parse({
    migrations: kept.map((row) => toAgentMigrationLogEntry(row, row.initiatedByUserId ? initiators.get(row.initiatedByUserId) ?? null : null)),
    truncated,
  });
}
