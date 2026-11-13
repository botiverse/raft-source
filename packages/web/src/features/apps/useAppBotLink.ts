import { useCallback, useEffect, useEffectEvent, useMemo, useState } from "react";
import { useLocation, useNavigate } from "react-router-dom";
import { useAppNavigate } from "../../hooks/useAppNavigate";
import type { InstalledConnectedApp } from "./connected-apps/connectedAppTypes";

const APP_BOT = "app_bot";
const INSTALLED_APP = "installed_app";

/** The Apps page search (with its `?`) that opens one installed App's detail, by the App's id (the row id, not its client_id). */
export function installedAppDetailSearch(appId: string): string {
  return `?${new URLSearchParams({ [INSTALLED_APP]: appId }).toString()}`;
}

/**
 * The Apps page's two addresses that open an installed App's detail. Both are
 * handled once the list is read, in one pass, and leave the address with one
 * replace (the other parameters kept), so Refresh or Back doesn't open them
 * again and neither handler can put back what the other removed.
 *
 * - `?app_bot=<client_id>`, the link an App sends to get its bot added
 *   (#proj-apps:#35): the public OAuth client_id (never the row id). This
 *   Server's installation of that App opens (`show(app)`, which marks the
 *   detail as opened from the link) on its bot section, which takes focus and
 *   keeps the usual Add / Don't Add; a member reads who can add it. An
 *   installed App without a bot (or with the bot UI off) opens on its plain
 *   detail. Any other client_id, unknown or just not installed here, gets one
 *   notice (`show(undefined)`), so the link can't tell whether a private App exists.
 * - `?installed_app=<app id>`, an App bot's profile naming its App
 *   (`installedAppDetailSearch`): the App's id, the row id the profile's
 *   `managedByApp.clientId` carries (server routes/agents.ts). The installed
 *   App with that id opens as its card opens it (`openInstalled(app)`).
 */
export function useAppBotLink({
  loaded,
  installedApps,
  show,
  openInstalled,
  closeDetail,
}: {
  loaded: boolean;
  installedApps: readonly InstalledConnectedApp[];
  show: (app: InstalledConnectedApp | undefined) => void;
  openInstalled: (app: InstalledConnectedApp) => void;
  closeDetail: () => void;
}) {
  const location = useLocation();
  const navigate = useNavigate();
  // Whether the link named an App this Server doesn't have installed.
  const [notInstalled, setNotInstalled] = useState(false);
  const handleLinks = useCallback(() => {
    if (!loaded) return;
    const params = new URLSearchParams(location.search);
    if (params.has(APP_BOT)) {
      const requested = params.get(APP_BOT)?.trim();
      const app = installedApps.find((entry) => entry.clientId === requested);
      show(app);
      setNotInstalled(!app);
    } else if (params.has(INSTALLED_APP)) {
      const requested = params.get(INSTALLED_APP)?.trim();
      const app = installedApps.find((entry) => entry.id === requested);
      // Nothing opens and nothing is said when it isn't installed here: the
      // link comes from a profile this viewer could already read, and a notice
      // would only tell a stranger's crafted link whether a private App exists.
      if (app) openInstalled(app);
    }
    params.delete(APP_BOT);
    params.delete(INSTALLED_APP);
    const search = params.toString();
    void navigate({ pathname: location.pathname, search: search ? `?${search}` : "", hash: location.hash }, { replace: true });
  }, [installedApps, loaded, location.hash, location.pathname, location.search, navigate, openInstalled, show]);
  const handleLinksFromLocation = useEffectEvent(handleLinks);
  useEffect(() => {
    const params = new URLSearchParams(location.search);
    if (params.has(APP_BOT) || params.has(INSTALLED_APP)) handleLinksFromLocation();
  }, [location.search, loaded]);
  const dismissNotInstalled = useCallback(() => setNotInstalled(false), []);
  // A member's way on from the bot section: the Server's people, where its owners and admins are.
  const nav = useAppNavigate();
  const addLink = useMemo(() => ({
    onFindAdmin: () => {
      closeDetail();
      nav.toMembers();
    },
  }), [closeDetail, nav]);
  return { addLink, notInstalled, dismissNotInstalled };
}
