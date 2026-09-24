import { and, asc, eq, inArray, isNull, lte, or, sql } from "drizzle-orm";
import { isDeepStrictEqual } from "node:util";
import {
  currentDate,
  type AgentActivity,
  type AgentActivityDetailKind,
  type ComputerLifecycleAction,
  type ComputerLifecycleExecutionAck,
  type ComputerLifecycleTerminal,
  type TrajectoryEntry,
} from "@botiverse/raft-shared";
import { getDb } from "../db/index.js";
import {
  agentActivityEvents,
  agents,
  computerLifecycleDispatches,
  computerLifecycleOperationTargets,
  computerLifecycleOperations,
  computers,
} from "../db/schema.js";

const SHUTDOWN_ACK_DEADLINE_MS = 30 * 1000;
const READY_ACK_DEADLINE_MS = 2 * 60 * 1000;
const MACHINE_CONVERGENCE_DEADLINE_MS = 15 * 60 * 1000;

type OperationRow = typeof computerLifecycleOperations.$inferSelect;

export interface ComputerLifecycleActivityProjection {
  agentId: string;
  activity: AgentActivity;
  detail: string;
  detailKind: AgentActivityDetailKind;
  entries: TrajectoryEntry[];
  dedupeKey: string;
}

export interface CompletedComputerLifecycleOperationFact {
  operationId: string;
  serverId: string;
  machineId: string;
  action: ComputerLifecycleAction;
  actorUserId: string | null;
  terminal: ComputerLifecycleTerminal;
  terminalReason: string | null;
}

export type ObserveComputerLifecycleResult =
  | { status: "rejected" }
  | { status: "late_after_terminal"; operationId: string; terminal: ComputerLifecycleTerminal }
  | { status: "pending"; operationId: string }
  | {
      status: "terminal";
      fact: CompletedComputerLifecycleOperationFact;
      projections: ComputerLifecycleActivityProjection[];
    };

function deadlineAfter(ms: number): Date {
  const deadline = currentDate();
  deadline.setTime(deadline.getTime() + ms);
  return deadline;
}

export function resolveComputerLifecycleOperationId(
  acknowledgement: Pick<ComputerLifecycleExecutionAck, "operationId" | "requestId">,
): string | null {
  if (acknowledgement.operationId && acknowledgement.requestId
    && acknowledgement.operationId !== acknowledgement.requestId) return null;
  return acknowledgement.operationId ?? acknowledgement.requestId ?? null;
}

