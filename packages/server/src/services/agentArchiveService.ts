/**
 * Agent archive (task #2, RFC "Agent 归档"). Archiving is the old soft delete
 * (`agents.deleted_at`) plus one `agent_archives` row that records where the
 * workspace is and the workspace operation the user asked for:
 *
 * - keep:   nothing to do; the workspace stays on its Computer.
 * - delete: the Computer removes the workspace (`machine:workspace:delete`,
 *           which every daemon understands).
 *
 * Commands to a Computer are not queued anywhere else, so an op stays in the
 * row until a replica that holds the Computer's connection sends it: right
 * after the request, on the Computer's `ready`, and on the 30s sweep. The
 * dispatch stamp is a lease.
 */
import { agentFindableBy } from "./agentMemberListPolicy";
import { agentEventRoom } from "../socket/platformScope";
import { randomUUID } from "node:crypto";
import {
  AGENT_ARCHIVE_UPDATED_EVENT,
  currentDate,
  isExternalAgentRuntime,
  type AgentArchivePendingOp,
  type AgentArchiveView,
  type AgentArchiveWorkspaceChoice,
} from "@botiverse/raft-shared";
import { and, eq, inArray, isNotNull, isNull, lt, or } from "drizzle-orm";
import type { Server as SocketServer } from "socket.io";
import { getDb, type DatabaseExecutor, type DatabaseTransaction } from "../db/index";
import {
  agentArchives,
  agentBootstrapTokens,
  agentCredentials,
  agents,
  machines,
  reminders,
} from "../db/schema";
import { cancelReminder } from "../apps/reminder/service";
import { mapWithConcurrency } from "../lib/mapWithConcurrency";
import { recordAgentCredentialsBulkRevoked, type ServerAuditContext } from "./integrationAuditService";
import { removeWeChatBridgeOfArchivedAssistant } from "./wechatBridgeCleanup";

/** A delete answers within 15s; anything older was lost. */
const DELETE_OP_LEASE_MS = 2 * 60_000;
/** Sends of one op before it is given up. */
const MAX_OP_ATTEMPTS = 5;

export type AgentArchiveRow = typeof agentArchives.$inferSelect;

export class AgentArchiveError extends Error {
  constructor(readonly code: string, readonly status: number, message = code) {
    super(message);
    this.name = "AgentArchiveError";
  }
}

/** The parts of the orchestrator the archive dispatch needs. */
export interface AgentArchiveDispatchPort {
  /** Computers connected to THIS replica. */
  localMachineIds(): string[];
  hasMachineLocally(machineId: string): boolean;
  /** `timed_out`: no answer within the wait; the Computer may still be deleting. */
  deleteMachineWorkspaceDir(machineId: string, directoryName: string): Promise<"deleted" | "failed" | "timed_out">;
}

/** Hosted (cloud) and external agents keep no workspace on a Computer. */
function hasComputerWorkspace(agent: { runtime: string; executionMode: string }): boolean {
  return agent.executionMode !== "cloud" && !isExternalAgentRuntime(agent.runtime);
}

/**
 * Inside the archive transaction, before `deleteAgent` clears `daemon_id`:
 * record where the workspace is and the op the user chose, cancel the agent's
 * reminders, and revoke its credentials and unused bootstrap tokens (they were
 * only unusable through the `deleted_at` join until now). A personal
 * assistant's WeChat binding goes too: its DM no longer has anyone to answer.
 */
