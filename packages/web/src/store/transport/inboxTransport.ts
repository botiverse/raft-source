/**
 * Inbox transport adapters — the L1 exemplar of RFC 037.
 *
 * This is the ONLY module that talks to the network for the inbox domain.
 * Everything it returns is a domain event (store/events/inboxEvents.ts);
 * nothing else escapes. Components never import this module — intents on
 * the domain store call it, and the socket bridge feeds its adapters.
 *
 * HTTP here is not a separate write path: initial/pagination loads become
 * `hydrate` events, re-pulls become `reconcile` events, and socket pushes
 * become `patch` events — all consumed by the same reducer (Linear
 * sync-engine rule: one entrypoint applies bootstrap and deltas alike).
 */

import type { AxiosResponse } from "axios";
import api from "../../api/client";
import { emitStateTransitionTrace } from "../../utils/stateTransitionTrace";
import type { InboxFilter, InboxItem } from "../inboxStore";
import type {
  InboxHydrateEvent,
  InboxPatchEvent,
  InboxReconcileEvent,
} from "../events/inboxEvents";

export const INBOX_PAGE_SIZE = 30;

interface InboxWindowResponse {
  items?: InboxItem[];
  hasMore?: boolean;
  totalCount?: number | null;
  totalUnreadCount?: number | null;
}

/** Injectable fetcher so tests exercise the full L1→L2→L3 path offline. */
export type InboxWindowFetcher = (params: {
  filter: InboxFilter;
  limit: number;
  offset: number;
}) => Promise<InboxWindowResponse>;

const defaultFetcher: InboxWindowFetcher = async (params) => {
  const { data } = await api.get("/channels/inbox", { params });
  return data as InboxWindowResponse;
};

/** Initial load / pagination page → `hydrate` event. */
export async function fetchInboxHydrate(
  args: { filter: InboxFilter; offset: number; reset: boolean },
  fetcher: InboxWindowFetcher = defaultFetcher,
): Promise<InboxHydrateEvent> {
  const data = await fetcher({
    filter: args.filter,
    limit: INBOX_PAGE_SIZE,
    offset: args.reset ? 0 : args.offset,
  });
  return {
    kind: "hydrate",
    filter: args.filter,
    reset: args.reset,
    items: data.items ?? [],
    hasMore: Boolean(data.hasMore),
    totalCount: data.totalCount ?? null,
    totalUnreadCount: data.totalUnreadCount ?? null,
  };
}

/** Server-truth re-pull (reconnect / visibility regain / patch-miss) →
 *  `reconcile` event. Same endpoint, different event semantics: the reducer
 *  replaces local state with this snapshot instead of merging a page. */
export async function fetchInboxReconcile(
  filter: InboxFilter,
  fetcher: InboxWindowFetcher = defaultFetcher,
): Promise<InboxReconcileEvent> {
  const data = await fetcher({ filter, limit: INBOX_PAGE_SIZE, offset: 0 });
  return {
    kind: "reconcile",
    filter,
    items: data.items ?? [],
    hasMore: Boolean(data.hasMore),
    totalCount: data.totalCount ?? null,
    totalUnreadCount: data.totalUnreadCount ?? null,
  };
}

/** Shape of the `message:new` socket payload fields the inbox cares about.
 *  (The full Message type lives in messageStore; the adapter deliberately
 *  depends only on what it reads.) */
export interface InboxSocketMessage {
  id: string;
  channelId: string;
  content?: string;
  createdAt?: string;
  senderType?: "user" | "agent" | "system" | "external_projection";
  senderId?: string;
  senderName?: string | null;
}

/** The channel/dm row variant of InboxItem (its discriminant is the
 *  two-valued `kind: "channel" | "dm"`). */
export type InboxChannelRow = Extract<InboxItem, { kind: "channel" | "dm" }>;

/** Channel context the S1 wiring supplies from channelStore (read-only) so
 *  the adapter can build a full row without cross-store reach-ins here. */
export interface InboxChannelContext {
  channelName: string;
  channelType: "channel" | "private" | "joint" | "dm";
  /** The row currently in inbox state for this channel, if any. */
  previousItem: InboxChannelRow | null;
  /** Whether this message mentions the current user (mention parser owns this). */
  mentionsCurrentUser: boolean;
}

/**
 * `message:new` socket push → `item-upsert` patch event, built locally from
 * data the client already holds — this is the hop that removes the
 * 3-4s "refetch the whole inbox to show one message" lag.
 * Returns null when the payload is not inbox-relevant (own channel row
 * bookkeeping stays in messageStore; sender==currentUser handling is the
 * S1 wiring's call via `context`).
 */
