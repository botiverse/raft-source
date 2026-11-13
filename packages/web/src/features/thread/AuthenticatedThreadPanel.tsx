import { deferredDialog } from "../../boot/deferredUi";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { MutableRefObject, ReactNode } from "react";
import type { SideSectionHead } from "../../components/task/sideSectionDrag";
import { useIntl } from "react-intl";
import { ThreadPanelContent, ThreadPanelRoot } from "@botiverse/raft-ui";
import { useRowHeadOnly } from "../../components/layout/rowPlanStore";
import { useThreadStore } from "../../store/threadStore";
import { useAgentStore } from "../../store/agentStore";
import { useChannelStore } from "../../store/channelStore";
import type { Channel } from "../../store/channelStore";
import { useLoungeAgentName } from "../../components/agent/agentLounge";
import { useMessageStore } from "../../store/messageStore";
import { coerceWireMessageSeqs } from "../../store/wireMessageSeq";
import type { Message } from "../../store/messageStore";
import { useServerStore } from "../../store/serverStore";
import { useAuthStore } from "../../store/authStore";
import { useTaskMetadataForMessage } from "../../store/taskStore";
import { getSocket } from "../../api/socket";
import { useHiddenHistory } from "../../store/hiddenHistoryStore";
import { useThreadUnreadHoldRelease } from "../../components/message/threadUnreadHold";
import { useToastViewportFloor } from "../../components/toastViewportBottom";
import { SelectShareLightbox } from "../../components/message/DeferredSelectShareLightbox";
import { useSelectShareErrorToast } from "../../components/message/useSelectShareErrorToast";
import { useLocation, useNavigate } from "react-router-dom";
import { usePaywallUpgrade } from "../../hooks/usePaywallUpgrade";
import { openThreadParentMessageRoute } from "../../components/layout/rightPanelUrlSync";
import { VisibleMessageTranslations, useVisibleMessageWindowStore } from "../../components/message/VisibleMessageTranslations";
import { EMPTY_MESSAGES } from "./threadMessages";
import { threadSelectableIds, useThreadSelectionActions } from "./useThreadSelectionActions";
import { useThreadParentChannel } from "./useThreadParentChannel";
import { useThreadMentionMaps } from "./useThreadMentionMaps";
import { useThreadPanelBack } from "./useThreadPanelBack";
import { useThreadTimeline } from "./useThreadTimeline";
import { useThreadParent } from "./useThreadParent";
import { useThreadFocus } from "./useThreadFocus";
import { useOutlineFocus, useThreadOutlineRail } from "./useThreadOutlineRail";
import { useThreadSearch } from "./useThreadSearch";
import { useThreadTimelineRows } from "./useThreadTimelineRows";
import { ThreadPanelResolvingShell } from "./ThreadPanelResolvingShell";
import { ThreadPanelHeader } from "./ThreadPanelHeader";
import { ThreadSearchBar } from "./ThreadSearchBar";
import { ThreadPanelReplies } from "./ThreadPanelReplies";
import { MessageSelectIntentProvider } from "../../components/message/MessageSelectIntentProvider";
import { AgentReadProgressContext } from "../../components/message/agentReadProgressContext";
import { ThreadPanelComposer } from "./ThreadPanelComposer";

/** A stable empty Lounge list for a store state written without the slice. */
const NO_LOUNGES: Channel[] = [];
const ForwardComposerDialog = deferredDialog(() => import("../../components/message/ForwardComposerDialog"));

