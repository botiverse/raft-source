import api from "../../src/api/client";
import { useServerStore } from "../../src/store/serverStore";

export const MARKETPLACE_LISTINGS_PATH = "/integrations/marketplace/listings";

type Get = typeof api.get;
type MarketplaceRow = {
  id: string;
  serverId?: string;
  name: string;
  description?: string | null;
  logoUrl?: string | null;
  category: string;
  createdAt?: string;
  installedAt?: string | null;
  privateShared?: boolean;
  humanMarketplaceVisible?: boolean;
  publishStatus?: string;
  publisherName?: string | null;
  publisherServerName?: string | null;
  marketplaceInstallBadge?: { kind: string; bucket?: string };
};

/** What the server lists on the Marketplace: no private shares, and this server's own App only once it is public. */
function onMarketplace(row: MarketplaceRow, serverId: string | undefined): boolean {
  if (row.privateShared) return false;
  return row.serverId !== serverId
    || (row.humanMarketplaceVisible === true && (row.publishStatus === "published" || row.publishStatus === "unpublish_requested"));
}

/**
 * Tests written against GET /integrations/marketplace (the App records) keep
 * working now that the Apps page's Marketplace tab reads pages of GET
 * /integrations/marketplace/listings: whatever `api.get` a test installs, a
 * listings request is answered as one page made from that test's
 * /integrations/marketplace answer, each App as the `app` listing the server
 * would send. Tests about the listings themselves (paging, filters, MCP rows)
 * answer the listings path directly; their answer wins.
 *
 * Call once at a test file's top level. Returns a function that puts a plain
 * `api.get` back.
 */
export function serveMarketplaceListingsFromAppRecords(): () => void {
  const base: Get = api.get;
  let current: Get = base;
  // Each `api.get` a test installs is wrapped once. A test that keeps the
  // wrapper it read (`const routed = api.get`) and calls it from its own
  // replacement gets the function it read, not this property again.
  const inner = new WeakMap<Get, Get>();
  const wrappers = new WeakMap<Get, Get>();
  const wrap = (fn: Get): Get => {
    const known = wrappers.get(fn);
    if (known) return known;
    const call = fn as (u: string, c?: unknown) => Promise<unknown>;
    const wrapped = (async (url: string, config?: unknown) => {
      if (url !== MARKETPLACE_LISTINGS_PATH) return call(url, config);
      try {
        const answer = await call(url, config) as { data?: { items?: unknown } } | undefined;
        if (Array.isArray(answer?.data?.items)) return answer;
      } catch {
        // The test answers only the App records: build the page from them.
      }
      const { data } = await call("/integrations/marketplace") as { data: MarketplaceRow[] };
      return { data: listingsPage(Array.isArray(data) ? data : []) };
    }) as Get;
    wrappers.set(fn, wrapped);
    inner.set(wrapped, fn);
    return wrapped;
  };
  Object.defineProperty(api, "get", {
    configurable: true,
    get: () => wrap(current),
    set: (next: Get) => { current = inner.get(next) ?? next; },
  });
  return () => {
    Object.defineProperty(api, "get", { configurable: true, writable: true, value: base });
  };
}

function listingsPage(rows: MarketplaceRow[]) {
  const serverId = useServerStore.getState().current?.id;
  const items = rows
    .filter((row) => onMarketplace(row, serverId))
    .map((row) => ({
      id: `app:${row.id}`,
      kind: "app",
      name: row.name,
      description: row.description ?? null,
      logoUrl: row.logoUrl ?? null,
      category: row.category,
      installBucket: row.marketplaceInstallBadge?.kind === "bucket" ? row.marketplaceInstallBadge.bucket ?? null : null,
      publishedAt: row.createdAt ?? null,
      installed: Boolean(row.installedAt),
      publisherName: row.publisherServerName ?? row.publisherName ?? null,
      app: row,
    }));
  return { items, nextCursor: null, total: items.length };
}
