// Starting a migration to another Computer: the checks and the provisioning
// that `POST /api/agents/:id/migrate` (a person, routes/agents.ts) and
// `POST /internal/agent-api/migrations/retry` (an agent retrying its
// size-failed migration once, routes/internalAgentApi.ts) share, so both
// starts check the same things in the same order and provision the same way.
// Each route answers the failures in its own words and codes.
import type { Request, Response } from "express";
import type { Server as SocketServer } from "socket.io";
import { and, eq, inArray, isNull, or } from "drizzle-orm";
import {
  AGENT_MIGRATION_CAPABILITY,
  AGENT_MIGRATION_SOURCE_DRAIN_CAPABILITY,
  hydrateRuntimeConfig,
  isExternalAgentRuntime,
  type AgentMigrationUserErrorCode,
  type RuntimeConfig,
} from "@botiverse/raft-shared";
import { getDb, type DatabaseTransaction } from "../db/index";
import { agentMigrations, agents, machines } from "../db/schema";
import * as agentMigrationService from "../services/agentMigrationService";
import type { AgentOrchestrator, MachineMigrationTransportState } from "../services/agentOrchestrator";
import { emitAgentMigrationUpdated } from "../services/agentMigrationRealtime";
import { findAccessRevokedMachineIds } from "../services/computerAgents";
import { BuiltInModelCatalogError, isBuiltInCatalogCheckedSelection } from "../services/builtinModelCatalogCompatibility";
import { MachineCatalogStaleError } from "../services/machineCatalogAuthority";
import { requireTeamBillingFeature } from "../services/planService";
import { handleMachineLocalRouting } from "../machineLocalReplay";

export const MIGRATION_MACHINE_ONLINE_MAX_AGE_MS = 2 * 60 * 1000;

export function sendBuiltInCatalogError(
  res: Response,
  error: BuiltInModelCatalogError | MachineCatalogStaleError,
): void {
  if (error instanceof MachineCatalogStaleError) {
    res
      .status(409)
      .json({ error: error.message, code: error.code, recovery: "retry" });
    return;
  }
  res.status(409).json({
    error: error.message,
    code: error.code,
    requestedModel: error.requestedModel,
    daemonVersion: error.daemonVersion,
    computerVersion: error.computerVersion,
    catalogRuntimeVersion: error.catalogRuntimeVersion,
    recovery: error.recovery,
  });
}

export function sendBuiltInCatalogUnavailable(
  res: Response,
  versions: { daemonVersion?: string | null; computerVersion?: string | null } = {},
): void {
  sendBuiltInCatalogError(
    res,
    new BuiltInModelCatalogError(
      "builtin_catalog_unavailable",
      "The target Computer's Built-in model catalog is unavailable. Retry after the Computer reconnects.",
      {
        daemonVersion: versions.daemonVersion ?? null,
        computerVersion: versions.computerVersion ?? null,
        recovery: "retry",
      },
    ),
  );
}

/**
 * Catalog-missing is a diagnostic on the write paths, not a rejection.
 *
 * Ruled by @artin (#proj-daemon task #322): a model id absent from the target Computer's catalog
 * must not, on its own, refuse a write. The catalog reports what one machine currently advertises;
 * it is not the backend's final statement of what can run. Each machine upgrades on its own
 * schedule, so rejecting on absence blocks agents one machine at a time rather than failing once,
 * loudly.
 *
 * DELIBERATELY NARROW -- only `builtin_model_unsupported_by_target` is demoted:
 *   - `builtin_catalog_unavailable` still rejects. That code means the catalog could not be read at
 *     all, i.e. UNKNOWN, not KNOWN-ABSENT. Treating unknown as permission is a separate decision
 *     and nobody has made it. (Scope confirmed by @Huaihuai before this change was written.)
 *   - every other error, and every other config/permission check on these routes, is untouched:
 *     this only removes catalog absence as a *sufficient* reason to reject.
 *
 * Returning null puts the caller on the exact path it already takes for a non-preset config, so no
 * catalog authority is leased -- there is no catalog-supported model to pin.
 */
export async function validateBuiltInPresetForWrite(
  agentOrchestrator: AgentOrchestrator,
  machineId: string,
  runtimeConfig: RuntimeConfig,
): Promise<
  Awaited<ReturnType<AgentOrchestrator["validateBuiltInPresetForMachine"]>>
