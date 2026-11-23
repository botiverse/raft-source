// A zip written front to back into a sink, for data exports (#triage:#512,
// design v7 §7). The format is yazl's (deflate, data descriptors, UTF-8
// names, Zip64 when an archive needs it); this file only adapts it to the
// export's shape: entries opened one at a time and fed in pieces (a JSONL
// conversation file grows batch by batch), the bytes pushed into a sink with
// backpressure (multipartSink.ts), and a running byte count the caller uses
// to roll to a new volume. One chunk of an entry is in memory at a time.
import { PassThrough } from "node:stream";
import { once } from "node:events";
import { ZipFile } from "yazl";

/** addBytes hands yazl at most this much at a time. */
const SLICE_BYTES = 256 * 1024;

/** Where the archive's bytes go, in order. One call at a time. */
export interface ZipSink {
  write(chunk: Buffer): Promise<void>;
}

export class StreamingZipWriter {
  private readonly zip = new ZipFile();
  private readonly names = new Set<string>();
  private readonly pump: Promise<void>;
  private failure: unknown = null;
  private written = 0;
  private entries = 0;
  private current: { name: string; input: PassThrough } | null = null;
  private finished = false;

  constructor(sink: ZipSink, private readonly modifiedAt: Date) {
    // yazl reports a broken entry by emitting "error"; unheard it would crash
    // the process, and yazl's end() is then a no-op, so fail the writer.
    this.zip.on("error", (error: unknown) => this.abort(error));
    const output = this.zip.outputStream as AsyncIterable<Buffer>;
    this.pump = (async () => {
      for await (const chunk of output) {
        await sink.write(chunk);
        this.written += chunk.length;
      }
    })();
    // Recorded for the next call; a failed sink fails every later step.
    this.pump.catch((error: unknown) => { this.failure ??= error ?? new Error("zip output failed"); });
  }

  /** Bytes the sink has taken so far (an entry being written lags by what yazl buffers). */
  get bytesWritten(): number {
    return this.written;
  }

  get entryCount(): number {
    return this.entries;
  }

  /** Start an entry; its bytes follow through write() until endEntry(). */
  async beginEntry(path: string): Promise<void> {
    this.checkWritable();
    if (this.current) throw new Error(`zip entry ${this.current.name} is still open`);
    this.claimName(path);
    const input = new PassThrough();
    this.zip.addReadStream(input, path, { mtime: this.modifiedAt, compress: true });
    this.current = { name: path, input };
  }

  /** Add bytes to the open entry; waits while the sink is behind. */
  async write(chunk: Buffer): Promise<void> {
    this.checkWritable();
    const entry = this.current;
    if (!entry) throw new Error("no zip entry is open");
    if (chunk.length === 0) return;
    if (!entry.input.write(chunk)) await this.until(once(entry.input, "drain"));
  }

  /** Close the open entry. */
  async endEntry(): Promise<void> {
    this.checkWritable();
    const entry = this.current;
    if (!entry) throw new Error("no zip entry is open");
    entry.input.end();
    this.current = null;
    this.entries += 1;
  }

  /** One whole entry from bytes in hand, fed in slices so the sink's pace holds. */
  async addBytes(path: string, bytes: Buffer): Promise<void> {
    await this.beginEntry(path);
    for (let at = 0; at < bytes.length; at += SLICE_BYTES) await this.write(bytes.subarray(at, at + SLICE_BYTES));
    await this.endEntry();
  }

  /** One whole entry from a stream (an attachment's bytes). A failing source fails the writer. */
  async addStream(path: string, source: AsyncIterable<Buffer | Uint8Array | string>): Promise<void> {
    await this.beginEntry(path);
    try {
      for await (const chunk of source) await this.write(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
    } catch (error) {
      this.abort(error);
      throw error;
    }
    await this.endEntry();
  }

  /**
   * Give up on this archive: every later call (and a pending finish) fails
   * with `reason`. The caller discards what the sink took (MultipartSink.abort).
   */
  abort(reason: unknown): void {
    if (this.failure) return;
    this.failure = reason ?? new Error("zip aborted");
    const output = this.zip.outputStream as NodeJS.ReadableStream & { destroy(error?: Error): void };
    output.destroy(this.failure instanceof Error ? this.failure : new Error(String(this.failure)));
  }

  /** Write the central directory and wait until the sink has every byte. */
  async finish(): Promise<void> {
    this.checkWritable();
    if (this.current) throw new Error(`zip entry ${this.current.name} is still open`);
    this.finished = true;
    this.zip.end();
    await this.pump;
  }

  private claimName(path: string): void {
    if (!path || path.startsWith("/") || path.includes("\\") || path.split("/").includes("..")) {
      throw new Error(`invalid zip entry name ${path}`);
    }
    if (this.names.has(path)) throw new Error(`zip entry ${path} was already written`);
    this.names.add(path);
  }

  private checkWritable(): void {
    if (this.failure) throw this.failure;
    if (this.finished) throw new Error("zip already finished");
  }

  /** Wait for `step`, but stop at once if the output fails meanwhile. */
  private async until(step: Promise<unknown>): Promise<void> {
    await Promise.race([step, this.pump.then(() => { throw new Error("zip output ended early"); })]);
  }
}
