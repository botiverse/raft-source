// Forum-style channels (#proj-chat:#24, flag channel_thread_sort_v0): the
// activity-ordered list mode of a channel set to `threadSort: "activity"`.
//
// The seq timeline (messageStore) keeps running underneath for the same
// channel: its latest page, live `message:new` appends, read state, unread
// counts and sync stay exactly as in a chat channel. This store adds what the
// seq window cannot express: pages of the channel's top-level messages
// ordered by latest activity (GET /messages/channel/:id/by-activity, keyset
// cursor `(activityAt, seq)`), and the live bumps `thread:updated` reports.
// A window lives only while a forum timeline shows its channel
// (`retainWindow`): replies elsewhere, or in a forum channel not on screen,
// record nothing and read nothing.
// `buildActivityTimeline` merges both into the rendered list: deduped by id
// (the seq copy wins, it gets every live update), ordered by activity with
// the newest at the bottom, and cut at the oldest loaded activity so the list
// never shows a hole between pages.

import { create } from "zustand";
import { messageActivityAtMs } from "@botiverse/raft-shared";
import api from "../api/client";
import type { Message } from "./messageStore";
import {
  captureReceiverPrivateIngressContext,
  hydrateBundledThreadSummaries,
  isReceiverPrivateIngressContextCurrent,
  useMessageStore,
} from "./messageStore";
import { coerceWireMessageSeqs } from "./wireMessageSeq";
import { registerServerReset } from "./serverResetRegistry";
import { subscribeMessageUpdated } from "./messageUpdatedApply";
import type { ThreadSummary } from "./threadStore";

export const ACTIVITY_PAGE_LIMIT = 50;

/** A top-level message as the activity page returns it: with its activity time. */
export type ActivityMessage = Message & { activityAt?: string | null };

export interface ChannelActivityWindow {
  /** Loaded rows, any order; the timeline orders them. */
  messages: ActivityMessage[];
  /** Cursor of the oldest loaded row; null when nothing older remains. */
  nextCursor: string | null;
  hasMore: boolean;
  historyLimited: boolean;
  loading: boolean;
  loadingOlder: boolean;
  error: boolean;
  /** New on every first-page load (unique across windows, so a reopened window never matches a stale page): a stale older page is dropped. */
  generation: number;
}

const EMPTY_WINDOW: ChannelActivityWindow = {
  messages: [],
  nextCursor: null,
  hasMore: false,
  historyLimited: false,
  loading: false,
  loadingOlder: false,
  error: false,
  generation: 0,
};

interface ChannelActivityState {
  windows: Record<string, ChannelActivityWindow>;
  /** Per open forum channel: latest reply time per parent message id from live `thread:updated`. */
  replyBumps: Record<string, Record<string, string>>;
  /** Read (or refresh) the first page; null does nothing. */
  loadLatest: (channelId: string | null) => Promise<void>;
  loadOlder: (channelId: string) => Promise<void>;
  /**
   * A live thread reply. `parentChannelId` is the parent's channel when the
   * event names it; otherwise the open window holding the parent stands in.
   * Acts only for a channel whose forum window is open.
   */
  noteThreadReply: (reply: { parentMessageId: string; lastReplyAt: string | null | undefined; parentChannelId: string | null }) => void;
  patchMessage: (message: Pick<Message, "id" | "channelId"> & Partial<Message>) => void;
  /** Drop a channel's window, bumps and pending refresh (its forum timeline closed). */
  forget: (channelId: string) => void;
}

/** Merge rows by id; a later copy replaces an earlier one but keeps its activityAt if it has none. */
function mergeById(existing: ActivityMessage[], incoming: ActivityMessage[]): ActivityMessage[] {
  const byId = new Map(existing.map((message) => [message.id, message]));
  for (const message of incoming) {
    const prior = byId.get(message.id);
    byId.set(message.id, prior ? { ...prior, ...message, activityAt: message.activityAt ?? prior.activityAt } : message);
  }
  return [...byId.values()];
}

function windowOf(state: ChannelActivityState, channelId: string): ChannelActivityWindow {
  return state.windows[channelId] ?? EMPTY_WINDOW;
}

type ActivityPageResponse = {
  messages?: ActivityMessage[];
  hasMore?: boolean;
  nextCursor?: string | null;
  historyLimited?: boolean;
  threadSummariesByParentMessageId?: Record<string, ThreadSummary>;
};

async function fetchActivityPage(channelId: string, cursor: string | null) {
  const params = new URLSearchParams({ limit: String(ACTIVITY_PAGE_LIMIT) });
  if (cursor) params.set("before", cursor);
  const { data } = await api.get<ActivityPageResponse>(`/messages/channel/${channelId}/by-activity?${params.toString()}`);
  return data;
}

// One pending first-page refresh per channel for bumps of parents not loaded yet.
const refreshTimers = new Map<string, ReturnType<typeof setTimeout>>();
const REFRESH_DEBOUNCE_MS = 500;
let lastGeneration = 0;

