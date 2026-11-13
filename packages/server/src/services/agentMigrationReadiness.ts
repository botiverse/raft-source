import { and, desc, eq, inArray } from "drizzle-orm";
import {
  AGENT_MIGRATION_MAX_ARCHIVE_ENTRIES,
  agentMigrationWorkspaceSizeErrorCode,
  MAX_AGENT_MIGRATION_TRANSPORT_BYTES,
  type AgentMigrationReadiness,
  type AgentMigrationTransferSummary,
  type AgentMigrationWorkspaceSizeErrorCode,
} from "@botiverse/raft-shared";
import { getDb, type DatabaseExecutor } from "../db/index";
import { agentMigrations } from "../db/schema";
import { parseWirePathList, wireValue } from "./agentMigrationReceiptService";

/**
 * Rows read per agent start. Migrations of one agent run one at a time, so a
 * handful of the newest covers the last successful move and any later
 * failures; a successful move older than that is not reported.
 */
export const AGENT_MIGRATION_READINESS_ROW_LIMIT = 8;

/**
 * `starting` counts as packed: the bundle was accepted (its transfer summary is
 * final from `ready` on), and the start on the target that carries this config
 * runs while the row is still `starting`; it becomes `completed` only after
 * that start is dispatched (internalComputer.ts `/arrived`).
 */
const PACKED_STATES = ["starting", "completed"] as const;
const READINESS_STATES = [...PACKED_STATES, "failed"] as const;

export type AgentMigrationReadinessRow = {
  id: string;
  state: (typeof agentMigrations.$inferSelect)["state"];
  transferSummary: Pick<AgentMigrationTransferSummary, "includedFileCount" | "includedBytes"> | null;
  transportErrorCode: string | null;
  transportErrorMessage: string | null;
  completedAt: Date | null;
  arrivedAt: Date | null;
  transportLostAt: Date | null;
  createdAt: Date;
};

function wireCount(message: string | null, key: string): number | null {
  const raw = message ? wireValue(message, key) : null;
  if (raw === null) return null;
  const value = Number(raw);
  return Number.isSafeInteger(value) && value >= 0 ? value : null;
}

/**
 * Readiness from the agent's newest migrations, newest first (only failed and
 * packed ones matter; others are skipped). A size failure counts only when it
 * is newer than the latest packed move.
 */
export function buildAgentMigrationReadiness(rowsNewestFirst: readonly AgentMigrationReadinessRow[]): AgentMigrationReadiness {
  const readiness: AgentMigrationReadiness = {
    limits: { maxBytes: MAX_AGENT_MIGRATION_TRANSPORT_BYTES, maxEntries: AGENT_MIGRATION_MAX_ARCHIVE_ENTRIES },
  };
  let sizeFailure: { row: AgentMigrationReadinessRow; code: AgentMigrationWorkspaceSizeErrorCode } | null = null;
  let packed: AgentMigrationReadinessRow | null = null;
  for (const row of rowsNewestFirst) {
    if ((PACKED_STATES as readonly string[]).includes(row.state) && row.transferSummary) {
      packed = row;
      break;
    }
    if (row.state !== "failed" || sizeFailure) continue;
    const code = agentMigrationWorkspaceSizeErrorCode(row);
    if (code) sizeFailure = { row, code };
  }

  const packedMeasure = packed?.transferSummary
    ? { files: packed.transferSummary.includedFileCount, bytes: packed.transferSummary.includedBytes }
    : null;
  if (packed && packedMeasure) {
    readiness.lastMeasured = {
      ...packedMeasure,
      // Arrival, not completion: it is set before the start on the target
      // (which already carries this config) and never changes afterwards.
      at: (packed.arrivedAt ?? packed.completedAt ?? packed.createdAt).toISOString(),
      source: "packed",
    };
  }
  if (sizeFailure) {
    const { row, code } = sizeFailure;
    const message = row.transportErrorMessage;
    // Written once, when the row failed: every size failure comes through
    // markAgentMigrationTransportLostForComputer, which sets transportLostAt;
    // createdAt (also never rewritten) only covers a row failed some other way.
    const at = (row.transportLostAt ?? row.createdAt).toISOString();
    const entryCountFailure = code === "MIGRATION_OBJECT_STORE_ENTRY_COUNT_LIMIT_EXCEEDED";
    readiness.lastSizeFailure = {
      migrationId: row.id,
      at,
      code,
      topPaths: message ? parseWirePathList(wireValue(message, entryCountFailure ? "topPathCounts" : "topEntries")) : [],
    };
    // A failure measures one dimension: the entry count, or the bytes packed
    // before the limit stopped it (a lower bound). The other one is carried
    // over from the older packed move, or 0 when there is none.
    readiness.lastMeasured = {
      files: (entryCountFailure ? wireCount(message, "entryCount") : null) ?? packedMeasure?.files ?? 0,
      bytes: (entryCountFailure ? null : wireCount(message, "actualBytes")) ?? packedMeasure?.bytes ?? 0,
      at,
      source: "failed",
    };
  }
  return readiness;
}

/**
 * One query on idx_agent_migrations_agent (agent_id, state): the agent's few
 * newest packed or failed migrations to another Computer.
 */
export async function loadAgentMigrationReadiness(
  agentId: string,
  executor: DatabaseExecutor = getDb(),
): Promise<AgentMigrationReadiness> {
  const rows = await executor.select({
    id: agentMigrations.id,
    state: agentMigrations.state,
    transferSummary: agentMigrations.transferSummary,
    transportErrorCode: agentMigrations.transportErrorCode,
    transportErrorMessage: agentMigrations.transportErrorMessage,
    completedAt: agentMigrations.completedAt,
    arrivedAt: agentMigrations.arrivedAt,
    transportLostAt: agentMigrations.transportLostAt,
    createdAt: agentMigrations.createdAt,
  })
    .from(agentMigrations)
    .where(and(
      eq(agentMigrations.agentId, agentId),
      inArray(agentMigrations.state, [...READINESS_STATES]),
      eq(agentMigrations.targetKind, "computer"),
    ))
    .orderBy(desc(agentMigrations.createdAt))
    .limit(AGENT_MIGRATION_READINESS_ROW_LIMIT);
  return buildAgentMigrationReadiness(rows);
}
