/**
 * Migrating an agent to Raft hosted (task #16): the state transitions after
 * the source's upload. The source side (quiesce, bundle upload, `ready`) is
 * the Computer migration's; see hostedAgentMigrationImporter for the work
 * between these steps.
 *
 *   ready --claim--> in_transit (importer lease)
 *   in_transit --file set built--> in_transit + review_ready_at
 *   in_transit + review_ready_at --user confirms--> arriving   (the switch, one txn)
 *
 * Everything before the switch is source-authoritative: a failure, a cancel or
 * the transfer deadline (an unconfirmed review included) ends the migration
 * and the agent stays on its Computer. The switch writes the agent's runtime
 * to external and records the hosted provisioning in the same transaction,
 * conditioned on the migration revision the review was shown at.
 */
import { agentConfigValues, recordAgentConfigChange } from "./agentConfigChangeEvents";
import { randomUUID } from "node:crypto";
import { and, eq, isNull, lt, or, sql } from "drizzle-orm";
import {
  EXTERNAL_AGENT_RUNTIME_ID,
  EXTERNAL_AGENT_RUNTIME_MODEL,
  RUNTIME_CONFIG_VERSION,
  currentDate,
  type AgentMigrationHostedImportSummary,
} from "@botiverse/raft-shared";
import { getDb, type DatabaseExecutor } from "../db/index";
import {
  agentMigrationHostedTargets,
  agentMigrations,
  agentRuntimeProvisions,
  agents,
  type AgentMigrationHostedRuntimeSnapshot,
} from "../db/schema";
import { lockAgentMigrationActorAuthority, type AgentMigrationRow } from "./agentMigrationService";
import { enqueueAgentMigrationFailedReceipt } from "./agentMigrationReceiptService";
import { encryptProviderSecret } from "./agentRuntimeProviderService";
import { recordAgentProvisioning } from "./agentRuntimeProvisionService";
import { revokeRunnerCredentialsOffMachine } from "./agentCredentialService";
import { recordTraceEvent } from "../tracing/semanticTrace";
import { readPositionLatestTargets, settleUnowedReadBacklog, type UnowedReadBacklogSettled } from "./unowedReadBacklog";

export const HOSTED_MIGRATION_IMPORT_SOURCE = "computer_migration";
/** How long one importer run may hold a migration before another worker may take it over. */
export const HOSTED_MIGRATION_IMPORTER_LEASE_MS = 10 * 60_000;

export type HostedTargetRow = typeof agentMigrationHostedTargets.$inferSelect;

/** AAD for the runtime snapshot's ciphertext: it decrypts only for its own migration. */
export function hostedRuntimeSnapshotScope(migrationId: string): string {
  return `agent-migration-runtime-snapshot:${migrationId}`;
}

export interface HostedImportClaim {
  migration: AgentMigrationRow;
  hosted: HostedTargetRow;
  leaseId: string;
}

/**
 * Take one hosted migration whose bundle is uploaded: a `ready` row (moved to
 * `in_transit`), or an `in_transit` row whose file set is not built yet and
 * whose importer lease lapsed (a worker died mid-build).
 */
export async function claimHostedAgentMigrationImport(input: { workerId: string; now?: Date }): Promise<HostedImportClaim | null> {
  const now = input.now ?? currentDate();
  return await getDb().transaction(async (tx) => {
    const [candidate] = await tx.select({ migration: agentMigrations, hosted: agentMigrationHostedTargets })
      .from(agentMigrations)
      .innerJoin(agentMigrationHostedTargets, eq(agentMigrationHostedTargets.migrationId, agentMigrations.id))
      .where(and(
        eq(agentMigrations.targetKind, "hosted"),
        or(
          eq(agentMigrations.state, "ready"),
          and(
            eq(agentMigrations.state, "in_transit"),
            isNull(agentMigrationHostedTargets.reviewReadyAt),
            or(
              isNull(agentMigrationHostedTargets.importerLeaseExpiresAt),
              lt(agentMigrationHostedTargets.importerLeaseExpiresAt, now),
            ),
          ),
        ),
      ))
      .orderBy(agentMigrations.readyAt)
      .limit(1)
      .for("update", { of: agentMigrations, skipLocked: true });
    if (!candidate) return null;
    if (now.getTime() > candidate.migration.transferDeadlineAt.getTime()) return null;
    let migration = candidate.migration;
    if (migration.state === "ready") {
      const [moved] = await tx.update(agentMigrations)
        .set({ state: "in_transit", revision: migration.revision + 1, updatedAt: now })
        .where(and(eq(agentMigrations.id, migration.id), eq(agentMigrations.revision, migration.revision)))
        .returning();
      if (!moved) return null;
      migration = moved;
    }
    const leaseId = `${input.workerId}:${randomUUID()}`;
    const [hosted] = await tx.update(agentMigrationHostedTargets)
      .set({
        importerLeaseId: leaseId,
        importerLeaseExpiresAt: new Date(now.getTime() + HOSTED_MIGRATION_IMPORTER_LEASE_MS),
        updatedAt: now,
      })
      .where(eq(agentMigrationHostedTargets.migrationId, migration.id))
      .returning();
    return { migration, hosted: hosted!, leaseId };
  });
}

