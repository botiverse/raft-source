import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { RefObject } from "react";
import { captureReceiverPrivateIngressContext, isReceiverPrivateIngressContextCurrent, useMessageStore } from "../../store/messageStore";
import type { Message } from "../../store/messageStore";
import api from "../../api/client";
import type { MessageTimelineHandle } from "../../components/message/MessageTimeline";
import type { ValidatedScreenshot } from "../../utils/screenshotBudget";
import { buildThreadSearchMatches, getThreadSearchableMessages, normalizeThreadSearchQuery, normalizeThreadSearchSelectionText } from "../../components/message/threadSearch";
import { useShortcut } from "../shortcuts/useShortcut";
import { mergeThreadMessages, onlyThreadMessages, sortThreadMessages } from "./threadMessages";
import { useThreadReplyContext } from "./useThreadReplyContext";
import { getThreadPanelSelectedSearchText } from "./threadPanelDom";

const THREAD_SEARCH_HYDRATION_DEBOUNCE_MS = 250;

export interface ThreadSearchPanelState {
  threadId: string | null;
  open: boolean;
  query: string;
  activeIndex: number;
  hydratedThreadId: string | null;
  loadingThreadId: string | null;
  corpusMessages: Message[];
}

type ThreadReplyContextOptions = Parameters<typeof useThreadReplyContext>[0];

/**
 * Search in this thread (⌘F while the panel has focus): the bar's state, the
 * whole thread loaded as its corpus, the matches and the active one, which
 * useThreadReplyContext brings into the replies' window.
 */
// oxlint-disable react-doctor/no-adjust-state-on-prop-change, react-doctor/no-derived-state, react-doctor/no-event-handler
export function useThreadSearch({
  threadChannelId,
  conversationKey,
  messages,
  hasMore,
  hasNewer,
  isCurrentThread,
  coerceThreadIngress,
  displayedParentMessageWithThreadId,
  picPreview,
  panelRef,
  messagesRef,
  timelineRef,
  replySetters,
  replyFocus,
}: {
  threadChannelId: string | null;
  conversationKey: string | null;
  messages: Message[];
  hasMore: boolean;
  hasNewer: boolean;
  isCurrentThread: (threadChannelId: string) => boolean;
  coerceThreadIngress: (incoming: readonly Message[]) => Message[];
  displayedParentMessageWithThreadId: Message | null;
  picPreview: ValidatedScreenshot[] | null;
  panelRef: RefObject<HTMLDivElement | null>;
  messagesRef: ThreadReplyContextOptions["messagesRef"];
  timelineRef: RefObject<MessageTimelineHandle | null>;
  replySetters: ThreadReplyContextOptions["setters"];
  replyFocus: ThreadReplyContextOptions["focus"];
}) {
  const threadSearchInputRef = useRef<HTMLInputElement>(null);
  const threadSearchScopeActiveRef = useRef(false);
  // Stryker disable all: thread search/newer refs are unrelated to the forward
  // surface and mutate as equivalent initial UI states in this focused oracle.
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
  const threadSearchStateIsCurrent = !!threadChannelId && threadSearchState.threadId === threadChannelId;
  const threadSearchOpen = threadSearchStateIsCurrent && threadSearchState.open;
  const threadSearchQuery = threadSearchStateIsCurrent ? threadSearchState.query : "";
  // Stryker disable next-line ConditionalExpression,EqualityOperator: thread-search loading state is outside the forward/copy selection oracle.
  const threadSearchLoading = threadSearchState.loadingThreadId === threadChannelId;
  const rawThreadSearchActiveIndex = threadSearchStateIsCurrent ? threadSearchState.activeIndex : 0;

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
        coerceThreadIngress(data.messages ?? data),
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
        coerceThreadIngress(data.messages ?? data),
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
  }, [hasMore, hasNewer, isCurrentThread, messages, coerceThreadIngress, threadChannelId]);

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
  useThreadReplyContext({
    threadChannelId, parentMessageId: displayedParentMessageWithThreadId?.id ?? null, messagesRef, timelineRef, isCurrentThread, coerceThreadIngress,
    setters: replySetters,
    search: { open: threadSearchOpen, activeMessageId: activeThreadSearchMessageId },
    focus: replyFocus,
  });

  // ⌘F / Ctrl+F (or the person's keys) in the thread panel (the "thread" scope), or on the body after the last
  // click or focus landed in it (the dispatcher's rule); a task conversation (no parent message) is searched the same
  // way. Closing the search leaves the body's key to the browser until the panel is clicked or focused again.
  useShortcut("search-thread", (event) => {
    if (event.target === document.body && !threadSearchScopeActiveRef.current) return false;
    openThreadSearch(getThreadPanelSelectedSearchText(panelRef.current));
  }, { enabled: !!conversationKey && !picPreview, scopeRef: panelRef });

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

  // Wrap so the menu's click event never leaks in as the seed query.
  const handleOpenThreadSearch = useCallback(() => openThreadSearch(), [openThreadSearch]);
  const markThreadSearchScopeActive = useCallback(() => {
    threadSearchScopeActiveRef.current = true;
  }, []);
  const handlePrevThreadSearchMatch = useCallback(() => goToThreadSearchMatch(-1), [goToThreadSearchMatch]);
  const handleNextThreadSearchMatch = useCallback(() => goToThreadSearchMatch(1), [goToThreadSearchMatch]);

  return {
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
  };
}
// oxlint-enable react-doctor/no-adjust-state-on-prop-change, react-doctor/no-derived-state, react-doctor/no-event-handler
