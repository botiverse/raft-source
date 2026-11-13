import { useEffect } from "react";
import type { Channel } from "../store/channelStore";
import { useReadReceiptStore } from "../store/readReceiptStore";

type ReadReceiptScopeChannel = Pick<Channel, "id" | "name" | "type">;

/**
 * A thread is eligible here; the server decides from its parent (threads under
 * #all hydrate as disabled), since the client only knows the thread's own id.
 * A joint channel is eligible: its detail carries the agents of every server
 * in it (people never).
 */
export function isReadReceiptScopeEligible(
  channel: ReadReceiptScopeChannel | null,
): channel is ReadReceiptScopeChannel {
  return !!channel && channel.name !== "all";
}

export function useReadReceiptHydrate(channel: ReadReceiptScopeChannel | null): void {
  const hydrateScope = useReadReceiptStore((state) => state.hydrateScope);
  const scopeId = isReadReceiptScopeEligible(channel) ? channel.id : null;

  useEffect(() => {
    if (!scopeId) return;
    void hydrateScope(scopeId);
  }, [hydrateScope, scopeId]);
}
