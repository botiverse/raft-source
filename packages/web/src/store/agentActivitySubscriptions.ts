// Which agents this tab wants detailed activity for (#proj-frontend:#8). A
// surface that shows an agent's live detail (its DM, its detail panel, a
// channel's member list, the open Working-now list) holds a subscription while
// it is on screen; the server then sends that agent's `agent:activity` to this
// tab, and only the coarse AGENT_ACTIVITY_STATE_EVENT for every other agent.
// Counted per agent, so two surfaces showing the same agent share one; sent
// again after every reconnect (resubscribeAgentActivity from rooms:joined).
import { useEffect, useRef } from "react";
import {
  AGENT_ACTIVITY_SUBSCRIBE_EVENT,
  AGENT_ACTIVITY_UNSUBSCRIBE_EVENT,
  AGENT_ACTIVITY_SUBSCRIBE_MAX_IDS,
} from "@botiverse/raft-shared";

export interface AgentActivitySubscriptionSocket {
  emit(event: string, ...args: unknown[]): unknown;
  connected?: boolean;
}

const counts = new Map<string, number>();
let socketGetter: (() => AgentActivitySubscriptionSocket | null) | null = null;

/** Where subscribe and unsubscribe go (socketBridge binds the app socket). */
export function setAgentActivitySubscriptionSocket(getter: (() => AgentActivitySubscriptionSocket | null) | null): void {
  socketGetter = getter;
}

function send(event: string, agentIds: string[]): void {
  const socket = socketGetter?.();
  if (!socket || socket.connected === false || agentIds.length === 0) return;
  for (let index = 0; index < agentIds.length; index += AGENT_ACTIVITY_SUBSCRIBE_MAX_IDS) {
    socket.emit(event, { agentIds: agentIds.slice(index, index + AGENT_ACTIVITY_SUBSCRIBE_MAX_IDS) });
  }
}

/** Hold detailed activity for these agents; returns the release. */
export function acquireAgentActivity(agentIds: readonly string[]): () => void {
  const ids = [...new Set(agentIds.filter(Boolean))];
  const added: string[] = [];
  for (const id of ids) {
    const count = counts.get(id) ?? 0;
    counts.set(id, count + 1);
    if (count === 0) added.push(id);
  }
  send(AGENT_ACTIVITY_SUBSCRIBE_EVENT, added);
  let released = false;
  return () => {
    if (released) return;
    released = true;
    const removed: string[] = [];
    for (const id of ids) {
      const count = (counts.get(id) ?? 0) - 1;
      if (count <= 0) {
        counts.delete(id);
        removed.push(id);
      } else {
        counts.set(id, count);
      }
    }
    send(AGENT_ACTIVITY_UNSUBSCRIBE_EVENT, removed);
  };
}

/** Whether this tab receives the agent's detailed activity (its coarse state is then ignored). */
export function isAgentActivitySubscribed(agentId: string): boolean {
  return counts.has(agentId);
}

/** After a (re)connect: the server forgot this socket's rooms; ask again for every held agent. */
export function resubscribeAgentActivity(): void {
  send(AGENT_ACTIVITY_SUBSCRIBE_EVENT, [...counts.keys()]);
}

/** Tests only. */
export function resetAgentActivitySubscriptionsForTests(): void {
  counts.clear();
  socketGetter = null;
}

/**
 * Detailed activity for these agents while the calling surface is mounted.
 * `agentIdKey` is the ids joined by "," (a stable dependency); empty: none.
 */
export function useAgentActivitySubscription(agentIdKey: string): void {
  // The new set is held before the old one is let go, so an agent in both
  // (a member list gaining one agent) is never unsubscribed in between.
  const releaseRef = useRef<(() => void) | null>(null);
  useEffect(() => {
    const release = agentIdKey ? acquireAgentActivity(agentIdKey.split(",")) : null;
    releaseRef.current?.();
    releaseRef.current = release;
  }, [agentIdKey]);
  useEffect(() => () => {
    releaseRef.current?.();
    releaseRef.current = null;
  }, []);
}
