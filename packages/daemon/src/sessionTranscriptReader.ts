import path from "node:path";
import { constants as fsConstants } from "node:fs";
import { lstat, open, realpath } from "node:fs/promises";
import zlib from "node:zlib";
import { redactDiagnosticText } from "@botiverse/raft-shared";

// Shared rule set (task #272): the previous local four-rule list let a bare
// JWT through. Transcripts keep dropping whole URLs, as they always have.
export function redactTranscript(text: string): string {
  return redactDiagnosticText(text, { urls: "drop" });
}

export async function isPathWithinAllowedRoots(filePath: string, roots: string[]): Promise<boolean> {
  const real = await realpath(filePath).catch(() => null);
  if (!real) return false;
  for (const root of roots) {
    const realRoot = await realpath(root).catch(() => null);
    if (!realRoot) continue;
    const rel = path.relative(realRoot, real);
    if (!rel.startsWith("..") && !path.isAbsolute(rel)) return true;
  }
  return false;
}

/** The path is not something the transcript reader may read (symlink, not a regular file). */
export class TranscriptPathRejectedError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "TranscriptPathRejectedError";
  }
}

/**
 * Why a compressed session file was not read. Daemon-side detail only: at the
 * shared contract it is `read_failed` (FeedbackTranscriptLookupReason).
 * - compressed_unsupported: this Node has no zstd (zlib.zstdDecompress, Node
 *   >= 22.15 / 23.8; the daemon requires 24).
 * - compressed_too_large: the compressed or decompressed size is over the
 *   decompression limit (a zstd bomb, or a rollout far over the read limit).
 * - compressed_corrupt: not a valid zstd stream.
 */
export type TranscriptReadFailureDetail = "compressed_unsupported" | "compressed_too_large" | "compressed_corrupt";

class TranscriptCompressedReadError extends Error {
  constructor(readonly detail: TranscriptReadFailureDetail, message: string) {
    super(message);
    this.name = "TranscriptCompressedReadError";
  }
}

/**
 * A compressed transcript is decompressed whole (the window is cut from its
 * plain bytes, as for a plain file), so its decompressed size is bounded: this
 * many times the read limit. A codex rollout up to it reads like the plain
 * file would (its tail, or the anchored window); a larger one is refused as
 * compressed_too_large rather than held in memory.
 */
export const ZSTD_TRANSCRIPT_DECOMPRESSED_LIMIT_FACTOR = 4;

/** Codex 0.16x compresses a cold rollout to `<rollout>.jsonl.zst`. */
const ZSTD_TRANSCRIPT_PATTERN = /\.jsonl\.zst$/i;

type PositionalReader = {
  read(buffer: Buffer, offset: number, length: number, position: number): Promise<{ bytesRead: number }>;
};

function bufferReader(data: Buffer): PositionalReader {
  return {
    async read(buffer, offset, length, position) {
      const bytesRead = Math.max(0, Math.min(length, data.length - position));
      data.copy(buffer, offset, position, position + bytesRead);
      return { bytesRead };
    },
  };
}

/**
 * Node's zstd decompressor, or undefined on a Node without one (typed as
 * present by @types/node, so checked at run time). A seam for tests.
 */
export const transcriptZstd: { decompress: typeof zlib.zstdDecompress | undefined } = {
  decompress: typeof zlib.zstdDecompress === "function" ? zlib.zstdDecompress : undefined,
};

async function decompressZstdTranscript(
  fd: Awaited<ReturnType<typeof open>>,
  compressedBytes: number,
  limit: number,
): Promise<Buffer> {
  const decompress = transcriptZstd.decompress;
  if (!decompress) throw new TranscriptCompressedReadError("compressed_unsupported", "zstd is not available in this Node runtime");
  if (compressedBytes > limit) throw new TranscriptCompressedReadError("compressed_too_large", "compressed session file is over the decompression limit");
  const compressed = Buffer.alloc(compressedBytes);
  let bytesRead = 0;
  while (bytesRead < compressedBytes) {
    const result = await fd.read(compressed, bytesRead, compressedBytes - bytesRead, bytesRead);
    if (result.bytesRead === 0) break;
    bytesRead += result.bytesRead;
  }
  return new Promise<Buffer>((resolve, reject) => {
    decompress(compressed.subarray(0, bytesRead), { maxOutputLength: limit }, (error, result) => {
      if (!error) return resolve(result);
      reject((error as NodeJS.ErrnoException).code === "ERR_BUFFER_TOO_LARGE"
        ? new TranscriptCompressedReadError("compressed_too_large", "decompressed session file is over the decompression limit")
        : new TranscriptCompressedReadError("compressed_corrupt", "compressed session file is not a valid zstd stream"));
    });
  });
}

