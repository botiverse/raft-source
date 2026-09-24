import { create } from "zustand";
import api from "../api/client";
import { registerServerReset } from "./serverResetRegistry";
import type { ActivitySortDirection } from "./inboxStore";

const PAGE_SIZE = 20;
let activeSavedListRequestId = 0;

export interface SavedEntry {
  messageId: string;
  channelId: string;
  channelName: string;
  channelType: string;
  content: string;
  senderType: string;
  senderId: string;
  senderName: string | null;
  senderAvatarUrl: string | null;
  createdAt: string;
  savedAt: string;
  parentChannelId: string | null;
  parentChannelName: string | null;
  parentChannelType: string | null;
  parentMessageId: string | null;
  parentMessagePreview?: string | null;
  parentMessageSenderType?: string | null;
  parentMessageSenderId?: string | null;
  replyCount?: number;
}

interface SavedState {
  saved: SavedEntry[];
  /** Set of saved message IDs for quick lookup */
  savedIds: Set<string>;
  loading: boolean;
  hasMore: boolean;
  /** True total saved count on the server — drives the sidebar/panel badge,
   *  independent of how many pages are currently loaded into `saved`. */
  total: number;
  resultTotal: number;
  query: string;
  channelId: string | null;
  sortDirection: ActivitySortDirection;
  loadSaved: (filters?: { query?: string; sortDirection?: ActivitySortDirection; channelId?: string | null }) => Promise<void>;
  loadMore: () => Promise<void>;
  saveMessage: (messageId: string) => Promise<void>;
  unsaveMessage: (messageId: string) => Promise<void>;
  isSaved: (messageId: string) => boolean;
  /** Check saved status for a batch of message IDs (used when loading messages) */
  checkSaved: (messageIds: string[]) => Promise<void>;
}

export const useSavedStore = create<SavedState>((set, get) => ({
  saved: [],
  savedIds: new Set(),
  loading: false,
  hasMore: false,
  total: 0,
  resultTotal: 0,
  query: "",
  channelId: null,
  sortDirection: "desc",

  loadSaved: async (filters) => {
    const requestId = ++activeSavedListRequestId;
    const query = filters?.query?.trim() ?? get().query;
    const sortDirection = filters?.sortDirection ?? get().sortDirection;
    const channelId = filters && "channelId" in filters ? filters.channelId ?? null : get().channelId;
    set({ loading: true, query, sortDirection, channelId });
    try {
      const { data } = await api.get("/channels/saved", {
        params: {
          limit: PAGE_SIZE,
          offset: 0,
          q: query || undefined,
          channelId: channelId || undefined,
          sort: sortDirection,
        },
      });
      const saved = data.saved as SavedEntry[];
      set((state) => {
        if (
          requestId !== activeSavedListRequestId
          || state.query !== query
          || state.channelId !== channelId
          || state.sortDirection !== sortDirection
        ) return {};
        // `saved` is only the first page, while `savedIds` also tracks visible
        // messages checked or saved outside that page. Replacing the set here
        // makes an optimistic save disappear when its row is not in page one.
        const savedIds = new Set(state.savedIds);
        for (const entry of saved) savedIds.add(entry.messageId);
        return {
          saved,
          savedIds,
          hasMore: !!data.hasMore,
          resultTotal: typeof data.total === "number" ? data.total : saved.length,
          // Fall back to the loaded length if an older server omits `total`.
          total: typeof data.globalTotal === "number"
            ? data.globalTotal
            : !query && !channelId
              ? (typeof data.total === "number" ? data.total : saved.length)
              : state.total,
          loading: false,
        };
      });
    } catch (err) {
      console.error("Failed to load saved messages:", err);
      if (requestId === activeSavedListRequestId) set({ loading: false });
    }
  },

  loadMore: async () => {
    const { saved, loading, hasMore } = get();
    if (loading || !hasMore) return;
    set({ loading: true });
    const requestId = ++activeSavedListRequestId;
    try {
      const { query, channelId, sortDirection } = get();
      const { data } = await api.get("/channels/saved", {
        params: {
          limit: PAGE_SIZE,
          offset: saved.length,
          q: query || undefined,
          channelId: channelId || undefined,
          sort: sortDirection,
        },
      });
      const more = data.saved as SavedEntry[];
      set((state) => {
        if (
          requestId !== activeSavedListRequestId
          || state.query !== query
          || state.channelId !== channelId
          || state.sortDirection !== sortDirection
        ) return {};
        const merged = [...state.saved, ...more];
        const ids = new Set(state.savedIds);
        for (const s of more) ids.add(s.messageId);
        return { saved: merged, savedIds: ids, hasMore: !!data.hasMore, loading: false };
      });
    } catch (err) {
      console.error("Failed to load more saved messages:", err);
      if (requestId === activeSavedListRequestId) set({ loading: false });
    }
  },

  saveMessage: async (messageId: string) => {
    // Optimistic update — bump the count immediately so the badge updates in
    // real time, only for a genuinely new save. loadSaved() reconciles on success.
    const wasSaved = get().savedIds.has(messageId);
    set((state) => ({
      savedIds: new Set([...state.savedIds, messageId]),
      total: wasSaved ? state.total : state.total + 1,
    }));
    try {
      await api.post("/channels/saved", { messageId });
      // Reload full list to get metadata + reconcile the authoritative total.
      get().loadSaved();
    } catch (err) {
      console.error("Failed to save message:", err);
      // Revert
      set((state) => {
        const next = new Set(state.savedIds);
        next.delete(messageId);
        return { savedIds: next, total: wasSaved ? state.total : Math.max(0, state.total - 1) };
      });
    }
  },

  unsaveMessage: async (messageId: string) => {
    // Optimistic update — drop the count immediately (real-time badge), only if
    // it was actually saved.
    const wasSaved = get().savedIds.has(messageId);
    set((state) => {
      const next = new Set(state.savedIds);
      next.delete(messageId);
      const wasInCurrentResult = state.saved.some((entry) => entry.messageId === messageId);
      return {
        savedIds: next,
        saved: state.saved.filter((s) => s.messageId !== messageId),
        total: wasSaved ? Math.max(0, state.total - 1) : state.total,
        resultTotal: wasInCurrentResult ? Math.max(0, state.resultTotal - 1) : state.resultTotal,
      };
    });
    try {
      await api.delete(`/channels/saved/${messageId}`);
    } catch (err) {
      console.error("Failed to unsave message:", err);
      // Revert by reloading
      get().loadSaved();
    }
  },

  isSaved: (messageId: string) => {
    return get().savedIds.has(messageId);
  },

  checkSaved: async (messageIds: string[]) => {
    if (messageIds.length === 0) return;
    try {
      const { data } = await api.post("/channels/saved/check", { messageIds });
      const ids = data.savedIds as string[];
      set((state) => {
        if (ids.every((id) => state.savedIds.has(id))) return state;
        const next = new Set(state.savedIds);
        for (const id of ids) next.add(id);
        return { savedIds: next };
      });
    } catch (err) {
      console.error("Failed to check saved messages:", err);
    }
  },
}));

// Reset on server switch
registerServerReset(() => {
  activeSavedListRequestId += 1;
  useSavedStore.setState({
    saved: [],
    savedIds: new Set(),
    loading: false,
    hasMore: false,
    total: 0,
    resultTotal: 0,
    query: "",
    channelId: null,
    sortDirection: "desc",
  });
});
