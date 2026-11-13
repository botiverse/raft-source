import { useCallback } from "react";
import { useLocation, useNavigate } from "react-router-dom";
import { deferredDialog } from "../../boot/deferredUi";
import { useUpgradeDialogStore } from "../../store/upgradeDialogStore";
import { UPGRADE_RETURN_PARAM, UPGRADE_RETURN_PARAMS } from "./upgradeGateCopy";

type UpgradeDialogHostProps = { dropCheckoutReturn: () => void };

/**
 * UpgradeDialog, kept out of the first download (boot/deferredUi). Its Close
 * after a failed download also drops a Stripe return's parameters: the
 * loaded host would have, and while they stay this wrapper keeps the
 * (failed) dialog mounted.
 */
const UpgradeDialogHost = deferredDialog<UpgradeDialogHostProps>(
  () => import("./UpgradeDialog").then(({ default: Host }) => ({ default: (_: UpgradeDialogHostProps) => <Host /> })),
  {
    close: ({ dropCheckoutReturn }) => {
      useUpgradeDialogStore.getState().close();
      dropCheckoutReturn();
    },
  },
);

/**
 * Mounts the upgrade dialog's host only when it has something to do: a
 * paywall opened it (the store's request), or Stripe brought the page back
 * with the paywall it started from. With neither the host renders nothing
 * and its effects do nothing, so leaving it unmounted changes nothing.
 */
export default function DeferredUpgradeDialogHost() {
  const requested = useUpgradeDialogStore((state) => state.request !== null);
  const location = useLocation();
  const navigate = useNavigate();
  const backFromCheckout = new URLSearchParams(location.search).has(UPGRADE_RETURN_PARAM);
  const dropCheckoutReturn = useCallback(() => {
    const params = new URLSearchParams(location.search);
    if (!params.has(UPGRADE_RETURN_PARAM)) return;
    for (const name of UPGRADE_RETURN_PARAMS) params.delete(name);
    const search = params.toString();
    navigate(
      { pathname: location.pathname, search: search ? `?${search}` : "", hash: location.hash },
      { replace: true, state: location.state },
    );
  }, [location.hash, location.pathname, location.search, location.state, navigate]);
  return requested || backFromCheckout ? <UpgradeDialogHost dropCheckoutReturn={dropCheckoutReturn} /> : null;
}
