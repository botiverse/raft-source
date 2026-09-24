import {
  createSyncCore,
  messageRef,
  messageRepliesDiscussion,
  syncScopeWindow,
} from "@botiverse/raft-shared";
import type {
  SyncCore,
  SyncDomainConfig,
  SyncFrame,
  SyncIngestOutcome,
  SyncSnapshot,
} from "@botiverse/raft-shared";
import {
  applyThreadReplyFrame,
  emptyThreadRepliesScope,
  hydrateThreadRepliesScope,
  INLINE_REPLY_CAP,
} from "./threadRepliesReadModel";
import type {
  ThreadRepliesScope,
} from "./threadRepliesReadModel";
import {
  projectThreadReplyFrame,
  readThreadRepliesSyncWindowEnvelope,
} from "./threadRepliesSocket";
import type {
  ThreadUpdatedPayload,
} from "./threadRepliesSocket";
import api from "../api/client";
import type { Message } from "./messageStore";
import {
  isReceiverPrivateIngressContextCurrent,
} from "./receiverPrivateIngress";
import type {
  ReceiverPrivateIngressContext,
} from "./receiverPrivateIngress";
import { registerMessagesSyncCoreReset } from "./messageSyncCoreReset";
import {
  isKnownThreadRepliesSyncWindowProducer,
  isThreadRepliesSyncWindowProducerEligible,
} from "./threadRepliesSyncProducerRegistry";

export const THREAD_REPLIES_SYNC_DOMAIN = "threadReplies";

export interface ThreadRepliesDomainEvent {
  kind: "thread:updated";
  parentMessageId: string;
  threadChannelId: string;
  replyCount: number;
  reply: Parameters<typeof applyThreadReplyFrame>[1];
}

export interface ThreadRepliesSyncContext {
  serverId: string | null;
  principalId: string | null;
  ingressContext: ReceiverPrivateIngressContext;
}

export interface ThreadRepliesRebaselineRequest {
  scopeId: string;
  epoch: string | null;
  generation: number;
  ingressGeneration: number;
  serverEpoch: number;
}

export interface ThreadRepliesPresentation {
  parentMessageId: string;
  threadChannelId: string;
  replyCount: number;
  lastReplyAt: string | null;
  participantIds: string[];
  unreadCount?: number;
  firstUnreadMessageId?: string | null;
  latestReply?: Message;
}

export type ThreadRepliesConsumerResult =
  | { kind: "shadow_fail_open"; reason: "ineligible" | "stale_principal"; frame: NonNullable<ReturnType<typeof projectThreadReplyFrame>> | null }
  | {
      kind: "applied";
      outcome: SyncIngestOutcome;
      parentMessageId: string;
      parentChannelId: string | null;
      threadChannelId: string;
      epoch: string | null;
      scopeId: string;
      scope: ThreadRepliesScope;
    }
  | { kind: "duplicate_dropped"; outcome: SyncIngestOutcome; parentMessageId: string; parentChannelId: string | null; threadChannelId: string; epoch: string | null; scopeId: string; ingressContext: ReceiverPrivateIngressContext }
  | { kind: "rebaseline_requested"; outcome: SyncIngestOutcome; parentMessageId: string; parentChannelId: string | null; threadChannelId: string; epoch: string | null; scopeId: string; ingressContext: ReceiverPrivateIngressContext; request: ThreadRepliesRebaselineRequest }
  | { kind: "rebaseline_pending"; parentMessageId: string; parentChannelId: string | null; threadChannelId: string; epoch: string | null; scopeId: string; ingressContext: ReceiverPrivateIngressContext }
  | { kind: "dropped"; reason: "invalid_frame" | "stale_ingress" };

