import { useCallback } from "react";
import { useLocation, useNavigate } from "react-router-dom";
import { deferredDialog } from "../../boot/deferredUi";
import { useUpgradeDialogStore } from "../../store/upgradeDialogStore";
import type { ExternalLimitContext } from "../../store/upgradeDialogStore";
import { UPGRADE_RETURN_PARAMS, UPGRADE_SERVER_PARAM } from "./upgradeGateCopy";

type ServerUpgradeDialogProps = {
  externalContext?: ExternalLimitContext;
  onPaid: (serverId: string) => void;
  dropCheckoutReturn: () => void;
};

/**
 * ServerUpgradeDialog, loaded when it opens (boot/deferredUi). Its Close after
 * a failed download also drops a Stripe return's parameters, as the loaded
 * host would have.
 */
const ServerUpgradeDialogHost = deferredDialog<ServerUpgradeDialogProps>(
  () => import("./ServerUpgradeDialog").then(({ ServerUpgradeDialogHost: Host }) => ({
    default: ({ externalContext, onPaid }: ServerUpgradeDialogProps) => <Host externalContext={externalContext} onPaid={onPaid} />,
  })),
  {
    close: ({ dropCheckoutReturn }) => {
      useUpgradeDialogStore.getState().close();
      dropCheckoutReturn();
    },
  },
);

/**
 * The upgrade dialog of a page outside the app (the invite and approval
 * pages) for a server of the viewer's: mounted only while the page asked for
 * it (the store's request, `onPage`) or Stripe brought the page back naming the server
 * it paid for. See ServerUpgradeDialog.
 */
export function ServerUpgradeDialog({ externalContext, onPaid }: {
  /** What the page upgrades the server for, for the dialog Stripe brings back. */
  externalContext?: ExternalLimitContext;
  /** The server turned Pro after paying here. */
  onPaid: (serverId: string) => void;
}) {
  const requested = useUpgradeDialogStore((state) => state.request?.onPage === true);
  const location = useLocation();
  const navigate = useNavigate();
  const backFromCheckout = new URLSearchParams(location.search).has(UPGRADE_SERVER_PARAM);
  const dropCheckoutReturn = useCallback(() => {
    const params = new URLSearchParams(location.search);
    if (!params.has(UPGRADE_SERVER_PARAM)) return;
    for (const name of UPGRADE_RETURN_PARAMS) params.delete(name);
    const search = params.toString();
    navigate(
      { pathname: location.pathname, search: search ? `?${search}` : "", hash: location.hash },
      { replace: true, state: location.state },
    );
  }, [location.hash, location.pathname, location.search, location.state, navigate]);
  return requested || backFromCheckout
    ? <ServerUpgradeDialogHost externalContext={externalContext} onPaid={onPaid} dropCheckoutReturn={dropCheckoutReturn} />
    : null;
}
