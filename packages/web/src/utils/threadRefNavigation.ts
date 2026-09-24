import type { FollowedThread, ThreadSummary } from "../store/threadStore";

type ThreadRefFollowedThread = Pick<FollowedThread, "parentMessageId" | "parentChannelId">
  & Partial<Pick<FollowedThread, "threadChannelId">>;

export interface ThreadRouteTarget {
  serverSlug: string;
  parentChannelId: string;
  parentMessageId: string;
  threadChannelId?: string | null;
  focusedMessageId?: string | null;
}

export interface ThreadRefIntent {
  serverSlug: string;
  parentChannelName: string;
  parentChannelType?: "channel" | "dm";
  parentChannelId?: string | null;
  shortId: string;
  focusedMessageId?: string | null;
}

export interface ThreadRefHandoffIntent extends ThreadRefIntent {
  handoffId: string;
}

export interface ThreadRefChannel {
  id: string;
  name: string;
  type: string;
  peerName?: string | null;
}

export interface ThreadRefAuthoritySnapshot {
  serverSlug?: string | null;
  serverEpoch: number;
}

export type ThreadRefHandoffResult = "opened" | "failed" | "stale" | "already-consumed";

interface ExecuteThreadRefHandoffOptions {
  consumedHandoffs: Set<string>;
  maxConsumedHandoffs?: number;
  intent: ThreadRefHandoffIntent;
  serverSlug: string;
  serverEpoch: number;
  channels: ThreadRefChannel[];
  consume: () => void;
  resolve: (parentChannel: ThreadRefChannel) => Promise<ThreadRouteTarget | null>;
  getAuthority: () => ThreadRefAuthoritySnapshot;
  onOpen: (target: ThreadRouteTarget, parentChannel: ThreadRefChannel) => void;
  onFailure: () => void;
}

interface ResolveThreadRefOptions {
  serverSlug: string;
  parentChannelId: string;
  shortId: string;
  summaries: Record<string, ThreadSummary>;
  followedThreads: ThreadRefFollowedThread[];
  loadContext: (parentChannelId: string, shortId: string) => Promise<{
    targetMessageId?: string | null;
    canonicalTarget?: {
      kind?: string;
      channelId?: string;
      messageId?: string;
      threadParentMessageId?: string;
      threadChannelId?: string | null;
    } | null;
  }>;
}

export type ResolvedThreadRefTarget = ThreadRouteTarget;

const THREAD_REF_CHANNEL_PARAM = "threadRefChannel";
const THREAD_REF_SHORT_PARAM = "threadRef";
const THREAD_REF_FOCUS_PARAM = "threadRefFocus";
const THREAD_REF_KIND_PARAM = "threadRefKind";
const THREAD_REF_NONCE_PARAM = "threadRefNonce";
const DEFAULT_MAX_CONSUMED_THREAD_REF_HANDOFFS = 64;

export function buildThreadRefHandoffPath(intent: ThreadRefIntent): string {
  const params = new URLSearchParams({
    [THREAD_REF_CHANNEL_PARAM]: intent.parentChannelName,
    [THREAD_REF_SHORT_PARAM]: intent.shortId,
    [THREAD_REF_NONCE_PARAM]: crypto.randomUUID(),
  });
  if (intent.focusedMessageId) params.set(THREAD_REF_FOCUS_PARAM, intent.focusedMessageId);
  if (intent.parentChannelType === "dm") params.set(THREAD_REF_KIND_PARAM, "dm");
  return `/s/${encodeURIComponent(intent.serverSlug)}?${params.toString()}`;
}

