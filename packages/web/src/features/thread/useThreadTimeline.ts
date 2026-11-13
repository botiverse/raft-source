import { useCallback, useEffect, useEffectEvent, useMemo, useRef, useState } from "react";
import type { Dispatch, SetStateAction } from "react";
import type { IntlShape } from "react-intl";
import { isAutoReadHeld } from "../../store/autoReadHold";
import { useReadReceiptStore } from "../../store/readReceiptStore";
import { useThreadStore } from "../../store/threadStore";
import { captureReceiverPrivateIngressContext, isReceiverPrivateIngressContextCurrent, isRetryableReadError, useMessageStore } from "../../store/messageStore";
import type { Message } from "../../store/messageStore";
import { getSocket } from "../../api/socket";
import { noteOutlineMessage } from "../../store/messageOutlineStore";
import { subscribeMessageUpdated } from "../../store/messageUpdatedApply";
import api from "../../api/client";
import { clearHiddenTarget, readHistoryLimitedError, recordHiddenHistory, recordHiddenTarget, useHiddenTarget } from "../../store/hiddenHistoryStore";
import { showToast } from "../../components/toastBridge";
import type { MessageTimelineHandle, MessageTimelineSource } from "../../components/message/MessageTimeline";
import { createTimelinePageGuard } from "../../components/message/timelinePageGuard";
import { useReadReceiptHydrate } from "../../hooks/useReadReceiptHydrate";
import { takeInFlightThreadRepliesPrefetch, takeThreadRepliesPrefetch, threadInitialFocusId, threadRepliesRequest } from "../../store/threadRepliesPrefetch";
import { THREAD_LATEST_WINDOW_LIMIT, mergeThreadBucketWithinWindow, mergeThreadMessageUpdates, mergeThreadMessages, onlyThreadMessages, sortThreadMessages } from "./threadMessages";
import { createThreadLiveReadBatcher, subscribeThreadLiveReplies } from "./threadLiveReplies";
import { useOpenThreadReadAgain } from "./useOpenThreadReadAgain";
import { scrollThreadTimelineToTop } from "./threadPanelDom";
import { useThreadViewSwitch } from "./useThreadViewSwitch";

/**
 * The replies' window: their first load (latest page, or the context of the
 * reply the thread was opened on) with its live subscription, paging older
 * and newer, the jump to the thread's start and back to its bottom, and the
 * source MessageTimeline renders. `messages` is the panel's own state (the
 * select-share handlers read it before this runs).
 */
