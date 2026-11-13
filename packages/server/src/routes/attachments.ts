import { DmPeerNotMemberError } from "../services/dmSendPolicy";
import { Router, type NextFunction, type Request, type Response, type Router as RouterType } from "express";
import { UUID_RE } from "../lib/messageId";
import { refuse } from "../lib/refusal";
import {
  createAttachmentPreviewBridgeTransform,
} from "../services/attachmentPreviewBridge";
import jwt from "jsonwebtoken";
import multer from "multer";
import fs from "node:fs";
import { createHash } from "node:crypto";
import sharp, { type Sharp } from "sharp";
import { withImageDecodeSlot } from "../lib/imageDecodeLimit";
import { eq, inArray, and, isNull, isNotNull } from "drizzle-orm";
import {
  replaceAgentLineBreaks,
  FREE_SINGLE_FILE_UPLOAD_LIMIT_BYTES,
  PRO_SINGLE_FILE_UPLOAD_LIMIT_BYTES,
  type AttachmentPreviewResponse,
  summarizeAttachmentPreviewResponse,
} from "@botiverse/raft-shared";
import { getDb } from "../db/index";
import { attachments, messages } from "../db/schema";
import * as channelService from "../services/channelService";
import * as userService from "../services/userService";
import * as attachmentCommentService from "../services/attachmentCommentService";
import { parseStructuredMentions } from "./messages";
import { channelBillingReadOnlyBody, getChannelBillingReadOnly, isChannelReadOnlyByBillingFeature, isChannelReadOnlyByQuota } from "../services/planService";
import { noteFreePlanPaywallHit, notePaywallHit } from "./paywallHit";
import type { AgentOrchestrator } from "../services/agentOrchestrator";
import { getAttachmentPreviewProvider } from "../services/attachmentPreviews/registry";
import { getAttachmentPreviewWithCache, type AttachmentPreviewCacheOutcome } from "../services/attachmentPreviews/previewCache";
import { withTraceChildSpan } from "../tracing/semanticTrace";
import { getStorage, getCdnStorage, isStorageNotFoundError, isStorageTimeoutError, resolvePublicAssetUrl } from "../services/storageService";
import {
  streamStorageResponse,
  streamStorageResponseThrough,
} from "../services/storageResponseStream";
import {
  FileUploadQuotaExceededError,
  buildFileUploadQuotaExceededResponse,
  getFileUploadQuotaSummary,
} from "../services/fileUploadQuotaService";
import { getFramedByOrigins, getWebFrameAncestorOrigins } from "../config/appUrl";
import {
  getAttachmentsForMessagesWithExecutor,
} from "../services/attachmentLinkingService";
import {
  getAttachmentFileSizeLimitBytes,
  getLegacyAttachmentFileSizeLimitBytes,
} from "../services/attachmentUploadPolicy";
import { resolveReadableAttachmentAuthorityContext } from "../services/attachmentAuthorityService";
import {
  type AttachmentObjectMetadata,
  type ResolvedAttachment,
  withAttachmentObjectMetadata,
} from "../services/attachmentRecord";
import { getRequestHistoryWindow, isAttachmentBehindWindow } from "../services/historyWindow";
import { uploadAttachmentBuffers } from "../services/attachmentUploadWriterService";
import { buildSvgRasterTransferKey } from "../services/attachmentTransferIntentService";
import { sendJsonServerError } from "./errorResponse";

export {
  getAttachmentFileSizeLimitBytes,
  getLegacyAttachmentFileSizeLimitBytes,
} from "../services/attachmentUploadPolicy";

const THUMBNAIL_MAX_WIDTH = 320;
const THUMBNAIL_QUALITY = 75;
const SVG_RASTER_PREVIEW_MAX_WIDTH = 2048;
const SVG_RASTER_PREVIEW_QUALITY = 85;
const SVG_RASTER_DENSITY = 192;
const SVG_RASTER_MAX_PIXELS = 4096 * 4096;
const HEIC_DECODE_MAX_PIXELS = 64 * 1024 * 1024;
/**
 * The pixel cap for a direct upload's thumbnail (task #57): sharp reads the
 * dimensions from the header and refuses a larger image before decoding its
 * pixels, the same bound HEIC uses.
 */
export const DIRECT_UPLOAD_THUMBNAIL_MAX_PIXELS = HEIC_DECODE_MAX_PIXELS;
const HTML_PREVIEW_TOKEN_TTL_SECONDS = 300;
export const ATTACHMENT_PRESIGNED_URL_TTL_SECONDS = 300;
// Inline video/audio previews use the presigned URL as a long-lived
// <video>/<audio> src: the browser keeps sending range requests to it for as
// long as the page is open, and an expired link surfaces as a broken preview
// (bug-triage task #14). Only those get the longer window; downloads and every
// other type keep the 5-minute TTL. Access is still checked when the link is
// issued (`GET /:id/url`), so this widens the window, not who can view.
export const ATTACHMENT_MEDIA_PREVIEW_PRESIGNED_URL_TTL_SECONDS = 3600;

interface HtmlPreviewTokenClaims {
  sub: string;
  type: "attachment-html-preview";
  attachmentId: string;
  serverId: string;
  actorType: "user" | "machine";
  actorId: string;
}

function jwtSecret() {
  const secret = process.env.JWT_SECRET;
  if (!secret) throw new Error("JWT_SECRET environment variable is required");
  return secret;
}

/** Build the public URL for a thumbnail key from its generation, or null if unavailable */
export function getThumbnailUrl(thumbnailKey: string | null): string | null {
  return resolvePublicAssetUrl(thumbnailKey);
}

interface HeicDecodableImage {
  width: number;
  height: number;
  decode: () => Promise<{ width: number; height: number; data: Uint8ClampedArray }>;
}

interface HeicImageCollection extends Array<HeicDecodableImage> {
  dispose: () => void;
}

async function createHeicSharp(buffer: Buffer): Promise<Sharp> {
  // libheif's WASM bundle is several megabytes and most requests never need it.
  // Load it only for HEIC/HEIF thumbnails rather than extending server startup.
  const { default: decodeHeic } = await import("heic-decode");
  const images = await decodeHeic.all({ buffer }) as unknown as HeicImageCollection;
  try {
    const image = images[0];
    if (!image) throw new Error("HEIC image not found");
    const { width, height } = image;
    if (
      !Number.isSafeInteger(width)
      || !Number.isSafeInteger(height)
      || width <= 0
      || height <= 0
      || width > Math.floor(HEIC_DECODE_MAX_PIXELS / height)
    ) {
      throw new Error(`HEIC dimensions exceed preview limit: ${width}x${height}`);
    }

    const decoded = await image.decode();
    if (decoded.width !== width || decoded.height !== height || decoded.data.byteLength !== width * height * 4) {
      throw new Error("HEIC decoder returned inconsistent pixel data");
    }
    const pixels = Buffer.from(decoded.data.buffer, decoded.data.byteOffset, decoded.data.byteLength);
    return sharp(pixels, {
      raw: { width, height, channels: 4 },
      limitInputPixels: HEIC_DECODE_MAX_PIXELS,
    });
  } finally {
    images.dispose();
  }
}

async function createImageSharp(buffer: Buffer, mimeType?: string | null): Promise<Sharp> {
  if (isHeicAttachmentMimeType(mimeType)) return createHeicSharp(buffer);
  return isSvgAttachmentMimeType(mimeType)
    ? sharp(buffer, { density: SVG_RASTER_DENSITY, limitInputPixels: SVG_RASTER_MAX_PIXELS })
    : sharp(buffer).rotate();
}

async function renderThumbnail(buffer: Buffer, mimeType?: string | null): Promise<Buffer> {
  return (await createImageSharp(buffer, mimeType))
    .resize(THUMBNAIL_MAX_WIDTH, undefined, { withoutEnlargement: true })
    .webp({ quality: THUMBNAIL_QUALITY })
    .toBuffer();
}

/** Generate a WebP thumbnail from an image buffer, in an image-decode slot. SVG input is rasterized first. */
export async function generateThumbnail(buffer: Buffer, mimeType?: string | null): Promise<Buffer> {
  return withImageDecodeSlot(() => renderThumbnail(buffer, mimeType));
}

/**
 * A direct upload's thumbnail (task #57): the multipart thumbnail, with the
 * raster formats also held to DIRECT_UPLOAD_THUMBNAIL_MAX_PIXELS (HEIC and SVG
 * already carry their own caps). The caller bounds the bytes it reads.
 */
export async function generateDirectUploadThumbnail(buffer: Buffer, mimeType: string): Promise<Buffer> {
  return withImageDecodeSlot(async () => {
    if (isHeicAttachmentMimeType(mimeType) || isSvgAttachmentMimeType(mimeType)) return renderThumbnail(buffer, mimeType);
    return sharp(buffer, { limitInputPixels: DIRECT_UPLOAD_THUMBNAIL_MAX_PIXELS }).rotate()
      .resize(THUMBNAIL_MAX_WIDTH, undefined, { withoutEnlargement: true })
      .webp({ quality: THUMBNAIL_QUALITY })
      .toBuffer();
  });
}

