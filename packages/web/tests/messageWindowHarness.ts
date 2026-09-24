import {
  selectChannelWindowMeta,
} from "../src/store/messageStore.js";
import type {
  Message,
} from "../src/store/messageStore.js";
import type { ThreadSummary } from "../src/store/threadStore.js";

class MemoryStorage {
  private readonly map = new Map<string, string>();

  getItem(key: string) {
    return this.map.has(key) ? this.map.get(key)! : null;
  }

  setItem(key: string, value: string) {
    this.map.set(key, value);
  }

  removeItem(key: string) {
    this.map.delete(key);
  }

  clear() {
    this.map.clear();
  }
}

if (!("localStorage" in globalThis) || typeof globalThis.localStorage?.getItem !== "function") {
  Object.defineProperty(globalThis, "localStorage", {
    value: new MemoryStorage(),
    configurable: true,
  });
}

if (!("sessionStorage" in globalThis) || typeof globalThis.sessionStorage?.getItem !== "function") {
  Object.defineProperty(globalThis, "sessionStorage", {
    value: new MemoryStorage(),
    configurable: true,
  });
}

const api = (await import("../src/api/client.js")).default;
const { useMessageStore } = await import("../src/store/messageStore.js");

const originalGet = api.get.bind(api);
const originalPost = api.post.bind(api);

type ChannelPageData = Message[] | {
  messages: Message[];
  historyLimited?: boolean;
  threadSummariesByParentMessageId?: Record<string, ThreadSummary>;
};
type ContextPageData = {
  messages?: Message[];
  threadSummariesByParentMessageId?: Record<string, ThreadSummary>;
  hasOlder?: boolean;
  hasNewer?: boolean;
  targetMessageId?: string;
  canonicalTarget?: {
    kind: "thread";
    channelId: string;
    messageId: string;
    threadParentMessageId: string;
    threadChannelId?: string | null;
  };
};
type ResponseData<T> = T | Promise<T>;

export interface WindowSnapshot {
  messageIds: string[];
  lastSeq: number;
  loading: boolean;
  hasGap: boolean;
  hasMore: boolean;
  hasNewer: boolean;
  loadingGap: boolean;
  highlightedMessageId: string | null;
  contextLoadError: string | null;
  unreadCount: number;
}

export interface WindowMetaSnapshot {
  loading: boolean;
  loadingOlder: boolean;
  loadingNewer: boolean;
  loadingGap: boolean;
  hasMore: boolean;
  hasNewer: boolean;
  hasGap: boolean;
  historyLimited: boolean;
  contextLoadError: string | null;
}

function resetStore() {
  useMessageStore.setState({
    channelMessages: {},
    channelWindowMeta: {},
    messages: [],
    highlightedMessageId: null,
    lastSeq: 0,
    currentChannelId: null,
    loading: false,
    loadingOlder: false,
    loadingNewer: false,
    loadingGap: false,
    hasMore: true,
    hasNewer: false,
    hasGap: false,
    contextLoadError: null,
    unreadCounts: {},
    currentUserId: null,
    historyLimited: false,
    isNearBottom: true,
  });
}

function getMaxSeq(messages: Message[]) {
  return Math.max(...messages.map((message) => message.seq || 0), 0);
}

export async function flushAsyncWork() {
  for (let i = 0; i < 5; i += 1) {
    await new Promise((resolve) => setTimeout(resolve, 0));
  }
}

