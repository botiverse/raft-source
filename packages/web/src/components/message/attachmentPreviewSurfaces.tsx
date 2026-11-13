import {
  Button,
  Card,
  CodeBlock,
  CodeBlockBody,
  LOCATED_MS,
  ScrollArea,
  Spinner,
  Tabs,
  TabsLabel,
  TabsList,
  TabsTab,
} from "@botiverse/raft-ui";
import CloseButton from "../ui/CloseButton";
import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState } from "react";
import type { PointerEvent as ReactPointerEvent, ReactNode } from "react";
import { Music, Plus, X } from "lucide-react";
import { useIntl } from "react-intl";
import Banner from "../ui/Banner";
import { XlsxPreviewEmpty } from "./XlsxPreviewEmpty";
import SandboxedPreviewFrame from "../ui/SandboxedPreviewFrame";
import CrossOriginPdfFrame from "../ui/CrossOriginPdfFrame";
import MarkdownContent from "../markdown/MarkdownContent";
import { createMarkdownOutlineHeadingComponents, extractMarkdownOutline, MarkdownOutlineNav } from "../markdown/MarkdownOutline";
import AttachmentTooltip from "./attachmentTooltip";
import { AttachmentCommentsPanel } from "./AttachmentCommentsPanel";
import { AttachmentCommentMargin } from "./AttachmentCommentMargin";
import type { AttachmentCommentMarginActions } from "./AttachmentCommentMargin";
import { useAttachmentComments } from "./useAttachmentComments";
import {
  captureNodeAnchor,
  captureSelectionAnchor,
  consumePendingVideoSeek,
  registerHtmlRegionJumpHandler,
  registerVideoTimestampJumpHandler,
} from "./attachmentCommentAnchors";
import type { CommentAnchor, StoredAnchor } from "./attachmentCommentAnchors";
import {
  ATTACHMENT_PREVIEW_EXTERNAL_LINK_COOLDOWN_MS,
  openAttachmentPreviewExternalLink,
  validateAttachmentPreviewExternalLink,
} from "./attachmentPreviewExternalLink";
import LeavingRaftMark from "../ui/LeavingRaftMark";
import type { AttachmentPreviewExternalLink } from "./attachmentPreviewExternalLink";
import { createVideoSeekCoalescer } from "./videoTimestampSeekCoalesce";
import { useAttachmentPreviewBridge } from "./attachmentPreviewBridge";
import type { DocumentAttachmentPreview } from "./attachmentPreview";
import type { Message } from "../../store/messageStore";
import { formatFileSizeBytes } from "../../utils/fileSizePresentation";
import { FileViewerHeader, FileViewerShell } from "../FileViewerShell";
import { INLINE_AUDIO_PREVIEW_CARD_CLASS } from "./attachmentPreviewLabels";

/**
 * Attachment preview surfaces, extracted from MessageItem.
 *
 * These lived inside MessageItem, which is why only a message could open a
 * document preview: the forward composer could not reach them and silently
 * downloaded instead. Housing them here lets every surface open the SAME
 * preview rather than growing a second implementation.
 */

export { DOCUMENT_PREVIEW_LABEL_ID, INLINE_AUDIO_PREVIEW_CARD_CLASS } from "./attachmentPreviewLabels";

export type PreviewCommentsContext = {
  attachmentId: string;
  filename: string;
  commentCount: number;
  parentMessage: Pick<Message, "id" | "channelId" | "senderId" | "senderType">;
};

/**
 * Where a preview shows its comments (task #118). The margin, each comment
 * beside the passage it is about, needs a document Raft renders itself and
 * can measure, whose stored anchors name a place in it: Markdown (section +
 * quote), plain text (lines) and CSV (rows). Everything else keeps the side
 * panel: HTML and PDF render in a frame, a video has times not passages, an
 * image has no text, and a spreadsheet's row anchors don't say which sheet
 * they are on, so placing them could attach a comment to the wrong row.
 */
