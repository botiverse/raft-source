import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState } from "react";
import type { PointerEvent as ReactPointerEvent, ReactNode } from "react";
import { Download, MessageSquareMore, Music, Plus, X } from "lucide-react";
import { useIntl } from "react-intl";
import { Button } from "raft-ui";
import Banner from "../ui/Banner";
import Spinner from "../ui/Spinner";
import Lightbox from "../ui/Lightbox";
import SandboxedPreviewFrame from "../ui/SandboxedPreviewFrame";
import MarkdownContent from "../markdown/MarkdownContent";
import { createMarkdownOutlineHeadingComponents, extractMarkdownOutline, MarkdownOutlineNav } from "../markdown/MarkdownOutline";
import AttachmentTooltip from "./attachmentTooltip";
import { AttachmentCommentsPanel } from "./AttachmentCommentsPanel";
import { captureNodeAnchor, captureSelectionAnchor, consumePendingVideoSeek } from "./attachmentCommentAnchors";
import {
  ATTACHMENT_PREVIEW_EXTERNAL_LINK_COOLDOWN_MS,
  openAttachmentPreviewExternalLink,
} from "./attachmentPreviewExternalLink";
import type { AttachmentPreviewExternalLink } from "./attachmentPreviewExternalLink";
import { createVideoSeekCoalescer } from "./videoTimestampSeekCoalesce";
import { registerHtmlRegionJumpHandler, registerVideoTimestampJumpHandler } from "./attachmentCommentAnchors";
import type { StoredAnchor } from "./attachmentCommentAnchors";
import { useAttachmentPreviewBridge } from "./attachmentPreviewBridge";
import { validateAttachmentPreviewExternalLink } from "./attachmentPreviewExternalLink";
import type { CommentAnchor } from "./attachmentCommentAnchors";
import type { DocumentAttachmentPreview } from "./attachmentPreview";
import type { Message } from "../../store/messageStore";

/**
 * Attachment preview surfaces, extracted from MessageItem.
 *
 * These lived inside MessageItem, which is why only a message could open a
 * document preview: the forward composer could not reach them and silently
 * downloaded instead. Housing them here lets every surface open the SAME
 * preview rather than growing a second implementation.
 */

export const DOCUMENT_PREVIEW_LABEL_ID = {
  csv: "message.messageItem.docPreviewCsv",
  xlsx: "message.messageItem.docPreviewXlsx",
  markdown: "message.messageItem.docPreviewMarkdown",
  text: "message.messageItem.docPreviewText",
  pdf: "message.messageItem.docPreviewPdf",
} as const;

export type PreviewCommentsContext = {
  attachmentId: string;
  filename: string;
  commentCount: number;
  parentMessage: Pick<Message, "id" | "channelId" | "senderId" | "senderType">;
};

export const PreviewCommentModeContext = createContext<{
  commentMode: boolean;
  pendingAnchor: CommentAnchor | null;
  pushAnchor: (anchor: CommentAnchor) => void;
  getPendingAnchor: () => CommentAnchor | null;
  openPanel: () => void;
} | null>(null);

