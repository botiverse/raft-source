/**
 * After the switch to hosted (R5/R6, task #16): the provider creates the agent
 * and imports the reviewed file set (the provision worker), and this module
 * ends the migration from what the provision row says:
 *
 * - imported      -> `completed`, receipt, archive the Computer copy, drop the file set;
 * - never created -> revert: the agent goes back to its Computer, as before the
 *                    switch (the provider refused the POST and never had it);
 * - import failed, or no import after 20 h -> needs attention (`failure_reason`),
 *                    the row stays `arriving` so a manual retry still completes it.
 *
 * The import hook makes completion immediate; the sweep in the importer loop
 * is the backstop for a lost hook, a restart, and the cases with no hook.
 */
import { lockMachineIfTakesAgents } from "./computerAgents";
import { agentConfigValues, recordAgentConfigChange } from "./agentConfigChangeEvents";
import { and, asc, eq, gt, isNotNull, isNull, ne, or, sql } from "drizzle-orm";
import { currentDate, type RuntimeConfig, type LegacyColumnReasoningEffort } from "@botiverse/raft-shared";
import { getDb } from "../db/index";
import {
  agentCredentials,
  agentMigrationHostedTargets,
  agentMigrations,
  agentRuntimeProfiles,
  agentRuntimeProvisions,
  agents,
} from "../db/schema";
import {
  recordAgentMigrationSourceArchiveAttemptFailed,
  recordAgentMigrationSourceWorkspaceArchivedById,
  type AgentMigrationRow,
} from "./agentMigrationService";
import {
  HOSTED_MIGRATION_NOT_CREATED_REASON,
  enqueueAgentMigrationFailedReceipt,
  enqueueHostedAgentMigrationCompletedReceipt,
} from "./agentMigrationReceiptService";
import { archiveMigrationSourceWorkspace } from "./agentMigrationSourceArchive";
import type { AgentOrchestrator } from "./agentOrchestrator";
import { decryptProviderSecret } from "./agentRuntimeProviderService";
import { probeProviderAgent } from "./agentRuntimeProvisionService";
import { HOSTED_MIGRATION_IMPORT_SOURCE, hostedRuntimeSnapshotScope } from "./hostedAgentMigrationService";
import type { StorageBackend } from "./storageService";
import { hostedMigrationFileSetStorage } from "./hostedMigrationFileSet";
import { recordTraceEvent } from "../tracing/semanticTrace";

/** An `arriving` hosted row with no import this long needs a person, ahead of the provider's 24 h import window. */
export const HOSTED_MIGRATION_STALL_MS = 20 * 60 * 60 * 1000;

export const HOSTED_MIGRATION_IMPORT_FAILED_REASON = "HOSTED_IMPORT_FAILED";
export const HOSTED_MIGRATION_IMPORT_STALLED_REASON = "HOSTED_IMPORT_STALLED";
/** The provider refused the create but still answers for the agent: not safe to revert by itself. */
export const HOSTED_MIGRATION_PROVIDER_FAILED_REASON = "HOSTED_PROVIDER_FAILED";
/** The provider had the agent and deleted it: the id can never be created there again, so no automatic revert. */
export const HOSTED_MIGRATION_AGENT_DELETED_REASON = "HOSTED_AGENT_DELETED";
/** The provider found the agent under another tenant: the server or token does not match the create's. */
export const HOSTED_MIGRATION_PROVIDER_MISMATCH_REASON = "HOSTED_PROVIDER_MISMATCH";

const SWEEP_BATCH = 20;

export interface HostedMigrationCompletionDeps {
  orchestrator?: Pick<AgentOrchestrator, "archiveAgentMigrationSourceWorkspace">;
  storage?: StorageBackend | null;
  onMigrationUpdated?: (migration: AgentMigrationRow) => void | Promise<void>;
  /** Tests stub the provider GET. */
  probeProvider?: typeof probeProviderAgent;
}

function arrivingHostedFor(agentId: string) {
  return and(
    eq(agentMigrations.agentId, agentId),
    eq(agentMigrations.targetKind, "hosted"),
    eq(agentMigrations.state, "arriving"),
  );
}

