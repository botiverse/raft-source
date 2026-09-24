import { currentTimeMs } from "@botiverse/raft-shared";
import type { SearchEntityResult } from "./searchEntities";

export const SEARCH_HISTORY_LIMIT = 15;
export const FREQUENT_SEARCH_ENTITY_LIMIT = 10;
export const SEARCH_ENTITY_USAGE_EVENT_LIMIT = 24;
export const SEARCH_ENTITY_USAGE_KEY_LIMIT = 64;
export const SEARCH_ENTITY_USAGE_WINDOW_MS = 90 * 24 * 60 * 60 * 1_000;
export const SEARCH_ENTITY_USAGE_HALF_LIFE_MS = 7 * 24 * 60 * 60 * 1_000;
const SEARCH_STATE_PARAM_KEYS = ["q", "senderId", "channelId", "range", "scope", "sort"] as const;

type SearchHistoryStorage = Pick<Storage, "getItem" | "setItem">;

export type SearchEntityUsage = Record<string, number[]>;

export interface SearchStateSnapshot {
  q?: string;
  senderId?: string;
  channelId?: string;
  range?: string;
  scopes?: string[];
  sort?: string;
}

export function getSearchHistoryStorageKey(
  serverId: string | null | undefined,
  userId: string | null | undefined,
): string | null {
  if (!serverId || !userId) return null;
  return `raft:search-history:${serverId}:${userId}`;
}

export function getSearchStateStorageKey(
  serverId: string | null | undefined,
  userId: string | null | undefined,
): string | null {
  if (!serverId || !userId) return null;
  return `raft:search-state:${serverId}:${userId}`;
}

export function getSearchEntityUsageStorageKey(
  serverId: string | null | undefined,
  userId: string | null | undefined,
): string | null {
  if (!serverId || !userId) return null;
  return `raft:search-entity-usage:${serverId}:${userId}`;
}

function normalizeOptionalSnapshotValue(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  const normalized = value.trim();
  return normalized || undefined;
}

export function readSearchState(
  storage: SearchHistoryStorage | null,
  storageKey: string | null,
): SearchStateSnapshot | null {
  if (!storage || !storageKey) return null;
  try {
    const parsed = JSON.parse(storage.getItem(storageKey) ?? "null");
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return null;
    const record = parsed as Record<string, unknown>;
    const scopes = Array.isArray(record.scopes)
      ? record.scopes
          .filter((value): value is string => typeof value === "string")
          .map((value) => value.trim())
          .filter(Boolean)
      : [];
    return {
      q: normalizeOptionalSnapshotValue(record.q),
      senderId: normalizeOptionalSnapshotValue(record.senderId),
      channelId: normalizeOptionalSnapshotValue(record.channelId),
      range: normalizeOptionalSnapshotValue(record.range),
      scopes: [...new Set(scopes)],
      sort: normalizeOptionalSnapshotValue(record.sort),
    };
  } catch {
    return null;
  }
}

export function searchParamsHaveExplicitState(params: URLSearchParams): boolean {
  return SEARCH_STATE_PARAM_KEYS.some((key) => params.has(key));
}

export function captureSearchState(params: URLSearchParams): SearchStateSnapshot {
  const value = (key: string) => normalizeOptionalSnapshotValue(params.get(key));
  return {
    q: value("q"),
    senderId: value("senderId"),
    channelId: value("channelId"),
    range: value("range"),
    scopes: [...new Set(params.getAll("scope").map((scope) => scope.trim()).filter(Boolean))],
    sort: value("sort"),
  };
}

export function applySearchState(
  params: URLSearchParams,
  snapshot: SearchStateSnapshot,
): URLSearchParams {
  const next = new URLSearchParams(params);
  for (const key of SEARCH_STATE_PARAM_KEYS) next.delete(key);
  if (snapshot.q) next.set("q", snapshot.q);
  if (snapshot.senderId) next.set("senderId", snapshot.senderId);
  if (snapshot.channelId) next.set("channelId", snapshot.channelId);
  if (snapshot.range) next.set("range", snapshot.range);
  for (const scope of snapshot.scopes ?? []) next.append("scope", scope);
  if (snapshot.sort) next.set("sort", snapshot.sort);
  return next;
}