> {
  try {
    return await agentOrchestrator.validateBuiltInPresetForMachine(
      machineId,
      runtimeConfig,
    );
  } catch (error) {
    if (
      error instanceof BuiltInModelCatalogError &&
      error.code === "builtin_model_unsupported_by_target"
    ) {
      console.warn(
        `[agents] Built-in catalog on machine ${machineId} does not list ${
          error.requestedModel ?? "the requested model"
        }; accepting the write (task #322). Start-time behaviour is unchanged.`,
      );
      return null;
    }
    throw error;
  }
}

export type MigrationTransferProvisioner = typeof agentMigrationService.provisionAgentMigrationObjectStoreTransfer;
export type MigrationLeaseDelivery = agentMigrationService.AgentMigrationTransportLeaseDelivery;

export class MigrationRoutePreflightError extends Error {
  constructor(
    readonly status: number,
    readonly code: "MIGRATION_TRANSPORT_NOT_PROVISIONED" | "MIGRATION_TRANSPORT_LOST" | "MIGRATION_TRANSPORT_PROVISION_FAILED",
    message: string,
  ) {
    super(message);
    this.name = "MigrationRoutePreflightError";
  }
}

export function machineSupportsRuntime(runtimes: string[] | null, runtime: string): boolean {
  return Array.isArray(runtimes) && runtimes.includes(runtime);
}

export type MigrationComputerCapabilitySide = "source" | "target";
export type MigrationComputerCapabilityReason = "runtime_unconfirmed" | "runtime_missing";

export interface MigrationComputerCapabilityFailure {
  side: MigrationComputerCapabilitySide;
  reason: MigrationComputerCapabilityReason;
  runtime: string;
}

export interface MigrationComputerCapabilityDetails {
  failures: MigrationComputerCapabilityFailure[];
}

/** task #1268: why the target cannot accept the migration right now (retryable). */
export interface MigrationTargetRuntimeDetectionDetails {
  side: "target";
  runtime: string;
  detectionStatus: "pending" | "incomplete";
  reason?: "deadline" | "child_failed" | "cancelled";
  retryable: true;
}

export type MigrationErrorDetails = (
  | MigrationResumableCapabilityDetail
  | MigrationComputerCapabilityDetails
  | MigrationTargetRuntimeDetectionDetails
);

export function computerRuntimeFailures(args: {
  /** undefined: no source Computer (an agent placed on the target without one). */
  sourceRuntimes: string[] | null | undefined;
  targetRuntimes: string[] | null;
  runtime: string;
}): MigrationComputerCapabilityFailure[] {
  const failures: MigrationComputerCapabilityFailure[] = [];
  for (const [side, runtimes] of [["source", args.sourceRuntimes], ["target", args.targetRuntimes]] as const) {
    if (runtimes === undefined) continue;
    if (!Array.isArray(runtimes)) {
      failures.push({ side, reason: "runtime_unconfirmed", runtime: args.runtime });
    } else if (!machineSupportsRuntime(runtimes, args.runtime)) {
      failures.push({ side, reason: "runtime_missing", runtime: args.runtime });
    }
  }
  return failures;
}

export function isUuid(value: string): boolean {
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value);
}

/**
 * Migration needs AGENT_MIGRATION_CAPABILITY on both computers; an older
 * daemon must be upgraded first. `side` names the computer(s) to upgrade.
 */
export interface MigrationResumableCapabilityDetail {
  side: "source" | "target" | "both";
  reason: "capability_missing";
}

export function migrationCapabilityDetail(
  source: Pick<MachineMigrationTransportState, "capabilities"> | null,
  target: Pick<MachineMigrationTransportState, "capabilities"> | null,
): MigrationResumableCapabilityDetail | null {
  const sourceMissing = !source?.capabilities?.includes(AGENT_MIGRATION_CAPABILITY);
  const targetMissing = !target?.capabilities?.includes(AGENT_MIGRATION_CAPABILITY);
  if (!sourceMissing && !targetMissing) return null;
  return { side: sourceMissing && targetMissing ? "both" : sourceMissing ? "source" : "target", reason: "capability_missing" };
}

export function getMigrationTransferProvisioner(req: { app: { get(name: string): unknown } }): MigrationTransferProvisioner {
  return (req.app.get("agentMigrationObjectStoreTransferProvisioner") as MigrationTransferProvisioner | undefined)
    ?? agentMigrationService.provisionAgentMigrationObjectStoreTransfer;
}

