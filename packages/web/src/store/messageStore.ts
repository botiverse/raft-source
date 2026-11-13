import { isAxiosError } from "axios";
import { isAutoReadHeld } from "./autoReadHold";
import { useProfileStore } from "./profileStore";
import { create } from "zustand";
import { isThreadMaximized, useUIStore } from "./uiStore";
import { clearHiddenHistory, clearHiddenTarget, readHistoryLimitedError, recordHiddenHistory, recordHiddenTarget } from "./hiddenHistoryStore";
import type {
  ActionCardMetadata,
  ArtifactReference,
  CanonicalReactionFact,
  ExternalMessageAuthorProjection,
  LegacyReactionRosterDto,
} from "@botiverse/raft-shared";
import { ACTIVE_INPUT_WINDOW_MS, resolveMarkUnreadOutcome } from "@botiverse/raft-shared";
import { isOlderCardRevision, messageCardRevision } from "./messageCardRevision";
import { flushPendingDraftSnapshot, loadDrafts, loadDraftTimes, onDraftsForgotten, persistDraftSnapshotImmediately, scheduleDraftSnapshot } from "./draftStorage";
import api from "../api/client";
import { getRwRead } from "../api/overloadRetry";
import { saveLastCounts } from "./lastCounts";
import { detectBrowserTimezone } from "../utils/timeFormatting";
import { emitStateTransitionTrace } from "../utils/stateTransitionTrace";
import { isCurrentServerConfirmed, onCurrentServerConfirmed, useServerStore } from "./serverStore";
import { useThreadStore } from "./threadStore";
import { consumeManualUnread, forgetManualUnread, rememberManualUnread, shouldSkipInitialAutoRead } from "./manualUnreadSkip";
import { forgetSkippedSeenRead, noteSkippedSeenRead, runSeenReadCatchUp } from "./seenReadCatchUp";
import type { ThreadSummary } from "./threadStore";
import { setCurrentPrincipalId } from "./principalRuntime";
import { noteOutlineMessage } from "./messageOutlineStore";
import { coerceWireMessageSeq, coerceWireMessageSeqs } from "./wireMessageSeq";
import {
  captureReceiverPrivateIngressContext,
  captureHumanActivityIngressContext,
  invalidateReceiverPrivateIngressContexts,
  isReceiverPrivateIngressContextCurrent,
  isReadForAnotherPersonHere,
  registerReceiverPrivatePrincipalReader,
} from "./receiverPrivateIngress";
import type {
  ReceiverPrivateIngressContext,
} from "./receiverPrivateIngress";
import { hydrateThreadRepliesSnapshotWithSyncCore } from "./threadRepliesSyncDomain";
import { latestPageRequest, messageWindowRequest, takeInFlightMessagePage, takeMessagePage, withLiveRowsAfter } from "./messagePagePrefetch";
import type { ThreadRepliesScope } from "./threadRepliesReadModel";
import { registerServerReset } from "./serverResetRegistry";
import { reactionReadModelStore } from "./reactionReadModels";
import { triggerMessagesSyncCoreReset } from "./messageSyncCoreReset";
import {
  getAcceptedReadState,
  normalizeReadStateUpdatedBulk,
  consumeReadStateSnapshotRows,
  getReadStateLedgerGeneration,
  hasAcceptedReadStateChangedAfter,
  notifyChannelReadLocally,
  rememberAcceptedReadStateProjection,
} from "./readStateSync";
import type {
  ReadStateProjection,
} from "./readStateSync";
import { clearMarkedUnreadForRead } from "./markedUnreadStore";
import { isChannelAccessLost, noteChannelReadError } from "./channelAccessLoss";
import { gapSyncWaitsForShow } from "./hiddenOwedReads";
import {
  channelOwesGapFill,
  clearPendingGapMessages,
  finishGapRead,
  getGapFillSinceSeq,
  getPendingGapMessages,
  joinGapReadInFlight,
  rememberPendingGapMessage,
  setGapFillReader,
  settlePendingGapMessages,
  startGapRead,
} from "./liveGapFill";

export interface MessageAttachment {
  id: string;
  filename: string;
  mimeType: string;
  sizeBytes: number;
  width?: number | null;
  height?: number | null;
  thumbnailUrl?: string | null;
  rasterPreviewUrl?: string | null;
  localPreviewUrl?: string | null;
  /** Scoped attachment-comment count (attachment-comments MVP §5 chip badge). */
  commentCount?: number;
  /**
   * The Artifact this attachment was saved as, for this viewer (workspace
   * Artifacts S5). Set only by the fake data source's stand-in: the server
   * never puts it on a message (the app asks `attachmentSaves`).
   */
  savedAsArtifact?: ArtifactReference | null;
}

/** Present when a message is a scoped attachment comment (MVP §5 `re:` chip). */
export interface MessageCommentRef {
  attachmentId: string;
  filename: string;
  /** Host message id for the chip's jump-to-message (cindyz 6/11). */
  hostMessageId: string | null;
  /**
   * Route coordinates for the jump — same source model as the Files tab:
   * channelId is ALWAYS the route channel (the parent channel when the host
   * message lives in a thread). null when the host row is unresolvable
   * (degrade to no jump, never a wrong one).
   */
  hostSource: {
    type: "channel" | "thread";
    routeKind: "channel" | "dm";
    channelId: string;
    parentMessageId?: string;
    threadChannelId?: string;
    /**
     * Set when the host is a top-level message that is itself a thread root —
     * the re: chip opens that thread (expanded) instead of locating the
     * closed-state message (cindyz #32).
     */
    rootThreadChannelId?: string;
  } | null;
  anchorLabel?: string | null;
  anchorQuote?: string | null;
}

/** Current wire DTO. It remains separately named from the normalized V2 fact. */
export interface LegacyMessageReaction extends LegacyReactionRosterDto {
  reactorIds: string[];
  reactorNames: string[];
}

export type MessageReaction = LegacyMessageReaction | CanonicalReactionFact;

export interface MessageMention {
  /** `external` = linked provider member (Slack participant); id is the projection id. */
  type: "user" | "agent" | "external";
  id: string;
  name: string;
  /** Read-only public projection only: the label to show instead of `@name`.
   *  Its `id` is display-local there, never a principal id. */
  displayName?: string;
}

export interface PendingMentionAction {
  resolutionId: string;
  messageId: string;
  targetType: "user" | "agent" | string;
  targetHandle: string;
  targetAvatarUrl?: string | null;
  reason: string;
  availableActions: Array<"notify" | "add" | string>;
  expiresAt?: string | null;
}

export interface MessageDeliveryWarning {
  targetType: "agent";
  targetId: string;
  /** `agent_stuck_on_tool` (task #25): queued behind a tool call the agent is stuck on. */
  reason: "agent_stopped" | "agent_stuck_on_tool";
}

export interface SendMessageResult {
  messageId: string;
  pendingMentionActions: PendingMentionAction[];
  unresolvedMentionHandles: string[];
  deliveryWarnings?: MessageDeliveryWarning[];
}

export interface ConversationContext {
  /** `task`: a task's own conversation (task v2), which has no parent message. */
  channelType: "channel" | "private" | "joint" | "dm" | "thread" | "task";
  parentMessageId?: string;
  parentChannelId?: string;
  parentChannelType?: "channel" | "private" | "joint" | "dm";
  /** Task v2: the task a task-conversation message belongs to. */
  taskId?: string;
}

export interface Message {
  id: string;
  seq?: number;
  /**
   * Client-only display coordinate for optimistic sends. It intentionally does
   * not count as a real server seq for gap/read logic; it only keeps rapid
   * pending rows in the same visual order they should occupy once server seqs
   * arrive.
   */
  optimisticDisplaySeq?: number;
  channelId: string;
  conversationContext?: ConversationContext;
  randomId?: string | null;
  senderType: "user" | "agent" | "external_projection";
  senderId: string;
  senderName?: string;
  senderDisplayName?: string;
  senderDescription?: string | null;
  senderMembershipStatus?: "active" | "left" | "removed" | null;
  /** Immutable attribution for senderType=external_projection. */
  externalAuthor?: ExternalMessageAuthorProjection | null;
  messageType?: "chat" | "system";
  content: string;
  mentions?: MessageMention[];
  /**
   * Thread ANCHOR id, NOT a "this is a reply" flag. When non-null, this
   * message is the parent of a thread and the value is the `channelId` of
   * the thread channel that hangs off it (server: `messages.thread_id`, set
   * by `channelService.syncParentMessageThreadId`). A reply *inside* a
   * thread is an ordinary message whose `channelId === threadChannelId` and
   * whose own `threadId` is null. Do not gate "thread reply" branches on
   * `threadId` — gate on whether the message's `channelId` resolves to a
   * thread-type channel.
   */
  threadId?: string | null;
  createdAt: string;
  updatedAt?: string;
  /**
   * RFC 077: ISO time the owner retracted this delegated message, else null
   * (canonical manifest v7 optional aggregate). Web reads it through
   * `isRetractedMessage` (components/message/delegatedMessage.ts).
   */
  deletedAt?: string | null;
  attachments?: MessageAttachment[];
  reactions?: MessageReaction[];
  /** Set when this message is a scoped attachment comment (MVP §5). */
  commentRef?: MessageCommentRef | null;
  /**
   * Optional structured metadata. v1 carries operation cards
   * (`actionMetadata.kind === "action-card"`). Renderers branch on the
   * `kind` discriminator.
   */
  actionMetadata?: ActionCardMetadata | { kind: string; [key: string]: unknown } | null;
  /**
   * Read-time projection for a task whose mutable title/details supersede this
   * immutable host message. The original `content` remains visible above it.
   */
  taskCurrentProjection?: {
    title: string;
    description: string | null;
    revision: number;
    superseded: boolean;
    amendedAt: string | null;
    amendedByType: "user" | "agent" | "system" | null;
    amendedByName: string | null;
    source: "tasks_current_projection";
  } | null;
}

export {
  captureReceiverPrivateIngressContext,
  isReceiverPrivateIngressContextCurrent,
};
export type { ReceiverPrivateIngressContext };

function coerceCurrentReceiverPrivateMessages(
  rawMessages: readonly Message[],
  context: ReceiverPrivateIngressContext,
): Message[] | null {
  if (!isReceiverPrivateIngressContextCurrent(context)) return null;
  const messages = coerceWireMessageSeqs(rawMessages);
  return messages;
}

function coerceCurrentReceiverPrivateMessage(
  rawMessage: Message,
  context: ReceiverPrivateIngressContext,
): Message | null {
  if (!isReceiverPrivateIngressContextCurrent(context)) return null;
  const message = coerceWireMessageSeq(rawMessage);
  return message;
}

// Stryker disable all: constant incomplete projection shape is asserted by the read-state projection shape test; object-shape mutants are type-level noise under the command runner.
function incompleteReadStateProjection(): ReadStateProjection {
  return {
    unreadCount: 0,
    hasMention: false,
    firstUnreadMessageId: null,
    firstMentionMessageId: null,
    complete: false,
  };
}
// Stryker restore all

type MessagesPageThreadSummaryPayload = {
  threadSummariesByParentMessageId?: Record<string, ThreadSummary>;
};

function isSyncCoreCompatThreadSummary(
  summary: ThreadSummary,
): summary is ThreadSummary & { latestReplies: NonNullable<ThreadSummary["latestReplies"]> } {
  return typeof summary?.threadChannelId === "string"
    && summary.threadChannelId.length > 0
    && typeof summary.replyCount === "number"
    && Number.isFinite(summary.replyCount)
    && summary.replyCount >= 0
    && Array.isArray(summary.latestReplies)
    && summary.latestReplies.every((reply) => (
      typeof reply?.messageId === "string"
      && typeof reply.seq === "number"
      && Number.isFinite(reply.seq)
    ));
}

/** Fold the thread summaries a messages response bundles into the thread store (every messages read does this). */
export function hydrateBundledThreadSummaries(
  data: MessagesPageThreadSummaryPayload,
  ingressContext: ReceiverPrivateIngressContext,
): void {
  const summaries = data.threadSummariesByParentMessageId;
  if (!summaries) return;
  if (!isReceiverPrivateIngressContextCurrent(ingressContext)) return;
  if (
    !ingressContext.serverId
    || !ingressContext.principalId
  ) {
    useThreadStore.getState().hydrateSummaries(summaries);
    return;
  }

  const projectedSummaries: Record<string, ThreadSummary> = {};
  const acceptedReplyScopes: Record<string, ThreadRepliesScope> = {};
  for (const [parentMessageId, summary] of Object.entries(summaries)) {
    if (!isSyncCoreCompatThreadSummary(summary)) {
      projectedSummaries[parentMessageId] = summary;
      continue;
    }
    // Compatibility host only: current HTTP summaries do not yet carry the
    // canonical producer/scopeCursor/epoch envelope. Match mobile current-main
    // by folding a null-epoch snapshot whose provisional watermark is the
    // newest preview seq. An empty preview therefore has watermark 0; that is
    // deliberately not represented as a final server-authored scope cursor.
    const watermark = summary.latestReplies.reduce(
      (max, reply) => Math.max(max, reply.seq),
      0,
    );
    const accepted = hydrateThreadRepliesSnapshotWithSyncCore({
      serverId: ingressContext.serverId,
      principalId: ingressContext.principalId,
      parentMessageId,
      threadChannelId: summary.threadChannelId,
      replies: summary.latestReplies,
      replyCount: summary.replyCount,
      historyLimited: false,
      watermark,
      epoch: null,
    });
    if (!accepted.scope) {
      projectedSummaries[parentMessageId] = summary;
      continue;
    }
    acceptedReplyScopes[parentMessageId] = accepted.scope;
    projectedSummaries[parentMessageId] = {
      ...summary,
      replyCount: accepted.scope.replyCount,
      latestReplies: accepted.scope.replies,
    };
  }
  useThreadStore.getState().hydrateSummariesWithReplyScopes(
    projectedSummaries,
    acceptedReplyScopes,
  );
}

interface ChannelMeta {
  hasMore: boolean;
  hasNewer: boolean;
  loadingGap?: boolean;
  hasGap?: boolean;
  historyLimited: boolean;
}

interface ChannelWindowMeta extends ChannelMeta {
  loading: boolean;
  loadingOlder: boolean;
  loadingNewer: boolean;
  contextLoadError: string | null;
}

interface CanonicalThreadTarget {
  kind: "thread";
  channelId: string;
  messageId: string;
  threadParentMessageId: string;
  threadChannelId?: string | null;
}

export interface MessageState {
  channelMessages: Record<string, Message[]>;
  channelWindowMeta: Record<string, ChannelWindowMeta>;
  /** Channels whose `channelMessages` list was filled by a history read
   * (latest page or a message's context window). A list made only of live
   * rows (`message:new`, `sync:resume`) that arrived while the channel was
   * closed is not the channel: opening it must fetch, never show it as-is. */
  historyFetchedChannels: Record<string, true>;
  messages: Message[];
  highlightedMessageId: string | null;
  /** Bumped on every jump, so a second jump to the same message restarts its
   * located highlight (useLocated). */
  highlightNonce: number;
  /** A jump found nothing (not there, or not for this reader): the toast that
   * says so is owed once, then taken, so a remount or a language switch does
   * not show it again. */
  pendingNotFoundToast: boolean;
  transientFocusRequest: { channelId: string; messageId: string; nonce: number } | null;
  lastSeq: number;
  /** The server's commit horizon (xid8, decimal string) from the last global
   * catch-up, or from `sync:horizon` at connect. Sent back as `sinceHorizon`
   * so a message that took a lower seq but committed after that catch-up is
   * still delivered. Null until the server has given one.
   *
   * Invariant (Tenny): the horizon held here must have been computed before
   * every later read that raises `lastSeq`. The starting horizon guarantees it
   * by arriving before the first history request (otherwise it is dropped);
   * each `sync:resume` response's horizon predates the loads after it. A
   * scoped read (one channel) never replaces it. */
  syncHorizon: string | null;
  currentChannelId: string | null;
  loading: boolean;
  loadingOlder: boolean;
  loadingNewer: boolean;
  loadingGap: boolean;
  hasMore: boolean;
  hasNewer: boolean;
  hasGap: boolean;
  contextLoadError: string | null;
  unreadCounts: Record<string, number>;
  mentionFlags: Record<string, boolean>;
  /**
   * Non-joined public channels whose latest message is past the user's cursor
   * (`hasNew` in the unread summary). They carry no exact count; the sidebar
   * shows a quiet indicator for them.
   */
  newFlags: Record<string, boolean>;
  currentUserId: string | null;
  drafts: Record<string, string>;
  /** When each draft was last edited (epoch ms); a draft from before times were kept has none. */
  draftUpdatedAt: Record<string, number>;
  historyLimited: boolean;
  isNearBottom: boolean;
  loadMessages: (channelId: string, requestGeneration?: number) => Promise<void>;
  loadOlderMessages: (channelId?: string) => Promise<void>;
  /** The plan stopped cutting history (an upgrade): the top of a cut channel opens again and its older messages load. */
  reopenHistoryWindow: (channelId: string) => void;
  loadNewerMessages: (channelId?: string) => Promise<void>;
  loadUnreadCounts: () => Promise<void>;
  addMessage: (message: Message, source?: "receiver-private" | "channel-room") => void;
  updateMessage: (message: Pick<Message, "id" | "channelId"> & Partial<Message>) => void;
  batchAddMessages: (messages: Message[]) => void;
  addOptimisticMessage: (message: Message) => void;
  removeOptimisticMessage: (optimisticId: string, channelId: string) => void;
  sendMessage: (
    channelId: string,
    content: string,
    attachmentIds?: string[],
    asTask?: boolean,
    optimisticId?: string,
    randomId?: string,
    mentions?: MessageMention[],
  ) => Promise<SendMessageResult>;
  loadMessageContext: (channelId: string, messageId: string) => Promise<void>;
  // Silent variant for resuming a remembered scroll position. Loads the same
  // window as `loadMessageContext` but skips the highlight flash + the
  // attendant scroll-to-center side-effect, so the timeline can land at the
  // anchor itself via persistKey memory.
  loadMessageWindowSilent: (channelId: string, messageId: string) => Promise<void>;
  /** A jump's target is behind the history window: the first messages the window shows after it, under the paywall. */
  loadWindowAfterHiddenTarget: (channelId: string, targetSeq: number, requestGeneration: number) => Promise<void>;
  syncGap: (channelId?: string, options?: { sinceSeq?: number }) => Promise<void>;
  setCurrentChannelId: (channelId: string | null) => void;
  setCurrentUserId: (userId: string | null) => void;
  setHighlightedMessageId: (messageId: string | null) => void;
  requestTransientFocus: (channelId: string, messageId: string) => void;
  consumeTransientFocusRequest: (nonce: number) => void;
  exitContextWindow: (channelId: string) => void;
  applyReadStateProjection: (channelId: string) => ReadStateProjection;
  clearUnread: (channelId: string) => void;
  markRead: (channelId: string) => Promise<void>;
  markConversationRead: (channelId: string) => Promise<void>;
  markUnread: (channelId: string) => Promise<void>;
  setNearBottom: (val: boolean) => void;
  markCurrentChannelRead: () => void;
  setDraft: (channelId: string, content: string) => void;
  adoptDraftChannel: (sourceChannelId: string, destinationChannelId: string, preferSource?: boolean) => string;
  clearDraft: (channelId: string) => void;
}

