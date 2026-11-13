import { Spinner, Button } from "@botiverse/raft-ui";
import { useEffect, useState, useCallback } from "react";
import type { MouseEvent } from "react";
import { useIntl } from "react-intl";
import { ChevronLeft, ChevronRight, ImageOff } from "lucide-react";
import { useImageLightboxStore } from "../store/imageLightboxStore";
import { transparentImageBackgroundClass } from "../utils/imagePreviewStyles";
import { isHeicImageMimeType, normalizeImageMimeType } from "../utils/imageMimeTypes";
import api from "../api/client";
import { FileViewerHeader, FileViewerShell } from "./FileViewerShell";
import Tooltip from "./ui/Tooltip";
import { AttachmentCommentsPanel } from "./message/AttachmentCommentsPanel";
import { PROGRAMMATIC_ZOOM_ANIMATION_MS, useImageZoom } from "./ImageZoom";
import { useShortcutLayer } from "../features/shortcuts/useShortcutLayer";

const URL_CACHE_SAFETY_WINDOW_MS = 60_000;
const EMPTY_FAILED_SRCS: ReadonlySet<string> = new Set();

interface AttachmentUrlResponse {
  url: string;
  expiresAt: string | null;
}

function triggerDownload(href: string, filename: string) {
  const a = document.createElement("a");
  a.href = href;
  a.download = filename;
  a.rel = "noopener";
  a.style.display = "none";
  document.body.appendChild(a);
  a.click();
  a.remove();
}

