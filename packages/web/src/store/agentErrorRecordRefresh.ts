import api from "../api/client";
import { reconcileAgentsList, stripActivityFields, useAgentStore } from "./agentStore";
import type { Agent, AgentActivityState } from "./agentStore";

/**
 * #proj-raft-computer:#48: the server stores an agent's runtime error (with
 * its `requiredAction`) but pushes only the error activity, and emits that
 * before the store write. When an error shows that the agent's record does
 * not describe, re-read the record once the burst settles.
 *
 * Bounded: at most one re-read per agent per distinct error detail. The
 * detail last asked for is remembered (one entry per agent, overwritten), so
 * an error that never lands in the record (another error path, a failed store
 * write) restated by later frames costs no further requests; a different
 * detail asks once more.
 */
let agentErrorRecordRefreshDelayMs = 1_500;
const agentErrorRecordRefreshTimers = new Map<string, ReturnType<typeof setTimeout>>();
const agentErrorRecordRefreshedDetail = new Map<string, string>();

/**
 * Re-read one listed agent's record (`GET /agents/:id`) and replace its row,
 * keeping the live activity (the socket's is newer). For a field the server
 * does not push, such as the stored `lastRuntimeError`.
 */
export async function refreshAgentRecord(agentId: string): Promise<void> {
  if (!useAgentStore.getState().agents.some((agent) => agent.id === agentId)) return;
  try {
    const { data } = await api.get(`/agents/${agentId}`);
    const agent = stripActivityFields(data as Parameters<typeof stripActivityFields>[0]);
    if (agent?.id !== agentId) return;
    useAgentStore.setState((state) => state.agents.some((candidate) => candidate.id === agentId)
      ? { agents: reconcileAgentsList(state.agents, state.agents.map((candidate) => candidate.id === agentId ? agent : candidate)) }
      : {});
  } catch (err) {
    console.error(`Failed to refresh agent ${agentId}:`, err);
  }
}

export function scheduleAgentErrorRecordRefresh(agentId: string, detail: string): void {
  if (agentErrorRecordRefreshedDetail.get(agentId) === detail) return;
  agentErrorRecordRefreshedDetail.set(agentId, detail);
  const pending = agentErrorRecordRefreshTimers.get(agentId);
  if (pending) clearTimeout(pending);
  agentErrorRecordRefreshTimers.set(agentId, setTimeout(() => {
    agentErrorRecordRefreshTimers.delete(agentId);
    void refreshAgentRecord(agentId);
  }, agentErrorRecordRefreshDelayMs));
}

/** Whether the live error is one the agent's stored record does not describe yet. */
export function agentErrorRecordStale(agent: Pick<Agent, "lastRuntimeError"> | undefined, activity: Pick<AgentActivityState, "activity" | "activityDetail"> | undefined): boolean {
  return Boolean(agent && activity?.activity === "error" && agent.lastRuntimeError?.message !== activity.activityDetail);
}

/**
 * Called for each pushed `agent:activity` after the store applied it: a new
 * fact showing an error its record does not describe yet schedules a re-read.
 * A heartbeat or other replay (probe reply) only restates the state.
 */
export function observeAgentActivityForErrorRecord(frame: { agentId: string; isHeartbeat?: boolean; isRefreshOnly?: boolean }): void {
  if (frame.isHeartbeat === true || frame.isRefreshOnly === true) return;
  const state = useAgentStore.getState();
  const activity = state.agentActivities[frame.agentId];
  if (activity && agentErrorRecordStale(state.agents.find((candidate) => candidate.id === frame.agentId), activity)) {
    scheduleAgentErrorRecordRefresh(frame.agentId, activity.activityDetail);
  }
}

export function __setAgentErrorRecordRefreshDelayMsForTests(ms?: number): () => void {
  const previous = agentErrorRecordRefreshDelayMs;
  agentErrorRecordRefreshDelayMs = ms ?? 1_500;
  return () => {
    agentErrorRecordRefreshDelayMs = previous;
    for (const timer of agentErrorRecordRefreshTimers.values()) clearTimeout(timer);
    agentErrorRecordRefreshTimers.clear();
    agentErrorRecordRefreshedDetail.clear();
  };
}