// ThreadPanel renders the thread *content surface*: header + parent message
// pinned + replies timeline + composer. It is presentation-agnostic about the
// column container — sizing/border/positioning/resize are owned by the host
// (chat-side col-4 wrapper, modal wrapper, mobile-modal wrapper, /search
// col-3 mount). Per stdrc 2026-05-28 #proj-uiux:c2313b1d msg=138867ba: page
// object lives in a column container; the same ThreadPanel renders identically
// in every host, with small surface-intrinsic differences (X close
// visibility, back-chevron breakpoint) flowing through props.
// Explicit thread identity makes the original stateful surface reusable across independently mounted hosts.
// oxlint-disable react-doctor/no-adjust-state-on-prop-change, react-doctor/no-derived-state, react-doctor/no-event-handler
export function AuthenticatedThreadPanel({
  allowExpand = false,
  presentation = "side",
  edge = "attached",
  onClose,
  threadIdentity,
  onFocusedMessageConsumed,
  onOpenProfile,
  // Stryker disable all: host defaults are exercised by browser smoke.
  showComposer = true,
  overlayComposer = false,
  mobilePage = false,
  composerAutoFocus = true,
  hideHeader = false,
  hideParentMessage = false,
  parentSlot,
  emptyState,
  searchCommandRef,
  backCommandRef,
  headerLeading,
  headerDrag,
  // Stryker restore all
}: {
  headerLeading?: ReactNode;
  headerDrag?: SideSectionHead;
  allowExpand?: boolean;
  // Surface-intrinsic axis (NOT column layout — the host owns layout):
  //   side          — X close visible at lg+ only (mobile uses back chevron),
  //                   back chevron up to lg-
  //   modal         — X close always visible (centered dialog needs close),
  //                   back chevron up to md-
  //   mobile-modal  — NO X (full-screen overlay; back chevron is the close),
  //                   back chevron up to md-
  presentation?: "side" | "modal" | "mobile-modal";
  // Whether the panel draws its own left divider. "attached" (default): it
  // sits beside the chat, which has none, so the panel owns the line.
  // "inset": the host column on its left already draws it (Activity / Search
  // master list), and a second line would read as one 2px seam (task #110).
  edge?: "attached" | "inset";
  // Optional override for the X / back close affordance, for hosts that need extra teardown
  // beyond closeThread (e.g. the /search col-3 host clears the search slot so col-3 doesn't go blank).
  onClose?: () => void;
  threadIdentity?: {
    /** Null for a sub-conversation without a parent message: a task's own
     *  conversation (task v2), identified by `parentTaskId` instead. */
    parentMessageId: string | null;
    parentChannelId: string;
    threadChannelId: string | null;
    focusedMessageId?: string | null;
    /** Names the jump to `focusedMessageId`, new on every jump (the store's
     *  `focusNonce`), so a second jump to the same reply restarts its located
     *  highlight. */
    focusNonce?: number;
    /** Task v2: the task whose conversation this is (no parent message). */
    parentTaskId?: string | null;
  };
  /** Clears a focus authority owned outside threadStore, such as Activity's
   * persistent master/detail `?msg=` anchor. */
  onFocusedMessageConsumed?: () => void;
  onOpenProfile?: (kind: "agent" | "human", id: string) => void;
  showComposer?: boolean;
  overlayComposer?: boolean;
  /** Dedicated new-tab page mode: mobile uses a full-bleed surface with a bottom-pinned composer. */
  mobilePage?: boolean;
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
  /** Replaces the "No replies yet" state of an empty conversation. */
  emptyState?: ReactNode;
  /** See ThreadPanelProps.searchCommandRef. */
  searchCommandRef?: MutableRefObject<(() => void) | null>;
  /** See ThreadPanelProps.backCommandRef. */
  backCommandRef?: MutableRefObject<(() => void) | null>;
}) {
  // A toast sits above this panel's footer: the composer or the bar in its place (toastViewportBottom.ts).
  const toastFloorRef = useToastViewportFloor();
  // One host node for `parentSlot` for the panel's lifetime; see ParentSlotMount.
  const parentSlotHost = useMemo(() => {
    const host = document.createElement("div");
    host.style.display = "contents";
    return host;
  }, []);
  const { formatMessage } = useIntl();
  // Stryker disable all: explicit identity projection is contract-pinned and browser-smoke verified.
  const storeParentMessageId = useThreadStore((s) => s.openParentMessageId);
  const storeThreadChannelId = useThreadStore((s) => s.openThreadChannelId);
  const storeParentChannelId = useThreadStore((s) => s.openParentChannelId);
  const storeFocusedMessageId = useThreadStore((s) => s.focusedMessageId);
  const storeFocusNonce = useThreadStore((s) => s.focusNonce);
  const parentMessageId = threadIdentity?.parentMessageId ?? storeParentMessageId;
  const threadChannelId = threadIdentity ? threadIdentity.threadChannelId : storeThreadChannelId;
  const parentChannelId = threadIdentity?.parentChannelId ?? storeParentChannelId;
  const { focusedMessageId, focusNonce, jumpToReply, clearOutlineFocus } = useOutlineFocus(threadChannelId, threadIdentity ? { messageId: threadIdentity.focusedMessageId ?? null, nonce: threadIdentity.focusNonce ?? 0 } : { messageId: storeFocusedMessageId, nonce: storeFocusNonce });
  // Marked unread from its menu: unread until the person leaves the thread.
  useThreadUnreadHoldRelease(threadChannelId);
  // Its messages' menus mark this thread unread, as its header ⋯ does.
  const openThread = useMemo(() => ({ threadChannelId, parentMessageId }), [threadChannelId, parentMessageId]);
  // Task v2: a task's own conversation has no parent message; the task is its
  // parent. `conversationKey` names the conversation either way (the parent
  // message id for a thread, so everything keyed by it stays as it was).
  const parentTaskId = threadIdentity?.parentTaskId ?? null;
  const conversationKey = parentMessageId ?? (parentTaskId ? `task:${parentTaskId}` : null);
  // A task conversation is its own channel: its agent typing is keyed there,
  // never the parent channel's top-level typing (which is what a null root means).
  const typingChannelId = parentTaskId ? threadChannelId : parentChannelId;
  const showHeader = !hideHeader;
  // Stryker restore all
  const threadSummaries = useThreadStore((s) => s.summaries);
  const followedThreads = useThreadStore((s) => s.followedThreads);
  const realtimeParentTaskUpdate = useTaskMetadataForMessage(parentMessageId);
  const closeThread = useThreadStore((s) => s.closeThread);
  // The task modal owns an independent identity slot (task #699): a modal
  // presentation whose threadIdentity comes from that slot reads the slot's
  // lookup state too, never the side thread's.
  const taskModalSlot = useThreadStore((s) => s.taskModal);
  const isTaskModalSurface = presentation !== "side" && taskModalSlot !== null && threadIdentity !== undefined;
  const storeOpenThreadError = useThreadStore((s) => s.openThreadError);
  const storeOpenThreadLoading = useThreadStore((s) => s.openThreadLoading);
  const openThreadError = isTaskModalSurface ? taskModalSlot.error : storeOpenThreadError;
  const openThreadLoading = isTaskModalSurface ? taskModalSlot.loading : storeOpenThreadLoading;
  const retryOpenThreadFromStore = useThreadStore((s) => s.retryOpenThread);
  const retryTaskModal = useThreadStore((s) => s.retryTaskModal);
  const retryOpenThread = isTaskModalSurface ? retryTaskModal : retryOpenThreadFromStore;
  const ensureOpenThreadChannel = useThreadStore((s) => s.ensureOpenThreadChannel);
  const ensureTaskModalThreadChannel = useThreadStore((s) => s.ensureTaskModalThreadChannel);
  // task #750: a task-modal composer's first send must resolve the thread from
  // the taskModal slot, not the side thread's open* slots (which are null
  // there and threw "No open thread to resolve" → "创建消息列失败").
  const ensureSurfaceThreadChannel = isTaskModalSurface ? ensureTaskModalThreadChannel : ensureOpenThreadChannel;
  const clearFocusedMessage = useThreadStore((s) => s.clearFocusedMessage);
  const clearTaskModalFocusedMessage = useThreadStore((s) => s.clearTaskModalFocusedMessage);
  // A focus is retired where it came from: a task modal's own slot, never the
  // side thread's (whose focus may belong to another open thread).
  const consumeFocusedMessage = useCallback(() => {
    clearOutlineFocus();
    if (isTaskModalSurface) clearTaskModalFocusedMessage();
    else clearFocusedMessage();
    onFocusedMessageConsumed?.();
  }, [clearFocusedMessage, clearOutlineFocus, clearTaskModalFocusedMessage, isTaskModalSurface, onFocusedMessageConsumed]);
  const threadBucket = useMessageStore((s) =>
    threadChannelId ? (s.channelMessages[threadChannelId] ?? EMPTY_MESSAGES) : EMPTY_MESSAGES
  );
  const parentChannelBucket = useMessageStore((s) =>
    parentChannelId ? (s.channelMessages[parentChannelId] ?? EMPTY_MESSAGES) : EMPTY_MESSAGES
  );
  const currentUser = useAuthStore((s) => s.user);

  const agents = useAgentStore((s) => s.agents);
  const channels = useChannelStore((s) => s.channels);
  const dmChannels = useChannelStore((s) => s.dmChannels);
  const loungeChannels = useChannelStore((s) => s.loungeChannels ?? NO_LOUNGES);
  const joinChannel = useChannelStore((s) => s.joinChannel);
  const joiningParentChannel = useChannelStore((s) => parentChannelId !== undefined && parentChannelId !== null && s.joiningChannelIds[parentChannelId] === true);
  const currentServer = useServerStore((s) => s.current);
  const serverSlug = currentServer?.slug;
  // A thread in an agent's Lounge is named after the Lounge ("{Name}'s Lounge"), as its channel is.
  const parentLoungeRow = useMemo(
    () => (parentChannelId ? loungeChannels.find((c) => c.id === parentChannelId) ?? null : null),
    [loungeChannels, parentChannelId],
  );
  const parentLoungeAgentName = useLoungeAgentName(parentLoungeRow);
  const parentLoungeTitle = parentLoungeRow ? formatMessage({ id: "agent.lounge.title" }, { name: parentLoungeAgentName }) : undefined;
  const {
    parentRouteKind,
    parentChannel,
    threadSourceChannel,
    parentJointFeatureLocked,
    parentExternalFrozen,
    parentDmAgent,
    parentDmAppBotRemoved,
    isGuest,
    showForwardAction,
    forwardState,
    threadSourceLabel,
    parentJoined,
    parentLoungeReadOnly,
    canReactToThread,
  } = useThreadParentChannel({ parentChannelId, threadChannelId, channels, dmChannels, loungeChannels, agents, currentServer, formatMessage, loungeTitle: parentLoungeTitle });

  // A thread opened where its parent was never loaded this session (Activity,
  // Search, Drafts: no channel route ran MainLayout's ensureChannel) would not
  // know its parent, and so not whether you may reply: an agent's Lounge is
  // listed nowhere until opened. Load the parent once (the store puts a Lounge
  // in its own slice).
  const ensureChannel = useChannelStore((s) => s.ensureChannel);
  const parentKnown = parentChannel !== null;
  useEffect(() => {
    if (!parentChannelId || parentKnown) return;
    void ensureChannel(parentChannelId);
  }, [ensureChannel, parentChannelId, parentKnown]);

  // ThreadPanel keeps its replies in local state (NOT messageStore.channelMessages),
  // so we declare `messages` here BEFORE the share-handlers hook can read it.
  // huxijin 2026-05-02 #proj-mobile a8748fc2: select-share in thread was
  // dropping all children because messageStore doesn't bucket replies for
  // the thread channel — ThreadPanel keeps them in local state and now
  // feeds them into useSelectionShareHandlers via the threadReplyMessages opt.
  const [messages, setMessages] = useState<Message[]>([]);
  const messagesRef = useRef(messages);
  messagesRef.current = messages;
  const {
    threadSelectScopedHere,
    forwardComposer,
    threadParentMessageRef,
    panelRef,
    picCapturing,
    picCaptureProgress,
    cancelPicCapture,
    picPreview,
    picError,
    setPicError,
    copiedMd,
    onSavePic,
    onCopyMd,
    openForwardComposer,
    forwardSingleMessage,
    copySelectedLinks,
    selectModeChannelId,
    handleClosePicPreview,
    handleRetryPicCapture,
    handlePicPreviewSaved,
    handleCloseForwardComposer,
    handleForwardComposerSent,
  } = useThreadSelectionActions({ parentMessageId, parentChannelId, threadChannelId, messages, parentChannel, serverSlug, formatMessage, closeThread, onClose });

  const { mentionMap, agentById, memberById, externalById } = useThreadMentionMaps({ parentChannelId, threadChannelId, agents });
  const routeNavigate = useNavigate();
  const location = useLocation();

  const coerceThreadIngress = useCallback((
    incoming: readonly Message[],
  ): Message[] => [...coerceWireMessageSeqs(incoming)], []);
  const paywallUpgrade = usePaywallUpgrade();
  const openJointUpgrade = useCallback(() => (parentExternalFrozen
    ? paywallUpgrade("external_channel_frozen", "channel_banner")
    : paywallUpgrade("joint_channel_read_only")), [paywallUpgrade, parentExternalFrozen]);

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

  const { handleClose, mobileBackHandler } = useThreadPanelBack({ serverSlug, parentChannelId, parentRouteKind, location, presentation, onClose, closeThread });
  const foldedByExpand = useRowHeadOnly("thread");

  // Visible replies feed translation through a store read by
  // <VisibleMessageTranslations>, so scrolling never re-renders this panel.
  const translationWindow = useVisibleMessageWindowStore();

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
  const resolveRegionRef = useRef<HTMLDivElement>(null);
  const {
    resolvedFocus,
    loading,
    repliesLoadFailed,
    replyRegionRef,
    repliesLoadingSince,
    loadingOlder,
    loadingNewer,
    olderPages,
    hasMore,
    hasNewer,
    historyLimited,
    focusTargetMissing,
    showsHiddenTarget,
    newMessageCount,
    atBottom,
    timelineRef,
    setHasMore,
    setHasNewer,
    setHistoryLimited,
    setLoadingOlder,
    setLoadingNewer,
    setSearchContextAutoLoadBlockKey,
    isCurrentThread,
    loadLatestThreadMessages,
    loadOlderPage,
    jumpToThreadStart,
    handleAtBottomStateChange,
    scrollToBottom,
    handleBackToBottom,
    handleWillSend,
    threadSource,
    handleRetryRepliesLoad,
  } = useThreadTimeline({ threadChannelId, parentMessageId, parentTaskId, focusedMessageId, isTaskModalSurface, threadBucket, messages, setMessages, coerceThreadIngress, consumeFocusedMessage, formatMessage });
  const outlineRail = useThreadOutlineRail(jumpToReply, jumpToThreadStart, { parentChannelId, parentMessageId, parentRouteKind, parentTaskId, serverSlug });

  const {
    parentMessage,
    displayedParentMessageWithThreadId,
    displayedParentTask,
    displayedParentThreadSummary,
    parentSourceTasks,
    taskV2,
  } = useThreadParent({
    parentMessageId, parentChannelId, threadChannelId, hideParentMessage, parentChannelBucket, followedThreads, threadSummaries,
    agentById, memberById, currentUser, realtimeParentTaskUpdate, coerceThreadIngress, messages,
  });
  threadParentMessageRef.current = displayedParentMessageWithThreadId;
  // What select-all takes is what the panel shows: no parent where it is
  // hidden (the task dialog shows it above the thread).
  const selectableIds = useMemo(
    () => threadSelectableIds(hideParentMessage ? null : displayedParentMessageWithThreadId, messages),
    [displayedParentMessageWithThreadId, hideParentMessage, messages],
  );
  // Every reply is loaded: none older, none newer, none behind the plan's limit.
  const selectableComplete = !hasMore && !hasNewer && !historyLimited;
  const translationLeadingMessage = parentMessage && !hideParentMessage ? parentMessage : null;
  const hiddenThreadHistory = useHiddenHistory(threadChannelId);

  const { effectiveFocusId, focusedMessageLoaded, locatedReplyId } = useThreadFocus({ focusedMessageId, resolvedFocus, messages, focusNonce, timelineRef, consumeFocusedMessage });

  // Upgraded while this thread was cut (server:plan-updated): page back past
  // the old window (or load the replies at all); the answer drops the paywall.
  // Once per thread and plan: a failed request or an answer that is still cut
  // (the plan written in two steps) must not ask again in a loop.
  const historyPlan = useServerStore((s) => s.billing?.plan || s.current?.plan);
  const historyReopenedForRef = useRef<string | null>(null);
  useEffect(() => {
    if (!historyPlan || historyPlan === "free" || !historyLimited || !threadChannelId) return;
    const key = `${threadChannelId}:${historyPlan}`;
    if (historyReopenedForRef.current === key) return;
    historyReopenedForRef.current = key;
    if (messages.length > 0) {
      olderPages.reset();
      void loadOlderPage(true);
    }
    else void loadLatestThreadMessages(threadChannelId).catch(() => undefined);
  }, [historyLimited, historyPlan, loadLatestThreadMessages, loadOlderPage, messages.length, olderPages, threadChannelId]);

  const handleThreadChannelResolved = useCallback((resolvedThreadChannelId: string) => {
    if (!parentMessageId) {
      // Task v2: the first send created the task's conversation; bind the
      // dialog to it so the panel loads and the composer posts there.
      if (parentTaskId) useThreadStore.getState().bindTaskConversationChannel(parentTaskId, resolvedThreadChannelId);
      return;
    }
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
    // task #750: on the modal surface the durable accept also binds the
    // taskModal slot, so the panel's identity (and composer) rebinds to the
    // real channel. Anchor-checked so a stale accept can't clobber a newer
    // modal. The server slug participates in the guard like every other
    // anchor comparison in this store (#750 follow-up).
    if (isTaskModalSurface) {
      useThreadStore.setState((prev) =>
        prev.taskModal
        && prev.taskModal.parentMessageId === parentMessageId
        && prev.taskModal.serverSlug === taskModalSlot?.serverSlug
          ? { taskModal: { ...prev.taskModal, threadChannelId: resolvedThreadChannelId } }
          : {},
      );
    }
  }, [parentMessageId, parentTaskId, isTaskModalSurface, taskModalSlot?.serverSlug]);

  const {
    threadSearchInputRef,
    setThreadSearchState,
    threadSearchOpen,
    threadSearchQuery,
    threadSearchLoading,
    threadSearchMatches,
    threadSearchActiveIndex,
    activeThreadSearchMessageId,
    closeThreadSearch,
    goToThreadSearchMatch,
    handleOpenThreadSearch,
    markThreadSearchScopeActive,
    handlePrevThreadSearchMatch,
    handleNextThreadSearchMatch,
  } = useThreadSearch({
    threadChannelId, conversationKey, messages, hasMore, hasNewer, isCurrentThread, coerceThreadIngress, displayedParentMessageWithThreadId, picPreview, panelRef,
    messagesRef, timelineRef,
    replySetters: { setMessages, setHasMore, setHasNewer, setHistoryLimited, setLoadingOlder, setLoadingNewer, setSearchContextAutoLoadBlockKey },
    replyFocus: { messageId: effectiveFocusId, nonce: focusNonce, loaded: focusedMessageLoaded, ready: !loading && !focusTargetMissing && messages.length > 0 },
  });

  const handleJoinParentChannel = useCallback(() => {
    if (!parentChannelId) return;
    void joinChannel(parentChannelId, "thread_panel");
  }, [joinChannel, parentChannelId]);

  const {
    agentReadProgress,
    threadPaywallScope,
    threadFoldedMessageIds,
    getPreviewSenderAgent,
    getPreviewSenderMember,
    threadMentionComposerChannelId,
    parentReactionParentScopeKey,
    renderThreadItem,
    threadLeadingRows,
    renderThreadLeadingRow,
    selectModeListEnd,
    threadFooter,
  } = useThreadTimelineRows({
    messages, formatMessage, agentById, memberById, currentUser, currentServer, threadChannelId, parentChannelId, parentMessageId, parentRouteKind,
    hasMore, hasNewer, historyLimited, loadingOlder, loadingNewer, showsHiddenTarget, activeThreadSearchMessageId, threadSearchQuery,
    canReactToThread, channels, externalById, mentionMap, locatedReplyId: outlineRail.locatedParentId ?? locatedReplyId, onOpenProfile, parentSlot, parentSlotHost,
    displayedParentMessageWithThreadId, displayedParentTask, parentSourceTasks, displayedParentThreadSummary,
    showComposer, typingChannelId, threadSelectScopedHere,
  });

  // Memoized JSX handlers (react-perf): declared above the early returns so
  // hook order stays stable regardless of loading/error branches below.
  const handleRetryOpenThread = useCallback(() => { void retryOpenThread(); }, [retryOpenThread]);
  const handleRetryOpenThreadFocused = useCallback(() => {
    resolveRegionRef.current?.focus({ preventScroll: true });
    handleRetryOpenThread();
  }, [handleRetryOpenThread]);
  useSelectShareErrorToast({ picError, setPicError, onRetry: handleRetryPicCapture });
  const handleOpenParentChannelAction = useCallback(() => {
    if (!parentMessageId || !parentChannelId) return;
    const routeKind = parentRouteKind === "dm" ? "dm" : "channel";
    // Reserve the canonical ?msg= URL before navigating, then clear the store
    // synchronously. BrowserRouter commits route state in a transition; the
    // ownership marker prevents an already-queued origin effect from racing
    // stale thread params back into the store before that commit lands.
    // Desktop preserves its existing PUSH semantics, while mobile replaces the
    // current thread detail entry and records the synchronous mobile-back step.
    openThreadParentMessageRoute({
      isDesktop,
      parentRouteKind: routeKind,
      parentChannelId,
      parentMessageId,
      serverSlug,
      navigate: routeNavigate,
    });
  }, [parentMessageId, parentChannelId, parentRouteKind, isDesktop, serverSlug, routeNavigate]);
  // A host-drawn header's More menu (the task dialog) runs the same command.
  useEffect(() => {
    if (!searchCommandRef) return;
    searchCommandRef.current = handleOpenThreadSearch;
    return () => {
      if (searchCommandRef.current === handleOpenThreadSearch) searchCommandRef.current = null;
    };
  }, [handleOpenThreadSearch, searchCommandRef]);
  // A host-drawn Back (task v2's covering column with tabs) does what the head's Back does.
  useEffect(() => {
    if (!backCommandRef) return;
    backCommandRef.current = mobileBackHandler;
    return () => {
      if (backCommandRef.current === mobileBackHandler) backCommandRef.current = null;
    };
  }, [backCommandRef, mobileBackHandler]);

  const threadContentLayerClassName = mobilePage
    ? "relative z-base min-h-0 flex-1 overflow-hidden"
    : "relative z-base min-h-0 flex-1 overflow-hidden";
  // Restored from 4afe5677e (lost in the #7347 revert merge, e8765efaf): the
  // chrome layer the header/composer sit in, above the z-base content layer.
  const threadChromeLayerClassName = "relative z-chrome shrink-0";

  if (!conversationKey) return null;
  const showBottomButton = hasNewer || !atBottom || newMessageCount > 0;
  const handleBottomButton = hasNewer ? handleBackToBottom : scrollToBottom;
  // Outer always fills its host's flex column. Column-layout (border/width/
  // resize/positioning/z-stack) lives on the host wrapper; ThreadPanel only
  // owns the surface content per stdrc msg=138867ba.
  // iPad Safari can keep the momentum scroller's composited hit-test layer
  // above adjacent flex siblings after history scroll; keep thread chrome in
  // explicit stack layers so back/input remain reachable.
  const panelClassName = "isolate flex h-full min-h-0 w-full flex-col bg-layer-canvas";
  // Inside the task sheet the modal frame (or the screen edge) already bounds
  // the panel, so the root's attached left edge would sit right beside the
  // frame's and read as a doubled line (task #741). Only the side column uses
  // that edge as its divider.
  const panelEdgeClassName = presentation === "modal" || presentation === "mobile-modal" || edge === "inset" ? " border-l-0" : "";
  // X close button visibility, per stdrc 2026-05-21 #proj-task:287f18ce
  // msg=804c045d: "它作为弹窗就需要叉；如果它是直接覆盖整个页面，就是返回."
  //   modal        — X (centered card with backdrop, X is the dialog close)
  //   mobile-modal — NO X (full-screen overlay, back chevron handles close)
  //   side         — X on desktop (lg+) only; mobile uses back chevron
  const closeButtonClassName = presentation === "modal"
    ? "flex"
    : "hidden lg:flex";

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
      <ThreadPanelResolvingShell
        panelClassName={panelClassName}
        showHeader={showHeader}
        mobileBackHandler={mobileBackHandler}
        handleClose={handleClose}
        closeButtonClassName={closeButtonClassName}
        resolveRegionRef={resolveRegionRef}
        resolveFailed={resolveFailed}
        handleRetryOpenThreadFocused={handleRetryOpenThreadFocused}
        openThreadError={openThreadError}
        currentServer={currentServer}
        repliesLoadingSince={repliesLoadingSince}
      />
    );
  }
  // Stryker disable all: select-share lightbox rendering predates this forward
  // change and is covered by share-lightbox behavior outside the forward mutation
  // corpus.
  const selectShareLightbox = picPreview ? (
    <SelectShareLightbox
      images={picPreview}
      filename={`raft-thread-${new Date().toISOString().slice(0, 10)}.png`}
      onClose={handleClosePicPreview}
      onSaved={handlePicPreviewSaved}
    />
  ) : null;
  // Stryker restore all

  return (
    <ThreadPanelRoot
      ref={panelRef}
      className={panelClassName + panelEdgeClassName}
      data-shortcut-scope="thread"
      onPointerDownCapture={markThreadSearchScopeActive}
      onFocusCapture={markThreadSearchScopeActive}
    >
      <VisibleMessageTranslations store={translationWindow} messages={messages} leading={translationLeadingMessage} />
      {/* Stryker disable all: header ownership is browser-smoke verified. */}
      {showHeader && <ThreadPanelHeader
        headerLeading={headerLeading}
        headerDrag={headerDrag}
        presentation={presentation}
        mobileBackHandler={mobileBackHandler}
        handleClose={handleClose}
        closeButtonClassName={closeButtonClassName}
        jumpToThreadStart={jumpToThreadStart}
        parentChannelId={parentChannelId}
        parentMessageId={parentMessageId}
        threadChannelId={threadChannelId}
        parentChannel={parentChannel}
        parentLoungeTitle={parentLoungeTitle}
        messages={messages}
        historyLimited={historyLimited}
        hiddenThreadHistory={hiddenThreadHistory}
        displayedParentThreadSummary={displayedParentThreadSummary}
        loading={loading}
        repliesLoadFailed={repliesLoadFailed}
        handleOpenParentChannelAction={handleOpenParentChannelAction}
        handleOpenThreadSearch={handleOpenThreadSearch}
        allowExpand={allowExpand}
      />}
      {/* Folded to its head by a region expanded in its column (#189 rule 5), its content stays laid out out of sight
          (index.css `data-thread-collapsed="expand"`), and out of reach: inert, whenever it mounts. */}
      <ThreadPanelContent inert={(presentation === "side" && foldedByExpand) || undefined}>
      {/* Stryker restore all */}
      {threadSearchOpen && (
        <ThreadSearchBar
          threadChromeLayerClassName={threadChromeLayerClassName}
          threadSearchInputRef={threadSearchInputRef}
          threadSearchQuery={threadSearchQuery}
          setThreadSearchState={setThreadSearchState}
          threadChannelId={threadChannelId}
          parentTaskId={parentTaskId}
          threadSearchLoading={threadSearchLoading}
          threadSearchMatches={threadSearchMatches}
          threadSearchActiveIndex={threadSearchActiveIndex}
          closeThreadSearch={closeThreadSearch}
          goToThreadSearchMatch={goToThreadSearchMatch}
          handlePrevThreadSearchMatch={handlePrevThreadSearchMatch}
          handleNextThreadSearchMatch={handleNextThreadSearchMatch}
        />
      )}

      {/* Thread replies (parent message scrolls with replies via Header) */}
      {/* The reply region stays from the first frame: busy while the
          replies load (DS Feedback), and where Retry leaves focus. */}
      {/* The replies' agent read progress (null: off here), and their select intent: a range takes what select-all would. */}
      <AgentReadProgressContext.Provider value={agentReadProgress}><MessageSelectIntentProvider timelineRef={timelineRef} selectableIds={selectableIds}>
      <ThreadPanelReplies
        replyRegionRef={replyRegionRef}
        threadContentLayerClassName={threadContentLayerClassName}
        selectModeListEnd={selectModeListEnd}
        selectableIds={selectableIds}
        showForwardAction={showForwardAction}
        forwardSingleMessage={forwardSingleMessage}
        openThread={openThread}
        parentSlot={parentSlot}
        parentSlotHost={parentSlotHost}
        loading={loading}
        messages={messages}
        displayedParentMessageWithThreadId={displayedParentMessageWithThreadId}
        mentionMap={mentionMap}
        channels={channels}
        displayedParentThreadSummary={displayedParentThreadSummary}
        displayedParentTask={displayedParentTask}
        parentSourceTasks={parentSourceTasks}
        getPreviewSenderAgent={getPreviewSenderAgent}
        getPreviewSenderMember={getPreviewSenderMember}
        threadMentionComposerChannelId={threadMentionComposerChannelId}
        parentReactionParentScopeKey={parentReactionParentScopeKey}
        canReactToThread={canReactToThread}
        onOpenProfile={onOpenProfile}
        activeThreadSearchMessageId={activeThreadSearchMessageId}
        threadSearchQuery={threadSearchQuery}
        repliesLoadingSince={repliesLoadingSince}
        repliesLoadFailed={repliesLoadFailed}
        handleRetryRepliesLoad={handleRetryRepliesLoad}
        historyLimited={historyLimited}
        threadChannelId={threadChannelId}
        focusTargetMissing={focusTargetMissing}
        showsHiddenTarget={showsHiddenTarget}
        threadPaywallScope={threadPaywallScope}
        emptyState={emptyState}
        timelineRef={timelineRef}
        threadSource={threadSource}
        renderThreadItem={renderThreadItem}
        threadFoldedMessageIds={threadFoldedMessageIds}
        threadLeadingRows={threadLeadingRows}
        renderThreadLeadingRow={renderThreadLeadingRow}
        threadFooter={threadFooter}
        handleAtBottomStateChange={handleAtBottomStateChange}
        translationWindow={translationWindow}
        showComposer={showComposer}
        typingChannelId={typingChannelId}
        parentMessageId={parentMessageId}
        showBottomButton={showBottomButton}
        handleBottomButton={handleBottomButton}
        newMessageCount={newMessageCount}
        outlineRail={outlineRail}
        focusTargetId={effectiveFocusId}
      />
      </MessageSelectIntentProvider></AgentReadProgressContext.Provider>

      {/* In thread-mode select, the toolbar replaces the input. */}
      {/* Stryker disable all: composer ownership and chrome are browser-smoke verified. */}
      {showComposer ? (
      <ThreadPanelComposer
        toastFloorRef={toastFloorRef}
        overlayComposer={overlayComposer}
        mobilePage={mobilePage}
        threadChromeLayerClassName={threadChromeLayerClassName}
        isGuest={isGuest}
        parentJoined={parentJoined}
        parentChannelId={parentChannelId}
        parentChannel={parentChannel}
        parentLoungeReadOnly={parentLoungeReadOnly}
        threadSelectScopedHere={threadSelectScopedHere}
        selectModeChannelId={selectModeChannelId}
        panelRef={panelRef}
        picCapturing={picCapturing}
        cancelPicCapture={cancelPicCapture}
        picCaptureProgress={picCaptureProgress}
        copiedMd={copiedMd}
        forwardState={forwardState}
        openForwardComposer={openForwardComposer}
        copySelectedLinks={copySelectedLinks}
        onSavePic={onSavePic}
        onCopyMd={onCopyMd}
        selectableIds={selectableIds}
        selectableComplete={selectableComplete}
        parentJointFeatureLocked={parentJointFeatureLocked}
        parentExternalFrozen={parentExternalFrozen}
        openJointUpgrade={openJointUpgrade}
        currentServer={currentServer}
        parentDmAppBotRemoved={parentDmAppBotRemoved}
        parentDmAgent={parentDmAgent}
        threadChannelId={threadChannelId}
        conversationKey={conversationKey}
        hideParentMessage={hideParentMessage}
        handleWillSend={handleWillSend}
        taskV2={taskV2}
        ensureSurfaceThreadChannel={ensureSurfaceThreadChannel}
        handleThreadChannelResolved={handleThreadChannelResolved}
        composerAutoFocus={composerAutoFocus}
        messages={messages}
        parentMessageId={parentMessageId}
        parentMessage={parentMessage}
        handleJoinParentChannel={handleJoinParentChannel}
        joiningParentChannel={joiningParentChannel}
      />
      ) : null}
      </ThreadPanelContent>
      {/* Stryker restore all */}
      {selectShareLightbox}
      {!isGuest && forwardComposer && parentChannel && threadSourceChannel && (
        <ForwardComposerDialog
          sourceMessages={forwardComposer.messages}
          sourceChannel={threadSourceChannel}
          sourceLabel={threadSourceLabel}
          sourceParentChannelId={parentChannelId}
          skippedCount={forwardComposer.skippedCount}
          nestedForwardCount={forwardComposer.nestedForwardCount}
          onClose={handleCloseForwardComposer}
          onSent={handleForwardComposerSent}
        />
      )}
      {/* Stryker restore all */}
    </ThreadPanelRoot>
  );
}
// oxlint-enable react-doctor/no-adjust-state-on-prop-change, react-doctor/no-derived-state, react-doctor/no-event-handler
