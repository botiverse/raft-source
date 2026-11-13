import {
  Badge,
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
  Lightbox,
  LightboxActions,
  LightboxContent,
  LightboxHeaderMeta,
  LightboxTitle,
  LightboxToolbar,
  PanelAction,
  toast,
} from "@botiverse/raft-ui";
import { CommentIcon } from "@botiverse/ricons";
import { LightboxBody } from "@botiverse/raft-ui/wip";
import { useCallback, useRef } from "react";
import type { HTMLAttributes, MouseEvent, ReactNode } from "react";
import { useIntl } from "react-intl";
import { Check, Copy, Download, EllipsisVertical, X } from "lucide-react";
import { dismissLayerProps } from "./ui/dismissLayer";
import { useOpenerFocus, useOverlayLayer } from "./ui/useOverlayLayer";
import { useShortcut } from "../features/shortcuts/useShortcut";
import { useShortcutLayer } from "../features/shortcuts/useShortcutLayer";
import AttachmentTooltip from "./message/attachmentTooltip";
import { AttachmentTypeBadge } from "./message/AttachmentTypeBadge";
import { useMediaQuery } from "../hooks/effectPrimitives";
import { useCopyText } from "../hooks/useCopyText";
import { OVERLAY_TITLEBAR_NO_DRAG_ATTR, useOverlayTitleBar } from "./topbar/overlayTitleBar";

/**
 * The one file viewer frame.
 *
 * Every attachment preview (images, PDF, text, markdown, tables, HTML, video,
 * audio) opens in this shell, so they all share one header: the file name,
 * then the same actions in the same order, closing with Download and Close.
 * Each type keeps its own body below the header.
 *
 * The header's icon buttons are all PanelActions and take their icon size
 * from it (raft-ui's `size-control-icon`: 18px at desktop density, 22px on
 * touch), so no icon here passes its own `size`. The gap between them is
 * LightboxActions' own 4px. Comments uses the same glyph as the comment count
 * on the attachment card (`CommentIcon`).
 *
 * Phones get a short header: the file name, one overflow menu (or Download
 * alone when there is nothing else to offer) and Close. The type badge and
 * the gallery count are dropped there; the thumbnail strip shows position.
 */

// Below raft's `sm` breakpoint, the same width at which the viewers' comment
// panels switch to their bottom sheets.
export const FILE_VIEWER_PHONE_QUERY = "(max-width: 639px)";

function stopPropagation(e: MouseEvent) {
  e.stopPropagation();
}

