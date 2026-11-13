// The Marketplace as pages: `GET /api/integrations/marketplace/listings`, for
// the signed-in member in their current server (X-Server-Id). It lists two
// kinds of thing a server can add:
//
// - `app`: a Raft App on the Marketplace, as the Settings Marketplace tab shows
//   it (no private shares). `app` is the record `GET /api/integrations/marketplace`
//   returns for it, unchanged, so the existing install flow works from it.
// - `mcp`: a Raft-recommended MCP App template (`mcp_app_templates`). Adding one
//   is `POST /api/mcp/apps` with `{ source: { kind: "template", templateKey } }`,
//   which needs `manageIntegrations`, as for installing an App.
//
// `GET /api/integrations/marketplace` keeps its answer (the whole App array),
// for the clients that read it today.
//
// Query (every parameter optional):
// - `type`: all (default) | app | mcp;
// - `category`: one of OAUTH_CLIENT_CATEGORIES; Apps and templates share them;
// - `sort`: installs (default: the highest install bucket first, then newest)
//   | published (newest first) | name (A to Z). Ties go to the name, then the
//   listing id, so the order is total;
// - `limit`: 1 to MARKETPLACE_LISTINGS_MAX_LIMIT, default
//   MARKETPLACE_LISTINGS_DEFAULT_LIMIT;
// - `q`: text in the name or description, case-insensitive;
// - `cursor`: a page's `nextCursor`. It continues the listing it came from
//   (same type, category, sort and q) after the last item that page held.
// Errors are `{ error, code }` (MARKETPLACE_LISTINGS_ERROR_CODES). Answers are
// per reader: `Cache-Control: private, no-store`.

import type { Brand } from "./brandedIds";
import type { MarketplaceInstallBucket } from "./marketplaceInstalls";
import type { OAuthClientCategory } from "./oauthClientCategories";

export const MARKETPLACE_LISTING_TYPES = ["all", "app", "mcp"] as const;
export type MarketplaceListingType = (typeof MARKETPLACE_LISTING_TYPES)[number];

export const MARKETPLACE_LISTING_SORTS = ["installs", "published", "name"] as const;
export type MarketplaceListingSort = (typeof MARKETPLACE_LISTING_SORTS)[number];

/** Items a page holds when `limit` is absent. */
export const MARKETPLACE_LISTINGS_DEFAULT_LIMIT = 24;
/** The largest `limit`. */
export const MARKETPLACE_LISTINGS_MAX_LIMIT = 100;
/** The longest `q`, in characters, after trimming. */
export const MARKETPLACE_LISTINGS_QUERY_MAX_CHARS = 200;

/**
 * A listing's id: `app:<App id>` or `mcp:<template key>`, unique across both
 * kinds. Opaque to clients; minted by the server.
 */
export type MarketplaceListingId = Brand<string, "MarketplaceListingId">;

/** A page's `nextCursor`: opaque to clients, minted and read by the server. */
export type MarketplaceCursor = Brand<string, "MarketplaceCursor">;

export interface MarketplaceListingsQuery {
  type?: MarketplaceListingType;
  category?: OAuthClientCategory;
  sort?: MarketplaceListingSort;
  limit?: number;
  q?: string;
  cursor?: MarketplaceCursor;
}

interface MarketplaceListingBase {
  id: MarketplaceListingId;
  name: string;
  description: string | null;
  logoUrl: string | null;
  category: OAuthClientCategory;
  /**
   * How widely it is used, as a bucket only (marketplaceInstalls.ts); null
   * below the first bucket. Exact counts are never sent, here or in a cursor.
   * Apps: their install badge's bucket (active installations on servers other
   * than the App's own). MCP: servers with an MCP App made from the template.
   */
  installBucket: MarketplaceInstallBucket | null;
  /**
   * ISO time. Apps: the publish approval (else the review time, else creation).
   * MCP: when the template joined the catalog; null while the server serves
   * its bundled fallback catalog, which has no times.
   */
  publishedAt: string | null;
  /** This server has it: an App installation, or an MCP App made from the template. */
  installed: boolean;
}

/** `App` is the record of `GET /api/integrations/marketplace`, as its reader types it. */
export interface MarketplaceAppListing<App> extends MarketplaceListingBase {
  kind: "app";
  /** The publishing server's name, else its creator's display name. */
  publisherName: string | null;
  app: App;
}

export interface MarketplaceMcpListing extends MarketplaceListingBase {
  kind: "mcp";
  /** `source.templateKey` for `POST /api/mcp/apps`. */
  templateKey: string;
  homepageUrl: string;
}

export type MarketplaceListing<App> = MarketplaceAppListing<App> | MarketplaceMcpListing;

export interface MarketplaceListingsResponse<App> {
  items: MarketplaceListing<App>[];
  nextCursor: MarketplaceCursor | null;
  /** Items matching type, category and q, over all pages ("Showing n / total"). */
  total: number;
}

/**
 * - 400 INVALID_REQUEST: `type`, `category`, `sort`, `limit` or `q` out of
 *   range, or a parameter given twice;
 * - 400 INVALID_CURSOR: not a cursor of this listing with the same type,
 *   category, sort and q: drop it to start over.
 */
export const MARKETPLACE_LISTINGS_ERROR_CODES = ["INVALID_REQUEST", "INVALID_CURSOR"] as const;
export type MarketplaceListingsErrorCode = (typeof MARKETPLACE_LISTINGS_ERROR_CODES)[number];