const TRANSCRIPT_OPEN_FLAGS = fsConstants.O_RDONLY | (fsConstants.O_NOFOLLOW ?? 0) | (fsConstants.O_NONBLOCK ?? 0);

async function readBoundedTranscriptFile(
  filePath: string,
  maxBytes: number,
  anchorAt?: string,
): Promise<{
  text: string;
  sizeBytes: number;
  /** Size of the source when it was read: the file on disk, or a compressed file's decompressed bytes. */
  sourceBytes: number;
  truncated: boolean;
  truncationDirection?: "head" | "tail" | "window";
}> {
  const info = await lstat(filePath);
  if (info.isSymbolicLink()) throw new TranscriptPathRejectedError("symbolic links are not allowed");
  if (!info.isFile()) throw new TranscriptPathRejectedError(`not a regular file: ${filePath}`);

  // Opened without following a link, and it must be the file just checked: a
  // last component swapped for a link (or another file) after the lstat is
  // refused instead of read.
  let fd;
  try {
    fd = await open(filePath, TRANSCRIPT_OPEN_FLAGS);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ELOOP") throw new TranscriptPathRejectedError("symbolic links are not allowed");
    throw error;
  }
  try {
    const opened = await fd.stat();
    if (!opened.isFile() || opened.dev !== info.dev || opened.ino !== info.ino) {
      throw new TranscriptPathRejectedError(`session file changed while it was opened: ${filePath}`);
    }
    // A hard link may name a file outside the runtime's roots; a runtime
    // never hard-links its own session files.
    if (opened.nlink > 1) throw new TranscriptPathRejectedError("hard-linked files are not allowed");
    if (ZSTD_TRANSCRIPT_PATTERN.test(filePath)) {
      const plain = await decompressZstdTranscript(fd, info.size, maxBytes * ZSTD_TRANSCRIPT_DECOMPRESSED_LIMIT_FACTOR);
      return await readBoundedTranscriptWindow(bufferReader(plain), plain.length, true, maxBytes, anchorAt);
    }
    // A rotated pi session file (`<ts>_<id>.jsonl.rotated`) is JSON lines too.
    const isJsonLines = /\.jsonl(\.rotated)?$/i.test(filePath);
    return await readBoundedTranscriptWindow(fd, info.size, isJsonLines, maxBytes, anchorAt);
  } finally {
    await fd.close();
  }
}

async function readBoundedTranscriptWindow(
  source: PositionalReader,
  size: number,
  isJsonLines: boolean,
  maxBytes: number,
  anchorAt?: string,
): Promise<{
  text: string;
  sizeBytes: number;
  sourceBytes: number;
  truncated: boolean;
  truncationDirection?: "head" | "tail" | "window";
}> {
  const anchorMs = anchorAt ? Date.parse(anchorAt) : Number.NaN;
  const anchorEnd = isJsonLines && Number.isFinite(anchorMs)
    ? await findTranscriptAnchorEnd(source, size, anchorMs, maxBytes)
    : null;
  const readEnd = size <= maxBytes
    ? size
    : (isJsonLines ? (anchorEnd ?? size) : maxBytes);
  const readStart = Math.max(0, readEnd - maxBytes);
  const toRead = readEnd - readStart;
  const buf = Buffer.alloc(toRead);
  let bytesRead = 0;
  while (bytesRead < toRead) {
    const result = await source.read(buf, bytesRead, toRead - bytesRead, readStart + bytesRead);
    if (result.bytesRead === 0) break;
    bytesRead += result.bytesRead;
  }
  const truncated = size > maxBytes;
  const completeBuffer = buf.subarray(0, bytesRead);
  const aligned = isJsonLines && truncated
    ? alignJsonLinesWindow(completeBuffer, readStart > 0)
    : completeBuffer;
  const text = aligned.toString("utf8");
  return {
    text,
    sizeBytes: Buffer.byteLength(text, "utf8"),
    sourceBytes: size,
    truncated,
    // TOOTH-2 F3: direction names which side of the ORIGINAL file this bounded
    // read dropped. Derived from actual geometry, never guessed:
    //   readEnd == size            ⇒ kept [readStart, size): HEAD dropped  ("head")
    //   readStart == 0            ⇒ kept [0, readEnd):      TAIL dropped ("tail")
    //   else                      ⇒ kept [readStart, readEnd): BOTH dropped ("window")
    truncationDirection: truncated
      ? (readEnd >= size ? "head" : readStart > 0 ? "window" : "tail")
      : undefined,
  };
}