export async function recordAgentArchive(tx: DatabaseExecutor, input: {
  agentId: string;
  userId: string;
  choice: AgentArchiveWorkspaceChoice;
  now?: Date;
  /** The audit context of the operation this archive is part of. */
  audit?: ServerAuditContext;
}): Promise<AgentArchiveRow> {
  const now = input.now ?? currentDate();
  const [agent] = await tx.select({
    id: agents.id,
    serverId: agents.serverId,
    machineId: agents.machineId,
    runtime: agents.runtime,
    executionMode: agents.executionMode,
    machineName: machines.name,
  })
    .from(agents)
    .leftJoin(machines, eq(machines.id, agents.machineId))
    .where(eq(agents.id, input.agentId))
    .for("update", { of: agents });
  if (!agent) throw new AgentArchiveError("agent_not_found", 404);
  const onComputer = hasComputerWorkspace(agent) && agent.machineId !== null;
  if (input.choice === "delete" && !onComputer) {
    throw new AgentArchiveError("archive_workspace_unavailable", 409, "This agent has no workspace on a Computer.");
  }
  const op: AgentArchivePendingOp | null = input.choice === "delete" ? "delete" : null;
  const [row] = await tx.insert(agentArchives).values({
    agentId: agent.id,
    serverId: agent.serverId,
    archivedAt: now,
    archivedByUserId: input.userId,
    machineId: onComputer ? agent.machineId : null,
    machineNameSnapshot: onComputer ? agent.machineName : null,
    // A hosted agent's provider deletes its workspace with the agent.
    workspaceState: onComputer ? "on_computer" : !hasComputerWorkspace(agent) ? "deleted" : "unknown",
    pendingOp: op,
    opId: op ? randomUUID() : null,
    opRequestedAt: op ? now : null,
    opRequestedByUserId: op ? input.userId : null,
    updatedAt: now,
  }).returning();

  const scheduled = await tx.select({ id: reminders.id, version: reminders.version })
    .from(reminders)
    .where(and(eq(reminders.ownerAgentId, agent.id), inArray(reminders.status, ["scheduled", "fired"])));
  for (const reminder of scheduled) {
    await cancelReminder(reminder.id, {
      executor: tx,
      expectedVersion: reminder.version,
      actor: { type: "human", id: input.userId },
    });
  }
  const revokedCredentials = await tx.update(agentCredentials).set({
    revokedAt: now,
    revokedReason: "agent_archived",
    revokedByUserId: input.userId,
  }).where(and(eq(agentCredentials.agentId, agent.id), isNull(agentCredentials.revokedAt)))
    .returning({ id: agentCredentials.id });
  await recordAgentCredentialsBulkRevoked({
    serverId: agent.serverId,
    agentId: agent.id,
    actorUserId: input.userId,
    revokedCount: revokedCredentials.length,
    reason: "agent_archived",
    audit: input.audit,
  }, tx);
  await tx.update(agentBootstrapTokens).set({
    revokedAt: now,
    revokedReason: "agent_archived",
    revokedByUserId: input.userId,
  }).where(and(
    eq(agentBootstrapTokens.targetAgentId, agent.id),
    isNull(agentBootstrapTokens.revokedAt),
    isNull(agentBootstrapTokens.consumedAt),
  ));
  await removeWeChatBridgeOfArchivedAssistant(tx, { agentId: agent.id, actorUserId: input.userId });
  return row;
}

export async function getAgentArchive(agentId: string, executor: DatabaseExecutor = getDb()): Promise<AgentArchiveRow | null> {
  const [row] = await executor.select().from(agentArchives).where(eq(agentArchives.agentId, agentId));
  return row ?? null;
}

export function toAgentArchiveView(row: AgentArchiveRow, port?: AgentArchiveDispatchPort | null): AgentArchiveView {
  return {
    agentId: row.agentId,
    archivedAt: row.archivedAt.toISOString(),
    archivedByUserId: row.archivedByUserId,
    machineId: row.machineId,
    machineName: row.machineNameSnapshot,
    workspaceState: row.workspaceState,
    pendingOp: row.pendingOp,
    // Only a replica that holds the connection knows it is online; others say
    // "waiting" until the op is dispatched.
    waitingForComputer: row.pendingOp !== null
      && row.opDispatchedAt === null
      && !(row.machineId && port?.hasMachineLocally(row.machineId)),
    lastErrorCode: row.lastErrorCode,
    lastErrorAt: row.lastErrorAt?.toISOString() ?? null,
  };
}

