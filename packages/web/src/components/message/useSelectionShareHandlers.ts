import { useState, useCallback } from "react";
import type { RefObject } from "react";
import { useIntl } from "react-intl";
import { useSelectionStore } from "../../store/selectionStore";
import { useMessageStore } from "../../store/messageStore";
import type { Message } from "../../store/messageStore";
import {
  captureSelectedMessages,
  SelectScreenshotTimeoutError,
  SHARE_PREVIEW_MAX_WIDTH,
} from "../../utils/selectScreenshot";
import {
  selectionToMarkdown,
  copyTextToClipboard,
  createSelectedMessagesShareArtifact,
  dataUrlToPngFile,
  navigateShareArtifactToX,
} from "../../utils/selectMarkdown";

/**
 * Resolve the messages currently selected, regardless of selection mode.
 *
 * Channel mode: resolve the selected ids from the channel cache plus the
 * currently visible ChatPanel window when it belongs to the selected channel.
 * The visible window is part of the local source of truth because context-menu
 * selection can happen before `channelMessages[channelId]` has the same row.
 * Thread descendants already had their ids stuffed into selectedIds at enter
 * time.
 *
 * Thread mode: the parent lives in `messageStore.channelMessages[
 * threadRootChannelId]` — easy to find. Replies live in **ThreadPanel's
 * local state**, NOT `messageStore.channelMessages[threadId]`, because
 * ThreadPanel maintains its own merge-on-realtime list (see PR #1190 v1.4
 * "Replaced global messageStore.channelMessages thread-bucket dependency
 * with new threadReplyMessages prop fed by ThreadPanel's local state —
 * source of truth aligns with what's on screen").
 *
 * Therefore the caller (`ThreadPanel`) MUST pass its local replies via
 * the `threadReplyMessages` opt or the children won't be found and the
 * export degrades to "parent only" — exactly the regression huxijin
 * caught at #proj-mobile a8748fc2 2026-05-02.
 *
 * Each result is annotated with `isThreadChild` so the renderer can indent
 * replies one step under their parent in the export.
 */
export function gatherSelectedMessages(opts?: {
  channelMessages?: readonly Message[];
  threadReplyMessages?: readonly Message[];
  threadParentMessageRef?: RefObject<Message | null>;
}): Array<Message & { isThreadChild: boolean }> {
  return gatherSelectedMessagesWithMeta(opts).messages;
}

export interface SelectedMessagesResolution {
  messages: Array<Message & { isThreadChild: boolean }>;
  unresolvedCount: number;
}

export function gatherSelectedMessagesWithMeta(opts?: {
  channelMessages?: readonly Message[];
  threadReplyMessages?: readonly Message[];
  threadParentMessageRef?: RefObject<Message | null>;
}): SelectedMessagesResolution {
  const sel = useSelectionStore.getState();
  if (!sel.isActive || sel.selectedIds.size === 0) return { messages: [], unresolvedCount: 0 };
  const ms = useMessageStore.getState();
  const seen = new Map<string, Message>();
  const pushFrom = (bucket: readonly Message[] | undefined, overwrite = false) => {
    if (!bucket) return;
    for (const m of bucket) {
      if (!sel.selectedIds.has(m.id)) continue;
      if (overwrite || !seen.has(m.id)) seen.set(m.id, m);
    }
  };
  const visibleMessagesFor = (channelId: string | null | undefined) => (
    channelId && ms.currentChannelId === channelId ? ms.messages : []
  );
  const channelSurfaceMessages = (channelId: string, callerVisibleMessages?: readonly Message[]) => {
    const cached = ms.channelMessages[channelId] ?? [];
    const visible = callerVisibleMessages ?? visibleMessagesFor(channelId);
    return visible.length > 0 ? [...cached, ...visible] : cached;
  };
  if (sel.channelId) {
    pushFrom(channelSurfaceMessages(sel.channelId, opts?.channelMessages));
  }
  if (sel.threadRootChannelId) {
    pushFrom(channelSurfaceMessages(sel.threadRootChannelId));
  }
  if (!sel.threadRootId && sel.channelId === opts?.channelMessages?.[0]?.channelId) {
    pushFrom(opts.channelMessages, true);
  }
  const threadParentMessage = opts?.threadParentMessageRef?.current ?? null;
  if (
    sel.threadRootId &&
    threadParentMessage &&
    sel.selectedIds.has(threadParentMessage.id) &&
    !seen.has(threadParentMessage.id)
  ) {
    seen.set(threadParentMessage.id, threadParentMessage);
  }
  // For channel-mode parents that have replies, the replies live in the
  // parent's `threadId` bucket; the live channel window may have the fresher
  // parent, so scan both it and the cached channel bucket for selected parents.
  if (!sel.threadRootId && sel.channelId) {
    const channelBucket = channelSurfaceMessages(sel.channelId, opts?.channelMessages);
    for (const m of channelBucket) {
      if (sel.selectedIds.has(m.id) && m.threadId) pushFrom(ms.channelMessages[m.threadId]);
    }
  }
  // Thread mode: prefer the caller-supplied ThreadPanel local replies
  // because messageStore doesn't keep a bucket for the thread channel.
  // (Falling back to messageStore.channelMessages[channelId] is harmless
  // — it's almost always empty in thread mode — but exists for callers
  // that don't pass threadReplyMessages.)
  if (sel.threadRootId && opts?.threadReplyMessages) {
    pushFrom(opts.threadReplyMessages);
  }

  // Tag thread-children. In thread mode any non-root selected id is a child.
  // In channel mode, a child is anything whose id appears in some selected
  // parent's thread bucket.
  const childIds = new Set<string>();
  if (sel.threadRootId) {
    for (const id of seen.keys()) if (id !== sel.threadRootId) childIds.add(id);
  } else if (sel.channelId) {
    const channelBucket = channelSurfaceMessages(sel.channelId, opts?.channelMessages);
    for (const m of channelBucket) {
      if (sel.selectedIds.has(m.id) && m.threadId) {
        const replies = ms.channelMessages[m.threadId] ?? [];
        for (const r of replies) if (sel.selectedIds.has(r.id)) childIds.add(r.id);
      }
    }
  }
  const messages = Array.from(seen.values())
    .map((m) => Object.assign({ isThreadChild: childIds.has(m.id) }, m))
    .sort((a, b) => {
      // Sort by seq when available so output reads top-to-bottom in chat
      // order, regardless of click order. Thread children are kept right
      // after their parent in the rendered list — see selectionToMarkdown
      // / captureSelectedMessages for child-after-parent ordering.
      if (a.seq != null && b.seq != null) return a.seq - b.seq;
      return Date.parse(a.createdAt) - Date.parse(b.createdAt);
    });
  return { messages, unresolvedCount: sel.selectedIds.size - seen.size };
}

