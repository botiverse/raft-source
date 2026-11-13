import type { Dispatch, SetStateAction } from "react";
import { compareMessagesForDisplay, isMatchingOptimisticMessage, mergeIncomingMessage } from "../../store/messageStore";
import type { Message } from "../../store/messageStore";
import { isCanonicalMessageReaction } from "../../store/normalizedMessageReactions";

export const EMPTY_MESSAGES: Message[] = [];
export const THREAD_LATEST_WINDOW_LIMIT = 50;
/** The 8-character id agents see in message headers (`msg=c1d2e3f4`). */
export const SHORT_MESSAGE_ID = /^[0-9a-f]{8}$/i;

// Share the messageStore's canonical ordering so a thread reply stream sorts
// IDENTICALLY to the main list. The old local comparator sank every not-yet-`seq`
// optimistic row below all persisted rows, so an optimistic reply jumped position
// the moment the server echo arrived with a `seq`; `compareMessagesForDisplay`
// instead orders it by `createdAt` where its future `seq` will land (task #480).
export function sortThreadMessages(msgs: Message[]): Message[] {
  return [...msgs].sort(compareMessagesForDisplay);
}

function sameReactions(
  a: Message["reactions"],
  b: Message["reactions"],
): boolean {
  if (a === b) return true;
  const la = a?.length ?? 0;
  const lb = b?.length ?? 0;
  if (la !== lb) return false;
  if (la === 0) return true;
  for (let i = 0; i < la; i += 1) {
    const left = a![i];
    const right = b![i];
    if (left.emoji !== right.emoji || left.count !== right.count) return false;
    if ("reactorIds" in left && "reactorIds" in right) {
      if (left.reactorIds.length !== right.reactorIds.length) return false;
      continue;
    }
    if (isCanonicalMessageReaction(left) && isCanonicalMessageReaction(right)) {
      if (JSON.stringify(left.previewK) !== JSON.stringify(right.previewK)) return false;
      continue;
    }
    return false;
  }
  return true;
}

export function sameMessageList(a: Message[], b: Message[]): boolean {
  if (a === b) return true;
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i += 1) {
    const left = a[i];
    const right = b[i];
    if (
      left.id !== right.id ||
      left.seq !== right.seq ||
      left.content !== right.content ||
      left.createdAt !== right.createdAt
    ) {
      return false;
    }
    // Reactions mutate in-place on a stored message when someone toggles an
    // emoji; without this check we'd shallow-equal a reaction-only diff and
    // skip the local `messages` setState, leaving the thread UI stale until
    // refresh. task #290.
    if (!sameReactions(left.reactions, right.reactions)) {
      return false;
    }
  }
  return true;
}

export function mergeThreadMessages(existing: Message[], incoming: Message[]): Message[] {
  if (incoming.length === 0) return existing;

  const byId = new Map(existing.map((msg) => [msg.id, msg]));
  for (const msg of incoming) {
    byId.set(msg.id, msg);
  }

  const merged = [...byId.values()];
  const realMessages = merged.filter((msg) => !msg.id.startsWith("optimistic-"));
  const optimisticIdsToDrop = new Set<string>();
  for (const real of sortThreadMessages(realMessages)) {
    const matchingOptimistic = merged.find(
      (optimistic) => !optimisticIdsToDrop.has(optimistic.id) && isMatchingOptimisticMessage(optimistic, real)
    );
    if (matchingOptimistic) {
      optimisticIdsToDrop.add(matchingOptimistic.id);
    }
  }
  const next = sortThreadMessages(merged.filter((msg) => !optimisticIdsToDrop.has(msg.id)));

  return sameMessageList(existing, next) ? existing : next;
}

/**
 * Apply `message:updated` payloads to rows already owned by this thread.
 * Some update producers intentionally send a sparse patch (attachment-comment
 * privacy scrubbing is `{ id, channelId, commentRef }`), so replacing the row
 * would erase required message fields such as `content`. Unknown ids are wake
 * signals for another read model, not permission to append an incomplete row.
 */
