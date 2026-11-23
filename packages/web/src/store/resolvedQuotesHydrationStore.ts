import { create } from "zustand";
import { hasSameConversationQuoteRef } from "@botiverse/raft-shared";
import type { ResolvedInlineQuotesMap } from "@botiverse/raft-shared";
import api from "../api/client";
import { useServerStore } from "./serverStore";
import { QUOTE_REPLY_FEATURE_FLAG_KEY, readServerFeatureFlag } from "./serverFeatureFlags";
import { registerServerReset } from "./serverResetRegistry";

const MAX_HYDRATED_ENTRIES = 250;

interface ResolvedQuotesHydrationState {
  byKey: Record<string, ResolvedInlineQuotesMap>;
  setEntry: (key: string, map: ResolvedInlineQuotesMap) => void;
  clearKey: (key: string) => void;
  clearAll: () => void;
}

const inFlightKeys = new Set<string>();

function hydrationKey(serverId: string | null | undefined, messageId: string): string {
  return `${serverId ?? ""}:${messageId}`;
}

export const useResolvedQuotesHydrationStore = create<ResolvedQuotesHydrationState>((set) => ({
  byKey: {},
  setEntry: (key, map) =>
    set((state) => {
      const keys = Object.keys(state.byKey);
      const next: Record<string, ResolvedInlineQuotesMap> =
        keys.length >= MAX_HYDRATED_ENTRIES && !(key in state.byKey)
          ? Object.fromEntries(keys.slice(keys.length - MAX_HYDRATED_ENTRIES + 1).map((k) => [k, state.byKey[k]!]))
          : { ...state.byKey };
      next[key] = map;
      return { byKey: next };
    }),
  clearKey: (key) =>
    set((state) => {
      if (!(key in state.byKey)) return state;
      const next = { ...state.byKey };
      delete next[key];
      return { byKey: next };
    }),
  clearAll: () => {
    inFlightKeys.clear();
    set({ byKey: {} });
  },
}));

export function useHydratedResolvedQuotes(messageId: string): ResolvedInlineQuotesMap | undefined {
  const serverId = useServerStore((s) => s.current?.id ?? null);
  const key = hydrationKey(serverId, messageId);
  return useResolvedQuotesHydrationStore((s) => s.byKey[key]);
}

/**
 * Hydrate per-viewer `resolvedQuotes` for a message received over real-time
 * Socket.IO (`message:new`, `thread:updated`, or `message:updated`).
 *
 * Room-wide WebSocket broadcasts intentionally NEVER carry `resolvedQuotes`
 * because history windows and visibility differ per viewer (Joint channels,
 * Free vs Pro, guests). Instead, when a live message contains `> msg=<id>` and
 * `quote_reply_v0` is enabled for the active server, this helper fetches
 * `GET /api/messages/:messageId/resolved-quotes` under the viewer's own session
 * and stores the verified map without mutating room broadcasts.
 */
export function hydrateLiveMessageResolvedQuotes(
  message: {
    id: string;
    content?: string | null;
    resolvedQuotes?: ResolvedInlineQuotesMap;
  },
  options?: { force?: boolean },
): void {
  if (!message.id || message.id.startsWith("optimistic-")) return;
  const content = message.content ?? "";
  const { current, serverEpoch } = useServerStore.getState();
  const serverId = current?.id ?? null;
  if (!serverId) return;

  const key = hydrationKey(serverId, message.id);

  if (!hasSameConversationQuoteRef(content)) {
    if (options?.force) {
      useResolvedQuotesHydrationStore.getState().clearKey(key);
    }
    return;
  }

  if (!readServerFeatureFlag(serverId, QUOTE_REPLY_FEATURE_FLAG_KEY)) return;
  if (!options?.force && message.resolvedQuotes && Object.keys(message.resolvedQuotes).length > 0) return;
  if (!options?.force && key in useResolvedQuotesHydrationStore.getState().byKey) return;
  if (inFlightKeys.has(key)) return;

  inFlightKeys.add(key);
  void api
    .get<{ resolvedQuotes?: ResolvedInlineQuotesMap }>(
      `/messages/${encodeURIComponent(message.id)}/resolved-quotes`,
    )
    .then(({ data }) => {
      if (useServerStore.getState().serverEpoch !== serverEpoch) return;
      if (useServerStore.getState().current?.id !== serverId) return;
      const map = data?.resolvedQuotes ?? {};
      useResolvedQuotesHydrationStore.getState().setEntry(key, map);
    })
    .catch(() => {
      // Degrade silently to plain blockquote on network/404/visibility failure.
    })
    .finally(() => {
      inFlightKeys.delete(key);
    });
}

export function clearResolvedQuotesHydration(): void {
  useResolvedQuotesHydrationStore.getState().clearAll();
}

registerServerReset(() => {
  clearResolvedQuotesHydration();
});