/** Ask to delete the workspace of an archived agent that kept it on its Computer. */
export async function requestAgentArchiveWorkspaceOp(input: {
  agentId: string;
  serverId: string;
  userId: string;
  op: AgentArchivePendingOp;
  now?: Date;
}, executor?: DatabaseTransaction): Promise<AgentArchiveRow> {
  const now = input.now ?? currentDate();
  const inTransaction = <T>(run: (tx: DatabaseTransaction) => Promise<T>) => executor ? run(executor) : getDb().transaction(run);
  return inTransaction(async (tx) => {
    const [agent] = await tx.select({ id: agents.id, serverId: agents.serverId, deletedAt: agents.deletedAt })
      .from(agents)
      .where(eq(agents.id, input.agentId));
    if (!agent || agent.serverId !== input.serverId || !agent.deletedAt) {
      throw new AgentArchiveError("agent_not_archived", 404, "Archived agent not found");
    }
    const [row] = await tx.select().from(agentArchives).where(eq(agentArchives.agentId, input.agentId)).for("update");
    if (!row || row.workspaceState !== "on_computer" || !row.machineId) {
      throw new AgentArchiveError("archive_workspace_unavailable", 409, "The workspace is not on a Computer.");
    }
    if (row.pendingOp) {
      throw new AgentArchiveError("archive_op_pending", 409, "Another workspace operation is still running.");
    }
    const [updated] = await tx.update(agentArchives).set({
      pendingOp: input.op,
      opId: randomUUID(),
      opRequestedAt: now,
      opRequestedByUserId: input.userId,
      opDispatchedAt: null,
      opAttempts: 0,
      lastErrorCode: null,
      lastErrorAt: null,
      updatedAt: now,
    }).where(eq(agentArchives.agentId, input.agentId)).returning();
    return updated;
  });
}

/** Claimable now: an op is pending and its lease is free or expired. */
function claimableArchiveOpFilter(now: Date) {
  return and(
    isNotNull(agentArchives.pendingOp),
    or(
      isNull(agentArchives.opDispatchedAt),
      lt(agentArchives.opDispatchedAt, new Date(now.getTime() - DELETE_OP_LEASE_MS)),
    ),
  );
}

/**
 * Which of these Computers have a claimable op: one read, no lock, through
 * idx_agent_archives_pending. Almost always none, so a sweep costs one query
 * instead of a locking transaction per connected Computer (prod 10-16: a
 * reconnect wave ran 100-134 of those per `ready`, 800 ms each waiting on the
 * pool).
 */
async function machinesWithClaimableArchiveOps(machineIds: readonly string[], now: Date): Promise<string[]> {
  if (machineIds.length === 0) return [];
  const rows = await getDb().selectDistinct({ machineId: agentArchives.machineId }).from(agentArchives)
    .where(and(inArray(agentArchives.machineId, [...machineIds]), claimableArchiveOpFilter(now)));
  return rows.flatMap((row) => (row.machineId ? [row.machineId] : []));
}

/** Claim the ops of one connected Computer whose lease is free or expired. */
async function claimArchiveOps(machineId: string, now: Date): Promise<AgentArchiveRow[]> {
  return getDb().transaction(async (tx) => {
    const candidates = await tx.select().from(agentArchives)
      .where(and(eq(agentArchives.machineId, machineId), claimableArchiveOpFilter(now)))
      .for("update", { skipLocked: true });
    const claimed: AgentArchiveRow[] = [];
    for (const row of candidates) {
      const [updated] = await tx.update(agentArchives).set({
        opDispatchedAt: now,
        opAttempts: row.opAttempts + 1,
        updatedAt: now,
      }).where(eq(agentArchives.agentId, row.agentId)).returning();
      claimed.push(updated);
    }
    return claimed;
  });
}

