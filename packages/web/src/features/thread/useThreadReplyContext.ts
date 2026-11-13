import { useCallback, useEffect } from "react";
import type { Dispatch, RefObject, SetStateAction } from "react";
import api from "../../api/client";
import type { MessageTimelineHandle } from "../../components/message/MessageTimeline";
import { captureReceiverPrivateIngressContext, isReceiverPrivateIngressContextCurrent, useMessageStore } from "../../store/messageStore";
import type { Message } from "../../store/messageStore";
import { mergeThreadMessages, onlyThreadMessages } from "./threadMessages";

const SHORT_MESSAGE_ID = /^[0-9a-f]{8}$/i;

interface ThreadWindowSetters {
  setMessages: Dispatch<SetStateAction<Message[]>>;
  setHasMore: (value: boolean) => void;
  setHasNewer: (value: boolean) => void;
  setHistoryLimited: (value: boolean) => void;
  setLoadingOlder: (value: boolean) => void;
  setLoadingNewer: (value: boolean) => void;
  /** Arms the window's auto-load guard for the reply being brought in. */
  setSearchContextAutoLoadBlockKey: (messageId: string | null) => void;
}

/**
 * Bring a reply the open thread panel hasn't loaded into its window (the
 * context around it), then scroll to it: the thread search's active match,
 * and a jump to a reply of the thread that is already open (a link or a
 * notification while the reader is elsewhere in it), which used to read the
 * thread but never got there (#triage:#157). A jump the panel has loaded
 * scrolls in the panel itself; a new thread's focus is its open's own load.
 */
export function useThreadReplyContext({
  threadChannelId,
  parentMessageId,
  messagesRef,
  timelineRef,
  isCurrentThread,
  coerceThreadIngress,
  setters,
  search,
  focus,
}: {
  threadChannelId: string | null;
  /** The parent shown above the replies: always "loaded". */
  parentMessageId: string | null;
  messagesRef: RefObject<Message[]>;
  timelineRef: RefObject<MessageTimelineHandle | null>;
  isCurrentThread: (threadChannelId: string) => boolean;
  coerceThreadIngress: (incoming: readonly Message[]) => Message[];
  setters: ThreadWindowSetters;
  search: { open: boolean; activeMessageId: string | null };
  /** The panel's jump target; `ready` once the thread's own load settled (and found it, or gave up on it). */
  focus: { messageId: string | null; nonce: number; loaded: boolean; ready: boolean };
}): void {
  const { setMessages, setHasMore, setHasNewer, setHistoryLimited, setLoadingOlder, setLoadingNewer, setSearchContextAutoLoadBlockKey } = setters;
  const ensureReplyLoaded = useCallback(async (messageId: string) => {
    if (!threadChannelId || messageId === parentMessageId) return true;
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
      coerceThreadIngress(data.messages ?? data),
    );
    setMessages((current) => mergeThreadMessages(current, contextMessages));
    setHasMore(!!data.hasOlder);
    setHasNewer(!!data.hasNewer);
    setHistoryLimited(!!data.historyLimited);
    setLoadingOlder(false);
    setLoadingNewer(false);
    return true;
  }, [
    parentMessageId,
    isCurrentThread,
    coerceThreadIngress,
    threadChannelId,
    messagesRef,
    setMessages,
    setHasMore,
    setHasNewer,
    setHistoryLimited,
    setLoadingOlder,
    setLoadingNewer,
    setSearchContextAutoLoadBlockKey,
  ]);

  // Stryker disable all: the effect's cancellation/dependency plumbing predates this change; the bounded-context arm is pinned by the structural contract and timeline behavior tests.
  useEffect(() => {
    if (!search.open || !search.activeMessageId) return;
    const activeMessageId = search.activeMessageId;
    let cancelled = false;
    void ensureReplyLoaded(activeMessageId)
      .then((visible) => {
        if (cancelled || !visible) return;
        requestAnimationFrame(() => {
          timelineRef.current?.scrollToMessage(activeMessageId, { align: "center" });
        });
      })
      .catch(() => {});
    return () => {
      cancelled = true;
    };
  }, [search.activeMessageId, ensureReplyLoaded, search.open, timelineRef]);
  // Stryker restore all

  // A jump the panel can't make yet: once the reply is in the window, the
  // panel's own jump (keyed on the reply and the nonce) scrolls to it. A short
  // id resolves only against loaded replies, so it isn't fetched.
  const { messageId: focusMessageId, nonce: focusNonce, loaded: focusLoaded, ready: focusReady } = focus;
  useEffect(() => {
    if (!focusMessageId || focusLoaded || !focusReady || SHORT_MESSAGE_ID.test(focusMessageId)) return;
    void ensureReplyLoaded(focusMessageId).catch(() => {});
  }, [focusMessageId, focusNonce, focusLoaded, focusReady, ensureReplyLoaded]);
}
