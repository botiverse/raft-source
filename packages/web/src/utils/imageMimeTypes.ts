/** MIME essence: lowercased, parameters stripped. Empty when unknown. */
export function normalizeImageMimeType(mimeType: string | null | undefined): string {
  return mimeType?.split(";")[0]?.trim().toLowerCase() ?? "";
}

// HEIC/HEIF is the iPhone camera default. Only Safari decodes it in <img>;
// Chrome, Firefox and Edge show a broken image. The server rasterizes it to a
// WebP thumbnail on upload (packages/server/src/routes/attachments.ts
// generateThumbnail), so that thumbnail is the only portable inline source.
const HEIC_IMAGE_MIME_TYPES = new Set([
  "image/heic",
  "image/heif",
  "image/heic-sequence",
  "image/heif-sequence",
]);

export function isHeicImageMimeType(mimeType: string | null | undefined): boolean {
  return HEIC_IMAGE_MIME_TYPES.has(normalizeImageMimeType(mimeType));
}

// Raster formats every supported browser decodes in <img>. Mirrors the
// server's thumbnail allowlist. Anything else under image/* (HEIC, TIFF, ...)
// may or may not decode depending on the browser.
const WEB_SAFE_IMAGE_MIME_TYPES = new Set(["image/jpeg", "image/png", "image/gif", "image/webp"]);

export function isWebSafeImageMimeType(mimeType: string | null | undefined): boolean {
  return WEB_SAFE_IMAGE_MIME_TYPES.has(normalizeImageMimeType(mimeType));
}
