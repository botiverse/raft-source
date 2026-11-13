// An agent's own retry of its migration to another Computer after the move
// failed because the workspace was too big (POST
// /internal/agent-api/migrations/retry; shared/src/agentMigrationRetry.ts).
// Approved by Artea (product) and Tenny (CTO), #wg-agent-migration 7746de27
// msg f607ea47. One retry per failed migration, within
// AGENT_MIGRATION_AGENT_RETRY_WINDOW_MS, with everything copied from it, on
// behalf of the person who started it.
//
// This module holds the rules on the failed row; the route
// (routes/internalAgentApi.ts) checks them first without locks, and
// insertAgentMigration checks them again under the start's row locks
// (lockAndCheckAgentMigrationRetry). A refusal changes nothing, so it does
// not use up the retry.
import {
  AGENT_MIGRATION_AGENT_RETRY_WINDOW_MS,
  agentMigrationWorkspaceSizeErrorCode,
  type AgentMigrationRetryRefusalCode,
  type AgentMigrationWorkspaceSizeErrorCode,
} from "@botiverse/raft-shared";
import { and, desc, eq } from "drizzle-orm";
import type { DatabaseExecutor } from "../db/index";
import { agentMigrations } from "../db/schema";
import type { AgentMigrationRow } from "./agentMigrationService";
import { wireValue } from "./agentMigrationReceiptService";

/** A retry the rules refuse; the route answers its code. */
export class AgentMigrationRetryRefusedError extends Error {
  constructor(readonly code: AgentMigrationRetryRefusalCode) {
    super(`Agent migration retry refused: ${code}`);
    this.name = "AgentMigrationRetryRefusedError";
  }
}

type RetryRuleRow = Pick<AgentMigrationRow,
  "id" | "state" | "targetKind" | "targetMachineId" | "sourceMachineId" | "flippedAt" | "transportErrorCode"
  | "transportErrorMessage" | "transportLostAt" | "updatedAt" | "retryOfMigrationId"
>;

/** When a failed migration failed: a size failure always sets transport_lost_at; updated_at covers any other. */
export function agentMigrationFailedAt(row: Pick<AgentMigrationRow, "transportLostAt" | "updatedAt">): Date {
  return row.transportLostAt ?? row.updatedAt;
}

/**
 * Why `failed` (the agent's newest migration) cannot be retried by the agent,
 * or null. In order: it must be a size failure of a move to another Computer
 * (NO_RETRYABLE_MIGRATION), within the window (RETRY_WINDOW_EXPIRED), not
 * itself a retry and not retried yet (ALREADY_RETRIED), and the agent must
 * still be on its source (NO_RETRYABLE_MIGRATION).
 */
export function agentMigrationRetryRefusal(input: {
  failed: RetryRuleRow | null;
  agentMachineId: string | null;
  /** A migration whose retry_of_migration_id is this one exists. */
  retried: boolean;
  now: Date;
}): AgentMigrationRetryRefusalCode | null {
  const { failed } = input;
  if (
    !failed
    || failed.state !== "failed"
    || failed.targetKind !== "computer"
    || !failed.targetMachineId
    || agentMigrationWorkspaceSizeErrorCode(failed) === null
  ) {
    return "NO_RETRYABLE_MIGRATION";
  }
  if (input.now.getTime() - agentMigrationFailedAt(failed).getTime() > AGENT_MIGRATION_AGENT_RETRY_WINDOW_MS) {
    return "RETRY_WINDOW_EXPIRED";
  }
  if (failed.retryOfMigrationId !== null || input.retried) return "ALREADY_RETRIED";
  // A size failure stops before the flip; the agent must still be where it failed from.
  if (failed.flippedAt !== null || input.agentMachineId !== failed.sourceMachineId) return "NO_RETRYABLE_MIGRATION";
  return null;
}

/** The agent's newest migration by creation (later updates to older rows, such as a source archive retry, don't count). */
export async function readNewestAgentMigration(
  executor: DatabaseExecutor,
  agentId: string,
  options: { forUpdate?: boolean } = {},
): Promise<AgentMigrationRow | null> {
  const query = executor.select()
    .from(agentMigrations)
    .where(eq(agentMigrations.agentId, agentId))
    .orderBy(desc(agentMigrations.createdAt), desc(agentMigrations.id))
    .limit(1);
  const [row] = options.forUpdate ? await query.for("update") : await query;
  return row ?? null;
}

/** Whether `migrationId` already has its retry. */
export async function agentMigrationHasRetry(executor: DatabaseExecutor, migrationId: string): Promise<boolean> {
  const [retry] = await executor.select({ id: agentMigrations.id })
    .from(agentMigrations)
    .where(eq(agentMigrations.retryOfMigrationId, migrationId))
    .limit(1);
  return Boolean(retry);
}

/**
 * The retry rules again, inside the start's transaction after its locks (the
 * starter's authority on the locked agent row, then the machine rows): the
 * failed migration is still the agent's newest, still retryable, and its
 * target is the one being started. Throws AgentMigrationRetryRefusedError.
 */