export function mergeThreadMessageUpdates(
  existing: Message[],
  updates: Array<Pick<Message, "id" | "channelId"> & Partial<Message>>,
): Message[] {
  if (existing.length === 0 || updates.length === 0) return existing;

  const updatesById = new Map(updates.map((update) => [update.id, update]));
  let changed = false;
  const merged = existing.map((message) => {
    const update = updatesById.get(message.id);
    if (!update) return message;
    const next = mergeIncomingMessage(message, update);
    if (next !== message) changed = true;
    return next;
  });

  return changed ? sortThreadMessages(merged) : existing;
}

/**
 * Project the shared message-store bucket into the thread panel's explicit
 * local history window. `sync:resume` is an event-replay stream, not a history
 * loader: on a fresh session it can contain every reply created after the
 * parent channel's last seen seq. Merging that bucket wholesale silently
 * bypasses the thread's latest-50 / prepend pagination contract.
 *
 * Existing rows may always receive canonical updates. New rows may only land
 * inside the window's loaded lower bound; a latest-aligned window also accepts
 * genuinely newer/optimistic rows, while a focused historical window keeps its
 * upper gap intact. An empty latest window may use a bounded cache tail to
 * avoid a blank flash, but never hydrates unbounded history from replay.
 */
export function mergeThreadBucketWithinWindow(
  existing: Message[],
  incoming: Message[],
  hasNewer: boolean,
  latestLimit = THREAD_LATEST_WINDOW_LIMIT,
): Message[] {
  if (incoming.length === 0) return existing;

  if (existing.length === 0) {
    if (hasNewer) return existing;
    const latest = sortThreadMessages(incoming).slice(-latestLimit);
    return mergeThreadMessages(existing, latest);
  }

  const existingIds = new Set(existing.map((message) => message.id));
  const persistedSeqs = existing
    .map((message) => message.seq)
    .filter((seq): seq is number => typeof seq === "number");
  if (persistedSeqs.length === 0) {
    const existingUpdates = incoming.filter((message) => existingIds.has(message.id));
    if (hasNewer) return mergeThreadMessages(existing, existingUpdates);

    const latestPersisted = sortThreadMessages(
      incoming.filter((message) => typeof message.seq === "number"),
    ).slice(-latestLimit);
    const optimistic = incoming.filter((message) => message.id.startsWith("optimistic-"));
    return mergeThreadMessages(existing, [...latestPersisted, ...optimistic, ...existingUpdates]);
  }

  const minSeq = Math.min(...persistedSeqs);
  const maxSeq = Math.max(...persistedSeqs);
  const withinWindow = incoming.filter((message) => {
    if (existingIds.has(message.id)) return true;
    if (message.id.startsWith("optimistic-")) return !hasNewer;
    if (typeof message.seq !== "number" || message.seq < minSeq) return false;
    return !hasNewer || message.seq <= maxSeq + 1;
  });
  return mergeThreadMessages(existing, withinWindow);
}

export function onlyThreadMessages(threadChannelId: string, messages: Message[]): Message[] {
  // ThreadPanel can be opened from permalinks whose `msg=` points at a parent
  // channel message. `/messages/context/:id` follows that id's own channel, so
  // defensively keep the reply timeline scoped to the concrete thread channel.
  return messages.filter((msg) => msg.channelId === threadChannelId);
}

export function findThreadParentMessage(
  parentChannelBucket: Message[],
  parentMessageId: string | null,
  parentChannelId: string | null,
): Message | null {
  if (!parentMessageId || !parentChannelId) return null;
  return parentChannelBucket.find((msg) => msg.id === parentMessageId) ?? null;
}

export function findCachedThreadParentMessage(
  channelMessages: Record<string, Message[]> | undefined,
  parentChannelId: string,
  parentMessageId: string,
): Message | null {
  return findThreadParentMessage(channelMessages?.[parentChannelId] ?? EMPTY_MESSAGES, parentMessageId, parentChannelId);
}

export function pickFreshThreadParentMessage(
  contextParent: Message | null,
  cachedParent: Message | null,
): Message | null {
  return cachedParent ?? contextParent;
}

export function syncThreadParentMessageFromStore(
  storeParentMessage: Message | null,
  setParentMessage: Dispatch<SetStateAction<Message | null>>,
): void {
  if (storeParentMessage) setParentMessage(storeParentMessage);
}