/** Extend a running importer's lease; false when another worker took it over. */
export async function renewHostedAgentMigrationImportLease(claim: HostedImportClaim, now: Date = currentDate()): Promise<boolean> {
  const [renewed] = await getDb().update(agentMigrationHostedTargets)
    .set({ importerLeaseExpiresAt: new Date(now.getTime() + HOSTED_MIGRATION_IMPORTER_LEASE_MS), updatedAt: now })
    .where(and(
      eq(agentMigrationHostedTargets.migrationId, claim.migration.id),
      eq(agentMigrationHostedTargets.importerLeaseId, claim.leaseId),
      isNull(agentMigrationHostedTargets.reviewReadyAt),
    ))
    .returning({ migrationId: agentMigrationHostedTargets.migrationId });
  return Boolean(renewed);
}

/** The importer built and persisted the file set: show it to the user, who confirms the switch. */
export async function recordHostedAgentMigrationFileSet(input: {
  claim: HostedImportClaim;
  fileSetObjectKey: string;
  fileSetSha256: string;
  importSummary: AgentMigrationHostedImportSummary;
  now?: Date;
}): Promise<AgentMigrationRow | null> {
  const now = input.now ?? currentDate();
  return await getDb().transaction(async (tx) => {
    const [hosted] = await tx.update(agentMigrationHostedTargets)
      .set({
        fileSetObjectKey: input.fileSetObjectKey,
        fileSetSha256: input.fileSetSha256,
        importSummary: input.importSummary,
        reviewReadyAt: now,
        importerLeaseId: null,
        importerLeaseExpiresAt: null,
        updatedAt: now,
      })
      .where(and(
        eq(agentMigrationHostedTargets.migrationId, input.claim.migration.id),
        eq(agentMigrationHostedTargets.importerLeaseId, input.claim.leaseId),
        isNull(agentMigrationHostedTargets.reviewReadyAt),
      ))
      .returning({ migrationId: agentMigrationHostedTargets.migrationId });
    if (!hosted) return null;
    // Bump the revision so the status API and realtime carry the review, and
    // so a confirmation names the revision it was shown.
    const [migration] = await tx.update(agentMigrations)
      .set({ revision: sql`${agentMigrations.revision} + 1`, updatedAt: now })
      .where(and(eq(agentMigrations.id, input.claim.migration.id), eq(agentMigrations.state, "in_transit")))
      .returning();
    return migration ?? null;
  });
}

/**
 * The importer could not build a file set (download, digest, archive or
 * provider-check failure). Before the switch, so the migration fails and the
 * agent stays on its Computer.
 */
export async function failHostedAgentMigrationBeforeSwitch(input: {
  claim: HostedImportClaim;
  code: string;
  message: string;
  now?: Date;
}): Promise<AgentMigrationRow | null> {
  const now = input.now ?? currentDate();
  return await getDb().transaction(async (tx) => {
    const [updated] = await tx.update(agentMigrations)
      .set({
        state: "failed",
        failureReason: input.code,
        transportTeardownAt: now,
        transportErrorCode: input.code,
        transportErrorMessage: input.message.slice(0, 500),
        revision: sql`${agentMigrations.revision} + 1`,
        updatedAt: now,
      })
      .where(and(
        eq(agentMigrations.id, input.claim.migration.id),
        eq(agentMigrations.state, "in_transit"),
        sql`EXISTS (
          SELECT 1 FROM ${agentMigrationHostedTargets}
          WHERE ${agentMigrationHostedTargets.migrationId} = ${agentMigrations.id}
            AND ${agentMigrationHostedTargets.importerLeaseId} = ${input.claim.leaseId}
        )`,
      ))
      .returning();
    if (!updated) return null;
    await tx.update(agentMigrationHostedTargets)
      .set({ importerLeaseId: null, importerLeaseExpiresAt: null, updatedAt: now })
      .where(eq(agentMigrationHostedTargets.migrationId, updated.id));
    await enqueueAgentMigrationFailedReceipt(tx, updated, now);
    return updated;
  });
}