export function parseThreadRefHandoff(serverSlug: string, search: string): ThreadRefHandoffIntent | null {
  const params = new URLSearchParams(search);
  const parentChannelName = params.get(THREAD_REF_CHANNEL_PARAM)?.trim();
  const shortId = params.get(THREAD_REF_SHORT_PARAM)?.trim();
  const handoffId = params.get(THREAD_REF_NONCE_PARAM)?.trim();
  if (!serverSlug || !parentChannelName || !shortId || !handoffId) return null;
  return {
    serverSlug,
    handoffId,
    parentChannelName,
    parentChannelType: params.get(THREAD_REF_KIND_PARAM) === "dm" ? "dm" : "channel",
    shortId,
    focusedMessageId: params.get(THREAD_REF_FOCUS_PARAM),
  };
}

export function consumeThreadRefHandoffSearch(search: string): string {
  const params = new URLSearchParams(search);
  params.delete(THREAD_REF_CHANNEL_PARAM);
  params.delete(THREAD_REF_SHORT_PARAM);
  params.delete(THREAD_REF_FOCUS_PARAM);
  params.delete(THREAD_REF_KIND_PARAM);
  params.delete(THREAD_REF_NONCE_PARAM);
  const nextSearch = params.toString();
  return nextSearch ? `?${nextSearch}` : "";
}

export function isThreadRouteAuthorityCurrent(
  expectedServerSlug: string,
  expectedServerEpoch: number,
  currentServerSlug: string | null | undefined,
  currentServerEpoch: number,
): boolean {
  return expectedServerSlug === currentServerSlug && expectedServerEpoch === currentServerEpoch;
}

export function captureThreadRouteAuthorityGuard(
  expectedServerSlug: string,
  getAuthority: () => { serverSlug: string | null | undefined; serverEpoch: number },
): () => boolean {
  const { serverEpoch: expectedServerEpoch } = getAuthority();
  return () => {
    const currentAuthority = getAuthority();
    return isThreadRouteAuthorityCurrent(
      expectedServerSlug,
      expectedServerEpoch,
      currentAuthority.serverSlug,
      currentAuthority.serverEpoch,
    );
  };
}

export async function executeThreadRefHandoffOnce({
  consumedHandoffs,
  maxConsumedHandoffs = DEFAULT_MAX_CONSUMED_THREAD_REF_HANDOFFS,
  intent,
  serverSlug,
  serverEpoch,
  channels,
  consume,
  resolve,
  getAuthority,
  onOpen,
  onFailure,
}: ExecuteThreadRefHandoffOptions): Promise<ThreadRefHandoffResult> {
  if (consumedHandoffs.has(intent.handoffId)) return "already-consumed";
  consumedHandoffs.add(intent.handoffId);
  const boundedSize = Math.max(1, maxConsumedHandoffs);
  while (consumedHandoffs.size > boundedSize) {
    const oldestHandoffId = consumedHandoffs.values().next().value;
    if (typeof oldestHandoffId !== "string") break;
    consumedHandoffs.delete(oldestHandoffId);
  }

  // The authority-bearing query is one-shot. Consume it synchronously before
  // channel lookup or any async resolution so failures cannot replay it.
  consume();

  const authorityIsCurrent = () => {
    const authority = getAuthority();
    return isThreadRouteAuthorityCurrent(
      serverSlug,
      serverEpoch,
      authority.serverSlug,
      authority.serverEpoch,
    );
  };
  const failClosed = (): ThreadRefHandoffResult => {
    if (!authorityIsCurrent()) return "stale";
    onFailure();
    return "failed";
  };

  const parentChannel = findThreadRefParentChannel(intent, serverSlug, channels);
  if (!parentChannel) return failClosed();

  let target: ThreadRouteTarget | null;
  try {
    target = await resolve(parentChannel);
  } catch {
    return failClosed();
  }

  if (!authorityIsCurrent()) return "stale";
  if (!target || target.serverSlug !== serverSlug) return failClosed();
  onOpen({
    ...target,
    focusedMessageId: intent.focusedMessageId ?? target.focusedMessageId,
  }, parentChannel);
  return "opened";
}