export function AttachmentPreviewShell({
  filename,
  onClose,
  onDownload,
  layout = "fill",
  comments,
  children,
}: {
  filename: string;
  onClose: () => void;
  onDownload: () => void;
  // Markdown previews need the portal root itself to scroll so Chrome's
  // native find-in-page can bring off-screen matches into view.
  layout?: "fill" | "browser-find";
  /** When set, the shell offers the attachment-comments panel (MVP §5). */
  comments?: PreviewCommentsContext;
  children: ReactNode;
}) {
  const { formatMessage } = useIntl();
  const browserFindLayout = layout === "browser-find";
  const [commentsOpen, setCommentsOpen] = useState(false);
  // Sticky after first open: the panel keeps its mounted content (and fetched
  // comments) while the collapse animation runs and across reopen.
  const [panelMounted, setPanelMounted] = useState(false);
  const [pendingAnchor, setPendingAnchor] = useState<CommentAnchor | null>(null);
  const pendingAnchorRef = useRef<CommentAnchor | null>(null);
  // Stryker disable all: behavior is pinned by attachmentCommentsPanelAnchor.behavior; remaining dependency-array mutants are equivalent for this ref + stable setter callback.
  const commitPendingAnchor = useCallback((anchor: CommentAnchor | null) => {
    pendingAnchorRef.current = anchor;
    setPendingAnchor(anchor);
  }, []);
  // Stryker restore all
  // Stryker disable next-line ArrayDeclaration: closes only over pendingAnchorRef; adding a static dependency is equivalent.
  const getPendingAnchor = useCallback(() => pendingAnchorRef.current, []);
  // Preview/comment mode (task #16 slice 1, cindyz: explicit mode beats a
  // hidden toggle for discoverability). Comment mode keeps the panel open and
  // LIVE-captures selections in natively-rendered previews; preview mode
  // leaves the artifact fully interactive. The HTML-iframe overlay arrives
  // with slice 2 (bridge) — in slice 1 comment mode on HTML only opens the
  // panel (unanchored comments, same as today).
  const [mode, setMode] = useState<"preview" | "comment">("preview");
  const commentMode = mode === "comment" && Boolean(comments);
  // Selection made in natively-rendered previews is captured when a comment
  // session starts as a STRUCTURAL anchor (task #15 — heading/line/row,
  // carries its own quote, clickable jump-back). The v0 plain-quote draft
  // prefill is retired (task #20): anchors carry the quote, and the inherited
  // composer owns its draft. The HTML iframe's selection is unreachable
  // across the sandbox by design — the comment-mode bridge covers it.
  const captureSelectionContext = () => {
    commitPendingAnchor(captureSelectionAnchor());
  };
  // Closing the panel ends the comment session: transient location state
  // (pending anchor / quote) must die with it, or a stale "L5" chip from the
  // last session silently re-targets the next comment (Dozy review of
  // 866d82d3). The typed draft itself is preserved — only WHERE dies.
  // Mobile bottom sheet (task #26, simplified to 2-state per cindyz 6/11):
  // collapsed shows only the panel's control row (the row IS the sheet header,
  // chevron included); half (45dvh) is the working state with the artifact
  // still visible. There is no full state and no separate handle bar. Desktop
  // (>= sm) ignores this entirely — the aside/right-drawer behavior is
  // unchanged.
  const [sheetState, setSheetState] = useState<"collapsed" | "half">("collapsed");
  const closeComments = () => {
    setMode("preview");
    commitPendingAnchor(null);
    setCommentsOpen(false);
    setSheetState("collapsed");
  };
  const openComments = () => {
    captureSelectionContext();
    setPanelMounted(true);
    setCommentsOpen(true);
    setSheetState((s) => (s === "collapsed" ? "half" : s));
  };
  const enterCommentMode = () => {
    if (!commentsOpen) openComments();
    // Comment mode auto-opens the sheet to half so the composer is reachable
    // while the artifact stays visible.
    setSheetState((s) => (s === "collapsed" ? "half" : s));
    setMode("comment");
  };
  // ONE AXIS (cindyz 6/11 16:28, supersedes the 98375fd7 contract): the
  // sidebar follows the Preview/Comment segment — Preview closes it entirely
  // (the toolbar badge button is gone; the segment is the only desktop entry;
  // the mobile sheet keeps its own chevron for read-only opens).
  const exitCommentMode = () => closeComments();
  const captureLiveSelection = (e: React.MouseEvent) => {
    if (!commentMode) return;
    const anchor = captureSelectionAnchor();
    if (anchor) {
      commitPendingAnchor(anchor);
      return;
    }
    // Tap-to-structure (task #26, coarse pointers only): with no text
    // selection, the tapped line/row/section itself becomes the anchor.
    // Desktop keeps selection as the only capture gesture — a mouse click
    // is also how selections START, so click-anchoring there would thrash.
    if (
      typeof window !== "undefined"
      && window.matchMedia("(pointer: coarse)").matches
      && e.target instanceof Node
    ) {
      const tapped = captureNodeAnchor(e.target);
      if (tapped) commitPendingAnchor(tapped);
    }
  };
  // Touch reliability (task #26): after native long-press selection, lifting
  // the finger or dragging the selection handles does NOT reliably fire
  // mouseup on the scope container (iOS/Android). While comment mode is
  // active, a debounced selectionchange listener captures the final range —
  // captureSelectionAnchor() already returns null for selections outside the
  // annotated preview structures, so the global listener stays scoped.
  useEffect(() => {
    if (!commentMode) return;
    let timer: number | null = null;
    const onSelectionChange = () => {
      if (timer !== null) window.clearTimeout(timer);
      // Debounced: selectionchange streams continuously while handles drag;
      // capture once the selection settles.
      timer = window.setTimeout(() => {
        const anchor = captureSelectionAnchor();
        if (anchor) commitPendingAnchor(anchor);
      }, 300);
    };
    document.addEventListener("selectionchange", onSelectionChange);
    return () => {
      document.removeEventListener("selectionchange", onSelectionChange);
      if (timer !== null) window.clearTimeout(timer);
    };
  }, [commentMode, commitPendingAnchor]);
  // Stryker disable all: behavior is pinned by attachmentCommentsPanelAnchor.behavior; remaining dependency-array mutant is equivalent because commitPendingAnchor is stable by construction.
  const pushAnchor = useCallback((anchor: CommentAnchor) => {
    commitPendingAnchor(anchor);
    setPanelMounted(true);
    setCommentsOpen(true);
  }, [commitPendingAnchor]);
  // Stryker restore all
  const openPanel = useCallback(() => {
    setPanelMounted(true);
    setCommentsOpen(true);
  }, []);
  const previewCommentCtx = useMemo(
    // Stryker disable next-line ArrowFunction,ObjectLiteral: video timestamp pending-anchor propagation is covered by document attachment Playwright e2e.
    () => ({ commentMode, pendingAnchor, pushAnchor, getPendingAnchor, openPanel }),
    // Stryker disable next-line ArrayDeclaration: dependency freshness is exercised by the paused video timestamp Playwright flow.
    [commentMode, pendingAnchor, pushAnchor, getPendingAnchor, openPanel],
  );
  useEffect(() => {
    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key !== "Escape") return;
      event.preventDefault();
      event.stopPropagation();
      onClose();
    };
    // keydown-global-exempt: preview escape inside <Lightbox> wrapper which moves focus into the overlay on open
    document.addEventListener("keydown", handleKeyDown);
    return () => document.removeEventListener("keydown", handleKeyDown);
  }, [onClose]);

  return (
    <Lightbox
      onClose={onClose}
      data-testid={browserFindLayout ? "attachment-preview-browser-find-scroll" : undefined}
      backdropClass={browserFindLayout ? "bg-brutal-cream" : undefined}
      positionClass={browserFindLayout ? "fixed left-0 right-0 top-0 h-[100dvh] w-screen max-w-[100dvw] overflow-x-clip overflow-y-auto" : undefined}
      lockBodyScroll={!browserFindLayout}
      scrollIntoViewOnMount={browserFindLayout}
      className={
        browserFindLayout
          ? // overflow-x-CLIP, not hidden: a hidden ancestor becomes a (non-
            // scrolling) scroll container and silently defeats the header's
            // sticky against the window scroller (cindyz: "header should be
            // sticky", task #38). clip clips without capturing sticky.
            "w-full max-w-[100dvw] overflow-x-clip bg-brutal-cream"
          : "flex flex-col items-center justify-center"
      }
    >
      <PreviewCommentModeContext.Provider value={previewCommentCtx}>
      <div
        className={
          browserFindLayout
            ? // fixed, not sticky: WebKit (iPadOS Safari) ignores sticky
              // when <html> has overflow-y set by the browser-find layout.
              "safe-top safe-left pointer-events-auto fixed left-0 right-0 top-0 z-10 max-w-[100dvw] overflow-x-clip border-b-2 border-black bg-white"
            : "safe-top safe-left pointer-events-auto absolute left-0 right-0 top-0 z-10 border-b-2 border-black bg-white"
        }
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex h-14 items-center gap-3 px-4">
          <div className="flex min-w-0 flex-1 items-center" title={filename}>
            <span className="min-w-0 flex-1 truncate text-sm font-display text-black">
              {filename}
            </span>
          </div>
          <div className="flex shrink-0 items-center gap-1.5">
            {comments ? (
              <Button
                type="button"
                size="icon-sm"
                variant={commentsOpen ? "primary" : "default"}
                data-message-affordance="attachment-preview-mode"
                onClick={mode === "comment" ? exitCommentMode : enterCommentMode}
                aria-label={formatMessage({ id: "message.messageItem.previewComment" })}
                aria-pressed={commentsOpen}
                data-comments-open={commentsOpen ? "true" : "false"}
              >
                <MessageSquareMore size={14} aria-hidden="true" />
              </Button>
            ) : null}
            <AttachmentTooltip content={formatMessage({ id: "common.lightbox.download" })} contentProps={{ side: "bottom" }}>
              <Button type="button" size="icon-sm" variant="default" onClick={onDownload} aria-label={formatMessage({ id: "common.lightbox.download" })}>
                <Download size={14} />
              </Button>
            </AttachmentTooltip>
            <AttachmentTooltip content={formatMessage({ id: "common.lightbox.close" })} contentProps={{ side: "bottom" }}>
              <Button type="button" size="icon-sm" variant="default" onClick={onClose} aria-label={formatMessage({ id: "common.lightbox.close" })}>
                <X size={14} />
              </Button>
            </AttachmentTooltip>
          </div>
        </div>
      </div>
      {browserFindLayout && <div className="safe-top h-14 w-full" aria-hidden="true" />}
      <div
        // data-anchor-scope: anchor jumps resolve ids/line markers inside the
        // ACTIVE preview only, never a background DOM (Dozy review note).
        data-anchor-scope=""
        // Comment mode live capture: every finished selection in a native
        // renderer becomes the pending anchor (mouseup fires after the
        // selection is final). No-op in preview mode.
        onMouseUp={captureLiveSelection}
        className={
          browserFindLayout
            ? `pointer-events-auto w-full max-w-[100dvw] overflow-x-clip bg-brutal-cream transition-[padding-right] duration-300 ease-in-out ${
                comments && commentsOpen ? "sm:pr-80" : ""
              }`
            : "absolute bottom-0 left-0 right-0 overflow-hidden bg-white"
        }
        style={
          browserFindLayout
            ? undefined
            : { top: "calc(56px + env(safe-area-inset-top, 0px))" }
        }
        onClick={(e) => e.stopPropagation()}
      >
        {!browserFindLayout && comments ? (
          /* Stable tree: children keep their tree position whether the panel
             is open or closed, so toggling comments never remounts the
             preview (a sandboxed HTML/PDF iframe would otherwise reload and
             lose its state). The aside animates width so the content is
             pushed left continuously — collapse/expand, not hide/show
             (cindyz 6/10). Panel content rides at fixed width inside the
             clipped aside so it never squishes mid-animation. */
          <div className="flex h-full w-full">
            <div className="h-full min-w-0 flex-1">{children}</div>
            <aside
              // inert while collapsed: the panel stays mounted for the width
              // animation, but its controls (filter/resolve/composer) must
              // leave the tab order and the accessibility tree (Dozy review).
              inert={!commentsOpen}
              className={`hidden h-full shrink-0 overflow-hidden border-black transition-[width] duration-300 ease-in-out sm:block ${
                commentsOpen ? "w-80 border-l-2" : "w-0 border-l-0"
              }`}
            >
              <div className="h-full w-80">
                {panelMounted ? (
                  <AttachmentCommentsPanel
                    attachmentId={comments.attachmentId}
                    filename={comments.filename}
                    parentMessage={comments.parentMessage}
                    pendingAnchor={pendingAnchor}
                    getPendingAnchor={getPendingAnchor}
                    // Stryker disable next-line ArrowFunction: anchor-clear sync is covered by attachment comment Playwright flows.
                    onAnchorCleared={() => commitPendingAnchor(null)}
                  />
                ) : null}
              </div>
            </aside>
          </div>
        ) : (
          children
        )}
      </div>
      {/* browser-find (markdown) scrolls the portal root, so the panel rides
          as a fixed drawer instead of splitting the scroll container. On
          narrow viewports both layouts use the same full-width drawer. */}
      {comments && browserFindLayout ? (
        /* Desktop markdown right-drawer (the browser-find layout has no flex
           aside): slides in/out via translate so the push-left padding and
           drawer move as one gesture. Narrow viewports use the bottom sheet
           below instead. */
        <div
          className={`pointer-events-auto fixed bottom-0 right-0 z-20 hidden w-full max-w-80 border-l-2 border-t-2 border-black bg-white transition-transform duration-300 ease-in-out sm:block ${
            commentsOpen ? "translate-x-0" : "translate-x-full"
          }`}
          style={{ top: "calc(56px + env(safe-area-inset-top, 0px))" }}
          onClick={(e) => e.stopPropagation()}
          // inert (not just aria-hidden) while offscreen: removes the
          // composer/buttons from the tab order too (Dozy review).
          inert={!commentsOpen}
        >
          {panelMounted ? (
            <AttachmentCommentsPanel
              attachmentId={comments.attachmentId}
              filename={comments.filename}
              parentMessage={comments.parentMessage}
              pendingAnchor={pendingAnchor}
              getPendingAnchor={getPendingAnchor}
              // Stryker disable next-line ArrowFunction: anchor-clear sync is covered by attachment comment Playwright flows.
              onAnchorCleared={() => commitPendingAnchor(null)}
            />
          ) : null}
        </div>
      ) : null}
      {comments ? (
        /* Mobile 2-state bottom sheet (task #26, cindyz simplification):
           collapsed (h-10) keeps the panel's control row visible as the sheet
           header — that row is the mobile entry; half (45dvh) is the working
           state with the artifact still visible above. No full state, no
           separate handle bar. Height transitions keep it one continuous
           surface. */
        <div
          data-message-affordance="attachment-comments-sheet"
          className={`pointer-events-auto fixed inset-x-0 bottom-0 z-20 flex flex-col border-t-2 border-black bg-white transition-[height] duration-300 ease-in-out sm:hidden ${
            sheetState === "half" ? "h-[45dvh]" : "h-10"
          }`}
          onClick={(e) => e.stopPropagation()}
        >
          {/* No separate handle bar (cindyz 6/11): the panel's own control
              row IS the sheet header — its chevron (sheetControls) expands/
              collapses, and the collapsed state hides the body via
              display:none (out of tab order — no inert games needed). */}
          <AttachmentCommentsPanel
            attachmentId={comments.attachmentId}
            filename={comments.filename}
            parentMessage={comments.parentMessage}
            pendingAnchor={pendingAnchor}
            getPendingAnchor={getPendingAnchor}
            // Stryker disable next-line ArrowFunction: anchor-clear sync is covered by attachment comment Playwright flows.
            onAnchorCleared={() => commitPendingAnchor(null)}
            // A chip jump on mobile means "show me the artifact": run the
            // full session boundary (Dozy review of a3a79538).
            onAnchorJump={closeComments}
            collapsedBody={sheetState === "collapsed"}
            sheetControls={{
              expanded: sheetState === "half",
              onToggle: () => {
                if (sheetState === "collapsed") {
                  setPanelMounted(true);
                  setCommentsOpen(true);
                  setSheetState("half");
                } else {
                  closeComments();
                }
              },
            }}
          />
        </div>
      ) : null}
      </PreviewCommentModeContext.Provider>
    </Lightbox>
  );
}