function createThreadRepliesDomain(): SyncDomainConfig<ThreadRepliesScope, ThreadRepliesDomainEvent> {
  return {
    name: THREAD_REPLIES_SYNC_DOMAIN,
    density: "sparse",
    initialState: emptyThreadRepliesScope,
    fold: (state, event) => {
      if (event.kind !== "thread:updated") return state;
      return applyThreadReplyFrame(
        state,
        event.reply,
        event.replyCount,
        { source: "sync-core" },
      );
    },
    fromSnapshot: (snapshot: SyncSnapshot<unknown>) => snapshot.state as ThreadRepliesScope,
    acceptSameWatermarkSnapshot: (currentState, snapshot) => {
      const incoming = snapshot.state as ThreadRepliesScope;
      if (!incoming || !Array.isArray(incoming.replies)) return false;
      // A sparse live frame can be the first contact for this scope and only
      // contain one reply. The bundled HTTP snapshot is the authoritative
      // latest-N projection; at the same watermark it may replace that
      // provisional state only when it is strictly richer and does not carry
      // an older authoritative count.
      if (incoming.replyCount < currentState.replyCount) return false;
      if (incoming.replies.length > currentState.replies.length) return true;
      if (incoming.replies.length < currentState.replies.length) return false;
      // Equal-size windows can still differ when several sparse live frames
      // arrived before the snapshot (for example [218,219,221] vs the
      // authoritative [219,220,221]). Compare newest-to-oldest so a snapshot
      // that advances any retained slot may replace the provisional window,
      // while a stale equal-size snapshot cannot roll it back.
      for (let index = incoming.replies.length - 1; index >= 0; index -= 1) {
        const incomingSeq = incoming.replies[index]?.seq ?? -1;
        const currentSeq = currentState.replies[index]?.seq ?? -1;
        if (incomingSeq === currentSeq) continue;
        return incomingSeq > currentSeq;
      }
      return false;
    },
  };
}

let threadRepliesSyncCore: SyncCore | null = null;
// HTTP compatibility snapshots intentionally carry epoch=null. Keep the first
// canonical producer epoch beside the core so those snapshots cannot erase it,
// and so a later canonical epoch mismatch is rejected before core mutation.
// This is deliberately replies-specific: generic Sync Core null-epoch snapshot
// semantics remain unchanged for domains that do not have this compatibility
// seam.
const canonicalEpochByScopeId = new Map<string, string>();
interface PendingThreadRepliesRebaseline {
  request: ThreadRepliesRebaselineRequest;
  frames: SyncFrame<ThreadRepliesDomainEvent>[];
  latestPresentation: ThreadRepliesPresentation;
  eventCount: number;
}
const pendingRebaselineByScopeId = new Map<string, PendingThreadRepliesRebaseline>();
let nextRebaselineGeneration = 0;

function getThreadRepliesSyncCore(): SyncCore {
  threadRepliesSyncCore ??= createSyncCore({
    domains: [createThreadRepliesDomain() as SyncDomainConfig<unknown, unknown>],
  });
  return threadRepliesSyncCore;
}

export function resetThreadRepliesSyncCore(): void {
  threadRepliesSyncCore = null;
  canonicalEpochByScopeId.clear();
  pendingRebaselineByScopeId.clear();
}

export const resetThreadRepliesSyncCoreForTests = resetThreadRepliesSyncCore;

export function readThreadRepliesSyncCoreScopeForTests(input: {
  serverId: string;
  principalId: string;
  parentMessageId: string;
  threadChannelId: string;
}): ThreadRepliesScope | null {
  return getThreadRepliesSyncCore().state<ThreadRepliesScope>(
    THREAD_REPLIES_SYNC_DOMAIN,
    threadRepliesScopeId(input),
  ) ?? null;
}

registerMessagesSyncCoreReset(resetThreadRepliesSyncCore);

export function threadRepliesScopeId(input: {
  serverId: string;
  principalId: string;
  parentMessageId: string;
  threadChannelId: string;
}): string {
  return JSON.stringify([
    input.serverId,
    input.principalId,
    input.parentMessageId,
    input.threadChannelId,
  ]);
}

export interface ThreadRepliesSnapshotHydrationResult {
  outcome: SyncIngestOutcome;
  scope: ThreadRepliesScope | null;
}

export interface ThreadRepliesRebaselineHydrationResult
  extends ThreadRepliesSnapshotHydrationResult {
  presentation: ThreadRepliesPresentation | null;
  pendingEventCount: number;
}

export interface ThreadRepliesRebaselineSnapshot {
  replies: ThreadRepliesDomainEvent["reply"][];
  replyCount: number;
  historyLimited: boolean;
  watermark: number;
  epoch: string | null;
}

