/**
 * `GET /api/integrations/marketplace/listings` (contract: packages/shared/src/marketplaceListingsContract.ts):
 * Marketplace Apps and Raft-recommended MCP App templates as one ranked, paged list.
 *
 * Each request reads and ranks the whole Marketplace, as `GET /api/integrations/marketplace` already
 * reads it whole, and answers the slice after the cursor's position. The catalog is the public Apps
 * plus the active templates (tens today); page in SQL instead if it grows to thousands.
 *
 * A cursor is the last item's sort position plus the filters and sort it was minted for. It carries
 * no authority (any position in a list the reader may see), so it is validated, not signed. Install
 * counts reach neither the answer nor a cursor: both carry the bucket (its rank in the cursor).
 */
import { isNotNull, sql } from "drizzle-orm";
import { z } from "zod";
import {
  MARKETPLACE_INSTALL_BUCKETS,
  MARKETPLACE_LISTING_SORTS,
  OAUTH_CLIENT_CATEGORIES,
  MARKETPLACE_LISTING_TYPES,
  MARKETPLACE_LISTINGS_DEFAULT_LIMIT,
  MARKETPLACE_LISTINGS_MAX_LIMIT,
  MARKETPLACE_LISTINGS_QUERY_MAX_CHARS,
  marketplaceInstallBucket,
  type MarketplaceAppListing,
  type MarketplaceCursor,
  type MarketplaceInstallBucket,
  type MarketplaceListing,
  type MarketplaceListingId,
  type MarketplaceListingSort,
  type MarketplaceListingsErrorCode,
  type MarketplaceListingsResponse,
  type MarketplaceListingType,
  type MarketplaceMcpListing,
  type OAuthClientCategory,
} from "@botiverse/raft-shared";
import { getDb } from "../db/index";
import { managedMcpServers } from "../db/schema";
import { listMcpAppTemplatesWithCreatedAt } from "./mcpAppTemplates";
import { isMarketplaceTabClient, listMarketplaceOAuthClientEntries } from "./oauthService";
import { clientLogoUrl } from "../config/privacyMode";

/** An App's record exactly as `GET /api/integrations/marketplace` answers it. */
export type MarketplaceAppRecord = Awaited<ReturnType<typeof listMarketplaceOAuthClientEntries>>[number]["client"];

/** Where an item sits in every sort; a cursor holds the last item's. */
type SortPosition = {
  /** 0 below the first install bucket, then 1, 2, ... in MARKETPLACE_INSTALL_BUCKETS order. */
  installRank: number;
  /** Epoch ms; null sorts after every time. */
  publishedAt: number | null;
  name: string;
  id: string;
};

export type MarketplaceListingsRequest = {
  type: MarketplaceListingType;
  category: OAuthClientCategory | null;
  sort: MarketplaceListingSort;
  limit: number;
  q: string | null;
  /** The previous page's last position; null for the first page. */
  after: SortPosition | null;
};

type ParseResult =
  | { ok: true; request: MarketplaceListingsRequest }
  | { ok: false; code: MarketplaceListingsErrorCode; error: string };

const CURSOR_MAX_CHARS = 2048;

const cursorSchema = z.object({
  type: z.enum(MARKETPLACE_LISTING_TYPES),
  category: z.enum(OAUTH_CLIENT_CATEGORIES).nullable(),
  sort: z.enum(MARKETPLACE_LISTING_SORTS),
  q: z.string().nullable(),
  after: z.object({
    installRank: z.number().int().min(0).max(MARKETPLACE_INSTALL_BUCKETS.length),
    publishedAt: z.number().int().nullable(),
    name: z.string(),
    id: z.string().regex(/^(app|mcp):./u),
  }).strict(),
}).strict();

type CursorContent = z.infer<typeof cursorSchema>;

function encodeCursor(content: CursorContent): MarketplaceCursor {
  return Buffer.from(JSON.stringify(content), "utf8").toString("base64url") as MarketplaceCursor;
}