export async function createUserComputerLifecycleOperation(input: {
  operationId?: string;
  parentOperationId?: string | null;
  serverId: string;
  machineId: string;
  actorUserId: string;
  action: ComputerLifecycleAction;
  dispatchMode: "local" | "server";
  connectionEpochBefore?: string | null;
  targetVersion?: string | null;
  broadcastPolicyDecision?: Record<string, unknown> | null;
  dispatch?: {
    action: "restart" | "upgrade";
    targetVersion: string;
    adapter: string;
  };
}): Promise<{
  operationId: string;
  dispatch?: { operationId: string; action: "restart" | "upgrade"; targetVersion: string };
} | null> {
  const db = getDb();
  const [computer] = await db.select({ id: computers.id })
    .from(computers)
    .where(and(
      eq(computers.serverId, input.serverId),
      eq(computers.machineId, input.machineId),
      isNull(computers.revokedAt),
    ))
    .limit(1);
  if (!computer) return null;
  const inserted = await db.transaction(async (tx) => {
    const rows = await tx.insert(computerLifecycleOperations).values({
      ...(input.operationId ? { id: input.operationId } : {}),
      ...(input.parentOperationId ? { parentOperationId: input.parentOperationId } : {}),
      serverId: input.serverId,
      computerId: computer.id,
      machineId: input.machineId,
      action: input.action,
      cause: "user_action",
      actorUserId: input.actorUserId,
      dispatchMode: input.dispatchMode,
      ...(input.connectionEpochBefore ? { connectionEpochBefore: input.connectionEpochBefore } : {}),
      ...(input.targetVersion ? { targetVersion: input.targetVersion } : {}),
      ...(input.broadcastPolicyDecision
        ? { broadcastPolicyDecision: input.broadcastPolicyDecision }
        : {}),
      ...(input.action === "start"
        ? { readyDeadlineAt: deadlineAfter(READY_ACK_DEADLINE_MS) }
        : { shutdownDeadlineAt: deadlineAfter(input.dispatch
            ? MACHINE_CONVERGENCE_DEADLINE_MS
            : SHUTDOWN_ACK_DEADLINE_MS) }),
    }).onConflictDoNothing().returning({ id: computerLifecycleOperations.id });
    if (!rows[0]) return { rows, dispatchRows: [] as Array<{ id: string }> };
    const dispatchRows = input.dispatch
      ? await tx.insert(computerLifecycleDispatches).values({
          parentOperationId: rows[0].id,
          dispatchAction: input.dispatch.action,
          targetVersion: input.dispatch.targetVersion,
          adapter: input.dispatch.adapter,
          originServerId: input.serverId,
          machineId: input.machineId,
          ...(input.connectionEpochBefore ? { observedSourceEpoch: input.connectionEpochBefore } : {}),
          phaseDeadlineAt: deadlineAfter(MACHINE_CONVERGENCE_DEADLINE_MS),
        }).returning({ id: computerLifecycleDispatches.id })
      : [];
    const targets = await tx.select({ id: agents.id }).from(agents).where(and(
      eq(agents.serverId, input.serverId),
      eq(agents.machineId, input.machineId),
      isNull(agents.deletedAt),
    ));
    if (targets.length > 0) {
      await tx.insert(computerLifecycleOperationTargets).values(targets.map((target) => ({
        operationId: rows[0]!.id,
        agentId: target.id,
        machineIdAtIntent: input.machineId,
      }))).onConflictDoNothing();
    }
    return { rows, dispatchRows };
  });
  if (inserted.rows[0]) {
    return {
      operationId: inserted.rows[0].id,
      ...(input.dispatch && inserted.dispatchRows[0]
        ? {
            dispatch: {
              operationId: inserted.dispatchRows[0].id,
              action: input.dispatch.action,
              targetVersion: input.dispatch.targetVersion,
            },
          }
        : {}),
    };
  }
  const [existing] = await db.select({
    id: computerLifecycleOperations.id,
    serverId: computerLifecycleOperations.serverId,
    machineId: computerLifecycleOperations.machineId,
    action: computerLifecycleOperations.action,
    actorUserId: computerLifecycleOperations.actorUserId,
    parentOperationId: computerLifecycleOperations.parentOperationId,
    dispatchMode: computerLifecycleOperations.dispatchMode,
    targetVersion: computerLifecycleOperations.targetVersion,
    broadcastPolicyDecision: computerLifecycleOperations.broadcastPolicyDecision,
  }).from(computerLifecycleOperations)
    .where(input.operationId
      ? eq(computerLifecycleOperations.id, input.operationId)
      : and(
          eq(computerLifecycleOperations.serverId, input.serverId),
          eq(computerLifecycleOperations.machineId, input.machineId),
          eq(computerLifecycleOperations.action, input.action),
          eq(computerLifecycleOperations.status, "pending"),
        ))
    .limit(1);
  if (!(existing
    && (!input.operationId || (existing.id === input.operationId
      && existing.parentOperationId === (input.parentOperationId ?? null)))
    && existing.dispatchMode === input.dispatchMode
    && existing.serverId === input.serverId
    && existing.machineId === input.machineId
    && existing.action === input.action
    && existing.actorUserId === input.actorUserId
    && existing.targetVersion === (input.targetVersion ?? null)
    && isDeepStrictEqual(
      existing.broadcastPolicyDecision,
      input.broadcastPolicyDecision ?? null,
    ))) return null;
  if (!input.dispatch) return { operationId: existing.id };
  const [dispatch] = await db.select({
    id: computerLifecycleDispatches.id,
    action: computerLifecycleDispatches.dispatchAction,
    targetVersion: computerLifecycleDispatches.targetVersion,
    adapter: computerLifecycleDispatches.adapter,
  }).from(computerLifecycleDispatches).where(eq(
    computerLifecycleDispatches.parentOperationId,
    existing.id,
  )).limit(1);
  return dispatch
    && dispatch.action === input.dispatch.action
    && dispatch.targetVersion === input.dispatch.targetVersion
    && dispatch.adapter === input.dispatch.adapter
      ? {
          operationId: existing.id,
          dispatch: {
            operationId: dispatch.id,
            action: dispatch.action,
            targetVersion: dispatch.targetVersion,
          },
        }
      : null;
}

