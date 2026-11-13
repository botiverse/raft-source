import { currentTimeMs } from "@botiverse/raft-shared";
import { create } from "zustand";
import { createJSONStorage, persist } from "zustand/middleware";
import type { StateStorage } from "zustand/middleware";
import {
  normalizeRecentConversationIds,
  pushRecentConversation,
} from "../features/search/recentConversations";

// Per server+user list of the conversations the user opened, most recent
// first. Feeds the desktop ⌘K overlay's empty state (task #113). Same shape and
// fail-open storage as searchEntityUsageStore: a local convenience that must
// never interfere with navigation.

const RECENT_CONVERSATION_STORE_KEY = "raft:recent-conversations-store:v1";
const RECENT_CONVERSATION_SCOPE_LIMIT = 32;

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
      // Storage denial or quota pressure must not interfere with navigation.
    }
  },
  removeItem: (name) => {
    try {
      localStorageOrNull()?.removeItem(name);
    } catch {
      // Fail-open, see setItem.
    }
  },
};

interface RecentConversationScope {
  channelIds: string[];
  lastTouchedAt: number;
}

interface RecentConversationState {
  scopes: Record<string, RecentConversationScope>;
  recordVisit: (scopeKey: string, channelId: string, visitedAt?: number) => void;
}

export function getRecentConversationScopeKey(
  serverId: string | null | undefined,
  userId: string | null | undefined,
): string | null {
  if (!serverId || !userId) return null;
  return `${serverId}:${userId}`;
}

function normalizeScopes(rawScopes: unknown): Record<string, RecentConversationScope> {
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
      return [scopeKey, { channelIds: normalizeRecentConversationIds(scope.channelIds), lastTouchedAt }] as const;
    })
    .filter(([, scope]) => scope.channelIds.length > 0)
    .sort((left, right) => right[1].lastTouchedAt - left[1].lastTouchedAt)
    .slice(0, RECENT_CONVERSATION_SCOPE_LIMIT));
}

export const EMPTY_RECENT_CONVERSATION_IDS: readonly string[] = Object.freeze([]);

export const useRecentConversationStore = create<RecentConversationState>()(persist(
  (set) => ({
    scopes: {},
    recordVisit: (scopeKey, channelId, visitedAt = currentTimeMs()) => set((state) => {
      const current = state.scopes[scopeKey]?.channelIds ?? [];
      // Re-visiting the conversation already at the head is the common case
      // (route re-render); skip the write so nothing downstream re-renders.
      if (current[0] === channelId) return state;
      return {
        scopes: normalizeScopes({
          ...state.scopes,
          [scopeKey]: { channelIds: pushRecentConversation(current, channelId), lastTouchedAt: visitedAt },
        }),
      };
    }),
  }),
  {
    name: RECENT_CONVERSATION_STORE_KEY,
    storage: createJSONStorage(() => dynamicLocalStorage),
    partialize: (state) => ({ scopes: state.scopes }),
    merge: (persistedState, currentState) => ({
      ...currentState,
      scopes: normalizeScopes((persistedState as Partial<RecentConversationState> | undefined)?.scopes),
    }),
  },
));