export function hydrateThreadRepliesSnapshotWithSyncCore(input: {
  serverId: string;
  principalId: string;
  parentMessageId: string;
  threadChannelId: string;
  replies: ThreadRepliesDomainEvent["reply"][];
  replyCount: number;
  historyLimited: boolean;
  watermark: number;
  epoch: string | null;
}): ThreadRepliesSnapshotHydrationResult {
  const scopeId = threadRepliesScopeId(input);
  const effectiveEpoch = input.epoch
    ?? canonicalEpochByScopeId.get(scopeId)
    ?? null;
  const scope = hydrateThreadRepliesScope(input.replies, input.replyCount, {
    historyLimited: input.historyLimited,
    principalId: input.principalId,
    parentMessageId: input.parentMessageId,
    threadChannelId: input.threadChannelId,
    epoch: effectiveEpoch,
  });
  const core = getThreadRepliesSyncCore();
  const outcome = core.ingestSnapshot(THREAD_REPLIES_SYNC_DOMAIN, {
    scopeId,
    watermark: BigInt(input.watermark),
    epoch: effectiveEpoch,
    state: scope,
  });
  if (outcome.kind === "applied" && input.epoch !== null) {
    canonicalEpochByScopeId.set(scopeId, input.epoch);
  }
  return {
    outcome,
    scope: core.state<ThreadRepliesScope>(THREAD_REPLIES_SYNC_DOMAIN, scopeId) ?? null,
  };
}

function currentThreadRepliesScope(
  scopeId: string,
): ThreadRepliesScope | null {
  return getThreadRepliesSyncCore().state<ThreadRepliesScope>(
    THREAD_REPLIES_SYNC_DOMAIN,
    scopeId,
  ) ?? null;
}

function rebaselineRequestMatches(
  request: ThreadRepliesRebaselineRequest,
): boolean {
  const pending = pendingRebaselineByScopeId.get(request.scopeId);
  return pending?.request.generation === request.generation
    && pending.request.epoch === request.epoch;
}

export function releaseThreadRepliesRebaselineRequest(
  request: ThreadRepliesRebaselineRequest,
): void {
  if (rebaselineRequestMatches(request)) {
    pendingRebaselineByScopeId.delete(request.scopeId);
  }
}

export function hydrateThreadRepliesRebaselineSnapshotWithSyncCore(input: {
  serverId: string;
  principalId: string;
  parentMessageId: string;
  threadChannelId: string;
  replies: ThreadRepliesDomainEvent["reply"][];
  replyCount: number;
  historyLimited: boolean;
  watermark: number;
  epoch: string | null;
  request: ThreadRepliesRebaselineRequest;
}): ThreadRepliesRebaselineHydrationResult {
  const scopeId = threadRepliesScopeId(input);
  if (
    input.request.scopeId !== scopeId
    || input.request.epoch !== input.epoch
    || !rebaselineRequestMatches(input.request)
  ) {
    return {
      outcome: {
        kind: "duplicate_dropped",
        scopeId,
        seq: BigInt(input.watermark),
      },
      scope: currentThreadRepliesScope(scopeId),
      presentation: null,
      pendingEventCount: 0,
    };
  }
  const result = hydrateThreadRepliesSnapshotWithSyncCore(input);
  const pending = pendingRebaselineByScopeId.get(scopeId);
  if (result.outcome.kind === "applied" && pending) {
    for (const frame of pending.frames) {
      getThreadRepliesSyncCore().ingestFrame(
        THREAD_REPLIES_SYNC_DOMAIN,
        frame,
      );
    }
    result.scope = currentThreadRepliesScope(scopeId);
  }
  releaseThreadRepliesRebaselineRequest(input.request);
  return {
    ...result,
    presentation: pending?.latestPresentation ?? null,
    pendingEventCount: pending?.eventCount ?? 0,
  };
}

function rawThreadRepliesProducer(payload: ThreadUpdatedPayload): string | null {
  const envelope = payload.syncCoreReplyWindow;
  if (!envelope || typeof envelope !== "object") return null;
  const producer = (envelope as Record<string, unknown>).producer;
  return typeof producer === "string" ? producer : null;
}

