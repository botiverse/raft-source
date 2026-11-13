// A PNG screenshot, read just enough for the blank check (pageChecks.ts isBlank): the share
// of its pixels, sampled, that are the most common colour. Only what Chromium's screenshots
// are (8-bit RGB or RGBA, not interlaced) is read; anything else is null (unknown, never
// blank). Inflated with the runtime's DecompressionStream (Workers and Node alike), and only
// for a page with no text, so most checks never decode a shot.

const SIGNATURE = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];
/** Past this many pixels a shot is not decoded (a viewport shot at 2x is under 1.5 million). */
const MAX_PIXELS = 8_000_000;
/** About this many pixels are sampled, spread over the whole shot. */
const SAMPLES = 16_384;

/** Whether `bytes` starts like a PNG (what the server takes, checkTask.ts isCheckShot). */
export function isPng(bytes: Uint8Array): boolean {
  return bytes.length > SIGNATURE.length && SIGNATURE.every((byte, index) => bytes[index] === byte);
}

const u32 = (bytes: Uint8Array, at: number) => ((bytes[at]! << 24) | (bytes[at + 1]! << 16) | (bytes[at + 2]! << 8) | bytes[at + 3]!) >>> 0;

interface Header {
  width: number;
  height: number;
  channels: 3 | 4;
}

/** The header and the concatenated IDAT data, or null for a PNG this doesn't read. */
function chunksOf(bytes: Uint8Array): { header: Header; data: Uint8Array<ArrayBuffer> } | null {
  if (!isPng(bytes)) return null;
  let header: Header | null = null;
  const parts: Uint8Array[] = [];
  let at = SIGNATURE.length;
  while (at + 12 <= bytes.length) {
    const length = u32(bytes, at);
    const type = String.fromCharCode(bytes[at + 4]!, bytes[at + 5]!, bytes[at + 6]!, bytes[at + 7]!);
    const start = at + 8;
    if (start + length + 4 > bytes.length) return null;
    if (type === "IHDR") {
      if (length !== 13) return null;
      const width = u32(bytes, start);
      const height = u32(bytes, start + 4);
      const [bitDepth, colorType, compression, filter, interlace] = [bytes[start + 8], bytes[start + 9], bytes[start + 10], bytes[start + 11], bytes[start + 12]];
      if (bitDepth !== 8 || compression !== 0 || filter !== 0 || interlace !== 0) return null;
      if (colorType !== 2 && colorType !== 6) return null;
      if (width === 0 || height === 0 || width * height > MAX_PIXELS) return null;
      header = { width, height, channels: colorType === 2 ? 3 : 4 };
    } else if (type === "IDAT") {
      parts.push(bytes.subarray(start, start + length));
    } else if (type === "IEND") {
      break;
    }
    at = start + length + 4;
  }
  if (header === null || parts.length === 0) return null;
  const data = new Uint8Array(parts.reduce((sum, part) => sum + part.length, 0));
  let offset = 0;
  for (const part of parts) {
    data.set(part, offset);
    offset += part.length;
  }
  return { header, data };
}

async function inflate(data: Uint8Array<ArrayBuffer>): Promise<Uint8Array | null> {
  try {
    const stream = new Blob([data]).stream().pipeThrough(new DecompressionStream("deflate"));
    return new Uint8Array(await new Response(stream).arrayBuffer());
  } catch {
    return null;
  }
}

const paeth = (a: number, b: number, c: number) => {
  const p = a + b - c;
  const pa = Math.abs(p - a);
  const pb = Math.abs(p - b);
  const pc = Math.abs(p - c);
  return pa <= pb && pa <= pc ? a : pb <= pc ? b : c;
};

/** The share (0..1) of sampled pixels that are the shot's most common colour, or null when it can't be read. */
export async function uniformShare(bytes: Uint8Array): Promise<number | null> {
  const chunks = chunksOf(bytes);
  if (chunks === null) return null;
  const { width, height, channels } = chunks.header;
  const raw = await inflate(chunks.data);
  const stride = width * channels;
  if (raw === null || raw.length < height * (stride + 1)) return null;
  const step = Math.max(1, Math.floor(Math.sqrt((width * height) / SAMPLES)));
  let previous = new Uint8Array(stride);
  let current = new Uint8Array(stride);
  const counts = new Map<number, number>();
  let samples = 0;
  for (let y = 0; y < height; y += 1) {
    const rowAt = y * (stride + 1);
    const filter = raw[rowAt]!;
    for (let x = 0; x < stride; x += 1) {
      const value = raw[rowAt + 1 + x]!;
      const left = x >= channels ? current[x - channels]! : 0;
      const up = previous[x]!;
      const upLeft = x >= channels ? previous[x - channels]! : 0;
      switch (filter) {
        case 0: current[x] = value; break;
        case 1: current[x] = (value + left) & 0xff; break;
        case 2: current[x] = (value + up) & 0xff; break;
        case 3: current[x] = (value + ((left + up) >> 1)) & 0xff; break;
        case 4: current[x] = (value + paeth(left, up, upLeft)) & 0xff; break;
        default: return null;
      }
    }
    if (y % step === 0) {
      for (let x = 0; x < width; x += step) {
        const at = x * channels;
        const alpha = channels === 4 ? current[at + 3]! : 255;
        const key = ((current[at]! * 256 + current[at + 1]!) * 256 + current[at + 2]!) * 256 + alpha;
        counts.set(key, (counts.get(key) ?? 0) + 1);
        samples += 1;
      }
    }
    [previous, current] = [current, previous];
  }
  if (samples === 0) return null;
  let most = 0;
  for (const count of counts.values()) most = Math.max(most, count);
  return most / samples;
}
