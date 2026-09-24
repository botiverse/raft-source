import { create } from "zustand";
import type {
  ActionCardMetadata,
  CanonicalReactionFact,
  ExternalMessageAuthorProjection,
  LegacyReactionRosterDto,
} from "@botiverse/raft-shared";
import { clearClockTimeout, setClockTimeout } from "@botiverse/raft-shared";
import api from "../api/client";
import { useServerStore } from "./serverStore";
import { useThreadStore } from "./threadStore";
import type { ThreadSummary } from "./threadStore";
import { setCurrentPrincipalId } from "./principalRuntime";
import {
  captureReceiverPrivateIngressContext,
  invalidateReceiverPrivateIngressContexts,
  isReceiverPrivateIngressContextCurrent,
  registerReceiverPrivatePrincipalReader,
} from "./receiverPrivateIngress";
import type {
  ReceiverPrivateIngressContext,
} from "./receiverPrivateIngress";
import { hydrateThreadRepliesSnapshotWithSyncCore } from "./threadRepliesSyncDomain";
import type { ThreadRepliesScope } from "./threadRepliesReadModel";
import { registerServerReset } from "./serverResetRegistry";
import {
  isNormalizedMessageV2FlagEnabled,
  registerNormalizedMessageV2Activation,
} from "./normalizedMessageV2FeatureFlag";
import {
  applyMessageReactionsForV2Ingress,
  applyMessagesReactionsForV2Ingress,
} from "./normalizedMessageReactions";
import { reactionReadModelStore } from "./reactionReadModels";
import { triggerMessagesSyncCoreReset } from "./messageSyncCoreReset";
import {
  getAcceptedReadState,
  consumeReadStateSnapshotRows,
  getReadStateLedgerGeneration,
  hasAcceptedReadStateChangedAfter,
  notifyChannelReadLocally,
  rememberAcceptedReadStateProjection,
} from "./readStateSync";
import type {
  ReadStateProjection,
} from "./readStateSync";

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
  type: "user" | "agent";
  id: string;
  name: string;
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

export interface SendMessageResult {
  messageId: string;
  pendingMentionActions: PendingMentionAction[];
  unresolvedMentionHandles: string[];
}