export function persistSearchState(
  storage: SearchHistoryStorage | null,
  storageKey: string | null,
  snapshot: SearchStateSnapshot,
): void {
  if (!storage || !storageKey) return;
  try {
    storage.setItem(storageKey, JSON.stringify(snapshot));
  } catch {
    // The search URL remains the live source of truth when local persistence
    // is unavailable.
  }
}

export function readSearchHistory(
  storage: SearchHistoryStorage | null,
  storageKey: string | null,
): string[] {
  if (!storage || !storageKey) return [];
  try {
    const parsed = JSON.parse(storage.getItem(storageKey) ?? "[]");
    if (!Array.isArray(parsed)) return [];
    const seen = new Set<string>();
    const history: string[] = [];
    for (const value of parsed) {
      if (typeof value !== "string") continue;
      const query = value.trim().slice(0, 200);
      const normalized = query.toLocaleLowerCase();
      if (!query || seen.has(normalized)) continue;
      seen.add(normalized);
      history.push(query);
      if (history.length >= SEARCH_HISTORY_LIMIT) break;
    }
    return history;
  } catch {
    return [];
  }
}

export function addSearchHistoryEntry(history: readonly string[], rawQuery: string): string[] {
  const query = rawQuery.trim().slice(0, 200);
  if (!query) return [...history];
  const normalized = query.toLocaleLowerCase();
  return [
    query,
    ...history.filter((entry) => entry.trim().toLocaleLowerCase() !== normalized),
  ].slice(0, SEARCH_HISTORY_LIMIT);
}

export function removeSearchHistoryEntry(history: readonly string[], rawQuery: string): string[] {
  const normalized = rawQuery.trim().toLocaleLowerCase();
  return history.filter((entry) => entry.trim().toLocaleLowerCase() !== normalized);
}

export function persistSearchHistory(
  storage: SearchHistoryStorage | null,
  storageKey: string | null,
  history: readonly string[],
): void {
  if (!storage || !storageKey) return;
  try {
    storage.setItem(storageKey, JSON.stringify(history.slice(0, SEARCH_HISTORY_LIMIT)));
  } catch {
    // Search history is an optional local convenience. Storage denial or
    // quota pressure must never interfere with the search surface itself.
  }
}

function isUsageEntityKey(key: string): boolean {
  return /^(channel|agent|human):[^:]{1,200}$/.test(key);
}

function normalizeUsageTimestamps(value: unknown, now: number): number[] {
  if (!Array.isArray(value)) return [];
  const minimum = now - SEARCH_ENTITY_USAGE_WINDOW_MS;
  const maximum = now + 5 * 60 * 1_000;
  return [...new Set(value
    .filter((timestamp): timestamp is number => (
      typeof timestamp === "number"
      && Number.isFinite(timestamp)
      && timestamp >= minimum
      && timestamp <= maximum
    )))]
    .sort((left, right) => right - left)
    .slice(0, SEARCH_ENTITY_USAGE_EVENT_LIMIT);
}

export function normalizeSearchEntityUsage(rawUsage: unknown, now: number): SearchEntityUsage {
  if (!rawUsage || typeof rawUsage !== "object" || Array.isArray(rawUsage)) return {};
  const entries = Object.entries(rawUsage as Record<string, unknown>)
    .filter(([key]) => isUsageEntityKey(key))
    .map(([key, value]) => [key, normalizeUsageTimestamps(value, now)] as const)
    .filter(([, timestamps]) => timestamps.length > 0)
    .sort((left, right) => (
      (right[1][0] ?? 0) - (left[1][0] ?? 0)
      || left[0].localeCompare(right[0])
    ))
    .slice(0, SEARCH_ENTITY_USAGE_KEY_LIMIT);
  return Object.fromEntries(entries);
}