/** Whether a thumbnail failure is the image itself being over the pixel caps (no retry helps). */
export function isThumbnailPixelLimitError(err: unknown): boolean {
  const message = err instanceof Error ? err.message : String(err);
  return /pixel limit|dimensions exceed preview limit/i.test(message);
}

/** Generate the larger safe bitmap used by the image lightbox for SVG attachments, in an image-decode slot. */
export async function generateSvgRasterPreview(buffer: Buffer): Promise<Buffer> {
  return withImageDecodeSlot(async () => (await createImageSharp(buffer, "image/svg+xml"))
    .resize(SVG_RASTER_PREVIEW_MAX_WIDTH, SVG_RASTER_PREVIEW_MAX_WIDTH, { fit: "inside", withoutEnlargement: true })
    .webp({ quality: SVG_RASTER_PREVIEW_QUALITY })
    .toBuffer());
}

export const attachmentRouter: RouterType = Router();

// NOTE: deliberately NOT covered by guardUuidPathParams — these routes keep
// their deliberate 400 {code:"invalid_attachment_id"} contract
// (rejectMalformedAttachmentId), not the generic 404 (task #12).

// Public router — serves files by UUID (no auth required, UUIDs are unguessable)
export const attachmentPublicRouter: RouterType = Router();

// Image MIME types that get thumbnail generation + inline preview behavior
const PREVIEWABLE_IMAGE_MIME_TYPES = new Set([
  "image/jpeg",
  "image/png",
  "image/gif",
  "image/webp",
]);
const SVG_IMAGE_MIME_TYPE = "image/svg+xml";
const HEIC_IMAGE_MIME_TYPES = new Set([
  "image/heic",
  "image/heif",
  "image/heic-sequence",
  "image/heif-sequence",
]);

const FILENAME_MIME_MAP: Record<string, string> = {
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".png": "image/png",
  ".gif": "image/gif",
  ".webp": "image/webp",
  ".svg": SVG_IMAGE_MIME_TYPE,
  ".heic": "image/heic",
  ".heif": "image/heif",
  ".html": "text/html",
  ".htm": "text/html",
  ".mp4": "video/mp4",
  ".webm": "video/webm",
  ".mov": "video/quicktime",
  ".mp3": "audio/mpeg",
  ".wav": "audio/wav",
  ".m4a": "audio/mp4",
  ".aac": "audio/aac",
  ".ogg": "audio/ogg",
  ".oga": "audio/ogg",
  ".opus": "audio/opus",
  ".weba": "audio/webm",
  ".flac": "audio/flac",
  ".pdf": "application/pdf",
  ".txt": "text/plain",
  ".md": "text/markdown",
  ".json": "application/json",
  ".csv": "text/csv",
};
const MIME_TYPE_RE = /^[a-z0-9][a-z0-9!#$&^_.+-]*\/[a-z0-9][a-z0-9!#$&^_.+-]*$/i;

export const MAX_ATTACHMENT_FILE_SIZE_BYTES = FREE_SINGLE_FILE_UPLOAD_LIMIT_BYTES;
export const MAX_ATTACHMENT_FILE_SIZE_LABEL = "50MB";
export const MAX_PRO_ATTACHMENT_FILE_SIZE_BYTES = PRO_SINGLE_FILE_UPLOAD_LIMIT_BYTES;
export const MAX_ATTACHMENT_UPLOAD_FILES = 10;
export const ATTACHMENT_UPLOAD_DISABLED_MESSAGE = "File uploads are disabled on this server";
export const ATTACHMENT_TOO_LARGE_MESSAGE = `Max ${MAX_ATTACHMENT_FILE_SIZE_LABEL} per file`;
const MULTER_ATTACHMENT_FILE_SIZE_SLACK_BYTES = 1024 * 1024;

export function isAttachmentUploadEnabled(): boolean {
  return process.env.ATTACHMENT_UPLOAD_ENABLED !== "false";
}

function attachmentSizeLabel(limitBytes: number): string {
  const mebibyte = 1024 * 1024;
  return limitBytes % mebibyte === 0
    ? `${limitBytes / mebibyte}MB`
    : `${limitBytes} bytes`;
}

export function getAttachmentTooLargeMessage(limitBytes = MAX_ATTACHMENT_FILE_SIZE_BYTES): string {
  return `Max ${attachmentSizeLabel(limitBytes)} per file`;
}

/**
 * The agent routes' multipart upload refusal for a file over the plan's limit
 * (413 `ATTACHMENT_TOO_LARGE`, through refuse()): the limit is in the
 * sentence (no agent client read the former `maxBytes`).
 */
export function attachmentTooLargeRefusal(limitBytes: number): { code: "ATTACHMENT_TOO_LARGE"; error: string } {
  return {
    code: "ATTACHMENT_TOO_LARGE",
    error: `That file is over this server's upload limit of ${attachmentSizeLabel(limitBytes)} per file: upload a smaller file.`,
  };
}

export function buildAttachmentTooLargeResponse(limitBytes = MAX_ATTACHMENT_FILE_SIZE_BYTES): {
  error: string;
  errorCode: "ATTACHMENT_TOO_LARGE";
  maxBytes: number;
} {
  return {
    error: getAttachmentTooLargeMessage(limitBytes),
    errorCode: "ATTACHMENT_TOO_LARGE",
    maxBytes: limitBytes,
  };
}

export async function resolveRequestAttachmentFileSizeLimitBytes(req: Request): Promise<number> {
  const serverId = req.serverId;
  if (!serverId) return MAX_ATTACHMENT_FILE_SIZE_BYTES;
  const quota = await getFileUploadQuotaSummary(serverId);
  return getAttachmentFileSizeLimitBytes(quota.plan);
}

async function resolveRequestLegacyAttachmentFileSizeLimitBytes(req: Request): Promise<number> {
  const serverId = req.serverId;
  if (!serverId) return MAX_ATTACHMENT_FILE_SIZE_BYTES;
  const quota = await getFileUploadQuotaSummary(serverId);
  return getLegacyAttachmentFileSizeLimitBytes(quota.plan);
}

function createAttachmentUpload(limitBytes: number): multer.Multer {
  return multer({
    storage: multer.memoryStorage(),
    limits: { fileSize: limitBytes + MULTER_ATTACHMENT_FILE_SIZE_SLACK_BYTES },
  });
}

export function runSingleAttachmentUpload(req: Request, res: Response, next: NextFunction): void {
  if (!isAttachmentUploadEnabled()) {
    res.status(503).json({
      error: ATTACHMENT_UPLOAD_DISABLED_MESSAGE,
      errorCode: "ATTACHMENT_UPLOAD_DISABLED",
    });
    return;
  }

  void resolveRequestAttachmentFileSizeLimitBytes(req).then((limitBytes) => {
    createAttachmentUpload(limitBytes).single("file")(req, res, (err: unknown) => {
      if (err instanceof multer.MulterError && err.code === "LIMIT_FILE_SIZE") {
        void noteFreePlanPaywallHit(req, "upload_file_size");
        // Only the agent routes upload one file at a time: they answer the
        // same refusal as their own size check after multer.
        refuse(res, 413, attachmentTooLargeRefusal(limitBytes));
        return;
      }
      if (err) {
        res.status(400).json({ error: err instanceof Error ? err.message : "Upload failed" });
        return;
      }
      next();
    });
  }, next);
}

function runAttachmentUpload(req: Request, res: Response, next: NextFunction): void {
  if (!isAttachmentUploadEnabled()) {
    res.status(503).json({
      error: ATTACHMENT_UPLOAD_DISABLED_MESSAGE,
      errorCode: "ATTACHMENT_UPLOAD_DISABLED",
    });
    return;
  }

  void resolveRequestLegacyAttachmentFileSizeLimitBytes(req).then((limitBytes) => {
    createAttachmentUpload(limitBytes).array("files", MAX_ATTACHMENT_UPLOAD_FILES)(req, res, (err: unknown) => {
      if (err instanceof multer.MulterError && err.code === "LIMIT_FILE_SIZE") {
        void noteFreePlanPaywallHit(req, "upload_file_size");
        res.status(413).json(buildAttachmentTooLargeResponse(limitBytes));
        return;
      }
      if (err) {
        res.status(400).json({ error: err instanceof Error ? err.message : "Upload failed" });
        return;
      }
      next();
    });
  }, next);
}

export function isEmptyUploadedFile(file: Pick<Express.Multer.File, "size" | "buffer">): boolean {
  return file.size <= 0 || file.buffer.length <= 0;
}

export function isOversizedUploadedFile(file: Pick<Express.Multer.File, "size">, limitBytes = MAX_ATTACHMENT_FILE_SIZE_BYTES): boolean {
  return file.size > limitBytes;
}

async function getRequestAttachmentTooLargeResponse(req: Request): Promise<ReturnType<typeof buildAttachmentTooLargeResponse>> {
  const limitBytes = await resolveRequestLegacyAttachmentFileSizeLimitBytes(req);
  return buildAttachmentTooLargeResponse(limitBytes);
}


export function isPreviewableImageMimeType(mimeType: string | null | undefined): boolean {
  return !!mimeType && PREVIEWABLE_IMAGE_MIME_TYPES.has(mimeType);
}

export function isSvgAttachmentMimeType(mimeType: string | null | undefined): boolean {
  return mimeType?.split(";")[0]?.trim().toLowerCase() === SVG_IMAGE_MIME_TYPE;
}

export function isHeicAttachmentMimeType(mimeType: string | null | undefined): boolean {
  const normalized = mimeType?.split(";")[0]?.trim().toLowerCase();
  return !!normalized && HEIC_IMAGE_MIME_TYPES.has(normalized);
}

export function canGenerateImagePreview(mimeType: string | null | undefined): boolean {
  return isPreviewableImageMimeType(mimeType) || isSvgAttachmentMimeType(mimeType) || isHeicAttachmentMimeType(mimeType);
}

export function buildSvgRasterPreviewKey(thumbnailKey: string): string {
  return buildSvgRasterTransferKey(thumbnailKey);
}

function getSvgRasterPreviewUrl(thumbnailKey: string | null, mimeType: string | null | undefined): string | null {
  if (!thumbnailKey || !isSvgAttachmentMimeType(mimeType)) return null;
  return resolvePublicAssetUrl(buildSvgRasterPreviewKey(thumbnailKey));
}

export function isHtmlAttachmentMimeType(mimeType: string | null | undefined): boolean {
  return mimeType?.split(";")[0]?.trim().toLowerCase() === "text/html";
}

export function isPdfAttachmentMimeType(mimeType: string | null | undefined): boolean {
  return mimeType?.split(";")[0]?.trim().toLowerCase() === "application/pdf";
}

export function isVideoPreviewAttachmentMimeType(mimeType: string | null | undefined): boolean {
  const normalized = mimeType?.split(";")[0]?.trim().toLowerCase();
  return normalized === "video/mp4" || normalized === "video/webm" || normalized === "video/quicktime";
}

export function isAudioPreviewAttachmentMimeType(mimeType: string | null | undefined): boolean {
  const normalized = mimeType?.split(";")[0]?.trim().toLowerCase();
  return (
    normalized === "audio/mpeg"
    || normalized === "audio/mp3"
    || normalized === "audio/wav"
    || normalized === "audio/x-wav"
    || normalized === "audio/wave"
    || normalized === "audio/aac"
    || normalized === "audio/mp4"
    || normalized === "audio/x-m4a"
    || normalized === "audio/ogg"
    || normalized === "audio/opus"
    || normalized === "audio/webm"
    || normalized === "audio/flac"
    || normalized === "audio/x-flac"
  );
}

function inferMimeTypeFromFilename(filename: string): string | null {
  const ext = filename.includes(".") ? filename.slice(filename.lastIndexOf(".")).toLowerCase() : "";
  return FILENAME_MIME_MAP[ext] || null;
}

export function resolveAttachmentMimeType(
  filename: string,
  mimeType: string | null | undefined,
): string {
  const normalized = mimeType?.trim().toLowerCase();
  if (normalized && normalized !== "application/octet-stream") {
    return normalized;
  }
  return inferMimeTypeFromFilename(normalizeAttachmentFilename(filename))
    || normalized
    || "application/octet-stream";
}

function inferMimeTypeFromBuffer(buffer: Buffer): string | null {
  if (buffer.length >= 8 && buffer.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4E, 0x47, 0x0D, 0x0A, 0x1A, 0x0A]))) {
    return "image/png";
  }
  if (buffer.length >= 3 && buffer.subarray(0, 3).equals(Buffer.from([0xFF, 0xD8, 0xFF]))) {
    return "image/jpeg";
  }
  if (buffer.length >= 6) {
    const header = buffer.subarray(0, 6).toString("ascii");
    if (header === "GIF87a" || header === "GIF89a") return "image/gif";
  }
  if (
    buffer.length >= 12 &&
    buffer.subarray(0, 4).toString("ascii") === "RIFF" &&
    buffer.subarray(8, 12).toString("ascii") === "WEBP"
  ) {
    return "image/webp";
  }
  if (buffer.length >= 16 && buffer.subarray(4, 8).toString("ascii") === "ftyp") {
    const boxSize = Math.min(buffer.readUInt32BE(0), buffer.length);
    const majorBrand = buffer.subarray(8, 12).toString("ascii");
    const brands = new Set<string>();
    for (let offset = 16; offset + 4 <= boxSize; offset += 4) {
      brands.add(buffer.subarray(offset, offset + 4).toString("ascii"));
    }
    if (["heic", "heix", "hevc", "hevx"].includes(majorBrand)) {
      return "image/heic";
    }
    if (!["avif", "avis"].some((brand) => brands.has(brand)) && ["mif1", "msf1"].includes(majorBrand)) {
      return "image/heif";
    }
  }
  return null;
}

