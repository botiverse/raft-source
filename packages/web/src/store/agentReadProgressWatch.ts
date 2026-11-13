// Which conversations this tab follows agent read progress in
// (agent_read_progress_v0; wire contract in shared agentReadProgress.ts). A
// surface that shows agents' read positions (an open channel, its thread
// panel) holds a watch while it is on screen; the server then sends that
// conversation's `read_progress:updated` to this socket only. Counted per
// conversation, so two surfaces on the same one share a watch; sent again
// after every reconnect (rewatchAgentReadProgress from rooms:joined), since
// watches belong to the connection.
import {
  READ_PROGRESS_DETAIL_CHANGED_EVENT,
  READ_PROGRESS_MAX_WATCHED_SCOPES,
  READ_PROGRESS_UNWATCH_EVENT,
  READ_PROGRESS_WATCH_EVENT,
} from "@botiverse/raft-shared";
import type { ReadProgressWatchRequest } from "@botiverse/raft-shared";
import { useReadReceiptStore } from "./readReceiptStore";
import type { SocketBinding } from "./socketBridge";

export interface AgentReadProgressWatchSocket {
  emit(event: string, ...args: unknown[]): unknown;
  connected?: boolean;
}

/** Held conversations in the order they were first watched (oldest first). */
const counts = new Map<string, number>();
let socketGetter: (() => AgentReadProgressWatchSocket | null) | null = null;

/** Where watch and unwatch go (socketBridge binds the app socket). */
export function setAgentReadProgressWatchSocket(getter: (() => AgentReadProgressWatchSocket | null) | null): void {
  socketGetter = getter;
}

function send(event: string, scopeId: string): void {
  const socket = socketGetter?.();
  if (!socket || socket.connected === false) return;
  const body: ReadProgressWatchRequest = { scopeId };
  socket.emit(event, body);
}

/** Follow one conversation's agent read progress; returns the release. */
export function acquireAgentReadProgressWatch(scopeId: string): () => void {
  const count = counts.get(scopeId) ?? 0;
  counts.set(scopeId, count + 1);
  if (count === 0) send(READ_PROGRESS_WATCH_EVENT, scopeId);
  let released = false;
  return () => {
    if (released) return;
    released = true;
    const next = (counts.get(scopeId) ?? 0) - 1;
    if (next > 0) {
      counts.set(scopeId, next);
      return;
    }
    counts.delete(scopeId);
    send(READ_PROGRESS_UNWATCH_EVENT, scopeId);
  };
}

/** Whether this tab follows the conversation (tests, diagnostics). */
export function isAgentReadProgressWatched(scopeId: string): boolean {
  return counts.has(scopeId);
}

/**
 * Who a watched conversation reaches changed: a thread's followers
 * (`thread:followers-updated`) or an agent's mute of a channel
 * (`read_progress:detail_changed`). The line under your latest message says
 * who stopped following or muted it, and that comes with the detail. Only
 * while watched: nothing else here shows it.
 */
export function refreshWatchedFollowState(scopeId: string): void {
  if (counts.has(scopeId)) useReadReceiptStore.getState().refreshFollowState(scopeId);
}

/** The events below, for the main layout's socket (socketBridge.ts). */
export const AGENT_READ_PROGRESS_SOCKET_EVENTS = ["read_progress:updated", READ_PROGRESS_DETAIL_CHANGED_EVENT] as const;

/**
 * A watched conversation's agents read on (`read_progress:updated`), or what
 * its detail says about them changed (`read_progress:detail_changed`: an agent
 * muted or unmuted it), so load it again.
 */
export function agentReadProgressSocketBindings(): Array<SocketBinding & { event: (typeof AGENT_READ_PROGRESS_SOCKET_EVENTS)[number] }> {
  return [
    {
      event: "read_progress:updated",
      handler: (payload) => useReadReceiptStore.getState().consumeReadProgressUpdated(payload),
    },
    {
      event: READ_PROGRESS_DETAIL_CHANGED_EVENT,
      handler: (payload: { scopeId?: unknown } | null | undefined) => {
        if (typeof payload?.scopeId === "string") refreshWatchedFollowState(payload.scopeId);
      },
    },
  ];
}

/**
 * After a (re)connect the server holds no watches for this socket: watch
 * every held conversation again, and load its detail again (forced), since
 * moves made while the socket was down were never sent. The server keeps the
 * newest READ_PROGRESS_MAX_WATCHED_SCOPES, so only those, oldest first. Frames
 * that arrive while a detail loads are kept for it (readReceiptStore).
 */
export function rewatchAgentReadProgress(): void {
  const held = [...counts.keys()].slice(-READ_PROGRESS_MAX_WATCHED_SCOPES);
  for (const scopeId of held) send(READ_PROGRESS_WATCH_EVENT, scopeId);
  for (const scopeId of held) void useReadReceiptStore.getState().hydrateScope(scopeId, { force: true, reason: "refresh" });
}

/** Tests only. */
export function resetAgentReadProgressWatchForTests(): void {
  counts.clear();
  socketGetter = null;
}