function decodeCursor(raw: string): CursorContent | null {
  if (raw.length > CURSOR_MAX_CHARS || !/^[A-Za-z0-9_-]+$/u.test(raw)) return null;
  try {
    const parsed = cursorSchema.safeParse(JSON.parse(Buffer.from(raw, "base64url").toString("utf8")));
    return parsed.success ? parsed.data : null;
  } catch {
    return null;
  }
}

function listingId(kind: MarketplaceListing<unknown>["kind"], rawId: string): MarketplaceListingId {
  return `${kind}:${rawId}` as MarketplaceListingId;
}

function oneOf<T extends string>(values: readonly T[], value: string): value is T {
  return (values as readonly string[]).includes(value);
}

/** The route's query, checked: every parameter at most once, in range, and a cursor of this same listing. */
export function parseMarketplaceListingsQuery(query: Record<string, unknown>): ParseResult {
  const invalid = (error: string): ParseResult => ({ ok: false, code: "INVALID_REQUEST", error });
  for (const name of ["type", "category", "sort", "limit", "q", "cursor"]) {
    if (query[name] !== undefined && typeof query[name] !== "string") return invalid(`${name} must be given once`);
  }
  const { type = "all", category: rawCategory, sort = "installs", limit: rawLimit, q: rawQ, cursor: rawCursor } = query as Record<string, string | undefined>;
  if (!oneOf(MARKETPLACE_LISTING_TYPES, type)) return invalid(`type is one of ${MARKETPLACE_LISTING_TYPES.join(", ")}`);
  const category = rawCategory ?? null;
  if (category !== null && !oneOf(OAUTH_CLIENT_CATEGORIES, category)) return invalid(`category is one of ${OAUTH_CLIENT_CATEGORIES.join(", ")}`);
  if (!oneOf(MARKETPLACE_LISTING_SORTS, sort)) return invalid(`sort is one of ${MARKETPLACE_LISTING_SORTS.join(", ")}`);
  let limit = MARKETPLACE_LISTINGS_DEFAULT_LIMIT;
  if (rawLimit !== undefined) {
    limit = /^\d{1,3}$/u.test(rawLimit) ? Number(rawLimit) : 0;
    if (limit < 1 || limit > MARKETPLACE_LISTINGS_MAX_LIMIT) return invalid(`limit is a whole number from 1 to ${MARKETPLACE_LISTINGS_MAX_LIMIT}`);
  }
  const q = rawQ?.trim() || null;
  if (q !== null && Array.from(q).length > MARKETPLACE_LISTINGS_QUERY_MAX_CHARS) {
    return invalid(`q is longer than ${MARKETPLACE_LISTINGS_QUERY_MAX_CHARS} characters`);
  }
  let after: SortPosition | null = null;
  if (rawCursor !== undefined) {
    const cursor = decodeCursor(rawCursor);
    if (!cursor || cursor.type !== type || cursor.category !== category || cursor.sort !== sort || cursor.q !== q) {
      return {
        ok: false,
        code: "INVALID_CURSOR",
        error: "cursor only continues the listing it came from (same type, category, sort and q); drop it to start over",
      };
    }
    after = cursor.after;
  }
  return { ok: true, request: { type, category, sort, limit, q, after } };
}

// One collation for every request, so a cursor's position means the same on the next page.
const byName = new Intl.Collator("en", { sensitivity: "base" });

function newestFirst(a: number | null, b: number | null): number {
  if (a === b) return 0;
  if (a === null) return 1;
  if (b === null) return -1;
  return b - a;
}

const PRIMARY_ORDER: Record<MarketplaceListingSort, (a: SortPosition, b: SortPosition) => number> = {
  // Within a bucket, newest first (Tenny 5e9b25f3).
  installs: (a, b) => (b.installRank - a.installRank) || newestFirst(a.publishedAt, b.publishedAt),
  published: (a, b) => newestFirst(a.publishedAt, b.publishedAt),
  name: () => 0,
};

/** A total order: the sort's own key, then the name, then the unique listing id. */
function compareListings(sort: MarketplaceListingSort, a: SortPosition, b: SortPosition): number {
  return PRIMARY_ORDER[sort](a, b)
    || byName.compare(a.name, b.name)
    || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0);
}