export function leaseStateFromDelivery(
  delivery: MigrationLeaseDelivery,
): agentMigrationService.AgentMigrationTransferLeaseState {
  const msg = delivery.message;
  return {
    provider: msg.provider,
    role: msg.role,
    transferKind: msg.transferKind,
    leaseSource: msg.leaseSource,
    migrationId: msg.migrationId,
    migrationGeneration: msg.migrationGeneration,
    sessionId: msg.sessionId,
    expiresAt: msg.expiresAt,
    maxBytes: msg.maxBytes,
  };
}

export function assertMigrationTransferLeaseReady(input: {
  migration: agentMigrationService.AgentMigrationRow;
  source: MigrationLeaseDelivery;
  target: MigrationLeaseDelivery;
  now: Date;
}): void {
  const sourceVerdict = agentMigrationService.evaluateAgentMigrationTransferLeaseReady({
    migration: input.migration,
    lease: leaseStateFromDelivery(input.source),
    role: "source",
    now: input.now,
  });
  if (!sourceVerdict.ready) {
    throw new MigrationRoutePreflightError(
      422,
      sourceVerdict.code,
      `Source migration transfer lease is not ready: ${sourceVerdict.reason}`,
    );
  }

  const targetVerdict = agentMigrationService.evaluateAgentMigrationTransferLeaseReady({
    migration: input.migration,
    lease: leaseStateFromDelivery(input.target),
    role: "target",
    now: input.now,
  });
  if (!targetVerdict.ready) {
    throw new MigrationRoutePreflightError(
      422,
      targetVerdict.code,
      `Target migration transfer lease is not ready: ${targetVerdict.reason}`,
    );
  }
}

/**
 * Whether the agent has a non-terminal migration. A pre-check only: /migrate inserts against the
 * one-active-migration-per-agent unique index, which is what makes it race-free.
 */
export async function hasActiveAgentMigration(tx: DatabaseTransaction, agentId: string): Promise<boolean> {
  const [activeMigration] = await tx
    .select({ id: agentMigrations.id })
    .from(agentMigrations)
    .where(and(
      eq(agentMigrations.agentId, agentId),
      inArray(agentMigrations.state, [...agentMigrationService.ACTIVE_AGENT_MIGRATION_STATES]),
    ))
    .limit(1);
  return Boolean(activeMigration);
}

/** A start refused before anything was written; the route answers it (sendMigrationError, or its own code). */
export interface ComputerMigrationStartFailure {
  status: number;
  code: AgentMigrationUserErrorCode;
  error: string;
  details?: MigrationErrorDetails;
}

/** What the checks found, for provisioning (computeValidatedMigration's result). */
export interface ValidatedComputerMigration {
  agentId: string;
  targetMachineId: string;
  /** The target's name now (the migration row snapshots it again under lock). */
  targetMachineName: string;
  runtimeConfig: RuntimeConfig;
  /** No source to bring anything from (no Computer, or one whose access was revoked): placed, not migrated. */
  placeWithoutSource: boolean;
  revokedSourceMachineId: string | null;
  /** The Computer the agent is on, when it can bring the agent over. */
  sourceMachineId: string | null;
  /** The source's migration capabilities, as it advertised them (empty when unknown). */
  sourceCapabilities: readonly string[];
  sourceDrainsBeforeStop: boolean;
}

/**
 * The checks of a start to another Computer, in the order the owner route has
 * always answered them: the agent and its source, the target (in the server,
 * not the source, runtime detection finished, runtime supported, migration
 * capability on both Computers, online), then no active migration. Reads
 * only; the start's write transaction re-checks what it must under its locks.
 * `targetComputer` is the target's id or name.
 */
