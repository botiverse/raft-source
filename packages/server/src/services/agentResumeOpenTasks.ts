// The open tasks an `agent:start` of a resumed session names (`openTasks`),
// so the daemon's resume input does not tell an agent that still holds
// unfinished work that there is nothing to do.
import type { AgentStartOpenTasks, AgentStartOpenTaskStatus } from "@botiverse/raft-shared";
import { formatAgentTaskRef } from "@botiverse/raft-shared";

import { resolveAgentTaskSurfaces, type AgentTaskSurface } from "./agentAssignedTaskSurfaces";
import * as taskService from "./taskService";

/** At most this many tasks are named; the rest are counted (`more`). */
export const AGENT_RESUME_OPEN_TASKS_LISTED = 5;

/**
 * The statuses the agent itself has to act on. `in_review` is left out: it
 * waits on someone else (and is no longer set; see the CLI guide).
 */
export const AGENT_RESUME_OPEN_TASK_STATUSES = ["todo", "in_progress"] as const satisfies readonly AgentStartOpenTaskStatus[];

type OpenTaskRow = { taskNumber: number; title: string; status: string; channelId: string };

function isResumeOpenTaskStatus(status: string): status is AgentStartOpenTaskStatus {
  return (AGENT_RESUME_OPEN_TASK_STATUSES as readonly string[]).includes(status);
}

/**
 * Rows read through the agent's task surfaces, as the start names them: each
 * by its agent-facing ref (`#channel:#7`, `dm:@peer:#7`; formatAgentTaskRef,
 * as the idle task reminder), in the rows' order. A row with no surface or ref
 * is not named but still counted in `more`. Null when no task can be named.
 */
export function toAgentStartOpenTasks(
  rows: readonly OpenTaskRow[],
  total: number,
  surfaces: ReadonlyMap<string, AgentTaskSurface>,
): AgentStartOpenTasks | null {
  const tasks: AgentStartOpenTasks["tasks"] = [];
  for (const row of rows) {
    if (!isResumeOpenTaskStatus(row.status)) continue;
    const surface = surfaces.get(row.channelId);
    if (!surface) continue;
    const ref = formatAgentTaskRef(surface.channelRef, row.taskNumber);
    if (!ref) continue;
    tasks.push({ ref, title: row.title, status: row.status });
  }
  // The daemon lists tasks by name: with none to name there is nothing to show.
  if (tasks.length === 0) return null;
  return { tasks, more: Math.max(0, total - tasks.length) };
}

/**
 * The open tasks (todo / in_progress) assigned to the agent, read through its
 * own task surfaces like `raft task list --mine`: the few most recently
 * updated by name, the rest counted. Null when it holds none. Bounded: one
 * surface resolution, one limited read and one count.
 */
export async function listAgentResumeOpenTasks(agent: { id: string; serverId: string }): Promise<AgentStartOpenTasks | null> {
  const surfaces = await resolveAgentTaskSurfaces(agent.serverId, agent.id);
  if (surfaces.size === 0) return null;
  const { rows, total } = await taskService.listRecentTasksAssignedToAgent(
    [...surfaces.keys()],
    agent.id,
    AGENT_RESUME_OPEN_TASKS_LISTED,
    { statuses: AGENT_RESUME_OPEN_TASK_STATUSES },
  );
  return toAgentStartOpenTasks(rows, total, surfaces);
}
