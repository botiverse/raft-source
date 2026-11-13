/**
 * A personal assistant's lifecycle is its owner's alone. A server owner/admin
 * keeps one safety switch, Stop, which pauses the assistant: nothing wakes it
 * (doorbell, brief, chat) until its owner starts it again. When it is paused,
 * the owner is told in their DM with the assistant. (The audit event joins the
 * shared server audit table once it lands; until then every stop is traced.)
 */
import { and, eq, inArray, isNotNull, isNull } from "drizzle-orm";
import type { Server as SocketServer } from "socket.io";
import type { ServerRole } from "@botiverse/raft-shared";
import { getDb, type DatabaseExecutor } from "../db/index";
import { agents } from "../db/schema";
import type { AgentOrchestrator } from "./agentOrchestrator";
import * as channelService from "./channelService";
import * as messageService from "./messageService";
import * as userService from "./userService";
import { recordTraceEvent } from "../tracing/semanticTrace";
import { FencedAuthorizationDeniedError, withActorMembershipFence } from "../lib/actorMembershipFence";
import { decideAgentResourceAuthority } from "../lib/actorPermissions";
import { isExternalAgentRuntime } from "@botiverse/raft-shared";
import { stopHostedAgentTurn } from "./agentRuntimeProvisionService";
import { emitAgentArchiveUpdated } from "./agentArchiveService";
import { agentEventRoom } from "../socket/platformScope";

/** True when this caller's stop of `agent` is a server owner/admin stopping someone else's assistant. */
export function isAdminStopOfAssistant(agent: { assistantOwnerUserId: string | null }, userId: string): agent is { assistantOwnerUserId: string } {
  return agent.assistantOwnerUserId !== null && agent.assistantOwnerUserId !== userId;
}

/**
 * Pause the assistant for an admin. True only for the stop that paused it, so
 * repeated stops while it stays paused do not notify the owner again.
 */
export async function pauseAssistant(tx: DatabaseExecutor, agentId: string, byUserId: string): Promise<boolean> {
  const paused = await tx.update(agents)
    .set({ assistantPausedAt: new Date(), assistantPausedByUserId: byUserId })
    .where(and(eq(agents.id, agentId), isNotNull(agents.assistantOwnerUserId), isNull(agents.assistantPausedAt)))
    .returning({ id: agents.id });
  return paused.length > 0;
}

/** The owner starts their paused assistant again. True when it was paused. */
export async function resumeAssistant(tx: DatabaseExecutor, agentId: string): Promise<boolean> {
  const resumed = await tx.update(agents)
    .set({ assistantPausedAt: null, assistantPausedByUserId: null })
    .where(and(eq(agents.id, agentId), isNotNull(agents.assistantPausedAt)))
    .returning({ id: agents.id });
  return resumed.length > 0;
}

/** Every stop of an assistant, by its owner or an admin: who, whose, and what happened. */
export function traceAssistantStop(input: {
  agentId: string;
  ownerUserId: string;
  actorUserId: string;
  byAdmin: boolean;
  paused: boolean;
  result: string;
}): void {
  recordTraceEvent("server.assistant.stop", {
    agent_id: input.agentId,
    subject_user_id: input.ownerUserId,
    actor_user_id: input.actorUserId,
    by_admin: input.byAdmin,
    newly_paused: input.paused,
    result: input.result,
  });
}

/**
 * Tell the owner an admin paused their assistant. Never throws: the pause
 * already happened. A notice that could not be sent is traced as
 * `server.assistant.stop_notice.failed`, so an unannounced pause can be found.
 */