export async function validateComputerMigrationStart(input: {
  serverId: string;
  agentId: string;
  targetComputer: string;
  orchestrator: AgentOrchestrator | undefined;
  now: Date;
}): Promise<{ failure: ComputerMigrationStartFailure } | { validated: ValidatedComputerMigration }> {
  const { serverId, targetComputer, now } = input;
  const agentOrchestrator = input.orchestrator;
  const result = await getDb().transaction(async (tx): Promise<ComputerMigrationStartFailure | { validated: ValidatedComputerMigration }> => {
    const [agent] = await tx
      .select()
      .from(agents)
      .where(and(eq(agents.id, input.agentId), eq(agents.serverId, serverId), isNull(agents.deletedAt)))
      .limit(1);
    if (!agent) {
      return { status: 404, code: "AGENT_NOT_FOUND", error: "Agent not found" };
    }
    // An agent on no Computer is placed on the target instead (placeAgentWithoutSource): the
    // same target checks below, nothing on a source to check. External and cloud agents never
    // run on a Computer.
    if (!agent.machineId && (isExternalAgentRuntime(agent.runtime) || agent.executionMode !== "byoc")) {
      return { status: 409, code: "AGENT_HAS_NO_SOURCE_MACHINE", error: "Agent has no source computer" };
    }
    const [boundMachine] = agent.machineId
      ? await tx
        .select()
        .from(machines)
        .where(and(eq(machines.id, agent.machineId), eq(machines.serverId, serverId)))
        .limit(1)
      : [];
    // Reconciler step 15 (B15): a Computer whose access was revoked never connects again, so it
    // can bring nothing over: the agent is placed on the target as one on no Computer is.
    const sourceAccessRevoked = Boolean(boundMachine)
      && (await findAccessRevokedMachineIds(tx, [boundMachine!.id])).has(boundMachine!.id);
    const placeWithoutSource = !agent.machineId || sourceAccessRevoked;
    const sourceMachine = sourceAccessRevoked ? undefined : boundMachine;
    const [targetMachine] = await tx
      .select()
      .from(machines)
      .where(and(
        eq(machines.serverId, serverId),
        isUuid(targetComputer)
          ? or(eq(machines.id, targetComputer), eq(machines.name, targetComputer))
          : eq(machines.name, targetComputer),
      ))
      .limit(1);
    if (!targetMachine) {
      return { status: 422, code: "TARGET_COMPUTER_NOT_IN_SERVER", error: "Target computer is not in this server" };
    }
    if (targetMachine.id === agent.machineId) {
      return { status: 409, code: "TARGET_COMPUTER_MATCHES_SOURCE", error: "Target computer matches the source computer" };
    }
    if (!boundMachine && !placeWithoutSource) {
      return { status: 409, code: "AGENT_HAS_NO_SOURCE_MACHINE", error: "Agent source computer is not available" };
    }

    // task #1268 (archer ruling): while the TARGET is still detecting this
    // runtime, or its last round never probed it, refuse with a retryable
    // 409 instead of committing a migration the target may not be able to
    // start. The source side keeps the existing check (the agent ran there).
    const targetDetection = await agentOrchestrator?.getMachineRuntimeDetection?.(targetMachine.id) ?? null;
    const targetRuntimeUnconfirmed = targetDetection?.status === "pending"
      || (targetDetection?.status === "incomplete" && (targetDetection.unfinishedRuntimes ?? []).includes(agent.runtime));
    if (targetDetection && targetRuntimeUnconfirmed) {
      const detectionStatus: "pending" | "incomplete" = targetDetection.status === "pending" ? "pending" : "incomplete";
      const details: MigrationTargetRuntimeDetectionDetails = {
        side: "target",
        runtime: agent.runtime,
        detectionStatus,
        ...(detectionStatus === "incomplete" ? { reason: targetDetection.reason ?? "child_failed" } : {}),
        retryable: true,
      };
      return {
        status: 409,
        code: "TARGET_RUNTIME_DETECTION_PENDING",
        error: detectionStatus === "pending"
          ? "The target computer is still detecting its runtimes; try again in a moment"
          : `The target computer's last runtime detection did not finish for ${agent.runtime}; rescan its runtimes and try again`,
        details,
      };
    }
    const capabilityFailures = computerRuntimeFailures({
      sourceRuntimes: sourceMachine ? sourceMachine.runtimes : undefined,
      targetRuntimes: targetMachine.runtimes,
      runtime: agent.runtime,
    });
    if (capabilityFailures.length > 0) {
      return {
        status: 422,
        code: "COMPUTER_CAPABILITY_INSUFFICIENT",
        error: placeWithoutSource
          ? "The target computer must support the agent's runtime"
          : "Both source and target computers must support the agent's runtime",
        details: { failures: capabilityFailures },
      };
    }

    // Placing an agent on no Computer transfers nothing: no migration transport to require.
    const [sourceTransport, targetTransport] = sourceMachine
      ? await Promise.all([
        agentOrchestrator?.getMachineMigrationTransport(sourceMachine.id) ?? null,
        agentOrchestrator?.getMachineMigrationTransport(targetMachine.id) ?? null,
      ])
      : [null, null];
    const capabilityDetail = sourceMachine ? migrationCapabilityDetail(sourceTransport, targetTransport) : null;
    if (capabilityDetail) {
      return {
        status: 422,
        code: "MIGRATION_RESUMABLE_CAPABILITY_REQUIRED",
        error: `Both source and target computers must run a Raft Computer that supports ${AGENT_MIGRATION_CAPABILITY}; upgrade the ${capabilityDetail.side === "both" ? "source and target computers" : `${capabilityDetail.side} computer`}`,
        details: capabilityDetail,
      };
    }

    const targetStatus = agentOrchestrator ? await agentOrchestrator.getMachineStatus(targetMachine.id) : "offline";
    const heartbeatFresh = Boolean(
      targetMachine.lastHeartbeat &&
      now.getTime() - targetMachine.lastHeartbeat.getTime() <= MIGRATION_MACHINE_ONLINE_MAX_AGE_MS,
    );
    if (targetStatus !== "online" || !heartbeatFresh) {
      return { status: 409, code: "TARGET_COMPUTER_OFFLINE", error: "Target computer is not online" };
    }

    if (await hasActiveAgentMigration(tx, agent.id)) {
      return { status: 409, code: "MIGRATION_ALREADY_IN_PROGRESS", error: "Agent already has an active migration" };
    }

    return {
      validated: {
        agentId: agent.id,
        targetMachineId: targetMachine.id,
        targetMachineName: targetMachine.name,
        runtimeConfig: hydrateRuntimeConfig(agent),
        placeWithoutSource,
        revokedSourceMachineId: sourceAccessRevoked ? boundMachine!.id : null,
        sourceMachineId: sourceMachine?.id ?? null,
        sourceCapabilities: sourceTransport?.capabilities ?? [],
        // Reconciler step 14 (Q-H): the source waits for its agent to be quiet before it stops it.
        sourceDrainsBeforeStop: sourceTransport?.capabilities?.includes(AGENT_MIGRATION_SOURCE_DRAIN_CAPABILITY) === true,
      },
    };
  });
  return "validated" in result ? result : { failure: result };
}