export async function markComputerLifecycleCommandSent(operationId: string): Promise<boolean> {
  const now = currentDate();
  const [dispatch] = await getDb().select({ parentOperationId: computerLifecycleDispatches.parentOperationId })
    .from(computerLifecycleDispatches)
    .where(eq(computerLifecycleDispatches.id, operationId))
    .limit(1);
  if (dispatch) {
    return getDb().transaction(async (tx) => {
      const updatedDispatch = await tx.update(computerLifecycleDispatches).set({
        phase: "first_hop_observed",
        phaseVersion: sql`${computerLifecycleDispatches.phaseVersion} + 1`,
        firstHopProgressOrdinal: sql`GREATEST(${computerLifecycleDispatches.firstHopProgressOrdinal}, 1)`,
        lastValidEvidenceAt: now,
        updatedAt: now,
      }).where(and(
        eq(computerLifecycleDispatches.id, operationId),
        isNull(computerLifecycleDispatches.terminalAt),
      )).returning({ id: computerLifecycleDispatches.id });
      if (!updatedDispatch[0]) return false;
      const updatedParent = await tx.update(computerLifecycleOperations).set({
        dispatchStatus: "sent",
        dispatchAttempts: sql`GREATEST(${computerLifecycleOperations.dispatchAttempts}, 1)`,
        commandSentAt: now,
        dispatchLeaseAt: now,
      }).where(and(
        eq(computerLifecycleOperations.id, dispatch.parentOperationId),
        eq(computerLifecycleOperations.status, "pending"),
      )).returning({ id: computerLifecycleOperations.id });
      return updatedParent.length > 0;
    });
  }
  const updated = await getDb().update(computerLifecycleOperations).set({
    dispatchStatus: "sent",
    dispatchAttempts: sql`GREATEST(${computerLifecycleOperations.dispatchAttempts}, 1)`,
    commandSentAt: now,
    dispatchLeaseAt: now,
  }).where(and(
    eq(computerLifecycleOperations.id, operationId),
    eq(computerLifecycleOperations.status, "pending"),
  )).returning({ id: computerLifecycleOperations.id });
  return updated.length > 0;
}

export async function releaseComputerLifecycleDispatchLease(operationId: string): Promise<void> {
  const [dispatch] = await getDb().select({ parentOperationId: computerLifecycleDispatches.parentOperationId })
    .from(computerLifecycleDispatches)
    .where(eq(computerLifecycleDispatches.id, operationId))
    .limit(1);
  await getDb().update(computerLifecycleOperations).set({ dispatchLeaseAt: null }).where(and(
    eq(computerLifecycleOperations.id, dispatch?.parentOperationId ?? operationId),
    eq(computerLifecycleOperations.status, "pending"),
    eq(computerLifecycleOperations.dispatchStatus, "pending"),
  ));
}

export interface ClaimedComputerLifecycleDispatch {
  operationId: string;
  parentOperationId: string;
  serverId: string;
  machineId: string;
  action: "restart" | "upgrade";
  targetVersion: string;
  broadcastPolicyDecision: Record<string, unknown> | null;
}

