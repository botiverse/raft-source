import { create } from "zustand";
import { useShallow } from "zustand/react/shallow";
import { AGENT_TYPING_TTL_MS } from "@botiverse/raft-shared";
import type { AgentTypingEvent } from "@botiverse/raft-shared";

/**
 * Agent typing line (raft-design 0042): who is about to post where.
 *
 * Fed by the server's `agent:typing` event. One entry per live tool call
 * (`agentId` + `callId`), kept per channel in the order the calls started, so
 * the faces and names never reshuffle on a refresh. An entry leaves on its
 * `end`, when its deadline passes (one timer for the earliest deadline, none
 * while the store is empty), when the agent's message lands in that
 * conversation, and on reconnect (the server re-sends live calls on refresh).
 */
export interface AgentTypingEntry {
  agentId: string;
  callId: string;
  channelId: string;
  /** The thread's root message for a thread reply; null for the channel itself. */
  parentMessageId: string | null;
  /** Local ms of the call's first `start`: the display order. */
  startedAt: number;
  /** Local ms after which the entry is dropped without a refresh. */
  deadline: number;
}

interface AgentTypingState {
  byChannel: Record<string, AgentTypingEntry[]>;
  apply: (event: AgentTypingEvent) => void;
  /** The agent posted into `channelId` (`parentMessageId` = the thread, or null). */
  clearForMessage: (agentId: string, channelId: string, parentMessageId: string | null) => void;
  /** The agent replied in the thread under `parentMessageId`, wherever its channel is. */
  clearForThreadReply: (agentId: string, parentMessageId: string) => void;
  pruneExpired: () => void;
  clear: () => void;
}

/**
 * `expiresAt` is the server's clock. A client clock that runs ahead or behind
 * would drop the line at once or keep it far too long, so a remaining time
 * outside (0, TTL] falls back to the TTL from now.
 */
export function localTypingDeadline(expiresAt: number, now: number): number {
  const remaining = expiresAt - now;
  return now + (remaining > 0 && remaining <= AGENT_TYPING_TTL_MS ? remaining : AGENT_TYPING_TTL_MS);
}

let expiryTimer: ReturnType<typeof setTimeout> | null = null;

/** Calls kept as "posted, ignore its starts"; the oldest goes first past this. */
export const AGENT_TYPING_CLEARED_CALLS_MAX = 128;
/** How long a cleared call's starts are ignored after the last one seen. */
export const AGENT_TYPING_CLEARED_CALL_TTL_MS = AGENT_TYPING_TTL_MS;
/** `agentId` + `callId` -> local ms until which its `start`s are ignored. */
const clearedCalls = new Map<string, number>();

function callKey(agentId: string, callId: string): string {
  return `${agentId}\u0000${callId}`;
}

function rememberCleared(entries: readonly AgentTypingEntry[], now: number) {
  for (const entry of entries) {
    const key = callKey(entry.agentId, entry.callId);
    clearedCalls.delete(key);
    clearedCalls.set(key, now + AGENT_TYPING_CLEARED_CALL_TTL_MS);
  }
  for (const [key, until] of clearedCalls) {
    if (clearedCalls.size <= AGENT_TYPING_CLEARED_CALLS_MAX && until > now) break;
    clearedCalls.delete(key);
  }
}

/** A start for a call whose message already landed: ignored, and it keeps the call remembered while it repeats. */
function isClearedCall(agentId: string, callId: string, now: number): boolean {
  if (clearedCalls.size === 0) return false;
  const key = callKey(agentId, callId);
  const until = clearedCalls.get(key);
  if (until === undefined) return false;
  if (until <= now) {
    clearedCalls.delete(key);
    return false;
  }
  clearedCalls.delete(key);
  clearedCalls.set(key, now + AGENT_TYPING_CLEARED_CALL_TTL_MS);
  return true;
}

function scheduleExpiry(byChannel: Record<string, AgentTypingEntry[]>) {
  if (expiryTimer !== null) {
    clearTimeout(expiryTimer);
    expiryTimer = null;
  }
  let next = Infinity;
  for (const entries of Object.values(byChannel)) {
    for (const entry of entries) next = Math.min(next, entry.deadline);
  }
  if (next === Infinity) return;
  expiryTimer = setTimeout(() => {
    expiryTimer = null;
    useAgentTypingStore.getState().pruneExpired();
  }, Math.max(0, next - Date.now()));
}

function withChannel(
  byChannel: Record<string, AgentTypingEntry[]>,
  channelId: string,
  entries: AgentTypingEntry[],
): Record<string, AgentTypingEntry[]> {
  const next = { ...byChannel };
  if (entries.length === 0) delete next[channelId];
  else next[channelId] = entries;
  return next;
}

function removeWhere(
  byChannel: Record<string, AgentTypingEntry[]>,
  drop: (entry: AgentTypingEntry) => boolean,
): Record<string, AgentTypingEntry[]> | null {
  let changed = false;
  let next = byChannel;
  for (const [channelId, entries] of Object.entries(byChannel)) {
    const kept = entries.filter((entry) => !drop(entry));
    if (kept.length === entries.length) continue;
    changed = true;
    next = withChannel(next, channelId, kept);
  }
  return changed ? next : null;
}