export function inboxPatchFromMessageNew(
  msg: InboxSocketMessage,
  context: InboxChannelContext,
): InboxPatchEvent | null {
  if (!msg?.id || !msg.channelId) return null;
  const previous = context.previousItem;
  const item: InboxItem = {
    kind: context.channelType === "dm" ? "dm" : "channel",
    channelId: msg.channelId,
    channelName: context.channelName,
    channelType: context.channelType,
    lastMessageId: msg.id,
    firstUnreadMessageId: previous?.firstUnreadMessageId ?? msg.id,
    firstMentionMessageId: context.mentionsCurrentUser
      ? previous?.firstMentionMessageId ?? msg.id
      : previous?.firstMentionMessageId ?? null,
    lastMessageAt: msg.createdAt ?? new Date().toISOString(),
    lastMessagePreview: msg.content ?? "",
    lastMessageSenderType: msg.senderType ?? "user",
    lastMessageSenderId: msg.senderId ?? "",
    lastMessageSenderName: msg.senderName ?? null,
    // The socket payload does not carry an exact canonical activity sequence.
    // Do not reuse stale row evidence or derive authority from IDs/timestamps.
    latestActivitySeq: null,
    unreadCount: (previous?.unreadCount ?? 0) + 1,
    hasMention: Boolean(previous?.hasMention) || context.mentionsCurrentUser,
  };
  return { kind: "patch", patch: "item-upsert", item, marker: msg.id };
}

/** Local read intent → `item-read` patch + fire-and-forget server persist.
 *  The optimistic transform is the reducer's job; this returns the event and
 *  performs the (idempotent) server write the same way markRead does today. */
export function inboxReadPatch(itemKey: string, channelIdToPersist: string): InboxPatchEvent {
  api.post(`/channels/${channelIdToPersist}/read-all`).catch(() => {
    // Honest degradation (Tenny review): the optimistic read will flip back
    // on the next reconcile — emit the cause so the flip is attributable
    // instead of an invisible-red. Recovery itself is reconcile's job.
    emitStateTransitionTrace({
      domain: "inbox",
      event: "persist:item-read-failed",
      entityId: itemKey,
      outcome: "conflict",
      outcomeDetail: "persist_failed",
      touched: 0,
      reconcileSuggested: true,
    });
  });
  return { kind: "patch", patch: "item-read", itemKey };
}

const readAllInFlight = new Map<string, Promise<AxiosResponse>>();

/** The write identity a `read-all` persists under. The coalesce key MUST carry
 *  this, not just the channel: a module-global map keyed by channel alone
 *  would merge writes across an account/server switch — and across the human vs
 *  agent receiver scopes Gate A introduces — letting a later identity ride the
 *  previous identity's in-flight request/ACK (a cross-principal false success).
 *  `receiver` is optional until the server delegation contract lands; it is
 *  already part of the key so human-self and agent-receiver writes never
 *  coalesce once A2 starts sending it. */
export interface ReadAllWriteIdentity {
  serverId: string | null;
  serverEpoch: number;
  principalId: string | null;
  receiver?: { kind: "human" | "agent"; id: string };
}

/** Persist a channel/thread `read-all`, coalescing concurrent posts that share
 *  the SAME write identity + scope into ONE in-flight network request.
 *
 *  A thread read intent otherwise reaches the server twice: the thread store's
 *  `clearThreadUnread` posts `/channels/:id/read-all`, and the Activity
 *  `markRead` intent posts the same scope again for its ack handling. Both are
 *  the same idempotent write under the same identity, so the second is pure
 *  duplicate traffic (the production HAR showed two concurrent POSTs per
 *  intent). The first caller owns the request; concurrent callers with an
 *  identical identity+scope share its promise — same response on success, same
 *  rejection on failure — and the slot clears on settle so the next intent
 *  posts again. A different principal/server/epoch/receiver gets its own slot. */
export function postReadAllCoalesced(
  channelId: string,
  identity: ReadAllWriteIdentity,
): Promise<AxiosResponse> {
  const key = [
    identity.serverId ?? "",
    identity.serverEpoch,
    identity.principalId ?? "",
    identity.receiver ? `${identity.receiver.kind}:${identity.receiver.id}` : "self",
    channelId,
  ].join("|");
  const existing = readAllInFlight.get(key);
  if (existing) return existing;
  const promise = api.post(
    `/channels/${channelId}/read-all`,
    identity.receiver ? { receiver: identity.receiver } : undefined,
  );
  readAllInFlight.set(key, promise);
  // Clear the slot when the request settles, via a DETACHED handler rather than
  // `.finally`: wrapping the returned promise would add a microtask and shift
  // callers' `.then` timing relative to the pre-coalescing direct `api.post`
  // (e.g. the persisted-read notification that drives Activity reconcile must
  // fire at the same point it always did). Concurrent same-key callers share
  // this exact promise, so one network request serves them all.
  promise.then(
    () => {
      readAllInFlight.delete(key);
    },
    () => {
      readAllInFlight.delete(key);
    },
  );
  return promise;
}
