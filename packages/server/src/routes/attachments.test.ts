import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "vitest";
import sharp from "sharp";
import {
  buildAttachmentTooLargeResponse,
  buildAttachmentContentLengthHeader,
  buildAttachmentContentDisposition,
  buildAttachmentDownloadContentDisposition,
  buildAttachmentInlinePreviewContentDisposition,
  buildAttachmentInlinePreviewContentSecurityPolicy,
  buildAttachmentResponseContentType,
  buildHtmlPreviewContentSecurityPolicy,
  canGenerateImagePreview,
  generateSvgRasterPreview,
  generateThumbnail,
  getAttachmentFileSizeLimitBytes,
  getLegacyAttachmentFileSizeLimitBytes,
  isEmptyUploadedFile,
  isOversizedUploadedFile,
  MAX_ATTACHMENT_FILE_SIZE_BYTES,
  MAX_PRO_ATTACHMENT_FILE_SIZE_BYTES,
  normalizeAttachmentFilename,
  normalizeUploadedMimeType,
  parseAttachmentByteRange,
  resolveAttachmentMimeType,
} from "./attachments.js";
import { getAttachmentDirectUploadThresholdBytes } from "../services/attachmentUploadPolicy.js";

test("normalizeAttachmentFilename repairs mojibake UTF-8 filenames", () => {
  const original = "这文件里有什么.pdf";
  const mojibake = Buffer.from(original, "utf8").toString("latin1");

  assert.equal(normalizeAttachmentFilename(mojibake), original);
});

test("normalizeAttachmentFilename leaves normal filenames unchanged", () => {
  assert.equal(normalizeAttachmentFilename("report-final.pdf"), "report-final.pdf");
  assert.equal(normalizeAttachmentFilename("café.pdf"), "café.pdf");
});

test("attachment single-file limit stays 50MB for Free and expands to 200MB for Pro", () => {
  const postTrial = new Date("2026-06-23T12:00:00Z");
  assert.equal(getAttachmentFileSizeLimitBytes("free", postTrial), MAX_ATTACHMENT_FILE_SIZE_BYTES);
  assert.equal(getAttachmentFileSizeLimitBytes("pro", postTrial), MAX_PRO_ATTACHMENT_FILE_SIZE_BYTES);
  assert.equal(getAttachmentFileSizeLimitBytes("founder", postTrial), MAX_PRO_ATTACHMENT_FILE_SIZE_BYTES);
  assert.equal(getAttachmentFileSizeLimitBytes("partner", postTrial), MAX_PRO_ATTACHMENT_FILE_SIZE_BYTES);

  assert.equal(isOversizedUploadedFile({ size: MAX_ATTACHMENT_FILE_SIZE_BYTES + 1 }, MAX_ATTACHMENT_FILE_SIZE_BYTES), true);
  assert.equal(isOversizedUploadedFile({ size: MAX_ATTACHMENT_FILE_SIZE_BYTES + 1 }, MAX_PRO_ATTACHMENT_FILE_SIZE_BYTES), false);
  assert.deepEqual(buildAttachmentTooLargeResponse(MAX_PRO_ATTACHMENT_FILE_SIZE_BYTES), {
    error: "Max 200MB per file",
    errorCode: "ATTACHMENT_TOO_LARGE",
    maxBytes: MAX_PRO_ATTACHMENT_FILE_SIZE_BYTES,
  });
});

test("legacy browser uploads ignore the direct-upload threshold and keep their transport safety cap", () => {
  const previous = process.env.ATTACHMENT_DIRECT_UPLOAD_THRESHOLD_BYTES;
  const postTrial = new Date("2026-06-23T12:00:00Z");
  try {
    delete process.env.ATTACHMENT_DIRECT_UPLOAD_THRESHOLD_BYTES;
    assert.equal(getLegacyAttachmentFileSizeLimitBytes("free", postTrial), 50 * 1024 * 1024);
    assert.equal(getLegacyAttachmentFileSizeLimitBytes("pro", postTrial), 90 * 1024 * 1024);

    process.env.ATTACHMENT_DIRECT_UPLOAD_THRESHOLD_BYTES = String(10 * 1024 * 1024);
    assert.equal(getLegacyAttachmentFileSizeLimitBytes("free", postTrial), 50 * 1024 * 1024);
    assert.equal(getLegacyAttachmentFileSizeLimitBytes("pro", postTrial), 90 * 1024 * 1024);
    assert.deepEqual(buildAttachmentTooLargeResponse(90 * 1024 * 1024), {
      error: "Max 90MB per file",
      errorCode: "ATTACHMENT_TOO_LARGE",
      maxBytes: 90 * 1024 * 1024,
    });

    process.env.ATTACHMENT_DIRECT_UPLOAD_THRESHOLD_BYTES = String(200 * 1024 * 1024);
    assert.equal(
      getLegacyAttachmentFileSizeLimitBytes("pro", postTrial),
      90 * 1024 * 1024,
      "raising the direct threshold cannot raise the legacy transport safety cap",
    );
  } finally {
    if (previous === undefined) delete process.env.ATTACHMENT_DIRECT_UPLOAD_THRESHOLD_BYTES;
    else process.env.ATTACHMENT_DIRECT_UPLOAD_THRESHOLD_BYTES = previous;
  }
});

