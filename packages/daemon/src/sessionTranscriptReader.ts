import path from "node:path";
import { lstat, open, realpath } from "node:fs/promises";

function redactTranscript(text: string): string {
  return text
    .replace(/sk_(?:agent|machine|computer)_[A-Za-z0-9_-]+/g, "sk_[redacted]")
    .replace(/sap_[A-Za-z0-9_-]+/g, "sap_[redacted]")
    .replace(/Bearer\s+[A-Za-z0-9_\-./+=]+/g, "Bearer [redacted]")
    .replace(/["']?auth[_-]?token["']?\s*[:=]\s*["'][^"']+["']/gi, "[redacted]")
    .replace(/https?:\/\/[^\s\"]+/g, "[url]");
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

async function readBoundedTranscriptFile(
  filePath: string,
  maxBytes: number,
  anchorAt?: string,
): Promise<{
  text: string;
  sizeBytes: number;
  truncated: boolean;
  truncationDirection?: "head" | "tail" | "window";
}> {
  const info = await lstat(filePath);
  if (info.isSymbolicLink()) throw new Error("symbolic links are not allowed");
  if (!info.isFile()) throw new Error(`not a regular file: ${filePath}`);

  const fd = await open(filePath, "r");
  try {
    const isJsonLines = path.extname(filePath).toLowerCase() === ".jsonl";
    const anchorMs = anchorAt ? Date.parse(anchorAt) : Number.NaN;
    const anchorEnd = isJsonLines && Number.isFinite(anchorMs)
      ? await findTranscriptAnchorEnd(fd, info.size, anchorMs, maxBytes)
      : null;
    const readEnd = info.size <= maxBytes
      ? info.size
      : (isJsonLines ? (anchorEnd ?? info.size) : maxBytes);
    const readStart = Math.max(0, readEnd - maxBytes);
    const toRead = readEnd - readStart;
    const buf = Buffer.alloc(toRead);
    let bytesRead = 0;
    while (bytesRead < toRead) {
      const result = await fd.read(buf, bytesRead, toRead - bytesRead, readStart + bytesRead);
      if (result.bytesRead === 0) break;
      bytesRead += result.bytesRead;
    }
    const truncated = info.size > maxBytes;
    const completeBuffer = buf.subarray(0, bytesRead);
    const aligned = isJsonLines && truncated
      ? alignJsonLinesWindow(completeBuffer, readStart > 0)
      : completeBuffer;
    const text = aligned.toString("utf8");
    return {
      text,
      sizeBytes: Buffer.byteLength(text, "utf8"),
      truncated,
      // TOOTH-2 F3: direction names which side of the ORIGINAL file this bounded
      // read dropped. Derived from actual geometry, never guessed:
      //   readEnd == info.size       ⇒ kept [readStart, size): HEAD dropped  ("head")
      //   readStart == 0            ⇒ kept [0, readEnd):      TAIL dropped ("tail")
      //   else                      ⇒ kept [readStart, readEnd): BOTH dropped ("window")
      truncationDirection: truncated
        ? (readEnd >= info.size ? "head" : readStart > 0 ? "window" : "tail")
        : undefined,
    };
  } finally {
    await fd.close();
  }
}

async function findTranscriptAnchorEnd(
  fd: Awaited<ReturnType<typeof open>>,
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

export async function readAndRedactTranscript(
  filePath: string,
  maxBytes: number,
  anchorAt?: string,
): Promise<{
  text: string;
  truncated: boolean;
  truncationDirection?: "head" | "tail" | "window";
} | null> {
  try {
    const { text, truncated, truncationDirection } = await readBoundedTranscriptFile(filePath, maxBytes, anchorAt);
    return { text: redactTranscript(text), truncated, truncationDirection };
  } catch {
    return null;
  }
}