export function attachmentCommentSurface(kind: DocumentAttachmentPreview["kind"]): "margin" | "panel" {
  return kind === "markdown" || kind === "text" || kind === "csv" ? "margin" : "panel";
}

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
  commentsSurface = "panel",
  copyText,
  onCopyError,
  children,
}: {
  filename: string;
  onClose: () => void;
  onDownload: () => void;
  /** Text the pane is showing, when it is copyable; the header then offers RUI's copy action. */
  copyText?: string;
  /** Called when that copy attempt fails; the host decides how to surface it. */
  onCopyError?: (error: Error) => void;
  // Markdown previews open in the lightbox's document mode: one page-length
  // body scrolls, so Chrome's native find-in-page brings off-screen matches
  // into view.
  layout?: "fill" | "browser-find";
  /** When set, the shell offers the attachment comments (MVP §5). */
  comments?: PreviewCommentsContext;
  /**
   * How those comments show: in the margin beside the document, or in the
   * side panel ({@link attachmentCommentSurface} decides per preview kind).
   */
  commentsSurface?: "margin" | "panel";
  children: ReactNode;
}) {
  const { formatMessage } = useIntl();
  const browserFindLayout = layout === "browser-find";
  // Margin comments replace the panel, its Preview/Comment mode, the drawer
  // and the phone sheet: the header button only shows or hides them, and they
  // show from the start (comments.md: a comment belongs beside its passage).
  const marginComments = comments && commentsSurface === "margin" ? comments : undefined;
  const panelComments = marginComments ? undefined : comments;
  const [marginShown, setMarginShown] = useState(true);
  // The shell loads the margin's comments (the panel loads its own): its
  // header button acts on whether there are any. On a file with no comments
  // yet it is how a comment on the whole file starts, and there is nothing to
  // hide; once there are comments it shows and hides them.
  const marginData = useAttachmentComments(marginComments?.attachmentId ?? null);
  const marginActions = useRef<AttachmentCommentMarginActions>(null);
  const startsFileComment = marginData.comments !== null
    && marginData.comments.length === 0
    && marginData.pendingComments.length === 0;
  const onMarginComments = useCallback(() => {
    if (startsFileComment) marginActions.current?.commentOnFile();
    else setMarginShown((shown) => !shown);
  }, [startsFileComment]);
  const [commentsOpen, setCommentsOpen] = useState(false);
  // Sticky after first open: the panel keeps its mounted content (and fetched
  // comments) while the collapse animation runs and across reopen.
  const [panelMounted, setPanelMounted] = useState(false);
  const [pendingAnchor, setPendingAnchor] = useState<CommentAnchor | null>(null);
  const pendingAnchorRef = useRef<CommentAnchor | null>(null);
  // Stryker disable all: behavior is pinned by attachmentCommentsPanelAnchor.behavior (removed in the 2026-11 web DOM test prune); remaining dependency-array mutants are equivalent for this ref + stable setter callback.
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
  const commentMode = mode === "comment" && Boolean(panelComments);
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
  const closeComments = useCallback(() => {
    setMode("preview");
    commitPendingAnchor(null);
    setCommentsOpen(false);
    setSheetState("collapsed");
  }, [commitPendingAnchor]);
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
  // Stryker disable all: behavior is pinned by attachmentCommentsPanelAnchor.behavior (removed in the 2026-11 web DOM test prune); remaining dependency-array mutant is equivalent because commitPendingAnchor is stable by construction.
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
  // Stryker disable next-line ArrowFunction: anchor-clear sync is covered by attachment comment Playwright flows.
  const clearPendingAnchor = useCallback(() => commitPendingAnchor(null), [commitPendingAnchor]);
  const previewCommentCtx = useMemo(
    // Stryker disable next-line ArrowFunction,ObjectLiteral: video timestamp pending-anchor propagation is covered by document attachment Playwright e2e.
    () => ({ commentMode, pendingAnchor, pushAnchor, getPendingAnchor, openPanel }),
    // Stryker disable next-line ArrayDeclaration: dependency freshness is exercised by the paused video timestamp Playwright flow.
    [commentMode, pendingAnchor, pushAnchor, getPendingAnchor, openPanel],
  );
  const sheetControls = useMemo(
    () => ({
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
    }),
    [sheetState, closeComments],
  );
  // browser-find (markdown) scrolls the document body, so the panel rides as a fixed drawer instead of splitting the
  // scroller. On narrow viewports both layouts use the same full-width drawer. Both comment surfaces are fixed over
  // the viewer, in the lightbox after its body (FileViewerShell's overlay), so the body's scrollbar never sits on them.
  const overlay = panelComments ? (
    <PreviewCommentModeContext.Provider value={previewCommentCtx}>
      {panelComments && browserFindLayout ? (
        /* Desktop markdown right-drawer (the browser-find layout has no flex
           aside): slides in/out via translate so the push-left padding and
           drawer move as one gesture. Narrow viewports use the bottom sheet
           below instead. */
        <div
          className={`pointer-events-auto fixed bottom-0 right-0 z-control hidden w-full max-w-80 border-l border-t border-line-seam bg-layer-canvas transition-transform duration-300 ease-in-out sm:block ${
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
              attachmentId={panelComments.attachmentId}
              filename={panelComments.filename}
              parentMessage={panelComments.parentMessage}
              pendingAnchor={pendingAnchor}
              getPendingAnchor={getPendingAnchor}
              onAnchorCleared={clearPendingAnchor}
            />
          ) : null}
        </div>
      ) : null}
      {panelComments ? (
        /* Mobile 2-state bottom sheet (task #26, cindyz simplification):
           collapsed (h-14, the panel's 56px PanelHeader) keeps the panel's
           header visible as the sheet header — that row is the mobile entry; half (45dvh) is the working
           state with the artifact still visible above. No full state, no
           separate handle bar. Height transitions keep it one continuous
           surface. */
        <div
          data-message-affordance="attachment-comments-sheet"
          className={`pointer-events-auto fixed inset-x-0 bottom-0 z-control flex flex-col border-t border-line-seam bg-layer-canvas transition-[height] duration-300 ease-in-out sm:hidden ${
            sheetState === "half" ? "h-[45dvh]" : "h-14"
          }`}
          onClick={(e) => e.stopPropagation()}
        >
          {/* No separate handle bar (cindyz 6/11): the panel's own control
              row IS the sheet header — its chevron (sheetControls) expands/
              collapses, and the collapsed state hides the body via
              display:none (out of tab order — no inert games needed). */}
          <AttachmentCommentsPanel
            attachmentId={panelComments.attachmentId}
            filename={panelComments.filename}
            parentMessage={panelComments.parentMessage}
            pendingAnchor={pendingAnchor}
            getPendingAnchor={getPendingAnchor}
            onAnchorCleared={clearPendingAnchor}
            // A chip jump on mobile means "show me the artifact": run the
            // full session boundary (Dozy review of a3a79538).
            onAnchorJump={closeComments}
            collapsedBody={sheetState === "collapsed"}
            sheetControls={sheetControls}
          />
        </div>
      ) : null}
    </PreviewCommentModeContext.Provider>
  ) : null;

  return (
    <FileViewerShell
      onClose={onClose}
      layout={browserFindLayout ? "document" : "contained"}
      data-testid={browserFindLayout ? "attachment-preview-browser-find-scroll" : undefined}
      aria-label={filename}
      overlay={overlay}
      header={(
        <FileViewerHeader
          filename={filename}
          {...(marginComments
            ? {
                // On a file with no comments it starts one, so it says so and
                // is a plain button; once there are comments it shows and hides them.
                commentsLabel: formatMessage({
                  id: startsFileComment ? "message.attachmentComments.commentOnFile" : "message.attachmentComments.title",
                }),
                commentsOpen: startsFileComment ? undefined : marginShown,
                commentsAffordance: "attachment-comments-toggle",
                // Nothing to show and no way to add: no button.
                onToggleComments: startsFileComment && !marginData.canComment ? undefined : onMarginComments,
              }
            : {
                commentsLabel: formatMessage({ id: "message.messageItem.previewComment" }),
                commentsOpen,
                commentsAffordance: "attachment-preview-mode",
                onToggleComments: panelComments ? (mode === "comment" ? exitCommentMode : enterCommentMode) : undefined,
              })}
          copyText={copyText}
          onCopyError={onCopyError}
          onDownload={onDownload}
          onClose={onClose}
        />
      )}
    >
      <PreviewCommentModeContext.Provider value={previewCommentCtx}>
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
            ? `pointer-events-auto w-full max-w-[100dvw] overflow-x-clip bg-layer-sidebar transition-[padding-right] duration-300 ease-in-out ${
                panelComments && commentsOpen ? "sm:pr-80" : ""
              }`
            : "pointer-events-auto relative min-h-0 w-full flex-1 overflow-hidden bg-layer-canvas"
        }
        onClick={(e) => e.stopPropagation()}
      >
        {marginComments ? (
          <AttachmentCommentMargin
            attachmentId={marginComments.attachmentId}
            filename={marginComments.filename}
            parentMessage={marginComments.parentMessage}
            shown={marginShown || startsFileComment}
            data={marginData}
            actionsRef={marginActions}
          >
            {children}
          </AttachmentCommentMargin>
        ) : !browserFindLayout && panelComments ? (
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
              className={`hidden h-full shrink-0 overflow-hidden border-line-seam transition-[width] duration-300 ease-in-out sm:block ${
                commentsOpen ? "w-80 border-l" : "w-0 border-l-0"
              }`}
            >
              <div className="h-full w-80">
                {panelMounted ? (
                  <AttachmentCommentsPanel
                    attachmentId={panelComments.attachmentId}
                    filename={panelComments.filename}
                    parentMessage={panelComments.parentMessage}
                    pendingAnchor={pendingAnchor}
                    getPendingAnchor={getPendingAnchor}
                    onAnchorCleared={clearPendingAnchor}
                  />
                ) : null}
              </div>
            </aside>
          </div>
        ) : (
          children
        )}
      </div>
      </PreviewCommentModeContext.Provider>
    </FileViewerShell>
  );
}

export function CsvPreviewPane({ preview, truncated }: { preview: Extract<DocumentAttachmentPreview, { kind: "csv" }>; truncated: boolean }) {
  const { formatMessage } = useIntl();
  return (
    // No nested vertical scroller (browser-find layout) — see TextPreviewPane.
    <div className="w-full bg-layer-sidebar p-4 font-mono text-mono-meta text-foreground">
      <div className="mb-2 flex items-center justify-between gap-3 text-foreground-hint">
        <span>{formatMessage({ id: "message.messageItem.csvPreview" })}</span>
        <span>{truncated ? formatMessage({ id: "message.messageItem.csvRowsFirst" }, { count: preview.rows.length }) : formatMessage({ id: "message.messageItem.csvRows" }, { count: preview.rowCount })}{formatMessage({ id: "message.messageItem.csvColumns" }, { count: preview.columnCount })}</span>
      </div>
      {/* Horizontal-only ScrollArea in the card: wide tables pan sideways, the
          vertical axis flows into the document scroll so ⌘F reaches every
          row. Known trade-off: the sticky thead pins to this area (a scroll
          container), not the viewport — wide-table panning beats a pinned header. */}
      <Card><ScrollArea orientation="horizontal" overscroll="auto" role="region" aria-label={formatMessage({ id: "message.messageItem.csvPreview" })}>
        <table className="min-w-full border-collapse bg-layer-card">
          <thead className="sticky top-0 z-sticky bg-fill-muted">
            <tr>
              {preview.headers.map((header, index) => (
                <th key={`${header}-${index}`} className="max-w-[220px] border border-line-hairline px-2 py-1 text-left font-bold">
                  <AttachmentTooltip content={header}><span className="block truncate">{header || formatMessage({ id: "message.messageItem.columnFallback" }, { index: index + 1 })}</span></AttachmentTooltip>
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {preview.rows.map((row, rowIndex) => (
              <tr key={rowIndex} data-anchor-row={rowIndex + 1} className="odd:bg-fill-muted/50">
                {preview.headers.map((_, columnIndex) => {
                  const value = row[columnIndex] ?? "";
                  return (
                    <td key={columnIndex} className="max-w-[220px] border border-line-hairline px-2 py-1 align-top">
                      <AttachmentTooltip content={value}><span className="block truncate">{value}</span></AttachmentTooltip>
                    </td>
                  );
                })}
              </tr>
            ))}
          </tbody>
        </table>
      </ScrollArea></Card>
      <div className="mt-2 text-foreground-hint">
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
  // Declared before the !selected early return: hooks must not trail it.
  const handleSheetChange = useCallback((next: string) => setActiveSheet(Number(next)), []);
  const selected = preview.sheets[Math.min(activeSheet, Math.max(0, preview.sheets.length - 1))];
  if (!selected) {
    return <XlsxPreviewEmpty className="bg-layer-sidebar" />;
  }
  const sheetTruncated = truncated || selected.truncated;
  const isEmpty = selected.headers.length === 0 && selected.rows.length === 0;
  return (
    <div className="w-full bg-layer-sidebar p-4 font-mono text-mono-meta text-foreground">
      <div className="mb-3 flex flex-wrap items-center justify-between gap-3 text-foreground-hint">
        <span>{formatMessage({ id: "message.messageItem.xlsxPreview" })}</span>
        <span>{formatMessage({ id: "message.messageItem.xlsxSheets" }, { count: preview.sheetCount })}</span>
      </div>
      {preview.sheets.length > 1 ? (
        <Tabs<string>
          value={String(activeSheet)}
          onValueChange={handleSheetChange}
          // TabsList scrolls its own row when the sheets don't fit.
          className="mb-3 min-w-0 max-w-full"
        >
          <TabsList aria-label={formatMessage({ id: "message.messageItem.xlsxSheetTabs" })}>
            {preview.sheets.map((sheet, index) => (
              <TabsTab
                key={`${sheet.name}-${index}`}
                value={String(index)}
              >
                <TabsLabel>{sheet.name || formatMessage({ id: "message.messageItem.xlsxUnnamedSheet" }, { index: index + 1 })}</TabsLabel>
              </TabsTab>
            ))}
          </TabsList>
        </Tabs>
      ) : null}
      {isEmpty ? (
        <XlsxPreviewEmpty />
      ) : (
        <Card><ScrollArea orientation="horizontal" overscroll="auto" role="region" aria-label={formatMessage({ id: "message.messageItem.xlsxPreview" })}>
          <table className="min-w-full border-collapse bg-layer-card">
            <thead className="sticky top-0 z-sticky bg-fill-muted"><tr>{selected.headers.map((header, index) => (
              <th key={`${header}-${index}`} className="max-w-[220px] border border-line-hairline px-2 py-1 text-left font-bold"><AttachmentTooltip content={header}><span className="block truncate">{header || formatMessage({ id: "message.messageItem.columnFallback" }, { index: index + 1 })}</span></AttachmentTooltip></th>
            ))}</tr></thead>
            <tbody>{selected.rows.map((row, rowIndex) => (
              <tr key={rowIndex} data-anchor-row={rowIndex + 1} className="odd:bg-fill-muted/50">
                {selected.headers.map((_, columnIndex) => { const value = row[columnIndex] ?? ""; return <td key={columnIndex} className="max-w-[220px] border border-line-hairline px-2 py-1 align-top"><AttachmentTooltip content={value}><span className="block truncate">{value}</span></AttachmentTooltip></td>; })}
              </tr>
            ))}</tbody>
          </table>
        </ScrollArea></Card>
      )}
      <div className="mt-2 text-foreground-hint">
        {sheetTruncated
          ? formatMessage({ id: "message.messageItem.xlsxTruncated" }, { count: selected.rows.length })
          : formatMessage({ id: "message.messageItem.xlsxShowingOf" }, { shown: selected.rows.length, total: selected.rowCount })}
      </div>
    </div>
  );
}

export function MarkdownPreviewPane({
  markdown,
  truncated,
  previewByteLength,
  sourceByteLength,
  onDownload,
}: {
  markdown: string;
  truncated: boolean;
  /** Bytes of the file the preview shows; set by the server when it cut. */
  previewByteLength?: number;
  /** The whole file's size in bytes, alongside previewByteLength. */
  sourceByteLength?: number;
  /** Download of the full file, offered from the truncation notice. */
  onDownload?: () => void;
}) {
  // Visual styling delegated to MarkdownContent so attachment preview shares
  // chat-body markdown primitives. The preview wrapper owns only the Slock
  // landing/blog-style reading shell: card, measure, and page padding.
  // stdrc 2026-05-08 #proj-uiux:6110c1ce (task #137).
  //
  // The server previews at most MARKDOWN_PREVIEW_BYTE_LIMIT of a file, cut at
  // its last whole line, and returns `truncated: true` with the sizes when the
  // file is larger (task #164; before it, a markdown file over ~64 KB was
  // refused and the click silently downloaded it). A truncated preview must
  // visibly declare its boundary — how much it shows, and that find-in-page
  // stops there — so absent matches read as "not in this preview", not "not
  // in this file" (#proj-uiux task #269, cindyz), and it offers the download
  // right there.
  const { formatMessage } = useIntl();
  const outline = useMemo(() => extractMarkdownOutline(markdown), [markdown]);
  const headingComponents = useMemo(
    () => createMarkdownOutlineHeadingComponents(outline),
    [outline],
  );

  return (
    <div className="min-h-[calc(100dvh-56px)] w-full max-w-[100dvw] overflow-x-clip bg-layer-sidebar px-4 py-8 md:px-8 md:py-10">
      <div className="mx-auto grid w-full max-w-3xl gap-6 xl:max-w-6xl xl:grid-cols-[16rem_minmax(0,48rem)] xl:items-start">
        <ScrollArea tabIndex={-1} overscroll="auto" className="hidden xl:sticky xl:top-10 xl:block xl:max-h-[calc(100dvh-7rem)] xl:self-start">
          <MarkdownOutlineNav outline={outline} />
        </ScrollArea>
        <div className="min-w-0">
          {truncated ? (
            // Info, not warning: a shortened preview is a fact about the
            // view, not a failure (the plain-text pane's "Truncated" is a
            // neutral hint for the same reason).
            <Banner
              intent="info"
              density="lg"
              className="mb-4"
              live={false}
              data-testid="markdown-preview-truncated"
              title={previewByteLength !== undefined && sourceByteLength !== undefined
                ? formatMessage(
                  { id: "message.messageItem.markdownTruncatedTitle" },
                  {
                    shown: formatFileSizeBytes(previewByteLength, formatMessage),
                    total: formatFileSizeBytes(sourceByteLength, formatMessage),
                  },
                )
                : formatMessage({ id: "message.messageItem.markdownTruncatedTitleUnsized" })}
              actions={onDownload ? (
                <Button type="button" size="md" variant="default" onClick={onDownload} data-testid="markdown-preview-truncated-download">
                  {formatMessage({ id: "message.messageItem.markdownTruncatedDownload" })}
                </Button>
              ) : undefined}
            >
              {formatMessage({ id: "message.messageItem.markdownTruncatedBody" })}
            </Banner>
          ) : null}
          <Card
            data-anchor-md-root=""
            className="max-w-full overflow-visible overflow-x-clip px-6 py-8 font-display text-body text-foreground md:px-10 md:py-12"
          >
            <MarkdownContent
              source={markdown}
              density="document"
              enableMermaid
              components={headingComponents}
            />
          </Card>
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
    <div className="w-full bg-layer-sidebar p-4">
      <div className="mb-2 flex items-center justify-between gap-3 font-mono text-mono-meta text-foreground-hint">
        <span>{formatMessage({ id: "message.messageItem.plainTextPreview" })}</span>
        {truncated ? <span>{formatMessage({ id: "message.messageItem.previewTruncated" })}</span> : null}
      </div>
      {/* Per-line elements (not one text node) so comment anchors can target
          and flash-highlight L<n> ranges (attachmentCommentAnchors). The
          preview is byte-capped server-side, so line count stays bounded.
          raft-ui's CodeBlock frame, but the lines wrap: a file in the viewer
          is read top to bottom, not scrolled sideways like a snippet. */}
      <CodeBlock className="my-0">
        <CodeBlockBody>
          <pre className="whitespace-pre-wrap break-words">
            {text.split(/\r?\n/).map((line, index) => (
              <div key={index} data-anchor-line={index + 1}>
                {line.length > 0 ? line : " "}
              </div>
            ))}
          </pre>
        </CodeBlockBody>
      </CodeBlock>
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
  onCopyError,
}: {
  filename: string;
  preview: DocumentAttachmentPreview;
  truncated: boolean;
  url: string | null;
  onClose: () => void;
  onDownload: () => void;
  comments?: PreviewCommentsContext;
  onCopyError?: (error: Error) => void;
}) {
  const { formatMessage } = useIntl();
  return (
    <AttachmentPreviewShell
      filename={filename}
      onClose={onClose}
      onDownload={onDownload}
      onCopyError={onCopyError}
      // Only the kinds we hold as plain text: a PDF or a spreadsheet has no
      // meaningful clipboard payload, and markdown copies its source (what the
      // pane renders), not the rendered HTML.
      copyText={
        preview.kind === "text"
          ? preview.text
          : preview.kind === "markdown"
            ? preview.markdown
            : undefined
      }
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
      commentsSurface={attachmentCommentSurface(preview.kind)}
    >
      {preview.kind === "csv" ? <CsvPreviewPane preview={preview} truncated={truncated} /> : null}
      {preview.kind === "xlsx" ? <XlsxPreviewPane preview={preview} truncated={truncated} /> : null}
      {preview.kind === "markdown" ? (
        <MarkdownPreviewPane
          markdown={preview.markdown}
          truncated={truncated}
          previewByteLength={preview.previewByteLength}
          sourceByteLength={preview.sourceByteLength}
          onDownload={onDownload}
        />
      ) : null}
      {preview.kind === "text" ? <TextPreviewPane text={preview.text} truncated={truncated} /> : null}
      {preview.kind === "pdf" ? (
        // Threat model: PDFs are uploaded by any human or agent, so the bytes
        // are attacker-controlled. The isolation boundary is the ORIGIN: the
        // PDF is served from the API / object-storage origin, never the app
        // origin, and CrossOriginPdfFrame refuses to render otherwise. It
        // carries no `sandbox` — Chromium's PDF viewer cannot run in any
        // sandboxed frame (task #91; supersedes the sandboxed shape from
        // #proj-frontend:8b1098b4 / the 2026-05-18 review, which rendered
        // chrome-error:// in Chrome and the desktop shell).
        <CrossOriginPdfFrame
          title={formatMessage({ id: "message.messageItem.pdfPreviewTitle" }, { filename })}
          src={url ?? ""}
          className="h-full w-full border-0 bg-sticker-paper"
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
      <div className="flex h-full w-full items-center justify-center bg-layer-sidebar p-4">
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
    <Card className={inline ? INLINE_AUDIO_PREVIEW_CARD_CLASS : "w-full max-w-xl p-4"}>
      <div className={`${inline ? "mb-2 gap-2" : "mb-3 gap-3"} flex items-center justify-between`}>
        <div className={`flex min-w-0 items-center ${inline ? "gap-2" : "gap-3"}`}>
          <div className={`flex shrink-0 items-center justify-center rounded-chip bg-fill-muted text-foreground-muted ${inline ? "size-8" : "size-9"}`}>
            <Music size={inline ? 16 : 18} />
          </div>
          <div className="min-w-0">
            <AttachmentTooltip content={filename}><div className="truncate text-callout font-semibold text-foreground">{filename}</div></AttachmentTooltip>
            <div className="font-mono text-mono-meta text-foreground-hint">{formatMessage({ id: "message.messageItem.audioFile" })}</div>
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
    </Card>
  );
}



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
  const dismissPendingExternalLink = useCallback(() => updatePendingExternalLink(null), [updatePendingExternalLink]);
  const openPendingExternalLink = useCallback(() => {
    if (pendingExternalLink && openAttachmentPreviewExternalLink(pendingExternalLink)) {
      updatePendingExternalLink(null);
    }
  }, [pendingExternalLink, updatePendingExternalLink]);
  // Drag rect in overlay-local px while capturing; flash region in CONTENT px
  // (it must track the document as the bridge reports scrolling).
  const [drag, setDrag] = useState<{ x0: number; y0: number; x1: number; y1: number } | null>(null);
  // The region a comment's anchor jumped to, located for LOCATED_MS. `token`
  // is the jump's, so a second jump to the same region restarts the highlight.
  const [flashRegion, setFlashRegion] = useState<{ x: number; y: number; w: number; h: number; token: number } | null>(null);
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
        setFlashRegion({ x, y, w: Number.isFinite(w) ? w : 0, h: Number.isFinite(h) ? h : 0, token });
        // The marker is positioned from live bridge geometry; it lives as long
        // as the located highlight. Each jump retires its own region (and only
        // its own: a newer one shown since stays), even when a newer jump's
        // locate was dropped and never replaced it.
        window.setTimeout(() => {
          setFlashRegion((region) => (region?.token === token ? null : region));
        }, LOCATED_MS);
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
        className={`h-full w-full border-0 bg-sticker-paper${externalLinksReady ? "" : " pointer-events-none"}`}
        frameRef={iframeRef}
        onLoad={handlePreviewDocumentLoad}
      />
      {!externalLinksReady ? (
        <div
          role="status"
          data-message-affordance="attachment-preview-external-links-loading"
          className="absolute inset-0 z-control flex items-center justify-center bg-layer-veil"
        >
          <div className="flex items-center gap-2 rounded-container bg-layer-popover px-3 py-2 text-callout font-semibold text-foreground shadow-float ring-1 ring-line-seam">
            <Spinner size="sm" aria-label={formatMessage({ id: "common.loadingLabel" })} /> {formatMessage({ id: "message.messageItem.preparingPreview" })}
          </div>
        </div>
      ) : null}
      {externalLinksReady ? (
        <div
          data-message-affordance="attachment-preview-external-link-hotspots"
          className="pointer-events-none absolute inset-0 z-raised overflow-hidden"
        >
          {externalLinkHotspots.map(({ key, link, text, rect }) => (
            <AttachmentTooltip key={key} content={link.href}>
              <button
                type="button"
                data-external-href={link.href}
                aria-label={formatMessage({ id: "message.messageItem.openExternalLink" }, { target: text || link.hostname })}
                className="pointer-events-auto absolute rounded-[2px] bg-transparent outline-none focus-visible:shadow-focus"
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
          className="absolute inset-x-3 bottom-3 z-float flex items-center gap-2 rounded-container bg-layer-popover p-2 pl-3 shadow-float ring-1 ring-line-seam"
        >
          <div className="min-w-0 flex-1">
            <div className="text-footnote font-bold text-foreground">{formatMessage({ id: "message.messageItem.browserBlockedTab" })}</div>
            <AttachmentTooltip content={pendingExternalLink.hostname}>
            <div className="truncate font-mono text-mono-meta font-bold text-foreground">
              {pendingExternalLink.hostname}
            </div>
            </AttachmentTooltip>
            <AttachmentTooltip content={pendingExternalLink.href}>
            <div className="truncate font-mono text-mono-meta text-foreground-hint">
              {pendingExternalLink.href}
            </div>
            </AttachmentTooltip>
          </div>
          <Button
            type="button"
            size="md"
            variant="outline"
            onClick={openPendingExternalLink}
          >
            {formatMessage({ id: "message.messageItem.openLink" })}
            <LeavingRaftMark data-icon="inline-end" />
          </Button>
          <CloseButton
            type="button"
            onClick={dismissPendingExternalLink}
            aria-label={formatMessage({ id: "message.messageItem.dismissExternalLink" })}
          >
            <X size={16} />
          </CloseButton>
        </div>
      ) : null}
      {flashRegion && state ? (
        // A located region of the document: square, no edge, raft-ui's located fade (states.md#located), but drawn
        // over the page, so its fill is a see-through info tint (--located-tint), never the opaque row fill that hid the text.
        <div
          key={flashRegion.token}
          data-located=""
          className="pointer-events-none absolute z-raised [--located-tint:color-mix(in_oklch,var(--info)_35%,transparent)]"
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
          className="absolute inset-0 z-control cursor-crosshair touch-none"
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
          <div className="pointer-events-none absolute left-1/2 top-3 z-float -translate-x-1/2 rounded-chip bg-layer-hud px-2 py-1 text-caption text-foreground-on-hud shadow-float">
            {state
              ? formatMessage({ id: "message.messageItem.clickToComment" })
              : formatMessage({ id: "message.messageItem.cantLocateInPage" })}
          </div>
          {drag ? (
            <div
              className="pointer-events-none absolute border border-dashed border-line-seam bg-brand-soft/50"
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
  const handleAddTimestampClick = useCallback((event: React.MouseEvent) => {
    event.stopPropagation();
    pushCurrentTimeAnchor();
  }, [pushCurrentTimeAnchor]);

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
        className="max-h-full max-w-full bg-black"
      />
      {canAddPausedTimestamp ? (
        <AttachmentTooltip content={formatMessage({ id: "message.messageItem.attachTimestamp" }, { timestamp: formatVideoCommentTimestamp(videoState.time) })}>
          <Button
            type="button"
            size="md"
            variant="outline"
            data-message-affordance="video-comment-add-timestamp"
            onClick={handleAddTimestampClick}
            className="absolute inset-x-0 bottom-5 mx-auto w-fit"
          >
            <Plus size={16} />
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