function installRank(bucket: MarketplaceInstallBucket | null): number {
  return bucket === null ? 0 : MARKETPLACE_INSTALL_BUCKETS.indexOf(bucket) + 1;
}

function sortPosition(item: MarketplaceListing<unknown>): SortPosition {
  return {
    installRank: installRank(item.installBucket),
    publishedAt: item.publishedAt === null ? null : Date.parse(item.publishedAt),
    name: item.name,
    id: item.id,
  };
}

async function appListings(serverId: string): Promise<MarketplaceAppListing<MarketplaceAppRecord>[]> {
  const entries = await listMarketplaceOAuthClientEntries(serverId);
  return entries
    .filter(({ client }) => isMarketplaceTabClient(client, serverId))
    .map(({ client, publishedAt }) => ({
      id: listingId("app", client.id),
      kind: "app",
      name: client.name,
      description: client.description,
      logoUrl: client.logoUrl,
      category: client.category,
      // Exactly the card's badge: a bucket only while the App is publicly listed.
      installBucket: client.marketplaceInstallBadge.kind === "bucket" ? client.marketplaceInstallBadge.bucket : null,
      publishedAt: publishedAt.toISOString(),
      installed: client.installationId !== null,
      publisherName: client.publisherServerName ?? client.publisherName,
      app: client,
    }));
}

async function mcpListings(serverId: string): Promise<MarketplaceMcpListing[]> {
  const [templates, usageRows] = await Promise.all([
    listMcpAppTemplatesWithCreatedAt(),
    // An MCP App made from a template keeps its templateKey (backfilled for older rows in 0408).
    getDb()
      .select({
        templateKey: managedMcpServers.templateKey,
        installCount: sql<number>`count(distinct ${managedMcpServers.serverId})`.mapWith(Number),
        installedHere: sql<boolean>`bool_or(${managedMcpServers.serverId} = ${serverId})`,
      })
      .from(managedMcpServers)
      .where(isNotNull(managedMcpServers.templateKey))
      .groupBy(managedMcpServers.templateKey),
  ]);
  const usage = new Map(usageRows.map((row) => [row.templateKey, row]));
  return templates.map(({ template, createdAt }) => ({
    id: listingId("mcp", template.key),
    kind: "mcp",
    name: template.name,
    description: template.description,
    logoUrl: clientLogoUrl(template.logoUrl),
    category: template.category,
    installBucket: marketplaceInstallBucket(usage.get(template.key)?.installCount ?? 0),
    publishedAt: createdAt?.toISOString() ?? null,
    installed: usage.get(template.key)?.installedHere ?? false,
    templateKey: template.key,
    homepageUrl: template.homepageUrl,
  }));
}

function matches(item: MarketplaceListing<unknown>, needle: string): boolean {
  return item.name.toLowerCase().includes(needle) || (item.description?.toLowerCase().includes(needle) ?? false);
}

export async function listMarketplaceListings(input: {
  serverId: string;
  request: MarketplaceListingsRequest;
}): Promise<MarketplaceListingsResponse<MarketplaceAppRecord>> {
  const { type, category, sort, limit, q, after } = input.request;
  const [apps, templates] = await Promise.all([
    type === "mcp" ? [] : appListings(input.serverId),
    type === "app" ? [] : mcpListings(input.serverId),
  ]);
  const needle = q?.toLowerCase() ?? null;
  const ranked = [...apps, ...templates]
    .filter((item) => (category === null || item.category === category) && (needle === null || matches(item, needle)))
    .map((item) => ({ item, position: sortPosition(item) }))
    .sort((a, b) => compareListings(sort, a.position, b.position));
  const rest = after ? ranked.filter(({ position }) => compareListings(sort, position, after) > 0) : ranked;
  const page = rest.slice(0, limit);
  const last = page.at(-1);
  return {
    items: page.map(({ item }) => item),
    nextCursor: rest.length > page.length && last ? encodeCursor({ type, category, sort, q, after: last.position }) : null,
    total: ranked.length,
  };
}
