// Test support for data exports (services/dataExport/): the flag, an
// in-memory storage backend with multipart and presigned URLs, and a
// producer whose batches are scripted, so the framework is tested before any
// real producer exists (PR1b ships none).
import { randomUUID } from "node:crypto";
import { Readable } from "node:stream";
import { inflateRawSync } from "node:zlib";
import { DATA_EXPORT_FEATURE_FLAG_KEY, type DataExportKind, type JsonValue } from "@botiverse/raft-shared";
import { getDb } from "../db/index";
import { featureFlags } from "../db/schema";
import type { DataExportAuthorization, DataExportBatch, DataExportJob, DataExportProducer } from "../services/dataExport/producer";
import type { MultipartStorage, MultipartUploadListing, StorageBackend } from "../services/storageService";

export async function setDataExportFlag(enabled: boolean, options: { killSwitch?: boolean } = {}): Promise<void> {
  await getDb().insert(featureFlags)
    .values({ key: DATA_EXPORT_FEATURE_FLAG_KEY, randomizationUnit: "user", salt: "test", defaultEnabled: enabled, killSwitch: options.killSwitch ?? false })
    .onConflictDoUpdate({ target: featureFlags.key, set: { defaultEnabled: enabled, killSwitch: options.killSwitch ?? false } });
}

/** Storage in memory: objects, multipart uploads (with when they began), and presigned URLs asked for. */
export class MemoryExportStorage implements StorageBackend {
  readonly objects = new Map<string, Buffer>();
  readonly uploads = new Map<string, { key: string; parts: Map<number, Buffer>; initiatedAt: Date }>();
  readonly aborted: string[] = [];
  readonly presigned: Array<{ key: string; expiresIn?: number; responseContentDisposition?: string; responseContentType?: string }> = [];
  /** Fail the upload of the part with this number (once), to test a volume that fails. */
  failPart: number | null = null;
  /** Runs at every get (a test changes the world while a file op reads). */
  onGet: ((key: string) => Promise<void>) | null = null;
  /** Runs after an upload completes (a test races another run in here). */
  onComplete: ((key: string) => Promise<void>) | null = null;
  /** `presign: false` leaves getPresignedUrl out, as local disk does (the route then streams). */
  constructor(presign = true) {
    if (!presign) delete this.getPresignedUrl;
  }

  async put(key: string, data: Buffer): Promise<void> { this.objects.set(key, Buffer.from(data)); }
  async get(key: string): Promise<Readable> {
    await this.onGet?.(key);
    const object = this.objects.get(key);
    if (!object) throw Object.assign(new Error("missing"), { name: "NoSuchKey" });
    return Readable.from([object]);
  }
  /** Confirms absence the way S3's NoSuchKey does; `probeError` makes it fail as an unavailable backend would. */
  probeError: Error | null = null;
  async probeObjectPresence(key: string): Promise<"present" | "missing"> {
    if (this.probeError) throw this.probeError;
    return this.objects.has(key) ? "present" : "missing";
  }
  async delete(key: string): Promise<void> { this.objects.delete(key); }
  getPresignedUrl? = async (key: string, options: { expiresIn?: number; responseContentDisposition?: string; responseContentType?: string } = {}): Promise<string> => {
    this.presigned.push({ key, ...options });
    return `https://exports.example.test/${key}?signed=1`;
  };

