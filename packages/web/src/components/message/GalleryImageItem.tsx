import { useCallback, useState } from "react";
import { useIntl } from "react-intl";
import { Download, ImageOff } from "lucide-react";
import {
  MessageImageGalleryAction,
  MessageImageGalleryItem,
  MessageImageGalleryOverlay,
  MessageImageGalleryPreview,
  Spinner,
} from "@botiverse/raft-ui";
import type { MessageImageGalleryItemLayout } from "@botiverse/raft-ui";
import Tooltip from "../ui/Tooltip";
import type { Message } from "../../store/messageStore";
import { useImageLightboxStore } from "../../store/imageLightboxStore";

/** Image-gallery tile — owns its open/download closures so the gallery map
    passes only stable references (task #709 react-perf). */
export function GalleryImageItem({
  att,
  previewSrc,
  isOptimistic,
  imageIndex,
  lightboxImages,
  layout,
  onDownload,
}: {
  att: NonNullable<Message["attachments"]>[number];
  previewSrc: string;
  isOptimistic: boolean;
  imageIndex: number;
  lightboxImages: NonNullable<Message["attachments"]>[number][];
  layout: MessageImageGalleryItemLayout;
  onDownload: (attachment: NonNullable<Message["attachments"]>[number]) => void | Promise<void>;
}) {
  const { formatMessage } = useIntl();
  const handleOpenImage = useCallback(() => {
    if (!isOptimistic && imageIndex >= 0) {
      // Image comments are descoped for now (cindyz 6/11): no comment
      // contexts → the lightbox renders no comment affordance.
      useImageLightboxStore.getState().open(lightboxImages, imageIndex);
    }
  }, [isOptimistic, imageIndex, lightboxImages]);
  // A source that fails to load (a dead thumbnail URL, a format this browser
  // can't decode) shows a placeholder, never a broken-image glyph. The tile
  // stays: opening it lets the lightbox fall back to the full image.
  const [failedSrc, setFailedSrc] = useState<string | null>(null);
  const previewFailed = failedSrc === previewSrc;
  const handlePreviewError = useCallback(() => setFailedSrc(previewSrc), [previewSrc]);
  const handleDownloadImage = useCallback((event: React.MouseEvent<HTMLButtonElement>) => {
    event.preventDefault();
    event.stopPropagation();
    void onDownload(att);
  }, [onDownload, att]);
  return (
    <Tooltip content={att.filename}>
    <MessageImageGalleryItem layout={layout}>
      {previewFailed ? (
        <span
          data-testid="gallery-image-placeholder"
          className="flex size-full items-center justify-center bg-fill-muted text-foreground-hint"
        >
          <ImageOff size={20} aria-hidden="true" />
        </span>
      ) : (
      <img
        src={previewSrc}
        alt={att.filename}
        data-select-screenshot-attachment-id={att.id}
        data-select-screenshot-attachment-width={att.width ?? undefined}
        data-select-screenshot-attachment-height={att.height ?? undefined}
        width={att.width ?? undefined}
        height={att.height ?? undefined}
        loading="lazy"
        onError={handlePreviewError}
      />
      )}
      {isOptimistic && (
        <MessageImageGalleryOverlay>
          <Spinner size="md" aria-label={formatMessage({ id: "common.loadingLabel" })} />
        </MessageImageGalleryOverlay>
      )}
      {!isOptimistic && (
        <MessageImageGalleryPreview
          onClick={handleOpenImage}
          aria-label={formatMessage({ id: "message.messageItem.previewFile" }, { filename: att.filename })}
        />
      )}
      {!isOptimistic && (
        <MessageImageGalleryAction
          onClick={handleDownloadImage}
          data-message-affordance="image-download"
          aria-label={formatMessage({ id: "message.messageItem.downloadFile" }, { filename: att.filename })}
        >
          <Download size={12} />
        </MessageImageGalleryAction>
      )}
    </MessageImageGalleryItem>
    </Tooltip>
  );
}