export function CsvPreviewPane({ preview, truncated }: { preview: Extract<DocumentAttachmentPreview, { kind: "csv" }>; truncated: boolean }) {
  const { formatMessage } = useIntl();
  return (
    // No nested vertical scroller (browser-find layout) — see TextPreviewPane.
    <div className="w-full bg-brutal-cream/45 p-4 font-mono text-[11px] text-black">
      <div className="mb-2 flex items-center justify-between gap-3 text-xs font-bold text-black/55">
        <span>{formatMessage({ id: "message.messageItem.csvPreview" })}</span>
        <span>{truncated ? formatMessage({ id: "message.messageItem.csvRowsFirst" }, { count: preview.rows.length }) : formatMessage({ id: "message.messageItem.csvRows" }, { count: preview.rowCount })}{formatMessage({ id: "message.messageItem.csvColumns" }, { count: preview.columnCount })}</span>
      </div>
      {/* Horizontal-only scroller: wide tables must pan sideways, but the
          vertical axis flows into the document scroll so ⌘F reaches every
          row. Known trade-off: the sticky thead pins to this wrapper (a
          scroll container), not the viewport — wide-table panning beats a
          pinned header here. */}
      <div className="overflow-x-auto border-2 border-black bg-white shadow-brutal-sm">
        <table className="min-w-full border-collapse bg-white">
          <thead className="sticky top-0 z-10 bg-brutal-cream">
            <tr>
              {preview.headers.map((header, index) => (
                <th key={`${header}-${index}`} className="max-w-[220px] border border-black px-2 py-1 text-left font-bold">
                  <span className="block truncate" title={header}>{header || formatMessage({ id: "message.messageItem.columnFallback" }, { index: index + 1 })}</span>
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {preview.rows.map((row, rowIndex) => (
              <tr key={rowIndex} data-anchor-row={rowIndex + 1} className="odd:bg-black/[0.03]">
                {preview.headers.map((_, columnIndex) => {
                  const value = row[columnIndex] ?? "";
                  return (
                    <td key={columnIndex} className="max-w-[220px] border border-black/40 px-2 py-1 align-top">
                      <span className="block truncate" title={value}>{value}</span>
                    </td>
                  );
                })}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <div className="mt-2 text-xs font-bold text-black/50">
        {truncated
          ? formatMessage({ id: "message.messageItem.csvTruncatedPerf" }, { count: preview.rows.length })
          : formatMessage({ id: "message.messageItem.csvShowingOf" }, { shown: preview.rows.length, total: preview.rowCount })}
      </div>
    </div>
  );
}

export function XlsxPreviewPane({ preview, truncated }: { preview: Extract<DocumentAttachmentPreview, { kind: "xlsx" }>; truncated: boolean }) {
  const { formatMessage } = useIntl();
  const [activeSheet, setActiveSheet] = useState(0);
  const selected = preview.sheets[Math.min(activeSheet, Math.max(0, preview.sheets.length - 1))];
  if (!selected) {
    return <div className="w-full bg-brutal-cream/45 p-4 text-xs font-bold text-black/60">{formatMessage({ id: "message.messageItem.xlsxEmpty" })}</div>;
  }
  const sheetTruncated = truncated || selected.truncated;
  const isEmpty = selected.headers.length === 0 && selected.rows.length === 0;
  return (
    <div className="w-full bg-brutal-cream/45 p-4 font-mono text-[11px] text-black">
      <div className="mb-3 flex flex-wrap items-center justify-between gap-3 text-xs font-bold text-black/55">
        <span>{formatMessage({ id: "message.messageItem.xlsxPreview" })}</span>
        <span>{formatMessage({ id: "message.messageItem.xlsxSheets" }, { count: preview.sheetCount })}</span>
      </div>
      {preview.sheets.length > 1 ? (
        <div className="mb-3 flex max-w-full gap-1 overflow-x-auto pb-1" role="tablist" aria-label={formatMessage({ id: "message.messageItem.xlsxSheetTabs" })}>
          {preview.sheets.map((sheet, index) => (
            <button
              key={`${sheet.name}-${index}`}
              type="button"
              role="tab"
              aria-selected={index === activeSheet}
              onClick={() => setActiveSheet(index)}
              className={`shrink-0 border-2 border-black px-2 py-1 text-xs font-bold shadow-brutal-sm ${index === activeSheet ? "bg-soft-signal" : "bg-white"}`}
            >
              {sheet.name || formatMessage({ id: "message.messageItem.xlsxUnnamedSheet" }, { index: index + 1 })}
            </button>
          ))}
        </div>
      ) : null}
      {isEmpty ? (
        <div className="border-2 border-black bg-white p-4 font-sans text-sm font-bold shadow-brutal-sm" data-testid="xlsx-preview-empty">
          {formatMessage({ id: "message.messageItem.xlsxEmpty" })}
        </div>
      ) : (
        <div className="overflow-x-auto border-2 border-black bg-white shadow-brutal-sm">
          <table className="min-w-full border-collapse bg-white">
            <thead className="sticky top-0 z-10 bg-brutal-cream"><tr>{selected.headers.map((header, index) => (
              <th key={`${header}-${index}`} className="max-w-[220px] border border-black px-2 py-1 text-left font-bold"><span className="block truncate" title={header}>{header || formatMessage({ id: "message.messageItem.columnFallback" }, { index: index + 1 })}</span></th>
            ))}</tr></thead>
            <tbody>{selected.rows.map((row, rowIndex) => (
              <tr key={rowIndex} data-anchor-row={rowIndex + 1} className="odd:bg-black/[0.03]">
                {selected.headers.map((_, columnIndex) => { const value = row[columnIndex] ?? ""; return <td key={columnIndex} className="max-w-[220px] border border-black/40 px-2 py-1 align-top"><span className="block truncate" title={value}>{value}</span></td>; })}
              </tr>
            ))}</tbody>
          </table>
        </div>
      )}
      <div className="mt-2 text-xs font-bold text-black/50">
        {sheetTruncated
          ? formatMessage({ id: "message.messageItem.xlsxTruncated" }, { count: selected.rows.length })
          : formatMessage({ id: "message.messageItem.xlsxShowingOf" }, { shown: selected.rows.length, total: selected.rowCount })}
      </div>
    </div>
  );
}

export function MarkdownPreviewPane({ markdown, truncated }: { markdown: string; truncated: boolean }) {
  // Visual styling delegated to MarkdownContent so attachment preview shares
  // chat-body markdown primitives. The preview wrapper owns only the Slock
  // landing/blog-style reading shell: card, measure, and page padding.
  // stdrc 2026-05-08 #proj-uiux:6110c1ce (task #137).
  //
  // The server caps the markdown preview to a byte prefix
  // (markdownPreviewProvider.streamByteCap, 128KB) and returns
  // `truncated: true` when the file is larger. Before #proj-uiux task #269
  // this pane silently dropped that flag (CsvPreviewPane / TextPreviewPane
  // already surface it): a user Cmd-F-searching for text that lives past the
  // cut got no match and no explanation — "Cmd-F won't bring me to the
  // content" (cindyz). Surface the boundary explicitly and point at Download
  // (in the shell header) for the full file. Invariant: a truncated preview
  // must visibly declare its boundary so absent matches read as "not in this
  // preview", not "not in this file".
  const { formatMessage } = useIntl();
  const outline = useMemo(() => extractMarkdownOutline(markdown), [markdown]);
  const headingComponents = useMemo(
    () => createMarkdownOutlineHeadingComponents(outline),
    [outline],
  );

  return (
    <div className="min-h-[calc(100dvh-56px)] w-full max-w-[100dvw] overflow-x-clip bg-brutal-cream px-4 py-8 md:px-8 md:py-10">
      <div className="mx-auto grid w-full max-w-3xl gap-6 xl:max-w-6xl xl:grid-cols-[16rem_minmax(0,48rem)] xl:items-start">
        <div className="hidden xl:sticky xl:top-20 xl:block xl:max-h-[calc(100dvh-7rem)] xl:self-start xl:overflow-auto">
          <MarkdownOutlineNav outline={outline} />
        </div>
        <div className="min-w-0">
          {truncated ? (
            <Banner
              intent="warning"
              density="lg"
              className="mb-4"
              data-testid="markdown-preview-truncated"
            >
              {formatMessage(
                { id: "message.messageItem.markdownTruncated" },
                { b: (chunks) => <span key="b" className="font-bold">{chunks}</span> },
              )}
            </Banner>
          ) : null}
          <div
            data-anchor-md-root=""
            className="card-brutal max-w-full overflow-x-clip bg-white px-6 py-8 font-display text-base text-black md:px-10 md:py-12"
          >
            <MarkdownContent
              source={markdown}
              density="document"
              enableMermaid
              components={headingComponents}
            />
          </div>
        </div>
      </div>
    </div>
  );
}

export function TextPreviewPane({ text, truncated }: { text: string; truncated: boolean }) {
  const { formatMessage } = useIntl();
  return (
    // No nested vertical scroller (browser-find layout): the pane flows into
    // the document so native find can scroll the window to matches.
    <div className="w-full bg-brutal-cream/45 p-4">
      <div className="mb-2 flex items-center justify-between gap-3 text-xs font-bold text-black/55">
        <span>{formatMessage({ id: "message.messageItem.plainTextPreview" })}</span>
        {truncated ? <span>{formatMessage({ id: "message.messageItem.previewTruncated" })}</span> : null}
      </div>
      {/* Per-line elements (not one text node) so comment anchors can target
          and flash-highlight L<n> ranges (attachmentCommentAnchors). The
          preview is byte-capped server-side, so line count stays bounded. */}
      <pre className="min-h-full whitespace-pre-wrap break-words border-2 border-black bg-white p-4 font-mono text-xs leading-5 text-black shadow-brutal-sm">
        {text.split(/\r?\n/).map((line, index) => (
          <div key={index} data-anchor-line={index + 1}>
            {line.length > 0 ? line : " "}
          </div>
        ))}
      </pre>
    </div>
  );
}

export function DocumentAttachmentPreviewModal({
  filename,
  preview,
  truncated,
  url,
  onClose,
  onDownload,
  comments,
}: {
  filename: string;
  preview: DocumentAttachmentPreview;
  truncated: boolean;
  url: string | null;
  onClose: () => void;
  onDownload: () => void;
  comments?: PreviewCommentsContext;
}) {
  const { formatMessage } = useIntl();
  return (
    <AttachmentPreviewShell
      filename={filename}
      onClose={onClose}
      onDownload={onDownload}
      // browser-find layout for every format rendered directly into the DOM
      // (markdown #1849; text/csv extended per cindyz, task #38 thread):
      // native ⌘F cannot scroll nested overflow containers to matches, so
      // these contribute height to the document and the window scrolls. PDF
      // stays fill — its iframe is its own findable document.
      layout={preview.kind === "markdown" || preview.kind === "text" || preview.kind === "csv" || preview.kind === "xlsx" ? "browser-find" : "fill"}
      // PDF comments are descoped (cindyz 6/11): the native viewer sits in a
      // sandbox we can't bridge, so anchors are impossible and attachment-
      // level-only comments aren't worth the surface. Re-enable when a
      // controlled renderer (pdf.js) makes page+rect anchors honest.
      comments={preview.kind === "pdf" ? undefined : comments}
    >
      {preview.kind === "csv" ? <CsvPreviewPane preview={preview} truncated={truncated} /> : null}
      {preview.kind === "xlsx" ? <XlsxPreviewPane preview={preview} truncated={truncated} /> : null}
      {preview.kind === "markdown" ? <MarkdownPreviewPane markdown={preview.markdown} truncated={truncated} /> : null}
      {preview.kind === "text" ? <TextPreviewPane text={preview.text} truncated={truncated} /> : null}
      {preview.kind === "pdf" ? (
        // Threat model: PDFs are uploaded by any human or agent, so the bytes
        // are attacker-controlled. Native PDF viewers (Chrome plugin, Firefox
        // pdf.js) run scripts inside the iframe — `allow-scripts` keeps the
        // viewer working while the absent `allow-same-origin` keeps the frame
        // in an opaque origin, so a hostile PDF cannot reach Slock cookies,
        // storage, or the parent DOM. Shares the same primitive + isolation
        // config as the HTML preview above (#proj-frontend:8b1098b4
        // react-doctor `iframe-missing-sandbox`, Ark security review).
        <SandboxedPreviewFrame
          title={formatMessage({ id: "message.messageItem.pdfPreviewTitle" }, { filename })}
          src={url ?? ""}
          sandbox="allow-scripts"
          referrerPolicy="no-referrer"
          className="h-full w-full border-0 bg-white"
        />
      ) : null}
    </AttachmentPreviewShell>
  );
}


export function HtmlAttachmentPreviewModal({
  filename,
  url,
  onClose,
  onDownload,
  comments,
}: {
  filename: string;
  url: string;
  onClose: () => void;
  onDownload: () => void;
  comments?: PreviewCommentsContext;
}) {
  return (
    <AttachmentPreviewShell filename={filename} onClose={onClose} onDownload={onDownload} comments={comments}>
      <HtmlPreviewBody url={url} filename={filename} commentsEnabled={Boolean(comments)} />
    </AttachmentPreviewShell>
  );
}

export function VideoAttachmentPreviewModal({
  filename,
  url,
  onClose,
  onDownload,
  comments,
}: {
  filename: string;
  url: string;
  onClose: () => void;
  onDownload: () => void;
  comments?: PreviewCommentsContext;
}) {
  return (
    <AttachmentPreviewShell filename={filename} onClose={onClose} onDownload={onDownload} comments={comments}>
      <VideoPreviewBody url={url} filename={filename} commentsEnabled={Boolean(comments)} attachmentId={comments?.attachmentId ?? null} />
    </AttachmentPreviewShell>
  );
}

export function AudioAttachmentPreviewModal({
  filename,
  url,
  onClose,
  onDownload,
}: {
  filename: string;
  url: string;
  onClose: () => void;
  onDownload: () => void;
}) {
  return (
    <AttachmentPreviewShell filename={filename} onClose={onClose} onDownload={onDownload}>
      <div className="flex h-full w-full items-center justify-center bg-brutal-cream p-4">
        <AudioPreviewBody filename={filename} url={url} />
      </div>
    </AttachmentPreviewShell>
  );
}

export function AudioPreviewBody({
  filename,
  url,
  actions,
  onError,
  variant = "modal",
}: {
  filename: string;
  url: string;
  actions?: ReactNode;
  onError?: () => void;
  variant?: "modal" | "inline";
}) {
  const { formatMessage } = useIntl();
  const inline = variant === "inline";
  return (
    <div className={inline ? INLINE_AUDIO_PREVIEW_CARD_CLASS : "w-full max-w-xl border-2 border-black bg-white p-4 shadow-brutal"}>
      <div className={`${inline ? "mb-2 gap-2" : "mb-3 gap-3"} flex items-center justify-between`}>
        <div className={`flex min-w-0 items-center ${inline ? "gap-2" : "gap-3"}`}>
          <div className={`flex shrink-0 items-center justify-center border-2 border-black bg-soft-signal ${inline ? "size-8" : "size-10"}`}>
            <Music size={inline ? 16 : 20} className="text-black" />
          </div>
          <div className="min-w-0">
            <div className="truncate text-sm font-bold text-black" title={filename}>{filename}</div>
            <div className="text-xs font-bold text-black/50">{formatMessage({ id: "message.messageItem.audioFile" })}</div>
          </div>
        </div>
        {actions ? <div className="shrink-0">{actions}</div> : null}
      </div>
      <audio
        title={formatMessage({ id: "message.messageItem.audioPreviewTitle" }, { filename })}
        src={url}
        controls
        preload="metadata"
        className="block w-full"
        onError={onError}
      />
    </div>
  );
}

export const INLINE_AUDIO_PREVIEW_CARD_CLASS = "w-full max-w-[min(28rem,calc(100vw-7rem))] overflow-hidden border-2 border-black bg-white p-2 text-left";


function HtmlPreviewBody({
  url,
  filename,
  commentsEnabled,
}: {
  url: string;
  filename: string;
  commentsEnabled: boolean;
}) {
  const { formatMessage } = useIntl();
  const ctx = useContext(PreviewCommentModeContext);
  const commentMode = commentsEnabled && (ctx?.commentMode ?? false);
  const [pendingExternalLink, setPendingExternalLink] = useState<AttachmentPreviewExternalLink | null>(null);
  const pendingExternalLinkRef = useRef<AttachmentPreviewExternalLink | null>(null);
  const lastExternalLinkAttemptAtRef = useRef(Number.NEGATIVE_INFINITY);
  const updatePendingExternalLink = useCallback((link: AttachmentPreviewExternalLink | null) => {
    pendingExternalLinkRef.current = link;
    setPendingExternalLink(link);
  }, []);
  const {
    iframeRef,
    state,
    stateRef,
    externalLinks,
    externalLinksReady,
    scrollTo,
    scrollBy,
    describe,
    locate,
    buildSrc,
    activateDocument,
  } = useAttachmentPreviewBridge();
  const handlePreviewDocumentLoad = useCallback(() => {
    // The iframe node is stable across hostile top-level self-navigation, but
    // its parent-owned link actions are document-scoped. Retire both bridge
    // inventory and any blocked-popup fallback until this document reports a
    // fresh inventory; never let the replacement document redeem an old URL.
    activateDocument();
    updatePendingExternalLink(null);
    lastExternalLinkAttemptAtRef.current = Number.NEGATIVE_INFINITY;
  }, [activateDocument, updatePendingExternalLink]);
  const externalLinkHotspots = useMemo(() => externalLinks.flatMap((candidate, linkIndex) => {
    const validated = validateAttachmentPreviewExternalLink(candidate.href, window.location.origin);
    if (!validated.ok) return [];
    return candidate.rects.map((rect, rectIndex) => ({
      key: `${linkIndex}:${rectIndex}:${validated.link.href}`,
      link: validated.link,
      text: candidate.text,
      rect,
    }));
  }), [externalLinks]);
  const handleExternalLinkHotspot = useCallback((link: AttachmentPreviewExternalLink) => {
    // This handler is attached only to parent-owned buttons positioned over
    // reported link rects. postMessage can move/forge a hotspot inside the
    // preview, but it cannot invoke this parent event or redeem activation
    // from the modal opener / another parent control.
    if (pendingExternalLinkRef.current) return;
    const now = performance.now();
    if (now - lastExternalLinkAttemptAtRef.current < ATTACHMENT_PREVIEW_EXTERNAL_LINK_COOLDOWN_MS) return;
    lastExternalLinkAttemptAtRef.current = now;
    if (openAttachmentPreviewExternalLink(link)) updatePendingExternalLink(null);
    else updatePendingExternalLink(link);
  }, [updatePendingExternalLink]);
  // Drag rect in overlay-local px while capturing; flash region in CONTENT px
  // (it must track the document as the bridge reports scrolling).
  const [drag, setDrag] = useState<{ x0: number; y0: number; x1: number; y1: number } | null>(null);
  const [flashRegion, setFlashRegion] = useState<{ x: number; y: number; w: number; h: number } | null>(null);
  const overlayRef = useRef<HTMLDivElement | null>(null);
  // Monotonic token so a slow async locate() from an earlier jump can't apply
  // over a newer click — "last click wins", not "last response wins" (Dozy
  // review #2818).
  const jumpSeqRef = useRef(0);
  const pushAnchor = ctx?.pushAnchor;
  const openPanel = ctx?.openPanel;

  // jumpToAnchor("html-region") delegates here while this preview is open:
  // scroll the document via the bridge and float a tracking flash marker.
  useEffect(() => {
    if (!commentsEnabled) return;
    let active = true;
    const handler = (anchor: StoredAnchor): boolean => {
      const storedX = Number(anchor.data.x);
      const storedY = Number(anchor.data.y);
      if (!Number.isFinite(storedX) || !Number.isFinite(storedY)) return false;
      const storedW = Number(anchor.data.w);
      const storedH = Number(anchor.data.h);
      const quote = typeof anchor.data.quote === "string" ? anchor.data.quote : "";
      const token = ++jumpSeqRef.current;
      const apply = (x: number, y: number, w: number, h: number) => {
        // Ignore a stale async locate that resolved after a newer jump or after
        // this preview handler tore down (Dozy review #2818).
        if (!active || token !== jumpSeqRef.current) return;
        const geometry = stateRef.current;
        const viewportWidth = geometry?.viewportWidth ?? 800;
        const viewportHeight = geometry?.viewportHeight ?? 600;
        scrollTo(Math.max(0, x - viewportWidth / 2), Math.max(0, y - viewportHeight / 3));
        setFlashRegion({ x, y, w: Number.isFinite(w) ? w : 0, h: Number.isFinite(h) ? h : 0 });
        // Marker is positioned from live bridge geometry, so there is no DOM
        // animation to listen for — a fixed lifetime matching .anchor-flash
        // retires it.
        window.setTimeout(() => setFlashRegion(null), 1800);
      };
      // Re-anchor the region by its stored quote in the CURRENT layout so the
      // marker tracks content reflow on resize (#29); fall back to the stored
      // coordinates on miss/timeout (never block on the hostile document).
      if (quote) {
        // nearY = stored vertical center: when the quote occurs more than
        // once, the reporter picks the occurrence nearest the original
        // anchor position instead of an arbitrary instance (#29 verify).
        void locate(quote, storedY + storedH / 2).then((rect) => {
          if (rect) apply(rect.x, rect.y, rect.w, rect.h);
          else apply(storedX, storedY, storedW, storedH);
        });
      } else {
        apply(storedX, storedY, storedW, storedH);
      }
      return true;
    };
    registerHtmlRegionJumpHandler(handler);
    return () => { active = false; registerHtmlRegionJumpHandler(null); };
  }, [commentsEnabled, scrollTo, stateRef, locate]);

  const overlayPoint = (e: ReactPointerEvent) => {
    const rect = overlayRef.current?.getBoundingClientRect();
    if (!rect) return null;
    return { x: e.clientX - rect.left, y: e.clientY - rect.top };
  };

  // Honest degrade (pre-staging): coarse pointers get NO region-capture
  // overlay. The pointer-down/up capture below has never been verified as
  // touch UX (real tap=point / drag=rect touch semantics are post-staging,
  // task #26) — hiding the affordance beats shipping a broken one. Touch
  // users still comment on HTML via the panel composer (unanchored), and
  // jump flash markers keep working: they render OUTSIDE this overlay.
  const coarsePointer = window.matchMedia("(pointer: coarse)").matches;

  return (
    <div className="relative h-full w-full">
      {/* Threat model: any human or agent can upload hostile HTML. We allow
          scripts for Mermaid/interactive diagrams, but intentionally omit
          allow-same-origin/top-navigation/forms/popups so the preview cannot
          join the Slock origin, read credentials, or affect the parent app.
          Isolation primitive shared with the mermaid diagram preview — config
          pinned here, unchanged from the pre-extraction iframe. The bridge
          params feed the appended geometry/external-link inventory reporter; every
          report remains hostile input and frameRef is only a postMessage
          identity/target, never content access. */}
      <SandboxedPreviewFrame
        title={formatMessage({ id: "message.messageItem.htmlPreviewTitle" }, { filename })}
        src={buildSrc(url)}
        sandbox="allow-scripts"
        referrerPolicy="no-referrer"
        className={`h-full w-full border-0 bg-white${externalLinksReady ? "" : " pointer-events-none"}`}
        frameRef={iframeRef}
        onLoad={handlePreviewDocumentLoad}
      />
      {!externalLinksReady ? (
        <div
          role="status"
          data-message-affordance="attachment-preview-external-links-loading"
          className="absolute inset-0 z-10 flex items-center justify-center bg-white/75"
        >
          <div className="flex items-center gap-2 border-2 border-black bg-white px-3 py-2 text-xs font-bold shadow-brutal-sm">
            <Spinner size="sm" /> {formatMessage({ id: "message.messageItem.preparingPreview" })}
          </div>
        </div>
      ) : null}
      {externalLinksReady ? (
        <div
          data-message-affordance="attachment-preview-external-link-hotspots"
          className="pointer-events-none absolute inset-0 z-10 overflow-hidden"
        >
          {externalLinkHotspots.map(({ key, link, text, rect }) => (
            <AttachmentTooltip key={key} content={link.href}>
              <button
                type="button"
                data-external-href={link.href}
                aria-label={formatMessage({ id: "message.messageItem.openExternalLink" }, { target: text || link.hostname })}
                className="pointer-events-auto absolute bg-transparent outline-none focus-visible:border-2 focus-visible:border-black focus-visible:bg-white/20"
                style={{ left: rect.x, top: rect.y, width: rect.w, height: rect.h }}
                onClick={() => handleExternalLinkHotspot(link)}
              />
            </AttachmentTooltip>
          ))}
        </div>
      ) : null}
      {pendingExternalLink ? (
        <div
          role="status"
          aria-live="polite"
          data-message-affordance="attachment-preview-external-link-fallback"
          className="absolute inset-x-3 bottom-3 z-40 flex items-center gap-2 border-2 border-black bg-white p-2 shadow-brutal"
        >
          <div className="min-w-0 flex-1">
            <div className="text-xs font-black">{formatMessage({ id: "message.messageItem.browserBlockedTab" })}</div>
            <div className="truncate text-xs font-bold" title={pendingExternalLink.hostname}>
              {pendingExternalLink.hostname}
            </div>
            <div className="truncate text-xs text-black/65" title={pendingExternalLink.href}>
              {pendingExternalLink.href}
            </div>
          </div>
          <Button
            type="button"
            size="sm"
            variant="default"
            onClick={() => {
              if (openAttachmentPreviewExternalLink(pendingExternalLink)) {
                updatePendingExternalLink(null);
              }
            }}
          >
            {formatMessage({ id: "message.messageItem.openLink" })}
          </Button>
          <Button
            type="button"
            size="icon-sm"
            variant="default"
            onClick={() => updatePendingExternalLink(null)}
            aria-label={formatMessage({ id: "message.messageItem.dismissExternalLink" })}
          >
            <X size={14} />
          </Button>
        </div>
      ) : null}
      {flashRegion && state ? (
        <div
          className="anchor-flash pointer-events-none absolute z-10 border-2 border-black"
          style={{
            left: flashRegion.x - state.scrollX,
            top: flashRegion.y - state.scrollY,
            width: Math.max(flashRegion.w, 14),
            height: Math.max(flashRegion.h, 14),
          }}
        />
      ) : null}
      {commentMode && !coarsePointer ? (
        <div
          ref={overlayRef}
          data-message-affordance="attachment-html-comment-overlay"
          className="absolute inset-0 z-20 cursor-crosshair touch-none"
          onWheel={(e) => {
            scrollBy(e.deltaX, e.deltaY);
          }}
          onPointerDown={(e) => {
            if (!state) {
              // Degraded explicitly (bridge silent): no fake precision — a
              // click just opens the panel for an unanchored comment.
              openPanel?.();
              return;
            }
            const pt = overlayPoint(e);
            if (!pt) return;
            e.currentTarget.setPointerCapture(e.pointerId);
            setDrag({ x0: pt.x, y0: pt.y, x1: pt.x, y1: pt.y });
          }}
          onPointerMove={(e) => {
            if (!drag) return;
            const pt = overlayPoint(e);
            if (!pt) return;
            setDrag({ ...drag, x1: pt.x, y1: pt.y });
          }}
          onPointerUp={() => {
            if (!drag || !state || !pushAnchor) {
              setDrag(null);
              return;
            }
            const x = Math.round(Math.min(drag.x0, drag.x1) + state.scrollX);
            const y = Math.round(Math.min(drag.y0, drag.y1) + state.scrollY);
            const w = Math.round(Math.abs(drag.x1 - drag.x0));
            const h = Math.round(Math.abs(drag.y1 - drag.y0));
            setDrag(null);
            // Ask the document what text the region covers so the chip reads
            // like a quote ("Activation D0≥35…") instead of raw coordinates
            // (cindyz: "~37% 有点看不懂"). Capture proceeds with a
            // coordinate-only anchor when the document doesn't answer.
            void describe(x, y, w, h).then((quote) => {
              pushAnchor({
                type: "html-region",
                data: {
                  x,
                  y,
                  w,
                  h,
                  viewportWidth: state.viewportWidth,
                  documentWidth: state.docWidth,
                  documentHeight: state.docHeight,
                  ...(quote ? { quote } : {}),
                },
              });
            });
          }}
        >
          <div className="pointer-events-none absolute left-1/2 top-3 z-30 -translate-x-1/2 border-2 border-black bg-white px-2 py-1 text-[11px] font-bold text-black shadow-brutal-sm">
            {state
              ? formatMessage({ id: "message.messageItem.clickToComment" })
              : formatMessage({ id: "message.messageItem.cantLocateInPage" })}
          </div>
          {drag ? (
            <div
              className="pointer-events-none absolute border-2 border-dashed border-black bg-soft-signal/20"
              style={{
                left: Math.min(drag.x0, drag.x1),
                top: Math.min(drag.y0, drag.y1),
                width: Math.abs(drag.x1 - drag.x0),
                height: Math.abs(drag.y1 - drag.y0),
              }}
            />
          ) : null}
        </div>
      ) : null}
    </div>
  );
}

function VideoPreviewBody({
  url,
  filename,
  commentsEnabled,
  attachmentId,
}: {
  url: string;
  filename: string;
  commentsEnabled: boolean;
  attachmentId: string | null;
}) {
  const { formatMessage } = useIntl();
  const videoRef = useRef<HTMLVideoElement>(null);
  const ctx = useContext(PreviewCommentModeContext);
  const commentMode = commentsEnabled && (ctx?.commentMode ?? false);
  const [videoState, setVideoState] = useState({ paused: true, time: 0 });
  const hasTimestampAnchor = ctx?.pendingAnchor?.type === "video-timestamp";
  const canAddPausedTimestamp =
    commentMode && videoState.paused && videoState.time > 0 && !hasTimestampAnchor;

  const pushCurrentTimeAnchor = useCallback(() => {
    if (!ctx) return;
    const video = videoRef.current;
    if (!video) return;
    const time = Math.round(video.currentTime * 1000) / 1000;
    if (time > 0) ctx.pushAnchor({ type: "video-timestamp", data: { time } });
  }, [ctx]);

  // Coalesce timestamp jumps onto the latest target (see videoTimestampSeekCoalesce).
  // Rapid currentTime writes thrash Chromium media (Aw Snap / error code 11).
  const seekCoalescerRef = useRef(createVideoSeekCoalescer(() => {
    const el = videoRef.current;
    if (!el) return null;
    return {
      pause: () => { el.pause(); },
      setCurrentTime: (time: number) => { el.currentTime = time; },
      get paused() { return el.paused; },
    };
  }));

  useEffect(() => {
    if (!videoRef.current) return;
    const video = videoRef.current;
    const coalescer = seekCoalescerRef.current;
    registerVideoTimestampJumpHandler((time) => coalescer.seek(time));
    if (attachmentId) {
      const pendingTime = consumePendingVideoSeek(attachmentId);
      if (pendingTime !== null) coalescer.seek(pendingTime);
    }
    return () => {
      registerVideoTimestampJumpHandler(null);
      coalescer.cancel();
      try { video.pause(); } catch { /* ignore */ }
    };
  }, [attachmentId]);

  useEffect(() => {
    const video = videoRef.current;
    if (!video) return;
    const syncVideoState = () => {
      setVideoState({
        paused: video.paused || video.ended,
        time: video.currentTime,
      });
    };
    video.addEventListener("loadedmetadata", syncVideoState);
    video.addEventListener("timeupdate", syncVideoState);
    video.addEventListener("pause", syncVideoState);
    video.addEventListener("play", syncVideoState);
    video.addEventListener("seeked", syncVideoState);
    video.addEventListener("ended", syncVideoState);
    return () => {
      video.removeEventListener("loadedmetadata", syncVideoState);
      video.removeEventListener("timeupdate", syncVideoState);
      video.removeEventListener("pause", syncVideoState);
      video.removeEventListener("play", syncVideoState);
      video.removeEventListener("seeked", syncVideoState);
      video.removeEventListener("ended", syncVideoState);
    };
  }, [url]);

  useEffect(() => {
    if (!videoRef.current || !commentMode || !ctx) return;
    const video = videoRef.current;
    // Only capture anchors from user-settled seeks (not intermediate frames
    // while a coalesced jump is still draining).
    const onSeeked = () => {
      // Intermediate seeked while a coalesced jump is still draining is ignored
      // by not pushing anchors until the user settles (paused + no further seeks).
      if (video.paused && video.currentTime > 0) pushCurrentTimeAnchor();
    };
    video.addEventListener("pause", pushCurrentTimeAnchor);
    video.addEventListener("seeked", onSeeked);
    return () => {
      video.removeEventListener("pause", pushCurrentTimeAnchor);
      video.removeEventListener("seeked", onSeeked);
    };
  }, [commentMode, ctx, pushCurrentTimeAnchor]);

  return (
    <div className="relative flex h-full w-full flex-col items-center justify-center bg-black p-4">
      <video
        ref={videoRef}
        title={formatMessage({ id: "message.messageItem.videoPreviewTitle" }, { filename })}
        src={url}
        controls
        playsInline
        preload="metadata"
        className="max-h-full max-w-full border-2 border-black bg-black"
      />
      {canAddPausedTimestamp ? (
        <AttachmentTooltip content={formatMessage({ id: "message.messageItem.attachTimestamp" }, { timestamp: formatVideoCommentTimestamp(videoState.time) })}>
          <Button
            type="button"
            size="sm"
            variant="default"
            data-message-affordance="video-comment-add-timestamp"
            onClick={(event) => {
              event.stopPropagation();
              pushCurrentTimeAnchor();
            }}
            className="absolute bottom-5 left-1/2 -translate-x-1/2"
          >
            <Plus size={12} />
            <span>{formatMessage({ id: "message.messageItem.addTimestamp" }, { timestamp: formatVideoCommentTimestamp(videoState.time) })}</span>
          </Button>
        </AttachmentTooltip>
      ) : null}
    </div>
  );
}


function formatVideoCommentTimestamp(seconds: number): string {
  const safeSeconds = Math.max(0, Math.floor(seconds));
  const h = Math.floor(safeSeconds / 3600);
  const m = Math.floor((safeSeconds % 3600) / 60);
  const s = safeSeconds % 60;
  return h > 0
    ? `${h}:${String(m).padStart(2, "0")}:${String(s).padStart(2, "0")}`
    : `${m}:${String(s).padStart(2, "0")}`;
}


// Stryker restore all