export function readSearchEntityUsage(
  storage: SearchHistoryStorage | null,
  storageKey: string | null,
  now = currentTimeMs(),
): SearchEntityUsage {
  if (!storage || !storageKey) return {};
  try {
    const parsed = JSON.parse(storage.getItem(storageKey) ?? "null");
    return normalizeSearchEntityUsage(parsed, now);
  } catch {
    return {};
  }
}

export function recordSearchEntityOpen(
  usage: SearchEntityUsage,
  entityKey: string,
  openedAt = currentTimeMs(),
): SearchEntityUsage {
  if (!isUsageEntityKey(entityKey) || !Number.isFinite(openedAt)) return usage;
  return normalizeSearchEntityUsage({
    ...usage,
    [entityKey]: [openedAt, ...(usage[entityKey] ?? [])],
  }, openedAt);
}

export function persistSearchEntityUsage(
  storage: SearchHistoryStorage | null,
  storageKey: string | null,
  usage: SearchEntityUsage,
): void {
  if (!storage || !storageKey) return;
  try {
    storage.setItem(storageKey, JSON.stringify(usage));
  } catch {
    // Personal usage is an optional local convenience. Search navigation must
    // continue when storage is denied or full.
  }
}

function usageRank(timestamps: readonly number[], now: number): { score: number; lastOpenedAt: number } {
  const minimum = now - SEARCH_ENTITY_USAGE_WINDOW_MS;
  let score = 0;
  let lastOpenedAt = 0;
  for (const timestamp of timestamps) {
    if (!Number.isFinite(timestamp) || timestamp < minimum || timestamp > now + 5 * 60 * 1_000) continue;
    score += 2 ** (-(Math.max(0, now - timestamp) / SEARCH_ENTITY_USAGE_HALF_LIFE_MS));
    lastOpenedAt = Math.max(lastOpenedAt, timestamp);
  }
  return { score, lastOpenedAt };
}

export function selectFrequentSearchEntities({
  entities,
  usage,
  eligibleEntityKeys,
  currentUserId,
  limit = FREQUENT_SEARCH_ENTITY_LIMIT,
  now = currentTimeMs(),
}: {
  entities: readonly SearchEntityResult[];
  usage: SearchEntityUsage;
  eligibleEntityKeys?: ReadonlySet<string>;
  currentUserId?: string | null;
  limit?: number;
  now?: number;
}): SearchEntityResult[] {
  if (limit <= 0) return [];
  const eligible = entities.filter((entity) => (
    entity.type !== "computer" && !entity.archivedAt
    && !(entity.type === "humanDm" && entity.userId === currentUserId)
    && (!eligibleEntityKeys || eligibleEntityKeys.has(entity.key))
  ));
  const frequent = eligible
    .map((entity) => ({ entity, rank: usageRank(usage[entity.key] ?? [], now) }))
    .filter((entry) => entry.rank.score > 0)
    .sort((left, right) => (
      right.rank.score - left.rank.score
      || right.rank.lastOpenedAt - left.rank.lastOpenedAt
      || left.entity.title.localeCompare(right.entity.title, undefined, { sensitivity: "base" })
      || left.entity.key.localeCompare(right.entity.key)
    ));

  return frequent.slice(0, limit).map(({ entity }) => entity);
}

/**
 * Search-history edit mode exists only where the per-tag remove button cannot
 * be revealed by hover: a touch viewport. It is also meaningless with an empty
 * list, and must not stay latched across a list that emptied and refilled —
 * otherwise history returning after a later search would come back with every
 * delete button already armed.
 */
export function resolveSearchHistoryEditing({
  isTouchViewport,
  editRequested,
  historyCount,
}: {
  isTouchViewport: boolean;
  editRequested: boolean;
  historyCount: number;
}): boolean {
  return isTouchViewport && editRequested && historyCount > 0;
}

/**
 * Desktop keeps the hover-revealed remove control on every tag. Touch renders
 * no remove control at all until edit mode is entered — absent, not merely
 * transparent, so it is neither tappable nor focusable at rest.
 */
export function shouldRenderSearchHistoryRemove({
  isTouchViewport,
  editing,
}: {
  isTouchViewport: boolean;
  editing: boolean;
}): boolean {
  return !isTouchViewport || editing;
}