test("buildAttachmentContentDisposition encodes unicode filenames with RFC5987", () => {
  const disposition = buildAttachmentContentDisposition("这文件里有什么.pdf", "application/pdf");

  assert.match(disposition, /^attachment; filename="/);
  assert.match(disposition, /filename\*=UTF-8''/);
  assert.match(disposition, /%E8%BF%99%E6%96%87%E4%BB%B6%E9%87%8C%E6%9C%89%E4%BB%80%E4%B9%88\.pdf/);
});


test("inline preview disposition is limited to PDF, supported media, and images", () => {
  assert.match(buildAttachmentInlinePreviewContentDisposition("paper.pdf", "application/pdf"), /^inline; filename="/);
  assert.match(buildAttachmentInlinePreviewContentDisposition("demo.mp4", "video/mp4"), /^inline; filename="/);
  assert.match(buildAttachmentInlinePreviewContentDisposition("demo.webm", "video/webm"), /^inline; filename="/);
  assert.match(buildAttachmentInlinePreviewContentDisposition("demo.mov", "video/quicktime"), /^inline; filename="/);
  assert.match(buildAttachmentInlinePreviewContentDisposition("voice.mp3", "audio/mpeg"), /^inline; filename="/);
  assert.match(buildAttachmentInlinePreviewContentDisposition("voice", "audio/mp3"), /^inline; filename="/);
  assert.match(buildAttachmentInlinePreviewContentDisposition("voice.wav", "audio/wav"), /^inline; filename="/);
  assert.match(buildAttachmentInlinePreviewContentDisposition("voice.m4a", "audio/mp4"), /^inline; filename="/);
  assert.match(buildAttachmentInlinePreviewContentDisposition("voice.aac", "audio/aac"), /^inline; filename="/);
  assert.match(buildAttachmentInlinePreviewContentDisposition("voice.ogg", "audio/ogg"), /^inline; filename="/);
  assert.match(buildAttachmentInlinePreviewContentDisposition("voice.opus", "audio/opus"), /^inline; filename="/);
  assert.match(buildAttachmentInlinePreviewContentDisposition("voice.weba", "audio/webm"), /^inline; filename="/);
  assert.match(buildAttachmentInlinePreviewContentDisposition("voice.flac", "audio/flac"), /^inline; filename="/);
  assert.match(buildAttachmentInlinePreviewContentDisposition("demo.webm", "application/octet-stream"), /^inline; filename="/);
  assert.match(buildAttachmentInlinePreviewContentDisposition("demo.mov", "application/octet-stream"), /^inline; filename="/);
  assert.match(buildAttachmentInlinePreviewContentDisposition("voice.mp3", "application/octet-stream"), /^inline; filename="/);
  assert.match(buildAttachmentInlinePreviewContentDisposition("voice.wav", "application/octet-stream"), /^inline; filename="/);
  assert.match(buildAttachmentInlinePreviewContentDisposition("voice.m4a", "application/octet-stream"), /^inline; filename="/);
  assert.match(buildAttachmentInlinePreviewContentDisposition("voice.ogg", "application/octet-stream"), /^inline; filename="/);
  assert.match(buildAttachmentInlinePreviewContentDisposition("diagram.html", "text/html"), /^attachment; filename="/);
  assert.match(buildAttachmentInlinePreviewContentDisposition("data.csv", "text/csv"), /^attachment; filename="/);
  assert.match(buildAttachmentInlinePreviewContentDisposition("voice.aiff", "audio/aiff"), /^attachment; filename="/);
  assert.match(buildAttachmentInlinePreviewContentDisposition("diagram.svg", "image/svg+xml"), /^attachment; filename="/);
});

test("resolveAttachmentMimeType recovers supported media from filename", () => {
  assert.equal(resolveAttachmentMimeType("demo.MP4", "application/octet-stream"), "video/mp4");
  assert.equal(resolveAttachmentMimeType("demo.WEBM", "application/octet-stream"), "video/webm");
  assert.equal(resolveAttachmentMimeType("demo.MOV", "application/octet-stream"), "video/quicktime");
  assert.equal(resolveAttachmentMimeType("voice.MP3", "application/octet-stream"), "audio/mpeg");
  assert.equal(resolveAttachmentMimeType("voice.WAV", "application/octet-stream"), "audio/wav");
  assert.equal(resolveAttachmentMimeType("voice.M4A", "application/octet-stream"), "audio/mp4");
  assert.equal(resolveAttachmentMimeType("voice.AAC", "application/octet-stream"), "audio/aac");
  assert.equal(resolveAttachmentMimeType("voice.OGG", "application/octet-stream"), "audio/ogg");
  assert.equal(resolveAttachmentMimeType("voice.OPUS", "application/octet-stream"), "audio/opus");
  assert.equal(resolveAttachmentMimeType("voice.WEBA", "application/octet-stream"), "audio/webm");
  assert.equal(resolveAttachmentMimeType("voice.FLAC", "application/octet-stream"), "audio/flac");
});

test("inline attachment preview CSP only allows configured frame ancestors", () => {
  assert.equal(
    buildAttachmentInlinePreviewContentSecurityPolicy(["https://app.slock.ai"]),
    "frame-ancestors 'self' https://app.slock.ai",
  );
});

test("buildAttachmentResponseContentType appends utf-8 for text-like types", () => {
  assert.equal(buildAttachmentResponseContentType("text/markdown"), "text/markdown; charset=utf-8");
  assert.equal(buildAttachmentResponseContentType("text/html"), "text/html; charset=utf-8");
  assert.equal(buildAttachmentResponseContentType("application/json"), "application/json; charset=utf-8");
  assert.equal(buildAttachmentResponseContentType("application/pdf"), "application/pdf");
});

test("buildAttachmentContentLengthHeader only returns finite non-negative integers", () => {
  assert.equal(buildAttachmentContentLengthHeader(42), "42");
  assert.equal(buildAttachmentContentLengthHeader(42.9), "42");
  assert.equal(buildAttachmentContentLengthHeader(0), "0");
  assert.equal(buildAttachmentContentLengthHeader(-1), undefined);
  assert.equal(buildAttachmentContentLengthHeader(Number.NaN), undefined);
  assert.equal(buildAttachmentContentLengthHeader(undefined), undefined);
  assert.equal(buildAttachmentContentLengthHeader(null), undefined);
});

test("parseAttachmentByteRange supports browser media range requests", () => {
  assert.deepEqual(parseAttachmentByteRange("bytes=0-", 100), { start: 0, end: 99, size: 100 });
  assert.deepEqual(parseAttachmentByteRange("bytes=20-39", 100), { start: 20, end: 39, size: 100 });
  assert.deepEqual(parseAttachmentByteRange("bytes=90-200", 100), { start: 90, end: 99, size: 100 });
  assert.deepEqual(parseAttachmentByteRange("bytes=-10", 100), { start: 90, end: 99, size: 100 });
  assert.equal(parseAttachmentByteRange("bytes=100-120", 100), "unsatisfiable");
  assert.equal(parseAttachmentByteRange("bytes=50-40", 100), "unsatisfiable");
  assert.equal(parseAttachmentByteRange("bytes=0-1,3-4", 100), null);
});

test("resolveAttachmentMimeType recovers legacy HTML rows from filename", () => {
  assert.equal(
    resolveAttachmentMimeType("diagram.HTML", "application/octet-stream"),
    "text/html",
  );
});

test("normal attachment disposition keeps HTML as download-only", () => {
  const disposition = buildAttachmentContentDisposition("diagram.html", "text/html");
  assert.match(disposition, /^attachment; filename="/);
});

test("HTML preview CSP allows external subresources but blocks privileged channels", () => {
  const csp = buildHtmlPreviewContentSecurityPolicy(["https://app.slock.ai"]);
  assert.match(csp, /script-src 'unsafe-inline' https:/);
  assert.match(csp, /style-src 'unsafe-inline' https:/);
  assert.match(csp, /img-src data: blob: https:/);
  assert.match(csp, /font-src data: https:/);
  assert.match(csp, /media-src data: blob: https:/);
  assert.match(csp, /connect-src 'none'/);
  assert.match(csp, /frame-ancestors 'self' https:\/\/app\.slock\.ai/);
  assert.match(csp, /base-uri 'none'/);
  assert.match(csp, /form-action 'none'/);
  assert.match(csp, /object-src 'none'/);
  assert.match(csp, /worker-src 'none'/);
  assert.doesNotMatch(csp, /allow-same-origin/);
});

test("normalizeUploadedMimeType keeps explicit image mime types", () => {
  assert.equal(
    normalizeUploadedMimeType("mock.png", "image/png"),
    "image/png",
  );
});

test("isEmptyUploadedFile rejects zero-byte multipart files", () => {
  assert.equal(isEmptyUploadedFile({ size: 0, buffer: Buffer.alloc(0) }), true);
  assert.equal(isEmptyUploadedFile({ size: 1, buffer: Buffer.from([0]) }), false);
});

test("normalizeUploadedMimeType recovers PNG from application/octet-stream by filename", () => {
  assert.equal(
    normalizeUploadedMimeType("mock.PNG", "application/octet-stream"),
    "image/png",
  );
});

test("normalizeUploadedMimeType recovers SVG from application/octet-stream by filename", () => {
  assert.equal(
    normalizeUploadedMimeType("diagram.svg", "application/octet-stream"),
    "image/svg+xml",
  );
});

test("normalizeUploadedMimeType recovers PNG from file signature when mime type is missing", () => {
  const pngHeader = Buffer.from([0x89, 0x50, 0x4E, 0x47, 0x0D, 0x0A, 0x1A, 0x0A]);
  assert.equal(
    normalizeUploadedMimeType("attachment", undefined, pngHeader),
    "image/png",
  );
});

test("normalizeUploadedMimeType recovers HEIC from filename and file signature", () => {
  const heic = readFileSync(new URL("./fixtures/preview-sample.heic", import.meta.url));

  assert.equal(
    normalizeUploadedMimeType("photo.HEIC", "application/octet-stream"),
    "image/heic",
  );
  assert.equal(
    normalizeUploadedMimeType("attachment", "application/octet-stream", heic),
    "image/heic",
  );
});

test("normalizeUploadedMimeType does not misclassify AVIF-compatible ftyp boxes as HEIF", () => {
  const makeFtyp = (majorBrand: string, compatibleBrand: string): Buffer => {
    const buffer = Buffer.alloc(20);
    buffer.writeUInt32BE(buffer.length, 0);
    buffer.write("ftyp", 4, "ascii");
    buffer.write(majorBrand, 8, "ascii");
    buffer.write(compatibleBrand, 16, "ascii");
    return buffer;
  };

  for (const compatibleBrand of ["avif", "avis"]) {
    assert.equal(
      normalizeUploadedMimeType(
        "attachment",
        "application/octet-stream",
        makeFtyp("mif1", compatibleBrand),
      ),
      "application/octet-stream",
    );
  }
});

test("normalizeUploadedMimeType prefers file signature over non-explicit transport mime", () => {
  const jpegHeader = Buffer.from([0xFF, 0xD8, 0xFF, 0xE0]);
  assert.equal(
    normalizeUploadedMimeType("attachment", "application/octet-stream", jpegHeader),
    "image/jpeg",
  );
  assert.equal(
    normalizeUploadedMimeType("attachment.png", "text/plain", jpegHeader),
    "image/jpeg",
  );
});

test("normalizeUploadedMimeType lets explicit override win", () => {
  const pngHeader = Buffer.from([0x89, 0x50, 0x4E, 0x47, 0x0D, 0x0A, 0x1A, 0x0A]);
  assert.equal(
    normalizeUploadedMimeType("attachment", "application/octet-stream", pngHeader, "image/svg+xml"),
    "image/svg+xml",
  );
});

test("normalizeUploadedMimeType ignores malformed explicit MIME overrides", () => {
  const pngHeader = Buffer.from([0x89, 0x50, 0x4E, 0x47, 0x0D, 0x0A, 0x1A, 0x0A]);
  assert.equal(
    normalizeUploadedMimeType("attachment", "application/octet-stream", pngHeader, "not-a-mime-type"),
    "image/png",
  );
});

test("resolveAttachmentMimeType recovers legacy image rows from filename", () => {
  assert.equal(
    resolveAttachmentMimeType("screenshot.webp", "application/octet-stream"),
    "image/webp",
  );
});

test("buildAttachmentContentDisposition treats legacy octet-stream image filenames as inline", () => {
  const disposition = buildAttachmentContentDisposition("screenshot.png", "application/octet-stream");
  assert.match(disposition, /^inline; filename="/);
});

test("buildAttachmentDownloadContentDisposition forces image filenames to attachment", () => {
  const disposition = buildAttachmentDownloadContentDisposition("reaction.gif");
  assert.match(disposition, /^attachment; filename="reaction\.gif"/);
});

test("image thumbnails honor EXIF orientation", async () => {
  const orientedJpeg = await sharp({
    create: {
      width: 40,
      height: 20,
      channels: 3,
      background: { r: 255, g: 0, b: 0 },
    },
  })
    .jpeg()
    .withMetadata({ orientation: 6 })
    .toBuffer();

  const thumbnail = await generateThumbnail(orientedJpeg, "image/jpeg");
  const metadata = await sharp(thumbnail).metadata();

  assert.equal(metadata.width, 20);
  assert.equal(metadata.height, 40);
});

test("HEIC attachments generate browser-compatible WebP thumbnails", async () => {
  const heic = readFileSync(new URL("./fixtures/preview-sample.heic", import.meta.url));

  assert.equal(canGenerateImagePreview("image/heic"), true);
  assert.match(buildAttachmentContentDisposition("photo.heic", "image/heic"), /^attachment; filename="/);

  const thumbnail = await generateThumbnail(heic, "image/heic");
  const metadata = await sharp(thumbnail).metadata();

  assert.equal(thumbnail.subarray(0, 4).toString("ascii"), "RIFF");
  assert.equal(thumbnail.subarray(8, 12).toString("ascii"), "WEBP");
  assert.equal(metadata.width, 32);
  assert.equal(metadata.height, 32);
});

test("buildAttachmentContentDisposition keeps raw SVG download-only", () => {
  const disposition = buildAttachmentContentDisposition("diagram.svg", "image/svg+xml");
  assert.match(disposition, /^attachment; filename="/);
});

test("SVG raster previews preserve Mermaid-style Latin and CJK text in WebP bitmaps", async () => {
  const svg = Buffer.from(`
    <svg xmlns="http://www.w3.org/2000/svg" width="420" height="96" viewBox="0 0 420 96">
      <rect width="420" height="96" fill="white"/>
      <text x="8" y="38" font-family="sans-serif" font-size="26" fill="black">Release plan</text>
      <text x="8" y="76" font-family="sans-serif" font-size="26" fill="black">中文 · 日本語 · 한국어</text>
      <circle cx="396" cy="48" r="12" fill="gold"/>
    </svg>
  `);
  const thumb = await generateThumbnail(svg, "image/svg+xml");
  const preview = await generateSvgRasterPreview(svg);

  for (const buffer of [thumb, preview]) {
    assert.equal(buffer.subarray(0, 4).toString("ascii"), "RIFF");
    assert.equal(buffer.subarray(8, 12).toString("ascii"), "WEBP");
  }

  const { data, info } = await sharp(preview)
    .flatten({ background: "white" })
    .greyscale()
    .raw()
    .toBuffer({ resolveWithObject: true });
  const textRegionRight = Math.floor(info.width * 0.72);
  let darkTextPixels = 0;
  for (let y = 0; y < info.height; y += 1) {
    for (let x = 0; x < textRegionRight; x += 1) {
      if (data[y * info.width + x]! < 64) darkTextPixels += 1;
    }
  }
  assert.ok(darkTextPixels > 200, `expected rasterized text pixels, got ${darkTextPixels}`);
});

test("invalid SVG raster previews fail closed", async () => {
  await assert.rejects(
    () => generateSvgRasterPreview(Buffer.from("<svg><broken></svg>")),
    /Input buffer has corrupt header|corrupt|svg/i,
  );
});

test("the default direct-upload threshold is 10 MiB and stays below the legacy transport safety cap", () => {
  const previous = process.env.ATTACHMENT_DIRECT_UPLOAD_THRESHOLD_BYTES;
  const postTrial = new Date("2026-06-23T12:00:00Z");
  try {
    delete process.env.ATTACHMENT_DIRECT_UPLOAD_THRESHOLD_BYTES;
    assert.equal(
      getAttachmentDirectUploadThresholdBytes(),
      10 * 1024 * 1024,
      "unset env must fall back to the 10 MiB default, not the legacy 90 MiB cap",
    );
    // Lowering the direct threshold must still leave the legacy transport limit alone.
    assert.equal(getLegacyAttachmentFileSizeLimitBytes("pro", postTrial), 90 * 1024 * 1024);
  } finally {
    if (previous === undefined) delete process.env.ATTACHMENT_DIRECT_UPLOAD_THRESHOLD_BYTES;
    else process.env.ATTACHMENT_DIRECT_UPLOAD_THRESHOLD_BYTES = previous;
  }
});