export async function claimPendingComputerLifecycleDispatches(
  machineIds: string[],
  limit = 50,
): Promise<ClaimedComputerLifecycleDispatch[]> {
  if (machineIds.length === 0) return [];
  const db = getDb();
  const now = currentDate();
  const leaseCutoff = currentDate();
  leaseCutoff.setTime(now.getTime() - 30_000);
  const candidates = await db.select({
    operationId: computerLifecycleDispatches.id,
    parentOperationId: computerLifecycleOperations.id,
    serverId: computerLifecycleOperations.serverId,
    machineId: computerLifecycleOperations.machineId,
    action: computerLifecycleDispatches.dispatchAction,
    targetVersion: computerLifecycleDispatches.targetVersion,
    broadcastPolicyDecision: computerLifecycleOperations.broadcastPolicyDecision,
  }).from(computerLifecycleOperations).innerJoin(
    computerLifecycleDispatches,
    eq(computerLifecycleDispatches.parentOperationId, computerLifecycleOperations.id),
  ).where(and(
    eq(computerLifecycleOperations.status, "pending"),
    eq(computerLifecycleOperations.dispatchMode, "server"),
    eq(computerLifecycleOperations.dispatchStatus, "pending"),
    inArray(computerLifecycleOperations.machineId, machineIds),
    or(
      isNull(computerLifecycleOperations.dispatchLeaseAt),
      lte(computerLifecycleOperations.dispatchLeaseAt, leaseCutoff),
    ),
  )).orderBy(asc(computerLifecycleOperations.createdAt)).limit(limit);

  const claimed: ClaimedComputerLifecycleDispatch[] = [];
  for (const candidate of candidates) {
    if (candidate.action !== "restart" && candidate.action !== "upgrade") continue;
    const updated = await db.update(computerLifecycleOperations).set({
      dispatchLeaseAt: now,
      dispatchAttempts: sql`${computerLifecycleOperations.dispatchAttempts} + 1`,
    }).where(and(
      eq(computerLifecycleOperations.id, candidate.parentOperationId),
      eq(computerLifecycleOperations.status, "pending"),
      eq(computerLifecycleOperations.dispatchStatus, "pending"),
      or(
        isNull(computerLifecycleOperations.dispatchLeaseAt),
        lte(computerLifecycleOperations.dispatchLeaseAt, leaseCutoff),
      ),
    )).returning({ id: computerLifecycleOperations.id });
    if (updated[0]) claimed.push(candidate as typeof claimed[number]);
  }
  return claimed;
}

export function reduceComputerLifecycleTerminal(operation: Pick<OperationRow,
  "action" | "dispatchMode" | "shutdownAckAt" | "disconnectedAt" | "readyAckAt" | "connectionEpochBefore" |
  "readyConnectionEpoch" | "targetVersion" | "loadedComputerVersion" | "broadcastPolicyDecision"
>): { terminal: ComputerLifecycleTerminal; reason: string | null } | null {
  if (operation.action === "start") {
    if (!operation.readyAckAt) return null;
    if (operation.connectionEpochBefore && operation.readyConnectionEpoch === operation.connectionEpochBefore) return null;
    return { terminal: "completed", reason: null };
  }
  if (operation.action === "stop") {
    return operation.shutdownAckAt && operation.disconnectedAt
      ? { terminal: "completed", reason: null }
      : null;
  }
  // A server-dispatched Restart/Upgrade is the user intent U. Only its D
  // child may close it after machine-wide replacement attestation.
  if (operation.dispatchMode === "server") return null;
  const completion = operation.broadcastPolicyDecision;
  if (completion?.completionMode === "legacy_k_promoted") {
    if (operation.action !== "upgrade" || !operation.shutdownAckAt || !operation.readyAckAt) return null;
    if (typeof completion.connectionEpoch !== "string"
      || operation.readyConnectionEpoch !== completion.connectionEpoch
      || completion.sourceVersion !== operation.targetVersion
      || operation.loadedComputerVersion !== operation.targetVersion) return null;
    return { terminal: "completed", reason: null };
  }
  if (!operation.shutdownAckAt || !operation.disconnectedAt || !operation.readyAckAt) return null;
  if (operation.connectionEpochBefore && operation.readyConnectionEpoch === operation.connectionEpochBefore) return null;
  if (operation.action === "upgrade" && operation.targetVersion !== operation.loadedComputerVersion) return null;
  return { terminal: "completed", reason: null };
}

export function projectTerminalComputerLifecycleActivity(
  fact: CompletedComputerLifecycleOperationFact,
  agentId: string,
): ComputerLifecycleActivityProjection {
  const succeeded = fact.terminal === "completed";
  const completedCopy: Record<ComputerLifecycleAction, { activity: AgentActivity; detail: string; detailKind: AgentActivityDetailKind }> = {
    start: { activity: "online", detail: "Computer started", detailKind: "computer_started" },
    stop: { activity: "offline", detail: "Computer stopped", detailKind: "stopped" },
    restart: { activity: "online", detail: "Computer restarted", detailKind: "computer_restarted" },
    upgrade: { activity: "online", detail: "Computer upgraded", detailKind: "computer_upgraded" },
  };
  const selected = succeeded
    ? completedCopy[fact.action]
    : {
        activity: "error" as const,
        detail: `Computer ${fact.action} ${fact.terminal}${fact.terminalReason ? `: ${fact.terminalReason}` : ""}`,
        detailKind: "computer_operation_failed" as const,
      };
  const entries: TrajectoryEntry[] = [{
    kind: "status",
    activity: selected.activity,
    activityKind: selected.activity,
    detail: selected.detail,
    detailKind: selected.detailKind,
  }];
  return {
    agentId,
    ...selected,
    entries,
    dedupeKey: `computer-operation:${fact.serverId}:${fact.machineId}:${fact.operationId}:${fact.terminal}`,
  };
}

