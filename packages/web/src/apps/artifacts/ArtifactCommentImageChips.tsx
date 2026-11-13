import { useCallback, useMemo, useRef } from "react";
import type { KeyboardEvent } from "react";
import { useIntl } from "react-intl";
import { ImageOff, RefreshCw, TriangleAlert, X } from "lucide-react";
import {
  Button,
  ComposerAttachment,
  ComposerAttachmentFailedOverlay,
  ComposerAttachmentImage,
  ComposerAttachmentRemove,
  ComposerAttachments,
  ComposerAttachmentUploadProgressBar,
} from "@botiverse/raft-ui";
import type { ArtifactCommentImage, ArtifactId, ObjectFileId } from "@botiverse/raft-shared";

import Tooltip from "../../components/ui/Tooltip";
import { useImageLightboxStore } from "../../store/imageLightboxStore";
import type { LightboxImage } from "../../store/imageLightboxStore";
import { transparentImageBackgroundClass } from "../../utils/imagePreviewStyles";
import { commentImageName, commentImageProblem } from "./artifactCommentImageText";
import { useCommentImageUrls } from "./artifactCommentImageUrls";
import type { CommentImageItem } from "./useCommentImageAttachments";

/** The file id of an image the box holds by id only (restored from this device): drawn from it. */
const restoredIdOf = (item: CommentImageItem): ObjectFileId | null => (item.preview === null && (item.status === "ready" || item.status === "expired") ? item.image.fileId : null);

/**
 * The images in a comment box (#proj-workspace:#146), as the message composer's attachments are
 * (features/composer/SortableAttachment.tsx): raft-ui's 64px ComposerAttachment thumbnails above the
 * input (outside the ink frame, as the DS compositions place them), each named by its file. One
 * uploaded opens in the app's lightbox (Preview). No words in the 64px cell (Kirby, #12929: they
 * didn't fit): uploading, the progress bar alone (said "Uploading" to assistive tech); failed or
 * expired, the failed cover with a warning icon, and where Retry may get past it a Retry icon
 * button whose name is the whole sentence; the reason is the line under the box. × removes any of
 * them, cancelling an upload still going. Not reorderable (at most four, in the order attached).
 */
export function CommentImageChips({ artifactId, items, onRemove, onRetry }: {
  artifactId: ArtifactId | null;
  items: readonly CommentImageItem[];
  onRemove: (key: string) => void;
  onRetry: (key: string) => void;
}) {
  const intl = useIntl();
  const { formatMessage } = intl;
  const restoredIds = useMemo(() => items.flatMap((item) => restoredIdOf(item) ?? []), [items]);
  const restoredViews = useCommentImageUrls(restoredIds.length > 0 ? artifactId : null, restoredIds);
  const srcs = items.map((item) => {
    const id = restoredIdOf(item);
    if (id === null) return item.preview;
    const view = restoredViews[restoredIds.indexOf(id)];
    return view?.status === "ok" ? view.url : null;
  });
  const srcsRef = useRef(srcs);
  srcsRef.current = srcs;
  // Preview: the lightbox on the uploaded images that are drawn, from the one pressed.
  const preview = useCallback((key: string) => {
    const shown: LightboxImage[] = [];
    let start = 0;
    items.forEach((item, index) => {
      const url = srcsRef.current[index];
      if (item.status !== "ready" || !url) return;
      if (item.key === key) start = shown.length;
      shown.push({ id: item.key, filename: commentImageName(item, index, intl), mimeType: item.image.contentType, sizeBytes: item.image.sizeBytes, width: item.image.width, height: item.image.height, directUrl: url, thumbnailUrl: url });
    });
    if (shown.length > 0) useImageLightboxStore.getState().open(shown, start);
  }, [items, intl]);
  if (items.length === 0) return null;
  return (
    <ComposerAttachments role="group" aria-label={formatMessage({ id: "artifacts.comments.images.label" })} data-testid="artifact-comment-attachments">
      {items.map((item, index) => (
        <CommentImageChip key={item.key} item={item} name={commentImageName(item, index, intl)} src={srcs[index] ?? null} onRemove={onRemove} onRetry={onRetry} onPreview={preview} />
      ))}
    </ComposerAttachments>
  );
}