// oxlint-disable react-doctor/no-adjust-state-on-prop-change, react-doctor/no-derived-state, react-doctor/no-event-handler
export function useThreadTimeline({
  threadChannelId,
  parentMessageId,
  parentTaskId,
  focusedMessageId,
  isTaskModalSurface,
  threadBucket,
  messages,
  setMessages,
  coerceThreadIngress,
  consumeFocusedMessage,
  formatMessage,
}: {
  threadChannelId: string | null;
  parentMessageId: string | null;
  parentTaskId: string | null;
  focusedMessageId: string | null;
  isTaskModalSurface: boolean;
  threadBucket: Message[];
  messages: Message[];
  setMessages: Dispatch<SetStateAction<Message[]>>;
  coerceThreadIngress: (incoming: readonly Message[]) => Message[];
  consumeFocusedMessage: () => void;
  formatMessage: IntlShape["formatMessage"];
}) {
  // The focus as a full id. A ref may name the reply by the 8-character short
  // id agents see in message headers (`#channel:thread msg=c1d2e3f4`; Sage,
  // #triage:#130); the focused load's context answers its full id
  // (`targetMessageId`), and every match by id below uses that. Kept here, not
  // written back to the store: `focusedMessageId` keys the load, so rewriting
  // it would load the thread again. It applies only while the focus it was
  // resolved for is still the focus.
  const [resolvedFocus, setResolvedFocus] = useState<{ from: string; to: string } | null>(null);

  // `messages` declared earlier so useSelectionShareHandlers can read it.
  const [loading, setLoading] = useState(false);
  // The replies' first page failed to load (not "not found": a read that
  // failed). Retry stamps when it was pressed, which runs the loader again.
  const [repliesLoadFailed, setRepliesLoadFailed] = useState(false);
  const [repliesRetryAt, setRepliesRetryAt] = useState<number | null>(null);
  // The thread channel the replies are loaded for: `web.view.switch` ends once they show (useThreadViewSwitch).
  const [repliesFor, setRepliesFor] = useState<string | null>(null);
  useThreadViewSwitch(parentMessageId, !isTaskModalSurface, { threadChannelId, repliesFor, loading, failed: repliesLoadFailed });
  const replyRegionRef = useRef<HTMLDivElement>(null);
  // The reply skeleton's 1-second wait counts from the click that opened the
  // thread (threadStore.openedAt, shared by the resolve shell and the reply
  // timeline), or from Retry. A task modal keeps its own slot, so it counts
  // from the panel's mount.
  const storeOpenedAt = useThreadStore((s) => s.openedAt);
  const [mountedAt] = useState(() => Date.now());
  const openedSince = isTaskModalSurface || !storeOpenedAt ? mountedAt : storeOpenedAt;
  const repliesLoadingSince = Math.max(openedSince, repliesRetryAt ?? 0);
  const [loadingOlder, setLoadingOlder] = useState(false);
  const [loadingNewer, setLoadingNewer] = useState(false);
  // Each direction asks for a page once (timelinePageGuard).
  const [olderPages] = useState(createTimelinePageGuard);
  const [newerPages] = useState(createTimelinePageGuard);
  const resetPageGuards = useCallback(() => {
    olderPages.reset();
    newerPages.reset();
  }, [olderPages, newerPages]);
  const [hasMore, setHasMore] = useState(true);
  const [hasNewer, setHasNewer] = useState(false);
  // A thread is its own read-receipt scope: replies carry the thread's
  // channelId, and agents' thread reads advance the thread's cursor. Like
  // ChatPanel, hydrate once the reply page is not loading.
  const threadReadReceiptScope = useMemo(() => (
    threadChannelId && !loading
      ? { id: threadChannelId, name: "", type: "thread" as const }
      : null
  ), [loading, threadChannelId]);
  useReadReceiptHydrate(threadReadReceiptScope);
  const [searchContextAutoLoadBlockKey, setSearchContextAutoLoadBlockKey] = useState<string | null>(
    null,
  );
  const [historyLimited, setHistoryLimited] = useState(false);
  // The reply this thread was opened on (search hit / permalink) could not be
  // loaded, so the panel fell back to the latest page. Paired with
  // historyLimited this means the target itself is behind the plan cutoff.
  const [focusTargetMissing, setFocusTargetMissing] = useState(false);
  // The focused reply is behind the history window: the paywall centers on it (task #8, frames 8, 9).
  const [hiddenTargetFocus, setHiddenTargetFocus] = useState(false);
  const [newMessageCount, setNewMessageCount] = useState(0);
  const [atBottom, setAtBottom] = useState(true);
  const timelineRef = useRef<MessageTimelineHandle>(null);
  const jumpToThreadStartInFlightRef = useRef(false);
  const isNearBottomRef = useRef(true);
  // Stryker disable all: thread search/newer refs are unrelated to the forward
  // surface and mutate as equivalent initial UI states in this focused oracle.
  const hasNewerRef = useRef(false);
  const { persistLiveRead, noteUnseenLiveReply, readAtBottom } = useOpenThreadReadAgain({ threadChannelId, parentMessageId, isNearBottomRef, hasNewerRef });
  // Stryker restore all
  // Stryker disable all: unchanged thread summary/latest-load logic falls into
  // the diff hunk after extracting task-metadata merge logic; task #486 coverage
  // is the displayed parent task badge and socket delivery path above.
  const hiddenThreadTarget = useHiddenTarget(threadChannelId);
  const showsHiddenTarget = hiddenTargetFocus && hiddenThreadTarget !== null;

  useEffect(() => {
    hasNewerRef.current = hasNewer;
  }, [hasNewer]);

  const isCurrentThread = useCallback((candidateThreadChannelId: string) => {
    const state = useThreadStore.getState();
    return state.openThreadChannelId === candidateThreadChannelId
      // A task conversation's identity lives in the task dialog's slot, and so
      // does a message thread opened in the task dialog (no task id).
      || ((parentTaskId !== null || isTaskModalSurface) && state.taskModal?.threadChannelId === candidateThreadChannelId);
  }, [parentTaskId, isTaskModalSurface]);

  const loadLatestThreadMessages = useCallback(async (nextThreadChannelId: string) => {
    const ingressContext = captureReceiverPrivateIngressContext(
      useMessageStore.getState().currentUserId,
    );
    const limit = 50;
    const { data } = await api.get(`/messages/channel/${nextThreadChannelId}?limit=${limit}`);
    if (!isCurrentThread(nextThreadChannelId)) return null;
    if (!isReceiverPrivateIngressContextCurrent(ingressContext)) {
      // Answered for an earlier viewer or epoch: open the thread again for the
      // current one, so its callers' "Loading replies…" never stays up.
      setRepliesRetryAt(Date.now());
      return null;
    }
    const msgs = onlyThreadMessages(
      nextThreadChannelId,
      coerceThreadIngress(data.messages ?? data),
    );
    setMessages(sortThreadMessages(msgs));
    setHasMore(msgs.length >= limit);
    setHasNewer(false);
    // This is also the fallback when a focused reply's context 404s — which is
    // exactly what a reply behind the plan history cutoff does. Dropping the
    // flag here rendered a cut-off thread as "No replies yet" (task #14).
    recordHiddenHistory(nextThreadChannelId, data);
    setHistoryLimited(!!data.historyLimited);
    setLoading(false);
    setLoadingOlder(false);
    setLoadingNewer(false);
    resetPageGuards();
    return msgs;
  }, [isCurrentThread, coerceThreadIngress, resetPageGuards, setMessages]);
  // Stryker restore all

  // Load thread messages
  // Capture focusedMessageId at effect time so clearing it later doesn't re-trigger the load
  const focusedAtOpenRef = useRef<string | null>(null);
  // Async-loader: thread messages on threadChannelId change. Standard
  // async-loader FP family — reset + fetch + arrival commit.
  // oxlint-disable-next-line react-doctor/no-cascading-set-state
  const subscribeAndLoadThread = useCallback(() => {
    if (!threadChannelId) return;
    let cancelled = false;

    // The parent is no reply: by full id or by its short id, it focuses nothing.
    const initialFocusId = threadInitialFocusId(focusedMessageId, parentMessageId);
    focusedAtOpenRef.current = initialFocusId;
    setFocusTargetMissing(false);
    setHiddenTargetFocus(false);
    setRepliesLoadFailed(false);

    // Use cached messages if available instead of clearing to empty (avoids blank flash)
    const cached = onlyThreadMessages(
      threadChannelId,
      coerceThreadIngress(
        useMessageStore.getState().channelMessages[threadChannelId] ?? [],
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
    setRepliesFor(threadChannelId);
    setNewMessageCount(0);
    setAtBottom(true);
    setHasMore(true);
    setHasNewer(false);
    // A permalink is a bounded context just like a search hit. Layout and
    // programmatic positioning must not page history before a user scroll.
    setSearchContextAutoLoadBlockKey(initialFocusId);
    setHistoryLimited(false);
    setLoadingOlder(false);
    setLoadingNewer(false);
    // The replies start over: a page fetched before may be asked for again.
    resetPageGuards();

    const mergeIntoThread = (incoming: Message[]) => {
      setMessages((prev) => mergeThreadMessages(prev, onlyThreadMessages(threadChannelId, incoming)));
    };

    const socket = getSocket();

    // Merge-only handler for task field updates (no new-message-count bump).
    const updateHandler = (msg: Message) => {
      if (msg.channelId !== threadChannelId) return;
      try {
        const updates = onlyThreadMessages(
          threadChannelId,
          coerceThreadIngress([msg]),
        );
        setMessages((prev) => mergeThreadMessageUpdates(prev, updates));
      } catch (error) {
        console.error("[MessageV2] rejected malformed thread message:updated", msg.id, error);
      }
    };
    // Live (`message:updated`) and the sync log's `message` change both arrive through applyMessageUpdated.
    const unsubscribeUpdates = subscribeMessageUpdated(updateHandler);

    // Live replies: both `message:new` and `thread:updated` can carry a reply.
    // For a DM/private-parent thread, message:new reaches only thread FOLLOWERS'
    // user rooms — never the thread channel room the open panel joined — so an
    // opened-but-not-followed viewer would stay stale; thread:updated reliably
    // reaches every viewer and carries the full reply. Both funnel through one
    // subscription that shares a seen-id set, so a reply arriving on both events
    // (public threads) is applied once and counted at most once.
    const normalizeThreadReply = (raw: unknown): Message | null => {
      if (!raw || typeof raw !== "object") return null;
      let normalized: Message;
      try {
        normalized = coerceThreadIngress([raw as Message])[0] ?? (raw as Message);
      } catch (error) {
        console.error("[MessageV2] rejected malformed thread live reply", error);
        return null;
      }
      // Only replies belonging to THIS thread channel are applied.
      return normalized.channelId === threadChannelId ? normalized : null;
    };
    // A reply that lands in view is read; persist it (debounced) so Activity,
    // which reads the server cursor, agrees with the cleared channel badge.
    const liveRead = createThreadLiveReadBatcher(persistLiveRead);
    const disposeLiveReplies = subscribeThreadLiveReplies({
      socket,
      threadChannelId,
      parentMessageId,
      normalizeReply: normalizeThreadReply,
      getScroll: () => ({ hasNewer: hasNewerRef.current, isNearBottom: isNearBottomRef.current }),
      setMessages,
      bumpNewCount: () => { noteUnseenLiveReply(); setNewMessageCount((c) => c + 1); },
      onReplyLandedInView: liveRead.add,
      onReply: noteOutlineMessage,
    });

    // Clear unread count for this thread in the followed threads list, unless
    // Activity reopened it on its own: then it stays unread until the person
    // acts in it (autoReadHold).
    if (!isAutoReadHeld(threadChannelId)) useThreadStore.getState().clearThreadUnread(threadChannelId);

    // Join socket room for thread channel
    socket.emit("join:channel", threadChannelId);

    const handleReconnect = () => {
      socket.emit("join:channel", threadChannelId);
    };

    socket.on("connect", handleReconnect);

    const INITIAL_LIMIT = THREAD_LATEST_WINDOW_LIMIT;
    // The open's click may have sent this request already (threadRepliesPrefetch): take it;
    // over cached replies (drawn above) only while it is in flight (takeInFlightThreadRepliesPrefetch).
    const firstRequest = threadRepliesRequest(threadChannelId, initialFocusId);
    const showsCachedReplies = !initialFocusId && cached.length > 0;
    const prefetched = (showsCachedReplies ? takeInFlightThreadRepliesPrefetch : takeThreadRepliesPrefetch)(firstRequest);
    const loadPromise = prefetched?.request ?? api.get(firstRequest.url, firstRequest.config);
    const ingressContext = prefetched?.ingressContext ?? captureReceiverPrivateIngressContext(
      useMessageStore.getState().currentUserId,
    );
    const fallbackToLatestThreadMessages = () => {
      setFocusTargetMissing(true);
      // Not behind the window (the route says so with history_limited): the
      // reply is not there, or not for this reader.
      showToast({
        title: formatMessage({ id: "message.chatPanel.messageNotFound" }),
        description: formatMessage({ id: "message.chatPanel.messageNotFoundHint" }),
        type: "warning",
      });
      void loadLatestThreadMessages(threadChannelId).catch((error: unknown) => {
        if (!cancelled) endRepliesLoad(error);
      });
    };
    // An answer for an earlier viewer or server state (the signed-in user or the
    // server's epoch changed while it was in flight, e.g. a cold load where the
    // thread request beats /auth/me) is dropped, and the open runs again for
    // the current state; returning without it left "Loading replies…" for good.
    const reopenAfterStaleAnswer = () => setRepliesRetryAt(Date.now());
    // A read that failed (5xx, timeout, offline) says so where the replies
    // would be, with Retry, instead of an empty thread or "not found". An
    // answer that could not be read is not retried: it stops loading.
    const endRepliesLoad = (error: unknown) => {
      setLoading(false);
      if (isRetryableReadError(error)) setRepliesLoadFailed(true);
    };
    // The focused reply is behind the window: the first replies the window
    // shows after it, under the paywall that centers on it.
    const loadAfterHiddenTarget = (targetSeq: number) => {
      void api.get(`/messages/channel/${threadChannelId}?limit=${INITIAL_LIMIT}&after=${targetSeq}`)
        .then(({ data }) => {
          if (cancelled) return;
          if (!isReceiverPrivateIngressContextCurrent(ingressContext)) {
            reopenAfterStaleAnswer();
            return;
          }
          const msgs = onlyThreadMessages(threadChannelId, coerceThreadIngress(data.messages ?? data));
          mergeIntoThread(msgs);
          setHasMore(false);
          // An after page always reports hasNewer; a short page is the end.
          setHasNewer(msgs.length >= INITIAL_LIMIT);
          setHistoryLimited(true);
          setLoading(false);
        })
        .catch((error: unknown) => {
          if (!cancelled) endRepliesLoad(error);
        });
    };

    // A read sent at the open went out before this panel joined the thread's
    // room: replies posted in between come from a read after its page.
    const catchUpAfter = (msgs: Message[]) => {
      const after = Math.max(0, ...msgs.map((msg) => msg.seq || 0));
      void api.get(`/messages/channel/${threadChannelId}?limit=${INITIAL_LIMIT}&after=${after}`)
        .then(({ data }) => {
          if (cancelled || !isReceiverPrivateIngressContextCurrent(ingressContext)) return;
          const newer = onlyThreadMessages(threadChannelId, coerceThreadIngress(data.messages ?? data));
          if (newer.length > 0) mergeIntoThread(newer);
          if (newer.length >= INITIAL_LIMIT) setHasNewer(true);
        })
        .catch(() => {});
    };

    loadPromise
      .then(({ data }) => {
        if (cancelled) return;
        if (!isReceiverPrivateIngressContextCurrent(ingressContext)) {
          reopenAfterStaleAnswer();
          return;
        }
        const msgs = onlyThreadMessages(
          threadChannelId,
          coerceThreadIngress(data.messages ?? data),
        );
        // The context names the reply's full id, which a short id in the ref
        // is not; a full id answers itself.
        const targetId = initialFocusId && typeof data.targetMessageId === "string" ? data.targetMessageId : initialFocusId;
        if (targetId && !msgs.some((msg) => msg.id === targetId)) {
          fallbackToLatestThreadMessages();
          return;
        }
        if (initialFocusId && targetId && targetId !== initialFocusId) {
          focusedAtOpenRef.current = targetId;
          setResolvedFocus({ from: initialFocusId, to: targetId });
        }
        mergeIntoThread(msgs);
        if (initialFocusId) {
          setHasMore(!!data.hasOlder);
          setHasNewer(!!data.hasNewer);
          // The window can reach the start of what the plan shows.
          recordHiddenHistory(threadChannelId, data);
          clearHiddenTarget(threadChannelId);
          setHistoryLimited(!data.hasOlder && !!data.historyLimited);
        } else {
          setHasMore(msgs.length >= INITIAL_LIMIT);
          setHasNewer(false);
          recordHiddenHistory(threadChannelId, data);
          setHistoryLimited(!!data.historyLimited);
        }
        setLoading(false);
        if (prefetched && !(initialFocusId && data.hasNewer)) catchUpAfter(msgs);
      })
      .catch((error: unknown) => {
        if (cancelled) return;
        if (initialFocusId) {
          const historyLimited = readHistoryLimitedError(error);
          const hiddenTarget = historyLimited?.hiddenTarget ?? null;
          if (hiddenTarget) {
            const hiddenTargetId = historyLimited?.targetMessageId ?? null;
            if (hiddenTargetId && hiddenTargetId !== initialFocusId) {
              focusedAtOpenRef.current = hiddenTargetId;
              setResolvedFocus({ from: initialFocusId, to: hiddenTargetId });
            }
            recordHiddenTarget(threadChannelId, hiddenTarget);
            setHiddenTargetFocus(true);
            loadAfterHiddenTarget(hiddenTarget.target.seq);
            return;
          }
          if (isRetryableReadError(error)) endRepliesLoad(error);
          else fallbackToLatestThreadMessages();
          return;
        }
        endRepliesLoad(error);
      });

    return () => {
      cancelled = true;
      disposeLiveReplies();
      liveRead.flush();
      unsubscribeUpdates();
      socket.off("connect", handleReconnect);
      socket.emit("leave:channel", threadChannelId);
      // Out of the room, its scope_read events stop: the next open loads read receipts again.
      useReadReceiptStore.getState().forgetScopeFreshness(threadChannelId);
    };
  }, [threadChannelId, parentMessageId, coerceThreadIngress, focusedMessageId, formatMessage, loadLatestThreadMessages, resetPageGuards, persistLiveRead, noteUnseenLiveReply, setMessages]);
  // Effect deps stay narrow on purpose: the focused id is captured at thread-open
  // time and clearing it later must not restart the loader. useEffectEvent gives the effect
  // the latest closure without widening the dep list.
  const subscribeAndLoadThreadEvent = useEffectEvent(subscribeAndLoadThread);
  // A retry (repliesRetryAt) runs the same open again.
  useEffect(() => subscribeAndLoadThreadEvent(), [threadChannelId, repliesRetryAt]);

  useEffect(() => {
    if (!threadChannelId || threadBucket.length === 0) return;
    setMessages((prev) => {
      const filteredThreadBucket = onlyThreadMessages(
        threadChannelId,
        coerceThreadIngress(threadBucket),
      );
      return mergeThreadBucketWithinWindow(
        prev,
        filteredThreadBucket,
        hasNewerRef.current,
      );
    });
  }, [coerceThreadIngress, threadBucket, threadChannelId, setMessages]);

  // Load older messages (pagination)
  // `force`: page back even though the last page said there was no more (the
  // plan stopped cutting history).
  const loadOlderPage = useCallback(async (force: boolean) => {
    if (!threadChannelId || loadingOlder || (!hasMore && !force) || messages.length === 0) return;

    const minSeq = Math.min(...messages.map((m) => m.seq || Infinity));
    if (!minSeq || minSeq === Infinity) return;
    // The state guard above lags a render (timelinePageGuard).
    const pageKey = `${threadChannelId}:${minSeq}`;
    if (!olderPages.start(pageKey)) return;
    let pageLoaded = false;

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
        coerceThreadIngress(data.messages ?? data),
      );
      setMessages((prev) => {
        const existingIds = new Set(prev.map((m) => m.id));
        const newMsgs = older.filter((m) => !existingIds.has(m.id));
        return newMsgs.length === 0 ? prev : [...newMsgs, ...prev];
      });
      setHasMore(older.length >= limit);
      recordHiddenHistory(requestThreadChannelId, data);
      setHistoryLimited(!!data.historyLimited);
      pageLoaded = true;
    } catch {
      // ignore
    } finally {
      olderPages.finish(pageKey, pageLoaded);
      setLoadingOlder(false);
    }
  }, [hasMore, isCurrentThread, loadingOlder, messages, coerceThreadIngress, olderPages, threadChannelId, setMessages]);
  const loadOlderMessages = useCallback(() => loadOlderPage(false), [loadOlderPage]);

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
          coerceThreadIngress(data.messages ?? data),
        );
        next = mergeThreadMessages(next, older);
        nextHasMore = older.length >= limit;
        recordHiddenHistory(requestThreadChannelId, data);
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
  }, [hasMore, historyLimited, isCurrentThread, messages, coerceThreadIngress, threadChannelId, setMessages]);

  const loadNewerMessages = useCallback(async () => {
    if (!threadChannelId || loadingNewer || !hasNewer || loading || messages.length === 0) return;

    const maxSeq = Math.max(...messages.map((m) => m.seq || 0));
    if (!maxSeq || maxSeq === Infinity) return;
    // Same lag as loadOlderPage (timelinePageGuard).
    const pageKey = `${threadChannelId}:${maxSeq}`;
    if (!newerPages.start(pageKey)) return;
    let pageLoaded = false;

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
        coerceThreadIngress(data.messages ?? data),
      );
      setMessages((prev) => {
        const existingIds = new Set(prev.map((m) => m.id));
        const newMsgs = newer.filter((m) => !existingIds.has(m.id));
        return mergeThreadMessages(prev, newMsgs);
      });
      setHasNewer(newer.length >= limit);
      pageLoaded = true;
    } catch {
      // ignore
    } finally {
      newerPages.finish(pageKey, pageLoaded);
      setLoadingNewer(false);
    }
  }, [hasNewer, isCurrentThread, loading, loadingNewer, messages, coerceThreadIngress, newerPages, threadChannelId, setMessages]);

  const handleAtBottomStateChange = useCallback((atBottom: boolean) => {
    isNearBottomRef.current = atBottom;
    setAtBottom(atBottom);
    if (atBottom) setNewMessageCount(0);
    readAtBottom(atBottom);
  }, [readAtBottom]);

  const scrollToBottom = useCallback(() => {
    timelineRef.current?.scrollToBottom();
    setNewMessageCount(0);
  }, []);

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

  // Stryker disable all: the ThreadPanel-to-MessageTimeline source wiring is pinned by the structural bounded-context contract; timeline behavior is covered separately.
  const threadSource = useMemo<MessageTimelineSource>(() => ({
    messages,
    hasOlder: hasMore,
    hasNewer,
    loading,
    loadOlder: loadOlderMessages,
    loadNewer: loadNewerMessages,
    initialFocusMessageId: showsHiddenTarget ? null : focusedAtOpenRef.current,
    initialAtStart: showsHiddenTarget,
    // Each focused open resets the paywall until its answer comes.
    atStartKey: showsHiddenTarget ? hiddenThreadTarget?.target.id ?? null : null,
    sentinelAutoLoadBlockKey: searchContextAutoLoadBlockKey,
  }), [
    showsHiddenTarget,
    hiddenThreadTarget,
    messages,
    hasMore,
    hasNewer,
    loading,
    loadOlderMessages,
    loadNewerMessages,
    searchContextAutoLoadBlockKey,
  ]);
  // Stryker restore all

  // Retry unmounts its own button: focus moves to the reply region, which
  // stays (busy, then the replies), instead of falling to <body>.
  const handleRetryRepliesLoad = useCallback(() => {
    setRepliesRetryAt(Date.now());
    replyRegionRef.current?.focus({ preventScroll: true });
  }, []);

  return {
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
  };
}
// oxlint-enable react-doctor/no-adjust-state-on-prop-change, react-doctor/no-derived-state, react-doctor/no-event-handler
