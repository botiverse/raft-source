import { useState, useCallback, useEffect, useRef } from "react";
import type { RefObject } from "react";
import { useIntl } from "react-intl";
import { useSelectionStore } from "../../store/selectionStore";
import { useMessageStore } from "../../store/messageStore";
import type { Message } from "../../store/messageStore";
import {
  SelectScreenshotRowsMissingError,
  SelectScreenshotTransientContentError,
  SelectScreenshotTimeoutError,
  SHARE_PREVIEW_MAX_WIDTH,
} from "../../utils/selectScreenshotShared";
import type { ScreenshotCaptureProgress } from "../../utils/selectScreenshot";
import { deferredModule } from "../../boot/deferredUi";
import { importHandledLocally, isDynamicImportFailure } from "../../utils/dynamicImportRecovery";
import { ScreenshotInvalidOutputError, ScreenshotNeedsPaginationError } from "../../utils/screenshotBudget";
import type { ValidatedScreenshot } from "../../utils/screenshotBudget";
import { selectionToMarkdown, copyTextToClipboard } from "../../utils/selectMarkdown";

// The image export (html-to-image and the capture pipeline), off the first
// download (boot/deferredUi): loaded when someone makes an image, normally
// already fetched in the background. A failed load is the share's own error
// line, and making the image again asks again.
const loadSelectScreenshot = deferredModule(() => import("../../utils/selectScreenshot"));

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
 * Each result is annotated with `isThreadChild` for text exports. Image
 * exports intentionally keep parent and reply rows on the same left edge.
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

/**
 * User-facing text for the two capture failures task #1302 added: the
 * selection is over the pixel budget even at 1x, or the engine returned an
 * unusable image. Both keep the selection, so the user can retry or select
 * fewer messages. `null` for any other error.
 */
function describeCaptureFailure(
  err: unknown,
  formatMessage: ReturnType<typeof useIntl>["formatMessage"],
): string | null {
  if (isDynamicImportFailure(err)) return formatMessage({ id: "common.deferred.failedDescription" });
  if (err instanceof ScreenshotNeedsPaginationError) return formatMessage({ id: "message.share.selectionTooLong" });
  if (err instanceof ScreenshotInvalidOutputError) return formatMessage({ id: "message.share.renderEmpty" });
  if (err instanceof SelectScreenshotTransientContentError) return formatMessage({ id: "message.share.contentNotReady" });
  if (err instanceof SelectScreenshotRowsMissingError) {
    return formatMessage(
      { id: "message.share.selectionNotRendered" },
      { missing: err.missingMessageIds.length, total: err.total },
    );
  }
  return null;
}

/**
 * Rejects with an AbortError once the capture job was cancelled.
 */
function throwIfShareAborted(signal: AbortSignal): void {
  if (signal.aborted) throw new DOMException("Share cancelled", "AbortError");
}

export interface SelectionShareHandlers {
  picCapturing: boolean;
  picCaptureProgress: ScreenshotCaptureProgress | null;
  cancelPicCapture: () => void;
  picPreview: ValidatedScreenshot[] | null;
  setPicPreview: (v: ValidatedScreenshot[] | null) => void;
  picError: string | null;
  setPicError: (v: string | null) => void;
  copiedMd: boolean;
  onSavePic: () => Promise<void>;
  onCopyMd: () => Promise<void>;
}

/**
 * Shared share-action handlers used by both ChatPanel (channel mode) and
 * ThreadPanel (thread mode). Centralizes the rasterize / clipboard
 * plumbing so the two surfaces don't drift.
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
  /** Panel whose rows the image is captured from (see CaptureOptions.scope). */
  captureScopeRef?: RefObject<HTMLElement | null>;
  onUnresolvedSelection?: (unresolvedCount: number) => void;
}

export function useSelectionShareHandlers(
  opts: UseSelectionShareHandlersOptions = {},
): SelectionShareHandlers {
  const { formatMessage } = useIntl();
  const [picCapturing, setPicCapturing] = useState(false);
  const [picCaptureProgress, setPicCaptureProgress] = useState<ScreenshotCaptureProgress | null>(null);
  const [picPreview, setPicPreview] = useState<ValidatedScreenshot[] | null>(null);
  const [picError, setPicError] = useState<string | null>(null);
  const [copiedMd, setCopiedMd] = useState(false);
  const channelMessages = opts.channelMessages;
  const threadReplyMessages = opts.threadReplyMessages;
  const threadParentMessageRef = opts.threadParentMessageRef;
  const onUnresolvedSelection = opts.onUnresolvedSelection;
  const captureScopeRef = opts.captureScopeRef;
  const captureJobRef = useRef<{ id: number; controller: AbortController } | null>(null);

  // Unmounting the panel mid-capture is a cancel: no capture continues after
  // the user has left.
  useEffect(() => () => {
    captureJobRef.current?.controller.abort();
    captureJobRef.current = null;
  }, []);

  const cancelPicCapture = useCallback(() => {
    captureJobRef.current?.controller.abort();
    captureJobRef.current = null;
    setPicCapturing(false);
    setPicCaptureProgress(null);
  }, []);

  const captureSharePreview = useCallback(async (job: { id: number; controller: AbortController }) => {
    const { messages, unresolvedCount } = gatherSelectedMessagesWithMeta({ channelMessages, threadReplyMessages, threadParentMessageRef });
    if (unresolvedCount > 0) {
      onUnresolvedSelection?.(unresolvedCount);
      return null;
    }
    if (messages.length === 0) return null;
    const { captureSelectedMessageImages } = await importHandledLocally(loadSelectScreenshot);
    // Cancelled while the export's code was loading: nothing to capture.
    throwIfShareAborted(job.controller.signal);
    return await captureSelectedMessageImages(messages.map((m) => m.id), {
      maxWidth: SHARE_PREVIEW_MAX_WIDTH,
      scope: captureScopeRef?.current,
      signal: job.controller.signal,
      onProgress: (progress) => {
        if (captureJobRef.current?.id === job.id) setPicCaptureProgress(progress);
      },
    });
  }, [captureScopeRef, channelMessages, onUnresolvedSelection, threadParentMessageRef, threadReplyMessages]);

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
    const job = { id: Date.now(), controller: new AbortController() };
    captureJobRef.current?.controller.abort();
    captureJobRef.current = job;
    try {
      const images = await captureSharePreview(job);
      if (images && captureJobRef.current?.id === job.id) setPicPreview(images);
    } catch (err) {
      if (err instanceof DOMException && err.name === "AbortError") return;
      // html-to-image rejects with the raw `<img onerror>` Event when a
      // cloned <img> fails to load — `String(err)` on an Event yields
      // "[object Event]" which is useless for triage. Pull useful fields
      // out so the user (and the bug report) gets the failing src URL.
      // huxijin 2026-05-02 #proj-mobile:fd343bd8 3e1aa57a.
      console.error("captureSelectedMessages failed:", err);
      let msg: string;
      const captureMessage = describeCaptureFailure(err, formatMessage);
      if (captureMessage) {
        msg = captureMessage;
      } else if (err instanceof SelectScreenshotTimeoutError) {
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
      if (captureJobRef.current?.id === job.id) {
        captureJobRef.current = null;
        setPicCapturing(false);
        setPicCaptureProgress(null);
      }
    }
  }, [captureSharePreview, channelMessages, formatMessage, onUnresolvedSelection, picCapturing, threadParentMessageRef, threadReplyMessages]);

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
    picCaptureProgress,
    cancelPicCapture,
    picPreview,
    setPicPreview,
    picError,
    setPicError,
    copiedMd,
    onSavePic,
    onCopyMd,
  };
}
