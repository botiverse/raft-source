// Real images for the object file tests (services/objectFiles.ts keeps only
// images whose header parses and whose metadata it can remove): a PNG built
// chunk by chunk (sync, so a test can name its chunks), and JPEG, WebP and
// GIF made by sharp. Each label gives other pixels, so two labels are two
// different files.
import { createHash } from "node:crypto";
import { crc32, deflateSync } from "node:zlib";
import sharp from "sharp";

export const PNG_SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

/** One PNG chunk: its length, type, data and CRC. */
export function pngChunk(type: string, data: Buffer = Buffer.alloc(0)): Buffer {
  const length = Buffer.alloc(4);
  length.writeUInt32BE(data.length);
  const typed = Buffer.concat([Buffer.from(type, "latin1"), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(typed));
  return Buffer.concat([length, typed, crc]);
}

/** A PNG's chunks, in order, as [type, whole chunk] (after the signature, up to IEND). */
export function pngChunksOf(bytes: Buffer): Array<{ type: string; bytes: Buffer }> {
  const chunks: Array<{ type: string; bytes: Buffer }> = [];
  for (let at = PNG_SIGNATURE.length; at + 12 <= bytes.length;) {
    const end = at + 12 + bytes.readUInt32BE(at);
    const type = bytes.toString("latin1", at + 4, at + 8);
    chunks.push({ type, bytes: bytes.subarray(at, end) });
    if (type === "IEND") break;
    at = end;
  }
  return chunks;
}

const seedOf = (label: string) => createHash("sha256").update(label).digest();

/**
 * An RGB PNG of `width` × `height` (default 2 × 2) whose pixels come from
 * `label`; `before` are chunks put after IHDR, `after` before IEND (text,
 * EXIF, time...). `padTo`: a second IDAT chunk (never decoded by the Server)
 * makes the file exactly that many bytes. `header` alone: a file with just
 * the signature and IHDR (a header for a size, no pixels at all).
 */
export function testPng(label = "", opts: { width?: number; height?: number; before?: Buffer[]; after?: Buffer[]; padTo?: number; header?: true } = {}): Buffer {
  const width = opts.width ?? 2;
  const height = opts.height ?? 2;
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 2; // RGB
  const head = Buffer.concat([PNG_SIGNATURE, pngChunk("IHDR", ihdr)]);
  if (opts.header) return head;
  const seed = seedOf(label);
  const rows: Buffer[] = [];
  for (let y = 0; y < height; y += 1) {
    const row = Buffer.alloc(1 + width * 3);
    for (let x = 0; x < width * 3; x += 1) row[1 + x] = seed[(y * width * 3 + x) % seed.length]!;
    rows.push(row);
  }
  const body = [...(opts.before ?? []), pngChunk("IDAT", deflateSync(Buffer.concat(rows))), ...(opts.after ?? [])];
  const end = pngChunk("IEND");
  const size = head.length + body.reduce((sum, chunk) => sum + chunk.length, 0) + end.length;
  if (opts.padTo !== undefined) {
    if (opts.padTo < size + 12) throw new Error(`testPng: ${opts.padTo} bytes is less than the smallest padded file (${size + 12})`);
    body.push(pngChunk("IDAT", Buffer.alloc(opts.padTo - size - 12, 0x5a)));
  }
  return Buffer.concat([head, ...body, end]);
}

/** A solid image of `label`'s colour, `width` × `height` (default 4 × 2), as sharp makes it. */
function solid(label: string, width: number, height: number) {
  const [r, g, b] = seedOf(label);
  return sharp({ create: { width, height, channels: 3, background: { r: r!, g: g!, b: b! } } });
}

/** A JPEG; `exif` writes EXIF into it (IFD0 tags, and its `orientation`). */
export async function testJpeg(label = "", opts: { width?: number; height?: number; orientation?: number; exif?: Record<string, string> } = {}): Promise<Buffer> {
  let image = solid(label, opts.width ?? 4, opts.height ?? 2).jpeg();
  if (opts.orientation !== undefined) image = image.withMetadata({ orientation: opts.orientation });
  if (opts.exif) image = image.withExifMerge({ IFD0: opts.exif });
  return image.toBuffer();
}

/** A WebP (lossy, or `lossless`); `exif` writes EXIF into it. */
export async function testWebp(label = "", opts: { width?: number; height?: number; lossless?: boolean; exif?: Record<string, string> } = {}): Promise<Buffer> {
  let image = solid(label, opts.width ?? 4, opts.height ?? 2).webp(opts.lossless ? { lossless: true } : {});
  if (opts.exif) image = image.withExif({ IFD0: opts.exif });
  return image.toBuffer();
}

/** A GIF. */
export function testGif(label = "", opts: { width?: number; height?: number } = {}): Promise<Buffer> {
  return solid(label, opts.width ?? 4, opts.height ?? 2).gif().toBuffer();
}

/**
 * A JPEG header (SOI, then a SOF0 marker) declaring `width` × `height`, and
 * nothing after it: no tables and no scan, so it can't be decoded. Its pixel
 * size is all there is to read.
 */
export function jpegHeaderOnly(width: number, height: number): Buffer {
  const sof = Buffer.from([0xff, 0xc0, 0x00, 0x11, 0x08, 0, 0, 0, 0, 0x03, 0x01, 0x22, 0x00, 0x02, 0x11, 0x01, 0x03, 0x11, 0x01]);
  sof.writeUInt16BE(height, 5);
  sof.writeUInt16BE(width, 7);
  return Buffer.concat([Buffer.from([0xff, 0xd8]), sof]);
}
