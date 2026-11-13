import assert from "node:assert/strict";
import { buildMessageImageGalleryRows } from "@botiverse/raft-ui";
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

test("the migrated builder produces the same rows slock pinned before the port", () => {
  // Same inputs as the pre-migration suite: the delegation must not change
  // any rowing result.
  const rows = buildMessageImageGalleryRows([
    { width: 800, height: 600 },
    { width: 300, height: 600 },
    { width: 1000, height: 200 },
    { width: 400, height: 400 },
  ]);
  assert.deepEqual(rows, [
    {
      items: [
        { index: 0, fit: "cover" },
        { index: 1, fit: "contain" },
      ],
    },
    { items: [{ index: 2, fit: "contain" }] },
    { items: [{ index: 3, fit: "cover" }] },
  ]);
  assert.deepEqual(buildMessageImageGalleryRows([{ width: 800, height: 600 }]), [
    {
      items: [
        { index: 0, fit: "contain", reserved: { width: "min(384px, 100%)", aspectRatio: "800 / 600" } },
      ],
    },
  ]);
});

test("sent image attachments with preserved local previews are no longer optimistic", () => {
  assert.equal(isOptimisticAttachment(imageAttachment({ id: "optimistic-att-5" })), true);
  assert.equal(isOptimisticAttachment(imageAttachment({ id: "att-5", localPreviewUrl: "blob:local" })), false);
});

test("HEIC previews inline only through a raster, never by fetching the raw file", () => {
  // Raw HEIC does not decode outside Safari: without a server thumbnail (or a
  // local preview the composer already decoded) it is a file card.
  const heic = (overrides: Partial<MessageAttachment> = {}) => imageAttachment({ filename: "IMG_3535.heic", mimeType: "image/heic", ...overrides });
  assert.equal(isPreviewableImageAttachment(heic()), false);
  assert.equal(isPreviewableImageAttachment(heic({ mimeType: "IMAGE/HEIF; x=y" })), false);
  assert.equal(isPreviewableImageAttachment(heic({ thumbnailUrl: "/thumb.webp" })), true);
  assert.equal(isPreviewableImageAttachment(heic({ localPreviewUrl: "blob:decoded" })), true);
  assert.equal(buildImageInlineFallbackKey([heic({ id: "att-heic" })]), "", "no raw-URL fetch for HEIC");
});

test("image attachments without thumbnails fetch an inline URL for direct gallery rendering", () => {
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
});