export async function noticeAssistantPausedByAdmin(input: {
  io: SocketServer | undefined;
  orchestrator: AgentOrchestrator;
  serverId: string;
  agentId: string;
  ownerUserId: string;
  adminUserId: string;
  adminRole: ServerRole | null;
}): Promise<void> {
  const attrs = { agent_id: input.agentId, subject_user_id: input.ownerUserId, actor_user_id: input.adminUserId };
  const failed = (reason: string) => recordTraceEvent("server.assistant.stop_notice.failed", { ...attrs, reason });
  try {
    if (!input.io) {
      failed("no_socket_server");
      return;
    }
    const dm = await channelService.findOrCreateDM(input.serverId, input.ownerUserId, input.agentId);
    if (!dm) {
      failed("no_owner_dm");
      return;
    }
    const admin = await userService.getUser(input.adminUserId);
    const role = input.adminRole === "owner" ? "server owner" : "server admin";
    const adminName = admin?.displayName || admin?.name || `A ${role}`;
    await messageService.broadcastSystemMessage(
      input.io,
      input.orchestrator,
      dm.id,
      `${adminName} (${role}) paused your assistant. It won't respond to anything until you start it again.`,
      {
        inboxFactPolicy: {
          mode: "record",
          producer: "assistant.stopped_by_admin",
          reason: "the owner learns when an admin pauses their assistant",
          causalActor: { type: "user", id: input.adminUserId },
        },
        // The assistant is paused; this is for its owner.
        targetAgentIds: [],
      },
    );
    recordTraceEvent("server.assistant.stop_notice", attrs);
  } catch (err) {
    failed(err instanceof Error ? err.name : "error");
  }
}

/**
 * The assistants among `agentIds`, keyed by id, with the fields
 * `decideAgentResourceAuthority` needs: bulk runtime controls (a channel's
 * stop-all / resume-all) decide each assistant on its own.
 */
export async function assistantsAmong(agentIds: readonly string[]): Promise<Map<string, { id: string; runtime: string; creatorType: string | null; creatorId: string | null; assistantOwnerUserId: string }>> {
  if (agentIds.length === 0) return new Map();
  const rows = await getDb()
    .select({ id: agents.id, runtime: agents.runtime, creatorType: agents.creatorType, creatorId: agents.creatorId, assistantOwnerUserId: agents.assistantOwnerUserId })
    .from(agents)
    .where(and(inArray(agents.id, [...agentIds]), isNotNull(agents.assistantOwnerUserId)));
  return new Map(rows.map((row) => [row.id, { ...row, assistantOwnerUserId: row.assistantOwnerUserId! }]));
}

export type AssistantStopOutcome =
  | { ok: true; result: string; paused: boolean; appliesOnReconnect?: boolean }
  | { ok: false; code: "hosted_stop_failed" | "not_hosted"; paused: boolean };

/**
 * Stop a personal assistant, the one path for its Stop button and a channel's
 * stop-all. Its owner stops the current turn. A server owner/admin pauses it
 * (re-decided under the actor membership fence) and then stops the current
 * turn; the owner is told only once the pause took, and only for the stop that
 * paused it. Every stop is traced.
 */
