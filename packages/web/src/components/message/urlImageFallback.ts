import type { MessageAttachment } from "../../store/messageStore";
import { isHeicImageMimeType, normalizeImageMimeType } from "../../utils/imageMimeTypes";

type ImageGalleryPreviewSource = Pick<MessageAttachment, "id" | "localPreviewUrl" | "thumbnailUrl" | "rasterPreviewUrl">;

export function isPreviewableImageAttachment(att: MessageAttachment): boolean {
  const mimeType = normalizeImageMimeType(att.mimeType);
  if (mimeType === "image/svg+xml") {
    return Boolean(att.thumbnailUrl || att.rasterPreviewUrl);
  }
  // HEIC/HEIF previews only through a raster the browser can decode: the
  // server thumbnail, or a local preview the composer already decoded. The raw
  // file is never an inline source (broken image outside Safari), so without
  // one it is a file card.
  if (isHeicImageMimeType(mimeType)) {
    return Boolean(att.thumbnailUrl || att.rasterPreviewUrl || att.localPreviewUrl);
  }
  return mimeType.startsWith("image/");
}

export function isOptimisticAttachment(att: Pick<MessageAttachment, "id">): boolean {
  return att.id.startsWith("optimistic-att-");
}

export function shouldFetchImageInlineFallback(
  att: Pick<MessageAttachment, "localPreviewUrl" | "thumbnailUrl" | "rasterPreviewUrl">,
): boolean {
  return !att.localPreviewUrl && !att.thumbnailUrl && !att.rasterPreviewUrl;
}

export function buildImageInlineFallbackKey(
  attachments: readonly MessageAttachment[] | null | undefined,
): string {
  return (attachments ?? [])
    .filter((att) =>
      isPreviewableImageAttachment(att) &&
      !isOptimisticAttachment(att) &&
      shouldFetchImageInlineFallback(att)
    )
    .map((att) => att.id)
    .join("|");
}

export function splitImageInlineFallbackKey(key: string): string[] {
  return key ? key.split("|") : [];
}

export function getImageGalleryPreviewSrc(
  att: ImageGalleryPreviewSource,
  fallbackUrls: Record<string, string>,
): string | undefined {
  return att.localPreviewUrl || att.thumbnailUrl || att.rasterPreviewUrl || fallbackUrls[att.id];
}

export function shouldRenderImageAsAttachmentChip(
  att: ImageGalleryPreviewSource,
  fallbackUrls: Record<string, string>,
): boolean {
  return !getImageGalleryPreviewSrc(att, fallbackUrls);
}

export function retainImageInlineFallbackUrls(
  current: Record<string, string>,
  attachmentIds: readonly string[],
): Record<string, string> {
  const next: Record<string, string> = {};
  for (const id of attachmentIds) {
    if (current[id]) next[id] = current[id];
  }
  return Object.keys(next).length === Object.keys(current).length ? current : next;
}

export function setImageInlineFallbackUrl(
  current: Record<string, string>,
  attachmentId: string,
  url: string,
): Record<string, string> {
  return current[attachmentId] === url ? current : { ...current, [attachmentId]: url };
}

export function removeImageInlineFallbackUrl(
  current: Record<string, string>,
  attachmentId: string,
): Record<string, string> {
  if (!current[attachmentId]) return current;
  const { [attachmentId]: _removed, ...next } = current;
  return next;
}
