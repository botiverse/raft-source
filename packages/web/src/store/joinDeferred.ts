import { create } from "zustand";
import { registerServerReset } from "./serverResetRegistry";

/**
 * Channels whose secondary loads (members, notification and display
 * settings, upload sessions and limits, tasks) a join holds: from the click
 * on Join until messages and channel info are back, the joined channel is
 * painted and the browser is idle (channelJoin.ts, #proj-frontend:#24).
 * Each hold has its own token, so a stale release from an earlier join cannot
 * end a newer one. Empty for a channel opened without a join.
 */
export const useJoinDeferredStore = create<{ ids: Record<string, number> }>(() => ({ ids: {} }));

let lastToken = 0;

/** Holds the channel's secondary loads; returns the token that releases this hold. */
export function holdJoinDeferred(channelId: string): number {
  const token = ++lastToken;
  useJoinDeferredStore.setState((s) => ({ ids: { ...s.ids, [channelId]: token } }));
  return token;
}

/**
 * Ends the hold: the join's own release passes its token (a newer hold is
 * left alone); a surface opened during the hold (the channel drawer) passes
 * none and ends whatever hold there is.
 */
export function releaseJoinDeferred(channelId: string, token?: number): void {
  const { ids } = useJoinDeferredStore.getState();
  const held = ids[channelId];
  if (held === undefined || (token !== undefined && held !== token)) return;
  const { [channelId]: _released, ...rest } = ids;
  useJoinDeferredStore.setState({ ids: rest });
}

export function useJoinDeferred(channelId: string | null | undefined): boolean {
  return useJoinDeferredStore((s) => !!channelId && s.ids[channelId] !== undefined);
}

registerServerReset(() => useJoinDeferredStore.setState({ ids: {} }));
