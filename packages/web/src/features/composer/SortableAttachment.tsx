import { useMemo } from "react";
import { ComposerAttachment } from "@botiverse/raft-ui";
import { useSortable } from "@dnd-kit/sortable";
import { CSS } from "@dnd-kit/utilities";
import { AttachmentChipBody } from "./AttachmentChipBody";
import type { PendingFile } from "./composerTypes";

/**
 * A pending attachment chip that can be dragged to reorder: the sortable shell (its node, transform and attributes)
 * around the memoized chip (AttachmentChipBody), so a drag renders only this shell.
 */
export function SortableAttachment({
  id,
  preview,
  fileName,
  mimeType,
  uploadStatus,
  uploadProgress,
  attachmentId,
  failedReason,
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
  /** Why a failed file isn't attached: the short line on its cover and the whole reason. */
  failedReason?: { label: string; detail: string };
  onRemove: (pendingId: string) => void;
  onPreview?: (attachmentId: string) => void;
  onPreviewError: (pendingId: string, src: string) => void;
}) {
  const { attributes, listeners, setNodeRef, transform, transition, isDragging } = useSortable({ id });
  const style = useMemo(() => ({
    transform: CSS.Transform.toString(transform),
    transition,
    opacity: isDragging ? 0.5 : 1,
    zIndex: isDragging ? "var(--z-index-raised)" : undefined,
  }), [transform, transition, isDragging]);
  return (
    <ComposerAttachment ref={setNodeRef} style={style} {...attributes}>
      <AttachmentChipBody
        id={id}
        preview={preview}
        fileName={fileName}
        mimeType={mimeType}
        uploadStatus={uploadStatus}
        uploadProgress={uploadProgress}
        attachmentId={attachmentId}
        failedLabel={failedReason?.label}
        failedDetail={failedReason?.detail}
        listeners={listeners}
        onRemove={onRemove}
        onPreview={onPreview}
        onPreviewError={onPreviewError}
      />
    </ComposerAttachment>
  );
}