/** Ends the current op. Without `workspaceState` the workspace stays where it is. */
async function finishOp(agentId: string, opId: string, outcome: {
  errorCode?: string;
  workspaceState?: "deleted";
}, now: Date): Promise<AgentArchiveRow | null> {
  const [row] = await getDb().update(agentArchives).set({
    pendingOp: null,
    opId: null,
    opDispatchedAt: null,
    opAttempts: 0,
    lastErrorCode: outcome.errorCode ?? null,
    lastErrorAt: outcome.errorCode ? now : null,
    ...(outcome.workspaceState ? { workspaceState: outcome.workspaceState } : {}),
    updatedAt: now,
  }).where(and(eq(agentArchives.agentId, agentId), eq(agentArchives.opId, opId))).returning();
  return row ?? null;
}

/** A transient failure: free the lease so the next sweep sends it again. */
async function releaseOpForRetry(agentId: string, opId: string, errorCode: string, now: Date): Promise<AgentArchiveRow | null> {
  const [row] = await getDb().update(agentArchives).set({
    opDispatchedAt: null,
    lastErrorCode: errorCode,
    lastErrorAt: now,
    updatedAt: now,
  }).where(and(eq(agentArchives.agentId, agentId), eq(agentArchives.opId, opId))).returning();
  return row ?? null;
}

/** One dispatch run per Computer at a time; a run for one Computer never holds up another. */
const dispatchInFlight = new Map<string, Promise<void>>();

/** A Computer that has not answered by then is treated as unreachable and asked again later. */
const DISPATCH_OP_TIMEOUT_MS = 60_000;

/**
 * Send every claimable op of the Computers connected to this replica, or only
 * of `machineIds` (a Computer that just sent `ready`: its own ops only; the
 * 30 s sweep covers the rest). Safe to call often: a call for a Computer whose
 * run is still going joins that run, and the claim is a lease.
 */
export async function dispatchPendingAgentArchiveOps(
  port: AgentArchiveDispatchPort,
  io?: SocketServer | null,
  options: { opTimeoutMs?: number; machineIds?: readonly string[] } = {},
): Promise<void> {
  const startOrJoin = (machineId: string): Promise<void> => {
    const running = dispatchInFlight.get(machineId);
    if (running) return running;
    const run = dispatchMachine(port, machineId, io, options.opTimeoutMs ?? DISPATCH_OP_TIMEOUT_MS)
      .catch((err) => console.warn("[agent-archive] dispatch failed", { machineId, err }))
      // Cleared only after it is registered, even if the run ended at once.
      .finally(() => {
        if (dispatchInFlight.get(machineId) === run) dispatchInFlight.delete(machineId);
      });
    dispatchInFlight.set(machineId, run);
    return run;
  };
  const local = options.machineIds
    ? options.machineIds.filter((machineId) => port.hasMachineLocally(machineId))
    : port.localMachineIds();
  const withOps = await machinesWithClaimableArchiveOps(local, currentDate());
  // Each run claims in its own transaction; a few Computers at a time.
  await mapWithConcurrency(withOps, 4, startOrJoin);
}

async function dispatchMachine(port: AgentArchiveDispatchPort, machineId: string, io: SocketServer | null | undefined, opTimeoutMs: number): Promise<void> {
  const claimed = await claimArchiveOps(machineId, currentDate());
  for (const row of claimed) {
    const updated = await dispatchOne(port, row, opTimeoutMs).catch((err) => {
      console.warn("[agent-archive] dispatch failed", { agentId: row.agentId, err });
      return null;
    });
    emitAgentArchiveUpdated(io, updated ?? row);
  }
}

function withTimeout<T>(promise: Promise<T>, timeoutMs: number): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error("agent archive op timed out")), timeoutMs);
  });
  return Promise.race([promise, timeout]).finally(() => clearTimeout(timer));
}

