import type { MarketplaceCursor, MarketplaceListing } from "@botiverse/raft-shared";
import type { AppsFilters } from "../../components/apps/appsFilters";
import type { MarketplaceOAuthClientRecord } from "./connected-apps/oauthClientRecords";

/** Discover's listings: pages of the Marketplace, Raft Apps and Raft's connected services in one list. */
export const MARKETPLACE_LISTINGS_PATH = "/integrations/marketplace/listings";

/** One Discover listing as the endpoint sends it; an App's `app` is its `GET /integrations/marketplace` record. */
export type DiscoverListing = MarketplaceListing<MarketplaceOAuthClientRecord>;

/**
 * The next page after the ones shown. The cursor is a position in the sort
 * (an install bucket, for the default sort), so an App that changed bucket
 * between two requests can come again: it keeps its first place.
 */
export function appendListings<T extends { id: string }>(shown: T[], next: T[]): T[] {
  const seen = new Set(shown.map((listing) => listing.id));
  return [...shown, ...next.filter((listing) => !seen.has(listing.id))];
}

/**
 * The request's parameters: the category and the search, in the server's
 * default order (the most used first). Discover names no App type (R4), so it
 * never sends `type`, and it has no Sort of its own.
 */
export function discoverListingParams(filters: Pick<AppsFilters, "category">, q: string, cursor?: MarketplaceCursor) {
  return {
    ...(filters.category !== "all" ? { category: filters.category } : {}),
    ...(q ? { q } : {}),
    ...(cursor ? { cursor } : {}),
  };
}