/**
 * T3: the provider imported the file set. One transaction: `arriving ->
 * completed`, drop the daemon-observed runtime profile (it names the source
 * Computer; a cloud agent reports none) and queue the receipt. Null when there
 * is nothing to complete (already completed, or not imported yet).
 */
export async function completeHostedAgentMigration(input: { agentId: string; now?: Date }): Promise<AgentMigrationRow | null> {
  const now = input.now ?? currentDate();
  return await getDb().transaction(async (tx) => {
    const [row] = await tx.select({ migration: agentMigrations, hosted: agentMigrationHostedTargets, importedAt: agentRuntimeProvisions.importedAt })
      .from(agentMigrations)
      .innerJoin(agentMigrationHostedTargets, eq(agentMigrationHostedTargets.migrationId, agentMigrations.id))
      .innerJoin(agentRuntimeProvisions, eq(agentRuntimeProvisions.agentId, agentMigrations.agentId))
      .where(and(arrivingHostedFor(input.agentId), eq(agentRuntimeProvisions.importRef, agentMigrations.supportRef)))
      .limit(1)
      .for("update", { of: agentMigrations });
    if (!row?.importedAt) return null;
    const [completed] = await tx.update(agentMigrations)
      .set({
        state: "completed",
        failureReason: null,
        arrivedAt: row.migration.arrivedAt ?? row.importedAt,
        completedAt: now,
        transportTeardownAt: row.migration.transportTeardownAt ?? now,
        revision: row.migration.revision + 1,
        updatedAt: now,
      })
      .where(and(
        eq(agentMigrations.id, row.migration.id),
        eq(agentMigrations.revision, row.migration.revision),
        eq(agentMigrations.state, "arriving"),
      ))
      .returning();
    if (!completed) return null;
    // The snapshot (encrypted runtime config and env values) only serves the
    // never-created revert, which can no longer happen.
    await tx.update(agentMigrationHostedTargets)
      .set({ runtimeSnapshot: null, updatedAt: now })
      .where(eq(agentMigrationHostedTargets.migrationId, completed.id));
    await tx.delete(agentRuntimeProfiles).where(eq(agentRuntimeProfiles.agentId, completed.agentId));
    await enqueueHostedAgentMigrationCompletedReceipt(tx, completed, row.hosted.importSummary ?? null, now);
    return completed;
  });
}

/**
 * After completion, outside the transaction: archive the Computer copy (a
 * failure goes to the existing background retry) and delete the file set.
 * Never throws; a file set that could not be deleted is retried by the sweep.
 */
export async function cleanUpCompletedHostedMigration(migration: AgentMigrationRow, deps: HostedMigrationCompletionDeps = {}, now: Date = currentDate()): Promise<void> {
  if (!migration.sourceWorkspaceArchivedAt) {
    const archive = await archiveMigrationSourceWorkspace(deps.orchestrator, {
      sourceMachineId: migration.sourceMachineId,
      migrationId: migration.id,
      agentId: migration.agentId,
      migrationCreatedAt: migration.createdAt,
    });
    const updated = archive.ok
      ? await recordAgentMigrationSourceWorkspaceArchivedById({ migrationId: migration.id, now })
      : await recordAgentMigrationSourceArchiveAttemptFailed({ migrationId: migration.id, errorCode: archive.errorCode, now });
    if (updated) await deps.onMigrationUpdated?.(updated);
  }
  await deleteHostedMigrationFileSet(migration.id, deps.storage, now);
}