async function applyObservation(input: {
  serverId: string;
  machineId: string;
  operationId: string;
  patch: Partial<Pick<OperationRow,
    "shutdownAckAt" | "disconnectedAt" | "readyAckAt" | "readyConnectionEpoch" | "loadedComputerVersion" |
    "readyDeadlineAt" | "dispatchStatus" | "commandSentAt"
  >>;
  forcedTerminal?: { terminal: ComputerLifecycleTerminal; reason: string };
}): Promise<ObserveComputerLifecycleResult> {
  const db = getDb();
  return db.transaction(async (tx) => {
    const [operation] = await tx.select().from(computerLifecycleOperations).where(and(
      eq(computerLifecycleOperations.id, input.operationId),
      eq(computerLifecycleOperations.serverId, input.serverId),
      eq(computerLifecycleOperations.machineId, input.machineId),
    )).limit(1);
    if (!operation) return { status: "rejected" } as const;
    if (operation.status !== "pending") {
      return { status: "late_after_terminal", operationId: operation.id, terminal: operation.status } as const;
    }
    let next = operation;
    if (Object.keys(input.patch).length > 0) {
      const [patched] = await tx.update(computerLifecycleOperations).set(input.patch).where(and(
        eq(computerLifecycleOperations.id, operation.id),
        eq(computerLifecycleOperations.serverId, input.serverId),
        eq(computerLifecycleOperations.machineId, input.machineId),
        eq(computerLifecycleOperations.status, "pending"),
      )).returning();
      if (!patched) {
        const [current] = await tx.select({ status: computerLifecycleOperations.status })
          .from(computerLifecycleOperations)
          .where(eq(computerLifecycleOperations.id, operation.id))
          .limit(1);
        return current && current.status !== "pending"
          ? { status: "late_after_terminal", operationId: operation.id, terminal: current.status } as const
          : { status: "rejected" } as const;
      }
      next = patched;
    }
    const terminal = input.forcedTerminal ?? reduceComputerLifecycleTerminal(next);
    if (!terminal) {
      return { status: "pending", operationId: operation.id } as const;
    }

    const terminalAt = currentDate();
    const [winner] = await tx.update(computerLifecycleOperations).set({
      status: terminal.terminal,
      terminalAt,
      terminalReason: terminal.reason,
    }).where(and(
      eq(computerLifecycleOperations.id, operation.id),
      eq(computerLifecycleOperations.status, "pending"),
    )).returning();
    if (!winner) {
      const [current] = await tx.select({ status: computerLifecycleOperations.status })
        .from(computerLifecycleOperations)
        .where(eq(computerLifecycleOperations.id, operation.id))
        .limit(1);
      return current && current.status !== "pending"
        ? { status: "late_after_terminal", operationId: operation.id, terminal: current.status } as const
        : { status: "rejected" } as const;
    }
    await tx.update(computerLifecycleDispatches).set({
      phase: "finalized",
      phaseVersion: sql`${computerLifecycleDispatches.phaseVersion} + 1`,
      terminalAt,
      ...(terminal.terminal === "completed" ? {} : { failureCode: terminal.reason ?? terminal.terminal }),
      updatedAt: terminalAt,
    }).where(and(
      eq(computerLifecycleDispatches.parentOperationId, winner.id),
      isNull(computerLifecycleDispatches.terminalAt),
    ));
    const fact: CompletedComputerLifecycleOperationFact = {
      operationId: winner.id,
      serverId: winner.serverId,
      machineId: winner.machineId,
      action: winner.action,
      actorUserId: winner.actorUserId,
      terminal: terminal.terminal,
      terminalReason: terminal.reason,
    };
    const targets = await tx.select({
      agentId: computerLifecycleOperationTargets.agentId,
      machineIdAtIntent: computerLifecycleOperationTargets.machineIdAtIntent,
      projectionStatus: computerLifecycleOperationTargets.projectionStatus,
    }).from(computerLifecycleOperationTargets).where(eq(
      computerLifecycleOperationTargets.operationId,
      operation.id,
    ));
    const projections: ComputerLifecycleActivityProjection[] = [];
    for (const target of targets) {
      if (target.projectionStatus !== "pending") continue;
      const [currentTarget] = await tx.select({
        serverId: agents.serverId,
        machineId: agents.machineId,
        deletedAt: agents.deletedAt,
      }).from(agents).where(eq(agents.id, target.agentId)).limit(1);
      const skipReason = !currentTarget || currentTarget.deletedAt
        ? "target_missing" as const
        : currentTarget.serverId !== operation.serverId
          || currentTarget.machineId !== target.machineIdAtIntent
          || target.machineIdAtIntent !== operation.machineId
          ? "no_longer_member" as const
          : null;
      if (skipReason) {
        await tx.update(computerLifecycleOperationTargets).set({
          projectionStatus: "skipped",
          projectionSkipReason: skipReason,
          projectedAt: terminalAt,
        }).where(and(
          eq(computerLifecycleOperationTargets.operationId, operation.id),
          eq(computerLifecycleOperationTargets.agentId, target.agentId),
          eq(computerLifecycleOperationTargets.projectionStatus, "pending"),
        ));
        continue;
      }
      const projection = projectTerminalComputerLifecycleActivity(fact, target.agentId);
      await tx.insert(agentActivityEvents).values({
        agentId: projection.agentId,
        activity: projection.activity,
        detail: projection.detail,
        entries: projection.entries,
        dedupeKey: projection.dedupeKey,
        createdAt: terminalAt,
      }).onConflictDoNothing();
      await tx.update(computerLifecycleOperationTargets).set({
        projectionStatus: "projected",
        projectedAt: terminalAt,
      }).where(and(
        eq(computerLifecycleOperationTargets.operationId, operation.id),
        eq(computerLifecycleOperationTargets.agentId, target.agentId),
        eq(computerLifecycleOperationTargets.projectionStatus, "pending"),
      ));
      projections.push(projection);
    }
    return { status: "terminal", fact, projections } as const;
  });
}

