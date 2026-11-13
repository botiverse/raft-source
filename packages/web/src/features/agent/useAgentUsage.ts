import { useCallback, useEffect, useState } from "react";
import { currentTimeMs } from "@botiverse/raft-shared";
import type { AgentUsageResponse } from "@botiverse/raft-shared";
import api from "../../api/client";
import { useServerStore } from "../../store/serverStore";
import { agentUsagePath, agentUsageRequestWindow, utcDay } from "./agentUsage";
import type { AgentUsageRange } from "./agentUsage";

export type AgentUsageLoad =
  | { kind: "loading" }
  | { kind: "error" }
  | { kind: "ready"; response: AgentUsageResponse };

const LOADING: AgentUsageLoad = { kind: "loading" };

/**
 * Usage for a range (and the range before it, for the change), read for the
 * current server: one agent's (the panel's tab), or with `agentId` null every
 * agent the reader may inspect, in one request (Members › Agents). Nothing is
 * read while `enabled` is false. A failed read is an error with Retry; the
 * request's failure is traced by the API client like any other.
 *
 * An answer counts only for the request it answers: while the read for a new
 * range (or agent, server, day) is in flight the load is "loading", so the tab
 * never draws one range's bars from another range's answer.
 */
export function useAgentUsage(agentId: string | null, range: AgentUsageRange, enabled = true): { load: AgentUsageLoad; retry: () => void } {
  const serverId = useServerStore((state) => state.current?.id);
  const { from, to } = agentUsageRequestWindow(range, utcDay(currentTimeMs()));
  const requestKey = `${serverId ?? ""}\u0000${agentId ?? ""}\u0000${from}\u0000${to}`;
  const [settled, setSettled] = useState<{ key: string; load: AgentUsageLoad } | null>(null);
  const [attempt, setAttempt] = useState(0);

  useEffect(() => {
    if (!serverId || !enabled) return;
    let cancelled = false;
    const key = `${serverId}\u0000${agentId ?? ""}\u0000${from}\u0000${to}`;
    api.get<AgentUsageResponse>(agentUsagePath(serverId), { params: agentId === null ? { from, to } : { from, to, agents: agentId } })
      .then(({ data }) => {
        if (!cancelled) setSettled({ key, load: { kind: "ready", response: data } });
      })
      .catch(() => {
        if (!cancelled) setSettled({ key, load: { kind: "error" } });
      });
    return () => {
      cancelled = true;
    };
  }, [agentId, attempt, enabled, from, serverId, to]);

  const retry = useCallback(() => {
    setSettled(null);
    setAttempt((value) => value + 1);
  }, []);

  return { load: settled?.key === requestKey ? settled.load : LOADING, retry };
}
