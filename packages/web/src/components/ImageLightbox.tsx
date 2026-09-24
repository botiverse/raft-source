import { useEffect, useState, useCallback } from "react";
import { useIntl } from "react-intl";
import { X, ChevronLeft, ChevronRight, Download, ImageOff, MessageSquareMore } from "lucide-react";
import { useImageLightboxStore } from "../store/imageLightboxStore";
import { transparentImageBackgroundClass } from "../utils/imagePreviewStyles";
import api from "../api/client";
import Spinner from "./ui/Spinner";
import Lightbox from "./ui/Lightbox";
import Button from "./ui/Button";
import { AttachmentCommentsPanel } from "./message/AttachmentCommentsPanel";
import { useImageZoom } from "./ImageZoom";

const URL_CACHE_SAFETY_WINDOW_MS = 60_000;

interface AttachmentUrlResponse {
  url: string;
  expiresAt: string | null;
}

export default function ImageLightbox() {
  const { formatMessage } = useIntl();
  const { isOpen, images, currentIndex, close, next, prev, goTo, imageUrlCache, cacheImageUrl, commentContexts } =
    useImageLightboxStore();
  const [fullUrl, setFullUrl] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState(false);
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
  const zoom = useImageZoom({ resetKey: current?.id ?? null });
  const toggleComments = () => {
    if (!commentsOpen) setPanelMounted(true);
    setCommentsOpen((open) => !open);
  };
  const hasMultiple = images.length > 1;
  const isFirst = currentIndex === 0;
  const isLast = currentIndex === images.length - 1;
  const currentMimeType = current?.mimeType.split(";")[0]?.trim().toLowerCase();
  const isRasterOnlyPreview = currentMimeType === "image/svg+xml"
    || currentMimeType === "image/heic"
    || currentMimeType === "image/heif"
    || currentMimeType === "image/heic-sequence"
    || currentMimeType === "image/heif-sequence";

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

  // Keyboard navigation (Lightbox primitive handles ESC; we add ArrowLeft/Right
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

  useEffect(() => {
    if (!isOpen) return;
    // keydown-global-exempt: arrow nav inside <Lightbox> wrapper which moves focus into the overlay on open
    document.addEventListener("keydown", handleKeyDown);
    return () => document.removeEventListener("keydown", handleKeyDown);
  }, [isOpen, handleKeyDown]);

  // Lightbox close is a store-level unmount of the content (images reset),
  // so panel visibility resets with it — adjust during render, not effect.
  const [wasOpen, setWasOpen] = useState(isOpen);
  if (isOpen !== wasOpen) {
    setWasOpen(isOpen);
    if (!isOpen) {
      setCommentsOpen(false);
      setPanelMounted(false);
    }
  }

  if (!isOpen || !current) return null;

  const fallbackSrc = current.thumbnailUrl || current.localPreviewUrl;
  const displaySrc = fullUrl || fallbackSrc;

  const handleImageError = () => {
    if (fullUrl && fallbackSrc) {
      setFullUrl(null);
      setError(false);
      return;
    }
    setError(true);
  };

  const triggerDownload = (href: string) => {
    const a = document.createElement("a");
    a.href = href;
    a.download = current.filename;
    a.rel = "noopener";
    a.style.display = "none";
    document.body.appendChild(a);
    a.click();
    a.remove();
  };

  const handleDownload = () => {
    // directUrl images (e.g. avatars) have no attachment record — download the
    // resolved URL directly instead of hitting the attachment presign endpoint.
    if (current.directUrl) {
      triggerDownload(current.directUrl);
      return;
    }
    api.get<AttachmentUrlResponse>(`/attachments/${current.id}/url?disposition=attachment`).then(({ data }) => {
      triggerDownload(data.url);
    }).catch(() => {});
  };

  // Arrow button: always visible for symmetry, but disabled style when at boundary
  const arrowBtn = (disabled: boolean) =>
    disabled
      ? "flex items-center justify-center size-12 border-2 border-white/10 bg-white/5 text-white/20 cursor-default"
      : `flex items-center justify-center size-12 border-2 border-black bg-white text-black transition-colors duration-100 hover:bg-soft-signal`;

  return (
    <Lightbox
      onClose={close}
      className="flex flex-col"
      data-testid="image-lightbox"
    >
      {/* Title bar — in normal flow so image stage naturally starts below it */}
      <div
        className="safe-top safe-left safe-right pointer-events-auto shrink-0 border-b-2 border-black bg-white"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex h-14 items-center gap-3 px-4">
          <div className="min-w-0 flex-1 truncate text-sm font-bold font-display text-black">
            {current.filename}
          </div>
          {hasMultiple && (
            <div className="shrink-0 border-2 border-black bg-soft-signal px-3 py-1 text-xs font-bold font-display text-black">
              {currentIndex + 1} / {images.length}
            </div>
          )}
          <div className="flex shrink-0 items-center gap-1.5">
            {currentCommentContext ? (
              /* Same iconText pattern as the preview-shell comments toggle. */
              <Button
                type="button"
                onClick={toggleComments}
                shape="icon"
                tone={commentsOpen ? "yellow" : "white"}
                title={
                  commentsOpen
                    ? formatMessage({ id: "common.lightbox.hideComments" })
                    : formatMessage({ id: "common.lightbox.comments" })
                }
                aria-label={
                  commentsOpen
                    ? formatMessage({ id: "common.lightbox.hideComments" })
                    : formatMessage({ id: "common.lightbox.comments" })
                }
                aria-pressed={commentsOpen}
                data-comments-open={commentsOpen ? "true" : "false"}
                data-message-affordance="attachment-comments-toggle"
              >
                <MessageSquareMore size={14} aria-hidden="true" />
              </Button>
            ) : null}
            <Button
              type="button"
              onClick={handleDownload}
              shape="icon"
              title={formatMessage({ id: "common.lightbox.download" })}
            >
              <Download size={14} />
            </Button>
            <Button
              type="button"
              onClick={close}
              shape="icon"
              title={formatMessage({ id: "common.close" })}
            >
              <X size={14} />
            </Button>
          </div>
        </div>
      </div>

      {/* Image area + comments aside — stage is pushed left continuously
          when comments open (same collapse/expand contract as the preview
          shell, task #14). */}
      <div className="flex min-h-0 flex-1">
      <div
        ref={zoom.wheelTargetRef}
        data-testid="image-lightbox-stage"
        className="relative flex min-w-0 flex-1 items-center justify-center overflow-hidden"
        // Empty-stage clicks close the lightbox. After zoom/pan, the visual
        // image box no longer matches its original layout box, so also guard
        // against stage-target clicks that land inside the transformed image.
        onClick={(e) => {
          if (e.target === e.currentTarget && !zoom.containsImagePoint(e.clientX, e.clientY)) close();
        }}
        onDoubleClick={zoom.onDoubleClick}
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
          <button
            type="button"
            onClick={(e) => {
              e.stopPropagation();
              if (!isFirst) prev();
            }}
            className={`${arrowBtn(isFirst)} absolute left-8 z-10`}
            title={formatMessage({ id: "common.lightbox.previousImage" })}
          >
            <ChevronLeft size={24} />
          </button>
        )}

        {/* Right arrow */}
        {hasMultiple && (
          <button
            type="button"
            onClick={(e) => {
              e.stopPropagation();
              if (!isLast) next();
            }}
            className={`${arrowBtn(isLast)} absolute right-8 z-10`}
            title={formatMessage({ id: "common.lightbox.nextImage" })}
          >
            <ChevronRight size={24} />
          </button>
        )}

        {loading && !displaySrc ? (
          <div className="flex size-64 items-center justify-center">
            <Spinner size="lg" variant="inverse" />
          </div>
        ) : error && !displaySrc ? (
          <div className="flex size-64 flex-col items-center justify-center gap-3 text-white/40">
            <ImageOff size={48} />
            {/* break-all so unbreakable long filenames wrap inside the 256px
                error stage instead of overflowing into the modal body.
                #proj-uiux task #133. */}
            <span className="px-4 text-center text-sm font-display break-all">{current.filename}</span>
            <span className="text-xs">{formatMessage({ id: "common.lightbox.failedToLoad" })}</span>
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
                transition: "none",
                willChange: zoom.isZoomed ? "transform" : "auto",
              }}
              onError={handleImageError}
              draggable={false}
            />
          )
        )}
      </div>

      {currentCommentContext ? (
        <aside
          // inert while collapsed: controls leave tab order + a11y tree.
          inert={!commentsOpen}
          className={`pointer-events-auto hidden h-full shrink-0 overflow-hidden border-black bg-white transition-[width] duration-300 ease-in-out sm:block ${
            commentsOpen ? "w-80 border-l-2" : "w-0 border-l-0"
          }`}
        >
          {/* Click shield lives on the inner div, not the semantic <aside>
              (a11y lint): stops Lightbox backdrop-close inside the panel. */}
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
          className={`pointer-events-auto fixed bottom-0 right-0 z-20 w-full border-l-2 border-t-2 border-black bg-white transition-transform duration-300 ease-in-out sm:hidden ${
            commentsOpen ? "translate-x-0" : "translate-x-full"
          }`}
          style={{ top: "calc(56px + env(safe-area-inset-top, 0px))" }}
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
          className="absolute bottom-4 left-0 right-0 z-10 flex items-center justify-center gap-1.5 pointer-events-none"
          onClick={(e) => e.stopPropagation()}
        >
          {images.map((img, idx) => {
            const thumbSrc = img.thumbnailUrl || img.localPreviewUrl;
            const isActive = idx === currentIndex;
            return (
              <button
                key={img.id}
                type="button"
                onClick={() => goTo(idx)}
                className={`pointer-events-auto size-12 border-2 transition-all duration-100 overflow-hidden ${
                  isActive
                    ? "border-soft-signal shadow-brutal-sm"
                    : "border-white/30 opacity-60 hover:opacity-100 hover:border-white/60"
                }`}
              >
                {thumbSrc ? (
                  <img
                    src={thumbSrc}
                    alt={img.filename}
                    className={`h-full w-full object-cover ${transparentImageBackgroundClass}`}
                    draggable={false}
                  />
                ) : (
                  <div className="h-full w-full bg-white/20 flex items-center justify-center text-white/50 text-xs font-bold">
                    {idx + 1}
                  </div>
                )}
              </button>
            );
          })}
        </div>
      )}
    </Lightbox>
  );
}
