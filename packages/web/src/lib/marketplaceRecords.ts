// This Server's App records as the Marketplace lists them (GET
// /integrations/marketplace), read through one cache: Settings › Apps reloads
// them (`fresh`), and the install card's dialog reuses a recent answer instead
// of reading the whole list again each time it opens. Per Server (the API
// client sends the current one); one request at a time; a failure is never
// kept, so the next read asks again.

import api from "../api/client";
import type { MarketplaceOAuthClientRecord } from "../features/apps/connected-apps/oauthClientRecords";
import { useServerStore } from "../store/serverStore";

/** How long an answer stands in for a new read, unless the caller asks for a fresh one. */
export const MARKETPLACE_RECORDS_REUSE_MS = 60_000;

type Entry = { at: number; records: Promise<MarketplaceOAuthClientRecord[]> };
const byServer = new Map<string, Entry>();

/**
 * The records, from a read at most MARKETPLACE_RECORDS_REUSE_MS old (or one in
 * flight), or a new read with `fresh`. Rejects as the request does.
 */
export function readMarketplaceRecords({ fresh = false }: { fresh?: boolean } = {}): Promise<MarketplaceOAuthClientRecord[]> {
  const serverId = useServerStore.getState().current?.id ?? "";
  const kept = byServer.get(serverId);
  if (!fresh && kept && Date.now() - kept.at < MARKETPLACE_RECORDS_REUSE_MS) return kept.records;
  const entry: Entry = {
    at: Date.now(),
    records: api.get<MarketplaceOAuthClientRecord[]>("/integrations/marketplace").then(({ data }) => (Array.isArray(data) ? data : [])),
  };
  byServer.set(serverId, entry);
  entry.records.catch(() => {
    if (byServer.get(serverId) === entry) byServer.delete(serverId);
  });
  return entry.records;
}

/** The kept answers are out of date (the server refused an install against them): the next read asks again. */
export function forgetMarketplaceRecords(): void {
  byServer.clear();
}
