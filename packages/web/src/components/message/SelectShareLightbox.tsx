import { Button, Card, DialogHeader, Lightbox, LightboxContent, ScrollArea } from "@botiverse/raft-ui";
import { useCallback, useMemo, useRef, useState } from "react";
import type { SyntheticEvent } from "react";
import { useIntl } from "react-intl";
import { Check, ChevronLeft, ChevronRight, Copy, Download, Share2, X } from "lucide-react";
import { downloadDataUrl } from "../../utils/selectScreenshotShared";
import type { ValidatedScreenshot } from "../../utils/screenshotBudget";
import { createScreenshotZip, downloadBlob, screenshotPageFilename } from "../../utils/selectScreenshotArchive";
import { copyPngDataUrlToClipboard } from "../../utils/selectMarkdown";
import CloseButton from "../ui/CloseButton";
import { dismissLayerProps } from "../ui/dismissLayer";
import { ICON_SM_END_PULL } from "../ui/headEdges";
import { useOpenerFocus, useOverlayLayer } from "../ui/useOverlayLayer";
import { useShortcut } from "../../features/shortcuts/useShortcut";
import { OVERLAY_TITLEBAR_ATTR, useOverlayTitleBar } from "../topbar/overlayTitleBar";

export interface SelectShareLightboxProps {
  /** Validated captured pages. `image` remains for single-page callers. */
  images?: readonly ValidatedScreenshot[];
  image?: ValidatedScreenshot;
  /** Suggested filename when the user clicks Download. */
  filename?: string;
  /** Called when the user dismisses the preview (Cancel, X, ESC, backdrop). Selection should be preserved. */
  onClose: () => void;
  /** Called after a successful Download. Selection mode should exit here. Defaults to onClose if omitted. */
  onSaved?: () => void;
}

type FileShareNavigator = Navigator & {
  canShare?: (data: ShareData) => boolean;
  share?: (data: ShareData) => Promise<void>;
};

function isMobileBrowser(): boolean {
  if (typeof window === "undefined") return false;
  return window.innerWidth < 768 || /Android|iPhone|iPad|iPod/i.test(navigator.userAgent);
}

function pngFile(image: ValidatedScreenshot, filename: string): File {
  return new File([image.blob], filename, { type: "image/png" });
}

function pngFiles(images: readonly ValidatedScreenshot[], filename: string): File[] {
  return images.map((image, index) => pngFile(
    image,
    screenshotPageFilename(filename, index + 1, images.length),
  ));
}

function canSavePngViaNativeShare(images: readonly ValidatedScreenshot[], filename: string): boolean {
  if (!isMobileBrowser()) return false;
  const nav = navigator as FileShareNavigator;
  if (typeof nav.share !== "function" || typeof nav.canShare !== "function") return false;
  try {
    return nav.canShare({ files: pngFiles(images, filename) });
  } catch {
    return false;
  }
}

function missingScreenshot(): never {
  throw new Error("SelectShareLightbox requires at least one validated screenshot");
}

/**
 * Confirmation lightbox shown after the user clicks Share in select mode.
 * Captures are already validated; this surface previews and delivers every
 * page without silently reducing a multi-page artifact to page one.
 *
 * raft-ui's Lightbox (z-lightbox, above the conversation, the select-mode toolbar
 * and dialogs): Esc, a press on the scrim and ⌘W close it. It is opened from
 * state, so focus is explicit: in on the lightbox when it opens, back to what
 * opened it (the toolbar's Share) when it closes.
 */