export async function observeComputerLifecycleAck(input: {
  serverId: string;
  machineId: string;
  connectionEpoch: string;
  acknowledgement: ComputerLifecycleExecutionAck;
}): Promise<ObserveComputerLifecycleResult> {
  const now = currentDate();
  const operationId = resolveComputerLifecycleOperationId(input.acknowledgement);
  if (!operationId) return { status: "rejected" };
  const [dispatch] = await getDb().select({
    id: computerLifecycleDispatches.id,
    parentOperationId: computerLifecycleDispatches.parentOperationId,
    action: computerLifecycleDispatches.dispatchAction,
    targetVersion: computerLifecycleDispatches.targetVersion,
    terminalAt: computerLifecycleDispatches.terminalAt,
  }).from(computerLifecycleDispatches).where(and(
    eq(computerLifecycleDispatches.id, operationId),
    eq(computerLifecycleDispatches.originServerId, input.serverId),
    eq(computerLifecycleDispatches.machineId, input.machineId),
  )).limit(1);
  if (dispatch) {
    if (dispatch.action !== input.acknowledgement.action) return { status: "rejected" };
    if (dispatch.terminalAt) {
      const [parent] = await getDb().select({ status: computerLifecycleOperations.status })
        .from(computerLifecycleOperations)
        .where(eq(computerLifecycleOperations.id, dispatch.parentOperationId))
        .limit(1);
      return parent && parent.status !== "pending"
        ? { status: "late_after_terminal", operationId: dispatch.parentOperationId, terminal: parent.status }
        : { status: "rejected" };
    }
    if (input.acknowledgement.phase === "shutdown") {
      await getDb().transaction(async (tx) => {
        await tx.update(computerLifecycleDispatches).set({
          phase: "first_hop_observed",
          phaseVersion: sql`${computerLifecycleDispatches.phaseVersion} + 1`,
          firstHopProgressOrdinal: sql`GREATEST(${computerLifecycleDispatches.firstHopProgressOrdinal}, 2)`,
          lastValidEvidenceAt: now,
          updatedAt: now,
        }).where(and(
          eq(computerLifecycleDispatches.id, dispatch.id),
          isNull(computerLifecycleDispatches.terminalAt),
        ));
        await tx.update(computerLifecycleOperations).set({
          shutdownAckAt: now,
          readyDeadlineAt: deadlineAfter(MACHINE_CONVERGENCE_DEADLINE_MS),
          dispatchStatus: "sent",
          commandSentAt: now,
        }).where(and(
          eq(computerLifecycleOperations.id, dispatch.parentOperationId),
          eq(computerLifecycleOperations.status, "pending"),
        ));
      });
      return { status: "pending", operationId: dispatch.parentOperationId };
    }
    const ack = input.acknowledgement;
    if (ack.loadedComputerVersion !== dispatch.targetVersion
      || !ack.serviceGeneration
      || !ack.managedSetRevision
      || ack.oldProcessIdentitiesDead !== true
      || !ack.deadProcessIdentities?.length
      || ack.deadProcessIdentities.some((identity) => typeof identity !== "string" || !identity)) {
      return { status: "rejected" };
    }
    await getDb().update(computerLifecycleDispatches).set({
      phase: "terminal_outbox",
      phaseVersion: sql`${computerLifecycleDispatches.phaseVersion} + 1`,
      lastValidEvidenceAt: now,
      observedTargetGeneration: ack.serviceGeneration,
      currentManagedSetRevision: ack.managedSetRevision,
      terminalEvidence: {
        loadedComputerVersion: ack.loadedComputerVersion,
        serviceGeneration: ack.serviceGeneration,
        managedSetRevision: ack.managedSetRevision,
        oldProcessIdentitiesDead: true,
        deadProcessIdentities: ack.deadProcessIdentities,
      },
      updatedAt: now,
    }).where(and(
      eq(computerLifecycleDispatches.id, dispatch.id),
      isNull(computerLifecycleDispatches.terminalAt),
    ));
    const result = await applyObservation({
      serverId: input.serverId,
      machineId: input.machineId,
      operationId: dispatch.parentOperationId,
      patch: {
        readyAckAt: now,
        readyConnectionEpoch: input.connectionEpoch,
        loadedComputerVersion: ack.loadedComputerVersion,
        dispatchStatus: "sent",
        commandSentAt: now,
      },
      forcedTerminal: { terminal: "completed", reason: "machine_dispatch_converged" },
    });
    if (result.status === "terminal" || result.status === "late_after_terminal") {
      await getDb().update(computerLifecycleDispatches).set({
        phase: "finalized",
        phaseVersion: sql`${computerLifecycleDispatches.phaseVersion} + 1`,
        terminalAt: now,
        updatedAt: now,
      }).where(and(
        eq(computerLifecycleDispatches.id, dispatch.id),
        isNull(computerLifecycleDispatches.terminalAt),
      ));
    }
    return result;
  }
  const [operation] = await getDb().select({ action: computerLifecycleOperations.action })
    .from(computerLifecycleOperations)
    .where(and(
      eq(computerLifecycleOperations.id, operationId),
      eq(computerLifecycleOperations.serverId, input.serverId),
      eq(computerLifecycleOperations.machineId, input.machineId),
    )).limit(1);
  if (!operation || operation.action !== input.acknowledgement.action) return { status: "rejected" };
  return applyObservation({
    serverId: input.serverId,
    machineId: input.machineId,
    operationId,
    patch: input.acknowledgement.phase === "shutdown"
      ? {
          shutdownAckAt: now,
          readyDeadlineAt: deadlineAfter(READY_ACK_DEADLINE_MS),
          dispatchStatus: "sent",
          commandSentAt: now,
        }
      : {
          readyAckAt: now,
          readyConnectionEpoch: input.connectionEpoch,
          dispatchStatus: "sent",
          commandSentAt: now,
          ...(input.acknowledgement.loadedComputerVersion
            ? { loadedComputerVersion: input.acknowledgement.loadedComputerVersion }
            : {}),
        },
  });
}

