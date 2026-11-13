import { useCallback, useEffect, useState } from "react";
import { useMediaQuery } from "../../hooks/effectPrimitives";
import { useAuthStore } from "../../store/authStore";
import type { Channel } from "../../store/channelStore";
import {
  getSearchEntityUsageScopeKey,
  useSearchEntityUsageStore,
} from "../../store/searchEntityUsageStore";
import { useServerStore } from "../../store/serverStore";
import { getCommittedSearchQuery } from "./searchComposition";
import { EMPTY_SEARCH_ENTITY_USAGE, SEARCH_HOME_TOUCH_QUERY } from "./searchConstants";
import {
  addSearchHistoryEntry,
  getSearchEntityUsageStorageKey,
  getSearchHistoryStorageKey,
  persistSearchHistory,
  readSearchEntityUsage,
  readSearchHistory,
  removeSearchHistoryEntry,
  resolveSearchHistoryEditing,
} from "./searchHome";

/**
 * The search home's memory: the recent search queries (local, per
 * user+server) with their phone edit mode, and the destinations opened from
 * search (the frequent list's usage counts).
 */
export function useSearchHistory({
  query,
  isComposing,
  dmChannels,
}: {
  query: string;
  isComposing: boolean;
  dmChannels: Channel[];
}) {
  const serverId = useServerStore((s) => s.current?.id);
  const currentUserId = useAuthStore((s) => s.user?.id);
  const searchHistoryStorageKey = getSearchHistoryStorageKey(serverId, currentUserId);
  const searchEntityUsageStorageKey = getSearchEntityUsageStorageKey(serverId, currentUserId);
  const searchEntityUsageScopeKey = getSearchEntityUsageScopeKey(serverId, currentUserId);
  const [searchHistory, setSearchHistory] = useState<string[]>(() => (
    readSearchHistory(
      typeof window === "undefined" ? null : window.localStorage,
      searchHistoryStorageKey,
    )
  ));
  const searchEntityUsage = useSearchEntityUsageStore((state) => (
    searchEntityUsageScopeKey
      ? state.scopes[searchEntityUsageScopeKey]?.usage ?? EMPTY_SEARCH_ENTITY_USAGE
      : EMPTY_SEARCH_ENTITY_USAGE
  ));
  const recordSearchEntityOpenInStore = useSearchEntityUsageStore((state) => state.recordOpen);
  const replaceSearchEntityUsageScope = useSearchEntityUsageStore((state) => state.replaceScope);

  // Search history is intentionally local and scoped to the current
  // user+server. It is a convenience surface, not server data or a
  // cross-device activity claim.
  useEffect(() => {
    setSearchHistory(readSearchHistory(
      typeof window === "undefined" ? null : window.localStorage,
      searchHistoryStorageKey,
    ));
  }, [searchHistoryStorageKey]);

  useEffect(() => {
    if (!searchEntityUsageScopeKey || Object.keys(searchEntityUsage).length > 0) return;
    const legacyUsage = readSearchEntityUsage(
      typeof window === "undefined" ? null : window.localStorage,
      searchEntityUsageStorageKey,
    );
    if (Object.keys(legacyUsage).length > 0) {
      replaceSearchEntityUsageScope(searchEntityUsageScopeKey, legacyUsage);
    }
  }, [replaceSearchEntityUsageScope, searchEntityUsage, searchEntityUsageScopeKey, searchEntityUsageStorageKey]);

  const rememberSearchQuery = useCallback((rawQuery: string) => {
    if (!searchHistoryStorageKey) return;
    setSearchHistory((current) => {
      const next = addSearchHistoryEntry(current, rawQuery);
      persistSearchHistory(
        typeof window === "undefined" ? null : window.localStorage,
        searchHistoryStorageKey,
        next,
      );
      return next;
    });
  }, [searchHistoryStorageKey]);

  const rememberCurrentSearchQuery = useCallback(() => {
    const committedQuery = getCommittedSearchQuery(query, isComposing);
    if (committedQuery) rememberSearchQuery(committedQuery);
  }, [isComposing, query, rememberSearchQuery]);

  // Touch surfaces have no hover, so the per-tag remove button cannot be
  // hover-revealed there. Mobile hides it behind an explicit edit mode
  // instead; desktop keeps the hover affordance untouched.
  const isTouchSearchHome = useMediaQuery(SEARCH_HOME_TOUCH_QUERY);
  const [searchHistoryEditRequested, setSearchHistoryEditRequested] = useState(false);
  const toggleSearchHistoryEdit = useCallback(() => setSearchHistoryEditRequested((editing) => !editing), []);
  // Edit mode only exists where it is reachable: a desktop viewport keeps the
  // hover affordance and never enters it, and an empty list has nothing to
  // edit. Both are derived here rather than synchronized by an Effect.
  const searchHistoryEditing = resolveSearchHistoryEditing({
    isTouchViewport: isTouchSearchHome,
    editRequested: searchHistoryEditRequested,
    historyCount: searchHistory.length,
  });

  const forgetSearchQuery = useCallback((rawQuery: string) => {
    setSearchHistory((current) => {
      const next = removeSearchHistoryEntry(current, rawQuery);
      persistSearchHistory(
        typeof window === "undefined" ? null : window.localStorage,
        searchHistoryStorageKey,
        next,
      );
      // Removing the last entry ends the edit session outright. Without this
      // the request would still be latched, and a later search re-entering
      // history would come back with every delete button already armed.
      if (next.length === 0) setSearchHistoryEditRequested(false);
      return next;
    });
  }, [searchHistoryStorageKey]);

  const clearSearchHistory = useCallback(() => {
    setSearchHistory([]);
    setSearchHistoryEditRequested(false);
    persistSearchHistory(
      typeof window === "undefined" ? null : window.localStorage,
      searchHistoryStorageKey,
      [],
    );
  }, [searchHistoryStorageKey]);

  const rememberSearchEntityOpen = useCallback((entityKey: string) => {
    if (!searchEntityUsageScopeKey) return;
    recordSearchEntityOpenInStore(searchEntityUsageScopeKey, entityKey);
  }, [recordSearchEntityOpenInStore, searchEntityUsageScopeKey]);

  const rememberOpenedChannel = useCallback((channelId: string, kind: "channel" | "dm") => {
    if (kind === "channel") {
      rememberSearchEntityOpen(`channel:${channelId}`);
      return;
    }
    const dm = dmChannels.find((channel) => channel.id === channelId);
    if (dm?.peerType === "agent" && dm.peerId) {
      rememberSearchEntityOpen(`agent:${dm.peerId}`);
    } else if (dm?.peerType === "user" && dm.peerId) {
      rememberSearchEntityOpen(`human:${dm.peerId}`);
    }
  }, [dmChannels, rememberSearchEntityOpen]);

  return {
    searchHistory,
    searchEntityUsage,
    rememberSearchQuery,
    rememberCurrentSearchQuery,
    isTouchSearchHome,
    searchHistoryEditing,
    toggleSearchHistoryEdit,
    forgetSearchQuery,
    clearSearchHistory,
    rememberSearchEntityOpen,
    rememberOpenedChannel,
  };
}
