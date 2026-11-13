import { memo, useCallback } from "react";
import type { KeyboardEvent } from "react";
import { useIntl } from "react-intl";
import { X, FileText, Image as ImageIcon } from "lucide-react";
import { ComposerAttachmentBody, ComposerAttachmentFailedOverlay, ComposerAttachmentFile, ComposerAttachmentImage, ComposerAttachmentMeta, ComposerAttachmentRemove, ComposerAttachmentTitle, ComposerAttachmentUploadingOverlay, ComposerAttachmentUploadProgressBar, Spinner } from "@botiverse/raft-ui";
import type { DraggableSyntheticListeners } from "@dnd-kit/core";
import Tooltip from "../../components/ui/Tooltip";
import { transparentImageBackgroundClass } from "../../utils/imagePreviewStyles";
import type { PendingFile } from "./composerTypes";

/**
 * What a pending attachment chip shows inside its sortable shell (SortableAttachment): the drag handle with the image
 * or file tile, the upload covers and Remove. Memoized: the shell renders on every pointer move while it is dragged
 * and on every change of the chip under the pointer; this renders only when the file does.
 */
export const AttachmentChipBody = memo(function AttachmentChipBody({
  id,
  preview,
  fileName,
  mimeType,
  uploadStatus,
  uploadProgress,
  attachmentId,
  failedLabel,
  failedDetail,
  listeners,
  onRemove,
  onPreview,
  onPreviewError,
}: {
  id: string;
  preview: string | null;
  fileName: string;
  mimeType: string;
  uploadStatus: PendingFile["uploadStatus"];
  uploadProgress: number;
  attachmentId: string | null;
  /** Why a failed file isn't attached: the short line on its cover, and the whole reason. */
  failedLabel?: string;
  failedDetail?: string;
  /** dnd-kit's listeners, for the drag handle (the same object through a drag). */
  listeners: DraggableSyntheticListeners;
  onRemove: (pendingId: string) => void;
  onPreview?: (attachmentId: string) => void;
  onPreviewError: (pendingId: string, src: string) => void;
}) {
  const { formatMessage } = useIntl();
  const failedReason = failedLabel !== undefined && failedDetail !== undefined ? { label: failedLabel, detail: failedDetail } : undefined;
  const handleRemove = useCallback(() => onRemove(id), [onRemove, id]);
  const handlePreview = useCallback(() => {
    if (attachmentId && onPreview) onPreview(attachmentId);
  }, [onPreview, attachmentId]);
  const handlePreviewKey = useCallback((e: KeyboardEvent<HTMLDivElement>) => {
    if (!preview || !onPreview) return;
    if (e.key === "Enter" || e.key === " ") {
      e.preventDefault();
      handlePreview();
    }
  }, [handlePreview, onPreview, preview]);
  // A preview the browser cannot decode falls back to the file tile (or the
  // next source) instead of a broken-image glyph.
  const handlePreviewError = useCallback(() => {
    if (preview) onPreviewError(id, preview);
  }, [onPreviewError, id, preview]);
  return (
    <>
      {/* Drag handle: the chip body itself. Spreading dnd-kit's
          {...listeners} ONLY here (not on the outer container) keeps
          the Remove button outside the drag handle, so taps on the
          ✕ never get captured by PointerSensor's native pointerdown
          listener. Without this split, on touch devices the parent
          element owned both the drag region and the button area —
          dnd-kit attaches NATIVE pointerdown listeners (not React),
          which `e.stopPropagation()` on a React synthetic onClick
          can't preempt; the X tap got swallowed and onRemove never
          fired. tygg #proj-mobile task #8. */}
      <Tooltip content={preview && onPreview ? formatMessage({ id: "message.composer.previewImage" }) : undefined}>
      <div
        {...listeners}
        role={preview && onPreview ? "button" : undefined}
        tabIndex={preview && onPreview ? 0 : undefined}
        onClick={preview && onPreview ? handlePreview : undefined}
        onKeyDown={handlePreviewKey}
        aria-label={preview && onPreview ? formatMessage({ id: "message.composer.previewAttachment" }, { file: fileName }) : undefined}
        className={`${preview ? "size-full " : ""}${preview && onPreview ? "cursor-zoom-in" : "cursor-grab active:cursor-grabbing"}`}
      >
        {/* Image chips: the attachment recipe sizes ComposerAttachmentImage as
            size-full of this body, so the body must fill the fixed 64px
            chip. Left at auto height, a portrait image grew to its natural
            height and spilled over the textarea below (#bug-triage task #11). */}
        {preview ? (
          <ComposerAttachmentImage>
            <img src={preview} alt={fileName} onError={handlePreviewError} className={`size-full object-cover ${transparentImageBackgroundClass}`} />
          </ComposerAttachmentImage>
        ) : (
          <ComposerAttachmentFile>
            {mimeType.startsWith("image/") ? <ImageIcon size={16} aria-hidden /> : <FileText size={16} aria-hidden />}
            <ComposerAttachmentBody>
              <ComposerAttachmentTitle>{fileName}</ComposerAttachmentTitle>
              <ComposerAttachmentMeta>{mimeType || formatMessage({ id: "message.composer.fileFallback" })}</ComposerAttachmentMeta>
            </ComposerAttachmentBody>
          </ComposerAttachmentFile>
        )}
      </div>
      </Tooltip>
      {uploadStatus === "validating" && (
        <ComposerAttachmentUploadingOverlay>
          <Spinner size="sm" className="mb-1" aria-label={formatMessage({ id: "common.loadingLabel" })} />
          <span>{formatMessage({ id: "message.composer.checkingAttachment" })}</span>
        </ComposerAttachmentUploadingOverlay>
      )}
      {uploadStatus === "uploading" && (
        <>
          <ComposerAttachmentUploadingOverlay>
            <Spinner size="sm" className="mb-1" aria-label={formatMessage({ id: "common.loadingLabel" })} />
            <span>
              {uploadProgress >= 99
                ? formatMessage({ id: "message.composer.finishingUpload" })
                : uploadProgress > 0
                  ? `${uploadProgress}%`
                  : formatMessage({ id: "message.composer.uploading" })}
            </span>
          </ComposerAttachmentUploadingOverlay>
          <ComposerAttachmentUploadProgressBar value={uploadProgress} />
        </>
      )}
      {uploadStatus === "error" && (failedReason ? (
        // The cover lies over the file, so the whole reason is the tooltip of
        // what fills it (a trigger of its own: the cover keeps its data-slot).
        <ComposerAttachmentFailedOverlay aria-label={failedReason.detail}>
          <Tooltip content={failedReason.detail}>
            <span className="absolute inset-0 flex items-center justify-center text-center">{failedReason.label}</span>
          </Tooltip>
        </ComposerAttachmentFailedOverlay>
      ) : (
        <ComposerAttachmentFailedOverlay>
          <span>{formatMessage({ id: "message.composer.uploadFailed" })}</span>
        </ComposerAttachmentFailedOverlay>
      ))}
      {/* Remove affordance. The ComposerAttachmentRemove recipe owns the
          chrome: desktop hides it until group hover; touch devices
          (`hover: none`) get an always-visible larger hit area — exactly
          the phones/tablets where a hover-only ✕ disappears. It stays
          OUTSIDE the drag-handle body above so taps reach onRemove. */}
      <ComposerAttachmentRemove
        onClick={handleRemove}
        aria-label={formatMessage({ id: "message.composer.removeAttachment" }, { file: fileName })}
      >
        <X size={10} />
      </ComposerAttachmentRemove>
    </>
  );
});
