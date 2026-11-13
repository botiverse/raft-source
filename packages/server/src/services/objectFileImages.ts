// What core does to an image before it keeps it as an object file
// (services/objectFiles.ts putObjectFile; docs/development/first-party-apps.md,
// "Object files"):
//
// - its pixel size, read from the header alone (PNG's IHDR, a JPEG's SOF
//   marker, WebP's VP8/VP8L/VP8X chunk, GIF's logical screen), before any
//   pixel is decoded: more than OBJECT_FILE_MAX_PIXELS is refused, so a small
//   file that would decode to gigabytes (a decode bomb) never reaches sharp,
//   nor a browser;
// - its metadata removed, whoever uploads it: JPEG and WebP are encoded again
//   (sharp keeps no EXIF, XMP or ICC profile by default and converts colour
//   to sRGB; a JPEG's EXIF orientation is applied first, so a phone photo
//   stays upright), PNG keeps only the chunks drawing it needs and its pixel
//   data byte for byte (never encoded again: screenshots stay lossless), GIF
//   stays as it is (animations survive). The size answered is that of what is
//   kept.
import sharp from "sharp";
import type { ObjectFileContentType } from "../db/schema";
import { withImageDecodeSlot } from "../lib/imageDecodeLimit";

/** The most pixels (width × height of the header) an image core keeps may have. */
export const OBJECT_FILE_MAX_PIXELS = 40_000_000;

/** JPEG and WebP are encoded again at this quality (a lossless WebP stays lossless). */
const REENCODE_QUALITY = 90;

export interface ImageSize {
  width: number;
  height: number;
}

/** Why an image isn't kept: its header or bytes aren't an image of its type, or it has too many pixels. */
export type ImageRefusal = "unsupported_type" | "too_many_pixels";

export class ImageRefusedError extends Error {
  constructor(readonly reason: ImageRefusal) {
    super(reason);
    this.name = "ImageRefusedError";
  }
}

const sized = (width: number, height: number): ImageSize | null => (width > 0 && height > 0 ? { width, height } : null);

/**
 * The chunks a PNG keeps: what a browser needs to draw it (its header,
 * palette and transparency, the pixel data, the end; colour space and gamma,
 * which change how it looks; an animated PNG's frames). Everything else
 * (tEXt, zTXt, iTXt, eXIf, tIME, pHYs, any private chunk) is left out.
 */
const PNG_KEPT_CHUNKS = new Set(["IHDR", "PLTE", "tRNS", "IDAT", "IEND", "gAMA", "cHRM", "sRGB", "iCCP", "cICP", "sBIT", "acTL", "fcTL", "fdAT"]);
const PNG_SIGNATURE_BYTES = 8;

interface PngChunk {
  type: string;
  /** The whole chunk: length, type, data and CRC. */
  bytes: Buffer;
  data: Buffer;
}

/** A PNG's chunks up to and including IEND (whatever follows it is not read), or null when they don't parse. */
function pngChunks(bytes: Buffer): PngChunk[] | null {
  const chunks: PngChunk[] = [];
  let at = PNG_SIGNATURE_BYTES;
  while (at + 12 <= bytes.length) {
    const length = bytes.readUInt32BE(at);
    const end = at + 12 + length;
    if (length > 0x7fffffff || end > bytes.length) return null;
    const type = bytes.toString("latin1", at + 4, at + 8);
    if (!/^[A-Za-z]{4}$/.test(type)) return null;
    chunks.push({ type, bytes: bytes.subarray(at, end), data: bytes.subarray(at + 8, at + 8 + length) });
    if (type === "IEND") return chunks;
    at = end;
  }
  return null;
}

/** A JPEG's frame size from its first SOF marker, walking the markers before it; null when there is none before the scan. */
function jpegSize(bytes: Buffer): ImageSize | null {
  let at = 2;
  while (at + 4 <= bytes.length) {
    if (bytes[at] !== 0xff) return null;
    const marker = bytes[at + 1]!;
    // Fill bytes before a marker.
    if (marker === 0xff) {
      at += 1;
      continue;
    }
    // Markers without a length (RSTn, TEM).
    if ((marker >= 0xd0 && marker <= 0xd7) || marker === 0x01) {
      at += 2;
      continue;
    }
    // The scan or the end before any frame header.
    if (marker === 0xda || marker === 0xd9) return null;
    const length = bytes.readUInt16BE(at + 2);
    if (length < 2) return null;
    // SOF0..SOF15, except DHT (C4), JPG (C8) and DAC (CC).
    if (marker >= 0xc0 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc) {
      if (at + 9 > bytes.length || length < 7) return null;
      return sized(bytes.readUInt16BE(at + 7), bytes.readUInt16BE(at + 5));
    }
    at += 2 + length;
  }
  return null;
}

interface WebpChunk {
  fourcc: string;
  data: Buffer;
}

/** RIFF chunks from `start` (a WebP's top-level ones after `RIFF <size> WEBP`: 12), or null when they don't parse. */
function webpChunks(bytes: Buffer, start = 12): WebpChunk[] | null {
  const chunks: WebpChunk[] = [];
  let at = start;
  while (at + 8 <= bytes.length) {
    const size = bytes.readUInt32LE(at + 4);
    if (at + 8 + size > bytes.length) return null;
    chunks.push({ fourcc: bytes.toString("latin1", at, at + 4), data: bytes.subarray(at + 8, at + 8 + size) });
    // Chunks are padded to an even size.
    at += 8 + size + (size % 2);
  }
  return chunks.length > 0 ? chunks : null;
}

