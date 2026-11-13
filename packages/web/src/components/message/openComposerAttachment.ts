import type { MessageAttachment } from "../../store/messageStore";
import { useImageLightboxStore } from "../../store/imageLightboxStore";
import type { ForwardedBundleAttachmentSnapshot } from "./ForwardedBundleCard";
import { isPreviewableImageAttachment } from "./urlImageFallback";
import {
  isAudioPreviewAttachment as isPreviewableAudioAttachment,
  isDocumentPreviewAttachment as isPreviewableDocumentAttachment,
  isVideoPreviewAttachment as isPreviewableVideoAttachment, isHtmlPreviewAttachment
} from "./attachmentPreview";
import { openMediaPreview } from "./openMediaPreview";
import { openDocumentPreview } from "./openDocumentPreview";
import { downloadAttachmentById } from "./downloadAttachment";

/** An attachment of the Forward dialog's bundle preview, opened as the chat body opens it. */
export function openComposerAttachment(snapshot: ForwardedBundleAttachmentSnapshot) {
  if (!snapshot.id) return;
  const attachment: MessageAttachment = {
    id: snapshot.id,
    filename: snapshot.filename,
    mimeType: snapshot.mimeType || "application/octet-stream",
    sizeBytes: snapshot.sizeBytes ?? 0,
    width: snapshot.width ?? null,
    height: snapshot.height ?? null,
    thumbnailUrl: null,
    rasterPreviewUrl: null,
    localPreviewUrl: null,
  };
  if (isPreviewableImageAttachment(attachment)) {
    useImageLightboxStore.getState().open([attachment], 0);
    return;
  }
  // html / video / audio open the same shared previews the chat body uses.
  if (isHtmlPreviewAttachment(attachment)) {
    void openMediaPreview("html", attachment);
    return;
  }
  if (isPreviewableVideoAttachment(attachment)) {
    void openMediaPreview("video", attachment);
    return;
  }
  if (isPreviewableAudioAttachment(attachment)) {
    void openMediaPreview("audio", attachment);
    return;
  }
  if (isPreviewableDocumentAttachment(attachment)) {
    // No commentContext on purpose: a forward preview shows a snapshot, not
    // the original message, so there is no host to attribute comments to.
    void openDocumentPreview(attachment, { onFallbackDownload: downloadAttachmentById });
    return;
  }
  void downloadAttachmentById(attachment);
}