export const useChannelActivityStore = create<ChannelActivityState>((set, get) => ({
  windows: {},
  replyBumps: {},

  loadLatest: async (channelId) => {
    if (!channelId) return;
    const generation = ++lastGeneration;
    set((state) => ({
      windows: {
        ...state.windows,
        // The new generation drops any older page in flight: its flag goes with it.
        [channelId]: { ...windowOf(state, channelId), loading: true, loadingOlder: false, error: false, generation },
      },
    }));
    const ingress = captureReceiverPrivateIngressContext(useMessageStore.getState().currentUserId);
    try {
      const data = await fetchActivityPage(channelId, null);
      if (!isReceiverPrivateIngressContextCurrent(ingress)) return;
      if (windowOf(get(), channelId).generation !== generation) return;
      hydrateBundledThreadSummaries(data, ingress);
      const rows = coerceWireMessageSeqs(data.messages ?? []) as ActivityMessage[];
      set((state) => {
        const current = windowOf(state, channelId);
        // A refresh keeps older pages already loaded (dedupe by id): only the
        // first load, with nothing older yet, takes the server's cursor.
        const keepOlder = current.messages.length > 0 && current.nextCursor !== null;
        return {
          windows: {
            ...state.windows,
            [channelId]: {
              ...current,
              messages: mergeById(current.messages, rows),
              nextCursor: keepOlder ? current.nextCursor : data.nextCursor ?? null,
              hasMore: keepOlder ? current.hasMore : Boolean(data.hasMore),
              historyLimited: keepOlder ? current.historyLimited : Boolean(data.historyLimited),
              loading: false,
              error: false,
            },
          },
        };
      });
    } catch {
      if (windowOf(get(), channelId).generation !== generation) return;
      set((state) => ({
        windows: { ...state.windows, [channelId]: { ...windowOf(state, channelId), loading: false, error: true } },
      }));
    }
  },

  loadOlder: async (channelId) => {
    const current = windowOf(get(), channelId);
    if (current.loading || current.loadingOlder || !current.hasMore || !current.nextCursor) return;
    const { generation, nextCursor } = current;
    set((state) => ({
      windows: { ...state.windows, [channelId]: { ...windowOf(state, channelId), loadingOlder: true } },
    }));
    // A stale page (a refresh started, or the window closed) is dropped. It
    // clears its flag only while its generation is still current, so it never
    // clears the flag of a newer older-page load.
    const settleStale = () => {
      if (windowOf(get(), channelId).generation !== generation || !get().windows[channelId]) return;
      set((state) => ({
        windows: { ...state.windows, [channelId]: { ...windowOf(state, channelId), loadingOlder: false } },
      }));
    };
    const ingress = captureReceiverPrivateIngressContext(useMessageStore.getState().currentUserId);
    try {
      const data = await fetchActivityPage(channelId, nextCursor);
      if (!isReceiverPrivateIngressContextCurrent(ingress) || windowOf(get(), channelId).generation !== generation) {
        settleStale();
        return;
      }
      hydrateBundledThreadSummaries(data, ingress);
      const rows = coerceWireMessageSeqs(data.messages ?? []) as ActivityMessage[];
      set((state) => {
        const latest = windowOf(state, channelId);
        return {
          windows: {
            ...state.windows,
            [channelId]: {
              ...latest,
              messages: mergeById(latest.messages, rows),
              nextCursor: data.nextCursor ?? null,
              hasMore: Boolean(data.hasMore),
              historyLimited: Boolean(data.historyLimited),
              loadingOlder: false,
            },
          },
        };
      });
    } catch {
      settleStale();
    }
  },

  noteThreadReply: ({ parentMessageId, lastReplyAt, parentChannelId }) => {
    if (!parentMessageId || !lastReplyAt) return;
    const { windows, replyBumps } = get();
    const channelId = parentChannelId
      ?? Object.keys(windows).find((id) => windows[id].messages.some((m) => m.id === parentMessageId))
      ?? null;
    // Not an open forum channel (any chat channel, or flag off): nothing to do.
    const window = channelId ? windows[channelId] : undefined;
    if (!channelId || !window) return;
    const bumps = replyBumps[channelId] ?? {};
    const prior = bumps[parentMessageId];
    if (prior && Date.parse(prior) >= Date.parse(lastReplyAt)) return;
    set((state) => ({
      replyBumps: { ...state.replyBumps, [channelId]: { ...(state.replyBumps[channelId] ?? {}), [parentMessageId]: lastReplyAt } },
    }));
    // A parent this channel has loaded moves with the bump alone.
    if (window.messages.some((m) => m.id === parentMessageId)) return;
    if (useMessageStore.getState().channelMessages[channelId]?.some((m) => m.id === parentMessageId)) return;
    // An old thread of this channel just got a reply: its first page now
    // holds the parent. One refresh per channel per debounce window.
    if (refreshTimers.has(channelId)) return;
    refreshTimers.set(channelId, setTimeout(() => {
      refreshTimers.delete(channelId);
      if (get().windows[channelId]) void get().loadLatest(channelId);
    }, REFRESH_DEBOUNCE_MS));
  },

  patchMessage: (message) => {
    const { windows } = get();
    const window = windows[message.channelId];
    if (!window || !window.messages.some((m) => m.id === message.id)) return;
    set((state) => {
      const current = windowOf(state, message.channelId);
      return {
        windows: {
          ...state.windows,
          [message.channelId]: {
            ...current,
            messages: current.messages.map((m) => (m.id === message.id ? { ...m, ...message } : m)),
          },
        },
      };
    });
  },

  forget: (channelId) => {
    const timer = refreshTimers.get(channelId);
    if (timer) clearTimeout(timer);
    refreshTimers.delete(channelId);
    set((state) => {
      if (!state.windows[channelId] && !state.replyBumps[channelId]) return state;
      const windows = { ...state.windows };
      delete windows[channelId];
      const replyBumps = { ...state.replyBumps };
      delete replyBumps[channelId];
      return { windows, replyBumps };
    });
  },
}));