export class HostedMigrationConfirmError extends Error {
  constructor(
    readonly code:
      | "MIGRATION_NOT_FOUND"
      | "MIGRATION_REVISION_STALE"
      | "HOSTED_REVIEW_NOT_READY"
      | "HOSTED_TARGET_ALREADY_USED"
      | "MIGRATION_SOURCE_MACHINE_MISMATCH",
    message: string,
  ) {
    super(message);
  }
}

/**
 * The user confirmed the review: switch the agent to hosted. One transaction,
 * conditioned on the revision the review was shown at, so a cancel or a
 * deadline abort that landed first makes this a no-op error instead of a
 * half-switch:
 *
 * 1. snapshot the runtime columns (for the never-created revert only);
 * 2. agent runtime -> external, off its Computer, no session;
 * 3. mint the hosted credential and record the provisioning with the
 *    `computer_migration` import source (needs the runtime already external);
 * 4. migration `in_transit -> arriving`.
 *
 * The caller kicks the provision worker after commit.
 */
export async function confirmHostedAgentMigration(input: {
  serverId: string;
  agentId: string;
  migrationRef: string;
  expectedRevision: number;
  userId: string;
  now?: Date;
}): Promise<AgentMigrationRow> {
  const now = input.now ?? currentDate();
  const confirmed = await getDb().transaction(async (tx) => {
    await lockAgentMigrationActorAuthority(tx, input.agentId, { serverId: input.serverId, userId: input.userId, capability: "migrateAgents" });
    const [row] = await tx.select({ migration: agentMigrations, hosted: agentMigrationHostedTargets })
      .from(agentMigrations)
      .innerJoin(agentMigrationHostedTargets, eq(agentMigrationHostedTargets.migrationId, agentMigrations.id))
      .where(and(
        eq(agentMigrations.supportRef, input.migrationRef),
        eq(agentMigrations.agentId, input.agentId),
        eq(agentMigrations.serverId, input.serverId),
      ))
      .limit(1)
      .for("update", { of: agentMigrations });
    if (!row) throw new HostedMigrationConfirmError("MIGRATION_NOT_FOUND", "Migration to the cloud not found");
    const { migration, hosted } = row;
    if (migration.revision !== input.expectedRevision) {
      throw new HostedMigrationConfirmError("MIGRATION_REVISION_STALE", "The migration changed since this review was shown");
    }
    if (migration.state !== "in_transit" || !hosted.reviewReadyAt || !hosted.fileSetObjectKey) {
      throw new HostedMigrationConfirmError("HOSTED_REVIEW_NOT_READY", "The move to the cloud is not waiting for confirmation");
    }
    if (now.getTime() > migration.transferDeadlineAt.getTime()) {
      throw new HostedMigrationConfirmError("HOSTED_REVIEW_NOT_READY", "The confirmation window has closed");
    }
    const [existingProvision] = await tx.select({ agentId: agentRuntimeProvisions.agentId })
      .from(agentRuntimeProvisions)
      .where(eq(agentRuntimeProvisions.agentId, migration.agentId))
      .limit(1);
    if (existingProvision) {
      throw new HostedMigrationConfirmError("HOSTED_TARGET_ALREADY_USED", "This agent has already run in the cloud");
    }
    const [agent] = await tx.select().from(agents)
      .where(and(eq(agents.id, migration.agentId), isNull(agents.deletedAt)))
      .limit(1);
    if (!agent || agent.machineId !== migration.sourceMachineId) {
      throw new HostedMigrationConfirmError("MIGRATION_SOURCE_MACHINE_MISMATCH", "The agent is no longer on the migration's source computer");
    }

    const runtimeSnapshot: AgentMigrationHostedRuntimeSnapshot = {
      runtime: agent.runtime,
      model: agent.model,
      reasoningEffort: agent.reasoningEffort ?? null,
      envVarsPresent: Boolean(agent.envVars && Object.keys(agent.envVars).length > 0),
      machineId: migration.sourceMachineId,
      encryptedRuntime: encryptProviderSecret(
        JSON.stringify({ runtimeConfig: agent.runtimeConfig ?? null, envVars: agent.envVars ?? null }),
        hostedRuntimeSnapshotScope(migration.id),
      ),
    };
    await tx.update(agentMigrationHostedTargets)
      .set({ runtimeSnapshot, reviewConfirmedAt: now, updatedAt: now })
      .where(eq(agentMigrationHostedTargets.migrationId, migration.id));
    const [switched] = await tx.update(agents)
      .set({
        runtime: EXTERNAL_AGENT_RUNTIME_ID,
        model: EXTERNAL_AGENT_RUNTIME_MODEL,
        runtimeConfig: {
          version: RUNTIME_CONFIG_VERSION,
          runtime: EXTERNAL_AGENT_RUNTIME_ID,
          model: { kind: "preset", id: EXTERNAL_AGENT_RUNTIME_MODEL },
          mode: { kind: "default" },
          reasoningEffort: null,
          envVars: null,
        },
        reasoningEffort: null,
        envVars: null,
        machineId: null,
        sessionId: null,
        updatedAt: now,
      })
      .where(and(eq(agents.id, agent.id), eq(agents.machineId, migration.sourceMachineId), isNull(agents.deletedAt)))
      .returning({ id: agents.id, serverId: agents.serverId, name: agents.name, displayName: agents.displayName, description: agents.description, runtime: agents.runtime, model: agents.model, reasoningEffort: agents.reasoningEffort });
    if (!switched) {
      throw new HostedMigrationConfirmError("MIGRATION_SOURCE_MACHINE_MISMATCH", "The agent is no longer on the migration's source computer");
    }
    // Off its Computer: the source's runner credentials go; the cloud runtime's
    // own (issued_via 'provision', minted just below) is never one of them.
    await revokeRunnerCredentialsOffMachine(tx, { agentIds: [switched.id], machineId: null, now });
    await recordAgentConfigChange(tx, {
      serverId: switched.serverId,
      agentId: switched.id,
      source: "hosted_migration",
      actor: { kind: "user", id: input.userId },
      before: agentConfigValues(agent),
      after: agentConfigValues(switched),
      changedAt: now,
    });
    await recordAgentProvisioning(tx, {
      agent: switched,
      provider: hosted.provider,
      createdByUserId: input.userId,
      model: hosted.hostedModel,
      importSource: HOSTED_MIGRATION_IMPORT_SOURCE,
      importRef: migration.supportRef,
    });
    const [arriving] = await tx.update(agentMigrations)
      .set({
        state: "arriving",
        flippedAt: now,
        revision: migration.revision + 1,
        updatedAt: now,
      })
      .where(and(
        eq(agentMigrations.id, migration.id),
        eq(agentMigrations.revision, migration.revision),
        eq(agentMigrations.state, "in_transit"),
      ))
      .returning();
    if (!arriving) throw new HostedMigrationConfirmError("MIGRATION_REVISION_STALE", "The migration changed since this review was shown");
    const backlog = await settleMigratedAgentReadBacklog(tx, agent.id);
    return { arriving, backlog };
  });
  recordTraceEvent("server.agent_migration.hosted_read_backlog_settled", {
    agent_id: confirmed.arriving.agentId,
    server_id: confirmed.arriving.serverId,
    outcome: "ok",
    conversation_count: confirmed.backlog.conversations,
    message_count: confirmed.backlog.messages,
    kept_conversation_count: confirmed.backlog.keptConversations,
  });
  return confirmed.arriving;
}

