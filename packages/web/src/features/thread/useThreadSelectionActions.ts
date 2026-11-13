import { useCallback, useEffect, useRef, useState } from "react";
import type { IntlShape } from "react-intl";
import { toast } from "@botiverse/raft-ui";
import type { Channel } from "../../store/channelStore";
import { useMessageStore } from "../../store/messageStore";
import type { Message } from "../../store/messageStore";
import { useSelectionStore } from "../../store/selectionStore";
import { useExitSelectionReturningFocus } from "../../components/message/SelectModeToolbar";
import type { ForwardDelivery } from "../../components/message/ForwardComposerDialog";
import { gatherSelectedMessagesWithMeta, useSelectionShareHandlers } from "../../components/message/useSelectionShareHandlers";
import { formatCopyLinksToast, formatForwardSelectionBlockedMessage, getForwardableMessages } from "../../components/message/forwardSelectionUtils";
import { isRangeSelectableMessage } from "../../components/message/messageRangeSelection";
import { forwardToast } from "../../components/message/forwardToast";
import { buildMessagePermalink } from "../../hooks/useAppNavigate";
import { useShortcutLayer } from "../../features/shortcuts/useShortcutLayer";

const SELECTION_TOAST_OPTIONS = { icon: false, dismissible: false } as const;

/**
 * What a thread's select-all checkbox selects: its parent and every loaded
 * reply that can be forwarded (not system updates, action cards or forwarded
 * bundles) and is not retracted (isRangeSelectableMessage, what a range takes).
 */
export function threadSelectableIds(parent: Message | null, replies: readonly Message[]): string[] {
  return (parent ? [parent, ...replies] : replies).filter(isRangeSelectableMessage).map((message) => message.id);
}

/**
 * Thread-mode select: the select-share handlers, the Escape paths of the
 * panel, the forward composer (a selection or one row) and Copy
 * Links. Scoped to this thread root, as ChatPanel's is to its channel.
 */
// oxlint-disable react-doctor/no-adjust-state-on-prop-change, react-doctor/no-derived-state, react-doctor/no-event-handler
export function useThreadSelectionActions({
  parentMessageId,
  parentChannelId,
  threadChannelId,
  messages,
  parentChannel,
  serverSlug,
  formatMessage,
  closeThread,
  onClose,
}: {
  parentMessageId: string | null;
  parentChannelId: string | null;
  threadChannelId: string | null;
  messages: Message[];
  parentChannel: Channel | null;
  serverSlug: string | undefined;
  formatMessage: IntlShape["formatMessage"];
  closeThread: () => void;
  onClose: (() => void) | undefined;
}) {
  // Keep locale-bound formatMessage out of effect/handler deps (render + memos use
  // it directly); toasts/handlers read formatMessageRef.current.
  const formatMessageRef = useRef(formatMessage);
  formatMessageRef.current = formatMessage;

  // Selection / share state. The hook wraps capture / download / clipboard
  // plumbing so ChatPanel and ThreadPanel stay in lock-step. ThreadPanel
  // only renders the toolbar when select mode is anchored at *this* thread
  // root — channel-mode select stays scoped to ChatPanel.
  const selectModeActive = useSelectionStore((s) => s.isActive);
  const selectModeThreadRootId = useSelectionStore((s) => s.threadRootId);
  const threadSelectScopedHere =
    selectModeActive && selectModeThreadRootId !== null && selectModeThreadRootId === parentMessageId;
  const [forwardComposer, setForwardComposer] = useState<{
    messages: Message[];
    skippedCount: number;
    nestedForwardCount: number;
  } | null>(null);
  const threadParentMessageRef = useRef<Message | null>(null);
  // Stryker disable all: thread selection forward/copy wiring is covered by focused DOM behavior tests; defensive no-context guards are intentionally no-op.
  const showUnresolvedSelectionToast = useCallback((unresolvedCount: number) => {
    toast.info(
      formatMessageRef.current({ id: "message.chatPanel.unresolvedMessages" }, { count: unresolvedCount }),
      SELECTION_TOAST_OPTIONS,
    );
  }, []);
  // Stryker restore all
  const panelRef = useRef<HTMLDivElement>(null);
  const exitSelectionReturningFocus = useExitSelectionReturningFocus(panelRef);
  const {
    picCapturing,
    picCaptureProgress,
    cancelPicCapture,
    picPreview,
    setPicPreview,
    picError,
    setPicError,
    copiedMd,
    onSavePic,
    onCopyMd,
  } = useSelectionShareHandlers({
    threadReplyMessages: messages,
    threadParentMessageRef,
    captureScopeRef: panelRef,
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
  // A layer on the registry's stack while selecting here. Focus goes back into this thread (its reply composer, the
  // message the selection started on, or its replies), not to <body>; the share preview owns Esc while it is up.
  useShortcutLayer("selection", threadSelectScopedHere, {
    ignoreDefaultPrevented: true,
    onEscape: () => (picPreview ? false : void exitSelectionReturningFocus()),
  });

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
      // Capture is needed to observe Escape before a tooltip can stop
      // propagation, but the eventual close must still let a focused child
      // consume the key first.
      queueMicrotask(() => {
        if (event.defaultPrevented) return;
        event.preventDefault();
        // Dedicated thread-window hosts own the final close operation: attempt
        // the browser close first, then return a normal tab to the server route.
        // Keep Escape on the same host-aware path as the visible close button
        // instead of only clearing threadStore.
        (onClose ?? closeThread)();
      });
    };
    // Listen before document-capture tooltip dismissal. Base UI's tooltip
    // consumes Escape there; a focused control inside this panel should still
    // follow the panel's Escape-close path on its first keypress.
    // keydown-global-exempt: capture-phase thread Escape close
    window.addEventListener("keydown", handler, true);
    return () => window.removeEventListener("keydown", handler, true);
  }, [closeThread, onClose, parentMessageId, picPreview, threadSelectScopedHere]);

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

  // One message, straight from its row (task #35): same composer, no select mode.
  const forwardSingleMessage = useCallback((message: Message) => {
    const { messages: forwardable, nestedForwardCount } = getForwardableMessages([message]);
    if (forwardable.length === 0) return;
    setForwardComposer({ messages: forwardable, skippedCount: 0, nestedForwardCount });
  }, []);

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
  // Stryker disable next-line StringLiteral: select-mode only renders while scoped to a known thread; this is a defensive child-prop fallback.
  const selectModeChannelId = threadChannelId ?? "";

  const handleClosePicPreview = useCallback(() => {
    cancelPicCapture();
    setPicPreview(null);
  }, [cancelPicCapture, setPicPreview]);
  const handleRetryPicCapture = useCallback(() => {
    setPicError(null);
    void onSavePic();
  }, [onSavePic, setPicError]);
  const handlePicPreviewSaved = useCallback(() => {
    setPicPreview(null);
    useSelectionStore.getState().exit();
  }, [setPicPreview]);
  const handleCloseForwardComposer = useCallback(() => setForwardComposer(null), []);
  const handleForwardComposerSent = useCallback((deliveries: ForwardDelivery[]) => {
    for (const delivery of deliveries) useMessageStore.getState().addMessage(delivery.message);
    useSelectionStore.getState().exit();
  }, []);

  return {
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
  };
}
// oxlint-enable react-doctor/no-adjust-state-on-prop-change, react-doctor/no-derived-state, react-doctor/no-event-handler
