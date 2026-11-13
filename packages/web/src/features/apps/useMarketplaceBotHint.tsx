import { useCallback } from "react";
import { ConnectedAppBotMarketplaceHint } from "../../components/settings/ConnectedAppBot";
import type { AppBotOffer } from "../../components/settings/ConnectedAppBot";
import type { InstalledConnectedApp } from "./connected-apps/connectedAppTypes";

/**
 * #proj-apps:#35 layer 2 (artin: no notifications, a hint in the
 * Marketplace): the card and the listing of an App this Server has installed
 * offer its bot while no one has decided on it (`pending`); declined or
 * added, they say nothing. The bot is read from the installed list by the
 * App's id, so an Add moves every place together. Owners and admins get
 * `onAdd` (Settings › Apps' add, its second step included); members read who
 * can add it.
 */
export function useMarketplaceBotHint({
  installedApps,
  serverName,
  canManage,
  botBusyClientId,
  onAdd,
}: {
  installedApps: readonly InstalledConnectedApp[];
  serverName: string;
  canManage: boolean;
  botBusyClientId: string | null;
  onAdd: (clientRowId: string, bot: AppBotOffer, action: "grant") => Promise<void>;
}) {
  const handleAdd = useCallback((appId: string, bot: AppBotOffer) => {
    void onAdd(appId, bot, "grant");
  }, [onAdd]);
  return useCallback((appId: string) => {
    const bot = installedApps.find((app) => app.id === appId)?.bot;
    if (bot?.grant !== "pending") return null;
    return (
      <ConnectedAppBotMarketplaceHint
        appId={appId}
        bot={bot}
        serverName={serverName}
        canManage={canManage}
        busy={botBusyClientId === appId}
        onAdd={handleAdd}
      />
    );
  }, [botBusyClientId, canManage, handleAdd, installedApps, serverName]);
}