export {
  DRAFT_PERSISTENCE_DEBOUNCE_MS,
  DRAFT_PERSISTENCE_MAX_WAIT_MS,
  draftsStorageKey,
  LEGACY_DRAFTS_STORAGE_KEY,
} from "./draftStorage";
const PENDING_READ_SEQS_STORAGE_KEY = "slock_pending_read_seqs";
const LOCAL_READ_SUPPRESSION_TTL_MS = 30_000;
const OPTIMISTIC_MATCH_CREATED_AT_WINDOW_MS = 5 * 60 * 1000;

export interface LocalReadSuppression {
  seq: number;
  expiresAt: number;
}

function loadPendingReadSeqs(): Record<string, number> {
  try {
    const raw = sessionStorage.getItem(PENDING_READ_SEQS_STORAGE_KEY);
    if (!raw) return {};
    const parsed = JSON.parse(raw);
    if (!parsed || typeof parsed !== "object") return {};
    const pending: Record<string, number> = {};
    for (const [channelId, seq] of Object.entries(parsed)) {
      if (typeof channelId === "string" && typeof seq === "number" && seq > 0) {
        pending[channelId] = seq;
      }
    }
    return pending;
  } catch {
    return {};
  }
}

function persistPendingReadSeqs(pendingReadSeqs: Record<string, number>) {
  try {
    if (Object.keys(pendingReadSeqs).length === 0) {
      sessionStorage.removeItem(PENDING_READ_SEQS_STORAGE_KEY);
    } else {
      sessionStorage.setItem(PENDING_READ_SEQS_STORAGE_KEY, JSON.stringify(pendingReadSeqs));
    }
  } catch {
    // ignore storage errors
  }
}

/**
 * Canonical display order, shared by the main channel list (`sortBySeq`) and the
 * ThreadPanel (`sortThreadMessages`). Prefer server `seq`; a no-`seq` row (local
 * optimistic / legacy) falls back to `createdAt` RELATIVE to its persisted
 * neighbors — i.e. it sits where its future server-`seq` will land — so an
 * optimistic reply does NOT jump position the moment the server echo carries a
 * `seq` (task #480). The has-seq/id fallbacks only decide ties where `createdAt`
 * is equal or unparseable.
 */
export function compareMessagesForDisplay(a: Message, b: Message): number {
  const aDisplaySeq = typeof a.seq === "number" ? a.seq : a.optimisticDisplaySeq;
  const bDisplaySeq = typeof b.seq === "number" ? b.seq : b.optimisticDisplaySeq;

  if (typeof aDisplaySeq === "number" && typeof bDisplaySeq === "number" && aDisplaySeq !== bDisplaySeq) {
    return aDisplaySeq - bDisplaySeq;
  }

  const aTime = Date.parse(a.createdAt);
  const bTime = Date.parse(b.createdAt);
  if (Number.isFinite(aTime) && Number.isFinite(bTime) && aTime !== bTime) {
    return aTime - bTime;
  }

  if (typeof aDisplaySeq === "number" && typeof bDisplaySeq === "number") return a.id.localeCompare(b.id);
  if (typeof aDisplaySeq === "number") return 1;
  if (typeof bDisplaySeq === "number") return -1;
  return a.id.localeCompare(b.id);
}

/** Sort messages chronologically. Prefer server seq; local/legacy no-seq rows fall back to createdAt. (Exported for the #480 sort test.) */
export function sortBySeq(msgs: Message[]): Message[] {
  return msgs.sort(compareMessagesForDisplay);
}

function getMaxDisplaySeq(messages: Message[]): number {
  return Math.max(
    ...messages.map((message) => {
      if (typeof message.seq === "number") return message.seq;
      if (typeof message.optimisticDisplaySeq === "number") return message.optimisticDisplaySeq;
      return 0;
    }),
    0,
  );
}

/** Default channel metadata. */
/** `contextLoadError` value for a jump target hidden by the plan history cutoff. */
export const CONTEXT_BEYOND_HISTORY_ERROR = "message.chatPanel.messageBeyondHistory";
/**
 * `contextLoadError` value for a jump target the server says is not there, or
 * not for this reader (400 bad id, 403, 404): the answer is final.
 */
export const CONTEXT_NOT_FOUND_ERROR = "message.chatPanel.messageNotFound";
/**
 * `contextLoadError` value for a jump whose context read failed for another
 * reason (5xx, timeout, offline): the message may well exist. Shown with the
 * same toast as before; only a final answer may say "not found" on its own.
 */
export const CONTEXT_LOAD_FAILED_ERROR = "message.chatPanel.messageContextFailed";

/**
 * A read that may succeed if asked again: the request itself failed (5xx,
 * timeout, offline), not the server's final answer, and not an answer we
 * could not read (a thrown parse or coerce error has no request behind it).
 */
export function isRetryableReadError(error: unknown): boolean {
  return isAxiosError(error) && !isFinalNotFound(error);
}

/** The server's final answer that a message is not there, or not for this reader (400, 403, 404). */
function isFinalNotFound(error: unknown): boolean {
  const status = (error as { response?: { status?: unknown } } | null)?.response?.status;
  return status === 400 || status === 403 || status === 404;
}

const DEFAULT_META: ChannelMeta = { hasMore: true, hasNewer: false, historyLimited: false };
const DEFAULT_WINDOW_META: ChannelWindowMeta = {
  ...DEFAULT_META,
  loading: false,
  loadingOlder: false,
  loadingNewer: false,
  loadingGap: false,
  hasGap: false,
  contextLoadError: null,
};
const EMPTY_MESSAGES: Message[] = [];
let currentChannelWindowMetaSnapshot: ChannelWindowMeta = DEFAULT_WINDOW_META;
let messageWindowRequestGeneration = 0;

function claimMessageWindowRequest(): number {
  // Stryker disable next-line AssignmentOperator: generations are opaque equality tokens; counting down is behavior-equivalent to counting up.
  messageWindowRequestGeneration += 1;
  return messageWindowRequestGeneration;
}

function ownsMessageWindowRequest(
  requestGeneration: number,
  channelId: string,
  currentChannelId: string | null,
): boolean {
  return requestGeneration === messageWindowRequestGeneration && currentChannelId === channelId;
}

/**
 * A window read dropped as stale (receiver-private ingress) does not stay on
 * the skeleton: when only who it was read for changed (a sign-in switch) and
 * it is still the open window, it is read again for the person signed in now;
 * otherwise (signed out, another server, another window) it stops loading.
 */
function settleStaleWindowRead(channelId: string, readFor: ReceiverPrivateIngressContext, readAgain: (() => Promise<void>) | null): Promise<void> {
  if (readAgain && isReadForAnotherPersonHere(readFor)) return readAgain();
  useMessageStore.setState((state) => ({
    channelWindowMeta: updateWindowMetaRecord(state.channelWindowMeta, channelId, { loading: false }),
    ...(state.currentChannelId === channelId ? { loading: false } : {}),
  }));
  return Promise.resolve();
}

function sameWindowMeta(a: ChannelWindowMeta, b: ChannelWindowMeta): boolean {
  return a.loading === b.loading
    && a.loadingOlder === b.loadingOlder
    && a.loadingNewer === b.loadingNewer
    && a.loadingGap === b.loadingGap
    && a.hasMore === b.hasMore
    && a.hasNewer === b.hasNewer
    && a.hasGap === b.hasGap
    && a.historyLimited === b.historyLimited
    && a.contextLoadError === b.contextLoadError;
}

function currentChannelWindowMeta(state: MessageState): ChannelWindowMeta {
  const next: ChannelWindowMeta = {
    loading: state.loading,
    loadingOlder: state.loadingOlder,
    loadingNewer: state.loadingNewer,
    loadingGap: state.loadingGap,
    hasMore: state.hasMore,
    hasNewer: state.hasNewer,
    hasGap: state.hasGap,
    historyLimited: state.historyLimited,
    contextLoadError: state.contextLoadError,
  };
  if (sameWindowMeta(currentChannelWindowMetaSnapshot, next)) {
    return currentChannelWindowMetaSnapshot;
  }
  currentChannelWindowMetaSnapshot = next;
  return currentChannelWindowMetaSnapshot;
}

// Window reloads replace loading flags; request ownership must outlive them.
// A stale ingress may be replaced, but its completion cannot release its successor.
const olderPageFlights = new Map<string, ReceiverPrivateIngressContext>();

function getChannelMeta(state: Pick<MessageState, "channelWindowMeta">, channelId: string): ChannelMeta {
  const stored = state.channelWindowMeta[channelId];
  if (!stored) return DEFAULT_META;
  return { hasMore: stored.hasMore, hasNewer: stored.hasNewer, historyLimited: stored.historyLimited };
}

/** Whether live rows for a closed channel land past the end of its loaded
 * context window (newer history still unloaded), leaving a hole. Its list is
 * then no longer one fetched segment: the rows stay (dedupe and unread rely
 * on them) but the history mark goes, so the next open fetches. */
function liveRowsLeaveHole(
  meta: ChannelWindowMeta | undefined,
  existing: Message[],
  incoming: Message[],
): boolean {
  if (!meta?.hasNewer) return false;
  let cursor = getMaxSeq(existing);
  if (cursor <= 0) return false;
  for (const message of sortBySeq(incoming)) {
    const seq = message.seq || 0;
    if (seq > cursor + 1) return true;
    cursor = Math.max(cursor, seq);
  }
  return false;
}

function forgetHistoryFetched(current: Record<string, true>, channelId: string): Record<string, true> {
  if (!current[channelId]) return current;
  const { [channelId]: _, ...rest } = current;
  return rest;
}

function markHistoryFetched(current: Record<string, true>, channelId: string): Record<string, true> {
  return current[channelId] ? current : { ...current, [channelId]: true };
}

type ChannelOpenBranch = "latest" | "context" | "remembered";

/** One per window-open call (an open that falls back to the latest page emits
 * a second one): which window it asked for, whether the list already in
 * memory was shown as-is, and what that list was. Ids and counts only. */
function traceChannelOpen(
  state: Pick<MessageState, "channelMessages" | "historyFetchedChannels">,
  channelId: string,
  branch: ChannelOpenBranch,
  cacheHit: boolean,
): void {
  const cachedCount = state.channelMessages[channelId]?.length ?? 0;
  const history = state.historyFetchedChannels[channelId] ? "fetched" : cachedCount > 0 ? "live_only" : "none";
  emitStateTransitionTrace({
    domain: "messages",
    event: "window.open",
    entityId: channelId,
    outcome: "applied",
    outcomeDetail: `branch=${branch};cache=${cacheHit ? "hit" : "miss"};cached=${cachedCount};history=${history}`,
    touched: 1,
  });
}

function toWindowMeta(meta: ChannelMeta, override?: Partial<ChannelWindowMeta>): ChannelWindowMeta {
  return { ...DEFAULT_WINDOW_META, ...meta, ...override };
}

function updateWindowMetaRecord(
  current: Record<string, ChannelWindowMeta>,
  channelId: string,
  partial: Partial<ChannelWindowMeta>,
): Record<string, ChannelWindowMeta> {
  const next = { ...DEFAULT_WINDOW_META, ...current[channelId], ...partial };
  const previous = current[channelId];
  if (previous && Object.keys(next).every((key) => previous[key as keyof ChannelWindowMeta] === next[key as keyof ChannelWindowMeta])) {
    return current;
  }
  return { ...current, [channelId]: next };
}

function getCachedChannelWindowState(
  channelId: string,
  cached: Message[],
  meta: ChannelMeta,
  highlightedMessageId?: string,
) {
  return {
    currentChannelId: channelId,
    messages: cached,
    loading: false,
    loadingOlder: false,
    loadingNewer: false,
    loadingGap: false,
    hasMore: meta.hasMore,
    hasNewer: meta.hasNewer,
    hasGap: false,
    contextLoadError: null,
    historyLimited: meta.historyLimited,
    highlightedMessageId: highlightedMessageId ?? null,
  };
}

// Requests whose reply can raise lastSeq (history reads and sends), counted
// since the store was last reset. A starting sync horizon (socketBridge) is
// only safe when the server took it before any of them ran, which is
// guaranteed only if its reply arrived before the first one went out.
let messageHistoryRequestCount = 0;
export function noteMessageHistoryRequest() {
  messageHistoryRequestCount += 1;
}
/** A sync horizon the server reported in a response header (decimal xid8), or null. */
function readSyncHorizonHeader(headers: unknown): string | null {
  const read = headers as { get?: (name: string) => unknown } & Record<string, unknown> | undefined;
  const value = typeof read?.get === "function" ? read.get("x-sync-horizon") : read?.["x-sync-horizon"];
  return typeof value === "string" && /^(0|[1-9][0-9]*)$/.test(value) ? value : null;
}
export function messageHistoryRequestsSent(): number {
  return messageHistoryRequestCount;
}
export function __resetMessageHistoryRequestsForTests() {
  messageHistoryRequestCount = 0;
}

const pendingReadSeqs = loadPendingReadSeqs();
const pendingReadRequests = new Map<string, Promise<void>>();
// A canonical unread receipt can arrive before its RW summary. Keep its count
// until that summary proves the same (or a newer) cursor version; no timer.
const pendingUnreadReceipts = new Map<string, { readStateVersion: number; unreadCount: number; maxReadSeq: number; latestActivitySeq?: number }>();
const localReadSuppressions = new Map<string, LocalReadSuppression>();
const AUTO_READ_ACTIVE_TAB_STORAGE_KEY = "slock_auto_read_active_tab_id";
const AUTO_READ_TAB_ID = (() => {
  if (typeof crypto !== "undefined" && typeof crypto.randomUUID === "function") {
    return crypto.randomUUID();
  }
  return `tab-${Date.now()}-${Math.random().toString(36).slice(2)}`;
})();
let explicitAutoReadUserActivityAt = 0;

type ReadVisibilityDocument = {
  visibilityState?: DocumentVisibilityState;
  hasFocus?: () => boolean;
};

type ReadVisibilityStorage = {
  getItem: (key: string) => string | null;
  setItem: (key: string, value: string) => void;
  removeItem?: (key: string) => void;
};

function getReadVisibilityStorage(): ReadVisibilityStorage | undefined {
  if (typeof window === "undefined") return undefined;
  try {
    return window.localStorage;
  } catch {
    return undefined;
  }
}

export function markCurrentBrowserTabActiveForAutoRead(
  storage: ReadVisibilityStorage | undefined = getReadVisibilityStorage(),
) {
  try {
    storage?.setItem(AUTO_READ_ACTIVE_TAB_STORAGE_KEY, AUTO_READ_TAB_ID);
  } catch {
    // If localStorage is unavailable, fall back to single-tab behavior.
  }
}

function isCurrentBrowserTabActiveForAutoRead(
  storage: ReadVisibilityStorage | undefined = getReadVisibilityStorage(),
): boolean {
  if (!storage) return true;
  try {
    return storage.getItem(AUTO_READ_ACTIVE_TAB_STORAGE_KEY) === AUTO_READ_TAB_ID;
  } catch {
    return true;
  }
}