export async function observeComputerLifecycleDisconnect(input: {
  serverId: string;
  machineId: string;
  connectionEpoch: string;
}): Promise<ObserveComputerLifecycleResult[]> {
  const db = getDb();
  const pending = await db.select({ id: computerLifecycleOperations.id })
    .from(computerLifecycleOperations)
    .where(and(
      eq(computerLifecycleOperations.serverId, input.serverId),
      eq(computerLifecycleOperations.machineId, input.machineId),
      eq(computerLifecycleOperations.status, "pending"),
      eq(computerLifecycleOperations.connectionEpochBefore, input.connectionEpoch),
    ));
  const now = currentDate();
  return Promise.all(pending.map((operation) => applyObservation({
    serverId: input.serverId,
    machineId: input.machineId,
    operationId: operation.id,
    patch: { disconnectedAt: now },
  })));
}

export async function terminalizeComputerLifecycleOperation(input: {
  operationId: string;
  serverId: string;
  machineId: string;
  terminal: Extract<ComputerLifecycleTerminal, "failed" | "rolled_back" | "superseded">;
  reason: string;
  loadedComputerVersion?: string;
}): Promise<ObserveComputerLifecycleResult> {
  const [dispatch] = await getDb().select({ parentOperationId: computerLifecycleDispatches.parentOperationId })
    .from(computerLifecycleDispatches)
    .where(and(
      eq(computerLifecycleDispatches.id, input.operationId),
      eq(computerLifecycleDispatches.originServerId, input.serverId),
      eq(computerLifecycleDispatches.machineId, input.machineId),
    )).limit(1);
  const operationId = dispatch?.parentOperationId ?? input.operationId;
  if (dispatch) {
    await getDb().update(computerLifecycleDispatches).set({
      failureCode: input.reason,
      updatedAt: currentDate(),
    }).where(and(
      eq(computerLifecycleDispatches.id, input.operationId),
      isNull(computerLifecycleDispatches.terminalAt),
    ));
  }
  return applyObservation({
    operationId,
    serverId: input.serverId,
    machineId: input.machineId,
    patch: input.loadedComputerVersion ? { loadedComputerVersion: input.loadedComputerVersion } : {},
    forcedTerminal: { terminal: input.terminal, reason: input.reason },
  });
}