async function dispatchOne(port: AgentArchiveDispatchPort, row: AgentArchiveRow, opTimeoutMs: number): Promise<AgentArchiveRow | null> {
  const now = currentDate();
  if (!row.pendingOp || !row.opId || !row.machineId) return row;
  if (row.opAttempts > MAX_OP_ATTEMPTS) {
    // After a timeout the Computer may still be deleting, or may be done; asking again tells.
    const errorCode = row.lastErrorCode === "ARCHIVE_DELETE_TIMED_OUT" ? "ARCHIVE_DELETE_UNCONFIRMED" : "ARCHIVE_ATTEMPTS_EXHAUSTED";
    return finishOp(row.agentId, row.opId, { errorCode }, now);
  }
  let result: "deleted" | "failed" | "timed_out";
  try {
    result = await withTimeout(port.deleteMachineWorkspaceDir(row.machineId, row.agentId), opTimeoutMs);
  } catch {
    return releaseOpForRetry(row.agentId, row.opId, "ARCHIVE_COMPUTER_UNREACHABLE", now);
  }
  // A delete of a missing directory succeeds, so asking again is how a slow one is confirmed.
  if (result === "timed_out") return releaseOpForRetry(row.agentId, row.opId, "ARCHIVE_DELETE_TIMED_OUT", now);
  return result === "deleted"
    ? finishOp(row.agentId, row.opId, { workspaceState: "deleted" }, now)
    : releaseOpForRetry(row.agentId, row.opId, "ARCHIVE_DELETE_FAILED", now);
}

/**
 * Tells the server's clients that an archive changed. Only the agent id goes
 * out: the details are read back through the permission-checked
 * `GET /agents/:id/archive`. A personal assistant's goes to its owner only.
 */
export function emitAgentArchiveUpdated(
  io: SocketServer | null | undefined,
  row: Pick<AgentArchiveRow, "agentId" | "serverId">,
  assistantOwnerUserId: string | null = null,
): void {
  io?.to(agentEventRoom(row.serverId, assistantOwnerUserId)).emit(AGENT_ARCHIVE_UPDATED_EVENT, { agentId: row.agentId });
}

/** The Computer panel removed the directory itself. */
export async function markAgentArchiveWorkspaceDeleted(agentId: string, machineId: string, now: Date = currentDate()): Promise<void> {
  await getDb().update(agentArchives).set({ workspaceState: "deleted", updatedAt: now })
    .where(and(eq(agentArchives.agentId, agentId), eq(agentArchives.machineId, machineId), isNull(agentArchives.pendingOp)));
}

export interface ArchivedAgentListEntry {
  agentId: string;
  name: string;
  displayName: string | null;
  avatarUrl: string | null;
  creatorType: "user" | "agent" | null;
  creatorId: string | null;
  createdAt: string;
  archivedAt: string;
  archivedByUserId: string | null;
  workspaceState: AgentArchiveView["workspaceState"];
  pendingOp: AgentArchivePendingOp | null;
  machineName: string | null;
}

/** Archived agents of a server, newest first, with their archive records when they have one. */
/** Another person's archived personal assistant is left out (agentFindableBy). */
export async function listArchivedAgents(serverId: string, viewerUserId: string): Promise<ArchivedAgentListEntry[]> {
  const rows = await getDb().select({ agent: agents, archive: agentArchives })
    .from(agents)
    .leftJoin(agentArchives, eq(agentArchives.agentId, agents.id))
    .where(and(eq(agents.serverId, serverId), isNotNull(agents.deletedAt), agentFindableBy({ userId: viewerUserId })));
  return rows
    .map(({ agent, archive }) => ({
      agentId: agent.id,
      name: agent.name,
      displayName: agent.displayName,
      avatarUrl: agent.avatarUrl,
      creatorType: agent.creatorType,
      creatorId: agent.creatorId,
      createdAt: agent.createdAt.toISOString(),
      archivedAt: (archive?.archivedAt ?? agent.deletedAt!).toISOString(),
      archivedByUserId: archive?.archivedByUserId ?? null,
      workspaceState: archive?.workspaceState ?? "unknown",
      pendingOp: archive?.pendingOp ?? null,
      machineName: archive?.machineNameSnapshot ?? null,
    }))
    .sort((left, right) => right.archivedAt.localeCompare(left.archivedAt) || left.name.localeCompare(right.name));
}
