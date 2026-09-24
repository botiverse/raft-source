import { currentTimeMs } from "@botiverse/raft-shared";
import { create } from "zustand";
import { createJSONStorage, persist } from "zustand/middleware";
import type { StateStorage } from "zustand/middleware";
import {
  normalizeSearchEntityUsage,
  recordSearchEntityOpen,
} from "../components/search/searchHome";
import type { SearchEntityUsage } from "../components/search/searchHome";

const SEARCH_ENTITY_USAGE_STORE_KEY = "raft:search-entity-usage-store:v1";
const SEARCH_ENTITY_USAGE_SCOPE_LIMIT = 32;

function localStorageOrNull(): Storage | null {
  try {
    return typeof globalThis.localStorage === "undefined" ? null : globalThis.localStorage;
  } catch {
    return null;
  }
}

const dynamicLocalStorage: StateStorage = {
  getItem: (name) => {
    try {
      return localStorageOrNull()?.getItem(name) ?? null;
    } catch {
      return null;
    }
  },
  setItem: (name, value) => {
    try {
      localStorageOrNull()?.setItem(name, value);
    } catch {
      // Personal Search usage is a convenience surface. Storage denial or
      // quota pressure must not interfere with navigation.
    }
  },
  removeItem: (name) => {
    try {
      localStorageOrNull()?.removeItem(name);
    } catch {
      // Clearing optional local usage should stay fail-open too.
    }
  },
};

interface SearchEntityUsageScope {
  usage: SearchEntityUsage;
  lastTouchedAt: number;
}

interface SearchEntityUsageState {
  scopes: Record<string, SearchEntityUsageScope>;
  recordOpen: (scopeKey: string, entityKey: string, openedAt?: number) => void;
  replaceScope: (scopeKey: string, usage: SearchEntityUsage, touchedAt?: number) => void;
}

export function getSearchEntityUsageScopeKey(
  serverId: string | null | undefined,
  userId: string | null | undefined,
): string | null {
  if (!serverId || !userId) return null;
  return `${serverId}:${userId}`;
}

function normalizeScopes(rawScopes: unknown, now: number): Record<string, SearchEntityUsageScope> {
  if (!rawScopes || typeof rawScopes !== "object" || Array.isArray(rawScopes)) return {};
  return Object.fromEntries(Object.entries(rawScopes as Record<string, unknown>)
    .filter(([scopeKey, rawScope]) => (
      scopeKey.length > 0
      && scopeKey.length <= 401
      && rawScope !== null
      && typeof rawScope === "object"
      && !Array.isArray(rawScope)
    ))
    .map(([scopeKey, rawScope]) => {
      const scope = rawScope as Record<string, unknown>;
      const lastTouchedAt = typeof scope.lastTouchedAt === "number" && Number.isFinite(scope.lastTouchedAt)
        ? scope.lastTouchedAt
        : 0;
      return [scopeKey, {
        usage: normalizeSearchEntityUsage(scope.usage, now),
        lastTouchedAt,
      }] as const;
    })
    .filter(([, scope]) => Object.keys(scope.usage).length > 0)
    .sort((left, right) => right[1].lastTouchedAt - left[1].lastTouchedAt)
    .slice(0, SEARCH_ENTITY_USAGE_SCOPE_LIMIT));
}

function updateScope(
  scopes: Record<string, SearchEntityUsageScope>,
  scopeKey: string,
  usage: SearchEntityUsage,
  touchedAt: number,
): Record<string, SearchEntityUsageScope> {
  return normalizeScopes({
    ...scopes,
    [scopeKey]: { usage, lastTouchedAt: touchedAt },
  }, touchedAt);
}

export const useSearchEntityUsageStore = create<SearchEntityUsageState>()(persist(
  (set) => ({
    scopes: {},
    recordOpen: (scopeKey, entityKey, openedAt = currentTimeMs()) => set((state) => ({
      scopes: updateScope(
        state.scopes,
        scopeKey,
        recordSearchEntityOpen(state.scopes[scopeKey]?.usage ?? {}, entityKey, openedAt),
        openedAt,
      ),
    })),
    replaceScope: (scopeKey, usage, touchedAt = currentTimeMs()) => set((state) => ({
      scopes: updateScope(state.scopes, scopeKey, usage, touchedAt),
    })),
  }),
  {
    name: SEARCH_ENTITY_USAGE_STORE_KEY,
    storage: createJSONStorage(() => dynamicLocalStorage),
    partialize: (state) => ({ scopes: state.scopes }),
    merge: (persistedState, currentState) => ({
      ...currentState,
      scopes: normalizeScopes(
        (persistedState as Partial<SearchEntityUsageState> | undefined)?.scopes,
        currentTimeMs(),
      ),
    }),
  },
));