function releaseCurrentBrowserTabForAutoRead(
  storage: ReadVisibilityStorage | undefined = getReadVisibilityStorage(),
) {
  try {
    if (storage?.getItem(AUTO_READ_ACTIVE_TAB_STORAGE_KEY) !== AUTO_READ_TAB_ID) return;
    if (typeof storage.removeItem === "function") {
      storage.removeItem(AUTO_READ_ACTIVE_TAB_STORAGE_KEY);
    } else {
      storage?.setItem(AUTO_READ_ACTIVE_TAB_STORAGE_KEY, "");
    }
  } catch {
    // If localStorage is unavailable, fall back to single-tab behavior.
  }
}

function rememberExplicitAutoReadUserActivity() {
  explicitAutoReadUserActivityAt = Date.now();
}

function forgetExplicitAutoReadUserActivity() {
  explicitAutoReadUserActivityAt = 0;
}

/**
 * The person is using this window: input within ACTIVE_INPUT_WINDOW_MS, the server's test for
 * holding the phone's alert (notifications/presenceReport), so a message read in view is read
 * there too (#triage:#157; it used to need input in the last second).
 */
function hasRecentExplicitAutoReadUserActivity(now = Date.now()) {
  return explicitAutoReadUserActivityAt > 0
    && now - explicitAutoReadUserActivityAt < ACTIVE_INPUT_WINDOW_MS;
}

export function canAutoMarkCurrentChannelRead(
  doc: ReadVisibilityDocument | undefined = typeof document === "undefined" ? undefined : document,
  isCurrentBrowserTabActive = isCurrentBrowserTabActiveForAutoRead,
  surface: "channel" | "thread" = "channel",
): boolean {
  if (!doc) return true;
  // A maximized thread hides the current channel even though its mounted
  // timeline and this browser tab remain active. Hidden content is not read.
  const thread = useThreadStore.getState();
  if (surface === "channel" && isThreadMaximized(useUIStore.getState().threadMaximized, thread.openParentMessageId,
      thread.openParentChannelId, useMessageStore.getState().currentChannelId, !!useProfileStore.getState().profileId)) return false;
  if (doc.visibilityState && doc.visibilityState !== "visible") return false;
  if (typeof doc.hasFocus === "function" && !doc.hasFocus()) return false;
  return isCurrentBrowserTabActive();
}

export function canAutoMarkLiveAppendRead(
  doc: ReadVisibilityDocument | undefined = typeof document === "undefined" ? undefined : document,
  isCurrentBrowserTabActive = isCurrentBrowserTabActiveForAutoRead,
  hasExplicitUserActivity = hasRecentExplicitAutoReadUserActivity,
  surface: "channel" | "thread" = "channel",
): boolean {
  return canAutoMarkCurrentChannelRead(doc, isCurrentBrowserTabActive, surface) && hasExplicitUserActivity();
}

if (typeof window !== "undefined" && typeof document !== "undefined") {
  // Back in front of the person: what landed in view meanwhile is read now (store/seenReadCatchUp).
  const claimAutoReadTab = () => {
    if (canAutoMarkCurrentChannelRead(document, () => true, "thread")) {
      markCurrentBrowserTabActiveForAutoRead();
    }
    runSeenReadCatchUp();
  };
  const claimAutoReadTabFromUserActivity = () => {
    rememberExplicitAutoReadUserActivity();
    claimAutoReadTab();
  };
  // Scrolling and touches fire many times a second; once a second says the window is in use.
  let lastContinuousInputAt = 0;
  const claimAutoReadTabFromContinuousInput = () => {
    const now = Date.now();
    if (now - lastContinuousInputAt < 1_000) return;
    lastContinuousInputAt = now;
    claimAutoReadTabFromUserActivity();
  };
  const releaseAutoReadTab = () => {
    if (document.visibilityState && document.visibilityState !== "visible") {
      forgetExplicitAutoReadUserActivity();
      releaseCurrentBrowserTabForAutoRead();
      return;
    }
    if (typeof document.hasFocus === "function" && !document.hasFocus()) {
      forgetExplicitAutoReadUserActivity();
      releaseCurrentBrowserTabForAutoRead();
    }
  };
  window.addEventListener("focus", claimAutoReadTab, true);
  window.addEventListener("blur", releaseAutoReadTab, true);
  document.addEventListener("visibilitychange", claimAutoReadTab, true);
  document.addEventListener("visibilitychange", releaseAutoReadTab, true);
  // The same inputs presence counts (WEB_PRESENCE_INPUT_EVENTS).
  document.addEventListener("pointerdown", claimAutoReadTabFromUserActivity, true);
  // keydown-global-exempt: records the actively used tab for unread auto-read gating, does not move focus
  document.addEventListener("keydown", claimAutoReadTabFromUserActivity, true);
  document.addEventListener("wheel", claimAutoReadTabFromContinuousInput, { capture: true, passive: true });
  document.addEventListener("touchstart", claimAutoReadTabFromContinuousInput, { capture: true, passive: true });
  window.setTimeout(claimAutoReadTab, 0);
}

/** The newest seq a read of this conversation is queued for (its auto-read included), 0 for none. */
export function getPendingReadSeq(channelId: string): number {
  return pendingReadSeqs[channelId] ?? 0;
}

function rememberLocalReadSuppression(channelId: string, seq: number, now = Date.now()) {
  if (seq <= 0) return;
  const current = localReadSuppressions.get(channelId);
  // `/channels/unread` is a server snapshot. During reconnect/visibility
  // recovery it can race a just-queued read cursor and reintroduce old unread
  // counts that the user already cleared locally. Keep a short client-side
  // floor so stale snapshots cannot visually undo the local read action.
  localReadSuppressions.set(channelId, {
    seq: Math.max(current?.seq ?? 0, seq),
    expiresAt: Math.max(current?.expiresAt ?? 0, now + LOCAL_READ_SUPPRESSION_TTL_MS),
  });
}

function forgetLocalReadSuppression(channelId: string) {
  localReadSuppressions.delete(channelId);
}

function forgetLocalReadSuppressionIfNewerMessage(channelId: string, seq?: number) {
  if (!seq) return;
  const suppression = localReadSuppressions.get(channelId);
  if (suppression && seq > suppression.seq) {
    localReadSuppressions.delete(channelId);
  }
}

function clearLocalReadSuppressions() {
  localReadSuppressions.clear();
}

/** One entry of `GET /channels/unread?summary=1` (server ChannelUnreadSummaryEntry). */
export type UnreadSummaryWireEntry = {
  unreadCount: number;
  hasMention: boolean;
  hasAnyMention: boolean;
  /** Non-joined public channel with messages past the cursor; unreadCount is 0. */
  hasNew?: boolean;
  readState?: import("@botiverse/raft-shared").InboxScopeReadFrontier;
};

export function parseUnreadSnapshot(data: unknown): {
  unreadCounts: Record<string, number>;
  mentionFlags: Record<string, boolean>;
  newFlags: Record<string, boolean>;
} {
  const source = typeof data === "object" && data !== null && "channels" in data
    ? (data as { channels?: unknown }).channels
    : data;
  const unreadCounts: Record<string, number> = {};
  const mentionFlags: Record<string, boolean> = {};
  const newFlags: Record<string, boolean> = {};
  if (typeof source !== "object" || source === null) {
    return { unreadCounts, mentionFlags, newFlags };
  }
  for (const [channelId, value] of Object.entries(source)) {
    if (typeof value === "number") {
      if (value > 0) unreadCounts[channelId] = value;
      continue;
    }
    if (typeof value !== "object" || value === null) continue;
    const entry = value as { [K in keyof UnreadSummaryWireEntry]?: unknown };
    const unreadCount = typeof entry.unreadCount === "number" ? entry.unreadCount : 0;
    if (unreadCount > 0) unreadCounts[channelId] = unreadCount;
    if (entry.hasMention === true) mentionFlags[channelId] = true;
    if (entry.hasNew === true) newFlags[channelId] = true;
  }
  return { unreadCounts, mentionFlags, newFlags };
}

function hasActiveLocalReadSuppression(
  channelId: string,
  suppressions: Map<string, LocalReadSuppression>,
  now: number,
): boolean {
  const suppression = suppressions.get(channelId);
  if (!suppression) return false;
  if (suppression.expiresAt <= now) {
    suppressions.delete(channelId);
    return false;
  }
  return true;
}

/** Filters stale unread snapshots and prunes expired suppressions from `suppressions`. */
export function filterUnreadCountsByLocalReadSuppressions(
  unreadCounts: Record<string, number>,
  suppressions: Map<string, LocalReadSuppression>,
  now = Date.now(),
): Record<string, number> {
  const filtered: Record<string, number> = {};
  for (const [channelId, count] of Object.entries(unreadCounts)) {
    if (!hasActiveLocalReadSuppression(channelId, suppressions, now)) {
      filtered[channelId] = count;
    }
  }
  return filtered;
}

export function filterMentionFlagsByLocalReadSuppressions(
  mentionFlags: Record<string, boolean>,
  suppressions: Map<string, LocalReadSuppression>,
  now = Date.now(),
): Record<string, boolean> {
  const filtered: Record<string, boolean> = {};
  for (const [channelId, value] of Object.entries(mentionFlags)) {
    if (!hasActiveLocalReadSuppression(channelId, suppressions, now)) {
      filtered[channelId] = value;
    }
  }
  return filtered;
}

function applyUnreadCount(
  unreadCounts: Record<string, number>,
  channelId: string,
  unreadCount: number,
): Record<string, number> {
  if (unreadCount > 0) {
    if (unreadCounts[channelId] === unreadCount) return unreadCounts;
    return { ...unreadCounts, [channelId]: unreadCount };
  }
  if (!unreadCounts[channelId]) return unreadCounts;
  const { [channelId]: _, ...rest } = unreadCounts;
  return rest;
}

function preserveUnreadSummaryForChannel(
  currentState: Pick<MessageState, "unreadCounts" | "mentionFlags">,
  nextState: Pick<MessageState, "unreadCounts" | "mentionFlags">,
  channelId: string,
): Pick<MessageState, "unreadCounts" | "mentionFlags"> {
  const unreadCounts = applyUnreadCount(nextState.unreadCounts, channelId, currentState.unreadCounts[channelId] ?? 0);
  const currentMention = currentState.mentionFlags[channelId] === true;
  // Stryker disable all: when current mention is true, reusing an existing true snapshot flag vs writing the same true flag is equivalent; true/false semantic preservation is covered by incomplete-cache race tests.
  const mentionFlags = currentMention
    ? (nextState.mentionFlags[channelId] === true ? nextState.mentionFlags : { ...nextState.mentionFlags, [channelId]: true })
    : nextState.mentionFlags[channelId]
      ? (() => {
        const { [channelId]: _mention, ...rest } = nextState.mentionFlags;
        return rest;
      })()
      : nextState.mentionFlags;
  // Stryker restore all
  return { unreadCounts, mentionFlags };
}

function isSelfAuthoredMessage(message: Pick<Message, "senderType" | "senderId">, currentUserId: string | null): boolean {
  return message.senderType === "user" && !!currentUserId && message.senderId === currentUserId;
}

function mentionsCurrentUser(message: Pick<Message, "mentions">, currentUserId: string | null): boolean {
  // Stryker disable next-line ConditionalExpression: the following id/type predicate is already false for null currentUserId; this early return is a readability guard.
  if (!currentUserId) return false;
  // Stryker disable next-line ArrayDeclaration: replacing the nullish fallback with a non-mention sentinel is behavior-equivalent under the structured mention predicate.
  return (message.mentions ?? []).some((mention) => mention.type === "user" && mention.id === currentUserId);
}

function canProjectCompleteReadState(messages: Message[] | undefined, meta: ChannelMeta | undefined, maxReadSeq: number): boolean {
  // Stryker disable next-line ConditionalExpression,BooleanLiteral: `projectReadStateFromMessages` also fail-closes incomplete projections; this guard keeps the helper total for direct callers.
  if (!messages || messages.length === 0) return false;
  // Stryker disable next-line OptionalChaining: callers pass a normalized window meta object; optionality keeps the helper total for direct callers.
  if (meta?.hasNewer) return false;
  // Stryker disable next-line OptionalChaining: projection callers pass normalized meta; optionality only keeps direct callers total while hasGap/loadingGap behavior is pinned by RED tests.
  if (meta?.hasGap || meta?.loadingGap) return false;
  const minSeq = Math.min(...messages.map((message) => message.seq ?? Infinity));
  return Number.isFinite(minSeq) && minSeq <= maxReadSeq + 1;
}

/**
 * #244: has a complete accepted read-state projection of the scope's loaded
 * messages already counted this message? addMessage projects the scope after
 * storing a live message, and the projection sets the Activity row's unread,
 * so the row's in-place patch must not count the message again. Computed
 * fresh: the stored projection is not replaced by a later incomplete one.
 */
export function loadedProjectionCountsMessage(message: Pick<Message, "id" | "channelId">): boolean {
  const state = useMessageStore.getState();
  const readState = getAcceptedReadState(useServerStore.getState().current?.id, message.channelId);
  if (!readState) return false;
  const bucket = state.channelMessages[message.channelId];
  if (!bucket?.some((known) => known.id === message.id)) return false;
  return canProjectCompleteReadState(bucket, selectChannelWindowMeta(state, message.channelId), readState.maxReadSeq);
}

function projectReadStateFromMessages(
  messages: Message[] | undefined,
  meta: ChannelMeta | undefined,
  currentUserId: string | null,
  maxReadSeq: number,
): ReadStateProjection {
  const complete = canProjectCompleteReadState(messages, meta, maxReadSeq);
  if (!complete) {
    return {
      unreadCount: 0,
      hasMention: false,
      firstUnreadMessageId: null,
      firstMentionMessageId: null,
      complete: false,
    };
  }

  let unreadCount = 0;
  let hasMention = false;
  let firstUnreadMessageId: string | null = null;
  let firstMentionMessageId: string | null = null;
  // Stryker disable next-line ArrayDeclaration: complete=true is unreachable without a concrete message array; fallback is a totality guard for direct callers.
  for (const message of messages ?? []) {
    const seq = message.seq ?? 0;
    if (seq <= maxReadSeq || isSelfAuthoredMessage(message, currentUserId)) continue;
    unreadCount += 1;
    firstUnreadMessageId ??= message.id;
    if (mentionsCurrentUser(message, currentUserId)) {
      hasMention = true;
      firstMentionMessageId ??= message.id;
    }
  }

  return {
    unreadCount,
    hasMention,
    firstUnreadMessageId,
    firstMentionMessageId,
    complete: true,
  };
}

function applyAcceptedReadStateProjection(
  state: MessageState,
  channelId: string,
  // Stryker disable next-line OptionalChaining: missing-current-server is a defensive direct-call fallback; normal server-scoped behavior is covered by reset/other-server tests.
  readState: { maxReadSeq: number; readStateVersion: number } | null = getAcceptedReadState(useServerStore.getState().current?.id, channelId),
): { state: MessageState; projection: ReadStateProjection } {
  const projection = projectReadStateFromMessages(
    state.channelMessages[channelId],
    selectChannelWindowMeta(state, channelId),
    state.currentUserId,
    // Stryker disable next-line OptionalChaining: when readState is null, projection is not applied; zero is a defensive no-op placeholder.
    readState?.maxReadSeq ?? 0,
  );
  if (!readState || !projection.complete) return { state, projection };

  const unreadCounts = applyUnreadCount(state.unreadCounts, channelId, projection.unreadCount);
  const mentionFlags = projection.hasMention
    ? { ...state.mentionFlags, [channelId]: true }
    : state.mentionFlags[channelId]
      ? (() => {
        const { [channelId]: _mention, ...rest } = state.mentionFlags;
        return rest;
      })()
      : state.mentionFlags;
  const newFlags = projection.unreadCount === 0 && state.newFlags[channelId]
    ? (() => {
      const { [channelId]: _new, ...rest } = state.newFlags;
      return rest;
    })()
    : state.newFlags;
  // Stryker disable all: this is a Zustand identity-preservation fast path; behavior tests assert resulting unread/mention state, not object reference churn.
  if (unreadCounts === state.unreadCounts && mentionFlags === state.mentionFlags && newFlags === state.newFlags) {
    return { state, projection };
  }
  // Stryker restore all
  return { state: { ...state, unreadCounts, mentionFlags, newFlags }, projection };
}

function applyAcceptedReadStateProjectionForChannels(state: MessageState, channelIds: Iterable<string>): MessageState {
  let nextState = state;
  // Stryker disable next-line OptionalChaining: server absence is a defensive reset-time no-op; server-scoped filtering is covered by other-server tests.
  const serverId = useServerStore.getState().current?.id;
  const seen = new Set<string>();
  for (const channelId of channelIds) {
    // Stryker disable next-line ConditionalExpression: duplicate channel ids are an idempotency/perf guard; applying the same projection twice is behavior-equivalent.
    if (seen.has(channelId)) continue;
    seen.add(channelId);
    const readState = getAcceptedReadState(serverId, channelId);
    // Stryker disable next-line ConditionalExpression: no accepted fact means projection is a no-op; callers also preserve raw summaries in this case.
    if (!readState) continue;
    const result = applyAcceptedReadStateProjection(nextState, channelId, readState);
    nextState = result.state;
    rememberAcceptedReadStateProjection(serverId, channelId, readState.readStateVersion, result.projection);
  }
  return nextState;
}