/** `injected`: a test's storage; otherwise the bucket the key itself names (hostedMigrationFileSetStorage). */
async function deleteHostedMigrationFileSet(migrationId: string, injected: StorageBackend | null | undefined, now: Date): Promise<void> {
  const [hosted] = await getDb().select({ key: agentMigrationHostedTargets.fileSetObjectKey })
    .from(agentMigrationHostedTargets)
    .where(eq(agentMigrationHostedTargets.migrationId, migrationId))
    .limit(1);
  if (!hosted?.key) return;
  const storage = injected === undefined ? hostedMigrationFileSetStorage(hosted.key) : injected;
  if (!storage) return;
  try {
    await storage.delete(hosted.key);
  } catch (error) {
    console.warn(`[HostedMigration] File set delete failed for ${migrationId}:`, error instanceof Error ? error.message : error);
    return;
  }
  await getDb().update(agentMigrationHostedTargets)
    .set({ fileSetObjectKey: null, updatedAt: now })
    .where(and(eq(agentMigrationHostedTargets.migrationId, migrationId), eq(agentMigrationHostedTargets.fileSetObjectKey, hosted.key)));
}

/** Mark an `arriving` hosted row as needing a person. Null when it already says so (or moved on). */
export async function markHostedAgentMigrationNeedsAttention(input: { agentId: string; reason: string; now?: Date }): Promise<AgentMigrationRow | null> {
  const now = input.now ?? currentDate();
  const [updated] = await getDb().update(agentMigrations)
    .set({ failureReason: input.reason, revision: sql`${agentMigrations.revision} + 1`, updatedAt: now })
    .where(and(
      arrivingHostedFor(input.agentId),
      or(isNull(agentMigrations.failureReason), ne(agentMigrations.failureReason, input.reason)),
    ))
    .returning();
  if (updated) {
    recordTraceEvent("server.agent_migration.hosted_needs_attention", {
      agent_id: updated.agentId,
      server_id: updated.serverId,
      outcome: "error",
      error_code: input.reason,
    });
    console.error(`[HostedMigration] needs attention migration=${updated.supportRef} agent=${updated.agentId} reason=${input.reason}`);
  }
  return updated ?? null;
}

/**
 * R6: the provider refused the create and never had the agent (the caller's
 * existence probe answered `never_existed`). One transaction puts everything back as
 * before the switch: the runtime from the snapshot on the source Computer, the
 * minted credential revoked, the provision row gone, the migration `failed`
 * with a receipt that says the agent stayed put. Its workspace is still on
 * the source (archive only follows an import), so its next message starts it
 * there.
 */