export type MigratedReadBacklog = UnowedReadBacklogSettled;

/**
 * At the switch to the cloud every conversation the agent has a read position
 * in is settled through its latest message, except what it still owes (see
 * unowedReadBacklog.ts). A cloud agent's pull acks what it reads and its wake
 * asks it to read until nothing is left, so the backlog a Computer never
 * advanced would otherwise be replayed on arrival (#raft-antiproton:9f9d85b0).
 */
export async function settleMigratedAgentReadBacklog(executor: DatabaseExecutor, agentId: string): Promise<MigratedReadBacklog> {
  return settleUnowedReadBacklog(executor, agentId, await readPositionLatestTargets(executor, agentId));
}

/**
 * What the owner sees for a hosted migration: the review (what comes over and
 * what does not) once built, and when it was confirmed. REST only, like the
 * migration's deadlines; the realtime payload stays as it is.
 */
export async function getHostedMigrationReview(migrationId: string): Promise<{
  provider: HostedTargetRow["provider"];
  hostedModel: string | null;
  reviewReadyAt: string | null;
  reviewConfirmedAt: string | null;
  importSummary: AgentMigrationHostedImportSummary | null;
} | null> {
  const [hosted] = await getDb().select().from(agentMigrationHostedTargets)
    .where(eq(agentMigrationHostedTargets.migrationId, migrationId))
    .limit(1);
  if (!hosted) return null;
  return {
    provider: hosted.provider,
    hostedModel: hosted.hostedModel,
    reviewReadyAt: hosted.reviewReadyAt?.toISOString() ?? null,
    reviewConfirmedAt: hosted.reviewConfirmedAt?.toISOString() ?? null,
    importSummary: hosted.importSummary ?? null,
  };
}