export async function recordComputerLifecycleUpgradeTarget(input: {
  operationId: string;
  serverId: string;
  machineId: string;
  targetVersion: string;
}): Promise<void> {
  if (!/^\d+\.\d+\.\d+(?:[-+][0-9A-Za-z.-]+)?$/.test(input.targetVersion)) return;
  await getDb().update(computerLifecycleOperations).set({ targetVersion: input.targetVersion }).where(and(
    eq(computerLifecycleOperations.id, input.operationId),
    eq(computerLifecycleOperations.serverId, input.serverId),
    eq(computerLifecycleOperations.machineId, input.machineId),
    eq(computerLifecycleOperations.action, "upgrade"),
    eq(computerLifecycleOperations.status, "pending"),
    isNull(computerLifecycleOperations.targetVersion),
  ));
}

export async function expirePendingComputerLifecycleOperations(): Promise<ObserveComputerLifecycleResult[]> {
  const now = currentDate();
  const pending = await getDb().select({
    id: computerLifecycleOperations.id,
    serverId: computerLifecycleOperations.serverId,
    machineId: computerLifecycleOperations.machineId,
    action: computerLifecycleOperations.action,
    shutdownAckAt: computerLifecycleOperations.shutdownAckAt,
    shutdownDeadlineAt: computerLifecycleOperations.shutdownDeadlineAt,
    readyDeadlineAt: computerLifecycleOperations.readyDeadlineAt,
  }).from(computerLifecycleOperations).where(and(
    eq(computerLifecycleOperations.status, "pending"),
    or(
      lte(computerLifecycleOperations.shutdownDeadlineAt, now),
      lte(computerLifecycleOperations.readyDeadlineAt, now),
    ),
  ));
  return Promise.all(pending.map((operation) => {
    const shutdownExpired = operation.shutdownDeadlineAt !== null
      && operation.shutdownDeadlineAt.getTime() <= now.getTime()
      && operation.shutdownAckAt === null;
    return applyObservation({
      serverId: operation.serverId,
      machineId: operation.machineId,
      operationId: operation.id,
      patch: {},
      forcedTerminal: {
        terminal: "unconfirmed",
        reason: shutdownExpired
          ? "shutdown_ack_timeout"
          : operation.action === "stop" ? "disconnect_timeout" : "ready_timeout",
      },
    });
  }));
}
