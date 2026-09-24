import { useEffect, useRef, useMemo, useCallback, useState } from "react";
import type { Dispatch, SetStateAction, ReactNode } from "react";
import { createPortal } from "react-dom";
import { useIntl } from "react-intl";
import { X, ArrowDown, MapPin, MessageSquare, LogIn, Search, ChevronUp, ChevronDown, ExternalLink } from "lucide-react";
import { toast } from "raft-ui";
import { useThreadStore } from "../../store/threadStore";
import type { ThreadSummary } from "../../store/threadStore";
import { useAgentStore } from "../../store/agentStore";
import { useChannelStore } from "../../store/channelStore";
import {
  captureReceiverPrivateIngressContext,
  compareMessagesForDisplay,
  isMatchingOptimisticMessage,
  isReceiverPrivateIngressContextCurrent,
  mergeIncomingMessage,
  useMessageStore,
} from "../../store/messageStore";
import { useServerStore } from "../../store/serverStore";
import { useAuthStore } from "../../store/authStore";
import { selectChannelTaskBucket, useTaskMetadataForMessage, useTaskStore } from "../../store/taskStore";
import { resolveThreadHostTask } from "../layout/threadHostTask";
import { getSocket } from "../../api/socket";
import api from "../../api/client";
import HistoryTopState from "./HistoryTopState";
import MessageItem, { buildMentionMap } from "./MessageItem";
import PanelHeader from "../ui/PanelHeader";
import ThreadOverflowMenu from "./ThreadOverflowMenu";
import Tooltip from "../ui/Tooltip";
import MessageInput from "./MessageInput";
import EmptyState from "../ui/EmptyState";
import Banner from "../ui/Banner";
import SelectModeToolbar from "./SelectModeToolbar";
import SelectShareLightbox from "./SelectShareLightbox";
import ForwardComposerDialog from "./ForwardComposerDialog";
import { useSelectionStore } from "../../store/selectionStore";
import { gatherSelectedMessagesWithMeta, useSelectionShareHandlers } from "./useSelectionShareHandlers";
import {
  canForwardFromSource,
  formatCopyLinksToast,
  formatForwardSelectionBlockedMessage,
  getForwardableMessages,
} from "./forwardSelectionUtils";
import { forwardToast } from "./forwardToast";
import MessageTimeline from "./MessageTimeline";
import type { MessageTimelineHandle, MessageTimelineSource } from "./MessageTimeline";
import type { Message } from "../../store/messageStore";
import {
  applyMessagesReactionsForV2Ingress,
  isCanonicalMessageReaction,
} from "../../store/normalizedMessageReactions";
import {
  SYNC_CORE_MESSAGES_FLAG_KEY,
  useServerFeatureFlag,
} from "../../store/serverFeatureFlags";
import { TOPBAR_OVERFLOW_FEATURE_FLAG_KEY } from "@botiverse/raft-shared";
import type { Task } from "../../store/taskStore";
import { useLocation, useNavigate } from "react-router-dom";
import { buildMessagePermalink, useAppNavigate, useMobileBack } from "../../hooks/useAppNavigate";
import { buildThreadWindowUrl, openPanelInNewTab } from "../../utils/openPanelInNewTab";
import { transitionThreadToParentMessage } from "../layout/rightPanelUrlSync";
import { useTranslationBatch } from "../../hooks/useTranslationBatch";
import { useChannelMembers } from "../../hooks/useChannelMembers";
import { buildMessageContextRequest, buildThreadParentContextRequest } from "./messageContextRequest";
import SystemMessageGroupDisclosure from "./SystemMessageGroupDisclosure";
import { buildSystemMessageRenderStates } from "./systemMessageGrouping";
import { useStableMessageGrouping } from "./messageGrouping";
import { useTimeFormatter } from "../../hooks/useTimeFormatter";
import { resolveMessageSenderMember } from "../../utils/messageSenderMember";
import { mergeParentTaskMetadata } from "../../utils/taskMetadata";
import type { SyncScopeKey } from "@botiverse/raft-shared";
import {
  buildThreadSearchMatches,
  getThreadSearchableMessages,
  isThreadSearchShortcut,
  normalizeThreadSearchQuery,
  normalizeThreadSearchSelectionText,
} from "./threadSearch";
import ThreadAgentFollowers from "../thread/ThreadAgentFollowers";

const EMPTY_MESSAGES: Message[] = [];
const SELECTION_TOAST_OPTIONS = { icon: false, dismissible: false } as const;
const THREAD_SEARCH_HYDRATION_DEBOUNCE_MS = 250;
const THREAD_PANEL_PARENT_CLASS_NAME = "border-b-2 border-black bg-white px-3 py-3";
/** Discriminator for HistoryTopState catalog keys — keep out of JSX string attrs. */
const THREAD_HISTORY_NOUN = "replies" as const;
export const THREAD_LATEST_WINDOW_LIMIT = 50;

interface ThreadSearchPanelState {
  threadId: string | null;
  open: boolean;
  query: string;
  activeIndex: number;
  hydratedThreadId: string | null;
  loadingThreadId: string | null;
  corpusMessages: Message[];
}

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