// Forum timelines on screen per channel: the window is dropped when the last closes.
const retainedWindows = new Map<string, number>();

/** A forum timeline shows `channelId`: read its first page; the returned release drops the window when the last one closes. */
export function retainWindow(channelId: string): () => void {
  retainedWindows.set(channelId, (retainedWindows.get(channelId) ?? 0) + 1);
  void useChannelActivityStore.getState().loadLatest(channelId);
  let released = false;
  return () => {
    if (released) return;
    released = true;
    const left = (retainedWindows.get(channelId) ?? 1) - 1;
    if (left > 0) {
      retainedWindows.set(channelId, left);
      return;
    }
    retainedWindows.delete(channelId);
    useChannelActivityStore.getState().forget(channelId);
  };
}

// Edits, retractions and card updates reach the loaded rows too.
subscribeMessageUpdated((message) => useChannelActivityStore.getState().patchMessage(message));

registerServerReset(() => {
  for (const timer of refreshTimers.values()) clearTimeout(timer);
  refreshTimers.clear();
  retainedWindows.clear();
  useChannelActivityStore.setState({ windows: {}, replyBumps: {} });
});

/** Activity time of a top-level message in ms: own time, its latest reply (summary or live bump) or the server's activityAt. */
export function activityKeyMs(
  message: ActivityMessage,
  summary: Pick<ThreadSummary, "lastReplyAt"> | undefined,
  bump: string | undefined,
): number {
  let key = messageActivityAtMs(message.createdAt, summary?.lastReplyAt ?? null);
  if (bump) key = Math.max(key, messageActivityAtMs(message.createdAt, bump));
  if (message.activityAt) key = Math.max(key, messageActivityAtMs(message.createdAt, message.activityAt));
  // The max of all three: when the newest reply is deleted the row keeps its
  // place until the window is read again (accepted for the pilot).
  return key;
}

function compareByActivity(a: { key: number; seq: number }, b: { key: number; seq: number }): number {
  return a.key - b.key || a.seq - b.seq;
}

/**
 * The rendered forum list: the activity window's rows and the seq bucket's
 * top-level rows of this channel, deduped by id (the seq copy wins: it gets
 * every live update), ordered by activity ascending (newest at the bottom),
 * ties by seq. While older pages remain, rows older than the oldest loaded
 * activity row are left out, so a seq row far back never shows above a hole.
 */
export function buildActivityTimeline(
  channelId: string,
  seqMessages: readonly Message[],
  window: ChannelActivityWindow | undefined,
  summaries: Readonly<Record<string, Pick<ThreadSummary, "lastReplyAt"> | undefined>>,
  bumps: Readonly<Record<string, string>>,
): Message[] {
  const byId = new Map<string, ActivityMessage>();
  for (const message of window?.messages ?? []) byId.set(message.id, message);
  for (const message of seqMessages) {
    if (message.channelId !== channelId) continue;
    const prior = byId.get(message.id);
    byId.set(message.id, prior?.activityAt ? { ...message, activityAt: prior.activityAt } : message);
  }
  const rows = [...byId.values()].map((message) => ({
    message,
    key: activityKeyMs(message, summaries[message.id], bumps[message.id]),
    seq: typeof message.seq === "number" ? message.seq : Number.MAX_SAFE_INTEGER,
  }));
  rows.sort(compareByActivity);
  let start = 0;
  if (window?.hasMore) {
    // The floor is the oldest row the activity pages returned.
    const paged = new Set(window.messages.map((m) => m.id));
    const floorIndex = rows.findIndex((row) => paged.has(row.message.id));
    if (floorIndex > 0) start = floorIndex;
  }
  return rows.slice(start).map((row) => row.message);
}
