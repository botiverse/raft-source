import type { Presence } from "@botiverse/raft-ui";
import type { SubagentLineage, SubagentOutcome } from "@botiverse/raft-shared";
import type { TrajectoryLogEntry } from "../../store/agentStore";

/**
 * #proj-runtime:#41 — the Activity tab's Sub-agents view, folded from the
 * activity the page already holds. A row belongs to a sub-agent only by its
 * explicit lineage marker (never by its text). A group is one run: the call
 * that started it (Claude's Agent tool_use id, Codex's spawn call id, Kimi's
 * Agent call) and the sub-agent's own id (`taskId`). Codex and Kimi rows carry
 * both; Claude's inner rows carry only the call and join that call's task.
 */
export type SubagentState = "running" | SubagentOutcome | "ended";

export interface SubagentGroup {
  /** The run: the call that started it and its own id (`taskId`) when known. */
  key: string;
  /** The call that started it: its title, and the raw log's link to it. */
  parentToolUseId?: string;
  /** What it was asked: the spawn row's summary, without Codex's operation prefix. Absent from older daemons. */
  title?: string;
  subagentType?: string;
  /** Its own id (`SubagentLineage.taskId`; Codex: its thread id), which a stop names. */
  taskId?: string;
  state: SubagentState;
  startedAt: number;
  /** When it finished; absent while it runs. */
  endedAt?: number;
  /** Its latest row. */
  lastAt: number;
  /** Its tool calls. */
  steps: number;
  /** The tool it called last. */
  lastToolName?: string;
  /** Its own rows, oldest first, without the lineage marker (the view is already this sub-agent's). */
  items: TrajectoryLogEntry[];
}

function lineageOf(item: TrajectoryLogEntry): SubagentLineage["subagent"] | undefined {
  return (item.entry as SubagentLineage).subagent;
}

function withoutLineage(item: TrajectoryLogEntry): TrajectoryLogEntry {
  const { subagent: _subagent, ...entry } = item.entry as TrajectoryLogEntry["entry"] & SubagentLineage;
  return { ...item, entry: entry as TrajectoryLogEntry["entry"] };
}

/** A Codex collab summary leads with its operation ("spawnAgent: …"); the title is the task. */
function titleFromSpawnSummary(toolInput: string): string | undefined {
  const text = toolInput.replace(/^spawnAgent(?::\s*|$)/, "").trim();
  return text || undefined;
}

/**
 * Whether a row opens or closes its sub-agent. Only lifecycle rows count:
 * the daemon's status rows (Claude and Codex, `subagent_activity`) and a
 * hosted agent's system rows. Other rows that carry a phase (a hosted
 * agent's tool end says `active`) are its steps, not its lifecycle.
 */
function lifecycleOf(item: TrajectoryLogEntry, lineage: NonNullable<SubagentLineage["subagent"]>): "open" | "close" | null {
  const { entry } = item;
  const lifecycleRow = (entry.kind === "status" && entry.detailKind === "subagent_activity") || entry.kind === "system";
  if (!lifecycleRow) return null;
  switch (lineage.phase) {
    case "started":
    case "progress":
      return "open";
    case "notification":
    case "ended":
      return "close";
    default:
      return null;
  }
}

/**
 * The group key a row's lineage belongs to (SubagentGroup.key), as
 * groupSubagents keys them, so a row can open exactly its own run.
 */
export function subagentKeyResolver(log: readonly TrajectoryLogEntry[]): (lineage: NonNullable<SubagentLineage["subagent"]>) => string | undefined {
  // One call can start several subagents (a Kimi AgentSwarm, a Codex spawn
  // naming several threads). Claude's inner rows carry only the call; they
  // belong to that call's one task.
  const tasksByCall = new Map<string, Set<string>>();
  for (const item of log) {
    const lineage = lineageOf(item);
    if (lineage?.parentToolUseId && lineage.taskId) {
      const tasks = tasksByCall.get(lineage.parentToolUseId) ?? new Set<string>();
      tasks.add(lineage.taskId);
      tasksByCall.set(lineage.parentToolUseId, tasks);
    }
  }
  // A run is one call and one task: a swarm's subagents share the call, a
  // Kimi resume reuses the task under a new call, a Codex follow-up turn keeps both.
  return (lineage) => {
    const call = lineage.parentToolUseId;
    if (!call) return lineage.taskId;
    const tasks = tasksByCall.get(call);
    const task = lineage.taskId ?? (tasks?.size === 1 ? [...tasks][0] : undefined);
    return task ? `${call}\u0000${task}` : call;
  };
}

export function groupSubagents(log: readonly TrajectoryLogEntry[]): SubagentGroup[] {
  const groups = new Map<string, SubagentGroup>();
  const spawnSummaries = new Map<string, { text: string; at: number }>();
  const keyOf = subagentKeyResolver(log);
  for (const item of log) {
    const { entry } = item;
    if (entry.kind === "tool_start" && entry.callId && entry.toolInput) {
      spawnSummaries.set(entry.callId, { text: entry.toolInput, at: item.timestamp });
    }
    const lineage = lineageOf(item);
    if (!lineage) continue;
    const key = keyOf(lineage);
    if (!key) continue;
    let group = groups.get(key);
    if (!group) {
      group = { key, state: "ended", startedAt: item.timestamp, lastAt: item.timestamp, steps: 0, items: [] };
      groups.set(key, group);
    }
    if (lineage.parentToolUseId && !group.parentToolUseId) group.parentToolUseId = lineage.parentToolUseId;
    if (lineage.subagentType && !group.subagentType) group.subagentType = lineage.subagentType;
    if (lineage.taskId && !group.taskId) group.taskId = lineage.taskId;
    group.lastAt = item.timestamp;
    const lifecycle = lifecycleOf(item, lineage);
    if (lifecycle === "open") {
      // A start (again, for a follow-up turn) opens it.
      group.state = "running";
      group.endedAt = undefined;
      continue;
    }
    if (lifecycle === "close") {
      // Without an outcome (an older daemon, or a notification that is only
      // an update) it reads as ended; a later start reopens it.
      group.state = lineage.outcome ?? "ended";
      group.endedAt = item.timestamp;
      continue;
    }
    if (entry.kind === "status" && entry.detailKind === "subagent_activity") continue;
    if (entry.kind === "tool_start") {
      group.steps += 1;
      group.lastToolName = entry.toolName;
    }
    group.items.push(withoutLineage(item));
  }
  for (const group of groups.values()) {
    // Its start may have scrolled out of the loaded activity: what is left
    // reads as ended at its last row, never as still running time.
    if (group.state !== "running" && group.endedAt === undefined) group.endedAt = group.lastAt;
    const spawn = group.parentToolUseId ? spawnSummaries.get(group.parentToolUseId) : undefined;
    if (spawn) {
      group.title = titleFromSpawnSummary(spawn.text);
      group.startedAt = Math.min(group.startedAt, spawn.at);
    }
  }
  // Running first, then the most recent.
  return [...groups.values()].sort((a, b) => Number(b.state === "running") - Number(a.state === "running") || b.startedAt - a.startedAt);
}

/** A system row that is a sub-agent's lifecycle (OAR runtimes') reads as that sub-agent's state, not as an error. */
export function subagentRowPresence(subagent: SubagentLineage["subagent"] | undefined): Presence | null {
  switch (subagent?.phase) {
    case "started":
    case "progress":
      return "busy";
    case "notification":
    case "ended":
      return subagent.outcome === "failed" ? "error" : "online";
    default:
      return null;
  }
}