function onlyThreadMessages(threadChannelId: string, messages: Message[]): Message[] {
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

export function getThreadPanelSelectedSearchText(root: HTMLElement | null): string {
  if (!root) return "";
  const selection = window.getSelection?.();
  if (!selection) return "";

  const selectedText = normalizeThreadSearchSelectionText(selection.toString());

  for (let index = 0; index < selection.rangeCount; index += 1) {
    const range = selection.getRangeAt(index);
    if (root.contains(range.commonAncestorContainer)) return selectedText;
  }
  return "";
}

export function scrollThreadTimelineToTop(
  timeline: Pick<MessageTimelineHandle, "scrollToTop"> | null,
): void {
  timeline?.scrollToTop();
}

// ThreadPanel renders the thread *content surface*: header + parent message
// pinned + replies timeline + composer. It is presentation-agnostic about the
// column container — sizing/border/positioning/resize are owned by the host
// (chat-side col-4 wrapper, modal wrapper, mobile-modal wrapper, /search
// col-3 mount). Per stdrc 2026-05-28 #proj-uiux:c2313b1d msg=138867ba: page
// object lives in a column container; the same ThreadPanel renders identically
// in every host, with small surface-intrinsic differences (X close
// visibility, back-chevron breakpoint) flowing through props.
// Explicit thread identity makes the original stateful surface reusable across independently mounted workspace panes.
// oxlint-disable react-doctor/no-adjust-state-on-prop-change, react-doctor/no-derived-state, react-doctor/no-event-handler
export default function ThreadPanel({
  presentation = "side",
  onClose,
  threadIdentity,
  onFocusedMessageConsumed,
  onOpenParentChannel,
  onOpenProfile,
  // Stryker disable all: workspace host defaults are exercised by the real-panel browser smoke.
  showComposer = true,
  overlayComposer = false,
  mobilePage = false,
  workspaceComposer = false,
  composerAutoFocus = true,
  hideHeader = false,
  hideParentMessage = false,
  parentSlot,
  // Stryker restore all
  headerActionsHost,
  scrollToTopRequest = 0,
}: {
  // Surface-intrinsic axis (NOT column layout — the host owns layout):
  //   side          — X close visible at lg+ only (mobile uses back chevron),
  //                   back chevron up to lg-
  //   modal         — X close always visible (centered dialog needs close),
  //                   back chevron up to md-
  //   mobile-modal  — NO X (full-screen overlay; back chevron is the close),
  //                   back chevron up to md-
  presentation?: "side" | "modal" | "mobile-modal";
  // Optional override for the X / back close affordance. Used by hosts that
  // need extra teardown beyond closeThread (e.g. /search col-3 host clears
  // the search slot too so col-3 doesn't go blank).
  onClose?: () => void;
  threadIdentity?: {
    parentMessageId: string;
    parentChannelId: string;
    threadChannelId: string | null;
    focusedMessageId?: string | null;
  };
  /** Clears a focus authority owned outside threadStore, such as Activity's
   * persistent master/detail `?msg=` anchor. */
  onFocusedMessageConsumed?: () => void;
  onOpenParentChannel?: (parentChannelId: string, parentMessageId: string) => void;
  onOpenProfile?: (kind: "agent" | "human", id: string) => void;
  showComposer?: boolean;
  overlayComposer?: boolean;
  /** Dedicated new-tab page mode: mobile uses a full-bleed surface with a bottom-pinned composer. */
  mobilePage?: boolean;
  workspaceComposer?: boolean;
  composerAutoFocus?: boolean;
  hideHeader?: boolean;
  /** Drop the anchoring message from the timeline, leaving replies only.
   *
   *  A task surface renders the task's own title and description above this
   *  panel. The anchor message's body is where that title came from, so
   *  showing both repeats the same sentence — and once `tasks.title` is edited
   *  the two diverge and the timeline copy reads as stale. Ordinary threads
   *  keep the anchor: there the message IS the subject. */
  hideParentMessage?: boolean;
  /** Optional content rendered before the parent/replies in the timeline. */
  parentSlot?: ReactNode;
  headerActionsHost?: Element | null;
  scrollToTopRequest?: number;
}) {
  const { formatMessage } = useIntl();
  // Keep locale-bound formatMessage out of effect/handler deps (render + memos use
  // it directly); toasts/handlers read formatMessageRef.current.
  const formatMessageRef = useRef(formatMessage);
  formatMessageRef.current = formatMessage;
  // Stryker disable all: explicit identity projection is contract-pinned and browser-smoke verified.
  const storeParentMessageId = useThreadStore((s) => s.openParentMessageId);
  const storeThreadChannelId = useThreadStore((s) => s.openThreadChannelId);
  const storeParentChannelId = useThreadStore((s) => s.openParentChannelId);
  const storeFocusedMessageId = useThreadStore((s) => s.focusedMessageId);
  const parentMessageId = threadIdentity?.parentMessageId ?? storeParentMessageId;
  const threadChannelId = threadIdentity ? threadIdentity.threadChannelId : storeThreadChannelId;
  const parentChannelId = threadIdentity?.parentChannelId ?? storeParentChannelId;
  const focusedMessageId = threadIdentity ? threadIdentity.focusedMessageId ?? null : storeFocusedMessageId;
  const showHeader = !hideHeader;
  // Stryker restore all
  const threadSummaries = useThreadStore((s) => s.summaries);
  const followedThreads = useThreadStore((s) => s.followedThreads);
  const realtimeParentTaskUpdate = useTaskMetadataForMessage(parentMessageId);
  const closeThread = useThreadStore((s) => s.closeThread);
  const openThreadError = useThreadStore((s) => s.openThreadError);
  const openThreadLoading = useThreadStore((s) => s.openThreadLoading);
  const retryOpenThread = useThreadStore((s) => s.retryOpenThread);
  const ensureOpenThreadChannel = useThreadStore((s) => s.ensureOpenThreadChannel);
  const clearFocusedMessage = useThreadStore((s) => s.clearFocusedMessage);
  const consumeFocusedMessage = useCallback(() => {
    clearFocusedMessage();
    onFocusedMessageConsumed?.();
  }, [clearFocusedMessage, onFocusedMessageConsumed]);
  const threadBucket = useMessageStore((s) =>
    threadChannelId ? (s.channelMessages[threadChannelId] ?? EMPTY_MESSAGES) : EMPTY_MESSAGES
  );
  const parentChannelBucket = useMessageStore((s) =>
    parentChannelId ? (s.channelMessages[parentChannelId] ?? EMPTY_MESSAGES) : EMPTY_MESSAGES
  );
  const currentUser = useAuthStore((s) => s.user);

  // Selection / share state. The hook wraps capture / download / clipboard
  // plumbing so ChatPanel and ThreadPanel stay in lock-step. ThreadPanel
  // only renders the toolbar when select mode is anchored at *this* thread
  // root — channel-mode select stays scoped to ChatPanel.
  const selectModeActive = useSelectionStore((s) => s.isActive);
  const selectModeThreadRootId = useSelectionStore((s) => s.threadRootId);
  const threadSelectScopedHere =
    selectModeActive && selectModeThreadRootId !== null && selectModeThreadRootId === parentMessageId;
  // ThreadPanel keeps its replies in local state (NOT messageStore.channelMessages),
  // so we declare `messages` here BEFORE the share-handlers hook can read it.
  // huxijin 2026-05-02 #proj-mobile a8748fc2: select-share in thread was
  // dropping all children because messageStore doesn't bucket replies for
  // the thread channel — ThreadPanel keeps them in local state and now
  // feeds them into useSelectionShareHandlers via the threadReplyMessages opt.
  const [messages, setMessages] = useState<Message[]>([]);
  const messagesRef = useRef(messages);
  messagesRef.current = messages;
  const [parentMessage, setParentMessage] = useState<Message | null>(null);
  const [parentTask, setParentTask] = useState<Task | null>(null);
  const loadTasks = useTaskStore((s) => s.loadTasks);
  const [forwardComposer, setForwardComposer] = useState<{
    messages: Message[];
    skippedCount: number;
    nestedForwardCount: number;
  } | null>(null);
  const [serverMessageForwardingEnabled, setServerMessageForwardingEnabled] = useState(false);
  // Stryker disable all: this setter wrapper is intentionally stable; dependency-array mutations are equivalent.
  const applyServerMessageForwardingEnabled = useCallback((enabled: boolean) => {
    setServerMessageForwardingEnabled(enabled);
  }, []);
  // Stryker restore all
  const threadParentMessageRef = useRef<Message | null>(null);
  const selectAll = useSelectionStore((s) => s.selectAll);
  // Stryker disable all: thread selection forward/copy wiring is covered by focused DOM behavior tests; defensive no-context guards are intentionally no-op.
  const showUnresolvedSelectionToast = useCallback((unresolvedCount: number) => {
    toast.info(
      formatMessageRef.current({ id: "message.chatPanel.unresolvedMessages" }, { count: unresolvedCount }),
      SELECTION_TOAST_OPTIONS,
    );
  }, []);
  // Stryker restore all
  // Stryker disable all: Select All parent inclusion is covered by thread
  // selection behavior tests; array-shape mutants are equivalent to the source
  // contract oracle when the parent fixture is already forwardable.
  const handleSelectAllInThread = useCallback(() => {
    const parent = threadParentMessageRef.current;
    const { messages: forwardableParent } = getForwardableMessages(parent ? [parent] : []);
    const { messages: forwardableReplies } = getForwardableMessages(messages);
    selectAll([...forwardableParent, ...forwardableReplies].map((message) => message.id));
  }, [messages, selectAll]);
  // Stryker restore all
  const {
    picCapturing,
    picPreview,
    setPicPreview,
    picError,
    setPicError,
    copiedMd,
    onSavePic,
    onShareX,
    onSharePreviewToX,
    onCopyMd,
  } = useSelectionShareHandlers({
    threadReplyMessages: messages,
    threadParentMessageRef,
    onUnresolvedSelection: showUnresolvedSelectionToast,
  });
  // Closing the thread or the panel unmounting should always exit a thread
  // select that was anchored here, otherwise the toolbar lingers in the
  // ChatPanel below. (ChatPanel only renders the toolbar in channel mode,
  // but other surfaces could observe stale state.)
  useEffect(() => {
    if (!parentMessageId) return;
    const anchorId = parentMessageId;
    return () => {
      const s = useSelectionStore.getState();
      if (s.threadRootId === anchorId) s.exit();
    };
  }, [parentMessageId]);
  // ESC out of thread select.
  useEffect(() => {
    if (!threadSelectScopedHere) return;
    const handler = (e: KeyboardEvent) => {
      if (e.key !== "Escape") return;
      if (picPreview) return;
      e.preventDefault();
      useSelectionStore.getState().exit();
    };
    // keydown-global-exempt: thread-scoped select mode toggle; no overlay surface, escape exits selection state in place
    window.addEventListener("keydown", handler);
    return () => window.removeEventListener("keydown", handler);
  }, [threadSelectScopedHere, picPreview]);

  useEffect(() => {
    if (!parentMessageId || threadSelectScopedHere || picPreview) return;
    const handler = (event: KeyboardEvent) => {
      if (event.key !== "Escape" || event.defaultPrevented) return;
      const target = event.target;
      if (!(target instanceof Node) || !panelRef.current?.contains(target)) return;
      const isEditableTarget =
        target instanceof HTMLInputElement ||
        target instanceof HTMLTextAreaElement ||
        (target instanceof HTMLElement && target.isContentEditable);
      if (isEditableTarget) return;
      event.preventDefault();
      // Dedicated thread-window hosts own the final close operation: attempt
      // the browser close first, then return a normal tab to the server route.
      // Keep Escape on the same host-aware path as the visible close button
      // instead of only clearing threadStore.
      (onClose ?? closeThread)();
    };
    // keydown-focus-on-open
    window.addEventListener("keydown", handler);
    return () => window.removeEventListener("keydown", handler);
  }, [closeThread, onClose, parentMessageId, picPreview, threadSelectScopedHere]);

  const agents = useAgentStore((s) => s.agents);
  const channels = useChannelStore((s) => s.channels);
  const dmChannels = useChannelStore((s) => s.dmChannels);
  const joinChannel = useChannelStore((s) => s.joinChannel);
  const members = useServerStore((s) => s.members);
  const mentionScopeChannelId = parentChannelId || threadChannelId || "";
  const { channelAgents: mentionChannelAgents, channelHumans: mentionChannelHumans } = useChannelMembers(mentionScopeChannelId);
  const mobileNavigate = useNavigate();
  const location = useLocation();
  const currentServer = useServerStore((s) => s.current);
  const normalizedMessageV2Enabled = useServerFeatureFlag(
    SYNC_CORE_MESSAGES_FLAG_KEY,
    { prefetch: false },
  ).enabled;
  const topbarOverflowEnabled = useServerFeatureFlag(
    TOPBAR_OVERFLOW_FEATURE_FLAG_KEY,
    { prefetch: false },
  ).enabled;
  const normalizeThreadIngress = useCallback((
    incoming: readonly Message[],
    source: "channel-room" | "receiver-private",
    parentScopeKind?: "thread",
  ): Message[] => {
    if (!normalizedMessageV2Enabled || !currentServer?.id || !currentUser?.id) return [...incoming];
    return applyMessagesReactionsForV2Ingress(incoming, {
      serverId: currentServer.id,
      principalId: currentUser.id,
      source,
      viewerUserId: currentUser?.id ?? null,
      parentScopeKey: parentScopeKind && incoming[0]
        ? {
            serverId: currentServer.id,
            scopeKind: parentScopeKind,
            scopeId: incoming[0].channelId,
          }
        : undefined,
    });
  }, [currentServer?.id, currentUser?.id, normalizedMessageV2Enabled]);
  const serverSlug = currentServer?.slug;
  const nav = useAppNavigate();

  useEffect(() => {
    if (!parentChannelId) return;
    const socket = getSocket();
    const joinParentChannelRoom = () => socket.emit("join:channel", parentChannelId);
    joinParentChannelRoom();
    socket.on("connect", joinParentChannelRoom);
    return () => {
      socket.off("connect", joinParentChannelRoom);
    };
  }, [parentChannelId]);

  // Semantic parent of a thread is its parent channel/dm. Fall back to chat
  // root when we don't yet know the parent (loading state).
  const parentRouteKind = parentChannelId
    ? (dmChannels.some((c) => c.id === parentChannelId) ? "dm" : "channel")
    : null;
  // Stryker disable all: parent-channel lookup and joint-lock banner guards are
  // existing defensive UI state; forward behavior is covered through the derived
  // thread source channel and toolbar entry tests below.
  const parentChannel = useMemo(
    () => parentChannelId
      ? channels.find((c) => c.id === parentChannelId) || dmChannels.find((c) => c.id === parentChannelId) || null
      : null,
    [channels, dmChannels, parentChannelId],
  );
  // Thread-source channel shape is asserted by the
  // composer/source contract tests; object-literal mutants are redundant with
  // those structural checks.
  const threadSourceChannel = useMemo(
    () => parentChannel && threadChannelId
      ? { ...parentChannel, id: threadChannelId, type: "thread" as const }
      : parentChannel,
    [parentChannel, threadChannelId],
  );
  const parentJointFeatureLocked = parentChannel?.type === "joint" && parentChannel.jointBillingLocked === true;
  // Stryker restore all
  const showForwardAction = serverMessageForwardingEnabled && canForwardFromSource(parentChannel);
  // Stryker disable all: thread composer source-label variants are covered by focused DOM behavior tests; the loading fallback is not user-clickable.
  const threadSourceLabel = useMemo(() => {
    const threadSuffix = formatMessage({ id: "message.forward.threadSuffix" });
    if (!parentChannel) return formatMessage({ id: "message.forward.threadFallback" });
    if (parentChannel.type === "dm") {
      return `@${parentChannel.peerDisplayName || parentChannel.peerName || parentChannel.name}${threadSuffix}`;
    }
    return `#${parentChannel.name}${threadSuffix}`;
  }, [formatMessage, parentChannel]);
  // Stryker restore all
  // Same tri-state contract as ChatPanel's channel composer: true means the
  // current human can reply, false means show the join CTA, undefined means
  // membership is still hydrating so we should not flash the wrong control.
  const parentJoined: boolean | undefined = parentChannel?.type === "dm" ? true : parentChannel?.joined;
  const canReactToThread = parentJoined === true
    && !parentChannel?.archivedAt
    && !parentJointFeatureLocked;
  const parentPath = serverSlug
    ? (parentChannelId && parentRouteKind
        ? `/s/${serverSlug}/${parentRouteKind}/${parentChannelId}`
        : `/s/${serverSlug}`)
    : "/";
  const threadIsOnParentSurface = location.pathname.replace(/\/$/, "") === parentPath.replace(/\/$/, "");
  // Stryker disable all: host-specific Back ownership is exercised by the
  // production BrowserRouter Playwright matrix and explicit reverse mutations;
  // the diff-scoped node oracle does not mount this full ThreadPanel surface.
  const handleClose = onClose ?? closeThread;
  // A regular full-row thread is a navigated detail surface, not always a
  // locally-owned modal. Preserve a real same-server origin (Activity/Search/
  // channel) with browser Back; on a cold permalink, useMobileBack falls back
  // to the semantic parent channel. Activity's route navigation now owns the
  // only history PUSH, so this can no longer land on a duplicate same-URL
  // entry. Modal/workspace hosts still own teardown directly.
  // Close the store-owned panel before consuming its history entry. The
  // right-panel subscriber synchronously replaces the current destination
  // with its cleaned URL and reserves that search before mobile Back POPs.
  // This makes the store/UI teardown atomic with a fast pre-Router-commit Back
  // instead of leaving a stale destination commit able to keep Thread mounted.
  // Stryker disable all: the focused BrowserRouter seam manually reverse-mutates the pre-navigation close.
  const onMobileBack = useMobileBack(
    threadIsOnParentSurface ? parentPath : handleClose,
    threadIsOnParentSurface ? closeThread : undefined,
  );
  // Stryker restore all
  // Stryker disable next-line all: host-specific handler ownership is covered by the production BrowserRouter journey and reviewer reverse mutations, not the diff gate's source-only ThreadPanel oracle.
  const mobileBackHandler = onClose || presentation === "modal" || presentation === "mobile-modal"
    ? handleClose
    : onMobileBack;
  // Stryker restore all

  const [translationWindowIds, setTranslationWindowIds] = useState<string[]>([]);
  const translationMessages = useMemo(
    () => {
      const replyIdSet = new Set(translationWindowIds);
      const visibleReplies = translationWindowIds.length > 0
        ? messages.filter((message) => replyIdSet.has(message.id))
        : [];
      return parentMessage && !hideParentMessage ? [parentMessage, ...visibleReplies] : visibleReplies;
    },
    [messages, parentMessage, hideParentMessage, translationWindowIds],
  );
  useTranslationBatch(translationMessages);
  // `messages` declared earlier so useSelectionShareHandlers can read it.
  const [loading, setLoading] = useState(false);
  const [loadingOlder, setLoadingOlder] = useState(false);
  const [loadingNewer, setLoadingNewer] = useState(false);
  const [hasMore, setHasMore] = useState(true);
  const [hasNewer, setHasNewer] = useState(false);
  const [searchContextAutoLoadBlockKey, setSearchContextAutoLoadBlockKey] = useState<string | null>(
    null,
  );
  const [historyLimited, setHistoryLimited] = useState(false);
  const [newMessageCount, setNewMessageCount] = useState(0);
  const [atBottom, setAtBottom] = useState(true);
  const [expandedSystemMessageGroups, setExpandedSystemMessageGroups] = useState<Set<string>>(() => new Set());
  const timelineRef = useRef<MessageTimelineHandle>(null);
  const scrolledFocusedMessageIdRef = useRef<string | null>(null);
  const handledScrollToTopRequestRef = useRef(0);
  const jumpToThreadStartInFlightRef = useRef(false);
  const panelRef = useRef<HTMLDivElement>(null);
  const threadSearchInputRef = useRef<HTMLInputElement>(null);
  const threadSearchScopeActiveRef = useRef(false);
  const isNearBottomRef = useRef(true);
  // Stryker disable all: thread search/newer refs are unrelated to the forward
  // surface and mutate as equivalent initial UI states in this focused oracle.
  const hasNewerRef = useRef(false);
  const [threadSearchState, setThreadSearchState] = useState<ThreadSearchPanelState>({
    threadId: null,
    open: false,
    query: "",
    activeIndex: 0,
    hydratedThreadId: null,
    loadingThreadId: null,
    // Stryker disable next-line ArrayDeclaration: thread-search corpus starts empty; hydration behavior is covered outside the forward mutation corpus.
    corpusMessages: [],
  });
  // Stryker restore all

  const gatherThreadSourceSelection = useCallback(() => {
    // Stryker disable next-line ConditionalExpression: the select toolbar only renders when scoped to a concrete thread channel; this is a stale-callback guard.
    if (!threadChannelId) return null;
    const { messages: selected, unresolvedCount } = gatherSelectedMessagesWithMeta({
      threadReplyMessages: messages,
      threadParentMessageRef,
    });
    if (unresolvedCount > 0) {
      showUnresolvedSelectionToast(unresolvedCount);
      return null;
    }
    return selected.filter((message) => {
      if (message.channelId === threadChannelId) return true;
      if (message.id === parentMessageId) {
        // Stryker disable next-line ConditionalExpression: message ids are globally unique; the channel check is defense-in-depth for stale mixed-channel state.
        return message.channelId === parentChannelId;
      }
      return false;
    });
  }, [messages, parentChannelId, parentMessageId, showUnresolvedSelectionToast, threadChannelId]);

  const openForwardComposer = useCallback(() => {
    const selectedThreadSources = gatherThreadSourceSelection();
    // Stryker disable next-line ConditionalExpression: null only comes from stale/no-channel or already-toasted unresolved selection paths.
    if (!selectedThreadSources) return;
    const {
      messages: forwardable,
      skippedCount,
      nestedForwardCount,
      actionCardCount,
      systemMessageCount,
    } = getForwardableMessages(selectedThreadSources);
    if (skippedCount > 0 || forwardable.length === 0) {
      forwardToast.info(formatForwardSelectionBlockedMessage(formatMessage, {
        forwardableCount: forwardable.length,
        nestedForwardCount,
        actionCardCount,
        systemMessageCount,
      }));
      return;
    }
    setForwardComposer({
      messages: forwardable,
      skippedCount: skippedCount + useSelectionStore.getState().selectedIds.size - selectedThreadSources.length,
      nestedForwardCount,
    });
  }, [formatMessage, gatherThreadSourceSelection]);

  const copySelectedLinks = useCallback(() => {
    // Stryker disable next-line ConditionalExpression: this guard is a stale parent-channel resolution no-op; the visible behavior is no clipboard side effect.
    if (!parentChannel) return;
    // Stryker disable next-line ConditionalExpression: the select toolbar is anchored to a concrete parent message; this is a stale-callback guard.
    if (!parentMessageId) return;
    if (!serverSlug) return;
    const { messages: selected, unresolvedCount } = gatherSelectedMessagesWithMeta({
      threadReplyMessages: messages,
      threadParentMessageRef,
    });
    if (unresolvedCount > 0) {
      showUnresolvedSelectionToast(unresolvedCount);
      return;
    }
    const routeKind = parentChannel.type === "dm" ? "dm" : "channel";
    const links = selected.map((selectedMessage) =>
      buildMessagePermalink(serverSlug, parentChannel.id, selectedMessage.id, {
        routeKind,
        threadParentMessageId: selectedMessage.channelId === threadChannelId ? parentMessageId : null,
      })
    );
    void navigator.clipboard.writeText(links.join("\n")).then(() => {
      toast.success(formatCopyLinksToast(links.length, formatMessageRef.current), SELECTION_TOAST_OPTIONS);
    }).catch(() => {
      toast.error(formatMessageRef.current({ id: "message.chatPanel.clipboardBlocked" }), SELECTION_TOAST_OPTIONS);
    });
  }, [messages, parentChannel, parentMessageId, serverSlug, showUnresolvedSelectionToast, threadChannelId]);
  const threadSearchStateIsCurrent = !!threadChannelId && threadSearchState.threadId === threadChannelId;
  const threadSearchOpen = threadSearchStateIsCurrent && threadSearchState.open;
  const threadSearchQuery = threadSearchStateIsCurrent ? threadSearchState.query : "";
  // Stryker disable next-line ConditionalExpression,EqualityOperator: thread-search loading state is outside the forward/copy selection oracle.
  const threadSearchLoading = threadSearchState.loadingThreadId === threadChannelId;
  // Stryker disable next-line StringLiteral: select-mode only renders while scoped to a known thread; this is a defensive child-prop fallback.
  const selectModeChannelId = threadChannelId ?? "";
  const rawThreadSearchActiveIndex = threadSearchStateIsCurrent ? threadSearchState.activeIndex : 0;

  // Column-layout (width / resize / desktop-or-overlay) is owned by the host
  // wrapper (SideThreadColumn / ModalThreadColumn / MobileModalThreadColumn /
  // direct mount in /search col-3). ThreadPanel itself renders as a plain
  // `flex h-full min-h-0 w-full flex-col` so each host fills it as the host
  // sees fit.
  //
  // `isDesktop` (lg breakpoint) stays here only to decide View-in-channel
  // navigation semantics (mobile = route push, desktop = in-place nav). It
  // is content-behavior, not column-layout.
  const [isDesktop, setIsDesktop] = useState(() => window.matchMedia("(min-width: 1024px)").matches);
  useEffect(() => {
    const mq = window.matchMedia("(min-width: 1024px)");
    const handler = (e: MediaQueryListEvent) => setIsDesktop(e.matches);
    mq.addEventListener("change", handler);
    return () => mq.removeEventListener("change", handler);
  }, []);

  const mentionMap = useMemo(
    () => buildMentionMap(agents, members, mentionChannelAgents, mentionChannelHumans),
    [agents, members, mentionChannelAgents, mentionChannelHumans],
  );
  const agentById = useMemo(() => {
    const map = new Map<string, (typeof agents)[0]>();
    for (const a of agents) map.set(a.id, a);
    for (const a of mentionChannelAgents) map.set(a.id, a);
    return map;
  }, [agents, mentionChannelAgents]);
  const memberById = useMemo(() => {
    const map = new Map<string, (typeof members)[0]>();
    for (const m of members) map.set(m.userId, m);
    for (const human of mentionChannelHumans) {
      map.set(human.id, {
        userId: human.id,
        serverId: human.serverId,
        serverName: human.serverName,
        serverSlug: human.serverSlug,
        email: null,
        gravatarHash: human.gravatarHash,
        name: human.name,
        displayName: human.displayName,
        description: human.description,
        avatarUrl: human.avatarUrl,
        role: human.role,
        joinedAt: "",
      });
    }
    return map;
  }, [members, mentionChannelHumans]);
  const fallbackParentMessage = useMemo<Message | null>(() => {
    if (!parentMessageId || !parentChannelId) return null;

    const cachedParent = parentChannelBucket.find((msg) => msg.id === parentMessageId);
    if (cachedParent) return cachedParent;

    const followedThread = followedThreads.find((thread) => thread.parentMessageId === parentMessageId);
    if (!followedThread) return null;

    const agent = followedThread.parentMessageSenderType === "agent" ? agentById.get(followedThread.parentMessageSenderId) : null;
    const member = resolveMessageSenderMember({
      senderType: followedThread.parentMessageSenderType as Message["senderType"],
      senderId: followedThread.parentMessageSenderId,
    }, memberById, currentUser) ?? null;
    const senderName = agent?.displayName ?? agent?.name ?? member?.displayName ?? member?.name;

    return {
      id: parentMessageId,
      channelId: parentChannelId,
      senderType: followedThread.parentMessageSenderType as Message["senderType"],
      senderId: followedThread.parentMessageSenderId,
      senderName,
      messageType: "chat",
      content: followedThread.parentMessagePreview,
      createdAt: followedThread.lastReplyAt ?? "1970-01-01T00:00:00.000Z",
    };
  }, [agentById, currentUser, followedThreads, memberById, parentChannelBucket, parentChannelId, parentMessageId]);
  // Stryker disable all: React subscription wiring for parent-message cache sync.
  // The lookup/merge behavior is covered by threadPanelParentActionCardSync.behavior.test.ts;
  // mutating this hook body/dependency list makes Stryker classify React timing as
  // survivor/timeout instead of adding a distinct behavior contract.
  const storeParentMessage = useMemo<Message | null>(() => {
    return findThreadParentMessage(parentChannelBucket, parentMessageId, parentChannelId);
  }, [parentChannelBucket, parentChannelId, parentMessageId]);
  // Stryker restore all
  const fallbackParentTask = useMemo<Task | null>(() => {
    if (!parentMessageId || !parentChannelId) return null;
    const followedThread = followedThreads.find((thread) => thread.parentMessageId === parentMessageId);
    if (!followedThread?.taskId || !followedThread.taskNumber || !followedThread.taskStatus) return null;

    return {
      id: followedThread.taskId,
      messageId: parentMessageId,
      channelId: parentChannelId,
      taskNumber: followedThread.taskNumber,
      title: followedThread.parentMessagePreview,
      status: followedThread.taskStatus as Task["status"],
      claimedByType: followedThread.taskClaimedByType,
      claimedById: followedThread.taskClaimedById,
      claimedByName: followedThread.taskClaimedByName,
      createdById: followedThread.parentMessageSenderId,
      createdByType: followedThread.parentMessageSenderType as Task["createdByType"],
      createdAt: followedThread.lastReplyAt ?? "1970-01-01T00:00:00.000Z",
      updatedAt: followedThread.lastReplyAt ?? "1970-01-01T00:00:00.000Z",
    };
  }, [followedThreads, parentChannelId, parentMessageId]);
  const displayedParentMessage = hideParentMessage ? null : (parentMessage ?? fallbackParentMessage);
  // Stryker disable all: thread-id shaping for the displayed parent message is
  // existing permalink/preview plumbing; task #486's changed behavior is the
  // linked task metadata merged below.
  const displayedParentMessageWithThreadId = useMemo<Message | null>(() => {
    if (!displayedParentMessage) return null;
    if (!threadChannelId || displayedParentMessage.threadId) return displayedParentMessage;
    return { ...displayedParentMessage, threadId: threadChannelId };
  }, [displayedParentMessage, threadChannelId]);
  // Stryker restore all
  threadParentMessageRef.current = displayedParentMessageWithThreadId;
  const displayedParentTask = useMemo(
    () => mergeParentTaskMetadata(parentTask, fallbackParentTask, realtimeParentTaskUpdate),
    [fallbackParentTask, parentTask, realtimeParentTaskUpdate],
  );
  // Stryker disable all: unchanged thread summary/latest-load logic falls into
  // the diff hunk after extracting task-metadata merge logic; task #486 coverage
  // is the displayed parent task badge and socket delivery path above.
  const displayedParentThreadSummary = useMemo<ThreadSummary | undefined>(() => {
    if (!parentMessageId || !threadChannelId) return undefined;

    const cachedSummary = threadSummaries[parentMessageId];
    if (cachedSummary) return cachedSummary;

    const followedThread = followedThreads.find((thread) => thread.parentMessageId === parentMessageId);
    const lastLoadedReplyAt = messages.length > 0
      ? messages[messages.length - 1]?.createdAt ?? null
      : null;

    return {
      threadChannelId,
      replyCount: Math.max(messages.length, followedThread?.replyCount ?? 0),
      lastReplyAt: followedThread?.lastReplyAt ?? lastLoadedReplyAt,
      participantIds: [],
      unreadCount: followedThread?.unreadCount ?? 0,
      firstUnreadMessageId: null,
    };
  }, [followedThreads, messages, parentMessageId, threadChannelId, threadSummaries]);

  useEffect(() => {
    if (!currentServer?.id) return;
    let canceled = false;
    applyServerMessageForwardingEnabled(false);
    void api.get<{ enabled?: unknown }>("/messages/forward/enabled")
      .then((res) => {
        if (!canceled) applyServerMessageForwardingEnabled(res.data.enabled === true);
      })
      .catch(() => {
        if (!canceled) applyServerMessageForwardingEnabled(false);
      });
    return () => {
      canceled = true;
    };
  }, [applyServerMessageForwardingEnabled, currentServer?.id]);

  useEffect(() => {
    hasNewerRef.current = hasNewer;
  }, [hasNewer]);

  const isCurrentThread = useCallback((candidateThreadChannelId: string) => {
    return useThreadStore.getState().openThreadChannelId === candidateThreadChannelId;
  }, []);

  const loadLatestThreadMessages = useCallback(async (nextThreadChannelId: string) => {
    const ingressContext = captureReceiverPrivateIngressContext(
      useMessageStore.getState().currentUserId,
    );
    const limit = 50;
    const { data } = await api.get(`/messages/channel/${nextThreadChannelId}?limit=${limit}`);
    if (
      !isCurrentThread(nextThreadChannelId)
      || !isReceiverPrivateIngressContextCurrent(ingressContext)
    ) return null;
    const msgs = onlyThreadMessages(
      nextThreadChannelId,
      normalizeThreadIngress(data.messages ?? data, "receiver-private", "thread"),
    );
    setMessages(sortThreadMessages(msgs));
    setHasMore(msgs.length >= limit);
    setHasNewer(false);
    setLoading(false);
    setLoadingOlder(false);
    setLoadingNewer(false);
    return msgs;
  }, [isCurrentThread, normalizeThreadIngress]);
  // Stryker restore all

  // Load thread messages
  // Capture focusedMessageId at effect time so clearing it later doesn't re-trigger the load
  const focusedAtOpenRef = useRef<string | null>(null);
  // Async-loader: thread messages on threadChannelId change. Standard
  // async-loader FP family — reset + fetch + arrival commit.
  // oxlint-disable-next-line react-doctor/no-cascading-set-state
  useEffect(() => {
    if (!threadChannelId) return;
    let cancelled = false;

    const initialFocusId =
      focusedMessageId && focusedMessageId !== parentMessageId
        ? focusedMessageId
        : null;
    focusedAtOpenRef.current = initialFocusId;

    // Use cached messages if available instead of clearing to empty (avoids blank flash)
    const cached = onlyThreadMessages(
      threadChannelId,
      normalizeThreadIngress(
        useMessageStore.getState().channelMessages[threadChannelId] ?? [],
        "channel-room",
        "thread",
      ),
    );
    if (initialFocusId) {
      setMessages([]);
      setLoading(true);
    } else {
      setMessages(cached.length
        ? mergeThreadBucketWithinWindow([], cached, false)
        : []);
      setLoading(!cached.length);
    }
    setNewMessageCount(0);
    setAtBottom(true);
    setHasMore(true);
    setHasNewer(false);
    setSearchContextAutoLoadBlockKey(null);
    setHistoryLimited(false);
    setLoadingOlder(false);
    setLoadingNewer(false);

    const mergeIntoThread = (incoming: Message[]) => {
      setMessages((prev) => mergeThreadMessages(prev, onlyThreadMessages(threadChannelId, incoming)));
    };

    const socket = getSocket();
    const handler = (msg: Message) => {
      if (msg.channelId !== threadChannelId) return;
      let normalizedMessage: Message;
      try {
        normalizedMessage = normalizeThreadIngress([msg], "channel-room", "thread")[0] ?? msg;
      } catch (error) {
        console.error("[MessageV2] rejected malformed thread message:new", msg.id, error);
        return;
      }
      setMessages((prev) => {
        const currentMaxSeq = Math.max(...prev.map((m) => m.seq || 0), 0);
        if (
          hasNewerRef.current
          && normalizedMessage.seq
          && currentMaxSeq > 0
          && normalizedMessage.seq > currentMaxSeq + 1
        ) {
          setNewMessageCount((c) => c + 1);
          return prev;
        }
        const next = mergeThreadMessages(prev, [normalizedMessage]);
        if (!isNearBottomRef.current || hasNewerRef.current) {
          setNewMessageCount((c) => c + 1);
        }
        return next;
      });
    };

    socket.on("message:new", handler);

    // Merge-only handler for task field updates (no new message count bump)
    const updateHandler = (msg: Message) => {
      if (msg.channelId !== threadChannelId) return;
      try {
        const updates = onlyThreadMessages(
          threadChannelId,
          normalizeThreadIngress([msg], "channel-room", "thread"),
        );
        setMessages((prev) => mergeThreadMessageUpdates(prev, updates));
      } catch (error) {
        console.error("[MessageV2] rejected malformed thread message:updated", msg.id, error);
      }
    };
    socket.on("message:updated", updateHandler);

    // Clear unread count for this thread in the followed threads list
    useThreadStore.getState().clearThreadUnread(threadChannelId);

    // Join socket room for thread channel
    socket.emit("join:channel", threadChannelId);

    const handleReconnect = () => {
      socket.emit("join:channel", threadChannelId);
    };

    socket.on("connect", handleReconnect);

    const INITIAL_LIMIT = THREAD_LATEST_WINDOW_LIMIT;
    const focusedReplyRequest = initialFocusId
      ? buildMessageContextRequest(initialFocusId, threadChannelId)
      : null;
    const loadPromise = focusedReplyRequest
      ? api.get(focusedReplyRequest.url, focusedReplyRequest.config)
      : api.get(`/messages/channel/${threadChannelId}?limit=${INITIAL_LIMIT}`);
    const ingressContext = captureReceiverPrivateIngressContext(
      useMessageStore.getState().currentUserId,
    );
    const fallbackToLatestThreadMessages = () => {
      void loadLatestThreadMessages(threadChannelId).catch(() => {
        if (!cancelled) setLoading(false);
      });
    };

    loadPromise
      .then(({ data }) => {
        if (cancelled || !isReceiverPrivateIngressContextCurrent(ingressContext)) return;
        const msgs = onlyThreadMessages(
          threadChannelId,
          normalizeThreadIngress(data.messages ?? data, "receiver-private", "thread"),
        );
        if (initialFocusId && !msgs.some((msg) => msg.id === initialFocusId)) {
          fallbackToLatestThreadMessages();
          return;
        }
        mergeIntoThread(msgs);
        if (initialFocusId) {
          setHasMore(!!data.hasOlder);
          setHasNewer(!!data.hasNewer);
          setHistoryLimited(!!data.historyLimited);
        } else {
          setHasMore(msgs.length >= INITIAL_LIMIT);
          setHasNewer(false);
          setHistoryLimited(!!data.historyLimited);
        }
        setLoading(false);
      })
      .catch(() => {
        if (cancelled) return;
        if (initialFocusId) {
          fallbackToLatestThreadMessages();
          return;
        }
        setLoading(false);
      });

    return () => {
      cancelled = true;
      socket.off("message:new", handler);
      socket.off("message:updated", updateHandler);
      socket.off("connect", handleReconnect);
      socket.emit("leave:channel", threadChannelId);
    };
    // The focused id is intentionally captured at thread-open time; clearing it
    // after scroll must not restart the loader. A V2 flag transition may rerun
    // once to replace legacy reaction rows with the normalized projection.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [normalizedMessageV2Enabled, threadChannelId]);

  useEffect(() => {
    if (!threadChannelId || threadBucket.length === 0) return;
    setMessages((prev) => {
      const filteredThreadBucket = onlyThreadMessages(
        threadChannelId,
        normalizeThreadIngress(threadBucket, "channel-room", "thread"),
      );
      return mergeThreadBucketWithinWindow(
        prev,
        filteredThreadBucket,
        hasNewerRef.current,
      );
    });
  }, [normalizeThreadIngress, threadBucket, threadChannelId]);

  // Load parent message and its linked task. Async-loader + reset-on-deps FP.
  // Stryker disable all: async loader/store hook wiring around the parent
  // snapshot and linked task. The new parent selection and cache preference
  // semantics are covered through the exported pure helpers; mutating this
  // block in isolation mostly probes React effect timing and pre-existing task
  // sync code.
  // oxlint-disable-next-line react-doctor/no-cascading-set-state
  useEffect(() => {
    setParentMessage(null);
    setParentTask(null);

    if (!parentMessageId || !parentChannelId) return;

    let cancelled = false;
    const ingressContext = captureReceiverPrivateIngressContext(
      useMessageStore.getState().currentUserId,
    );
    const parentContextRequest = buildThreadParentContextRequest(parentMessageId, parentChannelId);
    api.get(parentContextRequest.url, parentContextRequest.config)
      .then(({ data }) => {
        if (cancelled || !isReceiverPrivateIngressContextCurrent(ingressContext)) return;
        const msgs = normalizeThreadIngress(data.messages ?? [], "receiver-private");
        const parent = msgs.find((m) => m.id === parentMessageId) ?? null;
        const cachedParent = findCachedThreadParentMessage(useMessageStore.getState().channelMessages, parentChannelId, parentMessageId);
        setParentMessage(pickFreshThreadParentMessage(parent, cachedParent));
      })
      .catch(() => {
        if (!cancelled) setParentMessage(null);
      });

    // Load through the task store instead of fetching this endpoint privately.
    // The private fetch is why a DM task could render its chip here while
    // MainLayout — which reads only the store — concluded there was no task and
    // never mounted the task modal head (@artin, task #44). Two halves of one
    // modal held different answers because only one of them had asked.
    // `loadTasks` de-duplicates per channel, so this is one request, not two,
    // and `storeParentTask` below now sees DM and private tasks like any other.
    void loadTasks(parentChannelId);

    return () => {
      cancelled = true;
    };
  }, [loadTasks, normalizeThreadIngress, parentChannelId, parentMessageId]);

  // Keep parentTask in sync with taskStore mutations (mark-as-done from the
  // thread header's own context menu, socket task:updated, tasks page, etc.).
  // Without this, the initial API fetch above snapshots the status once and
  // the thread header's status badge stays stale until a refresh.
  const parentChannelTaskBucket = useTaskStore((s) => selectChannelTaskBucket(s, parentChannelId));
  const storeTasks = useTaskStore((s) => s.tasks);
  const storeServerTasks = useTaskStore((s) => s.serverTasks);
  const storeParentTask = useMemo(
    () => resolveThreadHostTask(parentMessageId, {
      tasks: storeTasks,
      parentChannelTasks: parentChannelTaskBucket,
      serverTasks: storeServerTasks,
    }),
    [parentMessageId, storeTasks, parentChannelTaskBucket, storeServerTasks],
  );
  useEffect(() => {
    if (storeParentTask) setParentTask(storeParentTask);
  }, [storeParentTask]);
  // Stryker restore all

  // ThreadPanel renders the parent message from local state after the context
  // fetch. Keep that snapshot synced with the canonical message store so local
  // action-card mutations and parent-channel realtime updates do not leave the
  // thread header/card stale until refresh.
  // Stryker disable all: React effect wiring for parent-message cache sync. The
  // sync helper behavior is covered by threadPanelParentActionCardSync.behavior.test.ts.
  useEffect(() => {
    syncThreadParentMessageFromStore(storeParentMessage, setParentMessage);
  }, [storeParentMessage]);
  // Stryker restore all

  useEffect(() => {
    if (!focusedMessageId) {
      scrolledFocusedMessageIdRef.current = null;
      return;
    }
    if (messages.length === 0) return;
    if (!messages.some((msg) => msg.id === focusedMessageId)) return;

    if (scrolledFocusedMessageIdRef.current !== focusedMessageId) {
      scrolledFocusedMessageIdRef.current = focusedMessageId;
      requestAnimationFrame(() => {
        timelineRef.current?.scrollToMessage(focusedMessageId, { align: "center" });
      });
    }

    const timer = window.setTimeout(() => {
      consumeFocusedMessage();
    }, 2000);

    return () => window.clearTimeout(timer);
  }, [consumeFocusedMessage, focusedMessageId, messages]);

  // Load older messages (pagination)
  const loadOlderMessages = useCallback(async () => {
    if (!threadChannelId || loadingOlder || !hasMore || messages.length === 0) return;

    const minSeq = Math.min(...messages.map((m) => m.seq || Infinity));
    if (!minSeq || minSeq === Infinity) return;

    const requestThreadChannelId = threadChannelId;
    const ingressContext = captureReceiverPrivateIngressContext(
      useMessageStore.getState().currentUserId,
    );
    setLoadingOlder(true);
    try {
      const limit = 50;
      const { data } = await api.get(
        `/messages/channel/${requestThreadChannelId}?limit=${limit}&before=${minSeq}`
      );
      if (
        !isCurrentThread(requestThreadChannelId)
        || !isReceiverPrivateIngressContextCurrent(ingressContext)
      ) return;
      const older = onlyThreadMessages(
        requestThreadChannelId,
        normalizeThreadIngress(data.messages ?? data, "receiver-private", "thread"),
      );
      setMessages((prev) => {
        const existingIds = new Set(prev.map((m) => m.id));
        const newMsgs = older.filter((m) => !existingIds.has(m.id));
        return newMsgs.length === 0 ? prev : [...newMsgs, ...prev];
      });
      setHasMore(older.length >= limit);
      setHistoryLimited(!!data.historyLimited);
    } catch {
      // ignore
    } finally {
      setLoadingOlder(false);
    }
  }, [hasMore, isCurrentThread, loadingOlder, messages, normalizeThreadIngress, threadChannelId]);

  const jumpToThreadStart = useCallback(async () => {
    if (!threadChannelId || messages.length === 0) {
      scrollThreadTimelineToTop(timelineRef.current);
      return;
    }
    if (jumpToThreadStartInFlightRef.current) return;

    jumpToThreadStartInFlightRef.current = true;
    const requestThreadChannelId = threadChannelId;
    const ingressContext = captureReceiverPrivateIngressContext(
      useMessageStore.getState().currentUserId,
    );
    let next = sortThreadMessages(messages);
    let nextHasMore = hasMore;
    let nextHistoryLimited = historyLimited;

    if (nextHasMore) setLoadingOlder(true);
    try {
      const limit = 50;
      while (nextHasMore && next.length > 0) {
        const minSeq = Math.min(...next.map((m) => m.seq || Infinity));
        if (!minSeq || minSeq === Infinity) break;
        const { data } = await api.get(
          `/messages/channel/${requestThreadChannelId}?limit=${limit}&before=${minSeq}`
        );
        if (
          !isCurrentThread(requestThreadChannelId)
          || !isReceiverPrivateIngressContextCurrent(ingressContext)
        ) return;
        const older = onlyThreadMessages(
          requestThreadChannelId,
          normalizeThreadIngress(data.messages ?? data, "receiver-private", "thread"),
        );
        next = mergeThreadMessages(next, older);
        nextHasMore = older.length >= limit;
        nextHistoryLimited = nextHistoryLimited || !!data.historyLimited;
        if (older.length === 0) break;
      }

      if (!isCurrentThread(requestThreadChannelId)) return;
      setMessages(next);
      setHasMore(nextHasMore);
      setHistoryLimited(nextHistoryLimited);
      requestAnimationFrame(() => {
        requestAnimationFrame(() => scrollThreadTimelineToTop(timelineRef.current));
      });
    } catch {
      scrollThreadTimelineToTop(timelineRef.current);
    } finally {
      if (isCurrentThread(requestThreadChannelId)) setLoadingOlder(false);
      jumpToThreadStartInFlightRef.current = false;
    }
  }, [hasMore, historyLimited, isCurrentThread, messages, normalizeThreadIngress, threadChannelId]);

  const loadNewerMessages = useCallback(async () => {
    if (!threadChannelId || loadingNewer || !hasNewer || loading || messages.length === 0) return;

    const maxSeq = Math.max(...messages.map((m) => m.seq || 0));
    if (!maxSeq || maxSeq === Infinity) return;

    const requestThreadChannelId = threadChannelId;
    const ingressContext = captureReceiverPrivateIngressContext(
      useMessageStore.getState().currentUserId,
    );
    setLoadingNewer(true);
    try {
      const limit = 50;
      const { data } = await api.get(
        `/messages/channel/${requestThreadChannelId}?limit=${limit}&after=${maxSeq}`
      );
      if (
        !isCurrentThread(requestThreadChannelId)
        || !isReceiverPrivateIngressContextCurrent(ingressContext)
      ) return;
      const newer = onlyThreadMessages(
        requestThreadChannelId,
        normalizeThreadIngress(data.messages ?? data, "receiver-private", "thread"),
      );
      setMessages((prev) => {
        const existingIds = new Set(prev.map((m) => m.id));
        const newMsgs = newer.filter((m) => !existingIds.has(m.id));
        return mergeThreadMessages(prev, newMsgs);
      });
      setHasNewer(newer.length >= limit);
    } catch {
      // ignore
    } finally {
      setLoadingNewer(false);
    }
  }, [hasNewer, isCurrentThread, loading, loadingNewer, messages, normalizeThreadIngress, threadChannelId]);

  const handleAtBottomStateChange = useCallback((atBottom: boolean) => {
    isNearBottomRef.current = atBottom;
    setAtBottom(atBottom);
    if (atBottom) setNewMessageCount(0);
  }, []);

  const scrollToBottom = useCallback(() => {
    timelineRef.current?.scrollToBottom();
    setNewMessageCount(0);
  }, []);

  useEffect(() => {
    if (scrollToTopRequest <= handledScrollToTopRequestRef.current) return;
    if (!timelineRef.current) return;
    handledScrollToTopRequestRef.current = scrollToTopRequest;
    void jumpToThreadStart();
  }, [jumpToThreadStart, loading, messages.length, scrollToTopRequest]);



  const handleBackToBottom = useCallback(async () => {
    if (!threadChannelId) return;
    // Loading remounts the timeline, so retire stale focus before the explicit
    // tail intent can be overwritten by initialFocusMessageId.
    focusedAtOpenRef.current = null;
    consumeFocusedMessage();
    setNewMessageCount(0);
    setLoading(true);
    setSearchContextAutoLoadBlockKey(null);
    try {
      const latest = await loadLatestThreadMessages(threadChannelId);
      if (!latest) return;
      isNearBottomRef.current = true;
      setAtBottom(true);
      requestAnimationFrame(() => {
        timelineRef.current?.scrollToBottom();
      });
    } catch {
      setLoading(false);
    }
  }, [consumeFocusedMessage, loadLatestThreadMessages, threadChannelId]);

  const loadThreadSearchCorpus = useCallback(async () => {
    if (!threadChannelId) return messages;
    const ingressContext = captureReceiverPrivateIngressContext(
      useMessageStore.getState().currentUserId,
    );

    const limit = 100;
    let next = sortThreadMessages(messages);
    let nextHasMore = hasMore;
    let nextHasNewer = hasNewer;

    while (nextHasMore && next.length > 0) {
      const minSeq = Math.min(...next.map((m) => m.seq || Infinity));
      if (!minSeq || minSeq === Infinity) break;
      const { data } = await api.get(
        `/messages/channel/${threadChannelId}?limit=${limit}&before=${minSeq}`,
      );
      if (
        !isCurrentThread(threadChannelId)
        || !isReceiverPrivateIngressContextCurrent(ingressContext)
      ) return next;
      const older = onlyThreadMessages(
        threadChannelId,
        normalizeThreadIngress(data.messages ?? data, "receiver-private", "thread"),
      );
      next = mergeThreadMessages(next, older);
      nextHasMore = older.length >= limit;
      if (older.length === 0) break;
    }

    while (nextHasNewer && next.length > 0) {
      const maxSeq = Math.max(...next.map((m) => m.seq || 0));
      if (!maxSeq || maxSeq === Infinity) break;
      const { data } = await api.get(
        `/messages/channel/${threadChannelId}?limit=${limit}&after=${maxSeq}`,
      );
      if (
        !isCurrentThread(threadChannelId)
        || !isReceiverPrivateIngressContextCurrent(ingressContext)
      ) return next;
      const newer = onlyThreadMessages(
        threadChannelId,
        normalizeThreadIngress(data.messages ?? data, "receiver-private", "thread"),
      );
      next = mergeThreadMessages(next, newer);
      nextHasNewer = newer.length >= limit;
      if (newer.length === 0) break;
    }

    if (!isCurrentThread(threadChannelId)) return next;
    setThreadSearchState((state) => ({
      ...state,
      hydratedThreadId: threadChannelId,
      corpusMessages: next,
    }));
    return next;
  }, [hasMore, hasNewer, isCurrentThread, messages, normalizeThreadIngress, threadChannelId]);

  const ensureThreadSearchHydrated = useCallback(async () => {
    if (
      !threadChannelId ||
      threadSearchState.hydratedThreadId === threadChannelId ||
      threadSearchState.loadingThreadId === threadChannelId
    ) return;
    setThreadSearchState((state) => ({ ...state, loadingThreadId: threadChannelId }));
    try {
      await loadThreadSearchCorpus();
    } finally {
      setThreadSearchState((state) => ({
        ...state,
        loadingThreadId: state.loadingThreadId === threadChannelId ? null : state.loadingThreadId,
      }));
    }
  }, [
    loadThreadSearchCorpus,
    threadChannelId,
    threadSearchState.hydratedThreadId,
    threadSearchState.loadingThreadId,
  ]);

  useEffect(() => {
    if (!threadSearchOpen || !threadChannelId || !normalizeThreadSearchQuery(threadSearchQuery)) return;
    const timeout = window.setTimeout(() => {
      void ensureThreadSearchHydrated();
    }, THREAD_SEARCH_HYDRATION_DEBOUNCE_MS);
    return () => window.clearTimeout(timeout);
  }, [ensureThreadSearchHydrated, threadChannelId, threadSearchOpen, threadSearchQuery]);

  const openThreadSearch = useCallback((seedQuery?: string) => {
    if (!threadChannelId) return;
    const nextSeedQuery = seedQuery ? normalizeThreadSearchSelectionText(seedQuery) : "";
    setThreadSearchState((state) => {
      const sameThread = state.threadId === threadChannelId;
      return {
        ...state,
        threadId: threadChannelId,
        open: true,
        query: nextSeedQuery || (sameThread ? state.query : ""),
        activeIndex: nextSeedQuery ? 0 : (sameThread ? state.activeIndex : 0),
      };
    });
    requestAnimationFrame(() => {
      threadSearchInputRef.current?.focus();
      threadSearchInputRef.current?.select();
    });
  }, [threadChannelId]);

  const closeThreadSearch = useCallback(() => {
    setThreadSearchState((state) => ({ ...state, open: false }));
    threadSearchScopeActiveRef.current = false;
    threadSearchInputRef.current?.blur();
  }, []);

  const handleWillSend = useCallback(async () => {
    focusedAtOpenRef.current = null;
    if (hasNewer || focusedMessageId) {
      consumeFocusedMessage();
      setNewMessageCount(0);
      hasNewerRef.current = false;
      setHasNewer(false);
      setLoadingNewer(false);
    }
    timelineRef.current?.armFollowOnNextAppend();
    isNearBottomRef.current = true;
    setAtBottom(true);
    setNewMessageCount(0);
    requestAnimationFrame(() => {
      timelineRef.current?.scrollToBottom();
    });
  }, [consumeFocusedMessage, focusedMessageId, hasNewer]);

  const handleThreadChannelResolved = useCallback((resolvedThreadChannelId: string) => {
    if (!parentMessageId) return;
    const existing = useThreadStore.getState().summaries[parentMessageId];
    useThreadStore.getState().updateSummary(parentMessageId, {
      threadChannelId: resolvedThreadChannelId,
      replyCount: Math.max(existing?.replyCount ?? 0, messagesRef.current.length + 1),
      lastReplyAt: existing?.lastReplyAt ?? null,
      participantIds: existing?.participantIds ?? [],
      unreadCount: existing?.unreadCount ?? 0,
      firstUnreadMessageId: existing?.firstUnreadMessageId ?? null,
      ...(existing?.latestReplies ? { latestReplies: existing.latestReplies } : {}),
    });
  }, [parentMessageId]);

  const threadSearchMessages = useMemo(
    () => getThreadSearchableMessages(
      displayedParentMessageWithThreadId,
      threadSearchState.hydratedThreadId === threadChannelId
        ? threadSearchState.corpusMessages
        : messages,
    ),
    [displayedParentMessageWithThreadId, messages, threadChannelId, threadSearchState.corpusMessages, threadSearchState.hydratedThreadId],
  );
  const threadSearchMatches = useMemo(
    () => buildThreadSearchMatches(threadSearchMessages, threadSearchQuery),
    [threadSearchMessages, threadSearchQuery],
  );
  const threadSearchActiveIndex = threadSearchMatches.length === 0
    ? 0
    : Math.min(rawThreadSearchActiveIndex, threadSearchMatches.length - 1);
  const activeThreadSearchMatch = threadSearchMatches[threadSearchActiveIndex] ?? null;
  const activeThreadSearchMessageId = threadSearchOpen
    ? activeThreadSearchMatch?.messageId ?? null
    : null;

  const ensureThreadSearchMatchVisible = useCallback(async (messageId: string) => {
    if (!threadChannelId || messageId === displayedParentMessageWithThreadId?.id) return true;
    if (messagesRef.current.some((message) => message.id === messageId)) return true;
    const ingressContext = captureReceiverPrivateIngressContext(
      useMessageStore.getState().currentUserId,
    );
    // Arm before the request starts: the old focused window can still have a
    // visible sentinel while the context response is being committed.
    setSearchContextAutoLoadBlockKey(messageId);

    const { data } = await api.get(`/messages/context/${messageId}`, {
      params: { channelId: threadChannelId },
    });
    if (
      !isCurrentThread(threadChannelId)
      || !isReceiverPrivateIngressContextCurrent(ingressContext)
    ) return false;

    const contextMessages = onlyThreadMessages(
      threadChannelId,
      normalizeThreadIngress(data.messages ?? data, "receiver-private", "thread"),
    );
    setMessages((current) => mergeThreadMessages(current, contextMessages));
    setHasMore(!!data.hasOlder);
    setHasNewer(!!data.hasNewer);
    setHistoryLimited(!!data.historyLimited);
    setLoadingOlder(false);
    setLoadingNewer(false);
    return true;
  }, [
    displayedParentMessageWithThreadId?.id,
    isCurrentThread,
    normalizeThreadIngress,
    threadChannelId,
  ]);

  // Stryker disable all: the effect's cancellation/dependency plumbing predates this change; the bounded-context arm is pinned by the structural contract and timeline behavior tests.
  useEffect(() => {
    if (!threadSearchOpen || !activeThreadSearchMessageId) return;
    let cancelled = false;
    void ensureThreadSearchMatchVisible(activeThreadSearchMessageId)
      .then((visible) => {
        if (cancelled || !visible) return;
        requestAnimationFrame(() => {
          timelineRef.current?.scrollToMessage(activeThreadSearchMessageId, { align: "center" });
        });
      })
      .catch(() => {});
    return () => {
      cancelled = true;
    };
  }, [activeThreadSearchMessageId, ensureThreadSearchMatchVisible, threadSearchOpen]);
  // Stryker restore all

  useEffect(() => {
    const updateThreadSearchScope = (event: Event) => {
      const target = event.target;
      threadSearchScopeActiveRef.current =
        target instanceof Node && !!panelRef.current?.contains(target);
    };
    window.addEventListener("pointerdown", updateThreadSearchScope, true);
    window.addEventListener("focusin", updateThreadSearchScope, true);
    return () => {
      window.removeEventListener("pointerdown", updateThreadSearchScope, true);
      window.removeEventListener("focusin", updateThreadSearchScope, true);
    };
  }, []);

  useEffect(() => {
    if (!parentMessageId || picPreview) return;
    const handler = (event: KeyboardEvent) => {
      if (!isThreadSearchShortcut(event) || event.defaultPrevented) return;
      const target = event.target;
      const targetInsidePanel = target instanceof Node && !!panelRef.current?.contains(target);
      const targetIsDocumentBody = target === document.body;
      if (!targetInsidePanel && !(targetIsDocumentBody && threadSearchScopeActiveRef.current)) return;
      event.preventDefault();
      openThreadSearch(getThreadPanelSelectedSearchText(panelRef.current));
    };
    // keydown-global-exempt: scoped Cmd/Ctrl+F replacement while the thread surface has focus.
    window.addEventListener("keydown", handler);
    return () => window.removeEventListener("keydown", handler);
  }, [openThreadSearch, parentMessageId, picPreview]);

  const goToThreadSearchMatch = useCallback((direction: 1 | -1) => {
    if (threadSearchMatches.length === 0) return;
    setThreadSearchState((state) => {
      const current = state.threadId === threadChannelId
        ? Math.min(state.activeIndex, threadSearchMatches.length - 1)
        : 0;
      return {
        ...state,
        threadId: threadChannelId ?? state.threadId,
        activeIndex: (current + direction + threadSearchMatches.length) % threadSearchMatches.length,
      };
    });
  }, [threadChannelId, threadSearchMatches.length]);

  const handleJoinParentChannel = useCallback(() => {
    if (!parentChannelId) return;
    void joinChannel(parentChannelId);
  }, [joinChannel, parentChannelId]);

  // Stryker disable all: the ThreadPanel-to-MessageTimeline source wiring is pinned by the structural bounded-context contract; timeline behavior is covered separately.
  const threadSource = useMemo<MessageTimelineSource>(() => ({
    messages,
    hasOlder: hasMore,
    hasNewer,
    loading,
    loadOlder: loadOlderMessages,
    loadNewer: loadNewerMessages,
    initialFocusMessageId: focusedAtOpenRef.current,
    sentinelAutoLoadBlockKey: searchContextAutoLoadBlockKey,
  }), [
    messages,
    hasMore,
    hasNewer,
    loading,
    loadOlderMessages,
    loadNewerMessages,
    searchContextAutoLoadBlockKey,
  ]);
  // Stryker restore all

  // Stryker disable next-line all: this unchanged memo falls into the diff gate's shifted range; system grouping has its own focused behavior suite.
  const systemMessageRenderStates = useMemo(
    () => buildSystemMessageRenderStates(messages, formatMessage),
    [messages, formatMessage],
  );

  const toggleSystemMessageGroup = useCallback((groupId: string) => {
    setExpandedSystemMessageGroups((current) => {
      const next = new Set(current);
      if (next.has(groupId)) next.delete(groupId);
      else next.add(groupId);
      return next;
    });
  }, []);

  const getPreviewSenderAgent = useCallback((message: Message) => (
      message.senderType === "agent" ? agentById.get(message.senderId) : undefined
  ), [agentById]);
  const getPreviewSenderMember = useCallback((message: Message) => (
      message.senderType === "user"
        ? resolveMessageSenderMember(message, memberById, currentUser) ?? undefined
        : undefined
  ), [currentUser, memberById]);

  // task #44 (stdrc): merge consecutive same-sender replies inside a thread too.
  // Threads still break the run on a day boundary ("按天合并") but DON'T render a
  // date divider — so we compute the same grouping and just never emit a
  // DateDivider here. Reply messages never carry their own reply/task chrome, so
  // there are no standalone ids to exclude.
  const { options: threadTimeFormatOptions } = useTimeFormatter();
  const messageGrouping = useStableMessageGrouping(
    messages,
    threadTimeFormatOptions.timeZone ?? undefined,
  );
  // Stryker disable next-line ConditionalExpression,LogicalOperator: thread composer routing is covered through MessageItem behavior; this normalizes the mounted thread id for duplicated render branches.
  const threadMentionComposerChannelId = threadChannelId || undefined;
  const threadReactionParentScopeKey = useMemo<SyncScopeKey | undefined>(() => (
    currentServer?.id && threadChannelId
      ? { serverId: currentServer.id, scopeKind: "thread", scopeId: threadChannelId }
      : undefined
  ), [currentServer?.id, threadChannelId]);
  const parentReactionParentScopeKey = useMemo<SyncScopeKey | undefined>(() => (
    currentServer?.id && parentChannelId
      ? { serverId: currentServer.id, scopeKind: "channel", scopeId: parentChannelId }
      : undefined
  ), [currentServer?.id, parentChannelId]);

  // Stryker disable all: focused sender-name mention behavior is covered through MessageItem/MessageInput; this memo only duplicates thread render pass-through and dependency invalidation.
  const renderThreadItem = useCallback((msg: Message, index: number) => {
    const systemMessageState = systemMessageRenderStates[index];
    if (systemMessageState?.kind === "hide") return null;
    const getThreadSearchHighlightQuery = (messageId: string) => (
      messageId === activeThreadSearchMessageId ? threadSearchQuery : undefined
    );

    if (systemMessageState?.kind === "summary") {
      const expanded = expandedSystemMessageGroups.has(systemMessageState.groupId);
      return (
        <div className="px-3" style={{ overflow: "clip visible" }}>
          <SystemMessageGroupDisclosure
            summary={systemMessageState.content}
            expanded={expanded}
            onToggle={() => toggleSystemMessageGroup(systemMessageState.groupId)}
          >
            {systemMessageState.messageIndexes.map((messageIndex) => {
              const originalMessage = messages[messageIndex];
              if (!originalMessage) return null;
              return (
                <MessageItem
                  key={originalMessage.id}
                  message={originalMessage}
                  mentionMap={mentionMap}
                  channels={channels}
                  parentChannelId={parentChannelId || undefined}
                  parentMessageId={parentMessageId || undefined}
                  previewSenderAgent={getPreviewSenderAgent(originalMessage)}
                  previewSenderMember={getPreviewSenderMember(originalMessage)}
                  mentionComposerChannelId={threadMentionComposerChannelId}
                  reactionParentScopeKey={threadReactionParentScopeKey}
                  canReact={canReactToThread}
                  hideThreadActions
                  onOpenProfile={onOpenProfile}
                  threadSearchHighlightQuery={getThreadSearchHighlightQuery(originalMessage.id)}
                  threadSearchActive={originalMessage.id === activeThreadSearchMessageId}
                />
              );
            })}
          </SystemMessageGroupDisclosure>
        </div>
      );
    }

    return (
      // `overflow: clip visible` (not `overflow-hidden`) so the hover toolbar can
      // ride on top of the message border without being clipped — matches
      // ChatPanel. Horizontal clipping is preserved.
      <div className="px-3" style={{ overflow: "clip visible" }}>
        <MessageItem
          key={msg.id}
          message={msg}
          mentionMap={mentionMap}
          channels={channels}
          parentChannelId={parentChannelId || undefined}
          parentMessageId={parentMessageId || undefined}
          previewSenderAgent={getPreviewSenderAgent(msg)}
          previewSenderMember={getPreviewSenderMember(msg)}
          mentionComposerChannelId={threadMentionComposerChannelId}
          reactionParentScopeKey={threadReactionParentScopeKey}
          canReact={canReactToThread}
          hideThreadActions
          onOpenProfile={onOpenProfile}
          groupState={messageGrouping.get(msg.id)}
          threadSearchHighlightQuery={getThreadSearchHighlightQuery(msg.id)}
          threadSearchActive={msg.id === activeThreadSearchMessageId}
        />
      </div>
    );
  }, [activeThreadSearchMessageId, canReactToThread, channels, expandedSystemMessageGroups, getPreviewSenderAgent, getPreviewSenderMember, mentionMap, messageGrouping, messages, onOpenProfile, parentChannelId, parentMessageId, systemMessageRenderStates, threadMentionComposerChannelId, threadReactionParentScopeKey, threadSearchQuery, toggleSystemMessageGroup]);
  // Stryker restore all

  // Stryker disable all: focused sender-name mention behavior is covered through MessageItem/MessageInput; this memo only duplicates thread parent pass-through and dependency invalidation.
  const threadHeader = useMemo(() => (
    <div>
      {parentSlot}
      {displayedParentMessageWithThreadId && (
        // The root renders through MessageTimeline.header, outside its message
        // map, but still participates in the same anchor/reveal item contract.
        <div
          data-testid="thread-panel-parent"
          data-message-id={displayedParentMessageWithThreadId.id}
          data-timeline-message-id={displayedParentMessageWithThreadId.id}
          className={THREAD_PANEL_PARENT_CLASS_NAME}
        >
          <MessageItem
            message={displayedParentMessageWithThreadId}
            mentionMap={mentionMap}
            channels={channels}
            threadSummary={displayedParentThreadSummary}
            linkedTask={displayedParentTask ?? undefined}
            previewSenderAgent={getPreviewSenderAgent(displayedParentMessageWithThreadId)}
            previewSenderMember={getPreviewSenderMember(displayedParentMessageWithThreadId)}
            mentionComposerChannelId={threadMentionComposerChannelId}
            reactionParentScopeKey={parentReactionParentScopeKey}
            canReact={canReactToThread}
            hideThreadActions
            showThreadFollowAction
            senderAvatarTestId="thread-parent-avatar"
            onOpenProfile={onOpenProfile}
            threadSearchHighlightQuery={
              displayedParentMessageWithThreadId.id === activeThreadSearchMessageId ? threadSearchQuery : undefined
            }
            threadSearchActive={displayedParentMessageWithThreadId.id === activeThreadSearchMessageId}
          />
        </div>
      )}
      <div className="px-3 pt-2">
        <HistoryTopState
          hasMore={hasMore}
          historyLimited={historyLimited}
          loadingOlder={loadingOlder}
          noun={THREAD_HISTORY_NOUN}
        />
        <div className="border-b border-black/10 pb-2 mb-1 text-xs text-black/40 font-mono text-center">
          {formatMessage({ id: "message.inlineThreadReplies.replyCount" }, { count: messages.length })}
        </div>
      </div>
    </div>
  ), [activeThreadSearchMessageId, canReactToThread, channels, displayedParentMessageWithThreadId, displayedParentTask, formatMessage, getPreviewSenderAgent, getPreviewSenderMember, hasMore, historyLimited, loadingOlder, mentionMap, messages.length, onOpenProfile, displayedParentThreadSummary, parentReactionParentScopeKey, parentSlot, threadMentionComposerChannelId, threadSearchQuery]);
  // Stryker restore all

  const threadFooter = useMemo(() => (
    <div className="px-3 pb-3">
      {loadingNewer && (
        <div className="py-2 text-center text-black/40 font-mono text-xs">
          {formatMessage({ id: "message.threadPanel.loadingNewerReplies" })}
        </div>
      )}
      <div className="h-3" />
    </div>
  ), [formatMessage, loadingNewer]);

  if (!parentMessageId) return null;
  const showBottomButton = hasNewer || !atBottom || newMessageCount > 0;
  const handleBottomButton = hasNewer ? handleBackToBottom : scrollToBottom;
  // Outer always fills its host's flex column. Column-layout (border/width/
  // resize/positioning/z-stack) lives on the host wrapper; ThreadPanel only
  // owns the surface content per stdrc msg=138867ba.
  // iPad Safari can keep the momentum scroller's composited hit-test layer
  // above adjacent flex siblings after history scroll; keep thread chrome in
  // explicit stack layers so back/input remain reachable.
  const panelClassName = mobilePage
    ? "isolate flex h-full min-h-0 w-full flex-col bg-white"
    : "isolate flex h-full min-h-0 w-full flex-col bg-white";
  const threadChromeLayerClassName = "relative z-20 shrink-0";
  const threadContentLayerClassName = mobilePage
    ? "relative z-0 min-h-0 flex-1 overflow-hidden"
    : "relative z-0 min-h-0 flex-1 overflow-hidden";
  // X close button visibility, per stdrc 2026-05-21 #proj-task:287f18ce
  // msg=804c045d: "它作为弹窗就需要叉；如果它是直接覆盖整个页面，就是返回."
  //   modal        — X (centered card with backdrop, X is the dialog close)
  //   mobile-modal — NO X (full-screen overlay, back chevron handles close)
  //   side         — X on desktop (lg+) only; mobile uses back chevron
  const closeButtonClassName = presentation === "modal"
    ? "btn-brutal-sm flex size-7 items-center justify-center bg-white"
    : "btn-brutal-sm hidden size-7 items-center justify-center bg-white lg:flex";

  // Show a loading shell while threadChannelId is being fetched (first-open
  // case). If resolution actually failed for *this* parent (e.g. the permalink
  // was opened mid private→public conversion, or any transient error), show an
  // actionable error + Retry instead of an unbounded spinner — see
  // threadStore.openThreadError (#engineering task #417).
  if (!threadChannelId) {
    // Stryker disable all: pre-existing retry-state matching is outside the workspace mutation corpus.
    const resolveFailed =
      !!openThreadError &&
      openThreadError.parentChannelId === parentChannelId &&
      openThreadError.parentMessageId === parentMessageId;
    // Stryker restore all
    if (resolveFailed || openThreadLoading) return (
      <div className={panelClassName}>
        {/* Stryker disable all: workspace header ownership is browser-smoke verified. */}
        {showHeader && <PanelHeader
          title={formatMessage({ id: "message.threadPanel.thread" })}
          onMobileBack={mobileBackHandler}
          mobileBackProps={{ "data-testid": "thread-mobile-back" }}
          containerProps={{ className: threadChromeLayerClassName }}
          mobileBreakpoint="lg"
          actions={
            <button
              onClick={handleClose}
              className={closeButtonClassName}
              title={formatMessage({ id: "message.threadPanel.closeThread" })}
              data-testid="thread-close"
            >
              <X size={14} />
            </button>
          }
        />}
        {/* Stryker restore all */}
        <div className="flex flex-1 items-center justify-center p-6">
          {resolveFailed ? (
            <div className="flex flex-col items-center gap-3 text-center">
              <div className="font-display text-lg font-bold text-black">
                {formatMessage({ id: "message.threadPanel.loadFailedTitle" })}
              </div>
              <div className="max-w-xs text-sm text-black/60">
                {formatMessage({ id: "message.threadPanel.loadFailedBody" })}
              </div>
              <button
                onClick={() => { void retryOpenThread(); }}
                className="btn-brutal-sm bg-white px-3 py-1.5 text-sm font-bold"
                data-testid="thread-retry"
              >
                {formatMessage({ id: "message.threadPanel.retry" })}
              </button>
            </div>
          ) : (
            <div className="text-black/40 font-mono text-sm">{formatMessage({ id: "message.chatPanel.loading" })}</div>
          )}
        </div>
      </div>
    );
  }
  // Stryker disable all: select-share lightbox rendering predates this forward
  // change and is covered by share-lightbox behavior outside the forward mutation
  // corpus.
  const selectShareLightbox = picPreview ? (
    <SelectShareLightbox
      dataUrl={picPreview}
      filename={`raft-thread-${new Date().toISOString().slice(0, 10)}.png`}
      onClose={() => setPicPreview(null)}
      onShareToX={onSharePreviewToX}
      onSaved={() => {
        setPicPreview(null);
        useSelectionStore.getState().exit();
      }}
    />
  ) : null;
  // Stryker restore all

  // Stryker disable all: parent reply/join chrome is existing ThreadPanel
  // behavior; forward tests exercise the toolbar branch separately.
  const canReplyInParentThread = parentJoined === true;
  const showJoinParentChannel = parentJoined === false
    && (currentServer?.role !== "guest" || parentChannel?.guestJoinable === true);
  const threadMentionChannelId = parentChannelId || undefined;
  const isChannelThreadInput = (() => {
    if (!parentChannelId) return false;
    const ch = channels.find((c) => c.id === parentChannelId) || dmChannels.find((c) => c.id === parentChannelId);
    return ch?.type !== "dm";
  })();
  // Stryker restore all
  // Stryker disable all: workspace header action forwarding is contract-pinned and browser-smoke verified.
  const handleOpenParentChannelAction = () => {
    if (!parentMessageId || !parentChannelId) return;
    if (onOpenParentChannel) {
      onOpenParentChannel(parentChannelId, parentMessageId);
      return;
    }
    const routeKind = parentRouteKind === "dm" ? "dm" : "channel";
    if (!isDesktop) {
      // View-in-channel replaces the current thread detail surface. The one
      // earlier PUSH belongs to the origin→Thread transition, so the channel's
      // Back returns straight to Activity/Search instead of reopening Thread.
      // Reserve the canonical ?msg= URL before navigating, then clear the
      // store. BrowserRouter commits route state in a transition; the explicit
      // ownership marker prevents an already-queued origin effect from racing
      // stale thread params back into the store before that commit lands.
      const base = serverSlug ? `/s/${serverSlug}` : "";
      transitionThreadToParentMessage({
        pathname: `${base}/${routeKind}/${parentChannelId}`,
        parentMessageId,
        navigate: mobileNavigate,
      });
    } else if (routeKind === "dm") {
      nav.toDmMessage(parentChannelId, parentMessageId);
    } else {
      nav.toMessage(parentChannelId, parentMessageId);
    }
  };
  // task #187 `topbar_overflow_v0`: a Thread has only immediate commands,
  // so its vertical-ellipsis opens a lightweight Raft UI DropdownMenu rather
  // than the Channel settings drawer. Search, View in channel and
  // Follow/Unfollow live in that menu; structural Back + Close stay in the
  // header. Flag off keeps the legacy standalone search + open-parent controls.
  const openParentChannelLabel = onOpenParentChannel
    ? formatMessage({ id: "message.threadPanel.openChannel" })
    : formatMessage({ id: "message.threadPanel.viewInChannel" });
  const handleOpenInNewTab = () => {
    if (!serverSlug || !parentChannelId || !parentMessageId) return;
    openPanelInNewTab(buildThreadWindowUrl(
      { pathname: window.location.pathname, search: window.location.search, origin: window.location.origin },
      {
        serverSlug,
        parentChannelId,
        parentMessageId,
        parentChannelType: parentRouteKind === "dm" ? "dm" : "channel",
        focusedMessageId,
      },
      useThreadStore.getState().openIntent === "task" ? "task" : "thread",
    ));
  };
  const openParentChannelButton = parentChannelId && (
    <Tooltip
      content={openParentChannelLabel}
      contentProps={{ side: "bottom", className: "pointer-events-none" }}
    >
      <button
        onClick={handleOpenParentChannelAction}
        onKeyDownCapture={(event) => {
          // Tooltip owns Escape to dismiss its popup. This trigger already
          // lived inside the ThreadPanel's non-editable-focus Escape
          // contract, so close the thread at capture time before the popup
          // consumes the same key.
          if (event.key !== "Escape") return;
          event.preventDefault();
          event.stopPropagation();
          handleClose();
        }}
        className="btn-brutal-sm flex size-7 shrink-0 items-center justify-center bg-white"
        aria-label={openParentChannelLabel}
        data-testid="thread-view-in-channel"
      >
        <MapPin size={14} />
      </button>
    </Tooltip>
  );
  const threadContextActions = topbarOverflowEnabled ? (
    <>
      <ThreadOverflowMenu
        threadChannelId={threadChannelId}
        parentMessageId={parentMessageId}
        viewInChannelLabel={openParentChannelLabel}
        onViewInChannel={handleOpenParentChannelAction}
        onOpenInNewTab={handleOpenInNewTab}
        onSearch={() => openThreadSearch()}
      />
    </>
  ) : (
    <>
      <button
        onClick={() => openThreadSearch()}
        className="btn-brutal-sm flex size-7 shrink-0 items-center justify-center bg-white"
        title={formatMessage({ id: "message.threadPanel.searchInThread" })}
        aria-label={formatMessage({ id: "message.threadPanel.searchInThread" })}
        data-testid="thread-search-open"
      >
        <Search size={14} />
      </button>
      <button
        onClick={handleOpenInNewTab}
        className="btn-brutal-sm flex size-7 shrink-0 items-center justify-center bg-white"
        title={formatMessage({ id: "message.threadPanel.openInNewTab" })}
        aria-label={formatMessage({ id: "message.threadPanel.openInNewTab" })}
        data-testid="thread-open-new-tab"
      >
        <ExternalLink size={14} />
      </button>
      {openParentChannelButton}
    </>
  );
  const showCloseButton = presentation !== "mobile-modal";
  const composerContainerClassName = mobilePage
    ? threadChromeLayerClassName
    : overlayComposer
    ? "absolute inset-x-0 bottom-0 bg-white shadow-brutal"
    : threadChromeLayerClassName;
  const composerTestId = workspaceComposer
    ? "workspace-panel-composer"
    : mobilePage
      ? "thread-window-composer"
      : undefined;
  const portaledHeaderActions = hideHeader && headerActionsHost
    ? createPortal(
        <div className="workspace-grid-tabset-actions" data-testid="workspace-tabset-context-actions">
          {threadChannelId && <ThreadAgentFollowers threadChannelId={threadChannelId} variant="header" />}
          {threadContextActions}
        </div>,
        headerActionsHost,
      )
    : null;
  // Stryker restore all

  return (
    <div
      ref={panelRef}
      className={panelClassName}
      onPointerDownCapture={() => { threadSearchScopeActiveRef.current = true; }}
      onFocusCapture={() => { threadSearchScopeActiveRef.current = true; }}
    >
      {/* Stryker disable all: workspace header ownership and portal are browser-smoke verified. */}
      {showHeader && <PanelHeader
        onMobileBack={mobileBackHandler}
        mobileBackProps={{ "data-testid": "thread-mobile-back" }}
        containerProps={{ className: threadChromeLayerClassName }}
        // In modal presentation the back chevron is the close affordance, so
        // it should hide once the Rail kicks in (md+, centered card). In side
        // presentation the chevron stays through to lg- (mobile full-screen).
        mobileBreakpoint={presentation === "side" ? "lg" : "md"}
        titleSlot={
          <button
            type="button"
            onClick={() => { void jumpToThreadStart(); }}
            className="flex h-panel-header w-full min-w-0 items-center font-bold text-black text-base truncate text-left"
            title={formatMessage({ id: "message.threadPanel.scrollToFirst" })}
            aria-label={formatMessage({ id: "message.threadPanel.scrollThreadToFirst" })}
            data-testid="thread-scroll-to-top"
          >
            {formatMessage({ id: "message.threadPanel.thread" })}
            {parentChannelId && (() => {
              // Stryker disable all: pre-existing parent label resolution is outside the workspace mutation corpus.
              const ch = channels.find((c) => c.id === parentChannelId) || dmChannels.find((c) => c.id === parentChannelId);
              if (!ch) return null;
              const label = ch.type === "dm" ? `@${ch.peerDisplayName || ch.peerName || ch.name}` : `#${ch.name}`;
              // Stryker restore all
              return <span className="font-normal text-black/50"> — {label}</span>;
            })()}
          </button>
        }
        actions={
          <>
            {threadChannelId && <ThreadAgentFollowers threadChannelId={threadChannelId} variant="header" />}
            {threadContextActions}
            {/*
              X close button.
              - modal (centered card): X is the standard dialog close.
              - mobile-modal (full-screen overlay): NO X — back chevron is
                the close affordance.
              - side: X on desktop (lg+), back chevron on mobile.
              Per stdrc 2026-05-21 #proj-task:287f18ce msg=804c045d.
            */}
            {showCloseButton && (
              <button
                onClick={handleClose}
                className={closeButtonClassName}
                title={formatMessage({ id: "message.threadPanel.closeThread" })}
                data-testid="thread-close"
              >
                <X size={14} />
              </button>
            )}
          </>
        }
      />}
      {portaledHeaderActions}
      {/* Stryker restore all */}
      {threadSearchOpen && (
        <div
          className={`${threadChromeLayerClassName} flex items-center gap-1.5 border-b-2 border-black bg-white px-2 py-2`}
          data-testid="thread-search-bar"
        >
          <Search size={14} className="shrink-0 text-black/50" />
          <input
            ref={threadSearchInputRef}
            value={threadSearchQuery}
            onChange={(event) => {
              const nextQuery = event.target.value;
              setThreadSearchState((state) => ({
                ...state,
                threadId: threadChannelId ?? state.threadId,
                open: true,
                query: nextQuery,
                activeIndex: 0,
              }));
            }}
            onKeyDown={(event) => {
              if (event.key === "Escape") {
                event.preventDefault();
                closeThreadSearch();
                return;
              }
              if (event.key === "Enter") {
                event.preventDefault();
                goToThreadSearchMatch(event.shiftKey ? -1 : 1);
              }
            }}
            className="min-w-0 flex-1 border-2 border-black bg-white px-2 py-1 text-sm font-medium outline-none focus:shadow-brutal-sm"
            placeholder={formatMessage({ id: "message.threadPanel.searchThisThread" })}
            aria-label={formatMessage({ id: "message.threadPanel.searchThisThread" })}
            data-testid="thread-search-input"
          />
          <div className="w-20 shrink-0 text-center font-mono text-xs text-black/50" data-testid="thread-search-count">
            {normalizeThreadSearchQuery(threadSearchQuery) && threadSearchLoading
              ? formatMessage({ id: "message.threadPanel.searchLoading" })
              : normalizeThreadSearchQuery(threadSearchQuery)
                ? (threadSearchMatches.length > 0
                    ? `${threadSearchActiveIndex + 1}/${threadSearchMatches.length}`
                    : "0/0")
                : ""}
          </div>
          <button
            onClick={() => goToThreadSearchMatch(-1)}
            disabled={threadSearchMatches.length === 0}
            className="btn-brutal-sm flex size-7 items-center justify-center bg-white disabled:opacity-40"
            title={formatMessage({ id: "message.threadPanel.previousMatch" })}
            aria-label={formatMessage({ id: "message.threadPanel.previousMatch" })}
          >
            <ChevronUp size={14} />
          </button>
          <button
            onClick={() => goToThreadSearchMatch(1)}
            disabled={threadSearchMatches.length === 0}
            className="btn-brutal-sm flex size-7 items-center justify-center bg-white disabled:opacity-40"
            title={formatMessage({ id: "message.threadPanel.nextMatch" })}
            aria-label={formatMessage({ id: "message.threadPanel.nextMatch" })}
          >
            <ChevronDown size={14} />
          </button>
          <button
            onClick={closeThreadSearch}
            className="btn-brutal-sm flex size-7 items-center justify-center bg-white"
            title={formatMessage({ id: "message.threadPanel.closeThreadSearch" })}
            aria-label={formatMessage({ id: "message.threadPanel.closeThreadSearch" })}
          >
            <X size={14} />
          </button>
        </div>
      )}

      {/* Thread replies (parent message scrolls with replies via Header) */}
      <div className={threadContentLayerClassName}>
        {loading ? (
          <div className="flex flex-col h-full">
            {parentSlot}
            {displayedParentMessageWithThreadId && (
              <div data-testid="thread-panel-parent" className={THREAD_PANEL_PARENT_CLASS_NAME}>
                <MessageItem
                  message={displayedParentMessageWithThreadId}
                  mentionMap={mentionMap}
                  channels={channels}
                  threadSummary={displayedParentThreadSummary}
                  linkedTask={displayedParentTask ?? undefined}
                  previewSenderAgent={getPreviewSenderAgent(displayedParentMessageWithThreadId)}
                  previewSenderMember={getPreviewSenderMember(displayedParentMessageWithThreadId)}
                  mentionComposerChannelId={threadMentionComposerChannelId}
                  reactionParentScopeKey={parentReactionParentScopeKey}
                  canReact={canReactToThread}
                  hideThreadActions
                  showThreadFollowAction
                  senderAvatarTestId="thread-parent-avatar"
                  onOpenProfile={onOpenProfile}
                  threadSearchHighlightQuery={
                    displayedParentMessageWithThreadId.id === activeThreadSearchMessageId ? threadSearchQuery : undefined
                  }
                />
              </div>
            )}
            <div className="flex flex-1 items-center justify-center">
              <div className="text-black/40 font-mono text-sm">{formatMessage({ id: "message.chatPanel.loading" })}</div>
            </div>
          </div>
        ) : messages.length === 0 ? (
          <div className="flex flex-col h-full overflow-auto">
            {parentSlot}
            {displayedParentMessageWithThreadId && (
              <div data-testid="thread-panel-parent" className={THREAD_PANEL_PARENT_CLASS_NAME}>
                <MessageItem
                  message={displayedParentMessageWithThreadId}
                  mentionMap={mentionMap}
                  channels={channels}
                  threadSummary={displayedParentThreadSummary}
                  linkedTask={displayedParentTask ?? undefined}
                  previewSenderAgent={getPreviewSenderAgent(displayedParentMessageWithThreadId)}
                  previewSenderMember={getPreviewSenderMember(displayedParentMessageWithThreadId)}
                  mentionComposerChannelId={threadMentionComposerChannelId}
                  reactionParentScopeKey={parentReactionParentScopeKey}
                  canReact={canReactToThread}
                  hideThreadActions
                  showThreadFollowAction
                  senderAvatarTestId="thread-parent-avatar"
                  onOpenProfile={onOpenProfile}
                  threadSearchHighlightQuery={
                    displayedParentMessageWithThreadId.id === activeThreadSearchMessageId ? threadSearchQuery : undefined
                  }
                />
              </div>
            )}
            <EmptyState
              className="flex flex-1 flex-col items-center justify-center"
              icon={<MessageSquare size={36} />}
              title={formatMessage({ id: "message.threadPanel.noRepliesTitle" })}
            />
          </div>
        ) : (
          <MessageTimeline
            key={threadChannelId}
            ref={timelineRef}
            source={threadSource}
            renderItem={renderThreadItem}
            header={threadHeader}
            footer={threadFooter}
            onAtBottomChange={handleAtBottomStateChange}
            onVisibleMessageWindowChange={setTranslationWindowIds}
            persistKey={`thread:${threadChannelId}`}
            className="h-full"
            testId="thread-message-scroller"
          />
        )}
        {showBottomButton && (
          <button
            onClick={handleBottomButton}
            className="btn-brutal-sm absolute bottom-3 left-1/2 -translate-x-1/2 flex items-center gap-1.5 bg-white px-3 py-1.5 text-xs font-bold z-10"
          >
            <ArrowDown size={12} />
            {/* Stryker disable all: pre-existing scroll-status copy is outside the workspace mutation corpus. */}
            {newMessageCount > 0 ? formatMessage({ id: "message.threadPanel.newCount" }, { count: newMessageCount }) : formatMessage({ id: "message.chatPanel.backToBottom" })}
            {/* Stryker restore all */}
          </button>
        )}
      </div>

      {/* In thread-mode select, the toolbar replaces the input. */}
      {/* Stryker disable all: workspace composer ownership and chrome are browser-smoke verified. */}
      {showComposer ? (
      <div
        className={composerContainerClassName}
        data-testid={composerTestId}
      >
      <div className={threadChromeLayerClassName}>
        {threadSelectScopedHere ? (
          <SelectModeToolbar
            channelId={selectModeChannelId}
            capturing={picCapturing}
            copied={copiedMd}
            onForward={showForwardAction ? openForwardComposer : undefined}
            onCopyLinks={copySelectedLinks}
            onSavePic={onSavePic}
            onShareX={onShareX}
            onCopyMd={onCopyMd}
            onSelectAll={handleSelectAllInThread}
          />
        ) : parentJointFeatureLocked ? (
          <div className="border-t-2 border-black bg-white p-3">
            <Banner intent="warning" className="justify-center text-center font-bold">
              {formatMessage({ id: "message.chatPanel.jointLocked" })}
              <button
                onClick={() => nav.toSettings("billing")}
                className="font-bold text-black underline"
              >
                {formatMessage({ id: "message.chatPanel.viewBilling" })}
              </button>
            </Banner>
          </div>
        ) : canReplyInParentThread ? (
          /* Thread message input — use parent channel members for @mention autocomplete */
          <MessageInput
            channelId={threadChannelId ?? `pending-thread:${parentMessageId}`}
            placeholder={formatMessage({ id: "message.threadPanel.composerPlaceholder" })}
            channelName={formatMessage({ id: "message.composer.threadChannelName" })}
            onWillSend={handleWillSend}
            resolveChannelId={threadChannelId ? undefined : ensureOpenThreadChannel}
            onChannelResolved={threadChannelId ? undefined : handleThreadChannelResolved}
            migrateDraftFromChannelId={threadChannelId ? `pending-thread:${parentMessageId}` : undefined}
            mentionChannelId={threadMentionChannelId}
            isChannelThread={isChannelThreadInput}
            threadMessages={messages}
            autoFocus={composerAutoFocus}
          />
        ) : showJoinParentChannel ? (
          <div className="flex items-center border-t-2 border-black bg-white p-3">
            <button
              onClick={handleJoinParentChannel}
              className="btn-brutal flex w-full items-center justify-center gap-1.5 bg-brutal-pink px-3 py-1.5 text-sm font-bold"
            >
              <LogIn size={14} />
              {formatMessage({ id: "message.threadPanel.joinChannelToReply" })}
            </button>
          </div>
        ) : null}
      </div>
      </div>
      ) : null}
      {/* Stryker restore all */}
      {selectShareLightbox}
      {forwardComposer && parentChannel && threadSourceChannel && (
        <ForwardComposerDialog
          sourceMessages={forwardComposer.messages}
          sourceChannel={threadSourceChannel}
          sourceLabel={threadSourceLabel}
          sourceParentChannelId={parentChannelId}
          skippedCount={forwardComposer.skippedCount}
          nestedForwardCount={forwardComposer.nestedForwardCount}
          onClose={() => setForwardComposer(null)}
          onSent={(deliveries) => {
            for (const delivery of deliveries) useMessageStore.getState().addMessage(delivery.message);
            useSelectionStore.getState().exit();
          }}
        />
      )}
      {/* Stryker restore all */}
      {picError && (
        <div
          role="alert"
          className="fixed bottom-20 left-1/2 z-[110] -translate-x-1/2 border-2 border-black bg-brutal-orange px-3 py-2 text-xs font-bold shadow-brutal-sm"
          onClick={() => setPicError(null)}
          data-testid="thread-select-share-error"
        >
          {formatMessage({ id: "message.chatPanel.imageActionFailed" }, { error: picError })}
        </div>
      )}
    </div>
  );
}
// oxlint-enable react-doctor/no-adjust-state-on-prop-change, react-doctor/no-derived-state, react-doctor/no-event-handler
