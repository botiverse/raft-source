// Where each unsent draft lives, for the Drafts page (#triage:#127).
//
// The composer keeps a draft under the conversation it is typed in
// (messageStore.drafts): a channel or DM id, a thread's or a task's own
// conversation id, or `pending-thread:…` for a thread nobody has replied to
// yet (ThreadPanel's composer before its conversation exists). Some keys name
// no conversation: dialog notes (a forward's note, an Artifact share's note)
// and comments on an attachment (`attachment-comment:…`, before their thread
// exists). They are never a draft here.
//
// Drafts are kept across servers, so a place is resolved for the current
// server: a channel or DM in the sidebar at once, anything else by asking the
// server (`GET /channels/:id`, `GET /messages/context/:id`), and a key the
// server says is not here (another server's, a deleted channel: a 404 or 403)
// is no place: it is left out of the list and the count, and the draft itself
// is kept. A lookup that failed for another reason (offline, a 5xx) is asked
// again later rather than remembered as no place. Lookups wait for the
// sidebar's lists (they place most keys at once) and run three at a time.

import { create } from "zustand";
import api from "../api/client";
import { useChannelStore } from "../store/channelStore";
import { findStoredChannel } from "../store/storedChannel";
import { useTaskStore } from "../store/taskStore";
import type { Task } from "../store/taskStore";
import { loadConversationIdentity } from "./messagePlace";
import type { LoadConversationIdentity } from "./messagePlace";

export type DraftRouteKind = "channel" | "dm";

export type DraftPlace =
  | { kind: "channel"; channelId: string; routeKind: DraftRouteKind }
  | { kind: "thread"; parentChannelId: string; parentMessageId: string; parentRouteKind: DraftRouteKind }
  | { kind: "task"; taskId: string; parentChannelId: string; parentRouteKind: DraftRouteKind };

const PENDING_THREAD_PREFIX = "pending-thread:";
const PENDING_TASK_PREFIX = "pending-thread:task:";
/** Keys a composer keeps that name no conversation. */
const NOT_CONVERSATION_PREFIXES = ["forward-note:", "artifact-share-note:", "artifact-link-send-note:", "attachment-comment:"];

/** A draft key that names a conversation (not a dialog's note or an attachment's comments). */
export function isConversationDraftKey(key: string): boolean {
  return !NOT_CONVERSATION_PREFIXES.some((prefix) => key.startsWith(prefix));
}

function knownType(channelId: string): string | null {
  const state = useChannelStore.getState();
  if (state.dmChannels.some((channel) => channel.id === channelId)) return "dm";
  return findStoredChannel(state, channelId)?.type ?? null;
}

function routeKindOf(channelId: string): DraftRouteKind {
  return knownType(channelId) === "dm" ? "dm" : "channel";
}

/**
 * A conversation's route kind now: what the sidebar's lists say, else the one
 * the place was resolved with (the lists may have loaded after it was).
 */
export function currentRouteKind(channelId: string, resolvedWith: DraftRouteKind): DraftRouteKind {
  const type = knownType(channelId);
  if (type === "dm") return "dm";
  if (type) return "channel";
  return resolvedWith;
}

function findTask(taskId: string): Task | undefined {
  const { tasks, tasksByChannelId } = useTaskStore.getState();
  return tasks.find((task) => task.id === taskId)
    ?? Object.values(tasksByChannelId).flat().find((task) => task.id === taskId);
}

function taskPlace(taskId: string, parentChannelId: string): DraftPlace {
  return { kind: "task", taskId, parentChannelId, parentRouteKind: routeKindOf(parentChannelId) };
}

/**
 * The place a draft key names, from what this tab already has; `undefined`
 * when only the server can say. A dialog note is never a place (null).
 */
export function resolveDraftPlaceSync(key: string): DraftPlace | null | undefined {
  if (!isConversationDraftKey(key)) return null;
  if (key.startsWith(PENDING_TASK_PREFIX)) {
    const taskId = key.slice(PENDING_TASK_PREFIX.length);
    const task = findTask(taskId);
    return task ? taskPlace(task.id, task.channelId) : undefined;
  }
  if (key.startsWith(PENDING_THREAD_PREFIX)) return undefined;
  const type = knownType(key);
  if (type === "dm") return { kind: "channel", channelId: key, routeKind: "dm" };
  if (type && type !== "thread" && type !== "task") return { kind: "channel", channelId: key, routeKind: "channel" };
  return undefined;
}

export type LoadMessageChannel = (messageId: string) => Promise<string | null>;

/** `GET /messages/context/:id`: the conversation a message was posted in. */
const loadMessageChannel: LoadMessageChannel = async (messageId) => {
  const { data } = await api.get<{ messages?: { id: string; channelId: string }[]; targetMessageId?: string }>(
    `/messages/context/${encodeURIComponent(messageId)}`,
    { params: { before: 0, after: 0 } },
  );
  const target = data?.targetMessageId ?? messageId;
  return data?.messages?.find((message) => message.id === target)?.channelId ?? null;
};

export interface DraftPlaceLoaders {
  conversation?: LoadConversationIdentity;
  messageChannel?: LoadMessageChannel;
}

function httpStatus(error: unknown): number | undefined {
  const status = (error as { response?: { status?: unknown } } | null)?.response?.status;
  return typeof status === "number" ? status : undefined;
}

