import axios from "axios";
import { create } from "zustand";
import type { AgentContextViewStatus } from "@botiverse/raft-shared";
import api from "../../api/client";

/**
 * Whether the context behind an agent's messages can be opened now
 * (`GET /api/agents/:id/context-view/status`, Archer's #12952). Any refusal
 * (the Server's flag off, an agent the person may not inspect, an unknown
 * agent) is the same 404: then there is no View Context at all, so the menu
 * shows no item.
 *
 * Asked only when a message's menu opens on an agent's message, or when the
 * panel opens or retries; never per rendered message. One answer per agent is
 * kept for `STATUS_TTL_MS`, so a menu opened again soon asks nothing, and one
 * request at a time per agent.
 *
 * - `status`: the answer; `null` is the 404 (no View Context for this person).
 * - `failed`: the last request failed otherwise (network, 5xx). Not kept: the
 *   menu shows no item, the panel says so and offers Retry.
 */
export const STATUS_TTL_MS = 30_000;

export interface AgentContextViewStatusEntry {
  status?: AgentContextViewStatus | null;
  /** When `status` was received (ms). */
  at?: number;
  pending?: boolean;
  failed?: boolean;
}

interface StatusState {
  byAgent: Record<string, AgentContextViewStatusEntry>;
}

export const useAgentContextViewStatusStore = create<StatusState>(() => ({ byAgent: {} }));

const inflight = new Map<string, Promise<void>>();

function patch(agentId: string, entry: AgentContextViewStatusEntry) {
  const byAgent = useAgentContextViewStatusStore.getState().byAgent;
  useAgentContextViewStatusStore.setState({ byAgent: { ...byAgent, [agentId]: { ...byAgent[agentId], ...entry } } });
}

function fresh(entry: AgentContextViewStatusEntry | undefined, now: number): boolean {
  return entry?.status !== undefined && entry.at !== undefined && now - entry.at < STATUS_TTL_MS;
}

/**
 * Ask for `agentId`'s status unless a fresh answer is kept (`force` asks
 * anyway: the panel's Retry). Resolves when the answer is in the store.
 */
export function loadAgentContextViewStatus(agentId: string, options: { force?: boolean } = {}): Promise<void> {
  const running = inflight.get(agentId);
  if (running) return running;
  if (!options.force && fresh(useAgentContextViewStatusStore.getState().byAgent[agentId], Date.now())) return Promise.resolve();
  patch(agentId, { pending: true });
  const request = api.get<AgentContextViewStatus>(`/agents/${encodeURIComponent(agentId)}/context-view/status`)
    .then(({ data }) => patch(agentId, { status: data, at: Date.now(), pending: false, failed: false }))
    .catch((error: unknown) => {
      if (axios.isAxiosError(error) && error.response?.status === 404) {
        patch(agentId, { status: null, at: Date.now(), pending: false, failed: false });
      } else {
        // A failure is not an answer: drop what was kept so neither the menu nor the panel acts on it.
        patch(agentId, { status: undefined, at: undefined, pending: false, failed: true });
      }
    })
    .finally(() => inflight.delete(agentId));
  inflight.set(agentId, request);
  return request;
}

/**
 * The Server refused a view of `agentId` (404: the flag went off, access was
 * lost): kept as the status's 404, so the menu stops offering View Context
 * until the answer is asked again.
 */
export function markAgentContextViewGone(agentId: string) {
  patch(agentId, { status: null, at: Date.now(), pending: false, failed: false });
}

/** One agent's entry; subscribe only where it is shown (the open menu, the panel), never per message. */
export function useAgentContextViewStatus(agentId: string): AgentContextViewStatusEntry | undefined {
  return useAgentContextViewStatusStore((state) => state.byAgent[agentId]);
}

/** Tests: forget every answer. */
export function resetAgentContextViewStatusCache() {
  inflight.clear();
  useAgentContextViewStatusStore.setState({ byAgent: {} });
}