export async function stopAssistant(input: {
  io: SocketServer | undefined;
  orchestrator: AgentOrchestrator;
  serverId: string;
  agent: { id: string; runtime: string; creatorType: string | null; creatorId: string | null; assistantOwnerUserId: string };
  actorUserId: string;
}): Promise<AssistantStopOutcome> {
  const { agent } = input;
  const byAdmin = isAdminStopOfAssistant(agent, input.actorUserId);
  let paused = false;
  let actorRole: ServerRole | null = null;
  if (byAdmin) {
    paused = await withActorMembershipFence(input.serverId, input.actorUserId, async (tx, lockedRole) => {
      actorRole = lockedRole;
      const [locked] = await tx
        .select({ serverId: agents.serverId, creatorType: agents.creatorType, creatorId: agents.creatorId, assistantOwnerUserId: agents.assistantOwnerUserId })
        .from(agents)
        .where(and(eq(agents.id, agent.id), isNull(agents.deletedAt)))
        .for("update");
      if (!locked || locked.serverId !== input.serverId) throw new FencedAuthorizationDeniedError("not_found");
      if (decideAgentResourceAuthority(lockedRole, input.actorUserId, locked, "controlAgentRuntime", { stop: true }) !== "allowed") {
        throw new FencedAuthorizationDeniedError("forbidden");
      }
      return pauseAssistant(tx, agent.id, input.actorUserId);
    });
  }
  let outcome: AssistantStopOutcome | null = null;
  try {
    if (isExternalAgentRuntime(agent.runtime)) {
      // A hosted assistant: the provider ends the running turn; the pause keeps it from waking again.
      const hosted = await stopHostedAgentTurn(agent.id, input.serverId);
      outcome = hosted.kind === "failed" || hosted.kind === "not_hosted"
        ? { ok: false, code: hosted.kind === "failed" ? "hosted_stop_failed" : "not_hosted", paused }
        : { ok: true, result: hosted.kind, paused };
    } else {
      // An admin's pause is a person's Stop: `owner_stop` ends the assistant's `raft proc` jobs too.
      const stopped = await input.orchestrator.stopAgent(agent.id, "manual", { daemonReason: "owner_stop" });
      outcome = { ok: true, result: "stopped", paused, ...(stopped?.delivered === false ? { appliesOnReconnect: true } : {}) };
    }
  } finally {
    // Traced however the turn stop went (a pause already written is never untraced).
    traceAssistantStop({
      agentId: agent.id,
      ownerUserId: agent.assistantOwnerUserId,
      actorUserId: input.actorUserId,
      byAdmin,
      paused,
      result: outcome ? (outcome.ok ? outcome.result : outcome.code) : "error",
    });
    if (paused) {
      // The agent payload shows the pause: its owner's clients re-read it (only
      // the owner finds an assistant; it is in no joint channel).
      input.io?.to(agentEventRoom(input.serverId, agent.assistantOwnerUserId)).emit("agent:updated", { agentId: agent.id });
      await noticeAssistantPausedByAdmin({
      io: input.io,
      orchestrator: input.orchestrator,
      serverId: input.serverId,
      agentId: agent.id,
      ownerUserId: agent.assistantOwnerUserId,
        adminUserId: input.actorUserId,
        adminRole: actorRole,
      });
    }
  }
  return outcome;
}

/**
 * The pause as an agent payload shows it: `assistantPausedAt` to everyone who
 * sees the agent; who paused it (`assistantPausedBy`) only to its owner and
 * server owners/admins. The raw `assistantPausedByUserId` never leaves.
 */
export async function projectAssistantPause<T extends { assistantOwnerUserId?: string | null; assistantPausedAt?: Date | string | null; assistantPausedByUserId?: string | null }>(
  rows: readonly T[],
  viewer: { userId: string; role: ServerRole | null },
): Promise<Array<Omit<T, "assistantPausedByUserId"> & { assistantPausedBy?: { id: string; name: string } | null }>> {
  const names = new Map<string, string>();
  for (const row of rows) {
    const by = row.assistantPausedAt ? row.assistantPausedByUserId : null;
    if (!by || names.has(by)) continue;
    const user = await userService.getUser(by);
    names.set(by, user?.displayName || user?.name || "");
  }
  return rows.map((row) => {
    const { assistantPausedByUserId, ...rest } = row;
    if (!row.assistantPausedAt) return rest;
    const mayKnow = row.assistantOwnerUserId === viewer.userId || viewer.role === "owner" || viewer.role === "admin";
    return mayKnow && assistantPausedByUserId
      ? { ...rest, assistantPausedBy: { id: assistantPausedByUserId, name: names.get(assistantPausedByUserId) ?? "" } }
      : rest;
  });
}

/**
 * After `removeMember` archived a departing owner's assistants: tell the
 * owner's clients as an archive does. Nobody else ever found them.
 */
export function announceArchivedAssistants(io: SocketServer | undefined, orchestrator: AgentOrchestrator | undefined, serverId: string, ownerUserId: string, agentIds: readonly string[]): void {
  for (const agentId of agentIds) {
    orchestrator?.evictCache(agentId);
    orchestrator?.forgetAgentActivity?.(agentId);
    emitAgentArchiveUpdated(io, { agentId, serverId }, ownerUserId);
    io?.to(agentEventRoom(serverId, ownerUserId)).emit("agent:deleted", { agentId });
  }
}
