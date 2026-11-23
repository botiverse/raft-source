// The `openTasks` of a server `agent:start` (AgentStartOpenTasks), checked
// once where the frame enters the daemon (core.ts). Everything downstream
// (the hosts, planStartupInput, the resume surfaces) trusts the typed value.
import type { AgentStartOpenTasks, AgentStartOpenTaskStatus } from "@botiverse/raft-shared";

/** More than the server ever names (5); a longer list is cut here and counted. */
export const MAX_AGENT_START_OPEN_TASKS = 20;

const STATUSES: ReadonlySet<string> = new Set<AgentStartOpenTaskStatus>(["todo", "in_progress"]);

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * The frame's `openTasks` as the daemon uses it: entries that are not a task
 * with a non-empty string ref, a string title and a known status are dropped;
 * `more` becomes a non-negative integer (0 when it is not a finite number),
 * plus any tasks cut beyond MAX_AGENT_START_OPEN_TASKS. Undefined when no
 * task is left to name (absent, malformed, or empty): the start then has no
 * open tasks, as from an older server.
 */
export function normalizeAgentStartOpenTasks(value: unknown): AgentStartOpenTasks | undefined {
  if (!isRecord(value) || !Array.isArray(value.tasks)) return undefined;
  const tasks: AgentStartOpenTasks["tasks"] = [];
  for (const entry of value.tasks as unknown[]) {
    if (!isRecord(entry)) continue;
    const { ref, title, status } = entry;
    if (typeof ref !== "string" || ref.trim() === "" || typeof title !== "string") continue;
    if (typeof status !== "string" || !STATUSES.has(status)) continue;
    tasks.push({ ref, title, status: status as AgentStartOpenTaskStatus });
  }
  if (tasks.length === 0) return undefined;
  const kept = tasks.slice(0, MAX_AGENT_START_OPEN_TASKS);
  const rawMore = typeof value.more === "number" && Number.isFinite(value.more) ? Math.max(0, Math.floor(value.more)) : 0;
  return { tasks: kept, more: rawMore + (tasks.length - kept.length) };
}