export default function SelectShareLightbox({
  images,
  image,
  filename = "slock-export.png",
  onClose,
  onSaved,
}: SelectShareLightboxProps) {
  const { formatMessage } = useIntl();
  const screenshots = useMemo(
    () => images ? Array.from(images) : image ? [image] : [],
    [image, images],
  );
  const [currentPage, setCurrentPage] = useState(0);
  const currentImage = screenshots[currentPage] ?? screenshots[0] ?? missingScreenshot();
  const { dataUrl } = currentImage;
  const pageCount = screenshots.length;
  const mobile = isMobileBrowser();
  const popupRef = useRef<HTMLDivElement | null>(null);
  const finalFocus = useOpenerFocus();
  // Desktop: the lightbox covers the window, title bar included, and its card
  // floats in the middle, so it has no header at the window's top. An empty
  // strip there is the window's title bar while it is open (drag region), and
  // the card starts below it, so the strip never lies over its controls. A
  // press on the strip drags the window rather than closing the preview.
  const titleBar = useOverlayTitleBar();
  const titleBarStrip = OVERLAY_TITLEBAR_ATTR in titleBar;
  // A modal layer of the shortcut registry: ⌘K and the selection's own keys stop under it; its Esc is Base UI's. The
  // lightbox's scope, so ⌘W (registry "close-preview", the desktop app's) closes it, as FileViewerShell.
  useOverlayLayer(true, "lightbox");
  useShortcut("close-preview", () => { onClose(); });
  const handleOpenChange = useCallback((open: boolean) => {
    if (!open) onClose();
  }, [onClose]);
  const [savingImage, setSavingImage] = useState(false);
  const [copyingImage, setCopyingImage] = useState(false);
  const [imageCopied, setImageCopied] = useState(false);
  const busy = savingImage || copyingImage;
  const [actionError, setActionError] = useState<string | null>(null);
  const [previewSourceWidth, setPreviewSourceWidth] = useState<number | null>(null);
  const canNativeShareImages = useMemo(
    () => canSavePngViaNativeShare(screenshots, filename),
    [filename, screenshots],
  );
  const showNativeShareActions = mobile && canNativeShareImages;

  const handlePreviewImageLoad = (event: SyntheticEvent<HTMLImageElement>) => {
    const { naturalWidth } = event.currentTarget;
    if (naturalWidth <= 0) return;

    // The capture records its actual raster ratio. Avoid enlarging a 1x or 2x
    // fallback above its source CSS width in the preview.
    setPreviewSourceWidth(naturalWidth / currentImage.pixelRatio);
  };

  const handleDownloadAll = useCallback(async () => {
    if (busy) return;
    setActionError(null);
    setSavingImage(true);
    try {
      if (screenshots.length === 1) {
        downloadDataUrl(dataUrl, filename);
      } else {
        const archive = await createScreenshotZip(screenshots, filename);
        downloadBlob(archive, `${filename.replace(/\.png$/i, "") || "raft-export"}.zip`);
      }
      (onSaved ?? onClose)();
    } finally {
      setSavingImage(false);
    }
  }, [busy, screenshots, dataUrl, filename, onSaved, onClose]);

  const handleShareAll = useCallback(async () => {
    if (busy) return;
    setActionError(null);
    if (!canNativeShareImages) {
      setActionError(formatMessage({ id: "message.selectShare.nativeShareUnavailable" }));
      return;
    }
    setSavingImage(true);
    try {
      const nav = navigator as FileShareNavigator;
      await nav.share?.({
        files: pngFiles(screenshots, filename),
        title: formatMessage({ id: "message.selectShare.nativeShareTitle" }),
      });
      (onSaved ?? onClose)();
    } catch (err) {
      if (err instanceof DOMException && err.name === "AbortError") return;
      setActionError(formatMessage({ id: "message.share.failed" }));
    } finally {
      setSavingImage(false);
    }
  }, [busy, canNativeShareImages, screenshots, filename, onSaved, onClose, formatMessage]);

  const handleDownloadCurrent = useCallback(() => {
    if (busy) return;
    setActionError(null);
    downloadDataUrl(
      dataUrl,
      screenshotPageFilename(filename, currentPage + 1, pageCount),
    );
  }, [busy, currentPage, dataUrl, filename, pageCount]);

  const handleCopyImage = useCallback(async () => {
    if (busy) return;
    setCopyingImage(true);
    setImageCopied(false);
    setActionError(null);
    try {
      await copyPngDataUrlToClipboard(dataUrl);
      setImageCopied(true);
    } catch (err) {
      console.error("copyPngDataUrlToClipboard failed:", err);
      setActionError(formatMessage({ id: "message.share.copyImageFailed" }));
    } finally {
      setCopyingImage(false);
    }
  }, [busy, dataUrl, formatMessage]);

  const selectPage = useCallback((page: number) => {
    setCurrentPage(Math.max(0, Math.min(pageCount - 1, page)));
    setPreviewSourceWidth(null);
    setImageCopied(false);
    setActionError(null);
  }, [pageCount]);

  const selectPreviousPage = useCallback(() => {
    selectPage(currentPage - 1);
  }, [currentPage, selectPage]);

  const selectNextPage = useCallback(() => {
    selectPage(currentPage + 1);
  }, [currentPage, selectPage]);

  return (
    <Lightbox open onOpenChange={handleOpenChange} closeOnModW={false}>
      <LightboxContent
        ref={popupRef}
        initialFocus={popupRef}
        finalFocus={finalFocus}
        aria-label={formatMessage({ id: "message.selectShare.title" })}
        className={titleBarStrip ? "items-center justify-center p-4 pt-12" : "items-center justify-center p-4"}
        data-testid="select-share-lightbox"
        {...dismissLayerProps}
      >
      {titleBarStrip ? (
        <div
          {...titleBar}
          aria-hidden="true"
          className="pointer-events-auto absolute inset-x-0 top-0 h-12"
          data-testid="select-share-lightbox-titlebar"
        />
      ) : null}
      {/* pointer-events-auto: the lightbox lets the pointer through to its scrim, which closes it. */}
      <Card className="pointer-events-auto flex max-h-[min(90vh,100%)] w-full max-w-3xl flex-col">
        <DialogHeader bar>
          <div className="min-w-0 flex-1">
            <h2 className="truncate text-headline text-foreground">
              {formatMessage({ id: "message.selectShare.title" })}
            </h2>
            {pageCount > 1 ? (
              <p className="truncate text-caption text-foreground-muted">
                {formatMessage({ id: "message.selectShare.imageCount" }, { count: pageCount })}
              </p>
            ) : null}
          </div>
          {pageCount > 1 ? (
            <span
              className="shrink-0 rounded-chip bg-info-soft px-2 py-1 font-mono text-mono-meta text-foreground"
              data-testid="select-share-page-count"
            >
              {currentPage + 1}/{pageCount}
            </span>
          ) : null}
          <CloseButton
            type="button"
            onClick={onClose}
            aria-label={formatMessage({ id: "common.close" })}
            data-testid="select-share-lightbox-close"
            className={ICON_SM_END_PULL}
          >
            <X className="size-4.5" />
          </CloseButton>
        </DialogHeader>

        {/* The preview scrolls both ways in a raft-ui ScrollArea; its padding
            stays on the area so the page still centres in the full box
            (min-h-full / min-w-full) and the page buttons keep their place.
            The buttons sit 24px in at every width (in the 64px side padding),
            clear of the area's 16px scrollbar gutter on the right edge, which
            takes the pointer while the area is hovered. */}
        <ScrollArea
          orientation="both"
          role="region"
          aria-label={formatMessage({ id: "message.selectShare.title" })}
          className="relative min-h-0 flex-1 bg-fill-muted px-16 py-4 sm:px-20 sm:py-6"
        >
          {pageCount > 1 ? (
            <Button
              type="button"
              size="icon-md"
              variant="outline"
              onClick={selectPreviousPage}
              disabled={currentPage === 0}
              aria-label={formatMessage({ id: "message.selectShare.previousPage" })}
              className="absolute left-6 top-1/2 z-raised -translate-y-1/2"
              data-testid="select-share-previous-page"
            >
              <ChevronLeft />
            </Button>
          ) : null}
          <div className="flex min-h-full min-w-full items-center justify-center">
            <img
              key={currentPage}
              src={dataUrl}
              alt={formatMessage({ id: "message.selectShare.alt" })}
              className="mx-auto block max-w-full rounded-container border border-line-hairline shadow-float"
              onLoad={handlePreviewImageLoad}
              style={previewSourceWidth ? { width: `${previewSourceWidth}px` } : undefined}
            />
          </div>
          {pageCount > 1 ? (
            <Button
              type="button"
              size="icon-md"
              variant="outline"
              onClick={selectNextPage}
              disabled={currentPage === pageCount - 1}
              aria-label={formatMessage({ id: "message.selectShare.nextPage" })}
              className="absolute right-6 top-1/2 z-raised -translate-y-1/2"
              data-testid="select-share-next-page"
            >
              <ChevronRight />
            </Button>
          ) : null}
        </ScrollArea>

        <div className="flex shrink-0 flex-col gap-2 border-t border-line-hairline px-3 py-3 sm:px-5">
          {actionError && (
            <p
              role="alert"
              className="text-callout font-medium text-danger-strong"
              data-testid="select-share-lightbox-copy-error"
            >
              {actionError}
            </p>
          )}
          <div className="grid w-full grid-cols-2 gap-2 sm:ml-auto sm:w-auto">
            {showNativeShareActions ? (
              <Button
                type="button"
                size="md"
                variant="outline"
                className="w-full min-w-0 px-2"
                onClick={handleDownloadCurrent}
                disabled={busy}
                data-testid="select-share-lightbox-save-current"
              >
                <Download className="hidden min-[360px]:block" />
                {formatMessage({ id: "message.selectShare.saveCurrent" })}
              </Button>
            ) : (
              <Button
                type="button"
                size="md"
                variant="outline"
                className="w-full min-w-0 px-2"
                onClick={handleCopyImage}
                disabled={busy}
                loading={copyingImage}
                loadingLabel={formatMessage({ id: "message.selectShare.copying" })}
                data-testid="select-share-lightbox-copy-image"
              >
                {imageCopied ? <Check className="hidden min-[360px]:block" /> : <Copy className="hidden min-[360px]:block" />}
                {imageCopied
                  ? formatMessage({ id: "message.selectShare.copied" })
                  : formatMessage({ id: "message.selectShare.copyCurrent" })}
              </Button>
            )}
            {showNativeShareActions ? (
              <Button
                type="button"
                size="md"
                variant="accent"
                className="w-full min-w-0 px-2"
                onClick={handleShareAll}
                disabled={busy}
                loading={savingImage}
                loadingLabel={formatMessage({ id: "message.selectShare.sharing" })}
                data-testid="select-share-lightbox-share"
              >
                <Share2 className="hidden min-[360px]:block" />
                {formatMessage({ id: "message.selectShare.shareAll" })}
              </Button>
            ) : (
              <Button
                type="button"
                size="md"
                variant="accent"
                className="w-full min-w-0 px-2"
                onClick={handleDownloadAll}
                disabled={busy}
                loading={savingImage}
                loadingLabel={formatMessage({ id: "message.selectShare.saving" })}
                data-testid="select-share-lightbox-download"
              >
                <Download className="hidden min-[360px]:block" />
                {formatMessage({ id: "message.selectShare.downloadAll" })}
              </Button>
            )}
          </div>
        </div>
      </Card>
      </LightboxContent>
    </Lightbox>
  );
}
