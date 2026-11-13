import { useEffect, useMemo } from "react";
import { create } from "zustand";
import { useAuthStore } from "../store/authStore";
import { useMachineStore } from "../store/machineStore";
import { useServerStore } from "../store/serverStore";
import {
  computerAttentionKey,
  computerAttentionPairs,
  computerAttentionSeenStorageKey,
  hasUnseenComputerAttention,
  markComputerAttentionSeen,
  parseComputerAttentionKey,
  pruneComputerAttentionSeen,
  readComputerAttentionSeen,
  sameComputerAttentionPairs,
  writeComputerAttentionSeen,
} from "../utils/computerAttentionSeen";

/**
 * The Computers attention dot (desktop rail; on a phone, the Computers button
 * in the server tab's popover): lit for a change you have not seen. See utils/computerAttentionSeen.ts
 * and raft-design #620 "Attention dots".
 */

interface SeenState {
  /** In-memory mirror of localStorage, by storage key (user + server). */
  byKey: Record<string, string[]>;
  setSeen: (storageKey: string, pairs: string[]) => void;
}

export const useComputerAttentionSeenStore = create<SeenState>((set) => ({
  byKey: {},
  setSeen: (storageKey, pairs) => {
    writeComputerAttentionSeen(storageKey, pairs);
    set((s) => ({ byKey: { ...s.byKey, [storageKey]: pairs } }));
  },
}));

function readSeen(storageKey: string): string[] {
  return useComputerAttentionSeenStore.getState().byKey[storageKey] ?? readComputerAttentionSeen(storageKey);
}

function useSeenStorageKey(): string | null {
  const userId = useAuthStore((s) => s.user?.id ?? null);
  const serverId = useServerStore((s) => s.current?.id ?? null);
  return userId && serverId ? computerAttentionSeenStorageKey(userId, serverId) : null;
}

/** Current attention pairs as a primitive, and whether the list is loaded. */
function useAttentionKey(): { key: string; loaded: boolean } {
  const key = useMachineStore((s) => computerAttentionKey(s.machines));
  const loaded = useMachineStore((s) => s.loadStatus === "loaded");
  return { key, loaded };
}

/**
 * Whether the Computers dot is lit: some computer is in an attention state
 * you have not seen yet. Guests cannot open Computers: never lit.
 */
export function useComputerAttentionDot(): boolean {
  const isGuest = useServerStore((s) => s.current?.role === "guest");
  const storageKey = useSeenStorageKey();
  const { key, loaded } = useAttentionKey();
  const storedSeen = useComputerAttentionSeenStore((s) => (storageKey ? s.byKey[storageKey] : undefined));
  const currentPairs = useMemo(() => parseComputerAttentionKey(key), [key]);
  const seen = useMemo(
    () => storedSeen ?? (storageKey ? readComputerAttentionSeen(storageKey) : []),
    [storageKey, storedSeen],
  );

  // A computer that left an attention state forgets it was seen there, so
  // re-entering lights the dot again. Only on a loaded list: the empty
  // pre-load list would forget everything.
  useEffect(() => {
    if (!storageKey || !loaded) return;
    const previous = readSeen(storageKey);
    const pruned = pruneComputerAttentionSeen(previous, currentPairs);
    if (pruned.length !== previous.length) {
      useComputerAttentionSeenStore.getState().setSeen(storageKey, pruned);
    }
  }, [currentPairs, loaded, storageKey]);

  if (isGuest) return false;
  return hasUnseenComputerAttention(currentPairs, seen);
}

/**
 * Mount on the Computers page: while it is open, every current attention
 * pair counts as seen (including ones that arrive while you look at it).
 */
export function useMarkComputerAttentionSeen(active = true): void {
  const storageKey = useSeenStorageKey();
  const { key, loaded } = useAttentionKey();
  useEffect(() => {
    if (!active || !storageKey || !loaded) return;
    const next = markComputerAttentionSeen(parseComputerAttentionKey(key));
    if (sameComputerAttentionPairs(readSeen(storageKey), next)) return;
    useComputerAttentionSeenStore.getState().setSeen(storageKey, next);
  }, [active, key, loaded, storageKey]);
}

/**
 * Imperative mark for a tap that opens Computers (the Computers button in the
 * phone server tab's popover): the dots go out on the tap itself rather than
 * after the pushed page mounts.
 * The Computers route still marks on open for every other way in.
 */
export function markComputerAttentionSeenNow(): void {
  const userId = useAuthStore.getState().user?.id;
  const server = useServerStore.getState().current;
  if (!userId || !server?.id || server.role === "guest") return;
  const machines = useMachineStore.getState();
  if (machines.loadStatus !== "loaded") return;
  const storageKey = computerAttentionSeenStorageKey(userId, server.id);
  const next = markComputerAttentionSeen(computerAttentionPairs(machines.machines));
  if (sameComputerAttentionPairs(readSeen(storageKey), next)) return;
  useComputerAttentionSeenStore.getState().setSeen(storageKey, next);
}