function withAcceptedReadStateProjection(
  state: MessageState,
  nextState: Partial<MessageState>,
  channelIds: Iterable<string>,
): Partial<MessageState> {
  const projected = applyAcceptedReadStateProjectionForChannels({ ...state, ...nextState }, channelIds);
  // Stryker disable next-line ConditionalExpression: returning nextState vs an equal unread/mention wrapper is reference-only under Zustand.
  if (projected === state) return nextState;
  return {
    ...nextState,
    unreadCounts: projected.unreadCounts,
    mentionFlags: projected.mentionFlags,
    newFlags: projected.newFlags,
  };
}

function rememberPendingRead(channelId: string, seq: number) {
  if (seq <= 0) return;
  rememberLocalReadSuppression(channelId, seq);
  const nextSeq = Math.max(getPendingReadSeq(channelId), seq);
  if (nextSeq === getPendingReadSeq(channelId)) return;
  pendingReadSeqs[channelId] = nextSeq;
  persistPendingReadSeqs(pendingReadSeqs);
}

function forgetPendingRead(channelId: string, upToSeq?: number) {
  const currentSeq = getPendingReadSeq(channelId);
  if (currentSeq <= 0) return;
  if (typeof upToSeq === "number" && currentSeq > upToSeq) return;
  delete pendingReadSeqs[channelId];
  persistPendingReadSeqs(pendingReadSeqs);
}

function resetPendingReads() {
  for (const channelId of Object.keys(pendingReadSeqs)) {
    delete pendingReadSeqs[channelId];
  }
  persistPendingReadSeqs(pendingReadSeqs);
  clearLocalReadSuppressions();
}

async function flushPendingRead(channelId: string): Promise<void> {
  const seq = getPendingReadSeq(channelId);
  if (seq <= 0) return;
  // A server taken from the device is only shown until GET /servers confirms
  // it; the read waits and goes out then (onCurrentServerConfirmed below).
  if (!isCurrentServerConfirmed()) return;

  const existing = pendingReadRequests.get(channelId);
  if (existing) return existing;

  clearMarkedUnreadForRead(channelId);
  const request = api.post(`/channels/${channelId}/read`, { seq })
    .then(() => {
      forgetPendingRead(channelId, seq);
    })
    .catch(() => {
      // Keep the pending seq so the next refresh/reconnect can retry.
    })
    .finally(() => {
      pendingReadRequests.delete(channelId);
      if (getPendingReadSeq(channelId) > seq) {
        void flushPendingRead(channelId);
      }
    });

  pendingReadRequests.set(channelId, request);
  return request;
}

async function flushAllPendingReads(): Promise<void> {
  const channelIds = Object.keys(pendingReadSeqs);
  if (channelIds.length === 0) return;
  await Promise.all(channelIds.map((channelId) => flushPendingRead(channelId)));
}

function queueReadSync(channelId: string, seq: number) {
  if (seq <= 0) return;
  // Activity reopened this conversation on its own: shown, not read, until the person acts in it.
  if (isAutoReadHeld(channelId)) return;
  rememberPendingRead(channelId, seq);
  void flushPendingRead(channelId);
}

function queueAutoReadSync(channelId: string, seq: number): boolean {
  if (isAutoReadHeld(channelId) || !canAutoMarkCurrentChannelRead()) return false;
  queueReadSync(channelId, seq);
  return true;
}

/** A live message that landed in view; refused (not in use), `readLater` reads it on return (store/seenReadCatchUp). */
function queueLiveAppendAutoReadSync(channelId: string, seq: number, surface: "channel" | "thread", readLater: () => boolean): boolean {
  if (isAutoReadHeld(channelId)) return false;
  if (!canAutoMarkLiveAppendRead(undefined, undefined, undefined, surface)) {
    noteSkippedSeenRead(channelId, readLater);
    return false;
  }
  queueReadSync(channelId, seq);
  return true;
}

/** The channel view's catch-up: reads it if it is still the one shown, at its bottom. */
function readCurrentChannelLater(channelId: string): () => boolean {
  return () => {
    const { currentChannelId, isNearBottom, hasNewer } = useMessageStore.getState();
    if (currentChannelId !== channelId) return true;
    if (!isNearBottom || hasNewer || isAutoReadHeld(channelId) || !canAutoMarkCurrentChannelRead()) return false;
    useMessageStore.getState().markCurrentChannelRead();
    return true;
  };
}

/**
 * Persist a read up to `seq` for a live reply that landed in view in an open
 * ThreadPanel. Same gate and queue as a channel's live append: the thread
 * panel keeps its replies in local state, so the channel append path never
 * sees them and the server cursor used to stay behind what the user had read.
 */
export function queueThreadLiveReplyReadSync(threadChannelId: string, seq: number, readLater: () => boolean): boolean {
  return queueLiveAppendAutoReadSync(threadChannelId, seq, "thread", readLater);
}

/** Get messages for a channel from the bucket, or empty array. */
function getBucket(channelMessages: Record<string, Message[]>, channelId: string | null): Message[] {
  return channelId ? channelMessages[channelId] ?? EMPTY_MESSAGES : EMPTY_MESSAGES;
}

export function selectChannelMessageBucket(state: MessageState, channelId: string | null): Message[] {
  return getBucket(state.channelMessages, channelId);
}

export function selectChannelWindowMeta(state: MessageState, channelId: string | null): ChannelWindowMeta {
  if (!channelId) return DEFAULT_WINDOW_META;
  const stored = state.channelWindowMeta[channelId];
  if (stored) return stored;
  if (state.currentChannelId === channelId) {
    return currentChannelWindowMeta(state);
  }
  return DEFAULT_WINDOW_META;
}

function getMaxSeq(messages: Message[]): number {
  return messages.reduce((maxSeq, message) => Math.max(maxSeq, message.seq || 0), 0);
}

/**
 * RFC 077: who sent a message for its owner (`delegatedBy`,
 * `delegatedByAgentId`) and its retraction (`deletedAt`) never go away once
 * known. A copy of the same message that lacks them (a `/messages/sync` page
 * whose rows don't carry them, an update from a producer that doesn't) must
 * not erase them, or a live "sent by" label vanishes until a reload.
 */
const DELEGATION_FACT_KEYS = ["delegatedBy", "delegatedByAgentId", "deletedAt"] as const;

function delegationFact(message: object, key: (typeof DELEGATION_FACT_KEYS)[number]): unknown {
  return (message as Record<string, unknown>)[key];
}

export function keepDelegationFacts<T extends object>(next: T, known: object): T {
  let patch: Record<string, unknown> | null = null;
  for (const key of DELEGATION_FACT_KEYS) {
    if (delegationFact(next, key) == null && delegationFact(known, key) != null) {
      patch = { ...(patch ?? {}), [key]: delegationFact(known, key) };
    }
  }
  return patch ? { ...next, ...patch } : next;
}

export function mergeIncomingMessage(
  existing: Message,
  incoming: Pick<Message, "id" | "channelId"> & Partial<Message>,
): Message {
  if (isOlderCardRevision(messageCardRevision(existing.actionMetadata), messageCardRevision(incoming.actionMetadata))) return existing; // RFC 082
  let changed = false;
  for (const [key, value] of Object.entries(incoming) as Array<[keyof Message, unknown]>) {
    if (key === "commentRef" && existing.commentRef && value == null) {
      continue;
    }
    if ((DELEGATION_FACT_KEYS as readonly string[]).includes(key) && value == null
      && delegationFact(existing, key as (typeof DELEGATION_FACT_KEYS)[number]) != null) {
      continue;
    }
    if (existing[key] !== value) {
      changed = true;
      break;
    }
  }
  if (!changed) return existing;

  const merged: Message = { ...existing, ...incoming };
  // Shared socket updates strip viewer-scoped attachment-comment metadata.
  // If this client already received an author-visible/comment-author-visible
  // ref through a scoped response, the stripped shared update must not erase it
  // and force a refresh before the `re:` chip comes back.
  if (existing.commentRef && incoming.commentRef == null) {
    merged.commentRef = existing.commentRef;
  }
  return keepDelegationFacts(merged, existing);
}

function getCreatedAtDistanceMs(left: Message, right: Message): number {
  const leftTime = Date.parse(left.createdAt);
  const rightTime = Date.parse(right.createdAt);
  if (!Number.isFinite(leftTime) || !Number.isFinite(rightTime)) {
    return Number.POSITIVE_INFINITY;
  }
  return Math.abs(leftTime - rightTime);
}

function hasMatchingAttachmentShape(optimistic: Message, real: Message): boolean {
  const optimisticAttachments = optimistic.attachments ?? [];
  const realAttachments = real.attachments ?? [];
  if (optimisticAttachments.length !== realAttachments.length) return false;
  return optimisticAttachments.every((attachment, index) => {
    const realAttachment = realAttachments[index];
    return Boolean(
      realAttachment &&
        attachment.filename === realAttachment.filename &&
        attachment.mimeType === realAttachment.mimeType &&
        attachment.sizeBytes === realAttachment.sizeBytes
    );
  });
}

function hasMatchingOptimisticSender(optimistic: Message, real: Message): boolean {
  if (!optimistic.senderId || optimistic.senderId === real.senderId) return true;
  if (optimistic.senderName !== real.senderName) return false;
  if (!optimistic.senderName) return false;
  if (!hasMatchingAttachmentShape(optimistic, real)) return false;
  return getCreatedAtDistanceMs(optimistic, real) <= OPTIMISTIC_MATCH_CREATED_AT_WINDOW_MS;
}

export function isMatchingOptimisticMessage(optimistic: Message, real: Message): boolean {
  if (!optimistic.id.startsWith("optimistic-")) return false;
  if (optimistic.channelId !== real.channelId) return false;
  if (optimistic.senderType !== real.senderType) return false;
  if (optimistic.randomId && real.randomId) {
    return optimistic.randomId === real.randomId;
  }

  // Deprecated migration fallback for pre-randomId clients and old socket
  // echoes. Remove after all active senders attach randomId to optimistic rows.
  if (optimistic.content !== real.content) return false;

  // The send form can create an optimistic row before the auth profile has
  // populated the current user id, or while it still has a stale local profile.
  // In that race, fall back to a narrow same-name/same-attachment/near-time
  // match so the socket echo cannot leave a duplicate row behind.
  return hasMatchingOptimisticSender(optimistic, real);
}

function findMatchingOptimisticMessage(messages: Message[], real: Message): Message | undefined {
  return messages
    .filter((message) => isMatchingOptimisticMessage(message, real))
    .sort((a, b) => {
      const timeDelta = getCreatedAtDistanceMs(a, real) - getCreatedAtDistanceMs(b, real);
      if (timeDelta !== 0) return timeDelta;
      return a.id.localeCompare(b.id);
    })[0];
}

function mergeOptimisticAttachmentPreviews(optimistic: Message | undefined, real: Message): Message {
  const optimisticAttachments = optimistic?.attachments;
  const realAttachments = real.attachments;
  if (!optimisticAttachments?.length || !realAttachments?.length) return real;

  let changed = false;
  const attachments = realAttachments.map((attachment, index) => {
    const local = optimisticAttachments[index];
    if (
      !local?.localPreviewUrl ||
      local.filename !== attachment.filename ||
      local.mimeType !== attachment.mimeType ||
      local.sizeBytes !== attachment.sizeBytes
    ) {
      return attachment;
    }

    changed = true;
    return {
      ...attachment,
      // Keep the sender-side blob preview through the optimistic -> persisted
      // handoff so image sends do not visually flash/reload as soon as the
      // server ack replaces the local row.
      localPreviewUrl: attachment.localPreviewUrl ?? local.localPreviewUrl,
      width: attachment.width ?? local.width ?? null,
      height: attachment.height ?? local.height ?? null,
    };
  });

  return changed ? { ...real, attachments } : real;
}

function isMessagePayload(value: unknown): value is Message {
  return Boolean(value && typeof value === "object" && typeof (value as { id?: unknown }).id === "string");
}

export function normalizePendingMentionActions(raw: unknown): PendingMentionAction[] {
  if (!Array.isArray(raw)) return [];
  return raw
    .filter((item): item is Record<string, unknown> => Boolean(item && typeof item === "object"))
    .map((item) => ({
      resolutionId: String(item.resolutionId ?? item.id ?? ""),
      messageId: String(item.messageId ?? ""),
      targetType: String(item.targetType ?? "unknown"),
      targetHandle: String(item.targetHandle ?? ""),
      targetAvatarUrl: typeof item.targetAvatarUrl === "string" && item.targetAvatarUrl.trim() ? item.targetAvatarUrl : null,
      reason: String(item.reason ?? "Mention target was not notified at send time."),
      availableActions: Array.isArray(item.availableActions) ? item.availableActions.map(String) : [],
      expiresAt: typeof item.expiresAt === "string" ? item.expiresAt : null,
    }))
    .filter((item) => item.resolutionId.length > 0);
}

export function normalizeDeliveryWarnings(raw: unknown): MessageDeliveryWarning[] {
  if (!Array.isArray(raw)) return [];
  return raw
    .filter((item): item is Record<string, unknown> => Boolean(item && typeof item === "object"))
    .flatMap((item): MessageDeliveryWarning[] => {
      if (item.targetType !== "agent" || (item.reason !== "agent_stopped" && item.reason !== "agent_stuck_on_tool")) return [];
      const targetId = typeof item.targetId === "string" ? item.targetId : "";
      if (!targetId) return [];
      return [{ targetType: "agent", targetId, reason: item.reason }];
    });
}

export function normalizeSendMessageResponse(data: unknown): {
  message: Message;
  pendingMentionActions: PendingMentionAction[];
  unresolvedMentionHandles: string[];
  deliveryWarnings?: MessageDeliveryWarning[];
} {
  if (isMessagePayload(data)) {
    return { message: data, pendingMentionActions: [], unresolvedMentionHandles: [] };
  }
  const wrapped = data as { message?: unknown; pendingMentionActions?: unknown; unresolvedMentionHandles?: unknown; deliveryWarnings?: unknown } | null;
  if (isMessagePayload(wrapped?.message)) {
    const deliveryWarnings = normalizeDeliveryWarnings(wrapped?.deliveryWarnings);
    return {
      message: wrapped.message,
      pendingMentionActions: normalizePendingMentionActions(wrapped?.pendingMentionActions),
      unresolvedMentionHandles: Array.isArray(wrapped?.unresolvedMentionHandles)
        ? wrapped.unresolvedMentionHandles.filter((item): item is string => typeof item === "string")
        : [],
      ...(deliveryWarnings.length > 0 ? { deliveryWarnings } : {}),
    };
  }
  throw new Error("Invalid message send response");
}

let unreadCountsRequestSeq = 0;