async function findTranscriptAnchorEnd(
  fd: PositionalReader,
  fileSize: number,
  anchorMs: number,
  maxRecordBytes: number,
): Promise<number | null> {
  const chunkSize = 256 * 1024;
  let position = 0;
  let carry = Buffer.alloc(0);
  let carryStart = 0;
  let discardingOversizedRecord = false;
  let latestAtOrBefore: { timestamp: number; end: number } | null = null;
  let earliestAfter: { timestamp: number; end: number } | null = null;

  while (position < fileSize) {
    const chunkStart = position;
    const nextSize = Math.min(chunkSize, fileSize - position);
    const chunk = Buffer.alloc(nextSize);
    const { bytesRead } = await fd.read(chunk, 0, nextSize, position);
    if (bytesRead === 0) break;
    position += bytesRead;

    let incoming = chunk.subarray(0, bytesRead);
    let incomingStart = chunkStart;
    if (discardingOversizedRecord) {
      const newline = incoming.indexOf(0x0a);
      if (newline === -1) {
        carryStart = position;
        continue;
      }
      incoming = incoming.subarray(newline + 1);
      incomingStart += newline + 1;
      discardingOversizedRecord = false;
    }

    const combined = carry.length > 0 ? Buffer.concat([carry, incoming]) : incoming;
    const combinedStart = carry.length > 0 ? carryStart : incomingStart;
    let lineStart = 0;
    for (let index = combined.indexOf(0x0a); index !== -1; index = combined.indexOf(0x0a, lineStart)) {
      const timestamp = readTranscriptRecordTimestamp(combined.subarray(lineStart, index));
      const lineEnd = combinedStart + index + 1;
      if (timestamp !== null && timestamp <= anchorMs) {
        if (!latestAtOrBefore || timestamp >= latestAtOrBefore.timestamp) {
          latestAtOrBefore = { timestamp, end: lineEnd };
        }
      } else if (timestamp !== null && (!earliestAfter || timestamp < earliestAfter.timestamp)) {
        earliestAfter = { timestamp, end: lineEnd };
      }
      lineStart = index + 1;
    }

    carry = combined.subarray(lineStart);
    carryStart = combinedStart + lineStart;
    if (carry.length > maxRecordBytes) {
      carry = Buffer.alloc(0);
      carryStart = position;
      discardingOversizedRecord = true;
    }
  }

  if (!discardingOversizedRecord && carry.length > 0) {
    const timestamp = readTranscriptRecordTimestamp(carry);
    if (timestamp !== null && timestamp <= anchorMs) {
      if (!latestAtOrBefore || timestamp >= latestAtOrBefore.timestamp) {
        latestAtOrBefore = { timestamp, end: fileSize };
      }
    } else if (timestamp !== null && (!earliestAfter || timestamp < earliestAfter.timestamp)) {
      earliestAfter = { timestamp, end: fileSize };
    }
  }

  return latestAtOrBefore?.end ?? earliestAfter?.end ?? null;
}

function readTranscriptRecordTimestamp(line: Buffer): number | null {
  try {
    const value = JSON.parse(line.toString("utf8")) as Record<string, unknown>;
    if (!value || typeof value !== "object" || Array.isArray(value)) return null;
    const candidate = value.timestamp;
    if (typeof candidate !== "string") return null;
    const parsed = Date.parse(candidate);
    if (Number.isFinite(parsed)) return parsed;
  } catch {
    // Malformed records cannot establish model-read-time authority.
  }
  return null;
}

function alignJsonLinesWindow(input: Buffer, dropLeadingRecord: boolean): Buffer {
  let start = 0;
  if (dropLeadingRecord) {
    const firstNewline = input.indexOf(0x0a);
    if (firstNewline === -1) return Buffer.alloc(0);
    start = firstNewline + 1;
  }

  let end = input.length;
  if (end > start && input[end - 1] !== 0x0a) {
    const lastNewline = input.lastIndexOf(0x0a);
    const finalRecordStart = Math.max(start, lastNewline + 1);
    if (!isCompleteJsonRecord(input.subarray(finalRecordStart))) {
      if (lastNewline < start) return Buffer.alloc(0);
      end = lastNewline + 1;
    }
  }
  return input.subarray(start, end);
}

function isCompleteJsonRecord(input: Buffer): boolean {
  try {
    JSON.parse(input.toString("utf8"));
    return true;
  } catch {
    return false;
  }
}

export type DetailedTranscriptRead =
  | {
    ok: true;
    text: string;
    /** Size of the source file at read time (a compressed file's decompressed size). */
    sourceBytes: number;
    truncated: boolean;
    truncationDirection?: "head" | "tail" | "window";
  }
  | { ok: false; failure: "path_rejected" | "read_failed"; errorClass: string; detail?: TranscriptReadFailureDetail };

