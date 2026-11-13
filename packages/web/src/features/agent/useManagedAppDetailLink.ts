import { useCallback } from "react";
import type { MouseEvent } from "react";
import { useIntl } from "react-intl";
import { useAppNavigate } from "../../hooks/useAppNavigate";
import { useServerPermissions } from "../../hooks/useServerPermissions";
import { useServerStore } from "../../store/serverStore";
import type { Agent } from "../../store/agentStore";
import { installedAppDetailSearch } from "../apps/useAppBotLink";

/**
 * An App bot's profile names the App it belongs to; that name links to the
 * App's installed detail on the Apps page, the dialog its card there opens
 * (`?installed_app=`, features/apps/useAppBotLink.ts). The profile's
 * `managedByApp.clientId` is the App's row id (server routes/agents.ts), which
 * is what the Apps page matches. A plain click navigates in the app; Cmd/Ctrl,
 * Shift or the middle button is the browser's (a new tab or window).
 *
 * Null where the viewer has no such page or the App isn't this Server's: a
 * guest (the Apps route sends guests away), a bot seen from another Server of
 * a joint channel, or a bounded public projection. There the name stays text.
 */
export function useManagedAppDetailLink(agent: Pick<Agent, "managedByAppInstallId" | "managedByApp" | "serverId" | "profileProjection">) {
  const { formatMessage } = useIntl();
  const nav = useAppNavigate();
  const { role } = useServerPermissions();
  const currentServerId = useServerStore((s) => s.current?.id ?? null);
  const slug = useServerStore((s) => s.current?.slug ?? null);
  const appId = agent.managedByApp?.clientId ?? null;
  const appName = agent.managedByApp?.name ?? null;
  const fromOtherServer = Boolean(currentServerId && agent.serverId && agent.serverId !== currentServerId);
  const search = appId ? installedAppDetailSearch(appId) : null;
  const href = search && slug ? `/s/${encodeURIComponent(slug)}/apps${search}` : null;
  const onClick = useCallback((event: MouseEvent) => {
    if (event.metaKey || event.ctrlKey || event.shiftKey || event.altKey || event.button !== 0) return;
    event.preventDefault();
    if (search) nav.toApps(search);
  }, [search, nav]);
  const visible = Boolean(agent.managedByAppInstallId && href && appName && role && role !== "guest"
    && !fromOtherServer && agent.profileProjection !== "channel_summary");
  if (!visible) return null;
  return { href: href!, onClick, label: formatMessage({ id: "agent.detail.openAppDetails" }, { app: appName }) };
}
