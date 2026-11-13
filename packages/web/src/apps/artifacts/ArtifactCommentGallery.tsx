import { useCallback, useMemo, useRef, useState } from "react";
import { useIntl } from "react-intl";
import { ImageOff, RefreshCw } from "lucide-react";
import {
  buildMessageImageGalleryRows,
  MessageImageGallery,
  MessageImageGalleryItem,
  MessageImageGalleryMedia,
  MessageImageGalleryOverlay,
  MessageImageGalleryPreview,
  MessageImageGalleryRow,
  Spinner,
} from "@botiverse/raft-ui";
import type { MessageImageGalleryItemLayout } from "@botiverse/raft-ui";
import type { ArtifactCommentImage, ArtifactId } from "@botiverse/raft-shared";

import { useImageLightboxStore } from "../../store/imageLightboxStore";
import type { LightboxImage } from "../../store/imageLightboxStore";
import { useCommentImageUrls } from "./artifactCommentImageUrls";
import type { CommentImageView } from "./artifactCommentImageUrls";

/** A name for an image a comment carries (it has none of its own): what the lightbox downloads it as. */
const EXTENSIONS: Record<ArtifactCommentImage["contentType"], string> = { "image/png": "png", "image/jpeg": "jpg", "image/webp": "webp", "image/gif": "gif" };
const fileNameOf = (image: ArtifactCommentImage, index: number) => `comment-image-${index + 1}.${EXTENSIONS[image.contentType] ?? "img"}`;

/**
 * The images a posted comment or a draft carries (#proj-workspace:#146), as a message's are: raft-ui's
 * MessageImageGallery laid out by its rows (the pixel size the Server read reserves each cell). Each
 * is read through the Artifact source and drawn from a `blob:` URL (useCommentImageUrls); one that is
 * gone shows a small "Image unavailable" in its place. A click opens the app's image lightbox on the
 * comment's images that loaded.
 */
export function ArtifactCommentGallery({ artifactId, images }: { artifactId: ArtifactId | null; images: readonly ArtifactCommentImage[] | undefined }) {
  const { formatMessage } = useIntl();
  const list = useMemo(() => images ?? [], [images]);
  const fileIds = useMemo(() => list.map((image) => image.fileId), [list]);
  // Bumped by a failed image's Retry: what failed is read again.
  const [attempt, setAttempt] = useState(0);
  const reload = useCallback(() => setAttempt((n) => n + 1), []);
  const views = useCommentImageUrls(list.length > 0 ? artifactId : null, fileIds, attempt);
  const rows = useMemo(() => buildMessageImageGalleryRows(list), [list]);
  // The lightbox gets the ones that loaded, starting at the one clicked.
  const viewsRef = useRef(views);
  viewsRef.current = views;
  const open = useCallback((index: number) => {
    const views = viewsRef.current;
    const shown: LightboxImage[] = [];
    let start = 0;
    list.forEach((image, i) => {
      const view = views[i];
      if (view?.status !== "ok") return;
      if (i === index) start = shown.length;
      shown.push({ id: image.fileId, filename: fileNameOf(image, i), mimeType: image.contentType, sizeBytes: image.sizeBytes, width: image.width, height: image.height, directUrl: view.url, thumbnailUrl: view.url });
    });
    if (shown.length > 0) useImageLightboxStore.getState().open(shown, start);
  }, [list]);
  if (list.length === 0) return null;
  return (
    <MessageImageGallery className="mt-1.5" aria-label={formatMessage({ id: "artifacts.comments.images.label" })} data-testid="artifact-comment-images">
      {rows.map((row) => (
        <MessageImageGalleryRow key={row.items.map((item) => list[item.index]!.fileId).join("-")} row={row}>
          {row.items.map((layout) => (
            <GalleryImage
              key={list[layout.index]!.fileId}
              image={list[layout.index]!}
              index={layout.index}
              count={list.length}
              layout={layout}
              view={views[layout.index]!}
              onOpen={open}
              onReload={reload}
            />
          ))}
        </MessageImageGalleryRow>
      ))}
    </MessageImageGallery>
  );
}

function GalleryImage({ image, index, count, layout, view, onOpen, onReload }: {
  image: ArtifactCommentImage;
  index: number;
  count: number;
  layout: MessageImageGalleryItemLayout;
  view: CommentImageView;
  onOpen: (index: number) => void;
  onReload: () => void;
}) {
  const { formatMessage } = useIntl();
  const open = useCallback(() => onOpen(index), [onOpen, index]);
  const alt = formatMessage({ id: "artifacts.comments.images.alt" }, { index: index + 1, count });
  return (
    <MessageImageGalleryItem layout={layout} data-testid="artifact-comment-image" data-file-id={image.fileId} data-status={view.status}>
      {view.status === "ok" ? (
        <MessageImageGalleryMedia render={<img src={view.url} alt={alt} width={image.width} height={image.height} loading="lazy" />} />
      ) : view.status === "failed" ? (
        // Not read (offline, a 5xx): what it says, under the gallery's own press layer (below).
        <span aria-hidden="true" className="flex size-full flex-col items-center justify-center gap-1 bg-fill-muted text-caption text-foreground-hint">
          <RefreshCw size={20} aria-hidden="true" />
          <span>{formatMessage({ id: "artifacts.comments.images.loadFailed" })}</span>
        </span>
      ) : view.status === "missing" ? (
        // Gone (deleted with its comment, never kept): a small placeholder, never a broken image (as GalleryImageItem's; raft-ui has no such item state).
        <span
          role="img"
          aria-label={formatMessage({ id: "artifacts.comments.images.unavailable" })}
          className="flex size-full flex-col items-center justify-center gap-1 bg-fill-muted text-caption text-foreground-hint"
          data-testid="artifact-comment-image-unavailable"
        >
          <ImageOff size={20} aria-hidden="true" />
          <span>{formatMessage({ id: "artifacts.comments.images.unavailable" })}</span>
        </span>
      ) : (
        <MessageImageGalleryOverlay>
          <Spinner size="md" aria-label={formatMessage({ id: "common.loadingLabel" })} />
        </MessageImageGalleryOverlay>
      )}
      {view.status === "ok" ? (
        <MessageImageGalleryPreview
          onClick={open}
          aria-label={formatMessage({ id: "artifacts.comments.images.open" }, { index: index + 1, count })}
          data-testid="artifact-comment-image-open"
        />
      ) : view.status === "failed" ? (
        // The button that reads it again is the gallery's press layer, with its hover and focus ring (not one of ours).
        <MessageImageGalleryPreview
          onClick={onReload}
          aria-label={formatMessage({ id: "artifacts.comments.images.reload" }, { index: index + 1, count })}
          data-testid="artifact-comment-image-reload"
        />
      ) : null}
    </MessageImageGalleryItem>
  );
}