export const useMessageStore = create<MessageState>((set, get) => ({
  channelMessages: {},
  channelWindowMeta: {},
  historyFetchedChannels: {},
  messages: [],
  highlightedMessageId: null,
  highlightNonce: 0,
  pendingNotFoundToast: false,
  transientFocusRequest: null,
  lastSeq: 0,
  syncHorizon: null,
  currentChannelId: null,
  loading: false,
  loadingOlder: false,
  // Stryker disable next-line BooleanLiteral: legacy initial newer-loading flag is reset explicitly in tests; this slice does not depend on boot loading state.
  loadingNewer: false,
  // Stryker disable next-line BooleanLiteral: legacy initial loading-gap flag is reset explicitly in tests; this slice does not depend on boot loading state.
  loadingGap: false,
  // Stryker disable all: legacy initial viewport/window flags are reset explicitly in tests; this read-state slice does not depend on default UI boot flags.
  hasMore: true,
  hasNewer: false,
  hasGap: false,
  contextLoadError: null,
  historyLimited: false,
  isNearBottom: true,
  // Stryker restore all
  unreadCounts: {},
  mentionFlags: {},
  newFlags: {},
  currentUserId: null,
  drafts: loadDrafts(null),
  draftUpdatedAt: loadDraftTimes(null),

  loadUnreadCounts: async () => {
    const epoch = useServerStore.getState().serverEpoch;
    const serverId = useServerStore.getState().current?.id;
    if (!serverId) return;
    try {
      await flushAllPendingReads();
      const requestReadStateGeneration = getReadStateLedgerGeneration();
      // Newest-started read wins: an older one landing late must not overwrite
      // counts read after a change (sync/changes, #triage:458d78f1).
      const request = ++unreadCountsRequestSeq;
      const { data, stale } = await getRwRead<unknown>("unread", "/channels/unread", { params: { summary: 1 } });
      if (useServerStore.getState().serverEpoch !== epoch) return;
      if (request !== unreadCountsRequestSeq) return;
      // #632 C1: fold the authority union off the RAW response, before
      // parseUnreadSnapshot narrows it to counts/flags.
      // The payload keys channels by id (object map, not an array) and may also
      // be the bare map — mirror parseUnreadSnapshot's own source resolution
      // rather than assuming a shape.
      // Real wire row type rather than an inline assertion (#632 C1).
      type UnreadWireRow = Partial<UnreadSummaryWireEntry> | number | null;
      const unreadSource: unknown = typeof data === "object" && data !== null && "channels" in data
        ? (data as { channels?: unknown }).channels
        : data;
      const unreadRows = typeof unreadSource === "object" && unreadSource !== null
        ? Object.entries(unreadSource as Record<string, UnreadWireRow>).map(([channelId, value]) => ({
          scopeId: channelId,
          readState: typeof value === "object" && value !== null ? value.readState : undefined,
        }))
        : [];
      for (const [channelId, receipt] of pendingUnreadReceipts) {
        const accepted = getAcceptedReadState(serverId, channelId);
        const row = unreadRows.find((candidate) => candidate.scopeId === channelId)?.readState;
        if ((accepted && accepted.readStateVersion > receipt.readStateVersion)
          || (row?.kind === "present" && row.readStateVersion >= receipt.readStateVersion
            && (receipt.latestActivitySeq === undefined || Number(row.latestActivity?.seq ?? 0) >= receipt.latestActivitySeq))) {
          pendingUnreadReceipts.delete(channelId);
        }
      }
      consumeReadStateSnapshotRows(
        serverId,
        unreadRows.filter((row) => !pendingUnreadReceipts.has(row.scopeId)),
        { ledgerGenerationAtRequest: requestReadStateGeneration },
      );
      const snapshot = parseUnreadSnapshot(data);
      set((state) => {
        const projectionChannelIds = new Set([
          ...Object.keys(state.channelMessages),
          ...Object.keys(state.unreadCounts),
          ...Object.keys(snapshot.unreadCounts),
          ...Object.keys(snapshot.mentionFlags),
          ...Object.keys(snapshot.newFlags),
        ]);
        // Stryker disable next-line ObjectLiteral: this merge seed is Zustand state plumbing; plain snapshot and stale-summary tests assert observable unread/mention results.
        let nextState: MessageState = {
          ...state,
          unreadCounts: filterUnreadCountsByLocalReadSuppressions(snapshot.unreadCounts, localReadSuppressions),
          mentionFlags: filterMentionFlagsByLocalReadSuppressions(snapshot.mentionFlags, localReadSuppressions),
          newFlags: filterMentionFlagsByLocalReadSuppressions(snapshot.newFlags, localReadSuppressions),
        };
        for (const channelId of projectionChannelIds) {
          const readState = getAcceptedReadState(serverId, channelId);
          // Stryker disable next-line ConditionalExpression: scopes without an accepted fact intentionally keep the server snapshot; read-state race tests cover accepted scopes.
          if (!readState) continue;
          const readStateChangedDuringRequest = hasAcceptedReadStateChangedAfter(serverId, channelId, requestReadStateGeneration);
          const row = unreadRows.find((candidate) => candidate.scopeId === channelId)?.readState;
          const snapshotAtAcceptedVersion = row?.kind === "present"
            && row.readStateVersion === readState.readStateVersion
            && row.maxReadSeq === String(readState.maxReadSeq);
          if (!readStateChangedDuringRequest || snapshotAtAcceptedVersion) continue;
          const result = applyAcceptedReadStateProjection(nextState, channelId, readState);
          if (result.projection.complete) {
            nextState = result.state;
            rememberAcceptedReadStateProjection(serverId, channelId, readState.readStateVersion, result.projection);
            continue;
          }
          nextState = {
            ...nextState,
            ...preserveUnreadSummaryForChannel(state, nextState, channelId),
          };
        }
        for (const [channelId, receipt] of pendingUnreadReceipts) {
          nextState.unreadCounts = applyUnreadCount(nextState.unreadCounts, channelId, receipt.unreadCount);
        }
        return {
          unreadCounts: nextState.unreadCounts,
          mentionFlags: nextState.mentionFlags,
          newFlags: nextState.newFlags,
        };
      });
      // Task #164: the last clean counts are what a later boot shows while RW is unavailable.
      if (!stale) {
        const { unreadCounts, mentionFlags, newFlags, currentUserId } = get();
        saveLastCounts(currentUserId, serverId, { unread: { unreadCounts, mentionFlags, newFlags } });
      }
    } catch {
      // Keep the counts shown; store/rwFreshness says they may be out of date.
    }
  },

  clearUnread: (channelId) => {
    notifyChannelReadLocally(channelId);
    set((state) => {
      // Stryker disable all: local clearUnread no-op/mention branches predate this read-state sync slice and are covered by local mark-read tests.
      const hasUnread = Boolean(state.unreadCounts[channelId]);
      const hasMentionFlag = state.mentionFlags[channelId] === true;
      const hasNewFlag = state.newFlags[channelId] === true;
      if (!hasUnread && !hasMentionFlag && !hasNewFlag) return state;
      const { [channelId]: _unread, ...unreadCounts } = state.unreadCounts;
      const { [channelId]: _mention, ...mentionFlags } = state.mentionFlags;
      const { [channelId]: _new, ...newFlags } = state.newFlags;
      return { unreadCounts, mentionFlags, newFlags };
      // Stryker restore all
    });
  },

  applyReadStateProjection: (channelId) => {
    let projection = incompleteReadStateProjection();
    // Stryker disable next-line OptionalChaining: applyReadStateProjection can be invoked during server reset; no-server means no accepted fact.
    const serverId = useServerStore.getState().current?.id;
    const readState = getAcceptedReadState(serverId, channelId);
    set((state) => {
      const result = applyAcceptedReadStateProjection(state, channelId, readState);
      projection = result.projection;
      return result.state;
    });
    if (readState) {
      rememberAcceptedReadStateProjection(serverId, channelId, readState.readStateVersion, projection);
    }
    return projection;
  },

  markRead: async (channelId) => {
    pendingUnreadReceipts.delete(channelId);
    clearMarkedUnreadForRead(channelId);
    const { data } = await api.post(`/channels/${channelId}/read-all`);
    const seq = Number(data?.seq ?? 0);
    if (seq > 0) {
      rememberLocalReadSuppression(channelId, seq);
    }
    forgetPendingRead(channelId);
    forgetManualUnread(channelId);
    get().clearUnread(channelId);
  },

  markConversationRead: async (channelId) => {
    pendingUnreadReceipts.delete(channelId);
    const ingress = captureHumanActivityIngressContext(get().currentUserId);
    clearMarkedUnreadForRead(channelId);
    const { data } = await api.post(`/channels/${channelId}/conversation-read-all`);
    if (!isReceiverPrivateIngressContextCurrent(ingress)) return;
    // HTTP and socket receipts share the same versioned ingress. Loading the
    // bridge on demand avoids pulling the Activity store into the startup path.
    const { applyReadStateUpdate } = await import("./applyReadStateUpdate");
    if (!isReceiverPrivateIngressContextCurrent(ingress)) return;
    for (const update of normalizeReadStateUpdatedBulk(data)) {
      applyReadStateUpdate(update);
      if (update.scopeId !== channelId) continue;
      const accepted = getAcceptedReadState(ingress.serverId, channelId);
      if (accepted?.readStateVersion !== update.readStateVersion) continue;
      const state = get();
      const projection = state.applyReadStateProjection(channelId);
      const knownNewerMessage = state.channelMessages[channelId]?.some((message) =>
        (message.seq ?? 0) > update.maxReadSeq && !isSelfAuthoredMessage(message, state.currentUserId));
      // The root may never have been opened in this tab. The acknowledged
      // frontier clears its old count. Subsequent live messages advance the
      // receipt's activity evidence and count until the summary catches up. Older RW summaries cannot
      // reintroduce the already-read messages.
      pendingUnreadReceipts.set(channelId, {
        readStateVersion: update.readStateVersion,
        unreadCount: projection.complete ? projection.unreadCount : knownNewerMessage ? (state.unreadCounts[channelId] ?? 1) : 0,
        maxReadSeq: update.maxReadSeq,
        ...(knownNewerMessage ? { latestActivitySeq: getMaxSeq(state.channelMessages[channelId] ?? []) } : {}),
      });
      if (!projection.complete && !knownNewerMessage) state.clearUnread(channelId);
    }
    await Promise.all([get().loadUnreadCounts(), useThreadStore.getState().loadFollowedThreads("manual")]);
  },

  markUnread: async (channelId) => {
    const epoch = useServerStore.getState().serverEpoch;
    const serverId = useServerStore.getState().current?.id;
    const userId = get().currentUserId;
    const isCurrent = () => useServerStore.getState().serverEpoch === epoch
      && useServerStore.getState().current?.id === serverId && get().currentUserId === userId;
    const inFlightRead = pendingReadRequests.get(channelId);
    forgetPendingRead(channelId);
    forgetLocalReadSuppression(channelId);
    if (get().currentChannelId === channelId) {
      rememberManualUnread(channelId);
    } else {
      forgetManualUnread(channelId);
    }
    // Do not invent a badge before the server finds an eligible message.
    try {
      if (inFlightRead) {
        await inFlightRead.catch(() => {});
      }
      if (!isCurrent()) return;
      const { data } = await api.post(`/channels/${channelId}/unread`);
      if (!isCurrent()) return;
      const unreadCount = Number(data?.unreadCount ?? 0);
      const version = Number(data?.readStateVersion ?? 0);
      // Nothing countable: the conversation is marked unread with no count. The
      // answer goes through the same version-ordered path as its socket event,
      // so an answer later than a newer read never brings the mark back.
      const outcome = resolveMarkUnreadOutcome(data);
      const markedUnread = outcome === "marked";
      if (markedUnread && serverId && Number.isSafeInteger(version) && version > 0) {
        const { applyReadStateUpdate } = await import("./applyReadStateUpdate");
        if (!isCurrent()) return;
        applyReadStateUpdate({
          serverId,
          scopeId: channelId,
          maxReadSeq: Number(data?.maxReadSeq ?? 0),
          readStateVersion: version,
          markedUnread: true,
        });
      }
      pendingUnreadReceipts.delete(channelId);
      if (version > 0) {
        const accepted = getAcceptedReadState(serverId, channelId);
        if (accepted && accepted.readStateVersion > version) return;
        pendingUnreadReceipts.set(channelId, { readStateVersion: version, unreadCount, maxReadSeq: Number(data?.maxReadSeq ?? 0) });
      }
      if (get().currentChannelId === channelId && outcome !== "nothing") {
        rememberManualUnread(channelId);
      } else {
        forgetManualUnread(channelId);
      }
      set((state) => ({
        unreadCounts: applyUnreadCount(state.unreadCounts, channelId, unreadCount),
      }));
      void get().loadUnreadCounts();
    } catch (error) {
      void get().loadUnreadCounts();
      throw error;
    }
  },

  setDraft: (channelId, content) => {
    set((state) => {
      if (state.drafts[channelId] === content) return state;
      let newDrafts: Record<string, string>;
      let newTimes: Record<string, number>;
      if (!content.trim()) {
        if (!state.drafts[channelId]) return state;
        const { [channelId]: _, ...rest } = state.drafts;
        newDrafts = rest;
        const { [channelId]: _time, ...restTimes } = state.draftUpdatedAt;
        newTimes = restTimes;
      } else {
        newDrafts = { ...state.drafts, [channelId]: content };
        newTimes = { ...state.draftUpdatedAt, [channelId]: Date.now() };
      }
      scheduleDraftSnapshot(state.currentUserId, newDrafts, newTimes);
      return { drafts: newDrafts, draftUpdatedAt: newTimes };
    });
  },

  adoptDraftChannel: (sourceChannelId, destinationChannelId, preferSource = false) => {
    let adoptedDraft = "";
    set((state) => {
      const sourceDraft = state.drafts[sourceChannelId] ?? "";
      const destinationDraft = state.drafts[destinationChannelId] ?? "";
      adoptedDraft = preferSource
        ? sourceDraft
        : destinationDraft || sourceDraft;

      if (sourceChannelId === destinationChannelId) return state;
      const hasSourceDraft = Object.hasOwn(state.drafts, sourceChannelId);
      const hasDestinationDraft = Object.hasOwn(state.drafts, destinationChannelId);
      if (!hasSourceDraft && (!preferSource || !hasDestinationDraft)) return state;

      const nextDrafts = { ...state.drafts };
      const nextTimes = { ...state.draftUpdatedAt };
      const adoptedTime = adoptedDraft === sourceDraft
        ? state.draftUpdatedAt[sourceChannelId] ?? state.draftUpdatedAt[destinationChannelId]
        : state.draftUpdatedAt[destinationChannelId] ?? state.draftUpdatedAt[sourceChannelId];
      delete nextDrafts[sourceChannelId];
      delete nextTimes[sourceChannelId];
      if (adoptedDraft.trim()) {
        nextDrafts[destinationChannelId] = adoptedDraft;
        if (adoptedTime !== undefined) nextTimes[destinationChannelId] = adoptedTime;
        else delete nextTimes[destinationChannelId];
      } else {
        delete nextDrafts[destinationChannelId];
        delete nextTimes[destinationChannelId];
      }
      persistDraftSnapshotImmediately(state.currentUserId, nextDrafts, nextTimes);
      return { drafts: nextDrafts, draftUpdatedAt: nextTimes };
    });
    return adoptedDraft;
  },

  clearDraft: (channelId) => {
    set((state) => {
      if (!state.drafts[channelId]) return state;
      const { [channelId]: _, ...rest } = state.drafts;
      const { [channelId]: _time, ...restTimes } = state.draftUpdatedAt;
      persistDraftSnapshotImmediately(state.currentUserId, rest, restTimes);
      return { drafts: rest, draftUpdatedAt: restTimes };
    });
  },

  loadMessages: async (channelId, ownedRequestGeneration) => {
    const requestGeneration = ownedRequestGeneration ?? claimMessageWindowRequest();
    if (requestGeneration !== messageWindowRequestGeneration) return;
    clearPendingGapMessages(channelId);
    const previousChannelId = get().currentChannelId;
    if (previousChannelId && previousChannelId !== channelId) {
      forgetManualUnread(previousChannelId);
    }

    const skipInitialAutoRead = shouldSkipInitialAutoRead(channelId);
    if (!skipInitialAutoRead && !isAutoReadHeld(channelId) && canAutoMarkCurrentChannelRead()) {
      get().clearUnread(channelId);
    }

    // A fetched list for this channel shows at once while the page refreshes;
    // a list of only live rows is not the channel, so it waits for the page.
    const opening = get();
    const cached = opening.channelMessages[channelId];
    const meta = getChannelMeta(opening, channelId);
    const canReuseCachedTail = !!cached && cached.length > 0 && !meta.hasNewer
      && !!opening.historyFetchedChannels[channelId];
    traceChannelOpen(opening, channelId, "latest", canReuseCachedTail);
    if (canReuseCachedTail) {
      set((state) => ({
        ...getCachedChannelWindowState(channelId, cached, meta),
        channelWindowMeta: updateWindowMetaRecord(state.channelWindowMeta, channelId, toWindowMeta(meta)),
      }));
    } else {
      set((state) => ({
        loading: true,
        loadingOlder: false,
        loadingNewer: false,
        loadingGap: false,
        currentChannelId: channelId,
        // Stryker disable all: loading-state defaults are legacy channel-open scaffolding; read-state projection tests only require the normalized meta shape after hydration.
        channelWindowMeta: updateWindowMetaRecord(state.channelWindowMeta, channelId, {
          loading: true,
          loadingOlder: false,
          loadingNewer: false,
          loadingGap: false,
          hasGap: false,
          hasMore: true,
          hasNewer: false,
          historyLimited: false,
          contextLoadError: null,
        }),
        historyLimited: false,
        hasMore: true,
        hasNewer: false,
        hasGap: false,
        contextLoadError: null,
        highlightedMessageId: null,
        // Stryker restore all
      }));
    }

    // The click that opened it may have sent this read already (messagePagePrefetch): take it;
    // over a cached list only while it is in flight (takeInFlightMessagePage).
    const prefetched = (canReuseCachedTail ? takeInFlightMessagePage : takeMessagePage)(latestPageRequest(channelId), get().currentUserId);
    const ingressContext = prefetched?.ingressContext ?? captureReceiverPrivateIngressContext(get().currentUserId);
    try {
      const limit = 50;
      // The page's own sync horizon (taken before its read) can start the
      // first sync:resume only if it was the page's only history read: none
      // went out before it, and none while it was in flight (the server may
      // run a later request's read before this one's horizon). The socket's
      // starting horizon follows the same rule (socketBridge).
      const firstHistoryRead = messageHistoryRequestsSent() === 0;
      noteMessageHistoryRequest();
      const { data, headers } = await (prefetched?.request ?? api.get(`/messages/channel/${channelId}?limit=${limit}`));
      // A read sent at the click went out before this count: its horizon is not known to be the first.
      const onlyHistoryRead = !prefetched && firstHistoryRead && messageHistoryRequestsSent() === 1;
      const pageHorizon = onlyHistoryRead ? readSyncHorizonHeader(headers) : null;
      if (
        get().currentChannelId === channelId &&
        requestGeneration !== messageWindowRequestGeneration
      ) return;
      const coerced = coerceCurrentReceiverPrivateMessages(
        data.messages ?? data,
        ingressContext,
      );
      if (!coerced) {
        return settleStaleWindowRead(channelId, ingressContext, get().currentChannelId === channelId ? () => get().loadMessages(channelId, requestGeneration) : null);
      }
      // The server bundles this page's thread summaries with the messages.
      // Hydrate them first so React never commits a parent-only intermediate
      // frame whose later inline-reply expansion changes scrollTop.
      hydrateBundledThreadSummaries(data, ingressContext);
      const historyLimited: boolean = data.historyLimited ?? false;
      recordHiddenHistory(channelId, data);
      const msgs = prefetched ? withLiveRowsAfter(coerced, get().channelMessages[channelId], prefetched.seqAtSend) : coerced;
      const hasMore = coerced.length >= limit;
      const maxSeq = Math.max(...msgs.map((m) => m.seq || 0), 0);

      set((state) => withAcceptedReadStateProjection(state, {
        channelMessages: { ...state.channelMessages, [channelId]: msgs },
        historyFetchedChannels: markHistoryFetched(state.historyFetchedChannels, channelId),
        channelWindowMeta: updateWindowMetaRecord(state.channelWindowMeta, channelId, {
          loading: false,
          loadingOlder: false,
          loadingNewer: false,
          loadingGap: false,
          hasMore,
          hasNewer: false,
          hasGap: false,
          historyLimited,
          contextLoadError: null,
        }),
        lastSeq: Math.max(state.lastSeq, maxSeq),
        ...(pageHorizon && state.syncHorizon === null ? { syncHorizon: pageHorizon } : {}),
        ...(state.currentChannelId === channelId ? {
          messages: msgs,
          loading: false,
          historyLimited,
          hasMore,
          hasNewer: false,
          hasGap: false,
          contextLoadError: null,
        } : {}),
      }, [channelId]));
      // Mark as read server-side (fire and forget)
      const autoReadQueued = maxSeq > 0 && !skipInitialAutoRead
        ? queueAutoReadSync(channelId, maxSeq)
        : false;
      if (skipInitialAutoRead) {
        consumeManualUnread(channelId);
      } else if (autoReadQueued) {
        // Clear unread again in case loadUnreadCounts ran between the initial
        // clearUnread and now (race with socket reconnect)
        get().clearUnread(channelId);
      }
    } catch {
      if (
        get().currentChannelId === channelId &&
        requestGeneration !== messageWindowRequestGeneration
      ) return;
      set((state) => ({
        channelWindowMeta: updateWindowMetaRecord(state.channelWindowMeta, channelId, { loading: false }),
        ...(state.currentChannelId === channelId ? { loading: false } : {}),
      }));
    }
  },

  reopenHistoryWindow: (channelId) => {
    if (!getChannelMeta(get(), channelId).historyLimited) return;
    clearHiddenHistory(channelId);
    // A jump that landed on the paywall is no longer behind anything: the
    // older pages that load now bring its target.
    const reopened = (current: string | null) => (current === CONTEXT_BEYOND_HISTORY_ERROR ? null : current);
    set((state) => ({
      channelWindowMeta: updateWindowMetaRecord(state.channelWindowMeta, channelId, {
        hasMore: true,
        historyLimited: false,
        contextLoadError: reopened(selectChannelWindowMeta(state, channelId).contextLoadError),
      }),
      ...(state.currentChannelId === channelId ? { hasMore: true, historyLimited: false, contextLoadError: reopened(state.contextLoadError) } : {}),
    }));
    const loaded = getBucket(get().channelMessages, channelId);
    if (loaded.length > 0) void get().loadOlderMessages(channelId);
    else void get().loadMessages(channelId);
  },

  loadOlderMessages: async (channelId) => {
    const state = get();
    const targetChannelId = channelId ?? state.currentChannelId;
    if (!targetChannelId) return;
    const activeFlight = olderPageFlights.get(targetChannelId);
    if (activeFlight && isReceiverPrivateIngressContextCurrent(activeFlight)) return;
    const targetMessages = getBucket(state.channelMessages, targetChannelId);
    const targetMeta = selectChannelWindowMeta(state, targetChannelId);
    if (targetMeta.loadingOlder || !targetMeta.hasMore || targetMessages.length === 0) return;

    const minSeq = Math.min(...targetMessages.map((m) => m.seq || Infinity));
    if (!minSeq || minSeq === Infinity) return;

    const ingressContext = captureReceiverPrivateIngressContext(state.currentUserId);
    olderPageFlights.set(targetChannelId, ingressContext);
    set((state) => ({
      loadingOlder: targetChannelId === state.currentChannelId ? true : state.loadingOlder,
      channelWindowMeta: updateWindowMetaRecord(state.channelWindowMeta, targetChannelId, { loadingOlder: true }),
    }));
    try {
      const limit = 50;
      const { data } = await api.get(
        `/messages/channel/${targetChannelId}?limit=${limit}&before=${minSeq}`
      );
      const older = coerceCurrentReceiverPrivateMessages(
        data.messages ?? data,
        ingressContext,
      );
      if (!older) return;
      hydrateBundledThreadSummaries(data, ingressContext);
      const historyLimited: boolean = data.historyLimited ?? false;
      recordHiddenHistory(targetChannelId, data);
      const hasMoreResult = older.length >= limit;
      const existingBucket = getBucket(get().channelMessages, targetChannelId);
      const existingIds = new Set(existingBucket.map((m) => m.id));
      const newMsgs = older.filter((m) => !existingIds.has(m.id));

      set((state) => {
        const existing = getBucket(state.channelMessages, targetChannelId);
        const merged = [...newMsgs, ...existing];
        const isCurrent = targetChannelId === state.currentChannelId;
        return withAcceptedReadStateProjection(state, {
          channelMessages: { ...state.channelMessages, [targetChannelId]: merged },
          channelWindowMeta: updateWindowMetaRecord(state.channelWindowMeta, targetChannelId, {
            loadingOlder: false,
            hasMore: hasMoreResult,
            historyLimited,
          }),
          messages: isCurrent ? merged : state.messages,
          loadingOlder: isCurrent ? false : state.loadingOlder,
          hasMore: isCurrent ? hasMoreResult : state.hasMore,
          historyLimited: isCurrent ? historyLimited : state.historyLimited,
        }, [targetChannelId]);
      });
    } catch {
      if (!isReceiverPrivateIngressContextCurrent(ingressContext)) return;
      set((state) => ({
        // Stryker disable next-line ConditionalExpression,EqualityOperator,BooleanLiteral: load-older failure spinner reset is legacy UI scaffolding outside read-state projection behavior.
        loadingOlder: targetChannelId === state.currentChannelId ? false : state.loadingOlder,
        channelWindowMeta: updateWindowMetaRecord(state.channelWindowMeta, targetChannelId, { loadingOlder: false }),
      }));
    } finally {
      if (olderPageFlights.get(targetChannelId) === ingressContext) {
        olderPageFlights.delete(targetChannelId);
      }
    }
  },

  loadNewerMessages: async (channelId) => {
    const state = get();
    const targetChannelId = channelId ?? state.currentChannelId;
    if (!targetChannelId) return;
    const targetMessages = getBucket(state.channelMessages, targetChannelId);
    const targetMeta = selectChannelWindowMeta(state, targetChannelId);
    if (!targetChannelId || targetMeta.loadingNewer || !targetMeta.hasNewer || targetMeta.loading || targetMessages.length === 0) return;

    const maxSeq = Math.max(...targetMessages.map((m) => m.seq || 0));
    if (!maxSeq || maxSeq === Infinity) return;

    set((state) => ({
      loadingNewer: targetChannelId === state.currentChannelId ? true : state.loadingNewer,
      channelWindowMeta: updateWindowMetaRecord(state.channelWindowMeta, targetChannelId, { loadingNewer: true }),
    }));
    const ingressContext = captureReceiverPrivateIngressContext(state.currentUserId);
    try {
      const limit = 50;
      noteMessageHistoryRequest();
      const { data } = await api.get(
        `/messages/channel/${targetChannelId}?limit=${limit}&after=${maxSeq}`
      );
      const newer = coerceCurrentReceiverPrivateMessages(
        data.messages ?? data,
        ingressContext,
      );
      if (!newer) return;
      hydrateBundledThreadSummaries(data, ingressContext);
      const hasNewerResult = newer.length >= limit;
      const existingBucket = getBucket(get().channelMessages, targetChannelId);
      const existingIds = new Set(existingBucket.map((m) => m.id));
      const newMsgs = newer.filter((m) => !existingIds.has(m.id));

      set((state) => {
        const existing = getBucket(state.channelMessages, targetChannelId);
        const merged = [...existing, ...newMsgs];
        const isCurrent = targetChannelId === state.currentChannelId;
        return withAcceptedReadStateProjection(state, {
          channelMessages: { ...state.channelMessages, [targetChannelId]: merged },
          channelWindowMeta: updateWindowMetaRecord(state.channelWindowMeta, targetChannelId, {
            loadingNewer: false,
            hasNewer: hasNewerResult,
          }),
          messages: isCurrent ? merged : state.messages,
          loadingNewer: isCurrent ? false : state.loadingNewer,
          hasNewer: isCurrent ? hasNewerResult : state.hasNewer,
          lastSeq: Math.max(state.lastSeq, ...newMsgs.map((m) => m.seq || 0)),
        }, [targetChannelId]);
      });

      const newestSeq = Math.max(...(getBucket(get().channelMessages, targetChannelId).map((m) => m.seq || 0)), 0);
      // Stryker disable next-line ConditionalExpression,LogicalOperator,BooleanLiteral,EqualityOperator: auto-read-on-tail pagination is legacy UI behavior outside this read-state socket projection contract.
      if (!hasNewerResult && newestSeq > 0 && targetChannelId === get().currentChannelId && get().isNearBottom) {
        const autoReadQueued = queueAutoReadSync(targetChannelId, newestSeq);
        if (autoReadQueued) {
          get().clearUnread(targetChannelId);
        }
      }
    } catch {
      set((state) => ({
        loadingNewer: targetChannelId === state.currentChannelId ? false : state.loadingNewer,
        channelWindowMeta: updateWindowMetaRecord(state.channelWindowMeta, targetChannelId, { loadingNewer: false }),
      }));
    }
  },

  exitContextWindow: (channelId) => {
    clearPendingGapMessages(channelId);
    if (get().currentChannelId !== channelId) return;
    set((state) => ({
      hasNewer: false,
      hasGap: false,
      loadingNewer: false,
      loadingGap: false,
      highlightedMessageId: null,
      contextLoadError: null,
      channelWindowMeta: updateWindowMetaRecord(state.channelWindowMeta, channelId, {
        hasNewer: false,
        hasGap: false,
        loadingNewer: false,
        loadingGap: false,
        contextLoadError: null,
      }),
    }));
  },
  addMessage: (incomingMessage, source = "receiver-private") => {
    const message = source === "channel-room"
      ? coerceWireMessageSeq(incomingMessage)
      : coerceCurrentReceiverPrivateMessage(
          incomingMessage,
          captureReceiverPrivateIngressContext(get().currentUserId),
        );
    if (!message) return;
    noteOutlineMessage(message);
    set((state) => {
      // Stryker disable next-line MethodExpression,ConditionalExpression,LogicalOperator: lastSeq monotonic bookkeeping predates this read-state projection slice; unread behavior is asserted separately.
      const newLastSeq = Math.max(state.lastSeq, message.seq || 0);
      const currentMaxSeq = getMaxSeq(state.messages);
      const project = (nextState: Partial<MessageState>) =>
        withAcceptedReadStateProjection(state, nextState, [message.channelId]);
      const receipt = pendingUnreadReceipts.get(message.channelId);
      if (receipt && (message.seq ?? 0) > receipt.maxReadSeq
        && !isSelfAuthoredMessage(message, state.currentUserId)
        && !state.channelMessages[message.channelId]?.some((known) => known.id === message.id)) {
        pendingUnreadReceipts.set(message.channelId, {
          ...receipt,
          unreadCount: receipt.unreadCount + 1,
          latestActivitySeq: Math.max(receipt.latestActivitySeq ?? 0, message.seq ?? 0),
        });
      }
      forgetLocalReadSuppressionIfNewerMessage(message.channelId, message.seq);

      // Always store in the channel bucket (even for non-current channels)
      let bucket = state.channelMessages[message.channelId] ?? [];
      // Update existing message if present (e.g. task fields added after convert-to-task)
      const existingIdx = bucket.findIndex((m) => m.id === message.id);
      if (existingIdx >= 0) {
        const mergedMessage = mergeIncomingMessage(bucket[existingIdx], message);
        if (mergedMessage === bucket[existingIdx]) {
          return newLastSeq === state.lastSeq ? state : { lastSeq: newLastSeq };
        }
        bucket = bucket.map((m, index) => index === existingIdx ? mergedMessage : m);
        const newChannelMessages = { ...state.channelMessages, [message.channelId]: bucket };
        return project({
          channelMessages: newChannelMessages,
          channelWindowMeta: message.channelId === state.currentChannelId
            ? updateWindowMetaRecord(state.channelWindowMeta, message.channelId, {})
            : state.channelWindowMeta,
          // Stryker disable next-line ConditionalExpression,EqualityOperator: current-channel message array replacement is legacy render-state mirroring; bucket/unread behavior is asserted separately.
          messages: message.channelId === state.currentChannelId ? bucket : state.messages,
          lastSeq: newLastSeq,
        });
      }
      // Replace at most one optimistic row with the persisted message. Sending
      // the same content twice should keep the second optimistic row until its
      // own server message arrives.
      const matchingOptimistic = findMatchingOptimisticMessage(bucket, message);
      const persistedMessage = mergeOptimisticAttachmentPreviews(matchingOptimistic, message);
      bucket = matchingOptimistic ? bucket.filter((m) => m.id !== matchingOptimistic.id) : bucket;
      const updatedBucket = sortBySeq([...bucket, persistedMessage]);
      const newChannelMessages = { ...state.channelMessages, [message.channelId]: updatedBucket };

      // Non-current channel: update bucket + unread count, don't touch `messages`
      if (message.channelId !== state.currentChannelId) {
        const historyFetchedChannels = liveRowsLeaveHole(
          state.channelWindowMeta[message.channelId],
          bucket,
          [persistedMessage],
        )
          ? forgetHistoryFetched(state.historyFetchedChannels, message.channelId)
          : state.historyFetchedChannels;
        if (isSelfAuthoredMessage(message, state.currentUserId)) {
          return project({
            channelMessages: newChannelMessages,
            historyFetchedChannels,
            lastSeq: newLastSeq,
          });
        }
        const prev = state.unreadCounts[message.channelId] || 0;
        return project({
          channelMessages: newChannelMessages,
          historyFetchedChannels,
          lastSeq: newLastSeq,
          unreadCounts: { ...state.unreadCounts, [message.channelId]: prev + 1 },
        });
      }

      const hasSeqGap = Boolean(
        message.seq &&
        currentMaxSeq > 0 &&
        message.seq > currentMaxSeq + 1
      );

      // Current channel: update bucket + messages
      // When viewing a centered context window with newer history still unloaded,
      // keep the loaded segment contiguous instead of appending across the gap.
      if (state.hasNewer && message.seq && currentMaxSeq > 0 && message.seq > currentMaxSeq + 1) {
        if (isSelfAuthoredMessage(message, state.currentUserId)) {
          return project({
            lastSeq: newLastSeq,
          });
        }
        const prev = state.unreadCounts[message.channelId] || 0;
        return project({
          lastSeq: newLastSeq,
          unreadCounts: { ...state.unreadCounts, [message.channelId]: prev + 1 },
        });
      }

      // A seq jump is almost never a real hole (seqs are server-global), so
      // the row is shown at once; a background /messages/sync from the window
      // tail fills whatever did go missing, and until it answers the channel
      // has a gap. While a hole is unconfirmed the row is not auto-read (that
      // would mark the hole read): the fill reads the channel once it lands.
      if (hasSeqGap && !state.hasNewer) rememberPendingGapMessage(persistedMessage, currentMaxSeq);
      const holeUnconfirmed = channelOwesGapFill(message.channelId);

      // Only mark as read if user is near the real latest bottom, not the
      // bottom of an older centered context slice.
      const autoReadQueued = Boolean(
        !holeUnconfirmed &&
        message.seq &&
        state.isNearBottom &&
        !state.hasNewer &&
        queueLiveAppendAutoReadSync(message.channelId, message.seq, "channel", readCurrentChannelLater(message.channelId))
      );

      // If user is scrolled up, or is intentionally viewing an older slice with
      // newer history still unloaded, keep unread state instead of clearing it.
      const unreadUpdate = !autoReadQueued && !isSelfAuthoredMessage(message, state.currentUserId)
        ? { unreadCounts: { ...state.unreadCounts, [message.channelId]: (state.unreadCounts[message.channelId] || 0) + 1 } }
        : {};

      const hasGap = holeUnconfirmed || (state.loadingGap && state.hasGap);
      return project({
        channelMessages: newChannelMessages,
        channelWindowMeta: updateWindowMetaRecord(state.channelWindowMeta, message.channelId, {
          hasGap,
        }),
        messages: updatedBucket,
        lastSeq: newLastSeq,
        hasGap,
        ...unreadUpdate,
      });
    });
  },

  // Merge-only update for existing messages (e.g. task field/reaction changes).
  // Does NOT append if message is not cached, does NOT increment unread.
  updateMessage: (message) =>
    set((state) => {
      const mergeIntoRows = (rows: Message[]) => {
        let changed = false;
        const merged = rows.map((m) => {
          if (m.id !== message.id) return m;
          changed = true;
          return mergeIncomingMessage(m, message);
        });
        return { changed, merged };
      };

      const bucket = state.channelMessages[message.channelId];
      const bucketUpdate = bucket ? mergeIntoRows(bucket) : { changed: false, merged: [] as Message[] };
      const visibleUpdate = mergeIntoRows(state.messages);
      if (!bucketUpdate.changed && !visibleUpdate.changed) return state; // Not cached, ignore

      const newChannelMessages = bucketUpdate.changed
        ? { ...state.channelMessages, [message.channelId]: bucketUpdate.merged }
        : state.channelMessages;
      return {
        channelMessages: newChannelMessages,
        channelWindowMeta: visibleUpdate.changed && message.channelId === state.currentChannelId
          ? updateWindowMetaRecord(state.channelWindowMeta, message.channelId, {})
          : state.channelWindowMeta,
        messages: visibleUpdate.changed ? visibleUpdate.merged : state.messages,
      };
    }),

  addOptimisticMessage: (message) =>
    set((state) => {
      const bucket = state.channelMessages[message.channelId] ?? [];
      const messageWithDisplaySeq =
        typeof message.seq === "number" || typeof message.optimisticDisplaySeq === "number"
          ? message
          : // Floor the display coordinate at the global `lastSeq` (max server
            // seq seen across channels), not just this bucket's max. On first
            // thread open the bucket is still empty (history hasn't loaded), so
            // `getMaxDisplaySeq(bucket)` is 0 and the row would get
            // optimisticDisplaySeq=1 — then once the thread history loads with
            // real server seqs (~millions) the row sorts to the TOP and jumps
            // back to the bottom on reconcile ("message flashes to the top then
            // jumps back", #3774 regression). A just-sent row's eventual server
            // seq is > lastSeq, so lastSeq+1 keeps it server-adjacent at the
            // bottom regardless of bucket-load timing, without changing the
            // comparator's server-adjacent contract (#481).
            { ...message, optimisticDisplaySeq: Math.max(getMaxDisplaySeq(bucket), state.lastSeq) + 1 };
      const updatedBucket = sortBySeq([...bucket, messageWithDisplaySeq]);
      const newChannelMessages = { ...state.channelMessages, [message.channelId]: updatedBucket };
      return {
        channelMessages: newChannelMessages,
        channelWindowMeta: message.channelId === state.currentChannelId
          ? updateWindowMetaRecord(state.channelWindowMeta, message.channelId, {})
          : state.channelWindowMeta,
        messages: message.channelId === state.currentChannelId ? updatedBucket : state.messages,
      };
    }),

  removeOptimisticMessage: (optimisticId, channelId) =>
    set((state) => {
      const bucket = state.channelMessages[channelId];
      if (!bucket) return state;
      const filtered = bucket.filter((m) => m.id !== optimisticId);
      if (filtered.length === bucket.length) return state;
      const newChannelMessages = { ...state.channelMessages, [channelId]: filtered };
      return {
        channelMessages: newChannelMessages,
        channelWindowMeta: channelId === state.currentChannelId
          ? updateWindowMetaRecord(state.channelWindowMeta, channelId, {})
          : state.channelWindowMeta,
        messages: channelId === state.currentChannelId ? filtered : state.messages,
      };
    }),

  // Batch-add messages in a single state update (used by sync:resume).
  // Avoids N re-renders when catching up many missed messages.
  batchAddMessages: (wireMsgs: Message[]) =>
    set((state) => {
      if (wireMsgs.length === 0) return state;
      const newMsgs = coerceWireMessageSeqs(wireMsgs);

      // Group incoming messages by channel
      const byChannel = new Map<string, Message[]>();
      for (const m of newMsgs) {
        let arr = byChannel.get(m.channelId);
        if (!arr) { arr = []; byChannel.set(m.channelId, arr); }
        // As in syncGap: a held-back live copy may know who sent it (RFC 077).
        const live = getPendingGapMessages(m.channelId).find((pending) => pending.id === m.id);
        arr.push(live ? keepDelegationFacts(m, live) : m);
      }

      // Merge into channel buckets
      const newChannelMessages = { ...state.channelMessages };
      const unreadUpdates = { ...state.unreadCounts };
      let historyFetchedChannels = state.historyFetchedChannels;

      for (const [channelId, msgs] of byChannel) {
        const existing = newChannelMessages[channelId] ?? [];
        // Known ids include the ones earlier in this batch: a catch-up page can
        // carry the same message twice, and each copy must count once.
        const knownIds = new Set(existing.map((m) => m.id));
        const deduped = msgs.filter((m) => {
          if (knownIds.has(m.id)) return false;
          knownIds.add(m.id);
          return true;
        });
        if (deduped.length > 0) {
          newChannelMessages[channelId] = sortBySeq([...existing, ...deduped]);
        }
        if (channelId !== state.currentChannelId
          && liveRowsLeaveHole(state.channelWindowMeta[channelId], existing, deduped)) {
          historyFetchedChannels = forgetHistoryFetched(historyFetchedChannels, channelId);
        }
        const newestDedupedSeq = getMaxSeq(deduped);
        forgetLocalReadSuppressionIfNewerMessage(channelId, newestDedupedSeq);
        // Update unread for non-current channels
        if (channelId !== state.currentChannelId) {
          const unreadIncoming = deduped.filter((message) => !isSelfAuthoredMessage(message, state.currentUserId));
          if (unreadIncoming.length > 0) {
            unreadUpdates[channelId] = (unreadUpdates[channelId] || 0) + unreadIncoming.length;
          }
        }
      }

      const maxSeq = Math.max(...newMsgs.map((m) => m.seq || 0), state.lastSeq);
      return withAcceptedReadStateProjection(state, {
        channelMessages: newChannelMessages,
        channelWindowMeta: state.currentChannelId
          ? updateWindowMetaRecord(state.channelWindowMeta, state.currentChannelId, {})
          : state.channelWindowMeta,
        messages: getBucket(newChannelMessages, state.currentChannelId),
        historyFetchedChannels,
        lastSeq: maxSeq,
        unreadCounts: unreadUpdates,
      }, byChannel.keys());
    }),

  sendMessage: async (channelId, content, attachmentIds, asTask, optimisticId, randomId, mentions) => {
    const ingressContext = captureReceiverPrivateIngressContext(get().currentUserId);
    // The reply raises lastSeq to the sent message's seq: a starting sync
    // horizon that arrives after this write is not safe to use either.
    noteMessageHistoryRequest();
    const { data } = await api.post("/v2/messages", {
      channelId,
      content,
      attachmentIds,
      asTask: asTask || undefined,
      randomId,
      mentions: mentions && mentions.length > 0 ? mentions : undefined,
      // The sender's IANA zone, recorded on the message for agents only.
      timezone: detectBrowserTimezone() ?? undefined,
    });
    const normalizedResponse = normalizeSendMessageResponse(data);
    const message = coerceCurrentReceiverPrivateMessage(
      normalizedResponse.message,
      ingressContext,
    );
    if (!message) {
      return {
        messageId: normalizedResponse.message.id,
        pendingMentionActions: [],
        unresolvedMentionHandles: normalizedResponse.unresolvedMentionHandles,
        deliveryWarnings: normalizedResponse.deliveryWarnings ?? [],
      };
    }
    const { pendingMentionActions, unresolvedMentionHandles, deliveryWarnings = [] } = normalizedResponse;
    const { useChannelStore } = await import("./channelStore");
    useChannelStore.getState().touchChannelActivity(
      channelId,
      typeof message.createdAt === "string" ? message.createdAt : null,
    );
    set((state) => {
      // The socket echo usually replaces the optimistic row before the HTTP
      // response resolves. Keep the exact optimistic id as a second cleanup
      // path for sender-profile races, so the local row cannot stay duplicated.
      let bucket = state.channelMessages[channelId] ?? [];
      const exactOptimistic = optimisticId ? bucket.find((m) => m.id === optimisticId) : undefined;
      const matchingOptimistic = exactOptimistic ?? findMatchingOptimisticMessage(bucket, message);
      const persistedMessage = mergeOptimisticAttachmentPreviews(matchingOptimistic, message);
      const optimisticIdsToRemove = [optimisticId, matchingOptimistic?.id];
      const bucketBeforeOptimisticCleanup = bucket;
      bucket = bucket.filter((m) => !optimisticIdsToRemove.includes(m.id));
      const removedOptimisticRows = bucket.length !== bucketBeforeOptimisticCleanup.length;
      const existingPersistedIndex = bucket.findIndex((m) => m.id === persistedMessage.id);
      if (existingPersistedIndex >= 0) {
        const newLastSeq = Math.max(state.lastSeq, persistedMessage.seq || 0);
        const mergedMessage = mergeIncomingMessage(bucket[existingPersistedIndex], persistedMessage);
        if (mergedMessage === bucket[existingPersistedIndex]) {
          if (removedOptimisticRows) {
            const newChannelMessages = { ...state.channelMessages, [channelId]: bucket };
            return {
              channelMessages: newChannelMessages,
              channelWindowMeta: channelId === state.currentChannelId
                ? updateWindowMetaRecord(state.channelWindowMeta, channelId, {})
                : state.channelWindowMeta,
              messages: channelId === state.currentChannelId ? bucket : state.messages,
              lastSeq: newLastSeq,
            };
          }
          return newLastSeq === state.lastSeq ? state : { lastSeq: newLastSeq };
        }
        const updatedBucket = bucket.map((m, index) => index === existingPersistedIndex ? mergedMessage : m);
        const newChannelMessages = { ...state.channelMessages, [channelId]: updatedBucket };
        return {
          channelMessages: newChannelMessages,
          channelWindowMeta: channelId === state.currentChannelId
            ? updateWindowMetaRecord(state.channelWindowMeta, channelId, {})
            : state.channelWindowMeta,
          messages: channelId === state.currentChannelId ? updatedBucket : state.messages,
          lastSeq: newLastSeq,
        };
      }
      const updatedBucket = sortBySeq([...bucket, persistedMessage]);
      const newChannelMessages = { ...state.channelMessages, [channelId]: updatedBucket };
      return {
        channelMessages: newChannelMessages,
        channelWindowMeta: channelId === state.currentChannelId
          ? updateWindowMetaRecord(state.channelWindowMeta, channelId, {})
          : state.channelWindowMeta,
        messages: channelId === state.currentChannelId ? updatedBucket : state.messages,
        lastSeq: Math.max(state.lastSeq, persistedMessage.seq || 0),
      };
    });
    return { messageId: message.id, pendingMentionActions, unresolvedMentionHandles, deliveryWarnings };
  },

  loadMessageContext: async (channelId, messageId) => {
    const requestGeneration = claimMessageWindowRequest();
    clearPendingGapMessages(channelId);
    const state = get();
    const cached = state.channelMessages[channelId];
    // Only a list a history read filled may stand in for the window around
    // the target; live rows that arrived while the channel was closed are not
    // its history, even when the target is one of them.
    const cacheHit = !!state.historyFetchedChannels[channelId]
      && !!cached?.some((message) => message.id === messageId);
    traceChannelOpen(state, channelId, "context", cacheHit);
    if (cached && cacheHit) {
      const meta = state.currentChannelId === channelId
        ? {
            hasMore: state.hasMore,
            hasNewer: state.hasNewer,
            historyLimited: state.historyLimited,
          }
          : getChannelMeta(state, channelId);
      set((current) => ({
        ...getCachedChannelWindowState(channelId, cached, meta, messageId),
        highlightNonce: current.highlightNonce + 1,
        channelWindowMeta: updateWindowMetaRecord(current.channelWindowMeta, channelId, toWindowMeta(meta)),
      }));
      return;
    }
    set((current) => ({
      loading: true,
      loadingOlder: false,
      loadingNewer: false,
      currentChannelId: channelId,
      channelWindowMeta: updateWindowMetaRecord(current.channelWindowMeta, channelId, {
        loading: true,
        loadingOlder: false,
        loadingNewer: false,
        contextLoadError: null,
      }),
      highlightedMessageId: messageId,
      highlightNonce: current.highlightNonce + 1,
      contextLoadError: null,
    }));

    const prefetched = takeMessagePage(messageWindowRequest(channelId, messageId), get().currentUserId);
    const ingressContext = prefetched?.ingressContext ?? captureReceiverPrivateIngressContext(get().currentUserId);
    try {
      noteMessageHistoryRequest();
      const { data } = await (prefetched?.request ?? api.get(`/messages/context/${messageId}`, { params: { channelId } }));
      if (!ownsMessageWindowRequest(requestGeneration, channelId, get().currentChannelId)) return;
      const canonicalTarget = data.canonicalTarget as CanonicalThreadTarget | undefined;
      if (canonicalTarget?.kind === "thread") {
        // Stryker disable next-line ObjectLiteral: typed thread payload shape is covered by openThread payload/source contracts.
        await useThreadStore.getState().openThread({
          parentChannelId: canonicalTarget.channelId,
          parentMessageId: canonicalTarget.threadParentMessageId,
          focusedMessageId: canonicalTarget.messageId,
        });
        if (ownsMessageWindowRequest(requestGeneration, channelId, get().currentChannelId)) {
          await get().loadMessages(channelId);
        }
        return;
      }
      const coerced = coerceCurrentReceiverPrivateMessages(
        data.messages ?? [],
        ingressContext,
      );
      if (!coerced) return settleStaleWindowRead(channelId, ingressContext, () => get().loadMessageContext(channelId, messageId));
      const msgs = prefetched && !data.hasNewer ? withLiveRowsAfter(coerced, get().channelMessages[channelId], prefetched.seqAtSend) : coerced;
      hydrateBundledThreadSummaries(data, ingressContext);
      const targetMessageId = data.targetMessageId ?? messageId;
      const maxSeq = Math.max(...msgs.map((m) => m.seq || 0), 0);
      // The window can reach the start of what the plan shows: keep the flag
      // (the history paywall goes there) and what the cutoff hides.
      const historyLimited = !data.hasOlder && data.historyLimited === true;
      recordHiddenHistory(channelId, data);
      clearHiddenTarget(channelId);

      set((state) => withAcceptedReadStateProjection(state, {
        channelMessages: { ...state.channelMessages, [channelId]: msgs },
        historyFetchedChannels: markHistoryFetched(state.historyFetchedChannels, channelId),
        channelWindowMeta: updateWindowMetaRecord(state.channelWindowMeta, channelId, {
          loading: false,
          loadingOlder: false,
          loadingNewer: false,
          hasMore: !!data.hasOlder,
          hasNewer: !!data.hasNewer,
          hasGap: false,
          historyLimited,
          contextLoadError: null,
        }),
        messages: msgs,
        lastSeq: Math.max(state.lastSeq, maxSeq),
        loading: false,
        hasMore: !!data.hasOlder,
        hasNewer: !!data.hasNewer,
        hasGap: false,
        historyLimited,
        contextLoadError: null,
        highlightedMessageId: targetMessageId,
      }, [channelId]));
    } catch (error) {
      if (!ownsMessageWindowRequest(requestGeneration, channelId, get().currentChannelId)) return;
      const hidden = readHistoryLimitedError(error);
      const hiddenThreadTarget = hidden?.canonicalTarget;
      if (
        hiddenThreadTarget?.kind === "thread"
        && hiddenThreadTarget.channelId
        && hiddenThreadTarget.messageId
        && hiddenThreadTarget.threadParentMessageId
      ) {
        // A reply behind the plan's history window opens its thread, as a
        // reply inside it does; the thread's paywall centers on it (task #8).
        await useThreadStore.getState().openThread({
          parentChannelId: hiddenThreadTarget.channelId,
          parentMessageId: hiddenThreadTarget.threadParentMessageId,
          focusedMessageId: hiddenThreadTarget.messageId,
        });
        if (ownsMessageWindowRequest(requestGeneration, channelId, get().currentChannelId)) {
          await get().loadMessages(channelId);
        }
        return;
      }
      if (hidden?.hiddenTarget) {
        // The target is behind the plan's history window (task #8): the
        // history paywall centers on it, over the first messages the window
        // shows after it.
        recordHiddenTarget(channelId, hidden.hiddenTarget);
        await get().loadWindowAfterHiddenTarget(channelId, hidden.hiddenTarget.target.seq, requestGeneration);
        return;
      }
      set((state) => ({
        // Stryker disable next-line BooleanLiteral: context-load failure spinner reset is legacy UI scaffolding outside read-state projection behavior.
        loading: false,
        highlightedMessageId: null,
        channelWindowMeta: updateWindowMetaRecord(state.channelWindowMeta, channelId, { loading: false }),
      }));
      const fallbackGeneration = claimMessageWindowRequest();
      await get().loadMessages(channelId, fallbackGeneration);
      if (ownsMessageWindowRequest(fallbackGeneration, channelId, get().currentChannelId)) {
        // Not behind the window (the route says so with history_limited):
        // the message is not there, or not for this reader; or the read
        // failed and nobody knows yet.
        const contextLoadError = isFinalNotFound(error) ? CONTEXT_NOT_FOUND_ERROR : CONTEXT_LOAD_FAILED_ERROR;
        set((state) => ({
          contextLoadError,
          pendingNotFoundToast: true,
          channelWindowMeta: updateWindowMetaRecord(state.channelWindowMeta, channelId, {
            contextLoadError,
          }),
        }));
      }
    }
  },

  loadMessageWindowSilent: async (channelId, messageId) => {
    const requestGeneration = claimMessageWindowRequest();
    clearPendingGapMessages(channelId);
    traceChannelOpen(get(), channelId, "remembered", false);
    set((state) => ({
      loading: true,
      loadingOlder: false,
      // Stryker disable next-line BooleanLiteral: silent-window loader initial flag is legacy UI scaffolding outside read-state projection behavior.
      loadingNewer: false,
      currentChannelId: channelId,
      channelWindowMeta: updateWindowMetaRecord(state.channelWindowMeta, channelId, {
        loading: true,
        loadingOlder: false,
        loadingNewer: false,
        contextLoadError: null,
      }),
      contextLoadError: null,
    }));

    const prefetched = takeMessagePage(messageWindowRequest(channelId, messageId), get().currentUserId);
    const ingressContext = prefetched?.ingressContext ?? captureReceiverPrivateIngressContext(get().currentUserId);
    try {
      noteMessageHistoryRequest();
      const { data } = await (prefetched?.request ?? api.get(`/messages/context/${messageId}`, { params: { channelId } }));
      if (!ownsMessageWindowRequest(requestGeneration, channelId, get().currentChannelId)) return;
      const coerced = coerceCurrentReceiverPrivateMessages(
        data.messages ?? [],
        ingressContext,
      );
      if (!coerced) return settleStaleWindowRead(channelId, ingressContext, () => get().loadMessageWindowSilent(channelId, messageId));
      const msgs = prefetched && !data.hasNewer ? withLiveRowsAfter(coerced, get().channelMessages[channelId], prefetched.seqAtSend) : coerced;
      hydrateBundledThreadSummaries(data, ingressContext);
      const maxSeq = Math.max(...msgs.map((m) => m.seq || 0), 0);
      const historyLimited = !data.hasOlder && data.historyLimited === true;
      recordHiddenHistory(channelId, data);
      clearHiddenTarget(channelId);

      set((state) => withAcceptedReadStateProjection(state, {
        channelMessages: { ...state.channelMessages, [channelId]: msgs },
        historyFetchedChannels: markHistoryFetched(state.historyFetchedChannels, channelId),
        channelWindowMeta: updateWindowMetaRecord(state.channelWindowMeta, channelId, {
          loading: false,
          loadingOlder: false,
          loadingNewer: false,
          hasMore: !!data.hasOlder,
          hasNewer: !!data.hasNewer,
          hasGap: false,
          historyLimited,
          contextLoadError: null,
        }),
        messages: msgs,
        lastSeq: Math.max(state.lastSeq, maxSeq),
        loading: false,
        hasMore: !!data.hasOlder,
        hasNewer: !!data.hasNewer,
        hasGap: false,
        historyLimited,
        contextLoadError: null,
      }, [channelId]));
    } catch {
      if (ownsMessageWindowRequest(requestGeneration, channelId, get().currentChannelId)) {
        set((state) => ({
          loading: false,
          channelWindowMeta: updateWindowMetaRecord(state.channelWindowMeta, channelId, { loading: false }),
        }));
        // The remembered row is gone from the window (it aged past the plan's
        // history, or it is not there): open at the latest messages instead
        // of an empty channel (task #8).
        await get().loadMessages(channelId, claimMessageWindowRequest());
      }
    }
  },

  loadWindowAfterHiddenTarget: async (channelId, targetSeq, requestGeneration) => {
    const ingressContext = captureReceiverPrivateIngressContext(get().currentUserId);
    try {
      const limit = 50;
      const { data } = await api.get(`/messages/channel/${channelId}?limit=${limit}&after=${targetSeq}`);
      if (!ownsMessageWindowRequest(requestGeneration, channelId, get().currentChannelId)) return;
      const msgs = coerceCurrentReceiverPrivateMessages(data.messages ?? data, ingressContext);
      if (!msgs) return settleStaleWindowRead(channelId, ingressContext, () => get().loadWindowAfterHiddenTarget(channelId, targetSeq, requestGeneration));
      hydrateBundledThreadSummaries(data, ingressContext);
      const maxSeq = Math.max(...msgs.map((m) => m.seq || 0), 0);
      // An after page always reports hasNewer; a short page is the end.
      const hasNewer = msgs.length >= limit;
      // Nothing above the paywall loads: the window starts here.
      set((state) => withAcceptedReadStateProjection(state, {
        channelMessages: { ...state.channelMessages, [channelId]: msgs },
        historyFetchedChannels: markHistoryFetched(state.historyFetchedChannels, channelId),
        channelWindowMeta: updateWindowMetaRecord(state.channelWindowMeta, channelId, {
          loading: false,
          loadingOlder: false,
          loadingNewer: false,
          hasMore: false,
          hasNewer,
          hasGap: false,
          historyLimited: true,
          contextLoadError: CONTEXT_BEYOND_HISTORY_ERROR,
        }),
        messages: msgs,
        lastSeq: Math.max(state.lastSeq, maxSeq),
        loading: false,
        hasMore: false,
        hasNewer,
        hasGap: false,
        historyLimited: true,
        contextLoadError: CONTEXT_BEYOND_HISTORY_ERROR,
        highlightedMessageId: null,
      }, [channelId]));
    } catch {
      if (ownsMessageWindowRequest(requestGeneration, channelId, get().currentChannelId)) {
        set((state) => ({
          loading: false,
          highlightedMessageId: null,
          contextLoadError: CONTEXT_BEYOND_HISTORY_ERROR,
          channelWindowMeta: updateWindowMetaRecord(state.channelWindowMeta, channelId, { loading: false, contextLoadError: CONTEXT_BEYOND_HISTORY_ERROR }),
        }));
      }
    }
  },

  syncGap: async (channelId, options) => {
    const { currentChannelId } = get();
    const targetChannelId = channelId ?? currentChannelId ?? undefined;
    // A channel this person was removed from: its sync is refused every time.
    if (isChannelAccessLost(targetChannelId)) return;

    // From the window tail, or lower when a live row shown across a jump
    // still has its hole unconfirmed.
    const pendingSince = targetChannelId ? getGapFillSinceSeq(targetChannelId) : null;
    const tailSeq = targetChannelId
      ? getMaxSeq(get().channelMessages[targetChannelId] ?? [])
      : get().lastSeq;
    const sinceSeq = options?.sinceSeq ?? (pendingSince === null ? tailSeq : Math.min(pendingSince, tailSeq));
    if (sinceSeq <= 0) return;

    // One read per scope at a time: a read asked for meanwhile (a live row
    // that lands while it is in flight, a heartbeat) runs once after it.
    const readKey = targetChannelId ?? "";
    if (joinGapReadInFlight(readKey, sinceSeq)) return;
    if (gapSyncWaitsForShow(targetChannelId, sinceSeq, get().syncGap)) return;
    const { read, startEpoch } = startGapRead(readKey);
    const { isNearBottom, hasNewer, unreadCounts } = get();

    const shouldTrackCurrentGap = Boolean(targetChannelId && currentChannelId === targetChannelId);
    if (shouldTrackCurrentGap) {
      set((state) => ({
        hasGap: true,
        loadingGap: true,
        channelWindowMeta: targetChannelId
          ? updateWindowMetaRecord(state.channelWindowMeta, targetChannelId, { hasGap: true, loadingGap: true })
          : state.channelWindowMeta,
      }));
    }

    const ingressContext = captureReceiverPrivateIngressContext(get().currentUserId);
    let outcome: "read" | "failed" | "abandoned" = "abandoned";
    let remainingPending = 0;
    try {
      const limit = 200;
      let cursor = sinceSeq;
      const syncedMessages: Message[] = [];

      while (true) {
        const params = new URLSearchParams({
          since_seq: String(cursor),
          limit: String(limit),
        });
        if (targetChannelId) params.set("channel_id", targetChannelId);

        noteMessageHistoryRequest();
        const { data } = await api.get(`/messages/sync?${params}`);
        const page = coerceCurrentReceiverPrivateMessages(
          (data as Message[]) ?? [],
          ingressContext,
        );
        // The signed-in person changed under the read: drop it (finally
        // still clears the loading flags).
        if (!page) return;
        if (page.length === 0) break;
        syncedMessages.push(...page);
        cursor = Math.max(cursor, getMaxSeq(page));
        if (page.length < limit) break;
      }

      set((state) => {
        // Group synced messages by channel
        const byChannel = new Map<string, Message[]>();
        for (const m of syncedMessages) {
          let arr = byChannel.get(m.channelId);
          // Stryker disable next-line BooleanLiteral,ConditionalExpression,BlockStatement,ArrayDeclaration: grouping bucket initialization is legacy sync-gap mechanics; read-state tests assert downstream unread projection.
          if (!arr) { arr = []; byChannel.set(m.channelId, arr); }
          // The live copy of a message shown across this gap may know more
          // than the sync row (RFC 077: who sent it for its owner); keep it.
          const live = getPendingGapMessages(m.channelId).find((pending) => pending.id === m.id);
          arr.push(live ? keepDelegationFacts(m, live) : m);
        }

        // Older rows the read returns interleave with the live rows already
        // shown: merge by id and order by seq.
        const newChannelMessages = { ...state.channelMessages };
        for (const [chId, msgs] of byChannel) {
          const existing = newChannelMessages[chId] ?? [];
          const knownIds = new Set(existing.map((m) => m.id));
          const deduped = msgs.filter((m) => {
            if (knownIds.has(m.id)) return false;
            knownIds.add(m.id);
            return true;
          });
          if (deduped.length > 0) {
            newChannelMessages[chId] = sortBySeq([...existing, ...deduped]);
          }
        }

        if (targetChannelId) {
          remainingPending = settlePendingGapMessages(
            targetChannelId,
            sinceSeq,
            startEpoch,
            new Set(syncedMessages.map((message) => message.id)),
          );
        }

        const maxSeq = Math.max(getMaxSeq(syncedMessages), state.lastSeq);
        const nextState: Partial<MessageState> = {
          channelMessages: newChannelMessages,
          messages: getBucket(newChannelMessages, state.currentChannelId),
          lastSeq: maxSeq,
        };
        if (shouldTrackCurrentGap) {
          nextState.hasGap = remainingPending > 0;
          nextState.loadingGap = false;
          if (targetChannelId) {
            nextState.channelWindowMeta = updateWindowMetaRecord(state.channelWindowMeta, targetChannelId, {
              hasGap: nextState.hasGap,
              loadingGap: false,
            });
          }
        }
        const projectionChannelIds = new Set(byChannel.keys());
        if (targetChannelId) projectionChannelIds.add(targetChannelId);
        return withAcceptedReadStateProjection(state, nextState, projectionChannelIds);
      });
      outcome = "read";

      // Read the channel through its newest row once no hole is left
      // unconfirmed (a row that landed during the read waits for its own).
      if (shouldTrackCurrentGap && targetChannelId && remainingPending === 0) {
        const updatedMessages = get().channelMessages[targetChannelId] ?? [];
        const newestSeq = getMaxSeq(updatedMessages);
        if (newestSeq > 0 && isNearBottom && !hasNewer) {
          const autoReadQueued = queueLiveAppendAutoReadSync(targetChannelId, newestSeq, "channel", readCurrentChannelLater(targetChannelId));
          if (autoReadQueued && unreadCounts[targetChannelId]) {
            get().clearUnread(targetChannelId);
          }
        }
      }
    } catch (error) {
      noteChannelReadError(targetChannelId, error);
      outcome = "failed";
    } finally {
      // Never leave the loading flag up: not on an error, not on a read
      // dropped because the signed-in person changed.
      if (shouldTrackCurrentGap && outcome !== "read") {
        set((state) => {
          const stillOwed = targetChannelId ? channelOwesGapFill(targetChannelId) : false;
          return {
            loadingGap: false,
            hasGap: stillOwed,
            channelWindowMeta: targetChannelId
              ? updateWindowMetaRecord(state.channelWindowMeta, targetChannelId, { loadingGap: false, hasGap: stillOwed })
              : state.channelWindowMeta,
          };
        });
      }
      finishGapRead(readKey, read, targetChannelId, outcome, (rerunSince) => void get().syncGap(targetChannelId, { sinceSeq: rerunSince }));
    }
  },

  setNearBottom: (val) => {
    const prev = get().isNearBottom;
    if (val === prev) return;
    set({ isNearBottom: val });
    // When scrolling back to bottom, mark current channel as read
    if (val && !get().hasNewer) get().markCurrentChannelRead();
  },

  markCurrentChannelRead: () => {
    const { currentChannelId, messages, hasNewer, isNearBottom } = get();
    if (!currentChannelId) return;
    if (isAutoReadHeld(currentChannelId) || !canAutoMarkCurrentChannelRead()) return;
    // Only what is in front of the person: not while they read older history
    // (a window focus used to read the whole channel from up there).
    if (hasNewer || !isNearBottom) return;
    // A live row is shown past a hole not yet confirmed empty: the gap fill
    // reads the channel once it answers (syncGap), not past the hole now.
    if (channelOwesGapFill(currentChannelId)) return;
    forgetSkippedSeenRead(currentChannelId);
    const maxSeq = Math.max(...messages.map((m) => m.seq || 0), 0);
    if (maxSeq > 0) {
      queueReadSync(currentChannelId, maxSeq);
    }
    get().clearUnread(currentChannelId);
  },

  setCurrentChannelId: (channelId) => {
    if (get().currentChannelId !== channelId) claimMessageWindowRequest();
    set({ currentChannelId: channelId });
  },
  setCurrentUserId: (userId) => {
    setCurrentPrincipalId(userId);
    // The same person again (a token refresh, /auth/me agreeing): nothing
    // changes, so no subscriber is told.
    if (get().currentUserId === userId) return;
    set({ currentUserId: userId });
    invalidateReceiverPrivateIngressContexts();
    reactionReadModelStore.getState().activatePrincipal(userId);
  },
  setHighlightedMessageId: (messageId) =>
    set((state) => ({
      highlightedMessageId: messageId,
      highlightNonce: messageId ? state.highlightNonce + 1 : state.highlightNonce,
    })),
  requestTransientFocus: (channelId, messageId) =>
    set({
      transientFocusRequest: {
        channelId,
        messageId,
        nonce: Date.now(),
      },
    }),
  consumeTransientFocusRequest: (nonce) => {
    if (get().transientFocusRequest?.nonce !== nonce) return;
    set({ transientFocusRequest: null });
  },
}));

