import { useEffect } from "react";
import type { Channel } from "../store/channelStore";
import { useReadReceiptStore } from "../store/readReceiptStore";
import {
  READ_RECEIPTS_FEATURE_FLAG_KEY,
  useServerFeatureFlag,
} from "../store/serverFeatureFlags";

export function isReadReceiptScopeEligible(
  channel: Pick<Channel, "id" | "name" | "type"> | null,
): channel is Pick<Channel, "id" | "name" | "type"> {
  return !!channel
    && channel.name !== "all"
    && channel.type !== "joint"
    && channel.type !== "thread";
}

export function useReadReceiptHydrate(channel: Channel | null): void {
  const hydrateScope = useReadReceiptStore((state) => state.hydrateScope);
  const clearAll = useReadReceiptStore((state) => state.clearAll);
  const { enabled } = useServerFeatureFlag(READ_RECEIPTS_FEATURE_FLAG_KEY);
  const eligible = enabled && isReadReceiptScopeEligible(channel);
  const scopeId = eligible ? channel.id : null;

  useEffect(() => {
    if (!enabled) {
      clearAll();
      return;
    }
    if (!scopeId) return;
    void hydrateScope(scopeId);
  }, [clearAll, enabled, hydrateScope, scopeId]);
}
