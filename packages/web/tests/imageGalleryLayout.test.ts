import assert from "node:assert/strict";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import test from "node:test";
import {
  buildImageInlineFallbackKey,
  getImageGalleryPreviewSrc,
  isOptimisticAttachment,
  isPreviewableImageAttachment,
  removeImageInlineFallbackUrl,
  retainImageInlineFallbackUrls,
  setImageInlineFallbackUrl,
  shouldFetchImageInlineFallback,
  shouldRenderImageAsAttachmentChip,
  splitImageInlineFallbackKey,
} from "../src/components/message/urlImageFallback";
import type { MessageAttachment } from "../src/store/messageStore";

const repoRoot = resolve(import.meta.dirname, "..");
const srcRoot = resolve(repoRoot, "src");

function strykerBackupSrc(): string | null {
  const tmp = resolve(repoRoot, ".stryker-tmp");
  if (!existsSync(tmp)) return null;
  const backup = readdirSync(tmp).find((entry) => entry.startsWith("backup-"));
  return backup ? resolve(tmp, backup, "src") : null;
}

function readSource(path: string): string {
  const sourcePath = path.replace(/^src\//, "");
  const backupSrc = strykerBackupSrc();
  const backupPath = backupSrc ? resolve(backupSrc, sourcePath) : null;
  return readFileSync(backupPath && existsSync(backupPath) ? backupPath : resolve(srcRoot, sourcePath), "utf8");
}

const source = readSource("components/message/MessageItem.tsx");
const fallbackSource = readSource("components/message/urlImageFallback.ts");
const inputSource = readSource("components/message/MessageInput.tsx");
const messageStoreSource = readSource("store/messageStore.ts");

function imageAttachment(overrides: Partial<MessageAttachment> = {}): MessageAttachment {
  return {
    id: "att-1",
    filename: "image.png",
    mimeType: "image/png",
    sizeBytes: 12,
    localPreviewUrl: null,
    thumbnailUrl: null,
    rasterPreviewUrl: null,
    ...overrides,
  };
}

test("image gallery layout is ratio-aware instead of count-only", () => {
  assert.match(source, /export function classifyImageAspect/);
  assert.match(source, /ratio >= 2\.2/);
  assert.match(source, /ratio <= 0\.55/);
  assert.match(source, /export function buildImageGalleryRows/);
  assert.match(source, /classifyImageAspect\(attachment\) === "wide"[\s\S]*?pushBufferedRows\(\)/);
  assert.match(source, /getImageGalleryFitClass\(att\)/);
  assert.match(source, /inline-block w-fit max-w-\[26rem\] justify-self-start/);
  assert.doesNotMatch(source, /function getImageGalleryGridClass/);
});

test("single image gallery reserves aspect-ratio space before the image loads", () => {
  assert.match(source, /const SINGLE_IMAGE_MAX_WIDTH = 416;/);
  assert.match(source, /const SINGLE_IMAGE_MAX_HEIGHT = 288;/);
  assert.match(source, /function getSingleImageReserveStyle\(att: MessageImageAttachment\)/);
  assert.match(source, /return \{ width: "min\(11rem, 100%\)", aspectRatio: "4 \/ 3" \};/);
  assert.match(source, /const scale = Math\.min\(SINGLE_IMAGE_MAX_WIDTH \/ att\.width, SINGLE_IMAGE_MAX_HEIGHT \/ att\.height, 1\);/);
  assert.match(source, /const imageReserveStyle = isSingleImage \? getSingleImageReserveStyle\(att\) : undefined;/);
  assert.match(source, /style=\{imageReserveStyle\}/);
  assert.match(source, /width=\{att\.width \?\? undefined\}/);
  assert.match(source, /height=\{att\.height \?\? undefined\}/);
  assert.match(source, /bg-brutal-cream\/60/);
  assert.doesNotMatch(source, /border-2 border-black bg-transparent/);
});

test("optimistic image attachments carry local dimensions when available", () => {
  assert.match(inputSource, /previewWidth\?: number;/);
  assert.match(inputSource, /previewHeight\?: number;/);
  assert.match(inputSource, /function readLocalImageDimensions\(previewUrl: string\)/);
  assert.match(inputSource, /const width = image\.naturalWidth;/);
  assert.match(inputSource, /const height = image\.naturalHeight;/);
  assert.match(inputSource, /readLocalImageDimensions\(pending\.preview\)/);
  assert.match(inputSource, /previewWidth: dimensions\.width/);
  assert.match(inputSource, /previewHeight: dimensions\.height/);
  assert.match(inputSource, /width: pf\.previewWidth \?\? null/);
  assert.match(inputSource, /height: pf\.previewHeight \?\? null/);
});

test("sent image attachments keep local previews across optimistic handoff", () => {
  assert.match(messageStoreSource, /function mergeOptimisticAttachmentPreviews/);
  assert.match(messageStoreSource, /localPreviewUrl: attachment\.localPreviewUrl \?\? local\.localPreviewUrl/);
  assert.match(messageStoreSource, /width: attachment\.width \?\? local\.width \?\? null/);
  assert.match(messageStoreSource, /height: attachment\.height \?\? local\.height \?\? null/);

  const submitStart = inputSource.indexOf("const handleSubmit = async");
  const catchStart = inputSource.indexOf("} catch (err) {", submitStart);
  assert.notEqual(submitStart, -1, "handleSubmit not found");
  assert.notEqual(catchStart, -1, "handleSubmit catch block not found");
  const successfulSubmitPath = inputSource.slice(submitStart, catchStart);
  assert.doesNotMatch(successfulSubmitPath, /URL\.revokeObjectURL/);
});

test("sent image attachments with preserved local previews are no longer optimistic", () => {
  assert.match(fallbackSource, /export function isOptimisticAttachment\(att: Pick<MessageAttachment, "id">\): boolean \{/);
  assert.match(fallbackSource, /return att\.id\.startsWith\("optimistic-att-"\);/);
  assert.equal(isOptimisticAttachment(imageAttachment({ id: "optimistic-att-5" })), true);
  assert.equal(isOptimisticAttachment(imageAttachment({ id: "att-5", localPreviewUrl: "blob:local" })), false);
  assert.match(source, /from "\.\/urlImageFallback";/);
  assert.match(source, /const lightboxImages = imageAttachments\.filter\(\(att\) => !isOptimisticAttachment\(att\)\)/);
  assert.match(source, /const isOptimistic = isOptimisticAttachment\(att\);/);
  assert.doesNotMatch(source, /const isOptimistic = !!att\.localPreviewUrl/);
});

test("image attachments without thumbnails still open the lightbox fallback", () => {
  assert.match(source, /const lightboxImages = imageAttachments\.filter\(\(att\) => !isOptimisticAttachment\(att\)\)/);
  // open() gained a third arg (per-attachment comment contexts, task #10);
  // the contract is the index fallback, not the exact arity.
  assert.match(source, /if \(isImage && !isOptimistic\) \{[\s\S]*?useImageLightboxStore\.getState\(\)\.open\([\s\S]{0,160}?imageIndex >= 0 \? imageIndex : 0/);
});

test("image attachments without thumbnails fetch an inline URL for direct gallery rendering", () => {
  assert.match(source, /const imageFallbackKey = useMemo/);
  assert.equal(isPreviewableImageAttachment(imageAttachment({ mimeType: " IMAGE/PNG ; charset=utf-8" })), true);
  assert.equal(isPreviewableImageAttachment(imageAttachment({ mimeType: "text/plain" })), false);
  assert.equal(isPreviewableImageAttachment(imageAttachment({
    mimeType: "image/svg+xml",
    thumbnailUrl: "/thumb.png",
    rasterPreviewUrl: "/raster.png",
  })), true);
  assert.equal(isPreviewableImageAttachment(imageAttachment({
    mimeType: "image/svg+xml",
    thumbnailUrl: "/thumb.png",
    rasterPreviewUrl: null,
  })), true);
  assert.equal(isPreviewableImageAttachment(imageAttachment({
    mimeType: "image/svg+xml",
    thumbnailUrl: null,
    rasterPreviewUrl: "/raster.png",
  })), true);
  assert.equal(shouldFetchImageInlineFallback({ localPreviewUrl: null, thumbnailUrl: null, rasterPreviewUrl: null }), true);
  assert.equal(shouldFetchImageInlineFallback({ localPreviewUrl: "blob:local", thumbnailUrl: null, rasterPreviewUrl: null }), false);
  assert.equal(shouldFetchImageInlineFallback({ localPreviewUrl: null, thumbnailUrl: "/thumb.png", rasterPreviewUrl: null }), false);
  assert.equal(shouldFetchImageInlineFallback({ localPreviewUrl: null, thumbnailUrl: null, rasterPreviewUrl: "/raster.png" }), false);

  assert.equal(buildImageInlineFallbackKey(undefined), "");
  assert.equal(buildImageInlineFallbackKey([
    imageAttachment({ id: "att-1" }),
    imageAttachment({ id: "att-2", filename: "notes.txt", mimeType: "text/plain" }),
    imageAttachment({ id: "att-3", localPreviewUrl: "blob:local" }),
    imageAttachment({ id: "att-4", thumbnailUrl: "/thumb.png" }),
    imageAttachment({ id: "optimistic-att-5" }),
    imageAttachment({ id: "att-6", mimeType: "image/jpeg; charset=utf-8" }),
  ]), "att-1|att-6");
  assert.deepEqual(splitImageInlineFallbackKey("att-1|att-6"), ["att-1", "att-6"]);
  assert.deepEqual(splitImageInlineFallbackKey(""), []);
  assert.match(source, /buildImageInlineFallbackKey\(message\.attachments\)/);
  assert.match(fallbackSource, /shouldFetchImageInlineFallback\(att\)/);
  // The inline URL fetch moved into a shared cache so the same attachment is
  // requested once instead of once per rendered tile (an attachment-dense
  // channel was tripping the 120/min download limiter and rendering broken
  // images). The gallery must route through it; the URL lives in the cache.
  assert.match(source, /fetchInlineAttachmentUrls\(attachmentIds\)/);
  assert.match(
    readFileSync(resolve(repoRoot, "src/components/message/inlineAttachmentUrlCache.ts"), "utf8"),
    /`\/attachments\/\$\{attachmentId\}\/url\?disposition=inline`/,
  );

  assert.equal(getImageGalleryPreviewSrc({
    id: "att-1",
    localPreviewUrl: "blob:local",
    thumbnailUrl: "/thumb.png",
    rasterPreviewUrl: "/raster.png",
  }, { "att-1": "/inline.png" }), "blob:local");
  assert.equal(getImageGalleryPreviewSrc({
    id: "att-1",
    localPreviewUrl: null,
    thumbnailUrl: "/thumb.png",
    rasterPreviewUrl: "/raster.png",
  }, { "att-1": "/inline.png" }), "/thumb.png");
  assert.equal(getImageGalleryPreviewSrc({
    id: "att-1",
    localPreviewUrl: null,
    thumbnailUrl: null,
    rasterPreviewUrl: "/raster.png",
  }, { "att-1": "/inline.png" }), "/raster.png");
  assert.equal(getImageGalleryPreviewSrc({
    id: "att-1",
    localPreviewUrl: null,
    thumbnailUrl: null,
    rasterPreviewUrl: null,
  }, { "att-1": "/inline.png" }), "/inline.png");
  assert.equal(getImageGalleryPreviewSrc({
    id: "att-2",
    localPreviewUrl: null,
    thumbnailUrl: null,
    rasterPreviewUrl: null,
  }, { "att-1": "/inline.png" }), undefined);
  assert.match(source, /getImageGalleryPreviewSrc\(att, imageFallbackUrls\)/);

  assert.equal(shouldRenderImageAsAttachmentChip({
    id: "att-1",
    localPreviewUrl: null,
    thumbnailUrl: null,
    rasterPreviewUrl: null,
  }, { "att-1": "/inline.png" }), false);
  assert.equal(shouldRenderImageAsAttachmentChip({
    id: "att-2",
    localPreviewUrl: null,
    thumbnailUrl: null,
    rasterPreviewUrl: null,
  }, { "att-1": "/inline.png" }), true);

  const retained = retainImageInlineFallbackUrls({ "att-1": "/inline.png", "old-att": "/old.png" }, ["att-1", "att-2"]);
  assert.deepEqual(retained, { "att-1": "/inline.png" });
  const unchanged = { "att-1": "/inline.png" };
  assert.equal(retainImageInlineFallbackUrls(unchanged, ["att-1"]), unchanged);
  assert.equal(setImageInlineFallbackUrl(unchanged, "att-1", "/inline.png"), unchanged);
  assert.deepEqual(setImageInlineFallbackUrl(unchanged, "att-2", "/second.png"), {
    "att-1": "/inline.png",
    "att-2": "/second.png",
  });
  assert.equal(removeImageInlineFallbackUrl(unchanged, "missing-att"), unchanged);
  assert.deepEqual(removeImageInlineFallbackUrl({
    "att-1": "/inline.png",
    "att-2": "/second.png",
  }, "att-1"), { "att-2": "/second.png" });
  assert.match(source, /shouldRenderImageAsAttachmentChip\(att, imageFallbackUrls\)/);
});

test("image gallery download affordance does not reuse the lightbox preview hit target", () => {
  const galleryStart = source.indexOf("const handleDownloadImage");
  const galleryEnd = source.indexOf("{videoAttachments.length > 0", galleryStart);
  assert.notEqual(galleryStart, -1, "thumbnail download handler not found");
  assert.notEqual(galleryEnd, -1, "image gallery block end not found");
  const gallerySource = source.slice(galleryStart, galleryEnd);

  assert.match(gallerySource, /event\.preventDefault\(\);/);
  assert.match(gallerySource, /event\.stopPropagation\(\);/);
  assert.match(gallerySource, /void handleDownloadAttachment\(att\);/);
  // aria labels migrated to react-intl (message.messageItem.previewFile/downloadFile).
  assert.match(gallerySource, /aria-label=\{formatMessage\(\{ id: "message\.messageItem\.previewFile" \}, \{ filename: att\.filename \}\)\}/);
  assert.match(gallerySource, /data-message-affordance="image-download"/);
  assert.match(gallerySource, /aria-label=\{formatMessage\(\{ id: "message\.messageItem\.downloadFile" \}, \{ filename: att\.filename \}\)\}/);
  assert.doesNotMatch(gallerySource, /<span[\s\S]{0,160}?data-message-affordance="image-download"/);
});