export function FileViewerHeader({
  filename,
  index = 0,
  count = 1,
  commentsLabel,
  commentsOpen,
  commentsAffordance,
  onToggleComments,
  copyText,
  onCopyError,
  onDownload,
  onClose,
}: {
  filename: string;
  /** Where this file sits in a gallery; shown as "2 / 5" on wide screens. */
  index?: number;
  count?: number;
  /** The comments toggle renders when `onToggleComments` is set. */
  commentsLabel?: string;
  /** Whether the comments are shown. Leave it out when the button does
   *  something rather than toggling (it is then no pressed/unpressed toggle). */
  commentsOpen?: boolean;
  /** data-message-affordance hook the e2e suites click through. */
  commentsAffordance?: string;
  onToggleComments?: () => void;
  /** Text the body is showing, when it is copyable. */
  copyText?: string;
  onCopyError?: (error: Error) => void;
  onDownload: () => void;
  onClose: () => void;
}) {
  const { formatMessage } = useIntl();
  const phone = useMediaQuery(FILE_VIEWER_PHONE_QUERY);
  // Desktop: the header is the window's title bar while the viewer is open
  // (traffic-light / caption-button corners reserved, drag region).
  const titleBarProps = useOverlayTitleBar();
  const copyController = useCopyText({ resetKey: copyText });
  const { copyText: writeCopyText } = copyController;
  const handleCopy = useCallback(() => {
    if (!copyText) return;
    writeCopyText(copyText).then(() => {
      // The phone menu closes on select, so the icon swap can't confirm it there.
      if (phone) toast.success(formatMessage({ id: "common.lightbox.copied" }));
    }, (error: unknown) => {
      onCopyError?.(error instanceof Error ? error : new Error(String(error)));
    });
  }, [copyText, formatMessage, onCopyError, phone, writeCopyText]);

  const downloadLabel = formatMessage({ id: "common.lightbox.download" });
  const copyLabel = formatMessage({ id: "common.lightbox.copy" });
  const closeLabel = formatMessage({ id: "common.lightbox.close" });
  const hasCopy = Boolean(copyText);
  const hasOverflow = Boolean(onToggleComments) || hasCopy;

  const closeAction = (
    <AttachmentTooltip content={closeLabel}>
      {/* Last in the header: raft-ui's head ends its icon box on the margin
          and lets its hit area hang past it (DS › Alignment). */}
      <PanelAction onClick={onClose} aria-label={closeLabel}>
        <X aria-hidden="true" />
      </PanelAction>
    </AttachmentTooltip>
  );
  const downloadAction = (
    <AttachmentTooltip content={downloadLabel}>
      <PanelAction onClick={onDownload} aria-label={downloadLabel}>
        <Download aria-hidden="true" />
      </PanelAction>
    </AttachmentTooltip>
  );

  return (
    <LightboxToolbar
      {...titleBarProps}
      data-testid="file-viewer-header"
      className="z-chrome"
      onClick={stopPropagation}
    >
      <AttachmentTooltip content={filename}>
        {/* Desktop: keep the pointer here so the full-name tooltip shows (the
            rest of the header is a window drag region). */}
        <LightboxHeaderMeta className="gap-2" {...{ [OVERLAY_TITLEBAR_NO_DRAG_ATTR]: "" }}>
          {phone ? null : (
            <AttachmentTypeBadge
              filename={filename}
              data-testid="attachment-preview-type-badge"
              className="h-4 w-8 shrink-0"
            />
          )}
          <LightboxTitle>{filename}</LightboxTitle>
        </LightboxHeaderMeta>
      </AttachmentTooltip>
      {count > 1 && !phone ? (
        <Badge appearance="outline" className="shrink-0 tabular-nums">
          {index + 1} / {count}
        </Badge>
      ) : null}
      {/* Screen readers hear a copy land; the icon swap is visual only. */}
      <span className="sr-only" aria-live="polite" data-testid="file-viewer-copy-status">
        {copyController.copied ? formatMessage({ id: "common.lightbox.copied" }) : ""}
      </span>
      <LightboxActions>
        {phone ? (
          hasOverflow ? (
            <DropdownMenu>
              <AttachmentTooltip content={formatMessage({ id: "common.lightbox.moreActions" })}>
                <DropdownMenuTrigger
                  render={(
                    <PanelAction
                      aria-label={formatMessage({ id: "common.lightbox.moreActions" })}
                      data-testid="file-viewer-overflow-trigger"
                    >
                      <EllipsisVertical aria-hidden="true" />
                    </PanelAction>
                  )}
                />
              </AttachmentTooltip>
              <DropdownMenuContent side="bottom" align="end" sideOffset={4}>
                {onToggleComments ? (
                  <DropdownMenuItem onClick={onToggleComments} data-message-affordance={commentsAffordance}>
                    <CommentIcon />
                    {commentsLabel}
                  </DropdownMenuItem>
                ) : null}
                {hasCopy ? (
                  <DropdownMenuItem onClick={handleCopy}>
                    <Copy />
                    {copyLabel}
                  </DropdownMenuItem>
                ) : null}
                <DropdownMenuItem onClick={onDownload}>
                  <Download />
                  {downloadLabel}
                </DropdownMenuItem>
              </DropdownMenuContent>
            </DropdownMenu>
          ) : downloadAction
        ) : (
          <>
            {onToggleComments ? (
              <AttachmentTooltip content={commentsLabel}>
                <PanelAction
                  onClick={onToggleComments}
                  aria-label={commentsLabel}
                  aria-pressed={commentsOpen}
                  data-comments-open={commentsOpen ? "true" : "false"}
                  data-message-affordance={commentsAffordance}
                >
                  <CommentIcon aria-hidden="true" />
                </PanelAction>
              </AttachmentTooltip>
            ) : null}
            {hasCopy ? (
              <AttachmentTooltip content={copyLabel}>
                <PanelAction onClick={handleCopy} aria-label={copyLabel}>
                  {copyController.copied
                    ? <Check aria-hidden="true" />
                    : <Copy aria-hidden="true" />}
                </PanelAction>
              </AttachmentTooltip>
            ) : null}
            {downloadAction}
          </>
        )}
        {closeAction}
      </LightboxActions>
    </LightboxToolbar>
  );
}

