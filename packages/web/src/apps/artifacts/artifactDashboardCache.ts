import type { ArtifactWebDashboardAll } from "@botiverse/raft-shared";

/** The home's unfiltered first page as its last read answered it. */
export interface CachedDashboardPage {
  page: ArtifactWebDashboardAll;
  /** Its rows' time is when they were opened (the `opened` sort). */
  byOpened: boolean;
}

/**
 * Only the list the home opens with (no filter, search or toggle: a page always mounts without them), one per
 * server and sort, so a few servers fit and a search never pushes them out.
 */
const MOST_PAGES = 8;
const pages = new Map<string, CachedDashboardPage>();
/** Whose pages these are: another reader in this tab (sign-out, then in as someone else) starts with none. */
let pagesReader: string | null = null;

const keyOf = (serverId: string, sort: string) => `${serverId}|${sort}`;

function forOwner(readerId: string | null): void {
  if (readerId === pagesReader) return;
  pages.clear();
  pagesReader = readerId;
}

/**
 * The page `readerId` last read for `serverId`'s home in `sort`, so coming back shows it at once while it is read
 * again; kept for this tab only, in memory, never past a reload.
 */
export function cachedDashboardPage(readerId: string | null, serverId: string, sort: string): CachedDashboardPage | null {
  forOwner(readerId);
  const key = keyOf(serverId, sort);
  const hit = pages.get(key);
  if (!hit) return null;
  pages.delete(key);
  pages.set(key, hit);
  return hit;
}

/** Keeps `entry` as that home's page, dropping the least recently used past MOST_PAGES. */
export function cacheDashboardPage(readerId: string | null, serverId: string, sort: string, entry: CachedDashboardPage): void {
  forOwner(readerId);
  const key = keyOf(serverId, sort);
  pages.delete(key);
  pages.set(key, entry);
  while (pages.size > MOST_PAGES) {
    const oldest = pages.keys().next().value;
    if (oldest === undefined) break;
    pages.delete(oldest);
  }
}

/** Forgets a server's home pages: Artifacts are off there, or its list can't be read. */
export function forgetDashboardPages(serverId: string): void {
  for (const key of [...pages.keys()]) if (key.startsWith(`${serverId}|`)) pages.delete(key);
}

/** Forgets every page: another data source answers differently (artifactSource). */
export function clearDashboardPages(): void {
  pages.clear();
  pagesReader = null;
}