function envelopeMatchesSharedRepliesContract(input: {
  envelope: NonNullable<ReturnType<typeof readThreadRepliesSyncWindowEnvelope>>;
  serverId: string;
  parentMessageId: string;
  parentAnchor: {
    parentMessageId: string;
    parentChannelId: string;
    parentChannelType: string;
  };
}): boolean {
  const { envelope, serverId, parentMessageId, parentAnchor } = input;
  if (!isThreadRepliesSyncWindowProducerEligible({
    producer: envelope.producer,
    serverId,
  })) return false;
  if (envelope.discussion.root.serverId !== serverId) return false;
  if (envelope.discussion.root.id !== parentMessageId) return false;
  if (parentAnchor.parentMessageId !== parentMessageId) return false;
  if (parentAnchor.parentChannelId !== envelope.parentChannelId) return false;
  if (parentAnchor.parentChannelType !== envelope.parentScopeKind) return false;
  if (envelope.discussion.parentScopeKey.serverId !== serverId) return false;
  if (envelope.discussion.parentScopeKey.scopeId !== envelope.parentChannelId) return false;
  if (envelope.discussion.parentScopeKey.scopeKind !== envelope.parentScopeKind) return false;
  if (!["channel", "private", "joint", "dm"].includes(envelope.parentScopeKind)) return false;
  const expectedDiscussion = messageRepliesDiscussion(
    messageRef(serverId, parentMessageId),
    envelope.discussion.parentScopeKey,
  );
  const expectedWindow = syncScopeWindow({
    scopeCursor: envelope.window.scopeCursor,
    epoch: envelope.window.epoch,
  });
  return envelope.discussion.root.kind === expectedDiscussion.root.kind
    && envelope.discussion.root.serverId === expectedDiscussion.root.serverId
    && envelope.discussion.root.id === expectedDiscussion.root.id
    && envelope.discussion.relation.kind === expectedDiscussion.relation.kind
    && envelope.discussion.parentScopeKey.serverId === expectedDiscussion.parentScopeKey.serverId
    && envelope.discussion.parentScopeKey.scopeKind === expectedDiscussion.parentScopeKey.scopeKind
    && envelope.discussion.parentScopeKey.scopeId === expectedDiscussion.parentScopeKey.scopeId
    && envelope.discussion.backing === expectedDiscussion.backing
    && envelope.window.kind === expectedWindow.kind
    && envelope.window.scopeCursor === expectedWindow.scopeCursor
    && envelope.window.epoch === expectedWindow.epoch;
}

function readThreadReplyParentAnchor(
  payload: ThreadUpdatedPayload,
): {
  parentMessageId: string;
  parentChannelId: string;
  parentChannelType: string;
} | null {
  const context = payload.latestReply?.conversationContext;
  if (!context || typeof context !== "object") return null;
  const candidate = context as Record<string, unknown>;
  if (candidate.channelType !== "thread") return null;
  if (typeof candidate.parentMessageId !== "string") return null;
  if (typeof candidate.parentChannelId !== "string") return null;
  if (typeof candidate.parentChannelType !== "string") return null;
  return {
    parentMessageId: candidate.parentMessageId,
    parentChannelId: candidate.parentChannelId,
    parentChannelType: candidate.parentChannelType,
  };
}

function readThreadRepliesPresentation(
  payload: ThreadUpdatedPayload,
): ThreadRepliesPresentation | null {
  if (typeof payload.parentMessageId !== "string") return null;
  if (typeof payload.threadChannelId !== "string") return null;
  if (typeof payload.replyCount !== "number" || !Number.isFinite(payload.replyCount)) return null;
  if (payload.lastReplyAt !== null && typeof payload.lastReplyAt !== "string") return null;
  if (!Array.isArray(payload.participantIds)) return null;
  if (!payload.participantIds.every((id) => typeof id === "string")) return null;
  if (
    payload.unreadCount !== undefined
    && (typeof payload.unreadCount !== "number" || !Number.isFinite(payload.unreadCount))
  ) return null;
  if (
    payload.firstUnreadMessageId !== undefined
    && payload.firstUnreadMessageId !== null
    && typeof payload.firstUnreadMessageId !== "string"
  ) return null;
  return {
    parentMessageId: payload.parentMessageId,
    threadChannelId: payload.threadChannelId,
    replyCount: payload.replyCount,
    lastReplyAt: payload.lastReplyAt,
    participantIds: [...payload.participantIds],
    ...(payload.unreadCount === undefined ? {} : { unreadCount: payload.unreadCount }),
    ...(payload.firstUnreadMessageId === undefined
      ? {}
      : { firstUnreadMessageId: payload.firstUnreadMessageId }),
    ...(payload.latestReply ? { latestReply: payload.latestReply as Message } : {}),
  };
}

