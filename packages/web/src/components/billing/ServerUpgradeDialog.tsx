import { useCallback, useEffect, useEffectEvent, useState } from "react";
import { useIntl } from "react-intl";
import { useLocation, useNavigate } from "react-router-dom";
import { PAYWALL_SURFACES } from "@botiverse/raft-shared";
import type { PaywallSurface } from "@botiverse/raft-shared";
import api from "../../api/client";
import { isPaywallGate, trackPaywallAction } from "../../analytics/paywall";
import { useServerStore } from "../../store/serverStore";
import type { BillingInfo } from "../../store/serverStore";
import { isUpgradeGate, useUpgradeDialogStore } from "../../store/upgradeDialogStore";
import type { ExternalLimitContext } from "../../store/upgradeDialogStore";
import { showToast } from "../toastBridge";
import { ServerOwnerUpgradeDialog } from "./UpgradeDialog";
import {
  GATE_COPY,
  gateValues,
  UPGRADE_CANCELED_PARAM,
  UPGRADE_RETURN_PARAM,
  UPGRADE_RETURN_PARAMS,
  UPGRADE_SERVER_PARAM,
  UPGRADE_SURFACE_PARAM,
} from "./upgradeGateCopy";

/** How often the plan is read while the payment lands: no socket tells a page outside the app. */
const PAID_POLL_MS = 4000;

function readSurface(value: string | null): PaywallSurface | undefined {
  return (PAYWALL_SURFACES as readonly string[]).includes(value ?? "") ? value as PaywallSurface : undefined;
}

function isFreePlan(plan: string | undefined): boolean {
  return !plan || plan === "free";
}

/**
 * The upgrade dialog on a page outside the app (the invite and approval pages,
 * design v4 C and E), for a server of the viewer's that is not the current
 * one: an owner pays for it here and comes back here. Mounted on demand by
 * DeferredServerUpgradeDialog (a request in the store, or Stripe's return).
 *
 * The server is the request's (`openUpgradeDialog(gate, { serverId, onPage: true })`), named
 * from the viewer's server list. Its billing (seats, a renewal, the plan) is
 * read here for that server (`X-Server-Id`), and read again while the payment
 * lands, since nothing pushes a plan change to this page. Stripe returns to
 * this page with the server named (`upgradeServer`); the dialog comes back
 * waiting for the plan, or with the choices after a cancel. Paid (the plan is
 * no longer Free): it closes with the app's toast, and `onPaid` lets the page
 * go on (the invitee connects the server, the approver approves).
 */
export function ServerUpgradeDialogHost({ externalContext, onPaid }: {
  /** What the page upgrades the server for (`connect`: to another server's channel), for the dialog Stripe brings back. */
  externalContext?: ExternalLimitContext;
  onPaid: (serverId: string) => void;
}) {
  const { formatMessage } = useIntl();
  const location = useLocation();
  const navigate = useNavigate();
  // Only what this page opened: the app's own requests are the app's dialog's.
  const request = useUpgradeDialogStore((state) => (state.request?.onPage ? state.request : null));
  const open = useUpgradeDialogStore((state) => state.open);
  const close = useUpgradeDialogStore((state) => state.close);
  const serverId = request?.serverId ?? null;
  const server = useServerStore((state) => (serverId ? state.servers.find((candidate) => candidate.id === serverId) ?? null : null));
  const [billing, setBilling] = useState<{ serverId: string; info: BillingInfo } | null>(null);

  // Back from Stripe: drop the parameters through the router, then wait for the plan, or offer the choices again.
  useEffect(() => {
    const params = new URLSearchParams(location.search);
    const gate = params.get(UPGRADE_RETURN_PARAM);
    const returnServerId = params.get(UPGRADE_SERVER_PARAM);
    if (!isUpgradeGate(gate) || !returnServerId) return;
    const canceled = params.get(UPGRADE_CANCELED_PARAM) === "1";
    const surface = readSurface(params.get(UPGRADE_SURFACE_PARAM));
    for (const name of UPGRADE_RETURN_PARAMS) params.delete(name);
    const search = params.toString();
    navigate(
      { pathname: location.pathname, search: search ? `?${search}` : "", hash: location.hash },
      { replace: true, state: location.state },
    );
    open(gate, returnServerId, { stage: canceled ? "choose" : "confirming", surface, externalContext, onPage: true });
  }, [externalContext, location.hash, location.pathname, location.search, location.state, navigate, open]);

  // Paid (the plan is no longer Free): close with the app's toast, and the page goes on.
  const finishPaid = useEffectEvent((paidServerId: string) => {
    const current = useUpgradeDialogStore.getState().request;
    if (!current?.onPage || current.serverId !== paidServerId) return;
    close();
    // Not waiting for a payment (opened, or back from a cancelled checkout):
    // the server is simply not on Free; nothing was paid here, so the page
    // doesn't go on (Warden, #14553 review).
    if (current.stage !== "paying" && current.stage !== "confirming") return;
    const name = useServerStore.getState().servers.find((candidate) => candidate.id === paidServerId)?.name;
    if (name) {
      showToast({
        title: formatMessage({ id: "upgradeDialog.paidToast" }, { server: name }),
        description: formatMessage({ id: GATE_COPY[current.gate].done }, gateValues(name)),
        type: "success",
        data: { intent: "success" },
      });
    }
    onPaid(paidServerId);
  });

  // The server's billing, and again while the payment lands (every few seconds, and on coming back to the window).
  const waiting = request?.stage === "paying" || request?.stage === "confirming";
  useEffect(() => {
    if (!serverId) return;
    let live = true;
    const read = () => {
      api.get<BillingInfo>("/billing/subscription", { headers: { "X-Server-Id": serverId } })
        .then(({ data }) => {
          if (!live) return;
          if (isFreePlan(data.plan)) setBilling({ serverId, info: data });
          else finishPaid(serverId);
        })
        .catch(() => undefined);
    };
    read();
    if (!waiting) return () => { live = false; };
    const timer = window.setInterval(read, PAID_POLL_MS);
    const onReturn = () => {
      if (document.visibilityState !== "hidden") read();
    };
    window.addEventListener("focus", onReturn);
    document.addEventListener("visibilitychange", onReturn);
    return () => {
      live = false;
      window.clearInterval(timer);
      window.removeEventListener("focus", onReturn);
      document.removeEventListener("visibilitychange", onReturn);
    };
  }, [serverId, waiting]);

  const info = billing && billing.serverId === serverId ? billing.info : null;

  const handleOpenChange = useCallback((next: boolean) => {
    if (next) return;
    // Closed by the person while still choosing: a paywall's dialog left without acting.
    const current = useUpgradeDialogStore.getState().request;
    if (current && current.stage === "choose" && !current.source && isPaywallGate(current.gate)) {
      trackPaywallAction(current.gate, "dismiss", current.surface, current.serverId);
    }
    close();
  }, [close]);

  if (!request || !server) return null;
  return (
    <ServerOwnerUpgradeDialog
      gate={request.gate}
      stage={request.stage}
      serverId={server.id}
      serverName={server.name}
      surface={request.surface}
      billing={info}
      onOpenChange={handleOpenChange}
    />
  );
}