export async function revertHostedAgentMigration(input: { agentId: string; now?: Date }): Promise<AgentMigrationRow | null> {
  const now = input.now ?? currentDate();
  return await getDb().transaction(async (tx) => {
    const [row] = await tx.select({ migration: agentMigrations, hosted: agentMigrationHostedTargets, provision: agentRuntimeProvisions })
      .from(agentMigrations)
      .innerJoin(agentMigrationHostedTargets, eq(agentMigrationHostedTargets.migrationId, agentMigrations.id))
      .innerJoin(agentRuntimeProvisions, eq(agentRuntimeProvisions.agentId, agentMigrations.agentId))
      .where(and(arrivingHostedFor(input.agentId), eq(agentRuntimeProvisions.importRef, agentMigrations.supportRef)))
      .limit(1)
      .for("update");
    if (!row || row.provision.state !== "failed" || row.provision.providerAgentId || !row.hosted.runtimeSnapshot) return null;
    const snapshot = row.hosted.runtimeSnapshot;
    const secret = JSON.parse(decryptProviderSecret(snapshot.encryptedRuntime, hostedRuntimeSnapshotScope(row.migration.id))) as {
      runtimeConfig: RuntimeConfig | null;
      envVars: Record<string, string> | null;
    };
    const [before] = await tx.select({ serverId: agents.serverId, runtime: agents.runtime, model: agents.model, reasoningEffort: agents.reasoningEffort })
      .from(agents).where(eq(agents.id, row.migration.agentId)).limit(1).for("update");
    // Back onto the source Computer only while it still takes agents: one whose
    // key was revoked (or that was removed) since leaves the agent unbound and
    // stopped, for its owner to move (computerAgents.ts).
    const backOnSource = snapshot.machineId !== null && await lockMachineIfTakesAgents(tx, snapshot.machineId);
    const [restored] = await tx.update(agents)
      .set({
        runtime: snapshot.runtime,
        model: snapshot.model,
        runtimeConfig: secret.runtimeConfig,
        // The snapshot copied this legacy column, so it holds a legacy value.
        reasoningEffort: snapshot.reasoningEffort as LegacyColumnReasoningEffort | null,
        envVars: secret.envVars,
        machineId: backOnSource ? snapshot.machineId : null,
        ...(backOnSource ? { machineReleaseReason: null, machineReleasedAt: null } : {}),
        ...(backOnSource ? {} : { status: "stopped" as const }),
        sessionId: null,
        updatedAt: now,
      })
      .where(and(eq(agents.id, row.migration.agentId), isNull(agents.machineId), isNull(agents.deletedAt)))
      .returning({ id: agents.id, runtime: agents.runtime, model: agents.model, reasoningEffort: agents.reasoningEffort });
    if (!restored) return null;
    if (before) {
      await recordAgentConfigChange(tx, {
        serverId: before.serverId,
        agentId: restored.id,
        source: "hosted_migration_revert",
        actor: { kind: "system" },
        before: agentConfigValues(before),
        after: agentConfigValues(restored),
        changedAt: now,
      });
    }
    await tx.update(agentCredentials)
      .set({ revokedAt: now, revokedReason: "agent_migration_reverted" })
      .where(and(eq(agentCredentials.agentId, row.migration.agentId), isNull(agentCredentials.revokedAt)));
    await tx.delete(agentRuntimeProvisions).where(eq(agentRuntimeProvisions.agentId, row.migration.agentId));
    const [failed] = await tx.update(agentMigrations)
      .set({
        state: "failed",
        failureReason: HOSTED_MIGRATION_NOT_CREATED_REASON,
        transportTeardownAt: row.migration.transportTeardownAt ?? now,
        transportErrorCode: row.provision.lastErrorCode,
        transportErrorMessage: row.provision.lastErrorMessage?.slice(0, 500) ?? null,
        revision: row.migration.revision + 1,
        updatedAt: now,
      })
      .where(and(eq(agentMigrations.id, row.migration.id), eq(agentMigrations.revision, row.migration.revision)))
      .returning();
    if (!failed) throw new Error("MIGRATION_CONCURRENT_UPDATE");
    await enqueueAgentMigrationFailedReceipt(tx, failed, now);
    return failed;
  });
}

/** The import hook: complete as soon as the provider confirmed the import. */
export async function onHostedMigrationImported(agentId: string, deps: HostedMigrationCompletionDeps = {}, now: Date = currentDate()): Promise<AgentMigrationRow | null> {
  const completed = await completeHostedAgentMigration({ agentId, now });
  if (!completed) return null;
  await deps.onMigrationUpdated?.(completed);
  await cleanUpCompletedHostedMigration(completed, deps, now);
  return completed;
}

/**
 * One pass over `arriving` hosted rows (plus completed rows whose file set is
 * still stored). Returns how many rows it changed.
 */
