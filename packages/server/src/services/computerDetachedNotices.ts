import { and, asc, eq, inArray, isNull, or } from "drizzle-orm";
import type { Server as SocketServer } from "socket.io";
import { getDb } from "../db/index";
import { agents, serverMembers } from "../db/schema";
import { postAgentActionRequiredNotice } from "./agentActionRequiredNoticeService";
import type { AgentOrchestrator } from "./agentOrchestrator";
import type { DetachedComputer, MemberDepartureReason } from "./computerKeyRevocation";

/**
 * After a Computer is detached (its key revoked, computerKeyRevocation.ts),
 * tells the owner of each live agent bound to its machine that the agent is
 * offline and needs another computer. In a shared server other members can
 * host agents on someone's computer; without this those agents went offline
 * silently (Tenny, #triage, 2026-11-02). Whoever detached it is not told about
 * their own agents. Best effort, after commit: a failed notice never fails the
 * detach.
 */
export async function noticeOwnersOfDetachedComputer(
  io: SocketServer | null | undefined,
  agentOrchestrator: AgentOrchestrator | null | undefined,
  detached: DetachedComputer | null | undefined,
  options: { actorUserId?: string; agentIds?: readonly string[]; removed?: boolean } = {},
): Promise<number> {
  if (!detached || !io || !agentOrchestrator) return 0;
  try {
    // Explicit ids: agents already unbound from a deleted computer (accountDeletion/cleanup.ts).
    const bound = await getDb().select({ id: agents.id, creatorType: agents.creatorType, creatorId: agents.creatorId })
      .from(agents)
      .where(and(
        options.agentIds ? inArray(agents.id, [...options.agentIds]) : eq(agents.machineId, detached.machineId),
        eq(agents.serverId, detached.serverId),
        isNull(agents.deletedAt),
      ));
    let sent = 0;
    for (const agent of bound) {
      if (agent.creatorType !== "user" || agent.creatorId === options.actorUserId) continue;
      const posted = await postAgentActionRequiredNotice(io, agentOrchestrator, {
        agentId: agent.id,
        notice: { kind: "computer_detached", computerName: detached.computerName, removed: options.removed },
      }).catch((err) => {
        console.warn("[computerDetachedNotices] notice failed", { agentId: agent.id, err });
        return false;
      });
      if (posted) sent += 1;
    }
    return sent;
  } catch (err) {
    console.warn("[computerDetachedNotices] lookup failed", { machineId: detached.machineId, err });
    return 0;
  }
}

/**
 * After a member removal's commit (serverService.ts removeMember: someone left,
 * was removed, or deleted their account): the Computers revoked with the
 * membership. Each one's agents are told about with the `member_left` reason,
 * and the server's Computers list refreshes. Best effort.
 *
 * Whom (Tenny, Warden, 2026-11-09): an agent's creator while they are still in
 * the server and are not the person who left; otherwise every owner of the
 * server, one notice per owner per Computer listing its agents. Read after the
 * removal committed, so an owner made just before the leave is found and the
 * person who left is never told. `departedUserId` is the person whose
 * membership ended, not whoever removed them.
 */
export async function announceComputersRevokedWithMembership(
  io: SocketServer | null | undefined,
  agentOrchestrator: AgentOrchestrator | null | undefined,
  detached: readonly DetachedComputer[],
  departedUserId: string,
  /** The revoke's own (computerKeyRevocation.ts `member_removed`): an account deletion reads its own text. */
  departureReason: MemberDepartureReason,
): Promise<void> {
  if (detached.length === 0) return;
  if (io && agentOrchestrator) {
    try {
      await noticeMemberLeftComputers(io, agentOrchestrator, detached, departedUserId, departureReason);
    } catch (err) {
      console.warn("[computerDetachedNotices] lookup failed", { machineIds: detached.map((computer) => computer.machineId), err });
    }
  }
  for (const computer of detached) {
    io?.to(`server:${computer.serverId}`).emit("machine:updated", { serverId: computer.serverId, machineId: computer.machineId });
  }
}

/**
 * The agents on every revoked Computer, then, in one read, the people who may
 * be told: each server's owners and those agents' creators still in it. Per
 * Computer: its agents' creators who stay, else the owners.
 */
async function noticeMemberLeftComputers(
  io: SocketServer,
  agentOrchestrator: AgentOrchestrator,
  detached: readonly DetachedComputer[],
  departedUserId: string,
  departureReason: MemberDepartureReason,
): Promise<void> {
  const db = getDb();
  const serverIds = [...new Set(detached.map((computer) => computer.serverId))];
  const bound = await db.select({ id: agents.id, name: agents.name, serverId: agents.serverId, machineId: agents.machineId, creatorType: agents.creatorType, creatorId: agents.creatorId })
    .from(agents)
    .where(and(
      inArray(agents.machineId, detached.map((computer) => computer.machineId)),
      inArray(agents.serverId, serverIds),
      isNull(agents.deletedAt),
    ))
    .orderBy(asc(agents.name), asc(agents.id));
  if (bound.length === 0) return;
  const creatorIds = [...new Set(bound.flatMap((agent) => (agent.creatorType === "user" && agent.creatorId ? [agent.creatorId] : [])))];
  const members = await db.select({ serverId: serverMembers.serverId, userId: serverMembers.userId, role: serverMembers.role })
    .from(serverMembers)
    .where(and(
      inArray(serverMembers.serverId, serverIds),
      creatorIds.length > 0 ? or(eq(serverMembers.role, "owner"), inArray(serverMembers.userId, creatorIds)) : eq(serverMembers.role, "owner"),
    ));
  const others = members.filter((member) => member.userId !== departedUserId);

  for (const computer of detached) {
    const onIt = bound.filter((agent) => agent.machineId === computer.machineId && agent.serverId === computer.serverId);
    if (onIt.length === 0) continue;
    const here = others.filter((member) => member.serverId === computer.serverId);
    const stillMember = new Set(here.map((member) => member.userId));
    const toOwners = onIt.filter((agent) => !(agent.creatorType === "user" && agent.creatorId && stillMember.has(agent.creatorId)));
    const post = (agentId: string, ownerUserId: string, agentNames?: string[]) => postAgentActionRequiredNotice(io, agentOrchestrator, {
      agentId,
      ownerUserId,
      notice: { kind: "computer_detached", computerName: computer.computerName, reason: "member_left", departureReason, ...(agentNames ? { agentNames } : {}) },
    }).catch((err) => {
      console.warn("[computerDetachedNotices] notice failed", { agentId, err });
      return false;
    });
    for (const agent of onIt) {
      if (!toOwners.includes(agent)) await post(agent.id, agent.creatorId!);
    }
    if (toOwners.length === 0) continue;
    const agentNames = toOwners.map((agent) => agent.name);
    for (const owner of here.filter((member) => member.role === "owner")) {
      // One notice, in the DM with the first of the agents that has one with
      // this owner (a personal assistant's only DM is with its own person).
      for (const agent of toOwners) {
        if (await post(agent.id, owner.userId, agentNames)) break;
      }
    }
  }
}