function CommentImageChip({ item, name, src, onRemove, onRetry, onPreview }: {
  item: CommentImageItem;
  name: string;
  src: string | null;
  onRemove: (key: string) => void;
  onRetry: (key: string) => void;
  onPreview: (key: string) => void;
}) {
  const intl = useIntl();
  const { formatMessage } = intl;
  const { key, status } = item;
  const remove = useCallback(() => onRemove(key), [onRemove, key]);
  const retry = useCallback(() => onRetry(key), [onRetry, key]);
  const previewable = status === "ready" && src !== null;
  const open = useCallback(() => onPreview(key), [onPreview, key]);
  const openByKey = useCallback((event: KeyboardEvent<HTMLDivElement>) => {
    if (event.key !== "Enter" && event.key !== " ") return;
    event.preventDefault();
    onPreview(key);
  }, [onPreview, key]);
  const problem = commentImageProblem(item, intl);
  const retryable = item.status === "failed" && item.failure.kind === "failed";
  const thumbnail = (
    <ComposerAttachmentImage>
      {src ? (
        <img src={src} alt={name} className={`size-full object-cover ${transparentImageBackgroundClass}`} />
      ) : (
        <span className="flex size-full items-center justify-center bg-fill-muted text-foreground-hint">
          <ImageOff size={16} aria-hidden="true" />
        </span>
      )}
    </ComposerAttachmentImage>
  );
  return (
    <ComposerAttachment data-testid="artifact-comment-attachment" data-status={status}>
      {previewable ? (
        // As the message composer's chips: the image itself opens the preview.
        <Tooltip content={formatMessage({ id: "message.composer.previewImage" })}>
          <div
            role="button"
            tabIndex={0}
            onClick={open}
            onKeyDown={openByKey}
            aria-label={formatMessage({ id: "message.composer.previewAttachment" }, { file: name })}
            className="size-full cursor-zoom-in"
            data-testid="artifact-comment-attachment-preview"
          >
            {thumbnail}
          </div>
        </Tooltip>
      ) : thumbnail}
      {item.status === "uploading" ? (
        <>
          {/* The bar alone (its own track; aria-hidden in raft-ui): what it is, for assistive tech only. */}
          <ComposerAttachmentUploadProgressBar value={item.progress} data-testid="artifact-comment-attachment-progress" />
          <span className="sr-only">{formatMessage({ id: "message.composer.uploading" })}</span>
        </>
      ) : null}
      {problem ? (
        <ComposerAttachmentFailedOverlay
          className="gap-0.5"
          data-testid={retryable ? "artifact-comment-attachment-failed" : status === "expired" ? "artifact-comment-attachment-expired" : "artifact-comment-attachment-refused"}
        >
          <TriangleAlert size={16} aria-hidden="true" />
          {retryable ? (
            // A failure the Server may get past: Retry, named by the whole sentence (the file, why, what to do).
            <Tooltip content={formatMessage({ id: "artifacts.comments.images.retry" })}>
              <Button variant="ghost" size="icon-md" onClick={retry} aria-label={sentenceOf(name, problem.detail, intl)} data-testid="artifact-comment-attachment-retry">
                <RefreshCw />
              </Button>
            </Tooltip>
          ) : (
            // Retry can't help (the bytes refused, the quota used up, the upload gone): why, and what to do.
            <span className="sr-only">{sentenceOf(name, problem.detail, intl)}</span>
          )}
        </ComposerAttachmentFailedOverlay>
      ) : null}
      <ComposerAttachmentRemove onClick={remove} aria-label={formatMessage({ id: "message.composer.removeAttachment" }, { file: name })} data-testid="artifact-comment-attachment-remove">
        <X size={10} />
      </ComposerAttachmentRemove>
    </ComposerAttachment>
  );
}

/** An image's whole problem as one sentence: "shot.png: It didn't upload. Retry, or remove it." */
const sentenceOf = (name: string, detail: string, intl: Pick<ReturnType<typeof useIntl>, "formatMessage">) =>
  intl.formatMessage({ id: "artifacts.comments.images.problem" }, { name, detail });

/**
 * The images a comment or draft being edited keeps (its text is edited, its images stay: the
 * contract's PATCH takes text only), as thumbnails above the input, with no ×, and a line saying so.
 */
export function KeptCommentImages({ artifactId, images }: { artifactId: ArtifactId | null; images: readonly ArtifactCommentImage[] }) {
  const { formatMessage } = useIntl();
  const fileIds = useMemo(() => images.map((image) => image.fileId), [images]);
  const views = useCommentImageUrls(images.length > 0 ? artifactId : null, fileIds);
  if (images.length === 0) return null;
  return (
    <div className="flex flex-col gap-1">
      <ComposerAttachments role="group" aria-label={formatMessage({ id: "artifacts.comments.images.label" })} data-testid="artifact-comment-kept-images">
        {images.map((image, index) => {
          const view = views[index];
          return (
            <ComposerAttachment key={image.fileId} data-testid="artifact-comment-kept-image">
              <ComposerAttachmentImage>
                {view?.status === "ok" ? (
                  <img src={view.url} alt={formatMessage({ id: "artifacts.comments.images.alt" }, { index: index + 1, count: images.length })} className={`size-full object-cover ${transparentImageBackgroundClass}`} />
                ) : (
                  <span className="flex size-full items-center justify-center bg-fill-muted text-foreground-hint">
                    <ImageOff size={16} aria-hidden="true" />
                  </span>
                )}
              </ComposerAttachmentImage>
            </ComposerAttachment>
          );
        })}
      </ComposerAttachments>
    </div>
  );
}