function threadRepliesFrame(
  payload: ThreadUpdatedPayload,
  context: ThreadRepliesSyncContext,
): {
  frame: SyncFrame<ThreadRepliesDomainEvent>;
  parentMessageId: string;
  parentChannelId: string | null;
  threadChannelId: string;
  epoch: string | null;
  scopeId: string;
  presentation: ThreadRepliesPresentation;
} | null {
  const projected = projectThreadReplyFrame(payload);
  const threadChannelId = payload.threadChannelId;
  const envelope = readThreadRepliesSyncWindowEnvelope(payload);
  const parentAnchor = readThreadReplyParentAnchor(payload);
  const presentation = readThreadRepliesPresentation(payload);
  if (!projected || typeof threadChannelId !== "string") return null;
  if (!context.serverId || !context.principalId) return null;
  if (!envelope) return null;
  if (!parentAnchor) return null;
  if (!presentation) return null;
  if (!envelopeMatchesSharedRepliesContract({
    envelope,
    serverId: context.serverId,
    parentMessageId: projected.parentMessageId,
    parentAnchor,
  })) return null;
  const scopeId = threadRepliesScopeId({
    serverId: context.serverId,
    principalId: context.principalId,
    parentMessageId: projected.parentMessageId,
    threadChannelId,
  });
  return {
    parentMessageId: projected.parentMessageId,
    parentChannelId: envelope.parentChannelId ?? null,
    threadChannelId,
    epoch: envelope.epoch,
    scopeId,
    presentation,
    frame: {
      scopeId,
      seq: BigInt(projected.reply.seq),
      epoch: envelope.epoch,
      event: {
        kind: "thread:updated",
        parentMessageId: projected.parentMessageId,
        threadChannelId,
        replyCount: projected.replyCount,
        reply: projected.reply,
      },
    },
  };
}

function rebaselineResult(
  normalized: NonNullable<ReturnType<typeof threadRepliesFrame>>,
  context: ThreadRepliesSyncContext,
  outcome: SyncIngestOutcome,
): Extract<ThreadRepliesConsumerResult, { kind: "rebaseline_requested" | "rebaseline_pending" }> {
  const pending = pendingRebaselineByScopeId.get(normalized.scopeId);
  const shared = {
    parentMessageId: normalized.parentMessageId,
    parentChannelId: normalized.parentChannelId,
    threadChannelId: normalized.threadChannelId,
    epoch: normalized.epoch,
    scopeId: normalized.scopeId,
    ingressContext: context.ingressContext,
  };
  if (
    pending?.request.epoch === normalized.epoch
    && pending.request.ingressGeneration === context.ingressContext.generation
    && pending.request.serverEpoch === context.ingressContext.serverEpoch
  ) {
    if (normalized.frame.seq >= (pending.frames.at(-1)?.seq ?? -Infinity)) {
      pending.latestPresentation = normalized.presentation;
    }
    if (!pending.frames.some((frame) => frame.seq === normalized.frame.seq)) {
      pending.eventCount += 1;
      pending.frames = [...pending.frames, normalized.frame]
        .sort((left, right) => (left.seq < right.seq ? -1 : left.seq > right.seq ? 1 : 0))
        .slice(-INLINE_REPLY_CAP);
    }
    return { kind: "rebaseline_pending", ...shared };
  }
  const request = {
    scopeId: normalized.scopeId,
    epoch: normalized.epoch,
    generation: ++nextRebaselineGeneration,
    ingressGeneration: context.ingressContext.generation,
    serverEpoch: context.ingressContext.serverEpoch,
  };
  pendingRebaselineByScopeId.set(normalized.scopeId, {
    request,
    frames: [normalized.frame],
    latestPresentation: normalized.presentation,
    eventCount: 1,
  });
  return {
    kind: "rebaseline_requested",
    outcome,
    request,
    ...shared,
  };
}