export interface SelectionShareHandlers {
  picCapturing: boolean;
  picPreview: string | null;
  setPicPreview: (v: string | null) => void;
  picError: string | null;
  setPicError: (v: string | null) => void;
  copiedMd: boolean;
  onSavePic: () => Promise<void>;
  onShareX: () => Promise<void>;
  onSharePreviewToX: (dataUrl: string) => Promise<void>;
  onCopyMd: () => Promise<void>;
}

/**
 * Shared share-action handlers used by both ChatPanel (channel mode) and
 * ThreadPanel (thread mode). Centralizes the rasterize / intent-window /
 * clipboard plumbing so the two surfaces don't drift.
 *
 * Filename choice for the PNG download lives in the lightbox caller —
 * this hook no longer owns the surface-name-derived filename.
 *
 * @param opts.threadReplyMessages — Required from ThreadPanel callers
 *   so thread-mode children can be resolved (`messageStore` does not
 *   bucket replies under the thread channel; ThreadPanel keeps them
 *   in local state). ChatPanel (channel mode) leaves this undefined and
 *   resolves from the channel cache plus the current visible message window.
 */
export interface UseSelectionShareHandlersOptions {
  channelMessages?: readonly Message[];
  threadReplyMessages?: readonly Message[];
  threadParentMessageRef?: RefObject<Message | null>;
  onUnresolvedSelection?: (unresolvedCount: number) => void;
}