export function buildThreadRoutePath(
  target: ThreadRouteTarget,
  parentChannelType: "channel" | "dm" = "channel",
): string {
  const params = new URLSearchParams({
    thread: `${target.parentChannelId}:${target.parentMessageId}`,
    msg: target.focusedMessageId ?? target.parentMessageId,
  });
  return `/s/${encodeURIComponent(target.serverSlug)}/${parentChannelType}/${target.parentChannelId}?${params.toString()}`;
}

export function findThreadRefParentChannel(
  intent: ThreadRefIntent,
  currentServerSlug: string,
  channels: ThreadRefChannel[],
): ThreadRefChannel | null {
  if (intent.serverSlug !== currentServerSlug) return null;
  const candidates = channels.filter((channel) =>
    (intent.parentChannelType === "dm"
      ? channel.type === "dm"
      : channel.type === "channel" || channel.type === "private" || channel.type === "joint")
    && (channel.name.toLowerCase() === intent.parentChannelName.toLowerCase()
      || (intent.parentChannelType === "dm" && channel.peerName?.toLowerCase() === intent.parentChannelName.toLowerCase()))
    && (!intent.parentChannelId || channel.id === intent.parentChannelId)
  );
  return candidates.length === 1 ? candidates[0] : null;
}

export function findThreadParentMessageIdByShortId({
  parentChannelId,
  shortId,
  followedThreads,
}: Pick<ResolveThreadRefOptions, "parentChannelId" | "shortId" | "summaries" | "followedThreads">): string | null {
  const normalizedShortId = shortId.toLowerCase();
  const matches = new Set<string>();

  for (const thread of followedThreads) {
    if (
      thread.parentChannelId === parentChannelId &&
      thread.parentMessageId.toLowerCase().startsWith(normalizedShortId)
    ) {
      matches.add(thread.parentMessageId);
    }
  }

  return matches.size === 1 ? [...matches][0] : null;
}

export async function resolveThreadParentMessageIdByShortId({
  serverSlug,
  parentChannelId,
  shortId,
  summaries,
  followedThreads,
  loadContext,
}: ResolveThreadRefOptions): Promise<string | null> {
  const target = await resolveThreadTargetByShortId({
    serverSlug,
    parentChannelId,
    shortId,
    summaries,
    followedThreads,
    loadContext,
  });
  return target?.parentMessageId ?? null;
}

export async function resolveThreadTargetByShortId({
  serverSlug,
  parentChannelId,
  shortId,
  summaries,
  followedThreads,
  loadContext,
}: ResolveThreadRefOptions): Promise<ResolvedThreadRefTarget | null> {
  const localParentMessageId = findThreadParentMessageIdByShortId({
    parentChannelId,
    shortId,
    summaries,
    followedThreads,
  });
  if (localParentMessageId) {
    const summary = summaries[localParentMessageId];
    const followed = followedThreads.find((thread) =>
      thread.parentChannelId === parentChannelId && thread.parentMessageId === localParentMessageId
    );
    return {
      serverSlug,
      parentChannelId,
      parentMessageId: localParentMessageId,
      threadChannelId: summary?.threadChannelId
        ?? followed?.threadChannelId
        ?? null,
    };
  }

  try {
    const context = await loadContext(parentChannelId, shortId);
    if (
      context.canonicalTarget?.kind === "thread"
      && typeof context.canonicalTarget.threadParentMessageId === "string"
    ) {
      return {
        serverSlug,
        parentChannelId: context.canonicalTarget.channelId ?? parentChannelId,
        parentMessageId: context.canonicalTarget.threadParentMessageId,
        threadChannelId: context.canonicalTarget.threadChannelId ?? null,
        focusedMessageId: context.targetMessageId ?? context.canonicalTarget.messageId ?? null,
      };
    }
    return context.targetMessageId
      ? { serverSlug, parentChannelId, parentMessageId: context.targetMessageId }
      : null;
  } catch {
    return null;
  }
}