/** A WebP's canvas size from its first chunk (VP8X's canvas, or the one frame's VP8 or VP8L header). */
function webpSize(bytes: Buffer): ImageSize | null {
  const first = webpChunks(bytes)?.[0];
  if (!first) return null;
  const { fourcc, data } = first;
  if (fourcc === "VP8X" && data.length >= 10) return sized(1 + data.readUIntLE(4, 3), 1 + data.readUIntLE(7, 3));
  if (fourcc === "VP8 " && data.length >= 10 && data[3] === 0x9d && data[4] === 0x01 && data[5] === 0x2a) {
    return sized(data.readUInt16LE(6) & 0x3fff, data.readUInt16LE(8) & 0x3fff);
  }
  if (fourcc === "VP8L" && data.length >= 5 && data[0] === 0x2f) {
    const bits = data.readUInt32LE(1);
    return sized((bits & 0x3fff) + 1, ((bits >>> 14) & 0x3fff) + 1);
  }
  return null;
}

/** Whether a WebP's (first) frame is lossless (VP8L), so encoding it again keeps it so. */
function webpIsLossless(bytes: Buffer): boolean {
  for (const chunk of webpChunks(bytes) ?? []) {
    if (chunk.fourcc === "VP8L") return true;
    if (chunk.fourcc === "VP8 ") return false;
    // An animation's frame: its header (16 bytes), then its own chunks (ALPH, then VP8 or VP8L).
    if (chunk.fourcc === "ANMF") return (webpChunks(chunk.data, 16) ?? []).some((frame) => frame.fourcc === "VP8L");
  }
  return false;
}

/**
 * The pixel size an image's header declares, read without decoding any
 * pixel; null when the header doesn't parse (truncated, malformed, a size of
 * 0). A JPEG's EXIF orientation is not applied here.
 */
export function imageHeaderSize(bytes: Buffer, type: ObjectFileContentType): ImageSize | null {
  switch (type) {
    case "image/png": {
      // IHDR is the first chunk: its data is width, height, then 5 bytes.
      if (bytes.length < 33 || bytes.readUInt32BE(8) !== 13 || bytes.toString("latin1", 12, 16) !== "IHDR") return null;
      return sized(bytes.readUInt32BE(16), bytes.readUInt32BE(20));
    }
    case "image/gif":
      return bytes.length >= 10 ? sized(bytes.readUInt16LE(6), bytes.readUInt16LE(8)) : null;
    case "image/jpeg":
      return jpegSize(bytes);
    case "image/webp":
      return webpSize(bytes);
  }
}

/** A PNG with only PNG_KEPT_CHUNKS, every kept chunk (IDAT included) byte for byte; null when its chunks don't parse. */
export function pngWithoutMetadata(bytes: Buffer): Buffer | null {
  const chunks = pngChunks(bytes);
  if (!chunks || chunks[0]?.type !== "IHDR" || !chunks.some((chunk) => chunk.type === "IDAT")) return null;
  return Buffer.concat([bytes.subarray(0, PNG_SIGNATURE_BYTES), ...chunks.filter((chunk) => PNG_KEPT_CHUNKS.has(chunk.type)).map((chunk) => chunk.bytes)]);
}

const isPixelLimitError = (error: unknown): boolean => /pixel limit/i.test(error instanceof Error ? error.message : String(error));

/** Encode a JPEG or WebP again with sharp (no metadata kept), its pixels bounded before decoding, in an image-decode slot. */
async function reencode(bytes: Buffer, type: "image/jpeg" | "image/webp"): Promise<Buffer> {
  try {
    return await withImageDecodeSlot(async () => {
      if (type === "image/jpeg") {
        return await sharp(bytes, { limitInputPixels: OBJECT_FILE_MAX_PIXELS }).rotate().jpeg({ quality: REENCODE_QUALITY }).toBuffer();
      }
      // Every frame of an animation (sharp's pixel limit counts them all together).
      return await sharp(bytes, { limitInputPixels: OBJECT_FILE_MAX_PIXELS, animated: true })
        .webp(webpIsLossless(bytes) ? { lossless: true } : { quality: REENCODE_QUALITY })
        .toBuffer();
    });
  } catch (error) {
    throw new ImageRefusedError(isPixelLimitError(error) ? "too_many_pixels" : "unsupported_type");
  }
}

/**
 * The image core keeps for `bytes` (of the type their first bytes say):
 * its header read first (ImageRefusedError `unsupported_type` when it doesn't
 * parse, `too_many_pixels` over OBJECT_FILE_MAX_PIXELS, before any decoding),
 * then its metadata removed (the file's header). The size answered is the
 * kept image's (a JPEG's after its orientation is applied).
 */
export async function keptImage(bytes: Buffer, type: ObjectFileContentType): Promise<{ bytes: Buffer } & ImageSize> {
  const header = imageHeaderSize(bytes, type);
  if (!header) throw new ImageRefusedError("unsupported_type");
  if (header.width * header.height > OBJECT_FILE_MAX_PIXELS) throw new ImageRefusedError("too_many_pixels");
  switch (type) {
    case "image/gif":
      return { bytes, ...header };
    case "image/png": {
      const kept = pngWithoutMetadata(bytes);
      if (!kept) throw new ImageRefusedError("unsupported_type");
      return { bytes: kept, ...header };
    }
    case "image/jpeg":
    case "image/webp": {
      const kept = await reencode(bytes, type);
      const size = imageHeaderSize(kept, type);
      if (!size) throw new Error(`object files: sharp wrote a ${type} whose header doesn't parse`);
      return { bytes: kept, ...size };
    }
  }
}