export async function sweepHostedAgentMigrations(deps: HostedMigrationCompletionDeps & { now?: Date } = {}): Promise<number> {
  const now = deps.now ?? currentDate();
  const probe = deps.probeProvider ?? probeProviderAgent;
  let changed = 0;
  // Every row with something left to decide, page by page: a fixed batch by
  // age would be filled for good by rows that are waiting on a person (or on
  // a provider that does not answer), and newer rows would never be swept.
  let after: string | null = null;
  for (;;) {
    const rows = await getDb().select({ migration: agentMigrations, provision: agentRuntimeProvisions })
      .from(agentMigrations)
      .leftJoin(agentRuntimeProvisions, and(
        eq(agentRuntimeProvisions.agentId, agentMigrations.agentId),
        eq(agentRuntimeProvisions.importRef, agentMigrations.supportRef),
        eq(agentRuntimeProvisions.importSource, HOSTED_MIGRATION_IMPORT_SOURCE),
      ))
      .where(and(
        eq(agentMigrations.targetKind, "hosted"),
        eq(agentMigrations.state, "arriving"),
        // Marked rows are done until an import lands (a manual retry), or a
        // failed import replaces a stall.
        or(
          isNull(agentMigrations.failureReason),
          isNotNull(agentRuntimeProvisions.importedAt),
          and(isNotNull(agentRuntimeProvisions.importFailedAt), ne(agentMigrations.failureReason, HOSTED_MIGRATION_IMPORT_FAILED_REASON)),
        ),
        after ? gt(agentMigrations.id, after) : undefined,
      ))
      .orderBy(asc(agentMigrations.id))
      .limit(SWEEP_BATCH);
    if (rows.length === 0) break;
    after = rows[rows.length - 1]!.migration.id;
    changed += await sweepHostedArrivals(rows, deps, probe, now);
    if (rows.length < SWEEP_BATCH) break;
  }
  // A file set whose delete failed at completion.
  const leftovers = await getDb().select({ id: agentMigrations.id })
    .from(agentMigrations)
    .innerJoin(agentMigrationHostedTargets, eq(agentMigrationHostedTargets.migrationId, agentMigrations.id))
    .where(and(eq(agentMigrations.state, "completed"), isNotNull(agentMigrationHostedTargets.fileSetObjectKey)))
    .limit(SWEEP_BATCH);
  for (const { id } of leftovers) await deleteHostedMigrationFileSet(id, deps.storage, now);
  return changed;
}

function stalled(migration: AgentMigrationRow, now: Date): boolean {
  return Boolean(migration.flippedAt) && now.getTime() - migration.flippedAt!.getTime() > HOSTED_MIGRATION_STALL_MS;
}

async function sweepHostedArrivals(
  rows: Array<{ migration: AgentMigrationRow; provision: typeof agentRuntimeProvisions.$inferSelect | null }>,
  deps: HostedMigrationCompletionDeps,
  probe: typeof probeProviderAgent,
  now: Date,
): Promise<number> {
  let changed = 0;
  for (const { migration, provision } of rows) {
    let updated: AgentMigrationRow | null = null;
    try {
      if (provision?.importedAt) {
        updated = await onHostedMigrationImported(migration.agentId, deps, now);
      } else if (provision?.state === "failed" && !provision.providerAgentId) {
        // Only a provider that never had the agent makes the revert safe.
        const existence = await probe(migration.agentId);
        const attention = {
          exists: HOSTED_MIGRATION_PROVIDER_FAILED_REASON,
          deleted: HOSTED_MIGRATION_AGENT_DELETED_REASON,
          elsewhere: HOSTED_MIGRATION_PROVIDER_MISMATCH_REASON,
        } as const;
        if (existence === "never_existed") updated = await revertHostedAgentMigration({ agentId: migration.agentId, now });
        else if (existence !== "unknown") updated = await markHostedAgentMigrationNeedsAttention({ agentId: migration.agentId, reason: attention[existence], now });
        // unknown: ask again next pass, but a provider that never answers
        // (or a server without the probe) must still reach a person.
        else if (stalled(migration, now)) updated = await markHostedAgentMigrationNeedsAttention({ agentId: migration.agentId, reason: HOSTED_MIGRATION_IMPORT_STALLED_REASON, now });
      } else if (provision?.importFailedAt) {
        updated = await markHostedAgentMigrationNeedsAttention({ agentId: migration.agentId, reason: HOSTED_MIGRATION_IMPORT_FAILED_REASON, now });
      } else if (stalled(migration, now)) {
        updated = await markHostedAgentMigrationNeedsAttention({ agentId: migration.agentId, reason: HOSTED_MIGRATION_IMPORT_STALLED_REASON, now });
      }
    } catch (error) {
      console.error(`[HostedMigration] Sweep failed for ${migration.supportRef}:`, error instanceof Error ? error.message : error);
    }
    if (updated) {
      changed += 1;
      // onHostedMigrationImported already reported its own updates.
      if (updated.state !== "completed") await deps.onMigrationUpdated?.(updated);
    }
  }
  return changed;
}