/**
 * The target Computer's Built-in model catalog check, for an agent on a
 * Built-in preset: answered by the replica holding the target's connection
 * (the request is replayed there when it is another one). "handled": the
 * response was sent (a refusal, or the owner replica's answer). Otherwise
 * the catalog authority to release once the start is done.
 */
export async function acquireMigrationTargetCatalogAuthority(
  req: Request,
  res: Response,
  agentOrchestrator: AgentOrchestrator | undefined,
  validated: Pick<ValidatedComputerMigration, "targetMachineId" | "runtimeConfig">,
): Promise<"handled" | (() => void)> {
  if (!isBuiltInCatalogCheckedSelection(validated.runtimeConfig)) return () => undefined;
  if (!agentOrchestrator) {
    sendBuiltInCatalogUnavailable(res);
    return "handled";
  }
  const routing = await handleMachineLocalRouting(
    req,
    res,
    validated.targetMachineId,
    () => agentOrchestrator.hasMachineLocally(validated.targetMachineId),
  );
  if (routing === "handled") return "handled";
  if (routing !== "confirmed_local") {
    sendBuiltInCatalogUnavailable(res);
    return "handled";
  }
  const catalogValidation = await validateBuiltInPresetForWrite(
    agentOrchestrator,
    validated.targetMachineId,
    validated.runtimeConfig,
  );
  if (!catalogValidation) return () => undefined;
  return agentOrchestrator.acquireBuiltInCatalogAuthority(validated.targetMachineId, catalogValidation.authority);
}

/** The Pro plan refusal, so the route can note the paywall hit. */
export interface ComputerMigrationPlanRequired extends ComputerMigrationStartFailure {
  planRequired: true;
}

/**
 * After the checks: the Pro plan (the last start-only gate before any
 * transport is provisioned or grant is minted), the transfer provision, then
 * the migration row and both transport leases in one write transaction, which
 * re-authorizes the starter under row locks (actorFence) and, for an agent's
 * retry, re-checks the failed migration (agentRetry). Throws what the write
 * throws (FencedAuthorizationDeniedError, ServerMembershipRevokedError,
 * MigrationRoutePreflightError, AgentMigrationRetryRefusedError).
 */
