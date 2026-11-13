/**
 * Conversations "manually marked unread" (#triage:#101): Mark as Unread on a
 * conversation whose messages after the read point are all the person's own
 * (a thread of only their replies under someone else's message). The server
 * cannot rewind the read point into anything it counts, so it marks the
 * scope instead; the sidebar and Activity show it unread with a dot and no
 * number, and counts never include it.
 *
 * One flag per conversation (a thread's own channel id, else the channel's),
 * shared by the sidebar and Activity:
 * - set and cleared by the read-state ledger (store/readStateSync), whose
 *   versions order it against reads: `read_state:updated`, a sync pull, any
 *   served snapshot, and Mark as Unread's own answer, which goes through the
 *   same path (a late answer never brings back a mark a newer read removed);
 * - cleared at once by a read write of the conversation from here (opening
 *   it, Mark as Read, Mark all read, sending in it): the same write clears it
 *   on the server, and its newer read state confirms it.
 */
import { create } from "zustand";

import { registerMarkedUnreadListener } from "./readStateSync";
import { registerServerReset } from "./serverResetRegistry";
import { useServerStore } from "./serverStore";

type MarkedUnreadState = { marked: Readonly<Record<string, true>> };

const NONE: Readonly<Record<string, true>> = Object.freeze({});

export const useMarkedUnreadStore = create<MarkedUnreadState>(() => ({ marked: NONE }));

export function setScopeMarkedUnread(scopeId: string, markedUnread: boolean): void {
  const { marked } = useMarkedUnreadStore.getState();
  if ((marked[scopeId] === true) === markedUnread) return;
  if (markedUnread) {
    useMarkedUnreadStore.setState({ marked: { ...marked, [scopeId]: true } });
    return;
  }
  const { [scopeId]: _cleared, ...rest } = marked;
  useMarkedUnreadStore.setState({ marked: rest });
}

/** A read write of the conversation is going out from here: its mark is read. */
export function clearMarkedUnreadForRead(scopeId: string): void {
  setScopeMarkedUnread(scopeId, false);
}

/** Mark all read is going out from here: every mark is read. */
export function clearAllMarkedUnreadForRead(): void {
  useMarkedUnreadStore.setState({ marked: NONE });
}

/** Whether the conversation shows unread with no number (outside React). */
export function isScopeMarkedUnread(scopeId: string | null | undefined): boolean {
  return Boolean(scopeId) && useMarkedUnreadStore.getState().marked[scopeId!] === true;
}

/** Whether the conversation shows unread with no number. */
export function useScopeMarkedUnread(scopeId: string | null | undefined): boolean {
  return useMarkedUnreadStore((state) => Boolean(scopeId) && state.marked[scopeId!] === true);
}

registerMarkedUnreadListener((serverId, scopeId, markedUnread) => {
  if (serverId !== useServerStore.getState().current?.id) return;
  setScopeMarkedUnread(scopeId, markedUnread);
});
registerServerReset(() => useMarkedUnreadStore.setState({ marked: NONE }));
