import { useCallback, useMemo, useState } from "react";
import type { Dispatch, SetStateAction } from "react";
import { useLocation, useNavigate } from "react-router-dom";
import { useServerStore } from "../../store/serverStore";
import { openUpgradeDialog } from "../../store/upgradeDialogStore";
import type { ExternalLimitContext } from "../../store/upgradeDialogStore";
import { UPGRADE_SERVER_PARAM } from "../billing/upgradeGateCopy";
import { getExternalInvite } from "./externalInviteAccept";
import type { RefusalUpgradeGate } from "./externalInviteAccept";
import type { InviteStep, InviteView } from "./inviteSteps";

/**
 * Upgrading one of the invitee's servers from the invite page (design v4 C).
 *
 * - `upgradeRow`: a connect row's Upgrade (a server at the free plan's one
 *   external channel). Their own server: the upgrade dialog opens on this page
 *   (ServerUpgradeDialog), titled for connecting it to the invite's channel,
 *   and Stripe brings them back here. An admin an older server still offered
 *   Upgrade to: into that server in the app, where the dialog asks an owner.
 * - `upgradeInApp`: that, as a refusal's Upgrade does it (the dialog for the
 *   refusal's gate, on the server, in the app; as before).
 * - `landingStep`: back from Stripe, the page opens on the connect list
 *   instead of the ways in.
 * - `refreshAfterPaid`: once the server is Pro, the invite and the server
 *   list are read again, and the server can be chosen.
 */
export function useInviteUpgrade({ token, channel, setView }: {
  token: string;
  /** The invite's channel, with its #. */
  channel: string;
  setView: Dispatch<SetStateAction<InviteView>>;
}) {
  const location = useLocation();
  const navigate = useNavigate();
  const myServers = useServerStore((s) => s.servers);
  const setCurrent = useServerStore((s) => s.setCurrent);
  const loadServers = useServerStore((s) => s.loadServers);
  // Read once: the dialog's host drops Stripe's parameters as it opens.
  const [backFromCheckout] = useState(() => new URLSearchParams(location.search).has(UPGRADE_SERVER_PARAM));
  const externalContext = useMemo<ExternalLimitContext>(() => ({ kind: "connect", channel }), [channel]);

  const upgradeInApp = useCallback((serverId: string | null | undefined, gate: RefusalUpgradeGate = "external_channel_free_limit") => {
    const server = myServers.find((mine) => mine.id === serverId);
    if (!server) return;
    setCurrent(server);
    navigate(`/s/${server.slug}`);
    // The joint free-server cap's dialog for no specific limit names no paywall, so no surface, as before.
    openUpgradeDialog(gate, gate === "general" ? { serverId: server.id } : { serverId: server.id, surface: "external_invite_page" });
  }, [myServers, setCurrent, navigate]);

  const upgradeRow = useCallback((serverId: string) => {
    // Only an owner pays: an admin an older server still offered Upgrade to asks one, in the app.
    if (myServers.find((mine) => mine.id === serverId)?.role !== "owner") {
      upgradeInApp(serverId);
      return;
    }
    openUpgradeDialog("external_channel_free_limit", { serverId, surface: "external_invite_page", externalContext, onPage: true });
  }, [externalContext, myServers, upgradeInApp]);

  const landingStep = useCallback((step: InviteStep): InviteStep => (
    backFromCheckout && step.kind === "options" ? { kind: "connect" } : step
  ), [backFromCheckout]);

  const refreshAfterPaid = useCallback(() => {
    void loadServers({ fresh: true, listOnly: true }).catch(() => undefined);
    getExternalInvite(token)
      .then((fresh) => setView((current) => ({ ...current, invite: fresh })))
      .catch(() => undefined);
  }, [loadServers, setView, token]);

  return { externalContext, upgradeRow, upgradeInApp, landingStep, refreshAfterPaid };
}