export function useSelectionShareHandlers(
  opts: UseSelectionShareHandlersOptions = {},
): SelectionShareHandlers {
  const { formatMessage } = useIntl();
  const [picCapturing, setPicCapturing] = useState(false);
  const [picPreview, setPicPreview] = useState<string | null>(null);
  const [picError, setPicError] = useState<string | null>(null);
  const [copiedMd, setCopiedMd] = useState(false);
  const channelMessages = opts.channelMessages;
  const threadReplyMessages = opts.threadReplyMessages;
  const threadParentMessageRef = opts.threadParentMessageRef;
  const onUnresolvedSelection = opts.onUnresolvedSelection;

  const captureSharePreview = useCallback(async () => {
    const { messages, unresolvedCount } = gatherSelectedMessagesWithMeta({ channelMessages, threadReplyMessages, threadParentMessageRef });
    if (unresolvedCount > 0) {
      onUnresolvedSelection?.(unresolvedCount);
      return null;
    }
    if (messages.length === 0) return null;
    return await captureSelectedMessages(messages.map((m) => m.id), {
      // Match the live main-panel bg per the post-#1272 layout color
      // contract (sidebar=cream, main=white). Prior cream bg was the
      // pre-contract value; export now reads as a white surface like
      // the actual chat. stdrc 2026-05-02 #proj-message:787397b0
      // 14135081: "share message 的截图的背景色，没对上最新的".
      backgroundColor: "#FFFFFF",
      maxWidth: SHARE_PREVIEW_MAX_WIDTH,
      threadChildIds: new Set(messages.filter((m) => m.isThreadChild).map((m) => m.id)),
    });
  }, [channelMessages, onUnresolvedSelection, threadParentMessageRef, threadReplyMessages]);

  const createShareArtifactAndNavigateToX = useCallback(async (dataUrl: string) => {
    const selectionChannelId = useSelectionStore.getState().channelId;
    if (!selectionChannelId) return;
    const file = await dataUrlToPngFile(dataUrl, "raft-thread.png");
    const artifact = await createSelectedMessagesShareArtifact(file, selectionChannelId);
    setPicPreview(null);
    useSelectionStore.getState().exit();
    navigateShareArtifactToX(artifact.url, formatMessage);
  }, [formatMessage]);

  const onSavePic = useCallback(async () => {
    if (picCapturing) return;
    const { messages, unresolvedCount } = gatherSelectedMessagesWithMeta({ channelMessages, threadReplyMessages, threadParentMessageRef });
    if (unresolvedCount > 0) {
      onUnresolvedSelection?.(unresolvedCount);
      return;
    }
    if (messages.length === 0) return;
    setPicError(null);
    setPicCapturing(true);
    try {
      const dataUrl = await captureSharePreview();
      if (dataUrl) setPicPreview(dataUrl);
    } catch (err) {
      // html-to-image rejects with the raw `<img onerror>` Event when a
      // cloned <img> fails to load — `String(err)` on an Event yields
      // "[object Event]" which is useless for triage. Pull useful fields
      // out so the user (and the bug report) gets the failing src URL.
      // huxijin 2026-05-02 #proj-mobile:fd343bd8 3e1aa57a.
      console.error("captureSelectedMessages failed:", err);
      let msg: string;
      if (err instanceof SelectScreenshotTimeoutError) {
        msg = formatMessage(
          { id: "message.share.renderTimedOut" },
          { seconds: err.timeoutSeconds },
        );
      } else if (err instanceof Error) {
        msg = err.message;
      } else if (err instanceof Event) {
        const target = err.target as HTMLImageElement | null;
        const src = target?.src ?? "(unknown src)";
        const truncated = src.length > 80 ? `${src.slice(0, 77)}...` : src;
        msg = formatMessage(
          { id: "message.share.imageLoadFailed" },
          { type: err.type, detail: truncated },
        );
      } else {
        msg = String(err);
      }
      setPicError(msg);
    } finally {
      setPicCapturing(false);
    }
  }, [captureSharePreview, channelMessages, formatMessage, onUnresolvedSelection, picCapturing, threadParentMessageRef, threadReplyMessages]);

  const onShareX = useCallback(async () => {
    if (picCapturing) return;
    const selectionChannelId = useSelectionStore.getState().channelId;
    const { messages, unresolvedCount } = gatherSelectedMessagesWithMeta({ channelMessages, threadReplyMessages, threadParentMessageRef });
    if (unresolvedCount > 0) {
      onUnresolvedSelection?.(unresolvedCount);
      return;
    }
    if (messages.length === 0 || !selectionChannelId) return;
    setPicError(null);
    setPicCapturing(true);
    try {
      const dataUrl = await captureSharePreview();
      if (dataUrl) await createShareArtifactAndNavigateToX(dataUrl);
    } catch (err) {
      if (err instanceof DOMException && err.name === "AbortError") {
        return;
      }
      console.error("share to X failed:", err);
      setPicError(err instanceof Error ? err.message : formatMessage({ id: "message.share.failed" }));
    } finally {
      setPicCapturing(false);
    }
  }, [captureSharePreview, channelMessages, createShareArtifactAndNavigateToX, formatMessage, onUnresolvedSelection, picCapturing, threadParentMessageRef, threadReplyMessages]);

  const onSharePreviewToX = useCallback(async (dataUrl: string) => {
    if (picCapturing) return;
    setPicError(null);
    setPicCapturing(true);
    try {
      await createShareArtifactAndNavigateToX(dataUrl);
    } catch (err) {
      console.error("share preview to X failed:", err);
      setPicError(err instanceof Error ? err.message : formatMessage({ id: "message.share.failed" }));
      throw err;
    } finally {
      setPicCapturing(false);
    }
  }, [createShareArtifactAndNavigateToX, formatMessage, picCapturing]);

  const onCopyMd = useCallback(async () => {
    const { messages, unresolvedCount } = gatherSelectedMessagesWithMeta({ channelMessages, threadReplyMessages, threadParentMessageRef });
    if (unresolvedCount > 0) {
      onUnresolvedSelection?.(unresolvedCount);
      return;
    }
    if (messages.length === 0) return;
    const md = selectionToMarkdown(messages, formatMessage);
    try {
      await copyTextToClipboard(md, formatMessage);
      setCopiedMd(true);
      setTimeout(() => setCopiedMd(false), 1500);
    } catch (err) {
      console.error("copyTextToClipboard failed:", err);
      setPicError(err instanceof Error ? err.message : formatMessage({ id: "message.share.clipboardBlocked" }));
    }
  }, [channelMessages, formatMessage, onUnresolvedSelection, threadParentMessageRef, threadReplyMessages]);

  return {
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
  };
}