export function normalizeUploadedMimeType(
  filename: string,
  mimeType: string | null | undefined,
  buffer?: Buffer,
  explicitMimeType?: string | null,
): string {
  const explicit = explicitMimeType?.trim().toLowerCase();
  if (explicit && MIME_TYPE_RE.test(explicit)) {
    return explicit;
  }
  const normalized = mimeType?.trim().toLowerCase();
  return inferMimeTypeFromBuffer(buffer ?? Buffer.alloc(0))
    || (normalized && normalized !== "application/octet-stream" ? normalized : null)
    || inferMimeTypeFromFilename(filename)
    || normalized
    || "application/octet-stream";
}

/** A stored or uploaded filename as shown: mojibake repaired, and no line break (it lands on a message's header line). */
export function normalizeAttachmentFilename(filename: string): string {
  return replaceAgentLineBreaks(repairAttachmentFilenameEncoding(filename), " ");
}

function repairAttachmentFilenameEncoding(filename: string): string {
  if (!/[^\x00-\x7F]/.test(filename)) return filename;

  const repaired = Buffer.from(filename, "latin1").toString("utf8");
  if (repaired.includes("\uFFFD")) return filename;
  if (Buffer.from(repaired, "utf8").toString("latin1") !== filename) return filename;
  return repaired;
}

function withUtf8CharsetIfNeeded(mimeType: string): string {
  if (/\bcharset=/i.test(mimeType)) return mimeType;
  const lower = mimeType.toLowerCase();
  if (
    lower.startsWith("text/") ||
    lower === "application/json" ||
    lower === "application/ld+json" ||
    lower === "application/xml" ||
    lower.endsWith("+json") ||
    lower.endsWith("+xml")
  ) {
    return `${mimeType}; charset=utf-8`;
  }
  return mimeType;
}