/** Like readAndRedactTranscript, but a failure says which kind it was instead of becoming null. */
export async function readAndRedactTranscriptDetailed(
  filePath: string,
  maxBytes: number,
  anchorAt?: string,
): Promise<DetailedTranscriptRead> {
  try {
    const { text, sourceBytes, truncated, truncationDirection } = await readBoundedTranscriptFile(filePath, maxBytes, anchorAt);
    return { ok: true, text: redactTranscript(text), sourceBytes, truncated, truncationDirection };
  } catch (err) {
    return {
      ok: false,
      failure: err instanceof TranscriptPathRejectedError ? "path_rejected" : "read_failed",
      errorClass: err instanceof Error ? err.name : "Error",
      ...(err instanceof TranscriptCompressedReadError ? { detail: err.detail } : {}),
    };
  }
}

export async function readAndRedactTranscript(
  filePath: string,
  maxBytes: number,
  anchorAt?: string,
): Promise<{
  text: string;
  truncated: boolean;
  truncationDirection?: "head" | "tail" | "window";
} | null> {
  const read = await readAndRedactTranscriptDetailed(filePath, maxBytes, anchorAt);
  return read.ok ? { text: read.text, truncated: read.truncated, truncationDirection: read.truncationDirection } : null;
}

/**
 * Where reading a rotated session's earlier files stopped, when the read and
 * not the walk (piSessionParentChain, whose end is reported otherwise) did.
 */
export type SessionTranscriptChainReadStop =
  | "current_file_truncated"
  | "size_limit"
  | "earlier_file_rejected"
  | "earlier_file_unreadable";

/**
 * The transcript of a session, with the files a rotated pi session continues
 * (`chain`: the earlier files oldest first, and why the walk ended). The files
 * are concatenated OLDEST FIRST, each whole JSONL file including its
 * `{"type":"session"}` header line, so a reader splits them at the header
 * lines; each later header's parentSession names the file before it.
 *
 * `maxBytes` is for the total: the current file is read first, then earlier
 * files newest first with what remains, so the oldest history is what a limit
 * drops. A current file that lost its head is returned alone: an earlier file
 * in front of its tail would hide the gap. An earlier file left out (limit,
 * unreadable, rejected) or a chain cut at its depth limit counts as the head
 * being dropped.
 */
export async function readSessionTranscriptChain<ChainEnd extends string>(
  currentFile: string,
  chain: { readonly earlier: readonly string[]; readonly end: ChainEnd } | undefined,
  allowedRoots: string[],
  maxBytes: number,
  anchorAt?: string,
): Promise<DetailedTranscriptRead & { earlierFiles?: number; chainStop?: ChainEnd | SessionTranscriptChainReadStop }> {
  const current = await readAndRedactTranscriptDetailed(currentFile, maxBytes, anchorAt);
  if (!current.ok || !chain) return current;
  if (current.truncated && current.truncationDirection !== "tail") {
    return { ...current, earlierFiles: 0, chainStop: "current_file_truncated" };
  }
  type Part = Extract<DetailedTranscriptRead, { ok: true }>;
  const parts: Part[] = [current];
  let used = Buffer.byteLength(current.text, "utf8");
  let headDropped = chain.end === "depth_limit";
  let chainStop: ChainEnd | SessionTranscriptChainReadStop = chain.end;
  const stop = (why: SessionTranscriptChainReadStop) => {
    headDropped = true;
    chainStop = why;
  };
  for (const file of [...chain.earlier].reverse()) {
    const remaining = maxBytes - used;
    if (remaining <= 0) {
      stop("size_limit");
      break;
    }
    if (!(await isPathWithinAllowedRoots(file, allowedRoots))) {
      stop("earlier_file_rejected");
      break;
    }
    const part = await readAndRedactTranscriptDetailed(file, remaining, anchorAt);
    if (!part.ok) {
      stop(part.failure === "path_rejected" ? "earlier_file_rejected" : "earlier_file_unreadable");
      break;
    }
    const text = part.text.endsWith("\n") || part.text.length === 0 ? part.text : `${part.text}\n`;
    const bytes = Buffer.byteLength(text, "utf8");
    if (bytes > remaining) {
      stop("size_limit");
      break;
    }
    parts.push({ ...part, text });
    used += bytes;
    if (part.truncated && part.truncationDirection !== "tail") {
      // The part lost its head to the limit; anything older is gone too.
      stop("size_limit");
      break;
    }
  }
  const tailDropped = parts.some((part) => part.truncationDirection === "tail" || part.truncationDirection === "window");
  const truncated = headDropped || tailDropped;
  return {
    ok: true,
    text: parts.map((part) => part.text).reverse().join(""),
    sourceBytes: parts.reduce((sum, part) => sum + part.sourceBytes, 0),
    truncated,
    truncationDirection: truncated ? (headDropped && tailDropped ? "window" : headDropped ? "head" : "tail") : undefined,
    earlierFiles: parts.length - 1,
    chainStop,
  };
}