/** The server's definite "not here": the key's conversation is on another server, gone, or not this person's. */
function isDefiniteAbsence(error: unknown): boolean {
  const status = httpStatus(error);
  return status === 404 || status === 403;
}

/**
 * The place a draft key names, asking the server when this tab can't tell;
 * null when there is none here. Rejects when the server could not answer
 * (offline, a 5xx, a 429), so the caller can ask again later.
 */
export async function resolveDraftPlace(key: string, loaders: DraftPlaceLoaders = {}): Promise<DraftPlace | null> {
  const known = resolveDraftPlaceSync(key);
  if (known !== undefined) return known;
  // A task's conversation that doesn't exist yet: only a loaded task says
  // its channel (there is no single-task lookup), so it waits for one.
  if (key.startsWith(PENDING_TASK_PREFIX)) return null;
  try {
    if (key.startsWith(PENDING_THREAD_PREFIX)) {
      const parentMessageId = key.slice(PENDING_THREAD_PREFIX.length);
      const parentChannelId = await (loaders.messageChannel ?? loadMessageChannel)(parentMessageId);
      if (!parentChannelId) return null;
      return { kind: "thread", parentChannelId, parentMessageId, parentRouteKind: routeKindOf(parentChannelId) };
    }
    const identity = await (loaders.conversation ?? loadConversationIdentity)(key);
    if (!identity) return null;
    if (identity.type === "thread" && identity.parentChannelId && identity.parentMessageId) {
      return {
        kind: "thread",
        parentChannelId: identity.parentChannelId,
        parentMessageId: identity.parentMessageId,
        parentRouteKind: routeKindOf(identity.parentChannelId),
      };
    }
    if (identity.type === "task" && identity.parentChannelId && identity.taskId) {
      return taskPlace(identity.taskId, identity.parentChannelId);
    }
    if (identity.type === "dm") return { kind: "channel", channelId: key, routeKind: "dm" };
    if (identity.type === "channel" || identity.type === "private" || identity.type === "joint") {
      return { kind: "channel", channelId: key, routeKind: "channel" };
    }
    return null;
  } catch (error) {
    if (isDefiniteAbsence(error)) return null;
    throw error;
  }
}

interface DraftPlaceState {
  /** `${serverId}:${draftKey}` → its place on that server, or null for none. */
  places: Record<string, DraftPlace | null>;
}

/** Places asked of the server, per server, kept for the tab's life (a draft's conversation doesn't move). */
export const useDraftPlaceStore = create<DraftPlaceState>(() => ({ places: {} }));

const inFlight = new Set<string>();
/** When a key's last lookup failed without an answer: it is not asked again before RETRY_AFTER_MS. */
const failedAt = new Map<string, number>();
const RETRY_AFTER_MS = 30_000;
/** At most this many lookups at once, so many drafts don't fire many requests together. */
const MAX_CONCURRENT_LOOKUPS = 3;
const queue: { cacheKey: string; key: string; loaders: DraftPlaceLoaders; askedAt: number }[] = [];
let active = 0;

export function draftPlaceCacheKey(serverId: string, key: string): string {
  return `${serverId}:${key}`;
}

function pump(): void {
  while (active < MAX_CONCURRENT_LOOKUPS && queue.length > 0) {
    const next = queue.shift()!;
    active += 1;
    void resolveDraftPlace(next.key, next.loaders).then(
      (place) => {
        failedAt.delete(next.cacheKey);
        useDraftPlaceStore.setState((state) => ({ places: { ...state.places, [next.cacheKey]: place } }));
      },
      () => {
        // No answer (offline, a 5xx): not remembered, asked again later.
        failedAt.set(next.cacheKey, next.askedAt);
      },
    ).finally(() => {
      inFlight.delete(next.cacheKey);
      active = Math.max(0, active - 1);
      pump();
    });
  }
}

/**
 * Asks the server for the keys this tab can't place yet: each key once per
 * server, three at a time. Call it once the sidebar's lists have loaded,
 * since they place most keys without a request.
 */
export function ensureDraftPlaces(serverId: string, keys: readonly string[], loaders: DraftPlaceLoaders = {}, now = Date.now()): void {
  for (const key of keys) {
    if (resolveDraftPlaceSync(key) !== undefined) continue;
    const cacheKey = draftPlaceCacheKey(serverId, key);
    if (cacheKey in useDraftPlaceStore.getState().places || inFlight.has(cacheKey)) continue;
    const failed = failedAt.get(cacheKey);
    if (failed !== undefined && now - failed < RETRY_AFTER_MS) continue;
    inFlight.add(cacheKey);
    queue.push({ cacheKey, key, loaders, askedAt: now });
  }
  pump();
}

/** A key's place on this server: from the tab first, then from what the server said; undefined while unknown. */
export function draftPlaceFor(serverId: string, key: string, places: Record<string, DraftPlace | null>): DraftPlace | null | undefined {
  const known = resolveDraftPlaceSync(key);
  if (known !== undefined) return known;
  return places[draftPlaceCacheKey(serverId, key)];
}

export function resetDraftPlacesForTests(): void {
  inFlight.clear();
  failedAt.clear();
  queue.length = 0;
  active = 0;
  useDraftPlaceStore.setState({ places: {} });
}
