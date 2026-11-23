import type { OAuthClientCategory } from "@botiverse/raft-shared";
import type { MessageId } from "../../i18n/messages";
import type { AppOrigin } from "../../features/apps/appView";
import type { ConnectedAppsTab } from "../settings/SettingsSegmentedControls";

/** Yours' one filter: where this Server got the App. */
export type AppsOriginFilter = AppOrigin | "all";

/**
 * The Apps page's toolbar: search on both scopes; Yours narrows its own list
 * by where the App came from (`origin`); Discover sends its Category to GET
 * /integrations/marketplace/listings. A scope ignores the other's filter.
 * Neither names an App type (R4), and Discover keeps the server's order (the
 * most used first): no Type, no Sort.
 */
export interface AppsFilters {
  search: string;
  origin: AppsOriginFilter;
  category: OAuthClientCategory | "all";
}

export const DEFAULT_APPS_FILTERS: AppsFilters = { search: "", origin: "all", category: "all" };

/** Whether something narrows the scope's list: the search, and the scope's own filter (Yours: origin; Discover: Category). */
export function hasActiveAppsFilters(filters: AppsFilters, scope: ConnectedAppsTab): boolean {
  if (filters.search.trim() !== "") return true;
  return scope === "yours" ? filters.origin !== "all" : filters.category !== "all";
}

/** Yours' origin filter, in the order its menu lists them. */
export const APPS_ORIGIN_FILTERS: readonly AppsOriginFilter[] = ["all", "internal", "shared", "marketplace"];

export const APPS_ORIGIN_LABEL_ID: Record<AppsOriginFilter, MessageId> = {
  all: "apps.filter.originAll",
  internal: "apps.filter.originInternal",
  shared: "apps.filter.originShared",
  marketplace: "apps.filter.originMarketplace",
};