export async function lockAndCheckAgentMigrationRetry(
  executor: DatabaseExecutor,
  input: { agentId: string; agentMachineId: string; retryOfMigrationId: string; targetMachineId: string | null; now: Date },
): Promise<AgentMigrationRow> {
  const newest = await readNewestAgentMigration(executor, input.agentId, { forUpdate: true });
  // A newer migration started meanwhile: it is no longer the one to retry.
  if (!newest || newest.id !== input.retryOfMigrationId) throw new AgentMigrationRetryRefusedError("NO_RETRYABLE_MIGRATION");
  if (newest.targetMachineId !== input.targetMachineId) throw new AgentMigrationRetryRefusedError("NO_RETRYABLE_MIGRATION");
  const refusal = agentMigrationRetryRefusal({
    failed: newest,
    agentMachineId: input.agentMachineId,
    retried: await agentMigrationHasRetry(executor, newest.id),
    now: input.now,
  });
  if (refusal) throw new AgentMigrationRetryRefusedError(refusal);
  return newest;
}

function pgErrorOf(err: unknown): { code?: unknown; constraint?: unknown; constraint_name?: unknown } | null {
  let current: unknown = err;
  for (let depth = 0; depth < 4 && current && typeof current === "object"; depth += 1) {
    const candidate = current as { code?: unknown; constraint?: unknown; constraint_name?: unknown; cause?: unknown };
    if (candidate.code === "23505") return candidate;
    current = candidate.cause;
  }
  return null;
}

/** A second retry of the same migration hit idx_agent_migrations_retry_of. */
export function isAgentMigrationRetryUniqueViolation(err: unknown): boolean {
  const pg = pgErrorOf(err);
  if (!pg) return false;
  const constraint = pg.constraint ?? pg.constraint_name;
  return constraint === "idx_agent_migrations_retry_of"
    || (constraint === undefined && err instanceof Error && err.message.includes("idx_agent_migrations_retry_of"));
}

/**
 * What a size failure measured: the entry count (files and folders) of an
 * entry-limit failure, or the bytes packed before a too-large one stopped (a
 * lower bound). The dimension it did not measure is null.
 */
export function agentMigrationSizeFailureMeasure(row: Pick<AgentMigrationRow, "transportErrorCode" | "transportErrorMessage">): {
  code: AgentMigrationWorkspaceSizeErrorCode;
  entries: number | null;
  bytes: number | null;
} | null {
  const code = agentMigrationWorkspaceSizeErrorCode(row);
  if (!code) return null;
  const message = row.transportErrorMessage ?? "";
  const count = (key: string) => {
    const value = Number(wireValue(message, key));
    return wireValue(message, key) !== null && Number.isSafeInteger(value) && value >= 0 ? value : null;
  };
  return code === "MIGRATION_OBJECT_STORE_ENTRY_COUNT_LIMIT_EXCEEDED"
    ? { code, entries: count("entryCount"), bytes: null }
    : { code, entries: null, bytes: count("actualBytes") };
}

/**
 * For a retry, what the failed attempt measured next to what this attempt
 * packs, so the owner's card can show how much the agent trimmed. `packed` is
 * the transfer summary once the source registered the bundle (`final`), else
 * the latest build progress, else null.
 */
export type AgentMigrationRetryComparison = {
  previousFailure: { code: AgentMigrationWorkspaceSizeErrorCode; entries: number | null; bytes: number | null; bytesIsLowerBound: boolean } | null;
  packed: { files: number; bytes: number; final: boolean } | null;
};

export function agentMigrationRetryComparison(
  retry: Pick<AgentMigrationRow, "transferSummary" | "sourceBuildProgress">,
  previous: Pick<AgentMigrationRow, "transportErrorCode" | "transportErrorMessage"> | null,
): AgentMigrationRetryComparison {
  const measure = previous ? agentMigrationSizeFailureMeasure(previous) : null;
  const progress = retry.sourceBuildProgress && "files" in retry.sourceBuildProgress && "bytes" in retry.sourceBuildProgress
    ? retry.sourceBuildProgress
    : null;
  return {
    previousFailure: measure
      ? { ...measure, bytesIsLowerBound: measure.code === "MIGRATION_OBJECT_STORE_BUNDLE_TOO_LARGE" }
      : null,
    packed: retry.transferSummary
      ? { files: retry.transferSummary.includedFileCount, bytes: retry.transferSummary.includedBytes, final: true }
      : progress
        ? { files: progress.files, bytes: progress.bytes, final: false }
        : null,
  };
}

/** The failed migration a retry repeats, for its comparison (same agent only). */
export async function readRetriedAgentMigration(
  executor: DatabaseExecutor,
  retry: Pick<AgentMigrationRow, "agentId" | "retryOfMigrationId">,
): Promise<AgentMigrationRow | null> {
  if (!retry.retryOfMigrationId) return null;
  const [row] = await executor.select()
    .from(agentMigrations)
    .where(and(eq(agentMigrations.id, retry.retryOfMigrationId), eq(agentMigrations.agentId, retry.agentId)))
    .limit(1);
  return row ?? null;
}
