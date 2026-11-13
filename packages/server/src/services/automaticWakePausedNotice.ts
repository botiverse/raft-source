import { asServerId, formatRaftChannelTaskRef, formatRaftDmTaskRef } from "@botiverse/raft-shared";
import type { Server as SocketServer } from "socket.io";
import { getDb } from "../db/index";
import { postAgentActionRequiredNotice } from "./agentActionRequiredNoticeService";
import { resolveAgentTaskSurfaces } from "./agentAssignedTaskSurfaces";
import type { AgentOrchestrator } from "./agentOrchestrator";
import * as agentService from "./agentService";
import * as channelService from "./channelService";
import { findAgentOwner } from "./computerAgents";
import * as taskService from "./taskService";

/** At most this many tasks are named in the notice; the rest are counted. */
export const AUTOMATIC_WAKE_PAUSED_LISTED_TASKS = 5;

export type AutomaticWakePausedTasks = {
  tasks: Array<{ ref: string; title: string }>;
  moreTasks: number;
  hiddenTasks: number;
};

/**
 * The open tasks (todo / in_progress / in_review) assigned to the agent, as
 * its owner may see them: named (ref and title, most recently updated first)
 * only in channels the owner can read (filterUserAccessibleChannelIds, the
 * batched canUserAccessChannel), otherwise only counted. Read through the
 * agent's own task surfaces, like `raft task list --mine`; bounded to the
 * named few plus counts.
 */
export async function listAutomaticWakePausedTasks(
  agent: { id: string; name: string; serverId: string },
  ownerUserId: string,
): Promise<AutomaticWakePausedTasks> {
  const surfaces = await resolveAgentTaskSurfaces(agent.serverId, agent.id);
  if (surfaces.size === 0) return { tasks: [], moreTasks: 0, hiddenTasks: 0 };
  const localChannelIds = [...new Set([...surfaces.values()].map((surface) => surface.localChannel.id))];
  const visibleLocal = await channelService.filterUserAccessibleChannelIds(localChannelIds, ownerUserId, asServerId(agent.serverId));
  const visibleKeys: string[] = [];
  const hiddenKeys: string[] = [];
  for (const [key, surface] of surfaces) (visibleLocal.has(surface.localChannel.id) ? visibleKeys : hiddenKeys).push(key);
  const [visible, hiddenTasks] = await Promise.all([
    taskService.listRecentTasksAssignedToAgent(visibleKeys, agent.id, AUTOMATIC_WAKE_PAUSED_LISTED_TASKS),
    taskService.countTasksAssignedToAgent(hiddenKeys, agent.id),
  ]);
  const tasks: Array<{ ref: string; title: string }> = [];
  for (const row of visible.rows) {
    const channel = surfaces.get(row.channelId)?.localChannel;
    if (!channel) continue;
    // A DM the owner can read is their own DM with the agent.
    const ref = channel.type === "dm"
      ? formatRaftDmTaskRef(agent.name, row.taskNumber)
      : formatRaftChannelTaskRef(channel.name, row.taskNumber);
    tasks.push({ ref, title: row.title });
  }
  return { tasks, moreTasks: Math.max(0, visible.total - tasks.length), hiddenTasks };
}

/**
 * Tells the agent's owner (a personal assistant's person, else its human
 * creator; findAgentOwner) that the early-exit breaker paused its automatic
 * wakes, with the open tasks it holds. The caller posts this once per trip:
 * on the exit that moved the breaker to blocked (`blockedNow`), never on later
 * exits while it stays blocked. False when there is no owner to tell.
 * At most once, not exactly once: if this replica stops or the post fails
 * after the trip was recorded, the trip goes unannounced (a best-effort
 * notice; the agent page still shows the pause).
 */
export async function postAutomaticWakePausedNotice(
  io: SocketServer,
  agentOrchestrator: AgentOrchestrator,
  input: { agentId: string; earlyExits: number },
): Promise<boolean> {
  // getDb() first: if it throws, the getAgent read must not be left running
  // with nobody awaiting its rejection.
  const db = getDb();
  const [agent, owner] = await Promise.all([
    agentService.getAgent(input.agentId, false, { dbCallsite: "automatic_wake_paused_notice.get_agent" }),
    findAgentOwner(db, input.agentId),
  ]);
  if (!agent || !owner) return false;
  const tasks = await listAutomaticWakePausedTasks(agent, owner.id);
  return postAgentActionRequiredNotice(io, agentOrchestrator, {
    agentId: agent.id,
    ownerUserId: owner.id,
    notice: { kind: "automatic_wake_paused", earlyExits: input.earlyExits, ...tasks },
  });
}
