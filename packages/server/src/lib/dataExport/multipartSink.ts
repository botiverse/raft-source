// A ZipSink (streamingZip.ts) that uploads one export volume as a multipart
// object. R2 requires every part but the last to be the same size, so parts
// are cut at exactly DATA_EXPORT_PART_BYTES; at most one part is held in
// memory. The sha256 of the whole volume goes into the export's manifest.
import { createHash, type Hash } from "node:crypto";
import type { MultipartStorage } from "../../services/storageService";
import type { ZipSink } from "./streamingZip";

export const DATA_EXPORT_PART_BYTES = 8 * 1024 * 1024;

export interface UploadedVolume {
  sizeBytes: number;
  sha256: string;
  parts: number;
}

export class MultipartSink implements ZipSink {
  private readonly hash: Hash = createHash("sha256");
  private buffer: Buffer[] = [];
  private buffered = 0;
  private size = 0;
  private readonly parts: Array<{ partNumber: number; etag: string }> = [];
  private closed = false;

  private constructor(
    private readonly storage: MultipartStorage,
    readonly key: string,
    readonly uploadId: string,
    private readonly partBytes: number,
  ) {}

  /** Start the upload of `key`. Record `uploadId` before writing so a lost run can abort it. */
  static async open(
    storage: MultipartStorage,
    key: string,
    contentType: string,
    partBytes = DATA_EXPORT_PART_BYTES,
  ): Promise<MultipartSink> {
    if (!Number.isSafeInteger(partBytes) || partBytes <= 0) throw new Error("multipart part size is invalid");
    const uploadId = await storage.createMultipartUpload(key, contentType);
    return new MultipartSink(storage, key, uploadId, partBytes);
  }

  async write(chunk: Buffer): Promise<void> {
    if (this.closed) throw new Error("multipart sink is closed");
    if (chunk.length === 0) return;
    this.hash.update(chunk);
    this.size += chunk.length;
    // Our own copy: the caller may reuse its buffer before the part is cut.
    this.buffer.push(Buffer.from(chunk));
    this.buffered += chunk.length;
    while (this.buffered >= this.partBytes) await this.uploadPart(this.take(this.partBytes));
  }

  /** Upload the last (shorter) part and complete the object. */
  async complete(): Promise<UploadedVolume> {
    if (this.closed) throw new Error("multipart sink is closed");
    this.closed = true;
    // A multipart object needs at least one part; the last may be short (or empty if it is the only one).
    if (this.buffered > 0 || this.parts.length === 0) await this.uploadPart(this.take(this.buffered));
    await this.storage.completeMultipartUpload(this.key, this.uploadId, this.parts);
    return { sizeBytes: this.size, sha256: this.hash.digest("hex"), parts: this.parts.length };
  }

  /** Give up: the parts uploaded so far are discarded by the backend. */
  async abort(): Promise<void> {
    this.closed = true;
    this.buffer = [];
    this.buffered = 0;
    await this.storage.abortMultipartUpload(this.key, this.uploadId);
  }

  /** The first `bytes` buffered bytes; the rest stays as views (no copy per part). */
  private take(bytes: number): Buffer {
    const pieces: Buffer[] = [];
    let needed = bytes;
    while (needed > 0) {
      const head = this.buffer[0]!;
      if (head.length <= needed) {
        pieces.push(head);
        this.buffer.shift();
        needed -= head.length;
      } else {
        pieces.push(head.subarray(0, needed));
        this.buffer[0] = head.subarray(needed);
        needed = 0;
      }
    }
    this.buffered -= bytes;
    return pieces.length === 1 ? pieces[0]! : Buffer.concat(pieces, bytes);
  }

  private async uploadPart(body: Buffer): Promise<void> {
    const partNumber = this.parts.length + 1;
    const etag = await this.storage.uploadPart(this.key, this.uploadId, partNumber, body);
    this.parts.push({ partNumber, etag });
  }
}
