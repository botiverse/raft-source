import type { PreparedAttachmentFile } from "../../utils/attachmentImageResize";
import { isWebSafeImageMimeType } from "../../utils/imageMimeTypes";
import type { PendingFile } from "./composerTypes";

export function isPreviewableImageFile(file: File): boolean {
  const mimeType = file.type.split(";")[0]?.trim().toLowerCase();
  return !!mimeType && mimeType.startsWith("image/") && mimeType !== "image/svg+xml";
}
/**
 * The local object URL, if the browser can show it. JPEG/PNG/GIF/WebP render
 * immediately; any other image type (HEIC outside Safari, TIFF, ...) waits for
 * a successful decode so an undecodable file never paints a broken image.
 */
export function getPendingFileLocalPreview(pf: PendingFile): string | null {
  if (!pf.preview || pf.failedPreviewSrcs?.includes(pf.preview)) return null;
  if (!pf.previewDecoded && !isWebSafeImageMimeType(pf.file.type)) return null;
  return pf.preview;
}
/** What the composer chip shows: the local preview, else the server thumbnail, else the file tile. */
export function getPendingFileDisplayPreview(pf: PendingFile): string | null {
  const local = getPendingFileLocalPreview(pf);
  if (local) return local;
  const thumbnail = pf.serverThumbnailUrl;
  return thumbnail && !pf.failedPreviewSrcs?.includes(thumbnail) ? thumbnail : null;
}
type LocalImageProbe =
  | { decoded: true; width: number; height: number }
  | { decoded: false };
/** Decode the local preview once: its size, or whether this browser cannot show it at all. */
export function readLocalImageDimensions(previewUrl: string): Promise<LocalImageProbe> {
  return new Promise((resolve) => {
    const image = new Image();
    image.onload = () => {
      const width = image.naturalWidth;
      const height = image.naturalHeight;
      resolve(width > 0 && height > 0 ? { decoded: true, width, height } : { decoded: false });
    };
    image.onerror = () => resolve({ decoded: false });
    image.src = previewUrl;
  });
}
/**
 * The chip once a large photo was resized before upload (attachmentImageResize.ts):
 * its file, size, local preview and dimensions describe what is actually sent,
 * not the original that was picked.
 */
export function pendingFileWithResizedUpload(pf: PendingFile, prepared: PreparedAttachmentFile, preview: string | null): PendingFile {
  const dimensions = preview && prepared.width && prepared.height
    ? { previewDecoded: true, previewWidth: prepared.width, previewHeight: prepared.height }
    : {};
  return { ...pf, file: prepared.file, preview, ...dimensions };
}