export function consumeThreadUpdatedWithSyncCore(
  payload: ThreadUpdatedPayload,
  context: ThreadRepliesSyncContext,
): ThreadRepliesConsumerResult {
  const legacyFrame = projectThreadReplyFrame(payload);
  if (!isReceiverPrivateIngressContextCurrent(context.ingressContext)) {
    return { kind: "dropped", reason: "stale_ingress" };
  }
  const producer = rawThreadRepliesProducer(payload);
  if (!isKnownThreadRepliesSyncWindowProducer(producer)) {
    return legacyFrame
      ? { kind: "shadow_fail_open", reason: "ineligible", frame: legacyFrame }
      : { kind: "dropped", reason: "invalid_frame" };
  }

  const normalized = threadRepliesFrame(payload, context);
  if (!normalized) {
    return { kind: "dropped", reason: "invalid_frame" };
  }

  const core = getThreadRepliesSyncCore();
  const canonicalEpoch = canonicalEpochByScopeId.get(normalized.scopeId);
  if (
    canonicalEpoch !== undefined
    && normalized.epoch !== null
    && normalized.epoch !== canonicalEpoch
  ) {
    return rebaselineResult(normalized, context, {
      kind: "epoch_rebaseline_requested",
      scopeId: normalized.scopeId,
    });
  }
  if (canonicalEpoch === undefined && normalized.epoch !== null) {
    // Canonical authority is established by arrival, even when the core later
    // classifies this particular seq as a duplicate of an HTTP watermark.
    canonicalEpochByScopeId.set(normalized.scopeId, normalized.epoch);
  }
  const outcome = core.ingestFrame(THREAD_REPLIES_SYNC_DOMAIN, normalized.frame);
  if (outcome.kind === "duplicate_dropped") {
    return {
      kind: "duplicate_dropped",
      outcome,
      parentMessageId: normalized.parentMessageId,
      parentChannelId: normalized.parentChannelId,
      threadChannelId: normalized.threadChannelId,
      epoch: normalized.epoch,
      scopeId: normalized.scopeId,
      ingressContext: context.ingressContext,
    };
  }
  if (outcome.kind === "epoch_rebaseline_requested") {
    return rebaselineResult(normalized, context, outcome);
  }
  const scope = core.state<ThreadRepliesScope>(THREAD_REPLIES_SYNC_DOMAIN, normalized.scopeId);
  if (!scope) {
    return { kind: "shadow_fail_open", reason: "ineligible", frame: legacyFrame };
  }
  return {
    kind: "applied",
    outcome,
    parentMessageId: normalized.parentMessageId,
    parentChannelId: normalized.parentChannelId,
    threadChannelId: normalized.threadChannelId,
    epoch: normalized.epoch,
    scopeId: normalized.scopeId,
    scope,
  };
}

function projectThreadReplySnapshotMessage(message: Message): ThreadRepliesDomainEvent["reply"] | null {
  if (typeof message.seq !== "number" || !Number.isFinite(message.seq)) return null;
  return {
    messageId: message.id,
    seq: message.seq,
    preview: typeof message.content === "string" ? message.content : "",
    senderId: typeof message.senderId === "string" ? message.senderId : "",
    senderType: message.senderType,
    senderName: typeof message.senderName === "string" ? message.senderName : "",
    senderDisplayName: typeof message.senderDisplayName === "string"
      ? message.senderDisplayName
      : (typeof message.senderName === "string" ? message.senderName : ""),
    senderAvatarUrl: null,
    createdAt: typeof message.createdAt === "string" ? message.createdAt : "",
  };
}

export async function requestThreadRepliesRebaselineSnapshot(input: {
  parentMessageId: string;
  parentChannelId?: string | null;
  threadChannelId: string;
  epoch: string | null;
}): Promise<ThreadRepliesRebaselineSnapshot | null> {
  if (!input.parentChannelId) return null;
  const [messagesResponse, summaryResponse] = await Promise.all([
    api.get(`/messages/channel/${input.threadChannelId}?limit=${INLINE_REPLY_CAP}`),
    api.get(`/channels/${input.parentChannelId}/threads/${input.parentMessageId}`).catch(() => null),
  ]);
  const data = messagesResponse.data;
  const summary = summaryResponse?.data;
  const messages = Array.isArray(data?.messages) ? data.messages as Message[] : [];
  const replies = messages
    .map(projectThreadReplySnapshotMessage)
    .filter((reply): reply is ThreadRepliesDomainEvent["reply"] => reply !== null);
  if (summary?.threadChannelId !== input.threadChannelId || typeof summary?.replyCount !== "number") {
    return null;
  }
  const replyCount = summary.replyCount;
  const watermark = replies.reduce((max, reply) => Math.max(max, reply.seq), 0);
  return {
    replies,
    replyCount,
    historyLimited: data?.historyLimited === true,
    watermark,
    epoch: input.epoch,
  };
}
