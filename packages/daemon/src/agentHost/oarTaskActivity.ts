import type { SubagentLineage } from "@botiverse/raft-shared";
import { BACKGROUND_TASK_SILENT_MS } from "../backgroundTaskHealth";

/**
 * #proj-runtime:#42: an OAR session's task events as the Sub-agents view's rows,
 * saying what the legacy host's `subagent_progress` rows say. Only subagents get a
 * row, as there: a shell command or a tool the runtime moved off the turn isn't
 * one a person would look for. A task's id is what a Stop sends back.
 */
type TaskEvent =
  | { kind: "task_started"; taskId: string; taskType: string; nativeType?: string; toolCallId?: string; childSessionId?: string }
  | { kind: "task_updated"; taskId: string; status?: string }
  | { kind: "task_ended"; taskId: string; status: "completed" | "failed" | "stopped" };

const OUTCOME = { completed: "done", failed: "failed", stopped: "stopped" } as const;

/** `nativeType` is a role on Grok and Qwen, and only the kind of task on these. */
const NOT_A_ROLE: ReadonlySet<string> = new Set(["local_agent", "remote_agent", "in_process_teammate", "subAgent"]);

export interface OarTaskRow {
  detail: string;
  subagent: NonNullable<SubagentLineage["subagent"]>;
}

interface TrackedTask {
  toolCallId?: string;
  role?: string;
  childSessionId?: string;
  stopRequested: boolean;
  ended: boolean;
  /** The last event that named it, on the host's clock. */
  lastEventAtMs: number;
}

export class OarTaskRows {
  private readonly tasks = new Map<string, TrackedTask>();

  constructor(private readonly now: () => number = Date.now) {}

  /**
   * The subagents still running, for idle's `backgroundTasks` (agentIdle.ts):
   * a runtime can start a turn of its own when one ends, so an agent with one
   * isn't idle. One no event has named for BACKGROUND_TASK_SILENT_MS is
   * presumed to have lost its end, as the legacy host presumes, so a lost
   * `task_ended` can't keep an agent busy for good.
   */
  runningCount(silentMs: number = BACKGROUND_TASK_SILENT_MS): number {
    const nowMs = this.now();
    let count = 0;
    for (const task of this.tasks.values()) {
      if (!task.ended && nowMs - task.lastEventAtMs < silentMs) count += 1;
    }
    return count;
  }

  isRunning(taskId: string): boolean {
    const task = this.tasks.get(taskId);
    return task !== undefined && !task.ended;
  }

  /** A person asked to stop it and the runtime hasn't refused: its `stopped` end is that stop. */
  isStopRequested(taskId: string): boolean {
    return this.tasks.get(taskId)?.stopRequested === true;
  }

  /** Set before the request: a child's turn can end before the runtime's answer. */
  noteStopRequested(taskId: string, requested: boolean): void {
    const task = this.tasks.get(taskId);
    if (task) task.stopRequested = requested;
  }

  private row(taskId: string, task: TrackedTask, phase: "started" | "progress" | "notification", detail: string, outcome?: keyof typeof OUTCOME): OarTaskRow {
    return {
      detail: `${detail}${task.role ? ` (${task.role})` : ""}`,
      subagent: {
        taskId,
        phase,
        ...(task.toolCallId ? { parentToolUseId: task.toolCallId } : {}),
        ...(task.role ? { subagentType: task.role } : {}),
        ...(outcome ? { outcome: OUTCOME[outcome] } : {}),
      },
    };
  }

  private end(taskId: string, task: TrackedTask, status: keyof typeof OUTCOME): OarTaskRow {
    task.ended = true;
    task.stopRequested = false;
    return this.row(taskId, task, "notification", `Subagent ${status}`, status);
  }

  onTaskEvent(event: TaskEvent): OarTaskRow | null {
    if (event.kind === "task_started") {
      if (event.taskType !== "agent") return null;
      const task: TrackedTask = {
        stopRequested: false,
        ended: false,
        lastEventAtMs: this.now(),
        ...(event.toolCallId ? { toolCallId: event.toolCallId } : {}),
        ...(event.nativeType && !NOT_A_ROLE.has(event.nativeType) ? { role: event.nativeType } : {}),
        ...(event.childSessionId ? { childSessionId: event.childSessionId } : {}),
      };
      this.tasks.set(event.taskId, task);
      return this.row(event.taskId, task, "started", "Subagent started");
    }
    const task = this.tasks.get(event.taskId);
    if (!task) return null;
    task.lastEventAtMs = this.now();
    if (event.kind === "task_updated") {
      // Codex: the parent gave an ended child more work, under the same task.
      if (task.ended && event.status !== "running" && event.status !== "pending") return null;
      task.ended = false;
      return this.row(event.taskId, task, "progress", "Subagent working");
    }
    return task.ended ? null : this.end(event.taskId, task, event.status);
  }

  /**
   * Codex may report no `task_ended` for a stopped child: the parent can give the
   * same thread more work, so its aborted turn is the end of what a person asked
   * to stop. Only one a person asked to stop: a child's turn ending on its own
   * says nothing about the task.
   */
  onChildTurnAborted(childSessionId: string): OarTaskRow | null {
    for (const [taskId, task] of this.tasks) {
      if (task.childSessionId === childSessionId && task.stopRequested && !task.ended) return this.end(taskId, task, "stopped");
    }
    return null;
  }
}