export const useAgentTypingStore = create<AgentTypingState>((set, get) => {
  const commit = (byChannel: Record<string, AgentTypingEntry[]> | null) => {
    if (byChannel === null) return;
    set({ byChannel });
    scheduleExpiry(byChannel);
  };

  return {
    byChannel: {},
    apply: (event) => {
      const { byChannel } = get();
      const entries = byChannel[event.channelId] ?? [];
      const index = entries.findIndex((entry) => entry.agentId === event.agentId && entry.callId === event.callId);
      if (event.state === "end") {
        if (index < 0) return;
        commit(withChannel(byChannel, event.channelId, entries.filter((_, i) => i !== index)));
        return;
      }
      const now = Date.now();
      if (index < 0 && isClearedCall(event.agentId, event.callId, now)) return;
      const deadline = localTypingDeadline(event.expiresAt, now);
      const parentMessageId = event.parentMessageId ?? null;
      if (index >= 0) {
        // A refresh: same place in line, new deadline.
        const next = [...entries];
        next[index] = { ...entries[index], parentMessageId, deadline };
        commit(withChannel(byChannel, event.channelId, next));
        return;
      }
      commit(withChannel(byChannel, event.channelId, [
        ...entries,
        { agentId: event.agentId, callId: event.callId, channelId: event.channelId, parentMessageId, startedAt: now, deadline },
      ]));
    },
    clearForMessage: (agentId, channelId, parentMessageId) => {
      const { byChannel } = get();
      const entries = byChannel[channelId];
      if (!entries) return;
      const cleared = entries.filter((entry) => entry.agentId === agentId && entry.parentMessageId === parentMessageId);
      if (cleared.length === 0) return;
      rememberCleared(cleared, Date.now());
      commit(withChannel(byChannel, channelId, entries.filter((entry) => !cleared.includes(entry))));
    },
    clearForThreadReply: (agentId, parentMessageId) => {
      const cleared: AgentTypingEntry[] = [];
      const next = removeWhere(get().byChannel, (entry) => {
        const drop = entry.agentId === agentId && entry.parentMessageId === parentMessageId;
        if (drop) cleared.push(entry);
        return drop;
      });
      if (cleared.length > 0) rememberCleared(cleared, Date.now());
      commit(next);
    },
    pruneExpired: () => {
      const now = Date.now();
      const { byChannel } = get();
      const next = removeWhere(byChannel, (entry) => entry.deadline <= now);
      // Nothing due yet (a timer that fired early): keep waiting for the earliest.
      if (next === null) scheduleExpiry(byChannel);
      else commit(next);
    },
    clear: () => {
      // A reconnect starts over; the server's own end markers cover the refreshes.
      clearedCalls.clear();
      if (Object.keys(get().byChannel).length === 0) return;
      commit({});
    },
  };
});

/**
 * The agents typing into one conversation — the channel itself
 * (`parentMessageId` null) or one thread under it — each once, in the order
 * they started. Ids only, so a refresh (new deadline) re-renders nothing.
 */
export function selectTypingAgentIds(
  state: Pick<AgentTypingState, "byChannel">,
  channelId: string | null | undefined,
  parentMessageId: string | null,
): string[] {
  if (!channelId) return [];
  const entries = state.byChannel[channelId];
  if (!entries) return [];
  const ids: string[] = [];
  for (const entry of entries) {
    if (entry.parentMessageId !== parentMessageId) continue;
    if (!ids.includes(entry.agentId)) ids.push(entry.agentId);
  }
  return ids;
}

export function useAgentTyping(channelId: string | null | undefined, parentMessageId: string | null): string[] {
  return useAgentTypingStore(useShallow((state) => selectTypingAgentIds(state, channelId, parentMessageId)));
}

/** The wire shape we act on, or null for a frame we cannot place. */
export function readAgentTypingEvent(payload: unknown): AgentTypingEvent | null {
  if (!payload || typeof payload !== "object") return null;
  const data = payload as Record<string, unknown>;
  if (typeof data.agentId !== "string" || typeof data.channelId !== "string" || typeof data.callId !== "string") return null;
  if (typeof data.serverId !== "string") return null;
  if (data.state !== "start" && data.state !== "end") return null;
  const parentMessageId = typeof data.parentMessageId === "string" ? data.parentMessageId : null;
  const expiresAt = typeof data.expiresAt === "number" && Number.isFinite(data.expiresAt) ? data.expiresAt : 0;
  return {
    agentId: data.agentId,
    serverId: data.serverId,
    channelId: data.channelId,
    parentMessageId,
    callId: data.callId,
    state: data.state,
    expiresAt,
  };
}

/**
 * An agent's message landed: it is no longer about to post there. A thread
 * reply carries its root in `conversationContext`; anything else is a post
 * into `channelId` itself.
 */
export function clearAgentTypingForMessage(message: {
  senderType: string;
  senderId: string;
  channelId: string;
  conversationContext?: { channelType: string; parentMessageId?: string };
}) {
  if (message.senderType !== "agent") return;
  const store = useAgentTypingStore.getState();
  const context = message.conversationContext;
  if (context?.channelType === "thread") {
    if (context.parentMessageId) store.clearForThreadReply(message.senderId, context.parentMessageId);
    return;
  }
  store.clearForMessage(message.senderId, message.channelId, null);
}
