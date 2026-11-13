// In-app navigation (RFC-067 `page_viewed`): one event per path change inside
// a server, carrying only the route name, never the path, ids or query. Paths
// under no tracked route send nothing; a settings path that only redirects
// counts as plain `settings` (see settingsTabForSegment).

import { useEffect } from "react";
import { RETIRED_SETTINGS_PAGE_TABS, SETTINGS_PAGE_TABS } from "@botiverse/raft-shared";
import type { ProductEventProperties } from "@botiverse/raft-shared";
import { legacySettingsRouteRedirectSlug, settingsTabIdForRouteSlug } from "../components/settings/settingsNavigation";
import { isHostShell } from "../embed";
import { useServerStore } from "../store/serverStore";
import { trackEvent } from "./track";

type PageRoute = NonNullable<ProductEventProperties<"page_viewed">["route"]>;
type SettingsTab = NonNullable<ProductEventProperties<"page_viewed">["settings_tab"]>;

function isSettingsTab(value: string): value is SettingsTab {
  return (SETTINGS_PAGE_TABS as readonly string[]).includes(value)
    && !(RETIRED_SETTINGS_PAGE_TABS as readonly string[]).includes(value);
}

/**
 * The Settings tab a path segment shows, or null when the path shows none. A tab's path is not
 * always its id: Applications is the tab `integrations` at `/settings/applications`, and
 * `/settings/server-labs` shows Labs.
 *
 * A path that only redirects is not a tab view: the page sends one `page_viewed` with route
 * "settings" and no tab before the redirect, then one for the target, so each visit counts once.
 * That covers retired tabs, old slugs (`/settings/integrations`, `/settings/browser`) and, for
 * everyone but a guest and the native host shell, Applications itself, which opens the Apps page
 * (`applicationsShown`; SettingsRoute in MainLayout).
 */
function settingsTabForSegment(segment: string, applicationsShown: boolean): SettingsTab | null {
  if (legacySettingsRouteRedirectSlug(segment) !== null) return null;
  const tab = settingsTabIdForRouteSlug(segment);
  if (tab === null || !isSettingsTab(tab)) return null;
  if (tab === "integrations" && !applicationsShown) return null;
  return tab;
}

/**
 * Whether Settings › Applications is shown as a settings page right now: only to a guest and in
 * the native host shell (SettingsRoute sends everyone else to /apps). Unknown server: not shown.
 */
function settingsApplicationsShown(): boolean {
  return isHostShell() || useServerStore.getState().current?.role === "guest";
}

const ROUTE_BY_SEGMENT: Readonly<Record<string, PageRoute>> = {
  channel: "channel",
  dm: "dm",
  activity: "activity",
  tasks: "tasks",
  saved: "saved",
  search: "search",
  members: "members",
  agent: "agent",
  human: "human",
  computer: "computer",
  machine: "computer", // legacy alias of computer/:machineId
  computers: "computers",
  apps: "apps",
  artifacts: "artifacts",
  settings: "settings",
  "release-notes": "release_notes",
  assistant: "assistant",
};

export function pageRouteFor(
  pathname: string,
  /** Settings › Applications renders (a guest, the host shell) instead of redirecting to /apps. */
  applicationsShown = false,
): { route: PageRoute; settingsTab?: SettingsTab } | null {
  const match = /^\/s\/[^/]+\/?(.*)$/.exec(pathname);
  if (!match) return null;
  const [first = "", second = "", third = ""] = match[1].split("/");
  // A conversation's own search (/channel/:id/search, /dm/:id/search), as the
  // native apps already report it; `search` is the global Search tab.
  if ((first === "channel" || first === "dm") && second && third === "search") return { route: "conversation_search" };
  const route = Object.prototype.hasOwnProperty.call(ROUTE_BY_SEGMENT, first) ? ROUTE_BY_SEGMENT[first] : undefined;
  if (!route) return null;
  // Only known tabs: whatever someone types into the address bar is not recorded.
  const settingsTab = route === "settings" ? settingsTabForSegment(second, applicationsShown) : null;
  return settingsTab ? { route, settingsTab } : { route };
}

export function usePageViewTracking(pathname: string): void {
  useEffect(() => {
    const page = pageRouteFor(pathname, settingsApplicationsShown());
    if (!page) return;
    trackEvent("page_viewed", page.settingsTab
      ? { route: page.route, settings_tab: page.settingsTab }
      : { route: page.route });
  }, [pathname]);
}