  readonly multipart: MultipartStorage = {
    createMultipartUpload: async (key) => {
      const id = randomUUID();
      this.uploads.set(id, { key, parts: new Map(), initiatedAt: new Date() });
      return id;
    },
    uploadPart: async (_key, uploadId, partNumber, body) => {
      if (this.failPart === partNumber) {
        this.failPart = null;
        throw new Error("part upload failed");
      }
      const upload = this.uploads.get(uploadId);
      if (!upload) throw new Error("Multipart upload not found");
      upload.parts.set(partNumber, Buffer.from(body));
      return `"${partNumber}"`;
    },
    completeMultipartUpload: async (key, uploadId, parts) => {
      const upload = this.uploads.get(uploadId);
      if (!upload) throw new Error("Multipart upload not found");
      this.objects.set(key, Buffer.concat(parts.map((part) => upload.parts.get(part.partNumber)!)));
      this.uploads.delete(uploadId);
      await this.onComplete?.(key);
    },
    abortMultipartUpload: async (_key, uploadId) => {
      this.aborted.push(uploadId);
      this.uploads.delete(uploadId);
    },
    listMultipartUploads: async (prefix): Promise<MultipartUploadListing[]> =>
      [...this.uploads.entries()].filter(([, upload]) => upload.key.startsWith(prefix)).map(([uploadId, upload]) => ({ key: upload.key, uploadId, initiatedAt: upload.initiatedAt })),
  };
}

export interface ScriptedProducerOptions<K extends DataExportKind> {
  kind: K;
  /** Batches by cursor (the cursor is the batch's index). */
  batches: Array<Omit<DataExportBatch<number>, "next">>;
  authorize?: (job: DataExportJob<K>, stage: "create" | "batch" | "download") => DataExportAuthorization | Promise<DataExportAuthorization>;
  /** Runs before each batch (a test changes the world here). */
  beforeBatch?: (cursor: number) => Promise<void> | void;
}

/** A producer that writes the scripted batches in order; `calls` records the cursors it was asked for. */
export function scriptedProducer<K extends DataExportKind>(options: ScriptedProducerOptions<K>): DataExportProducer<K, number> & { calls: number[] } {
  const calls: number[] = [];
  return {
    kind: options.kind,
    calls,
    authorize: async (job, stage) => options.authorize ? options.authorize(job, stage) : { ok: true },
    validateScope: async ({ scope }) => ({ ok: true, scope }),
    initialCursor: () => 0,
    decodeCursor: (raw: JsonValue) => {
      if (typeof raw !== "number") throw new Error("not a cursor");
      return raw;
    },
    nextBatch: async (_job, cursor) => {
      calls.push(cursor);
      await options.beforeBatch?.(cursor);
      const batch = options.batches[cursor]!;
      return { ...batch, next: cursor + 1 < options.batches.length ? cursor + 1 : null };
    },
  };
}

/** The entry names of a zip, read from its central directory. */
export function zipEntryNames(zip: Buffer): string[] {
  return zipEntries(zip).map((entry) => entry.name);
}

/** One entry's bytes (deflated or stored). */
export function zipEntry(zip: Buffer, name: string): Buffer {
  const entry = zipEntries(zip).find((candidate) => candidate.name === name);
  if (!entry) throw new Error(`no entry ${name}`);
  const at = entry.offset;
  const start = at + 30 + zip.readUInt16LE(at + 26) + zip.readUInt16LE(at + 28);
  const data = zip.subarray(start, start + entry.compressedSize);
  return entry.method === 8 ? inflateRawSync(data) : Buffer.from(data);
}

function zipEntries(zip: Buffer): Array<{ name: string; method: number; compressedSize: number; offset: number }> {
  const end = zip.lastIndexOf(Buffer.from([0x50, 0x4b, 0x05, 0x06]));
  if (end < 0) throw new Error("no end of central directory");
  let at = zip.readUInt32LE(end + 16);
  const count = zip.readUInt16LE(end + 10);
  const entries: Array<{ name: string; method: number; compressedSize: number; offset: number }> = [];
  for (let i = 0; i < count; i += 1) {
    if (zip.readUInt32LE(at) !== 0x02014b50) throw new Error("bad central directory entry");
    const nameLength = zip.readUInt16LE(at + 28);
    const extraLength = zip.readUInt16LE(at + 30);
    const commentLength = zip.readUInt16LE(at + 32);
    entries.push({
      name: zip.subarray(at + 46, at + 46 + nameLength).toString("utf8"),
      method: zip.readUInt16LE(at + 10),
      compressedSize: zip.readUInt32LE(at + 20),
      offset: zip.readUInt32LE(at + 42),
    });
    at += 46 + nameLength + extraLength + commentLength;
  }
  return entries;
}