export async function provisionComputerMigrationStart(input: {
  serverId: string;
  validated: Pick<ValidatedComputerMigration, "agentId" | "targetMachineId" | "sourceDrainsBeforeStop">;
  initiatedByUserId: string;
  actorFence: agentMigrationService.AgentMigrationActorFence;
  agentRetry?: { retryOfMigrationId: string; triggeredByAgentId: string };
  provisioner: MigrationTransferProvisioner;
  now: Date;
  /** Runs in the start's write transaction once the row and leases exist (the retry's audit event). */
  inStartTransaction?: (tx: DatabaseTransaction, provisioning: agentMigrationService.AgentMigrationProvisioningResult) => Promise<void>;
}): Promise<
  | { failure: ComputerMigrationStartFailure | ComputerMigrationPlanRequired }
  | { provisioning: agentMigrationService.AgentMigrationProvisioningResult }
> {
  const db = getDb();
  const { now, validated } = input;
  try {
    await requireTeamBillingFeature(db, input.serverId, "Agent migration", now);
  } catch (err) {
    if (err instanceof Error && err.message === "Agent migration requires the Pro plan.") {
      return { failure: { status: 403, code: "MIGRATION_PRO_PLAN_REQUIRED", error: err.message, planRequired: true } };
    }
    throw err;
  }
  let transferProvision: agentMigrationService.AgentMigrationObjectStoreTransferProvision;
  try {
    transferProvision = await input.provisioner();
  } catch (err) {
    return {
      failure: {
        status: 422,
        code: "MIGRATION_TRANSPORT_PROVISION_FAILED",
        error: err instanceof Error ? err.message : "Failed to provision migration transfer lease",
      },
    };
  }

  return await db.transaction(async (tx) => {
    try {
      const provisioning = await agentMigrationService.beginAgentMigrationProvisioning({
        agentId: validated.agentId,
        targetMachineId: validated.targetMachineId,
        sourceDrainsBeforeStop: validated.sourceDrainsBeforeStop,
        initiatedByUserId: input.initiatedByUserId,
        // Task #93 line C: re-authorize the initiator under row locks inside this write transaction.
        actorFence: input.actorFence,
        ...(input.agentRetry ? { agentRetry: input.agentRetry } : {}),
        now,
        transportProvider: transferProvision.provider,
        transportSessionId: transferProvision.sessionId,
        transportLeaseMs: transferProvision.leaseMs,
        transportMaxBytes: transferProvision.maxBytes,
      }, tx);
      assertMigrationTransferLeaseReady({
        migration: provisioning.migration,
        source: provisioning.source,
        target: provisioning.target,
        now,
      });
      await input.inStartTransaction?.(tx, provisioning);
      return { provisioning } as const;
    } catch (err) {
      const message = err instanceof Error ? err.message : "";
      if (/idx_agent_migrations_active_agent|duplicate key|constraint/i.test(message)) {
        return { failure: { status: 409, code: "MIGRATION_ALREADY_IN_PROGRESS", error: "Agent already has an active migration" } } as const;
      }
      throw err;
    }
  });
}

/**
 * Hand both Computers their transport lease. On a send failure the migration
 * is marked failed (transport provision failed) and the failure returned; null
 * once both were sent.
 */
export async function sendComputerMigrationLeases(input: {
  io: SocketServer | undefined;
  orchestrator: AgentOrchestrator | undefined;
  provisioning: agentMigrationService.AgentMigrationProvisioningResult;
}): Promise<ComputerMigrationStartFailure | null> {
  const { provisioning, orchestrator } = input;
  try {
    await Promise.all([
      orchestrator?.sendAgentMigrationTransportLease(provisioning.source.machineId, provisioning.source.message),
      orchestrator?.sendAgentMigrationTransportLease(provisioning.target.machineId, provisioning.target.message),
    ]);
    return null;
  } catch (err) {
    const failed = await agentMigrationService.markAgentMigrationTransportProvisionFailed({
      migrationId: provisioning.migration.id,
      message: err instanceof Error ? err.message : "Failed to send migration transfer lease",
    });
    if (failed) await emitAgentMigrationUpdated(input.io, failed);
    return {
      status: 422,
      code: "MIGRATION_TRANSPORT_PROVISION_FAILED",
      error: err instanceof Error ? err.message : "Failed to send migration transfer lease",
    };
  }
}