/**
 * raft-ui's Lightbox, open while mounted: the scrim, the header, then the
 * body. `contained` (default) puts the header in flow above a body that fills
 * the rest of the window. `document` is raft-ui's document mode
 * (`modal="trap-focus"`): the page-length body scrolls in a LightboxBody under
 * the header, focus lands on it so the keys scroll it, and the page's scroll
 * isn't locked; the browser's find in page reaches every match.
 *
 * Esc, a press on the scrim and ⌘W close it. Focus moves in when it opens and
 * goes back to whatever opened the viewer when it closes. Popups opened inside
 * (tooltips, menus, the comment sheet) are Base UI's and portal into the
 * lightbox by themselves; `overlay` holds fixed surfaces of the viewer's own (a
 * comment drawer or sheet), drawn above the body, in the lightbox.
 */
export function FileViewerShell({
  onClose,
  header,
  layout = "contained",
  overlay,
  children,
  ...rest
}: {
  onClose: () => void;
  header: ReactNode;
  layout?: "contained" | "document";
  /** Fixed surfaces over the body (pointer-events-auto), after it in the lightbox. */
  overlay?: ReactNode;
  children: ReactNode;
} & Omit<HTMLAttributes<HTMLDivElement>, "children" | "onClick" | "className">) {
  const documentMode = layout === "document";
  const popupRef = useRef<HTMLDivElement | null>(null);
  // Read during the first render, before Base UI moves focus in.
  const finalFocus = useOpenerFocus();
  // A modal layer of the shortcut registry: ⌘K and the layers under it stop hearing keys while the viewer is open,
  // and its Esc stays Base UI's. Its scope is the lightbox's, for ⌘W / Ctrl+W (registry "close-preview", the desktop
  // app's; a browser keeps it for the tab): it closes the topmost preview, the viewer opened last.
  useOverlayLayer(true, "lightbox");
  // The preview's own commands (comment-selection, from the comment margin inside it) are the file preview's scope:
  // a layer of that scope over the modal one, with no keys of its own, so the registry still offers them under it.
  useShortcutLayer("filePreview", true);
  useShortcut("close-preview", () => { onClose(); });
  const handleOpenChange = useCallback((open: boolean) => {
    if (!open) onClose();
  }, [onClose]);

  return (
    <Lightbox open onOpenChange={handleOpenChange} modal={documentMode ? "trap-focus" : true} closeOnModW={false}>
      <LightboxContent
        ref={popupRef}
        // Document mode focuses the body itself (raft-ui); the contained viewer takes focus on the lightbox, so a
        // focused control under it can't swallow its keys (the arrows, Esc).
        initialFocus={documentMode ? undefined : popupRef}
        finalFocus={finalFocus}
        {...dismissLayerProps}
        {...rest}
      >
        {header}
        {documentMode ? <LightboxBody className="bg-layer-sidebar">{children}</LightboxBody> : children}
        {overlay}
      </LightboxContent>
    </Lightbox>
  );
}
