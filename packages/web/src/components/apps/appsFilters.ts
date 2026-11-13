import type { MarketplaceListingSort, MarketplaceListingType, OAuthClientCategory } from "@botiverse/raft-shared";
import type { MessageId } from "../../i18n/messages";

/**
 * The Apps page's toolbar (#proj-apps task #22): search, then Type, Category
 * and Sort. The Marketplace sends them to GET /integrations/marketplace/listings;
 * Installed and My Apps filter their own lists with the same values.
 */
export interface AppsFilters {
  search: string;
  type: MarketplaceListingType;
  category: OAuthClientCategory | "all";
  sort: MarketplaceListingSort;
}

export const DEFAULT_APPS_FILTERS: AppsFilters = { search: "", type: "all", category: "all", sort: "installs" };

/** Search, Type and Category narrow the list; Sort only orders it, so Clear All leaves it. */
export function hasActiveAppsFilters(filters: AppsFilters): boolean {
  return filters.search.trim() !== "" || filters.type !== "all" || filters.category !== "all";
}

export const APPS_TYPE_LABEL_ID: Record<MarketplaceListingType, MessageId> = {
  all: "apps.filter.typeAll",
  app: "apps.filter.typeApp",
  mcp: "apps.filter.typeMcp",
};

export const APPS_SORT_LABEL_ID: Record<MarketplaceListingSort, MessageId> = {
  installs: "apps.filter.sortInstalls",
  published: "apps.filter.sortPublished",
  name: "apps.filter.sortName",
};

/** Whether a row of this kind shows under the Type filter. */
export function matchesAppsType(type: MarketplaceListingType, mcp: boolean): boolean {
  return type === "all" || (type === "mcp") === mcp;
}

