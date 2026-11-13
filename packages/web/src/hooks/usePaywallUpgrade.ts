import { useCallback } from "react";
import type { PaywallSurface } from "@botiverse/raft-shared";
import { useServerStore } from "../store/serverStore";
import { openUpgradeDialog } from "../store/upgradeDialogStore";
import type { ExternalLimitContext, HistoryLimitContext, UpgradeGate } from "../store/upgradeDialogStore";
import { useAppNavigate } from "./useAppNavigate";
import { isPaywallGate, trackPaywallAction } from "../analytics/paywall";
import { noteBillingEntry } from "../analytics/billingEntry";

/**
 * What a paywall's Upgrade does: on a Free server, open the upgrade dialog for the limit
 * just hit; on a paid server (a Joint Channel locked by other servers' plans), keep
 * going to Plan & Billing, since upgrading this server is not the answer there.
 */
export function usePaywallUpgrade(): (gate: UpgradeGate, surface?: PaywallSurface, historyContext?: HistoryLimitContext, externalContext?: ExternalLimitContext) => void {
  const nav = useAppNavigate();
  // The same reading the paywall labels use (billing first), so label and action agree.
  const plan = useServerStore((state) => state.billing?.plan || state.current?.plan);
  return useCallback((gate: UpgradeGate, surface?: PaywallSurface, historyContext?: HistoryLimitContext, externalContext?: ExternalLimitContext) => {
    if (!plan || plan === "free") {
      openUpgradeDialog(gate, { ...(surface ? { surface } : {}), ...(historyContext ? { historyContext } : {}), ...(externalContext ? { externalContext } : {}) });
      return;
    }
    if (isPaywallGate(gate)) {
      trackPaywallAction(gate, "view_billing", surface);
      // Plan & Billing names this paywall as the entry of a checkout or seat change it starts.
      noteBillingEntry(gate);
    }
    nav.toSettings("billing");
  }, [nav, plan]);
}