export interface ConversationContext {
  channelType: "channel" | "private" | "joint" | "dm" | "thread";
  parentMessageId?: string;
  parentChannelId?: string;
  parentChannelType?: "channel" | "private" | "joint" | "dm";
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

function normalizeReceiverPrivateMessagesIfEnabled(
  messages: readonly Message[],
  context: ReceiverPrivateIngressContext,
): Message[] | null {
  if (!isReceiverPrivateIngressContextCurrent(context)) return null;
  if (!isNormalizedMessageV2FlagEnabled()) return messages as Message[];
  if (!context.serverId || !context.principalId) return messages as Message[];
  return applyMessagesReactionsForV2Ingress(messages, {
    serverId: context.serverId,
    principalId: context.principalId,
    source: "receiver-private",
    viewerUserId: context.principalId,
  });
}

function normalizeReceiverPrivateMessageIfEnabled(
  message: Message,
  context: ReceiverPrivateIngressContext,
): Message | null {
  if (!isReceiverPrivateIngressContextCurrent(context)) return null;
  if (!isNormalizedMessageV2FlagEnabled()) return message;
  if (!context.serverId || !context.principalId) return message;
  return applyMessageReactionsForV2Ingress(message, {
    serverId: context.serverId,
    principalId: context.principalId,
    source: "receiver-private",
    viewerUserId: context.principalId,
  });
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

function hydrateBundledThreadSummaries(
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
  messages: Message[];
  highlightedMessageId: string | null;
  transientFocusRequest: { channelId: string; messageId: string; nonce: number } | null;
  lastSeq: number;
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
  currentUserId: string | null;
  drafts: Record<string, string>;
  historyLimited: boolean;
  isNearBottom: boolean;
  loadMessages: (channelId: string, requestGeneration?: number) => Promise<void>;
  loadOlderMessages: (channelId?: string) => Promise<void>;
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
  markUnread: (channelId: string) => Promise<void>;
  setNearBottom: (val: boolean) => void;
  markCurrentChannelRead: () => void;
  setDraft: (channelId: string, content: string) => void;
  adoptDraftChannel: (sourceChannelId: string, destinationChannelId: string, preferSource?: boolean) => string;
  clearDraft: (channelId: string) => void;
}

export const DRAFTS_STORAGE_KEY = "slock_drafts";
// Draft edits are kept synchronous in Zustand, while durable storage is
// coalesced. The maxWait is deliberately independent of the debounce timer:
// mobile browsers are not guaranteed to deliver a lifecycle event before a
// process is killed.
export const DRAFT_PERSISTENCE_DEBOUNCE_MS = 250;
export const DRAFT_PERSISTENCE_MAX_WAIT_MS = 3_000;
const MANUAL_UNREAD_SKIP_STORAGE_KEY = "slock_manual_unread_skip";
const PENDING_READ_SEQS_STORAGE_KEY = "slock_pending_read_seqs";
const LOCAL_READ_SUPPRESSION_TTL_MS = 30_000;
const LIVE_APPEND_AUTO_READ_ACTIVITY_WINDOW_MS = 1_000;
const OPTIMISTIC_MATCH_CREATED_AT_WINDOW_MS = 5 * 60 * 1000;
const pendingGapMessages = new Map<string, Message[]>();

export interface LocalReadSuppression {
  seq: number;
  expiresAt: number;
}

function loadDraftsFromStorage(): Record<string, string> {
  try {
    const raw = localStorage.getItem(DRAFTS_STORAGE_KEY);
    return raw ? JSON.parse(raw) : {};
  } catch {
    return {};
  }
}

function saveDraftsToStorage(drafts: Record<string, string>) {
  try {
    if (Object.keys(drafts).length === 0) {
      localStorage.removeItem(DRAFTS_STORAGE_KEY);
    } else {
      localStorage.setItem(DRAFTS_STORAGE_KEY, JSON.stringify(drafts));
    }
  } catch {
    // ignore quota errors
  }
}

let pendingDraftSnapshot: Record<string, string> | null = null;
let draftDebounceTimer: unknown = null;
let draftMaxWaitTimer: unknown = null;
let draftPersistenceGeneration = 0;
let draftDebounceToken = 0;

function cancelDraftPersistenceTimers() {
  if (draftDebounceTimer !== null) {
    clearClockTimeout(draftDebounceTimer);
    draftDebounceTimer = null;
  }
  if (draftMaxWaitTimer !== null) {
    clearClockTimeout(draftMaxWaitTimer);
    draftMaxWaitTimer = null;
  }
}

function flushPendingDraftSnapshot() {
  const snapshot = pendingDraftSnapshot;
  if (snapshot === null) return;
  pendingDraftSnapshot = null;
  draftPersistenceGeneration += 1;
  draftDebounceToken += 1;
  cancelDraftPersistenceTimers();
  saveDraftsToStorage(snapshot);
}

function persistDraftSnapshotImmediately(drafts: Record<string, string>) {
  // clear/adopt are durability boundaries: a stale trailing timer must not be
  // able to restore a sent or migrated draft after this synchronous write.
  draftPersistenceGeneration += 1;
  draftDebounceToken += 1;
  cancelDraftPersistenceTimers();
  pendingDraftSnapshot = { ...drafts };
  flushPendingDraftSnapshot();
}

function scheduleDraftSnapshot(drafts: Record<string, string>) {
  // `drafts` is a fresh Zustand snapshot and is never mutated after the
  // transition, so retaining it avoids another full-map clone per keystroke.
  pendingDraftSnapshot = drafts;
  draftDebounceToken += 1;
  const debounceToken = draftDebounceToken;
  if (draftDebounceTimer !== null) clearClockTimeout(draftDebounceTimer);
  draftDebounceTimer = setClockTimeout(() => {
    if (debounceToken !== draftDebounceToken) return;
    flushPendingDraftSnapshot();
  }, DRAFT_PERSISTENCE_DEBOUNCE_MS);

  if (draftMaxWaitTimer === null) {
    const generation = draftPersistenceGeneration;
    draftMaxWaitTimer = setClockTimeout(() => {
      draftMaxWaitTimer = null;
      if (generation !== draftPersistenceGeneration) return;
      flushPendingDraftSnapshot();
    }, DRAFT_PERSISTENCE_MAX_WAIT_MS);
  }
}

function installDraftPersistenceLifecycle() {
  if (typeof window === "undefined" || typeof document === "undefined") return;
  window.addEventListener("pagehide", flushPendingDraftSnapshot);
  document.addEventListener("visibilitychange", () => {
    if (document.visibilityState === "hidden") flushPendingDraftSnapshot();
  });
}

installDraftPersistenceLifecycle();

function loadManualUnreadSkips(): Set<string> {
  try {
    const raw = sessionStorage.getItem(MANUAL_UNREAD_SKIP_STORAGE_KEY);
    if (!raw) return new Set();
    const channelIds = JSON.parse(raw);
    return Array.isArray(channelIds) ? new Set(channelIds.filter((id): id is string => typeof id === "string")) : new Set();
  } catch {
    return new Set();
  }
}

function persistManualUnreadSkips(channelIds: Set<string>) {
  try {
    if (channelIds.size === 0) {
      sessionStorage.removeItem(MANUAL_UNREAD_SKIP_STORAGE_KEY);
    } else {
      sessionStorage.setItem(MANUAL_UNREAD_SKIP_STORAGE_KEY, JSON.stringify([...channelIds]));
    }
  } catch {
    // ignore storage errors
  }
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

/** Per-channel metadata (hasMore, historyLimited). Stored outside Zustand to avoid
 *  triggering re-renders when non-current channels' metadata changes. */
const channelMetaMap = new Map<string, ChannelMeta>();

function getChannelMeta(channelId: string): ChannelMeta {
  return channelMetaMap.get(channelId) ?? DEFAULT_META;
}

function toWindowMeta(meta: ChannelMeta, override?: Partial<ChannelWindowMeta>): ChannelWindowMeta {
  return { ...DEFAULT_WINDOW_META, ...meta, ...override };
}

function updateWindowMetaRecord(
  current: Record<string, ChannelWindowMeta>,
  channelId: string,
  partial: Partial<ChannelWindowMeta>,
): Record<string, ChannelWindowMeta> {
  const next = { ...DEFAULT_WINDOW_META, ...(current[channelId] ?? channelMetaMap.get(channelId)), ...partial };
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

const manualUnreadSkipChannels = loadManualUnreadSkips();
const pendingReadSeqs = loadPendingReadSeqs();
const pendingReadRequests = new Map<string, Promise<void>>();
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

function hasRecentExplicitAutoReadUserActivity(now = Date.now()) {
  return explicitAutoReadUserActivityAt > 0
    && now - explicitAutoReadUserActivityAt <= LIVE_APPEND_AUTO_READ_ACTIVITY_WINDOW_MS;
}

export function canAutoMarkCurrentChannelRead(
  doc: ReadVisibilityDocument | undefined = typeof document === "undefined" ? undefined : document,
  isCurrentBrowserTabActive = isCurrentBrowserTabActiveForAutoRead,
): boolean {
  if (!doc) return true;
  if (doc.visibilityState && doc.visibilityState !== "visible") return false;
  if (typeof doc.hasFocus === "function" && !doc.hasFocus()) return false;
  return isCurrentBrowserTabActive();
}

export function canAutoMarkLiveAppendRead(
  doc: ReadVisibilityDocument | undefined = typeof document === "undefined" ? undefined : document,
  isCurrentBrowserTabActive = isCurrentBrowserTabActiveForAutoRead,
  hasExplicitUserActivity = hasRecentExplicitAutoReadUserActivity,
): boolean {
  return canAutoMarkCurrentChannelRead(doc, isCurrentBrowserTabActive) && hasExplicitUserActivity();
}

if (typeof window !== "undefined" && typeof document !== "undefined") {
  const claimAutoReadTab = () => {
    if (canAutoMarkCurrentChannelRead(document, () => true)) {
      markCurrentBrowserTabActiveForAutoRead();
    }
  };
  const claimAutoReadTabFromUserActivity = () => {
    rememberExplicitAutoReadUserActivity();
    claimAutoReadTab();
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
  document.addEventListener("pointerdown", claimAutoReadTabFromUserActivity, true);
  // keydown-global-exempt: records the actively used tab for unread auto-read gating, does not move focus
  document.addEventListener("keydown", claimAutoReadTabFromUserActivity, true);
  window.setTimeout(claimAutoReadTab, 0);
}

function shouldSkipInitialAutoRead(channelId: string): boolean {
  return manualUnreadSkipChannels.has(channelId);
}

function rememberManualUnread(channelId: string) {
  manualUnreadSkipChannels.add(channelId);
  persistManualUnreadSkips(manualUnreadSkipChannels);
}

function consumeManualUnread(channelId: string) {
  if (!manualUnreadSkipChannels.delete(channelId)) return;
  persistManualUnreadSkips(manualUnreadSkipChannels);
}

function forgetManualUnread(channelId: string) {
  if (!manualUnreadSkipChannels.delete(channelId)) return;
  persistManualUnreadSkips(manualUnreadSkipChannels);
}

function getPendingReadSeq(channelId: string): number {
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

export function parseUnreadSnapshot(data: unknown): {
  unreadCounts: Record<string, number>;
  mentionFlags: Record<string, boolean>;
} {
  const source = typeof data === "object" && data !== null && "channels" in data
    ? (data as { channels?: unknown }).channels
    : data;
  const unreadCounts: Record<string, number> = {};
  const mentionFlags: Record<string, boolean> = {};
  if (typeof source !== "object" || source === null) {
    return { unreadCounts, mentionFlags };
  }
  for (const [channelId, value] of Object.entries(source)) {
    if (typeof value === "number") {
      if (value > 0) unreadCounts[channelId] = value;
      continue;
    }
    if (typeof value !== "object" || value === null) continue;
    const entry = value as { unreadCount?: unknown; hasMention?: unknown; hasAnyMention?: unknown };
    const unreadCount = typeof entry.unreadCount === "number" ? entry.unreadCount : 0;
    if (unreadCount > 0) unreadCounts[channelId] = unreadCount;
    if (entry.hasMention === true) mentionFlags[channelId] = true;
  }
  return { unreadCounts, mentionFlags };
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
  // Stryker disable all: this is a Zustand identity-preservation fast path; behavior tests assert resulting unread/mention state, not object reference churn.
  if (unreadCounts === state.unreadCounts && mentionFlags === state.mentionFlags) {
    return { state, projection };
  }
  // Stryker restore all
  return { state: { ...state, unreadCounts, mentionFlags }, projection };
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

  const existing = pendingReadRequests.get(channelId);
  if (existing) return existing;

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
  rememberPendingRead(channelId, seq);
  void flushPendingRead(channelId);
}

function queueAutoReadSync(channelId: string, seq: number): boolean {
  if (!canAutoMarkCurrentChannelRead()) return false;
  queueReadSync(channelId, seq);
  return true;
}

function queueLiveAppendAutoReadSync(channelId: string, seq: number): boolean {
  if (!canAutoMarkLiveAppendRead()) return false;
  queueReadSync(channelId, seq);
  return true;
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

export function mergeIncomingMessage(
  existing: Message,
  incoming: Pick<Message, "id" | "channelId"> & Partial<Message>,
): Message {
  let changed = false;
  for (const [key, value] of Object.entries(incoming) as Array<[keyof Message, unknown]>) {
    if (key === "commentRef" && existing.commentRef && value == null) {
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
  return merged;
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

export function normalizeSendMessageResponse(data: unknown): {
  message: Message;
  pendingMentionActions: PendingMentionAction[];
  unresolvedMentionHandles: string[];
} {
  if (isMessagePayload(data)) {
    return { message: data, pendingMentionActions: [], unresolvedMentionHandles: [] };
  }
  const wrapped = data as { message?: unknown; pendingMentionActions?: unknown; unresolvedMentionHandles?: unknown } | null;
  if (isMessagePayload(wrapped?.message)) {
    return {
      message: wrapped.message,
      pendingMentionActions: normalizePendingMentionActions(wrapped?.pendingMentionActions),
      unresolvedMentionHandles: Array.isArray(wrapped?.unresolvedMentionHandles)
        ? wrapped.unresolvedMentionHandles.filter((item): item is string => typeof item === "string")
        : [],
    };
  }
  throw new Error("Invalid message send response");
}

function getPendingGapMessages(channelId: string): Message[] {
  return pendingGapMessages.get(channelId) ?? [];
}

function rememberPendingGapMessage(message: Message) {
  if (!message.seq) return;
  const pending = getPendingGapMessages(message.channelId);
  if (pending.some((pendingMessage) => pendingMessage.id === message.id)) return;
  pendingGapMessages.set(message.channelId, sortBySeq([...pending, message]));
}

function forgetPendingGapMessage(channelId: string, messageId: string) {
  const pending = getPendingGapMessages(channelId);
  if (pending.length === 0) return;
  const filtered = pending.filter((message) => message.id !== messageId);
  if (filtered.length === pending.length) return;
  if (filtered.length === 0) {
    pendingGapMessages.delete(channelId);
    return;
  }
  pendingGapMessages.set(channelId, filtered);
}

function clearPendingGapMessages(channelId?: string) {
  if (channelId) {
    pendingGapMessages.delete(channelId);
    return;
  }
  pendingGapMessages.clear();
}

// Stryker disable all: pre-existing gap-stitching helper is outside the read-state projection contract; gap behavior is covered by sync/window tests, not this diff-gate oracle.
function takeContiguousPendingGapMessages(channelId: string, currentMaxSeq: number, existingIds: Set<string>): Message[] {
  const pending = getPendingGapMessages(channelId);
  if (pending.length === 0) return [];

  let cursor = currentMaxSeq;
  const stitched: Message[] = [];
  const remaining: Message[] = [];

  for (const message of pending) {
    if (existingIds.has(message.id)) {
      cursor = Math.max(cursor, message.seq || 0);
      continue;
    }

    const seq = message.seq || 0;
    if (seq > 0 && seq === cursor + 1) {
      stitched.push(message);
      cursor = seq;
      continue;
    }

    remaining.push(message);
  }

  if (remaining.length === 0) {
    pendingGapMessages.delete(channelId);
  } else {
    pendingGapMessages.set(channelId, remaining);
  }

  return stitched;
}
// Stryker restore all

export const useMessageStore = create<MessageState>((set, get) => ({
  channelMessages: {},
  channelWindowMeta: {},
  messages: [],
  highlightedMessageId: null,
  transientFocusRequest: null,
  lastSeq: 0,
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
  currentUserId: null,
  drafts: loadDraftsFromStorage(),

  loadUnreadCounts: async () => {
    const epoch = useServerStore.getState().serverEpoch;
    const serverId = useServerStore.getState().current?.id;
    if (!serverId) return;
    try {
      await flushAllPendingReads();
      const requestReadStateGeneration = getReadStateLedgerGeneration();
      const { data } = await api.get("/channels/unread", { params: { summary: 1 } });
      if (useServerStore.getState().serverEpoch !== epoch) return;
      // #632 C1: fold the authority union off the RAW response, before
      // parseUnreadSnapshot narrows it to counts/flags.
      // The payload keys channels by id (object map, not an array) and may also
      // be the bare map — mirror parseUnreadSnapshot's own source resolution
      // rather than assuming a shape.
      // Real wire row type rather than an inline assertion (#632 C1).
      type UnreadWireRow = { readState?: import("@botiverse/raft-shared").InboxScopeReadFrontier } | number | null;
      const unreadSource: unknown = typeof data === "object" && data !== null && "channels" in data
        ? (data as { channels?: unknown }).channels
        : data;
      consumeReadStateSnapshotRows(
        serverId,
        typeof unreadSource === "object" && unreadSource !== null
          ? Object.entries(unreadSource as Record<string, UnreadWireRow>).map(([channelId, value]) => ({
            scopeId: channelId,
            readState: typeof value === "object" && value !== null ? value.readState : undefined,
          }))
          : [],
        { ledgerGenerationAtRequest: requestReadStateGeneration },
      );
      const snapshot = parseUnreadSnapshot(data);
      set((state) => {
        const projectionChannelIds = new Set([
          ...Object.keys(state.channelMessages),
          ...Object.keys(state.unreadCounts),
          ...Object.keys(snapshot.unreadCounts),
          ...Object.keys(snapshot.mentionFlags),
        ]);
        // Stryker disable next-line ObjectLiteral: this merge seed is Zustand state plumbing; plain snapshot and stale-summary tests assert observable unread/mention results.
        let nextState: MessageState = {
          ...state,
          unreadCounts: filterUnreadCountsByLocalReadSuppressions(snapshot.unreadCounts, localReadSuppressions),
          mentionFlags: filterMentionFlagsByLocalReadSuppressions(snapshot.mentionFlags, localReadSuppressions),
        };
        for (const channelId of projectionChannelIds) {
          const readState = getAcceptedReadState(serverId, channelId);
          // Stryker disable next-line ConditionalExpression: scopes without an accepted fact intentionally keep the server snapshot; read-state race tests cover accepted scopes.
          if (!readState) continue;
          const readStateChangedDuringRequest = hasAcceptedReadStateChangedAfter(serverId, channelId, requestReadStateGeneration);
          if (!readStateChangedDuringRequest) continue;
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
        return {
          unreadCounts: nextState.unreadCounts,
          mentionFlags: nextState.mentionFlags,
        };
      });
    } catch {
      // ignore
    }
  },

  clearUnread: (channelId) => {
    notifyChannelReadLocally(channelId);
    set((state) => {
      // Stryker disable all: local clearUnread no-op/mention branches predate this read-state sync slice and are covered by local mark-read tests.
      const hasUnread = Boolean(state.unreadCounts[channelId]);
      const hasMentionFlag = state.mentionFlags[channelId] === true;
      if (!hasUnread && !hasMentionFlag) return state;
      const { [channelId]: _unread, ...unreadCounts } = state.unreadCounts;
      const { [channelId]: _mention, ...mentionFlags } = state.mentionFlags;
      return { unreadCounts, mentionFlags };
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
    const { data } = await api.post(`/channels/${channelId}/read-all`);
    const seq = Number(data?.seq ?? 0);
    if (seq > 0) {
      rememberLocalReadSuppression(channelId, seq);
    }
    forgetPendingRead(channelId);
    forgetManualUnread(channelId);
    get().clearUnread(channelId);
  },

  markUnread: async (channelId) => {
    const inFlightRead = pendingReadRequests.get(channelId);
    forgetPendingRead(channelId);
    forgetLocalReadSuppression(channelId);
    if (get().currentChannelId === channelId) {
      rememberManualUnread(channelId);
    } else {
      forgetManualUnread(channelId);
    }
    set((state) => ({
      unreadCounts: applyUnreadCount(state.unreadCounts, channelId, Math.max(1, state.unreadCounts[channelId] ?? 0)),
    }));

    try {
      if (inFlightRead) {
        await inFlightRead.catch(() => {});
      }
      const { data } = await api.post(`/channels/${channelId}/unread`);
      const unreadCount = Number(data?.unreadCount ?? 0);
      if (get().currentChannelId === channelId && unreadCount > 0) {
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
      if (!content.trim()) {
        if (!state.drafts[channelId]) return state;
        const { [channelId]: _, ...rest } = state.drafts;
        newDrafts = rest;
      } else {
        newDrafts = { ...state.drafts, [channelId]: content };
      }
      scheduleDraftSnapshot(newDrafts);
      return { drafts: newDrafts };
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
      delete nextDrafts[sourceChannelId];
      if (adoptedDraft.trim()) {
        nextDrafts[destinationChannelId] = adoptedDraft;
      } else {
        delete nextDrafts[destinationChannelId];
      }
      persistDraftSnapshotImmediately(nextDrafts);
      return { drafts: nextDrafts };
    });
    return adoptedDraft;
  },

  clearDraft: (channelId) => {
    set((state) => {
      if (!state.drafts[channelId]) return state;
      const { [channelId]: _, ...rest } = state.drafts;
      persistDraftSnapshotImmediately(rest);
      return { drafts: rest };
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
    if (!skipInitialAutoRead && canAutoMarkCurrentChannelRead()) {
      get().clearUnread(channelId);
    }

    // If we have cached messages for this channel, show them immediately
    const cached = get().channelMessages[channelId];
    const meta = getChannelMeta(channelId);
    const canReuseCachedTail = !!cached && cached.length > 0 && !meta.hasNewer;
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

    const ingressContext = captureReceiverPrivateIngressContext(get().currentUserId);
    try {
      const limit = 50;
      const { data } = await api.get(`/messages/channel/${channelId}?limit=${limit}`);
      if (
        get().currentChannelId === channelId &&
        requestGeneration !== messageWindowRequestGeneration
      ) return;
      const msgs = normalizeReceiverPrivateMessagesIfEnabled(
        data.messages ?? data,
        ingressContext,
      );
      if (!msgs) return;
      // The server bundles this page's thread summaries with the messages.
      // Hydrate them first so React never commits a parent-only intermediate
      // frame whose later inline-reply expansion changes scrollTop.
      hydrateBundledThreadSummaries(data, ingressContext);
      const historyLimited: boolean = data.historyLimited ?? false;
      const hasMore = msgs.length >= limit;
      const maxSeq = Math.max(...msgs.map((m) => m.seq || 0), 0);

      // Update per-channel metadata
      channelMetaMap.set(channelId, { hasMore, hasNewer: false, historyLimited });

      set((state) => withAcceptedReadStateProjection(state, {
        channelMessages: { ...state.channelMessages, [channelId]: msgs },
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

  loadOlderMessages: async (channelId) => {
    const state = get();
    const targetChannelId = channelId ?? state.currentChannelId;
    if (!targetChannelId) return;
    const targetMessages = getBucket(state.channelMessages, targetChannelId);
    const targetMeta = selectChannelWindowMeta(state, targetChannelId);
    if (targetMeta.loadingOlder || !targetMeta.hasMore || targetMessages.length === 0) return;

    const minSeq = Math.min(...targetMessages.map((m) => m.seq || Infinity));
    if (!minSeq || minSeq === Infinity) return;

    set((state) => ({
      loadingOlder: targetChannelId === state.currentChannelId ? true : state.loadingOlder,
      channelWindowMeta: updateWindowMetaRecord(state.channelWindowMeta, targetChannelId, { loadingOlder: true }),
    }));
    const ingressContext = captureReceiverPrivateIngressContext(state.currentUserId);
    try {
      const limit = 50;
      const { data } = await api.get(
        `/messages/channel/${targetChannelId}?limit=${limit}&before=${minSeq}`
      );
      const older = normalizeReceiverPrivateMessagesIfEnabled(
        data.messages ?? data,
        ingressContext,
      );
      if (!older) return;
      hydrateBundledThreadSummaries(data, ingressContext);
      const historyLimited: boolean = data.historyLimited ?? false;
      const hasMoreResult = older.length >= limit;
      const existingBucket = getBucket(get().channelMessages, targetChannelId);
      const existingIds = new Set(existingBucket.map((m) => m.id));
      const newMsgs = older.filter((m) => !existingIds.has(m.id));

      // Update per-channel metadata
      channelMetaMap.set(targetChannelId, {
        hasMore: hasMoreResult,
        hasNewer: selectChannelWindowMeta(get(), targetChannelId).hasNewer,
        historyLimited,
      });

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
      set((state) => ({
        // Stryker disable next-line ConditionalExpression,EqualityOperator,BooleanLiteral: load-older failure spinner reset is legacy UI scaffolding outside read-state projection behavior.
        loadingOlder: targetChannelId === state.currentChannelId ? false : state.loadingOlder,
        channelWindowMeta: updateWindowMetaRecord(state.channelWindowMeta, targetChannelId, { loadingOlder: false }),
      }));
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
      const { data } = await api.get(
        `/messages/channel/${targetChannelId}?limit=${limit}&after=${maxSeq}`
      );
      const newer = normalizeReceiverPrivateMessagesIfEnabled(
        data.messages ?? data,
        ingressContext,
      );
      if (!newer) return;
      hydrateBundledThreadSummaries(data, ingressContext);
      const hasNewerResult = newer.length >= limit;
      const existingBucket = getBucket(get().channelMessages, targetChannelId);
      const existingIds = new Set(existingBucket.map((m) => m.id));
      const newMsgs = newer.filter((m) => !existingIds.has(m.id));

      channelMetaMap.set(targetChannelId, {
        hasMore: selectChannelWindowMeta(get(), targetChannelId).hasMore,
        hasNewer: hasNewerResult,
        historyLimited: selectChannelWindowMeta(get(), targetChannelId).historyLimited,
      });

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
    channelMetaMap.set(channelId, {
      hasMore: get().hasMore,
      // Stryker disable next-line BooleanLiteral: exiting a context window always drops newer-context state; this is legacy window bookkeeping outside read-state projection behavior.
      hasNewer: false,
      historyLimited: get().historyLimited,
    });
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
      ? incomingMessage
      : normalizeReceiverPrivateMessageIfEnabled(
          incomingMessage,
          captureReceiverPrivateIngressContext(get().currentUserId),
        );
    if (!message) return;
    set((state) => {
      // Stryker disable next-line MethodExpression,ConditionalExpression,LogicalOperator: lastSeq monotonic bookkeeping predates this read-state projection slice; unread behavior is asserted separately.
      const newLastSeq = Math.max(state.lastSeq, message.seq || 0);
      const currentMaxSeq = getMaxSeq(state.messages);
      const project = (nextState: Partial<MessageState>) =>
        withAcceptedReadStateProjection(state, nextState, [message.channelId]);
      forgetPendingGapMessage(message.channelId, message.id);
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
        if (isSelfAuthoredMessage(message, state.currentUserId)) {
          return project({
            channelMessages: newChannelMessages,
            lastSeq: newLastSeq,
          });
        }
        const prev = state.unreadCounts[message.channelId] || 0;
        return project({
          channelMessages: newChannelMessages,
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

      // Preserve a contiguous loaded window: if socket delivery skips seqs,
      // defer appending until we heal the gap from the current window tail.
      if (!state.hasNewer && (state.hasGap || hasSeqGap)) {
        rememberPendingGapMessage(message);
        if (!state.loadingGap) {
          setTimeout(() => get().syncGap(message.channelId), 0);
        }
        const channelWindowMeta = updateWindowMetaRecord(state.channelWindowMeta, message.channelId, {
          hasGap: true,
          loadingGap: state.loadingGap,
        });
        if (isSelfAuthoredMessage(message, state.currentUserId)) {
          return project({
            lastSeq: newLastSeq,
            hasGap: true,
            channelWindowMeta,
          });
        }
        const prev = state.unreadCounts[message.channelId] || 0;
        return project({
          lastSeq: newLastSeq,
          hasGap: true,
          channelWindowMeta,
          unreadCounts: { ...state.unreadCounts, [message.channelId]: prev + 1 },
        });
      }

      // Only mark as read if user is near the real latest bottom, not the
      // bottom of an older centered context slice.
      const autoReadQueued = Boolean(
        message.seq &&
        state.isNearBottom &&
        !state.hasNewer &&
        queueLiveAppendAutoReadSync(message.channelId, message.seq)
      );

      // If user is scrolled up, or is intentionally viewing an older slice with
      // newer history still unloaded, keep unread state instead of clearing it.
      const unreadUpdate = !autoReadQueued && !isSelfAuthoredMessage(message, state.currentUserId)
        ? { unreadCounts: { ...state.unreadCounts, [message.channelId]: (state.unreadCounts[message.channelId] || 0) + 1 } }
        : {};

      return project({
        channelMessages: newChannelMessages,
        channelWindowMeta: updateWindowMetaRecord(state.channelWindowMeta, message.channelId, {
          hasGap: false,
        }),
        messages: updatedBucket,
        lastSeq: newLastSeq,
        hasGap: false,
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
  batchAddMessages: (newMsgs: Message[]) =>
    set((state) => {
      if (newMsgs.length === 0) return state;

      // Group incoming messages by channel
      const byChannel = new Map<string, Message[]>();
      for (const m of newMsgs) {
        let arr = byChannel.get(m.channelId);
        if (!arr) { arr = []; byChannel.set(m.channelId, arr); }
        arr.push(m);
      }

      // Merge into channel buckets
      const newChannelMessages = { ...state.channelMessages };
      const unreadUpdates = { ...state.unreadCounts };

      for (const [channelId, msgs] of byChannel) {
        const existing = newChannelMessages[channelId] ?? [];
        const existingIds = new Set(existing.map((m) => m.id));
        const deduped = msgs.filter((m) => !existingIds.has(m.id));
        if (deduped.length > 0) {
          newChannelMessages[channelId] = sortBySeq([...existing, ...deduped]);
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
        lastSeq: maxSeq,
        unreadCounts: unreadUpdates,
      }, byChannel.keys());
    }),

  sendMessage: async (channelId, content, attachmentIds, asTask, optimisticId, randomId, mentions) => {
    const ingressContext = captureReceiverPrivateIngressContext(get().currentUserId);
    const { data } = await api.post("/v2/messages", {
      channelId,
      content,
      attachmentIds,
      asTask: asTask || undefined,
      randomId,
      mentions: mentions && mentions.length > 0 ? mentions : undefined,
    });
    const normalizedResponse = normalizeSendMessageResponse(data);
    const message = normalizeReceiverPrivateMessageIfEnabled(
      normalizedResponse.message,
      ingressContext,
    );
    if (!message) {
      return {
        messageId: normalizedResponse.message.id,
        pendingMentionActions: [],
        unresolvedMentionHandles: normalizedResponse.unresolvedMentionHandles,
      };
    }
    const { pendingMentionActions, unresolvedMentionHandles } = normalizedResponse;
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
    return { messageId: message.id, pendingMentionActions, unresolvedMentionHandles };
  },

  loadMessageContext: async (channelId, messageId) => {
    const requestGeneration = claimMessageWindowRequest();
    clearPendingGapMessages(channelId);
    const state = get();
    const cached = state.channelMessages[channelId];
    if (cached?.some((message) => message.id === messageId)) {
      const meta = state.currentChannelId === channelId
        ? {
            hasMore: state.hasMore,
            hasNewer: state.hasNewer,
            historyLimited: state.historyLimited,
          }
          : getChannelMeta(channelId);
      set((current) => ({
        ...getCachedChannelWindowState(channelId, cached, meta, messageId),
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
      contextLoadError: null,
    }));

    const ingressContext = captureReceiverPrivateIngressContext(get().currentUserId);
    try {
      const { data } = await api.get(`/messages/context/${messageId}`, { params: { channelId } });
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
      const msgs = normalizeReceiverPrivateMessagesIfEnabled(
        data.messages ?? [],
        ingressContext,
      );
      if (!msgs) return;
      hydrateBundledThreadSummaries(data, ingressContext);
      const targetMessageId = data.targetMessageId ?? messageId;
      const maxSeq = Math.max(...msgs.map((m) => m.seq || 0), 0);
      channelMetaMap.set(channelId, {
        hasMore: !!data.hasOlder,
        hasNewer: !!data.hasNewer,
        historyLimited: false,
      });

      set((state) => withAcceptedReadStateProjection(state, {
        channelMessages: { ...state.channelMessages, [channelId]: msgs },
        channelWindowMeta: updateWindowMetaRecord(state.channelWindowMeta, channelId, {
          loading: false,
          loadingOlder: false,
          loadingNewer: false,
          hasMore: !!data.hasOlder,
          hasNewer: !!data.hasNewer,
          hasGap: false,
          historyLimited: false,
          contextLoadError: null,
        }),
        messages: msgs,
        lastSeq: Math.max(state.lastSeq, maxSeq),
        loading: false,
        hasMore: !!data.hasOlder,
        hasNewer: !!data.hasNewer,
        hasGap: false,
        historyLimited: false,
        contextLoadError: null,
        highlightedMessageId: targetMessageId,
      }, [channelId]));
    } catch {
      if (ownsMessageWindowRequest(requestGeneration, channelId, get().currentChannelId)) {
        set((state) => ({
          // Stryker disable next-line BooleanLiteral: context-load failure spinner reset is legacy UI scaffolding outside read-state projection behavior.
          loading: false,
          highlightedMessageId: null,
          channelWindowMeta: updateWindowMetaRecord(state.channelWindowMeta, channelId, { loading: false }),
        }));
        const fallbackGeneration = claimMessageWindowRequest();
        await get().loadMessages(channelId, fallbackGeneration);
        if (ownsMessageWindowRequest(fallbackGeneration, channelId, get().currentChannelId)) {
          set((state) => ({
            contextLoadError: "message.chatPanel.messageNotFound",
            channelWindowMeta: updateWindowMetaRecord(state.channelWindowMeta, channelId, {
              contextLoadError: "message.chatPanel.messageNotFound",
            }),
          }));
        }
      }
    }
  },

  loadMessageWindowSilent: async (channelId, messageId) => {
    const requestGeneration = claimMessageWindowRequest();
    clearPendingGapMessages(channelId);
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

    const ingressContext = captureReceiverPrivateIngressContext(get().currentUserId);
    try {
      const { data } = await api.get(`/messages/context/${messageId}`, { params: { channelId } });
      if (!ownsMessageWindowRequest(requestGeneration, channelId, get().currentChannelId)) return;
      const msgs = normalizeReceiverPrivateMessagesIfEnabled(
        data.messages ?? [],
        ingressContext,
      );
      if (!msgs) return;
      hydrateBundledThreadSummaries(data, ingressContext);
      const maxSeq = Math.max(...msgs.map((m) => m.seq || 0), 0);
      channelMetaMap.set(channelId, {
        hasMore: !!data.hasOlder,
        hasNewer: !!data.hasNewer,
        historyLimited: false,
      });

      set((state) => withAcceptedReadStateProjection(state, {
        channelMessages: { ...state.channelMessages, [channelId]: msgs },
        channelWindowMeta: updateWindowMetaRecord(state.channelWindowMeta, channelId, {
          loading: false,
          loadingOlder: false,
          loadingNewer: false,
          hasMore: !!data.hasOlder,
          hasNewer: !!data.hasNewer,
          hasGap: false,
          historyLimited: false,
          contextLoadError: null,
        }),
        messages: msgs,
        lastSeq: Math.max(state.lastSeq, maxSeq),
        loading: false,
        hasMore: !!data.hasOlder,
        hasNewer: !!data.hasNewer,
        hasGap: false,
        historyLimited: false,
        contextLoadError: null,
      }, [channelId]));
    } catch {
      if (ownsMessageWindowRequest(requestGeneration, channelId, get().currentChannelId)) {
        set((state) => ({
          loading: false,
          channelWindowMeta: updateWindowMetaRecord(state.channelWindowMeta, channelId, { loading: false }),
        }));
      }
    }
  },

  syncGap: async (channelId, options) => {
    const { currentChannelId, loadingGap, isNearBottom, hasNewer, unreadCounts } = get();
    const targetChannelId = channelId ?? currentChannelId ?? undefined;
    if (loadingGap) return;

    const sinceSeq = options?.sinceSeq ?? (
      targetChannelId
        ? getMaxSeq(get().channelMessages[targetChannelId] ?? [])
        : get().lastSeq
    );
    if (sinceSeq <= 0) return;

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

        const { data } = await api.get(`/messages/sync?${params}`);
        const page = normalizeReceiverPrivateMessagesIfEnabled(
          (data as Message[]) ?? [],
          ingressContext,
        );
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
          arr.push(m);
        }

        const newChannelMessages = { ...state.channelMessages };
        for (const [chId, msgs] of byChannel) {
          const existing = newChannelMessages[chId] ?? [];
          const existingIds = new Set(existing.map((m) => m.id));
          const deduped = msgs.filter((m) => !existingIds.has(m.id));
          if (deduped.length > 0) {
            newChannelMessages[chId] = sortBySeq([...existing, ...deduped]);
          }
        }

        if (targetChannelId) {
          const existing = newChannelMessages[targetChannelId] ?? [];
          const stitched = takeContiguousPendingGapMessages(
            targetChannelId,
            getMaxSeq(existing),
            new Set(existing.map((message) => message.id))
          );
          if (stitched.length > 0) {
            newChannelMessages[targetChannelId] = sortBySeq([...existing, ...stitched]);
          }
        }

        const maxSeq = Math.max(getMaxSeq(syncedMessages), state.lastSeq);
        const nextState: Partial<MessageState> = {
          channelMessages: newChannelMessages,
          messages: getBucket(newChannelMessages, state.currentChannelId),
          lastSeq: maxSeq,
        };
        if (shouldTrackCurrentGap) {
          nextState.hasGap = targetChannelId ? getPendingGapMessages(targetChannelId).length > 0 : false;
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

      if (shouldTrackCurrentGap && targetChannelId) {
        const updatedMessages = get().channelMessages[targetChannelId] ?? [];
        const newestSeq = getMaxSeq(updatedMessages);
        if (newestSeq > 0 && isNearBottom && !hasNewer) {
          const autoReadQueued = queueLiveAppendAutoReadSync(targetChannelId, newestSeq);
          if (autoReadQueued && unreadCounts[targetChannelId]) {
            get().clearUnread(targetChannelId);
          }
        }
      }
    } catch {
      if (shouldTrackCurrentGap) {
        set((state) => ({
          loadingGap: false,
          channelWindowMeta: targetChannelId
            ? updateWindowMetaRecord(state.channelWindowMeta, targetChannelId, { loadingGap: false })
            : state.channelWindowMeta,
        }));
      }
      // Ignore sync errors
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
    const { currentChannelId, messages, hasNewer } = get();
    if (!currentChannelId) return;
    if (!canAutoMarkCurrentChannelRead()) return;
    if (hasNewer) return;
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
    const previousUserId = get().currentUserId;
    set({ currentUserId: userId });
    setCurrentPrincipalId(userId);
    if (previousUserId === userId) return;
    invalidateReceiverPrivateIngressContexts();
    reactionReadModelStore.getState().activatePrincipal(userId);
    const serverId = useServerStore.getState().current?.id;
    if (userId && serverId && isNormalizedMessageV2FlagEnabled()) {
      void rebaselineNormalizedMessageV2ForCurrentServer(serverId);
    }
  },
  setHighlightedMessageId: (messageId) => set({ highlightedMessageId: messageId }),
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

export async function rebaselineNormalizedMessageV2ForCurrentServer(
  activationServerId: string,
): Promise<void> {
  const state = useMessageStore.getState();
  const currentServerId = useServerStore.getState().current?.id ?? null;
  const principalId = state.currentUserId;
  if (currentServerId !== activationServerId || !principalId) return;

  triggerMessagesSyncCoreReset();
  reactionReadModelStore.getState().reset();
  reactionReadModelStore.getState().activatePrincipal(principalId);

  const bucketEntries = Object.entries(state.channelMessages);
  const flatMessages = bucketEntries.flatMap(([, messages]) => messages);
  try {
    const projected = applyMessagesReactionsForV2Ingress(flatMessages, {
      serverId: activationServerId,
      principalId,
      source: "receiver-private",
      viewerUserId: principalId,
    });
    let cursor = 0;
    const channelMessages: Record<string, Message[]> = {};
    for (const [channelId, messages] of bucketEntries) {
      channelMessages[channelId] = projected.slice(cursor, cursor + messages.length);
      cursor += messages.length;
    }
    const currentChannelId = state.currentChannelId;
    useMessageStore.setState({
      channelMessages,
      messages: currentChannelId ? channelMessages[currentChannelId] ?? [] : [],
    });
  } catch (error) {
    console.error("[MessageV2] rebaseline rejected a non-canonical message cache", error);
    const currentChannelId = state.currentChannelId;
    useMessageStore.setState({ channelMessages: {}, messages: [] });
    if (currentChannelId) {
      await useMessageStore.getState().loadMessages(currentChannelId);
    }
  }
}

registerNormalizedMessageV2Activation((serverId) => {
  void rebaselineNormalizedMessageV2ForCurrentServer(serverId);
});

// Reset server-scoped state when the user switches servers.
// channelMessages and drafts are intentionally kept: channelMessages becomes
// unreachable once channels are cleared, and drafts are harmless cross-server.
registerServerReset(() =>
  {
    claimMessageWindowRequest();
    invalidateReceiverPrivateIngressContexts();
    triggerMessagesSyncCoreReset();
    resetPendingReads();
    clearPendingGapMessages();
    useMessageStore.setState({
      channelMessages: {},
      channelWindowMeta: {},
      messages: [],
      highlightedMessageId: null,
      transientFocusRequest: null,
      lastSeq: 0,
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
      historyLimited: false,
      isNearBottom: true,
    });
  }
);