export function createMessageWindowHarness() {
  resetStore();

  const syncPages: Array<ResponseData<Message[]>> = [];
  const channelPages: Array<ResponseData<ChannelPageData>> = [];
  const contextPages: Array<ResponseData<ContextPageData>> = [];
  const postResponses: unknown[] = [];
  const getCalls: string[] = [];
  const postCalls: Array<{ url: string; body: unknown }> = [];

  api.get = (async (url: string) => {
    getCalls.push(url);
    if (url.startsWith("/messages/sync?")) {
      return { data: await (syncPages.shift() ?? []) };
    }
    if (url.startsWith("/messages/channel/")) {
      const page = await (channelPages.shift() ?? []);
      return { data: Array.isArray(page) ? { messages: page } : page };
    }
    if (url.startsWith("/messages/context/")) {
      if (contextPages.length === 0) throw new Error(`Unexpected GET ${url}`);
      return { data: await contextPages.shift()! };
    }
    throw new Error(`Unexpected GET ${url}`);
  }) as typeof api.get;

  api.post = (async (url: string, body?: unknown) => {
    postCalls.push({ url, body });
    return { data: postResponses.shift() ?? {} };
  }) as typeof api.post;

  return {
    primeWindow(channelId: string, messages: Message[], overrides?: Partial<WindowSnapshot> & { lastSeq?: number }) {
      const lastSeq = overrides?.lastSeq ?? getMaxSeq(messages);
      useMessageStore.setState({
        channelMessages: { [channelId]: messages },
        channelWindowMeta: {
          [channelId]: {
            loading: overrides?.loading ?? false,
            loadingOlder: false,
            loadingNewer: false,
            loadingGap: overrides?.loadingGap ?? false,
            hasMore: overrides?.hasMore ?? true,
            hasNewer: overrides?.hasNewer ?? false,
            hasGap: overrides?.hasGap ?? false,
            historyLimited: false,
            contextLoadError: overrides?.contextLoadError ?? null,
          },
        },
        messages,
        currentChannelId: channelId,
        lastSeq,
        loading: overrides?.loading ?? false,
        hasMore: overrides?.hasMore ?? true,
        hasGap: overrides?.hasGap ?? false,
        hasNewer: overrides?.hasNewer ?? false,
        loadingGap: overrides?.loadingGap ?? false,
        unreadCounts: overrides?.unreadCount ? { [channelId]: overrides.unreadCount } : {},
        isNearBottom: true,
      });
    },

    setCurrentUser(userId: string | null) {
      useMessageStore.getState().setCurrentUserId(userId);
    },

    switchCurrentChannel(channelId: string | null) {
      useMessageStore.setState({
        currentChannelId: channelId,
        messages: channelId ? (useMessageStore.getState().channelMessages[channelId] ?? []) : [],
      });
    },

    enqueueSyncPages(...pages: Array<ResponseData<Message[]>>) {
      syncPages.push(...pages);
    },

    enqueueChannelPages(...pages: Array<ResponseData<ChannelPageData>>) {
      channelPages.push(...pages);
    },

    enqueueContextPages(...pages: Array<ResponseData<ContextPageData>>) {
      contextPages.push(...pages);
    },

    enqueuePostResponses(...responses: unknown[]) {
      postResponses.push(...responses);
    },

    socketMessage(message: Message) {
      useMessageStore.getState().addMessage(message);
    },

    batchMessages(messages: Message[]) {
      useMessageStore.getState().batchAddMessages(messages);
    },

    optimisticMessage(message: Message) {
      useMessageStore.getState().addOptimisticMessage(message);
    },

    async syncGap(channelId?: string) {
      await useMessageStore.getState().syncGap(channelId);
    },

    async loadMessageContext(channelId: string, messageId: string) {
      await useMessageStore.getState().loadMessageContext(channelId, messageId);
    },

    async loadMessageWindowSilent(channelId: string, messageId: string) {
      await useMessageStore.getState().loadMessageWindowSilent(channelId, messageId);
    },

    async loadOlderMessages(channelId?: string) {
      await useMessageStore.getState().loadOlderMessages(channelId);
    },

    async loadNewerMessages(channelId?: string) {
      await useMessageStore.getState().loadNewerMessages(channelId);
    },

    async sendMessage(channelId: string, content: string, optimisticId?: string, randomId?: string) {
      return useMessageStore.getState().sendMessage(channelId, content, undefined, undefined, optimisticId, randomId);
    },

    snapshot(channelId: string): WindowSnapshot {
      const state = useMessageStore.getState();
      return {
        messageIds: state.messages.map((message) => message.id),
        lastSeq: state.lastSeq,
        loading: state.loading,
        hasGap: state.hasGap,
        hasMore: state.hasMore,
        hasNewer: state.hasNewer,
        loadingGap: state.loadingGap,
        highlightedMessageId: state.highlightedMessageId,
        contextLoadError: state.contextLoadError,
        unreadCount: state.unreadCounts[channelId] || 0,
      };
    },

    windowMeta(channelId: string): WindowMetaSnapshot {
      const meta = selectChannelWindowMeta(useMessageStore.getState(), channelId);
      return {
        loading: meta.loading,
        loadingOlder: meta.loadingOlder,
        loadingNewer: meta.loadingNewer,
        loadingGap: meta.loadingGap,
        hasMore: meta.hasMore,
        hasNewer: meta.hasNewer,
        hasGap: meta.hasGap,
        historyLimited: meta.historyLimited,
        contextLoadError: meta.contextLoadError,
      };
    },

    messages(channelId: string): Message[] {
      return [...(useMessageStore.getState().channelMessages[channelId] ?? [])];
    },

    setWindowMeta(channelId: string, meta: Partial<WindowMetaSnapshot>) {
      useMessageStore.setState((state) => ({
        channelWindowMeta: {
          ...state.channelWindowMeta,
          [channelId]: {
            ...selectChannelWindowMeta(state, channelId),
            ...meta,
          },
        },
        ...(channelId === state.currentChannelId ? {
          ...(meta.loading !== undefined ? { loading: meta.loading } : {}),
          ...(meta.loadingOlder !== undefined ? { loadingOlder: meta.loadingOlder } : {}),
          ...(meta.loadingNewer !== undefined ? { loadingNewer: meta.loadingNewer } : {}),
          ...(meta.loadingGap !== undefined ? { loadingGap: meta.loadingGap } : {}),
          ...(meta.hasMore !== undefined ? { hasMore: meta.hasMore } : {}),
          ...(meta.hasNewer !== undefined ? { hasNewer: meta.hasNewer } : {}),
          ...(meta.hasGap !== undefined ? { hasGap: meta.hasGap } : {}),
          ...(meta.historyLimited !== undefined ? { historyLimited: meta.historyLimited } : {}),
          ...(meta.contextLoadError !== undefined ? { contextLoadError: meta.contextLoadError } : {}),
        } : {}),
      }));
    },

    rawMessages(channelId: string): Message[] | undefined {
      return useMessageStore.getState().channelMessages[channelId];
    },

    getCalls() {
      return [...getCalls];
    },

    postCalls() {
      return [...postCalls];
    },

    restore() {
      api.get = originalGet;
      api.post = originalPost;
      resetStore();
    },
  };
}