function sanitizeAsciiFallbackFilename(filename: string): string {
  const safe = filename
    .replace(/[\r\n]/g, " ")
    .replace(/["\\]/g, "_")
    .replace(/[^\x20-\x7E]/g, "_")
    .trim();
  return safe || "download";
}

function buildContentDisposition(disposition: "attachment" | "inline", filename: string): string {
  const normalizedFilename = normalizeAttachmentFilename(filename);
  const fallbackFilename = sanitizeAsciiFallbackFilename(normalizedFilename);
  const encodedUtf8Filename = encodeURIComponent(normalizedFilename).replace(
    /['()*]/g,
    (ch) => `%${ch.charCodeAt(0).toString(16).toUpperCase()}`
  );
  return `${disposition}; filename="${fallbackFilename}"; filename*=UTF-8''${encodedUtf8Filename}`;
}

export function buildAttachmentContentDisposition(
  filename: string,
  mimeType: string | null | undefined
): string {
  const disposition = isPreviewableImageMimeType(resolveAttachmentMimeType(filename, mimeType)) ? "inline" : "attachment";
  return buildContentDisposition(disposition, filename);
}

export function buildAttachmentDownloadContentDisposition(filename: string): string {
  return buildContentDisposition("attachment", filename);
}

export function buildAttachmentInlinePreviewContentDisposition(
  filename: string,
  mimeType: string | null | undefined
): string {
  const resolvedMimeType = resolveAttachmentMimeType(filename, mimeType);
  const disposition = isPdfAttachmentMimeType(resolvedMimeType) || isVideoPreviewAttachmentMimeType(resolvedMimeType) || isAudioPreviewAttachmentMimeType(resolvedMimeType) || isPreviewableImageMimeType(resolvedMimeType)
    ? "inline"
    : "attachment";
  return buildContentDisposition(disposition, filename);
}

function shouldUseInlinePreviewDisposition(req: Request, filename: string, mimeType: string | null | undefined): boolean {
  const resolvedMimeType = resolveAttachmentMimeType(filename, mimeType);
  return req.query.disposition === "inline" && (isPdfAttachmentMimeType(resolvedMimeType) || isVideoPreviewAttachmentMimeType(resolvedMimeType) || isAudioPreviewAttachmentMimeType(resolvedMimeType));
}

function shouldUseDownloadDisposition(req: Request): boolean {
  return req.query.disposition === "attachment" || req.query.download === "1";
}

function attachmentUrlTtlSecondsForRequest(req: Request, filename: string, mimeType: string | null | undefined): number {
  if (shouldUseDownloadDisposition(req) || req.query.disposition !== "inline") return ATTACHMENT_PRESIGNED_URL_TTL_SECONDS;
  const resolvedMimeType = resolveAttachmentMimeType(filename, mimeType);
  return isVideoPreviewAttachmentMimeType(resolvedMimeType) || isAudioPreviewAttachmentMimeType(resolvedMimeType)
    ? ATTACHMENT_MEDIA_PREVIEW_PRESIGNED_URL_TTL_SECONDS
    : ATTACHMENT_PRESIGNED_URL_TTL_SECONDS;
}

export function shouldStreamAttachmentThroughServerForRequest(
  req: Pick<Request, "query">,
): boolean {
  return req.query.selectScreenshot === "1" || process.env.DEPLOYMENT_ENV === "slockdev";
}

export function getAttachmentStreamingBaseUrl(
  req: Pick<Request, "protocol" | "get">,
): string {
  if (process.env.DEPLOYMENT_ENV === "slockdev") {
    const forwardedProto = req.get("x-forwarded-proto")?.split(",", 1)[0]?.trim() || req.protocol;
    const forwardedHost = req.get("x-forwarded-host")?.split(",", 1)[0]?.trim() || req.get("host");
    return `${forwardedProto}://${forwardedHost}`;
  }
  return process.env.SERVER_URL || `${req.protocol}://${req.get("host")}`;
}

function buildAttachmentContentDispositionForRequest(req: Request, filename: string, mimeType: string | null | undefined): string {
  if (shouldUseDownloadDisposition(req)) {
    return buildAttachmentDownloadContentDisposition(filename);
  }
  return shouldUseInlinePreviewDisposition(req, filename, mimeType)
    ? buildAttachmentInlinePreviewContentDisposition(filename, mimeType)
    : buildAttachmentContentDisposition(filename, mimeType);
}

export function buildAttachmentResponseContentType(mimeType: string | null | undefined): string {
  return withUtf8CharsetIfNeeded(mimeType || "application/octet-stream");
}

export function buildAttachmentContentLengthHeader(sizeBytes: number | null | undefined): string | undefined {
  if (typeof sizeBytes !== "number" || !Number.isFinite(sizeBytes) || sizeBytes < 0) return undefined;
  return String(Math.floor(sizeBytes));
}

export type AttachmentByteRange = { start: number; end: number; size: number } | "unsatisfiable" | null;

export function parseAttachmentByteRange(rangeHeader: string | string[] | undefined, sizeBytes: number | null | undefined): AttachmentByteRange {
  if (!rangeHeader || Array.isArray(rangeHeader)) return null;
  if (typeof sizeBytes !== "number" || !Number.isFinite(sizeBytes) || sizeBytes <= 0) return null;
  const size = Math.floor(sizeBytes);
  const match = /^bytes=(\d*)-(\d*)$/.exec(rangeHeader.trim());
  if (!match) return null;
  const [, rawStart, rawEnd] = match;
  if (!rawStart && !rawEnd) return null;

  if (!rawStart) {
    const suffixLength = Number(rawEnd);
    if (!Number.isFinite(suffixLength) || suffixLength <= 0) return "unsatisfiable";
    const start = Math.max(0, size - suffixLength);
    return { start, end: size - 1, size };
  }

  const start = Number(rawStart);
  const end = rawEnd ? Number(rawEnd) : size - 1;
  if (!Number.isInteger(start) || !Number.isInteger(end) || start < 0 || end < start || start >= size) {
    return "unsatisfiable";
  }
  return { start, end: Math.min(end, size - 1), size };
}

// The Raft Desktop shell embeds attachment previews from its custom-scheme page
// origin (app://raft). getWebFrameAncestorOrigins keeps only http(s) web
// origins, so that desktop origin is filtered out and a preview response's
// `frame-ancestors` blocks the app://raft parent (ERR_BLOCKED_BY_RESPONSE)
// even after the desktop page CSP allows the frame.
const DESKTOP_APP_FRAME_ANCESTOR = "app://raft";

// Frame ancestors for BOTH framed preview responses: the configured web origins
// (CORS_ORIGIN + app URL, http(s)) plus the desktop shell. #7977 added the
// desktop origin to the interactive HTML preview only; the API-served inline
// preview (local-storage fallback / protected proxy, e.g. the PDF viewer frame)
// kept a web-only list, which blocked the desktop shell (ERR_BLOCKED_BY_RESPONSE)
// on self-hosted / local-storage deployments. The desktop shell is a supported
// embedding origin for every attachment preview, so it is admitted here
// explicitly. This widens the ancestor allowlist by exactly that one origin
// (an origin identifier, not an application identity); attachment ACL / token
// checks still run before the stream, and every other origin stays refused.
// CORS and the web-side frame policy are untouched.
//
// Then FRAMED_BY_ORIGINS (getFramedByOrigins): a page that frames the Raft app
// itself (Deck). frame-ancestors names every ancestor, so a preview the app
// frames inside Deck is blocked unless Deck is listed too. An ancestor only:
// it is not a CORS origin, not a redirect target, and nothing here takes a
// message from it; the preview's parent is still the app. Unset: none.
function getPreviewFrameAncestorOrigins(raw = process.env.CORS_ORIGIN, framedBy = process.env.FRAMED_BY_ORIGINS): string[] {
  const origins = [...getWebFrameAncestorOrigins(raw), DESKTOP_APP_FRAME_ANCESTOR];
  return [...origins, ...getFramedByOrigins(framedBy).filter((origin) => !origins.includes(origin))];
}

export function buildAttachmentInlinePreviewContentSecurityPolicy(frameAncestorOrigins = getPreviewFrameAncestorOrigins()): string {
  const frameAncestors = ["'self'", ...frameAncestorOrigins].join(" ");
  return `frame-ancestors ${frameAncestors}`;
}

export function buildHtmlPreviewContentSecurityPolicy(frameAncestorOrigins = getPreviewFrameAncestorOrigins()): string {
  const frameAncestors = ["'self'", ...frameAncestorOrigins].join(" ");
  return [
    "default-src 'none'",
    // Opaque origin even when the preview URL is opened directly (not only
    // inside the web app's sandboxed iframe): hostile HTML must never run as
    // the API origin, where same-origin deployments keep credentials.
    "sandbox allow-scripts",
    // Treat every HTML attachment as hostile, whether it came from a human or
    // an agent. v0 intentionally allows HTTPS subresources for Mermaid/charts;
    // the security contract is that a leaked previewToken only replays this
    // exact HTML preview briefly, not that hostile HTML cannot beacon out.
    "script-src 'unsafe-inline' https:",
    "style-src 'unsafe-inline' https:",
    "img-src data: blob: https:",
    "font-src data: https:",
    "media-src data: blob: https:",
    "connect-src 'none'",
    "object-src 'none'",
    "base-uri 'none'",
    "form-action 'none'",
    "worker-src 'none'",
    `frame-ancestors ${frameAncestors}`,
  ].join("; ");
}

function buildAttachmentResponse(attachment: {
  id: string;
  filename: string;
  mimeType: string | null;
  sizeBytes: number;
  width: number | null;
  height: number | null;
  thumbnailKey: string | null;
}) {
  const filename = normalizeAttachmentFilename(attachment.filename);
  const resolvedMimeType = resolveAttachmentMimeType(filename, attachment.mimeType);
  return {
    id: attachment.id,
    filename,
    mimeType: resolvedMimeType,
    sizeBytes: attachment.sizeBytes,
    width: attachment.width,
    height: attachment.height,
    thumbnailUrl: getThumbnailUrl(attachment.thumbnailKey),
    rasterPreviewUrl: getSvgRasterPreviewUrl(attachment.thumbnailKey, resolvedMimeType),
  };
}

function logAttachmentAccessError(
  operation: "url" | "serve" | "preview",
  attachmentId: string | undefined,
  err: unknown,
  attachment?: (typeof attachments.$inferSelect & Partial<AttachmentObjectMetadata>) | null,
): void {
  console.error(`[Attachments] Failed to ${operation} attachment`, {
    attachmentId: attachment?.id ?? attachmentId ?? null,
    channelId: attachment?.channelId ?? null,
    storageKey: attachment?.storageKey ?? null,
    sizeBytes: attachment?.sizeBytes ?? null,
    mimeType: attachment?.mimeType ?? null,
    filename: attachment?.filename ?? null,
    resolvedMimeType: attachment ? resolveAttachmentMimeType(attachment.filename, attachment.mimeType) : null,
  }, err);
}

async function resolveReadableAttachmentForRequest(
  projection: typeof attachments.$inferSelect,
  req: Request,
  principalOverride?: { type: "user" | "machine"; id: string },
): Promise<ResolvedAttachment | null> {
  const readable = await resolveReadableAttachmentAccess(projection, req, principalOverride);
  if (!readable) return null;
  // A file posted in a message behind the plan's history window is behind it
  // too (services/historyWindow.ts); the web never shows that message. The
  // window is read once per request (batch routes resolve many files), and a
  // bound file's message time comes from the access check's own row.
  const historyWindow = await getRequestHistoryWindow(req, req.serverId!);
  const behind = await isAttachmentBehindWindow(
    { messageId: readable.attachment.messageId, messageCreatedAt: readable.messageCreatedAt },
    historyWindow,
  );
  return behind ? null : readable.attachment;
}

async function resolveReadableAttachmentAccess(
  projection: typeof attachments.$inferSelect,
  req: Request,
  principalOverride?: { type: "user" | "machine"; id: string },
): Promise<{ attachment: ResolvedAttachment; messageCreatedAt: Date | null } | null> {
  // The typed RFC 049 resolver owns both authorization and the immutable
  // physical read model (attachment_objects).
  if (!req.serverId) return null;
  // Machine credentials do not read attachments (#proj-raft-computer:8e6a4629).
  const principal = principalOverride ?? (req.userId ? { type: "user" as const, id: req.userId } : null);
  if (!principal) return null;
  const context = await resolveReadableAttachmentAuthorityContext({
    projectionId: projection.id,
    requestServerId: req.serverId,
    principal,
  });
  if (!context) return null;
  return {
    attachment: withAttachmentObjectMetadata({
      ...context.projection,
      channelId: context.localHostChannel.id,
      uploaderId: context.object.uploaderId,
      uploaderType: context.object.uploaderType,
    }, context.object),
    messageCreatedAt: context.canonicalMessage.createdAt,
  };
}

function signHtmlPreviewToken(
  attachment: ResolvedAttachment,
  req: Request,
): { token: string; expiresAt: string } {
  const nowMs = Date.now();
  const actorType = req.userId ? "user" : "machine";
  const actorId = req.userId ?? req.machineId;
  if (!actorId || !req.serverId) {
    throw new Error("Cannot create attachment preview token without scoped actor");
  }

  const token = jwt.sign({
    sub: actorId,
    type: "attachment-html-preview",
    attachmentId: attachment.id,
    serverId: req.serverId,
    actorType,
    actorId,
  } satisfies HtmlPreviewTokenClaims, jwtSecret(), {
    expiresIn: HTML_PREVIEW_TOKEN_TTL_SECONDS,
    audience: "attachment-html-preview",
    issuer: "slock-server",
  });

  return {
    token,
    expiresAt: new Date(nowMs + HTML_PREVIEW_TOKEN_TTL_SECONDS * 1000).toISOString(),
  };
}

function verifyHtmlPreviewToken(
  token: string,
  attachmentId: string,
  serverId: string | undefined,
): HtmlPreviewTokenClaims | null {
  if (!serverId) return null;

  try {
    const claims = jwt.verify(token, jwtSecret(), {
      audience: "attachment-html-preview",
      issuer: "slock-server",
    }) as jwt.JwtPayload & Partial<HtmlPreviewTokenClaims>;

    if (
      claims.type !== "attachment-html-preview" ||
      claims.attachmentId !== attachmentId ||
      claims.serverId !== serverId ||
      (claims.actorType !== "user" && claims.actorType !== "machine") ||
      typeof claims.actorId !== "string" ||
      claims.sub !== claims.actorId
    ) {
      return null;
    }

    return claims as unknown as HtmlPreviewTokenClaims;
  } catch {
    return null;
  }
}

function buildAuthenticatedAttachmentUrl(req: Request, pathSuffix = ""): URL {
  const serverUrl = process.env.SERVER_URL || `${req.protocol}://${req.get("host")}`;
  const url = new URL(`${serverUrl}/api/attachments/${req.params.id}${pathSuffix}`);
  const authHeader = req.headers.authorization;
  const queryToken = typeof req.query.token === "string" ? req.query.token : null;
  if (authHeader?.startsWith("Bearer ")) {
    url.searchParams.set("token", authHeader.slice(7));
  } else if (queryToken) {
    url.searchParams.set("token", queryToken);
  }
  if (req.serverId) {
    url.searchParams.set("serverId", req.serverId);
  }
  return url;
}

function buildHtmlPreviewUrl(req: Request, attachment: ResolvedAttachment): {
  url: URL;
  expiresAt: string;
} {
  const serverUrl = process.env.SERVER_URL || `${req.protocol}://${req.get("host")}`;
  const url = new URL(`${serverUrl}/api/attachments/${attachment.id}/html-preview`);
  const { token, expiresAt } = signHtmlPreviewToken(attachment, req);
  url.searchParams.set("previewToken", token);
  if (req.serverId) {
    url.searchParams.set("serverId", req.serverId);
  }
  return { url, expiresAt };
}

// Upload attachments (up to 10 at once)
attachmentRouter.post(
  "/upload",
  runAttachmentUpload,
  async (req, res) => {
    try {
      const files = req.files as Express.Multer.File[];
      if (!files || files.length === 0) {
        res.status(400).json({ error: "No files provided" });
        return;
      }
      if (files.some(isEmptyUploadedFile)) {
        res.status(400).json({ error: "Empty files are not allowed" });
        return;
      }
      const tooLargeResponse = await getRequestAttachmentTooLargeResponse(req);
      if (files.some((file) => isOversizedUploadedFile(file, tooLargeResponse.maxBytes))) {
        void noteFreePlanPaywallHit(req, "upload_file_size");
        res.status(413).json(tooLargeResponse);
        return;
      }

      const channelId = req.body.channelId;
      if (!channelId) {
        res.status(400).json({ error: "channelId is required" });
        return;
      }

      // Verify channel access
      const canAccess = await channelService.canUserAccessChannel(channelId, req.userId!, req.serverId!);
      if (!canAccess || !await channelService.canUserPostToChannel(channelId, req.userId!)) {
        res.status(403).json({ error: "You do not have access to this channel" });
        return;
      }

      // Archive gate: no new attachments on an archived channel.
      if (await channelService.isChannelArchived(channelId)) {
        res.status(409).json({ error: "This channel is archived", code: "channel_archived" });
        return;
      }
      const billingReadOnly = await getChannelBillingReadOnly(channelId, req.serverId!);
      if (billingReadOnly) {
        if (billingReadOnly.reason === "joint_over_limit") notePaywallHit(req, "joint_channel_read_only");
        res.status(403).json(channelBillingReadOnlyBody(billingReadOnly));
        return;
      }

      if (await isChannelReadOnlyByQuota(channelId, req.serverId!)) {
        res.status(403).json({ error: "This channel is read-only because its quota was exceeded" });
        return;
      }

      const storage = getStorage();
      if (!storage) {
        res.status(503).json({ error: "File uploads are not configured on this server" });
        return;
      }
      const cdnStorage = getCdnStorage();
      const inserted = await uploadAttachmentBuffers({
        serverId: req.serverId!,
        channelId,
        uploaderId: req.userId!,
        uploaderType: "user",
        files: files.map((file) => {
          const filename = normalizeAttachmentFilename(file.originalname);
          return {
            buffer: file.buffer,
            filename,
            mimeType: normalizeUploadedMimeType(filename, file.mimetype, file.buffer),
            contentHash: createHash("sha256").update(file.buffer).digest("hex"),
          };
        }),
        storage,
        cdnStorage,
        preview: {
          canGenerate: canGenerateImagePreview,
          generateThumbnail,
          isSvg: isSvgAttachmentMimeType,
          generateSvgRasterPreview,
        },
      });

      res.json({
        attachments: inserted.map(buildAttachmentResponse),
      });
    } catch (err: any) {
      console.error("Upload error:", err);
      if (isStorageTimeoutError(err)) {
        res.status(504).json({ error: "Attachment storage timed out" });
        return;
      }
      if (err instanceof FileUploadQuotaExceededError) {
        notePaywallHit(req, "upload_monthly_quota", { requestedBytes: err.requestedBytes, monthUsedBytes: err.summary.usedBytes });
        res.status(err.status).json(await buildFileUploadQuotaExceededResponse(req.serverId!, err, "human"));
        return;
      }
      res.status(500).json({ error: "Failed to upload files" });
    }
  }
);

// --- Attachment comments (attachment-comments MVP spec §4) ---------------
// A comment is a normal message in the attachment's parent-message thread,
// scoped by one attachment_comment_refs row. These routes serve user senders
// (this router is mounted behind requireAuth/requireServer); the agent
// transport reuses attachmentCommentService in PR3.

// Batch comment counts for chips/badges. Registered before the param routes
// for clarity; only attachments the caller can access are included.
attachmentRouter.get("/comments/counts", async (req, res) => {
  try {
    const idsParam = typeof req.query.ids === "string" ? req.query.ids : "";
    const ids = idsParam.split(",").map((s) => s.trim()).filter(Boolean);
    if (ids.length === 0 || ids.length > 100) {
      res.status(400).json({ error: "ids must contain 1-100 attachment ids" });
      return;
    }
    const db = getDb();
    const rows = await db.select().from(attachments).where(inArray(attachments.id, ids));
    const accessible: string[] = [];
    for (const projection of rows) {
      const attachment = await resolveReadableAttachmentForRequest(projection, req);
      if (attachment) accessible.push(attachment.id);
    }
    const counts = await attachmentCommentService.getAttachmentCommentCounts(accessible);
    res.json({ counts });
  } catch (err) {
    sendJsonServerError(req, res, { error: "Failed to load comment counts", logPrefix: "Comment counts error:", err });
  }
});

// List comments scoped to one attachment (thread messages joined via refs).
attachmentRouter.get("/:id/comments", async (req, res) => {
  try {
    if (rejectMalformedAttachmentId(req, res)) return;
    const db = getDb();
    const [projection] = await db
      .select()
      .from(attachments)
      .where(eq(attachments.id, req.params.id))
      .limit(1);
    const attachment = projection
      ? await resolveReadableAttachmentForRequest(projection, req)
      : null;
    if (!attachment) {
      res.status(404).json({ error: "Attachment not found" });
      return;
    }
    const limit = typeof req.query.limit === "string" ? Number(req.query.limit) : undefined;
    const result = await attachmentCommentService.listAttachmentComments(attachment.id, {
      limit: Number.isFinite(limit) ? limit : undefined,
    });
    // Viewer write-state so the panel can gate affordances honestly (§5b
    // read-only / archived states) instead of presenting a composer the
    // server would reject.
    const channel = await channelService.getChannel(attachment.channelId);
    const viewer = channel?.archivedAt
      ? { canComment: false, reason: "archived" as const }
      : !attachment.messageId
        ? { canComment: false, reason: "unlinked" as const }
        : (await isChannelReadOnlyByBillingFeature(attachment.channelId, req.serverId!))
          ? { canComment: false, reason: "read_only" as const }
          : (await isChannelReadOnlyByQuota(attachment.channelId, req.serverId!))
          ? { canComment: false, reason: "read_only" as const }
          : (await channelService.canUserPostToChannel(attachment.channelId, req.userId!))
            ? { canComment: true, reason: "ok" as const }
            : { canComment: false, reason: "not_member" as const };
    res.json({ ...result, viewer });
  } catch (err) {
    sendJsonServerError(req, res, { error: "Failed to load comments", logPrefix: "Comment list error:", err });
  }
});

// Create a scoped comment: thread message via the normal message pipeline
// (broadcastAndDeliver) + ref row. WHO may post is decided here (channel
// member + not read-only); the service owns mechanics and state validation.
attachmentRouter.post("/:id/comments", async (req, res) => {
  try {
    if (rejectMalformedAttachmentId(req, res)) return;
    const db = getDb();
    const [projection] = await db
      .select()
      .from(attachments)
      .where(eq(attachments.id, req.params.id))
      .limit(1);
    const attachment = projection
      ? await resolveReadableAttachmentForRequest(projection, req)
      : null;
    if (!attachment) {
      res.status(404).json({ error: "Attachment not found" });
      return;
    }
    const content = req.body?.content;
    const mentions = parseStructuredMentions(req.body?.mentions);
    if (mentions === "invalid") {
      res.status(400).json({ error: "Invalid mentions payload", code: "mentions_invalid" });
      return;
    }
    const userId = req.userId!;
    const user = await userService.getUser(userId);
    const senderName = user?.displayName || user?.name || "User";
    const io = req.app.get("io");
    const agentOrchestrator = req.app.get("agentOrchestrator") as AgentOrchestrator;

    const result = await attachmentCommentService.createAttachmentComment(io, agentOrchestrator, {
      attachmentId: req.params.id,
      serverId: req.serverId!,
      senderType: "user",
      senderId: userId,
      senderName,
      content,
      anchor: req.body?.anchor,
      mentions,
      // Membership only — content/archived/quota gates live in the service
      // (single pipeline shared with the agent transport).
      authorize: async (parentChannelId) => {
        const canPost = await channelService.canUserPostToChannel(parentChannelId, userId);
        if (!canPost) {
          throw new attachmentCommentService.AttachmentCommentError(
            403,
            "not_a_member",
            "You must join this channel to comment",
          );
        }
      },
    });
    res.json(result);
  } catch (err) {
    if (err instanceof attachmentCommentService.AttachmentCommentError) {
      res.status(err.status).json({ error: err.message, code: err.code });
      return;
    }
    if (err instanceof DmPeerNotMemberError) {
      res.status(err.status).json({ error: err.message, code: err.code });
      return;
    }
    sendJsonServerError(req, res, { error: "Failed to create comment", logPrefix: "Comment create error:", err });
  }
});

// Return a short-lived presigned URL for an attachment (JSON, no redirect).
// Used by the frontend to download attachments without putting JWTs in query strings.
const MAX_ATTACHMENT_URL_BATCH = 50;
const ATTACHMENT_UUID_RE = UUID_RE;

/**
 * Reject a malformed `:id` before it reaches a `uuid` column.
 *
 * `attachments.id` is `uuid`, so a non-UUID path segment does not miss — it
 * makes Postgres raise a cast error, which the route's catch turns into
 * `500 Failed to serve attachment`. That reports a client-side typo as a server
 * fault, and it is what made the 2026-08-02 upload incident hard to read: the
 * 500s were the signal that the ids were not UUID-shaped, but the body blamed
 * the server. The batch route already filters ids through `ATTACHMENT_UUID_RE`;
 * the single-id routes did not.
 *
 * Returns `true` if the request was rejected (response already sent).
 */
function rejectMalformedAttachmentId(req: Request, res: Response): boolean {
  const id = req.params.id;
  if (typeof id === "string" && ATTACHMENT_UUID_RE.test(id)) return false;
  res.status(400).json({
    error: "A valid attachment id is required",
    code: "invalid_attachment_id",
  });
  return true;
}

// Batch URL resolution.
//
// One request per attachment does not scale with the UI: a message with N
// images costs N requests, the same attachments rendered again in a forward
// preview cost N more, and an attachment-dense channel trips the 120/min
// download limiter — the images then render as broken files. Resolving a
// message's attachments in one call keeps the request count proportional to
// messages rather than to images.
//
// Access is still checked per attachment: a batch must not become a way to
// read something the caller could not read individually.
attachmentPublicRouter.post("/urls", async (req, res) => {
  try {
    const rawIds = (req.body as { attachmentIds?: unknown })?.attachmentIds;
    if (!Array.isArray(rawIds) || rawIds.length === 0) {
      res.status(400).json({ error: "attachmentIds is required" });
      return;
    }
    const ids = [...new Set(rawIds.filter((id): id is string => typeof id === "string" && ATTACHMENT_UUID_RE.test(id)))];
    if (ids.length === 0 || ids.length > MAX_ATTACHMENT_URL_BATCH) {
      res.status(400).json({ error: `attachmentIds must hold 1..${MAX_ATTACHMENT_URL_BATCH} valid ids` });
      return;
    }

    const db = getDb();
    const projections = await db.select().from(attachments).where(inArray(attachments.id, ids));
    const storage = getStorage();
    if (!storage) {
      res.status(503).json({ error: "File storage is not configured on this server" });
      return;
    }

    const results = await Promise.all(projections.map(async (projection) => {
      const attachment = await resolveReadableAttachmentForRequest(projection, req);
      // Denied entries are simply omitted; the caller learns nothing about them
      // beyond "no url", exactly as a per-attachment 403 would leave it.
      if (!attachment) return null;
      if (storage.getPresignedUrl && !shouldStreamAttachmentThroughServerForRequest(req)) {
        const expiresIn = ATTACHMENT_PRESIGNED_URL_TTL_SECONDS;
        const url = await storage.getPresignedUrl(attachment.storageKey, {
          expiresIn,
          responseContentDisposition: buildAttachmentInlinePreviewContentDisposition(attachment.filename, attachment.mimeType),
        });
        // expiresAt is intentionally omitted: the caller treats a missing value
        // as "no client-side expiry" and refetches on load failure, which keeps
        // this route free of an ambient clock read.
        return { id: attachment.id, url, expiresAt: null };
      }
      const serverUrl = getAttachmentStreamingBaseUrl(req);
      const url = new URL(`${serverUrl}/api/attachments/${attachment.id}`);
      const authHeader = req.headers.authorization;
      const queryToken = typeof req.query.token === "string" ? req.query.token : null;
      if (authHeader?.startsWith("Bearer ")) url.searchParams.set("token", authHeader.slice(7));
      else if (queryToken) url.searchParams.set("token", queryToken);
      if (req.serverId) url.searchParams.set("serverId", req.serverId);
      url.searchParams.set("disposition", "inline");
      return { id: attachment.id, url: url.toString(), expiresAt: null };
    }));

    res.json({ urls: results.filter((r): r is NonNullable<typeof r> => r !== null) });
  } catch (err) {
    sendJsonServerError(req, res, { error: "Failed to resolve attachment urls", logPrefix: "Batch attachment URL resolution failed:", err });
  }
});

attachmentPublicRouter.get("/:id/url", async (req, res) => {
  if (rejectMalformedAttachmentId(req, res)) return;
  try {
    const db = getDb();
    const [projection] = await db
      .select()
      .from(attachments)
      .where(eq(attachments.id, req.params.id as string))
      .limit(1);

    if (!projection) {
      res.status(404).json({ error: "Attachment not found" });
      return;
    }
    const attachment = await resolveReadableAttachmentForRequest(projection, req);
    if (!attachment) {
      res.status(404).json({ error: "Attachment not found" });
      return;
    }

    const storage = getStorage();
    if (!storage) {
      res.status(503).json({ error: "File storage is not configured on this server" });
      return;
    }

    if (storage.getPresignedUrl && !shouldStreamAttachmentThroughServerForRequest(req)) {
      const expiresIn = attachmentUrlTtlSecondsForRequest(req, attachment.filename, attachment.mimeType);
      const url = await storage.getPresignedUrl(attachment.storageKey, {
        expiresIn,
        responseContentDisposition: buildAttachmentContentDispositionForRequest(req, attachment.filename, attachment.mimeType),
        responseContentType: buildAttachmentResponseContentType(resolveAttachmentMimeType(attachment.filename, attachment.mimeType)),
      });
      res.json({
        url,
        expiresAt: new Date(Date.now() + expiresIn * 1000).toISOString(),
      });
      return;
    }

    // Local storage fallback: build absolute URL to the streaming endpoint.
    // `<img src>` / new-tab downloads cannot set headers, so embed both
    // token and serverId as query params. `requireServerForFlex` accepts
    // `serverId` from the query for exactly this path, and `requireFlexAuth`
    // accepts the token from the query — so when the caller ITSELF reached
    // this endpoint via `?token=...&serverId=...` (two-hop fresh-tab flow),
    // propagate the query token rather than dropping it. Spotted by @Cody
    // in PR #945 review.
    const serverUrl = getAttachmentStreamingBaseUrl(req);
    const url = new URL(`${serverUrl}/api/attachments/${attachment.id}`);
    const authHeader = req.headers.authorization;
    const queryToken = typeof req.query.token === "string" ? req.query.token : null;
    if (authHeader?.startsWith("Bearer ")) {
      url.searchParams.set("token", authHeader.slice(7));
    } else if (queryToken) {
      url.searchParams.set("token", queryToken);
    }
    if (req.serverId) {
      url.searchParams.set("serverId", req.serverId);
    }
    if (shouldUseDownloadDisposition(req)) {
      url.searchParams.set("disposition", "attachment");
    } else if (shouldUseInlinePreviewDisposition(req, attachment.filename, attachment.mimeType)) {
      url.searchParams.set("disposition", "inline");
    }
    res.json({ url: url.toString(), expiresAt: null });
  } catch (err) {
    sendJsonServerError(req, res, { error: "Failed to get attachment URL", logPrefix: "[Attachments] Failed to url attachment", err });
  }
});

/** Coarse source-size class for preview traces: no ids, names or exact sizes. */
function attachmentPreviewSizeBucket(sizeBytes: number): string {
  if (sizeBytes < 100 * 1024) return "<100KB";
  if (sizeBytes < 1024 * 1024) return "100KB-1MB";
  if (sizeBytes <= 10 * 1024 * 1024) return "1-10MB";
  return ">10MB";
}

/** generated / cache_hit / capped (over a size limit) / unsupported. */
function attachmentPreviewTraceOutcome(response: AttachmentPreviewResponse, cache: AttachmentPreviewCacheOutcome): string {
  if (response.status === "unsupported") return response.reason === "too_large" ? "capped" : "unsupported";
  return cache === "hit" || cache === "shared" ? "cache_hit" : "generated";
}

attachmentPublicRouter.get("/:id/preview", async (req, res) => {
  if (rejectMalformedAttachmentId(req, res)) return;
  try {
    const db = getDb();
    const [projection] = await db
      .select()
      .from(attachments)
      .where(eq(attachments.id, req.params.id as string))
      .limit(1);

    if (!projection) {
      res.status(404).json({ error: "Attachment not found" });
      return;
    }
    const attachment = await resolveReadableAttachmentForRequest(projection, req);
    if (!attachment) {
      res.status(404).json({ error: "Attachment not found" });
      return;
    }

    res.setHeader("Cache-Control", "private, no-store");
    // Access is checked above; the cache below only saves CPU (task #19).
    const previewKind = getAttachmentPreviewProvider(attachment)?.kind ?? "unsupported";
    const result = await withTraceChildSpan(
      "server.attachment_preview.build",
      { surface: "server", kind: "internal", attrs: { preview_kind: previewKind, size_bucket: attachmentPreviewSizeBucket(attachment.sizeBytes) } },
      () => getAttachmentPreviewWithCache(attachment),
      {
        onSuccess: (built) => ({
          outcome: attachmentPreviewTraceOutcome(built.response, built.cache),
          cache: built.cache,
          ...(built.computeMs === null ? {} : { compute_ms: built.computeMs }),
          ...(built.fetchMs === undefined ? {} : { fetch_ms: built.fetchMs }),
          ...(built.parseMs === undefined ? {} : { parse_ms: built.parseMs }),
        }),
      },
    );
    // `?view=summary` is the attachment card's read (task #164): the kind and
    // stats line only, never the document body. Same build and cache.
    res.json(req.query.view === "summary" ? summarizeAttachmentPreviewResponse(result.response) : result.response);
  } catch (err) {
    // A missing storage object is a 404, not a server fault: the attachment
    // row outlived its object (lifecycle sweep, manual bucket edit, staging
    // residue). Mirrors the "Attachment not found" branches above.
    if (isStorageNotFoundError(err)) {
      res.status(404).json({ error: "Attachment not found" });
      return;
    }
    sendJsonServerError(req, res, { error: "Failed to build attachment preview", logPrefix: "[Attachments] Failed to preview attachment", err });
  }
});

// Return an authenticated URL for rendering a single-file HTML attachment in
// a sandboxed iframe. Threat model: any server member or agent can upload HTML,
// so the preview assumes hostile input. Scripts are allowed for Mermaid/diagram
// use cases, but the document must not receive Slock origin privileges or affect
// the parent window. The iframe omits allow-same-origin on the client; this
// endpoint keeps ACL checks and preview-only security headers server-side.
attachmentPublicRouter.get("/:id/html-preview-url", async (req, res) => {
  if (rejectMalformedAttachmentId(req, res)) return;
  try {
    const db = getDb();
    const [projection] = await db
      .select()
      .from(attachments)
      .where(eq(attachments.id, req.params.id as string))
      .limit(1);

    if (!projection) {
      res.status(404).json({ error: "Attachment not found" });
      return;
    }
    const attachment = await resolveReadableAttachmentForRequest(projection, req);
    if (!attachment) {
      res.status(404).json({ error: "Attachment not found" });
      return;
    }

    if (!isHtmlAttachmentMimeType(resolveAttachmentMimeType(attachment.filename, attachment.mimeType))) {
      res.status(415).json({ error: "Attachment is not previewable HTML" });
      return;
    }

    const { url, expiresAt } = buildHtmlPreviewUrl(req, attachment);
    res.json({ url: url.toString(), expiresAt });
  } catch (err) {
    sendJsonServerError(req, res, { error: "Failed to get HTML preview URL", logPrefix: "[Attachments] Failed to url attachment", err });
  }
});

// Stream HTML through Slock rather than redirecting to object storage so the
// preview path always carries the sandbox-oriented headers below. Normal
// downloads intentionally still use `attachment` disposition.
attachmentPublicRouter.get("/:id/html-preview", async (req, res) => {
  if (rejectMalformedAttachmentId(req, res)) return;
  let attachmentForLog: (typeof attachments.$inferSelect & Partial<AttachmentObjectMetadata>) | null = null;
  let streamFailureLogged = false;
  try {
    const db = getDb();
    const [projection] = await db
      .select()
      .from(attachments)
      .where(eq(attachments.id, req.params.id as string))
      .limit(1);
    attachmentForLog = projection ?? null;

    if (!projection) {
      res.status(404).json({ error: "Attachment not found" });
      return;
    }

    const previewToken = typeof req.query.previewToken === "string" ? req.query.previewToken : null;
    const tokenClaims = previewToken
      ? verifyHtmlPreviewToken(previewToken, projection.id, req.serverId)
      : null;

    const attachment = await resolveReadableAttachmentForRequest(
      projection,
      req,
      tokenClaims ? { type: tokenClaims.actorType, id: tokenClaims.actorId } : undefined,
    );
    if (!attachment) {
      res.status(404).json({ error: "Attachment not found" });
      return;
    }
    attachmentForLog = attachment;

    // Resolve visibility before returning token-shape errors. Otherwise an
    // authenticated caller can add an invalid previewToken (or a user bearer
    // query token) and distinguish an existing inaccessible UUID from a
    // nonexistent UUID by 403 versus 404.
    if (previewToken && !tokenClaims) {
      res.status(403).json({ error: "Invalid attachment preview token" });
      return;
    }

    if (!previewToken && typeof req.query.token === "string") {
      res.status(403).json({ error: "User bearer query tokens cannot authorize HTML preview" });
      return;
    }

    const resolvedMimeType = resolveAttachmentMimeType(attachment.filename, attachment.mimeType);
    if (!isHtmlAttachmentMimeType(resolvedMimeType)) {
      res.status(415).json({ error: "Attachment is not previewable HTML" });
      return;
    }

    const storage = getStorage();
    if (!storage) {
      res.status(503).json({ error: "File storage is not configured on this server" });
      return;
    }

    const stream = await storage.get(attachment.storageKey);
    res.setHeader("Cache-Control", "private, no-store");
    res.setHeader("Content-Type", buildAttachmentResponseContentType(resolvedMimeType));
    res.setHeader("Content-Security-Policy", buildHtmlPreviewContentSecurityPolicy());
    res.setHeader("Referrer-Policy", "no-referrer");
    // Helmet's default SAMEORIGIN header would block the web app from framing
    // the API-origin preview document. CSP frame-ancestors above is the
    // allowlist source of truth for this sandbox-only endpoint.
    res.removeHeader("X-Frame-Options");
    res.setHeader("X-Content-Type-Options", "nosniff");
    res.setHeader("Content-Disposition", buildContentDisposition("inline", attachment.filename));
    // Measurement bridge (task #16): normally appended, but inserted before
    // an attachment-owned CSP meta tag so a strict report can still announce
    // bridge readiness. The attachment CSP remains in place for every later
    // byte; downloads/storage stay untouched. No Content-Length is set because
    // the preview response contains extra bridge bytes.
    const previewStream = createAttachmentPreviewBridgeTransform();
    const logStreamFailure = (streamError: unknown) => {
      // A destination abort destroys the upstream after the response closes;
      // an upstream/transform failure fires here first and remains observable.
      if (res.destroyed || streamFailureLogged) return;
      streamFailureLogged = true;
      logAttachmentAccessError("serve", req.params.id, streamError, attachmentForLog);
    };
    stream.once("error", logStreamFailure);
    previewStream.once("error", logStreamFailure);
    await streamStorageResponseThrough(stream, previewStream, res);
  } catch (err) {
    if (!streamFailureLogged && !res.destroyed && !res.headersSent) {
      logAttachmentAccessError("serve", req.params.id, err, attachmentForLog);
    }
    if (res.destroyed || res.headersSent) return;
    if (isStorageNotFoundError(err)) {
      res.status(404).json({ error: "Attachment not found" });
      return;
    }
    res.status(500).json({ error: "Failed to serve HTML preview" });
  }
});

// Serve an attachment by UUID (requires auth via requireFlexAuth)
attachmentPublicRouter.get("/:id", async (req, res) => {
  if (rejectMalformedAttachmentId(req, res)) return;
  let attachmentForLog: (typeof attachments.$inferSelect & Partial<AttachmentObjectMetadata>) | null = null;
  try {
    const db = getDb();
    const [projection] = await db
      .select()
      .from(attachments)
      .where(eq(attachments.id, req.params.id as string))
      .limit(1);
    attachmentForLog = projection ?? null;

    if (!projection) {
      res.status(404).json({ error: "Attachment not found" });
      return;
    }
    const attachment = await resolveReadableAttachmentForRequest(projection, req);
    if (!attachment) {
      res.status(404).json({ error: "Attachment not found" });
      return;
    }
    attachmentForLog = attachment;

    const storage = getStorage();
    if (!storage) {
      res.status(503).json({ error: "File storage is not configured on this server" });
      return;
    }

    // S3: redirect to presigned URL for direct access (no server bandwidth).
    // Download-as-image captures need same-origin readable bytes so the web
    // client can inline protected images as data URLs before rasterizing.
    if (storage.getPresignedUrl && !shouldStreamAttachmentThroughServerForRequest(req)) {
      const presignedUrl = await storage.getPresignedUrl(attachment.storageKey, {
        expiresIn: ATTACHMENT_PRESIGNED_URL_TTL_SECONDS,
        responseContentDisposition: buildAttachmentContentDispositionForRequest(req, attachment.filename, attachment.mimeType),
        responseContentType: buildAttachmentResponseContentType(resolveAttachmentMimeType(attachment.filename, attachment.mimeType)),
      });
      res.redirect(302, presignedUrl);
      return;
    }

    // Local storage fallback and select-screenshot protected proxy: stream
    // through the app server so auth headers and same-origin CORS stay intact.
    const useInlinePreviewDisposition = shouldUseInlinePreviewDisposition(req, attachment.filename, attachment.mimeType);
    const contentType = buildAttachmentResponseContentType(resolveAttachmentMimeType(attachment.filename, attachment.mimeType));
    const contentDisposition = buildAttachmentContentDispositionForRequest(req, attachment.filename, attachment.mimeType);
    const contentLength = buildAttachmentContentLengthHeader(attachment.sizeBytes);
    const getRange = storage.getRange?.bind(storage);
    const requestedRange = getRange ? parseAttachmentByteRange(req.headers.range, attachment.sizeBytes) : null;
    if (requestedRange === "unsatisfiable") {
      if (contentLength) {
        res.setHeader("Content-Range", `bytes */${contentLength}`);
      }
      res.status(416).end();
      return;
    }
    const stream = requestedRange
      ? await getRange!(attachment.storageKey, requestedRange.start, requestedRange.end)
      : await storage.get(attachment.storageKey);
    res.setHeader("Cache-Control", "private, immutable, max-age=31536000");
    res.setHeader("Content-Type", contentType);
    if (contentLength) {
      res.setHeader("Accept-Ranges", "bytes");
      if (requestedRange) {
        res.status(206);
        res.setHeader("Content-Range", `bytes ${requestedRange.start}-${requestedRange.end}/${requestedRange.size}`);
        res.setHeader("Content-Length", String(requestedRange.end - requestedRange.start + 1));
      } else {
        res.setHeader("Content-Length", contentLength);
      }
    }
    res.setHeader("X-Content-Type-Options", "nosniff");
    res.setHeader("Content-Disposition", contentDisposition);
    if (useInlinePreviewDisposition) {
      // Helmet's default SAMEORIGIN header blocks local API-origin PDFs from
      // being framed by the web app during development. Inline preview URLs are
      // still ACL/token scoped; downloads continue to use attachment disposition.
      res.removeHeader("X-Frame-Options");
      res.setHeader("Content-Security-Policy", buildAttachmentInlinePreviewContentSecurityPolicy());
      res.setHeader("Cross-Origin-Resource-Policy", "cross-origin");
      res.setHeader("Referrer-Policy", "no-referrer");
    } else if (
      !shouldUseDownloadDisposition(req)
      && isPreviewableImageMimeType(resolveAttachmentMimeType(attachment.filename, attachment.mimeType))
    ) {
      // An inline image is an <img> in the web app, which a self-hosted
      // deployment may serve from another origin or site than this API.
      // Helmet's same-origin CORP would block it there (presigned storage
      // URLs carry no CORP). The URL is still token/ACL scoped, as for the
      // inline previews above; downloads keep the default.
      res.setHeader("Cross-Origin-Resource-Policy", "cross-origin");
    }
    await streamStorageResponse(stream, res);
  } catch (err) {
    if (res.destroyed || res.headersSent) return;
    logAttachmentAccessError("serve", req.params.id, err, attachmentForLog);
    if (isStorageNotFoundError(err)) {
      res.status(404).json({ error: "Attachment not found" });
      return;
    }
    res.status(500).json({ error: "Failed to serve attachment" });
  }
});

/**
 * Batch-fetch attachments for a list of message IDs.
 * Returns a map: messageId → attachment[]
 */
export async function getAttachmentsForMessages(
  messageIds: string[]
): Promise<Map<string, ResolvedAttachment[]>> {
  return getAttachmentsForMessagesWithExecutor(getDb(), messageIds);
}