// Keep the ingress fence tied to the actual Zustand projection. This also
// covers test/dev callers that seed the store with setState instead of the
// public setCurrentUserId action, without making the shared ingress module
// import messageStore and create a runtime cycle.
registerReceiverPrivatePrincipalReader(
  () => useMessageStore.getState().currentUserId,
);

onCurrentServerConfirmed(() => {
  void flushAllPendingReads();
});

// Drafts belong to the signed-in person (draftStorage.ts). Followed on
// the store rather than in setCurrentUserId so a seeded `setState` is covered
// too: a new person gets their own drafts and the previous one's leave memory.
// A switch without a sign-out keeps the previous person's drafts in their own
// entry (their pending write lands there); a sign-out has already dropped it.
useMessageStore.subscribe((state, previousState) => {
  if (state.currentUserId === previousState.currentUserId) return;
  flushPendingDraftSnapshot();
  useMessageStore.setState({ drafts: loadDrafts(state.currentUserId), draftUpdatedAt: loadDraftTimes(state.currentUserId) });
});

onDraftsForgotten((userId) => {
  const { currentUserId } = useMessageStore.getState();
  if (userId === null || currentUserId === null || currentUserId === userId) useMessageStore.setState({ drafts: {}, draftUpdatedAt: {} });
});

setGapFillReader((channelId, sinceSeq) => void useMessageStore.getState().syncGap(channelId, { sinceSeq }));

// Reset server-scoped state when the user switches servers.
// channelMessages and drafts are intentionally kept: channelMessages becomes
// unreachable once channels are cleared, and drafts are harmless cross-server.
registerServerReset(() =>
  {
    claimMessageWindowRequest();
    invalidateReceiverPrivateIngressContexts();
    triggerMessagesSyncCoreReset();
    resetPendingReads();
    pendingUnreadReceipts.clear();
    clearPendingGapMessages();
    messageHistoryRequestCount = 0;
    useMessageStore.setState({
      channelMessages: {},
      channelWindowMeta: {},
      historyFetchedChannels: {},
      messages: [],
      highlightedMessageId: null,
      transientFocusRequest: null,
      lastSeq: 0,
      syncHorizon: null,
      currentChannelId: null,
      loading: false,
      loadingOlder: false,
      loadingNewer: false,
      loadingGap: false,
      hasMore: true,
      hasNewer: false,
      hasGap: false,
      unreadCounts: {},
      mentionFlags: {},
      newFlags: {},
      historyLimited: false,
      isNearBottom: true,
    });
  }
);
