// task #1260 follow-up: a background task leaves the APM's set only on its
// terminal notification. When that event is lost (a sub-agent that crashed),
// the count never returns to zero, the agent is never idle (agentIdle.ts), and
// every idle-gated rotation or restart waits forever. A task the runtime has
// said nothing about for BACKGROUND_TASK_SILENT_MS is a candidate to presume
// ended, but silence alone does not prove it (a quiet long build may still
// run, and an idle-gated restart would kill it): it is removed only when the
// runtime's process tree is readable and holds no live process started since
// the task did. Holding longer is preferred over killing running work.
//
// The decision is pure here; the APM's periodic sweep reads the tree and acts.

import { readDescendants, type ProcessTreeEntry } from "./drivers/processTree";

/** No event for a task this long makes it a candidate to presume ended. */
export const BACKGROUND_TASK_SILENT_MS = 60 * 60_000;
/** A candidate that is kept is traced again at most this often. */
export const BACKGROUND_TASK_KEPT_RETRACE_MS = 60 * 60_000;
/**
 * The daemon records a task's start when it reads `started`, after the
 * runtime has already spawned the work: a descendant this much older than the
 * recorded start still counts as the task's own.
 */
export const BACKGROUND_TASK_START_SLACK_MS = 60_000;

/** What the check needs of one task (the APM's BackgroundTaskRecord). */
export interface BackgroundTaskHealthRecord {
  startedAtMs: number;
  /** The last subagent-progress event carrying this task's id (its start included). */
  lastEventAtMs: number;
  /** When a kept candidate was last traced. */
  presumedEndedTracedAtMs?: number;
}

/** Reads the runtime's descendants; null when the tree cannot be read. */
export type RuntimeDescendantReader = (rootPid: number) => Promise<readonly ProcessTreeEntry[] | null>;

/** With start times off Linux too (`ps lstart`): an unknown start counts as the task's. */
export const defaultRuntimeDescendantReader: RuntimeDescendantReader = (rootPid) => readDescendants(rootPid, { psStartTimes: true });

/**
 * Which task a sub-agent's own row (its thinking, text, tool calls) belongs
 * to, so the row counts as that task's event: by the row's `taskId` (Codex,
 * Kimi), else by the call that started it (Claude's inner rows carry only the
 * Agent tool_use id, which the task's `task_started` names as `tool_use_id`)
 * when exactly one task has that call. Anything else matches nothing: a row
 * never refreshes a task it may not belong to. The web's Sub-agents view
 * joins rows to tasks the same way (subagentGroups.ts).
 */
export function backgroundTaskForSubagentRow(
  tasks: ReadonlyMap<string, { parentToolUseId?: string }>,
  lineage: { taskId?: string; parentToolUseId?: string },
): string | null {
  if (lineage.taskId) return tasks.has(lineage.taskId) ? lineage.taskId : null;
  if (!lineage.parentToolUseId) return null;
  let match: string | null = null;
  for (const [taskId, task] of tasks) {
    if (task.parentToolUseId !== lineage.parentToolUseId) continue;
    if (match !== null) return null;
    match = taskId;
  }
  return match;
}

/** The tasks with no event for at least `silentMs`, oldest silence first. */
export function silentBackgroundTasks<T extends BackgroundTaskHealthRecord>(
  tasks: ReadonlyMap<string, T>,
  nowMs: number,
  silentMs: number = BACKGROUND_TASK_SILENT_MS,
): Array<{ taskId: string; task: T; silentMs: number }> {
  const out: Array<{ taskId: string; task: T; silentMs: number }> = [];
  for (const [taskId, task] of tasks) {
    const silent = nowMs - task.lastEventAtMs;
    if (silent >= silentMs) out.push({ taskId, task, silentMs: silent });
  }
  return out.sort((a, b) => b.silentMs - a.silentMs);
}

export type DescendantEvidence =
  | { treeUnreadable: true }
  | { treeUnreadable: false; descendants: readonly ProcessTreeEntry[] };

/** Read the runtime's tree once for every candidate; any failure is "unreadable". */
export async function readDescendantEvidence(
  rootPid: number | undefined,
  read: RuntimeDescendantReader,
): Promise<DescendantEvidence> {
  if (typeof rootPid !== "number") return { treeUnreadable: true };
  try {
    const descendants = await read(rootPid);
    return descendants === null ? { treeUnreadable: true } : { treeUnreadable: false, descendants };
  } catch {
    return { treeUnreadable: true };
  }
}

export interface SilentTaskVerdict {
  remove: boolean;
  /** Live descendants that may be the task's work; null when the tree is unreadable. */
  descendantsAlive: number | null;
  treeUnreadable: boolean;
}

/**
 * Remove a silent task only when the tree is readable and no live descendant
 * started since the task did (less the slack). A descendant whose start time
 * cannot be read (no /proc, e.g. macOS `ps`) may be the task's work, so it
 * counts as alive.
 */
export function silentTaskVerdict(
  task: Pick<BackgroundTaskHealthRecord, "startedAtMs">,
  evidence: DescendantEvidence,
  startSlackMs: number = BACKGROUND_TASK_START_SLACK_MS,
): SilentTaskVerdict {
  if (evidence.treeUnreadable) return { remove: false, descendantsAlive: null, treeUnreadable: true };
  const since = task.startedAtMs - startSlackMs;
  const descendantsAlive = evidence.descendants
    .filter((entry) => entry.startedAtMs === undefined || entry.startedAtMs >= since).length;
  return { remove: descendantsAlive === 0, descendantsAlive, treeUnreadable: false };
}

/** A kept candidate is traced on its first check, then at most once per BACKGROUND_TASK_KEPT_RETRACE_MS. */
export function shouldTraceKeptCandidate(
  task: Pick<BackgroundTaskHealthRecord, "presumedEndedTracedAtMs">,
  nowMs: number,
  retraceMs: number = BACKGROUND_TASK_KEPT_RETRACE_MS,
): boolean {
  return task.presumedEndedTracedAtMs === undefined || nowMs - task.presumedEndedTracedAtMs >= retraceMs;
}