export default function ImageLightbox() {
  const { formatMessage } = useIntl();
  const { isOpen, images, currentIndex, close, next, prev, goTo, imageUrlCache, cacheImageUrl, commentContexts } =
    useImageLightboxStore();
  const [fullUrl, setFullUrl] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState(false);
  // Sources an <img> here failed to load (undecodable format, dead URL). They
  // are skipped for the next candidate, and finally the error tile, instead of
  // leaving a broken-image glyph on the stage or in the thumbnail strip.
  const [failedSrcs, setFailedSrcs] = useState<ReadonlySet<string>>(EMPTY_FAILED_SRCS);
  const markSrcFailed = useCallback((src: string) => {
    setFailedSrcs((current) => (current.has(src) ? current : new Set([...current, src])));
  }, []);
  // Attachment comments on the lightbox surface (F10, task #10). Same
  // mechanics as AttachmentPreviewShell: panel mounts on first open and
  // stays mounted (collapse animation, no refetch on reopen), collapsed
  // surfaces are inert. The panel context follows the CURRENT image as the
  // user pages through the gallery.
  const [commentsOpen, setCommentsOpen] = useState(false);
  const [panelMounted, setPanelMounted] = useState(false);

  const current = images[currentIndex];
  const currentCommentContext = current ? commentContexts[current.id] : undefined;
  // Zoom + pan controller for the current image. Reset key = current image id
  // so prev/next + close all reset scale=1, translate=(0,0). Zoom state lives
  // entirely inside the hook (per-mount React state); not in
  // imageLightboxStore — transient interaction, not persistent gallery model.
  const zoom = useImageZoom({
    resetKey: current?.id ?? null,
    programmaticZoomAnimationMs: PROGRAMMATIC_ZOOM_ANIMATION_MS,
  });
  const toggleComments = useCallback(() => {
    if (!commentsOpen) setPanelMounted(true);
    setCommentsOpen((open) => !open);
  }, [commentsOpen]);
  const hasMultiple = images.length > 1;
  const isFirst = currentIndex === 0;
  const isLast = currentIndex === images.length - 1;
  const currentMimeType = normalizeImageMimeType(current?.mimeType);
  const isRasterOnlyPreview = currentMimeType === "image/svg+xml" || isHeicImageMimeType(currentMimeType);

  // Fetch full-resolution URL when current image changes. Async-loader +
  // reset-on-current-change. Same FP family as Cluster 2/3 async-loaders.
  // oxlint-disable-next-line react-doctor/no-cascading-set-state
  useEffect(() => {
    if (!current) return;
    let cancelled = false;

    // Images carrying a ready-to-use URL (e.g. avatars) skip the attachment fetch.
    if (current.directUrl) {
      setLoading(false);
      setError(false);
      setFullUrl(current.directUrl);
      return;
    }

    if (isRasterOnlyPreview) {
      const safeRasterUrl = current.rasterPreviewUrl || current.thumbnailUrl || current.localPreviewUrl;
      setLoading(false);
      setError(!safeRasterUrl);
      setFullUrl(safeRasterUrl ?? null);
      return;
    }

    const cached = imageUrlCache[current.id];
    const cachedExpiresAt = cached?.expiresAt ? Date.parse(cached.expiresAt) : null;
    const cacheStillValid =
      !!cached &&
      (cachedExpiresAt == null || Number.isFinite(cachedExpiresAt) && Date.now() < cachedExpiresAt - URL_CACHE_SAFETY_WINDOW_MS);

    if (cacheStillValid) {
      setLoading(false);
      setError(false);
      setFullUrl(cached.url);
      return;
    }

    setLoading(true);
    setFullUrl(null);
    setError(false);
    api
      .get<AttachmentUrlResponse>(`/attachments/${current.id}/url`)
      .then(({ data }) => {
        if (cancelled) return;
        cacheImageUrl(current.id, { url: data.url, expiresAt: data.expiresAt ?? null });
        setFullUrl(data.url);
      })
      .catch(() => {
        if (!cancelled) setError(true);
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [cacheImageUrl, current, imageUrlCache, isRasterOnlyPreview]);

  // Keyboard navigation (the raft-ui Lightbox handles Esc; we add ArrowLeft/Right
  // + zoom shortcuts). When the user is zoomed, ArrowLeft/Right pan instead of
  // navigating — otherwise prev/next would feel like "image jumped" mid-pan.
  const handleKeyDown = useCallback(
    (e: KeyboardEvent) => {
      if (e.key === "ArrowLeft") {
        if (zoom.isZoomed) return;
        if (!isFirst) prev();
      } else if (e.key === "ArrowRight") {
        if (zoom.isZoomed) return;
        if (!isLast) next();
      } else if (e.key === "0") {
        zoom.reset();
      }
    },
    [prev, next, isFirst, isLast, zoom],
  );

  const handlePrevClick = useCallback(
    (e: MouseEvent) => {
      e.stopPropagation();
      if (!isFirst) prev();
    },
    [isFirst, prev],
  );

  const handleNextClick = useCallback(
    (e: MouseEvent) => {
      e.stopPropagation();
      if (!isLast) next();
    },
    [isLast, next],
  );

  const handleDownload = useCallback(() => {
    if (!current) return;
    // directUrl images (e.g. avatars) have no attachment record — download the
    // resolved URL directly instead of hitting the attachment presign endpoint.
    if (current.directUrl) {
      triggerDownload(current.directDownloadUrl ?? current.directUrl, current.filename);
      return;
    }
    api.get<AttachmentUrlResponse>(`/attachments/${current.id}/url?disposition=attachment`).then(({ data }) => {
      triggerDownload(data.url, current.filename);
    }).catch(() => {});
  }, [current]);

  // Arrows and 0 while open: a layer over FileViewerShell's (a raft-ui Lightbox, which moves focus into the overlay on
  // open and closes on Esc), so a menu opened over the image takes its own keys first.
  useShortcutLayer("lightbox", isOpen, { onKey: handleKeyDown });

  // Lightbox close is a store-level unmount of the content (images reset),
  // so panel visibility resets with it — adjust during render, not effect.
  const [wasOpen, setWasOpen] = useState(isOpen);
  if (isOpen !== wasOpen) {
    setWasOpen(isOpen);
    if (!isOpen) {
      setCommentsOpen(false);
      setPanelMounted(false);
      setFailedSrcs(EMPTY_FAILED_SRCS);
    }
  }

  if (!isOpen || !current) return null;

  const fallbackSrc = current.thumbnailUrl || current.localPreviewUrl;
  const displaySrc = [fullUrl, fallbackSrc].find((src): src is string => !!src && !failedSrcs.has(src)) ?? null;

  const allSourcesFailed = !displaySrc && [fullUrl, fallbackSrc].some((src) => !!src && failedSrcs.has(src));

  const handleImageError = () => {
    if (!displaySrc) return;
    markSrcFailed(displaySrc);
    const nextSrc = [fullUrl, fallbackSrc].find((src) => !!src && src !== displaySrc && !failedSrcs.has(src));
    setError(!nextSrc);
  };

  return (
    <FileViewerShell
      onClose={close}
      data-testid="image-lightbox"
      aria-label={current.filename}
      header={(
        <FileViewerHeader
          filename={current.filename}
          index={currentIndex}
          count={images.length}
          commentsLabel={formatMessage({ id: commentsOpen ? "common.lightbox.hideComments" : "common.lightbox.comments" })}
          commentsOpen={commentsOpen}
          commentsAffordance="attachment-comments-toggle"
          onToggleComments={currentCommentContext ? toggleComments : undefined}
          onDownload={handleDownload}
          onClose={close}
        />
      )}
    >
      {/* Image area + comments aside — stage is pushed left continuously
          when comments open (same collapse/expand contract as the preview
          shell, task #14). */}
      <div className="flex min-h-0 flex-1">
      <div
        ref={zoom.wheelTargetRef}
        data-testid="image-lightbox-stage"
        // pointer-events-auto: the raft-ui lightbox lets the pointer through to its scrim; the stage takes it back.
        className="pointer-events-auto relative flex min-w-0 flex-1 items-center justify-center overflow-hidden"
        // A mouse click on the image toggles fit ↔ actual size; the release of
        // a pan drag is swallowed. Click lives on the stage because pointer
        // capture retargets clicks on an enlarged image here. Other
        // empty-stage clicks close the lightbox. After zoom/pan, the visual
        // image box no longer matches its original layout box, so also guard
        // against stage-target clicks that land inside the transformed image.
        onClick={(e) => {
          if (zoom.onClick(e)) return;
          if (e.target === e.currentTarget && !zoom.containsImagePoint(e.clientX, e.clientY)) close();
        }}
        onPointerDown={zoom.onPointerDown}
        onPointerMove={zoom.onPointerMove}
        onPointerUp={zoom.onPointerUp}
        onPointerCancel={zoom.onPointerUp}
        onTouchStart={zoom.onTouchStart}
        onTouchMove={zoom.onTouchMove}
        onTouchEnd={zoom.onTouchEnd}
        onTouchCancel={zoom.onTouchEnd}
        style={{ touchAction: zoom.style.touchAction, cursor: zoom.style.stageCursor }}
      >
        {/* Left arrow */}
        {hasMultiple && (
          <Tooltip content={formatMessage({ id: "common.lightbox.previousImage" })}>
            <span
              className="absolute left-8 z-raised inline-flex"
              onClick={(e) => e.stopPropagation()}
            >
              <Button size="icon-lg"
                type="button"
                disabled={isFirst}
                onClick={handlePrevClick}
                aria-label={formatMessage({ id: "common.lightbox.previousImage" })}
              >
                <ChevronLeft size={24} />
              </Button>
            </span>
          </Tooltip>
        )}

        {/* Right arrow */}
        {hasMultiple && (
          <Tooltip content={formatMessage({ id: "common.lightbox.nextImage" })}>
            <span
              className="absolute right-8 z-raised inline-flex"
              onClick={(e) => e.stopPropagation()}
            >
              <Button size="icon-lg"
                type="button"
                disabled={isLast}
                onClick={handleNextClick}
                aria-label={formatMessage({ id: "common.lightbox.nextImage" })}
              >
                <ChevronRight size={24} />
              </Button>
            </span>
          </Tooltip>
        )}

        {loading && !displaySrc ? (
          <div className="flex size-64 items-center justify-center">
            <Spinner size="lg" variant="inverse"  aria-label={formatMessage({ id: "common.loadingLabel" })} />
          </div>
        ) : (error || allSourcesFailed) && !displaySrc ? (
          <div className="flex size-64 flex-col items-center justify-center gap-3 text-foreground-on-hud/70">
            <ImageOff size={36} />
            {/* break-all so unbreakable long filenames wrap inside the 256px
                error stage instead of overflowing into the modal body.
                #proj-uiux task #133. */}
            <span className="px-4 text-center text-callout break-all">{current.filename}</span>
            <span className="text-caption">{formatMessage({ id: "common.lightbox.failedToLoad" })}</span>
          </div>
        ) : (
          displaySrc && (
            <img
              ref={zoom.imageRef}
              data-testid="image-lightbox-image"
              src={displaySrc}
              alt={current.filename}
              className={`max-h-full max-w-full object-contain ${transparentImageBackgroundClass} ${
                zoom.isZoomed ? "select-none" : ""
              }`}
              style={{
                transform: zoom.style.transform,
                cursor: zoom.style.cursor,
                transformOrigin: "center",
                willChange: zoom.isZoomed ? "transform" : "auto",
              }}
              onError={handleImageError}
              onTransitionEnd={zoom.onTransitionEnd}
              draggable={false}
            />
          )
        )}
      </div>

      {currentCommentContext ? (
        <aside
          // inert while collapsed: controls leave tab order + a11y tree.
          inert={!commentsOpen}
          className={`pointer-events-auto hidden h-full shrink-0 overflow-hidden border-line-seam bg-layer-canvas transition-[width] duration-300 ease-in-out sm:block ${
            commentsOpen ? "w-80 border-l" : "w-0 border-l-0"
          }`}
        >
          {/* Click shield lives on the inner div, not the semantic <aside>
              (a11y lint): stops the stage's blank-click close inside the panel. */}
          <div className="h-full w-80" onClick={(e) => e.stopPropagation()}>
            {panelMounted ? (
              <AttachmentCommentsPanel
                attachmentId={current.id}
                filename={current.filename}
                parentMessage={currentCommentContext.parentMessage}
              />
            ) : null}
          </div>
        </aside>
      ) : null}
      </div>

      {/* Narrow viewports: comments ride a bottom drawer (same pattern as
          the preview shell) since the aside is hidden below sm. */}
      {currentCommentContext ? (
        <div
          inert={!commentsOpen}
          onClick={(e) => e.stopPropagation()}
          className={`pointer-events-auto fixed bottom-0 right-0 z-control w-full border-t border-l border-line-seam bg-layer-canvas transition-transform duration-300 ease-in-out sm:hidden ${
            commentsOpen ? "translate-x-0" : "translate-x-full"
          }`}
          style={{ top: "calc(var(--header-height) + env(safe-area-inset-top, 0px))" }}
        >
          {panelMounted ? (
            <AttachmentCommentsPanel
              attachmentId={current.id}
              filename={current.filename}
              parentMessage={currentCommentContext.parentMessage}
            />
          ) : null}
        </div>
      ) : null}

      {/* Thumbnail strip (multi-image) */}
      {hasMultiple && (
        <div
          className="absolute bottom-4 left-0 right-0 z-raised flex items-center justify-center gap-1.5 pointer-events-none"
          onClick={(e) => e.stopPropagation()}
        >
          {images.map((img, idx) => {
            const candidateThumbSrc = img.thumbnailUrl || img.localPreviewUrl;
            const thumbSrc = candidateThumbSrc && !failedSrcs.has(candidateThumbSrc) ? candidateThumbSrc : null;
            const isActive = idx === currentIndex;
            return (
              <button
                key={img.id}
                type="button"
                onClick={() => goTo(idx)}
                className={`pointer-events-auto size-12 overflow-hidden rounded-sticker border-[1.5px] transition-[opacity,border-color] duration-100 outline-none focus-visible:shadow-focus ${
                  isActive
                    // The image you are on: the yellow "you are here" edge
                    // with its ink outline (a sticker edge, never a shadow).
                    ? "border-selected opacity-100 ring-[1.5px] ring-sticker-ink"
                    : "border-foreground-on-hud/30 opacity-60 hover:opacity-100 hover:border-foreground-on-hud/60"
                }`}
              >
                {thumbSrc ? (
                  <img
                    src={thumbSrc}
                    alt={img.filename}
                    onError={() => markSrcFailed(thumbSrc)}
                    className={`h-full w-full object-cover ${transparentImageBackgroundClass}`}
                    draggable={false}
                  />
                ) : (
                  <div className="flex h-full w-full items-center justify-center bg-foreground-on-hud/20 font-mono text-mono-meta text-foreground-on-hud/70">
                    {idx + 1}
                  </div>
                )}
              </button>
            );
          })}
        </div>
      )}
    </FileViewerShell>
  );
}
