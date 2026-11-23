// The export volume upload (multipartSink.ts) and the local multipart
// backend (storageService.ts). Proves: every part but the last is exactly the
// part size (R2's rule), whatever the write sizes; the bytes, size and
// sha256 of the object are the volume's; an empty volume is one empty part;
// abort discards the parts; and through getStorage() the local backend
// completes a real zip that reads back and lists only unfinished uploads; on
// S3 the commands go to the private legacy bucket, abort tolerates an upload
// that is already gone, and listing follows every page.
import assert from "node:assert/strict";
import { createHash, randomBytes } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  AbortMultipartUploadCommand,
  CompleteMultipartUploadCommand,
  CreateMultipartUploadCommand,
  ListMultipartUploadsCommand,
  S3Client,
  UploadPartCommand,
} from "@aws-sdk/client-s3";
import { getStorage, resetStorageForTests, type MultipartStorage } from "../../services/storageService";
import { MultipartSink } from "./multipartSink";
import { StreamingZipWriter } from "./streamingZip";

class FakeMultipart implements MultipartStorage {
  readonly uploads = new Map<string, Map<number, Buffer>>();
  readonly completed = new Map<string, Buffer>();
  readonly aborted: string[] = [];
  async createMultipartUpload(key: string): Promise<string> {
    const id = `${key}#${this.uploads.size + 1}`;
    this.uploads.set(id, new Map());
    return id;
  }
  async uploadPart(_key: string, uploadId: string, partNumber: number, body: Buffer): Promise<string> {
    this.uploads.get(uploadId)!.set(partNumber, Buffer.from(body));
    return `etag-${partNumber}`;
  }
  async completeMultipartUpload(key: string, uploadId: string, parts: ReadonlyArray<{ partNumber: number; etag: string }>): Promise<void> {
    const stored = this.uploads.get(uploadId)!;
    this.completed.set(key, Buffer.concat(parts.map((part) => {
      assert.equal(part.etag, `etag-${part.partNumber}`);
      return stored.get(part.partNumber)!;
    })));
  }
  async abortMultipartUpload(_key: string, uploadId: string): Promise<void> {
    this.aborted.push(uploadId);
    this.uploads.delete(uploadId);
  }
  async listMultipartUploads(prefix: string) {
    return [...this.uploads.keys()].filter((id) => id.startsWith(prefix)).map((id) => ({ key: id.split("#")[0]!, uploadId: id, initiatedAt: new Date(0) }));
  }
}

test("parts are cut at exactly the part size whatever the write sizes; the last is the rest", async () => {
  const storage = new FakeMultipart();
  const sink = await MultipartSink.open(storage, "data-exports/v1/x/1.zip", "application/zip", 1000);
  const written: Buffer[] = [];
  for (const size of [1, 999, 1500, 3, 2497, 0, 4000, 17]) {
    const chunk = Buffer.alloc(size, size % 251);
    written.push(chunk);
    await sink.write(chunk);
  }
  const all = Buffer.concat(written);
  const volume = await sink.complete();
  const parts = [...storage.uploads.get(sink.uploadId)!.values()];
  assert.deepEqual(parts.slice(0, -1).map((part) => part.length), Array(parts.length - 1).fill(1000));
  assert.equal(parts.at(-1)!.length, all.length % 1000 || 1000);
  assert.deepEqual(storage.completed.get("data-exports/v1/x/1.zip"), all);
  assert.deepEqual(volume, {
    sizeBytes: all.length,
    sha256: createHash("sha256").update(all).digest("hex"),
    parts: Math.ceil(all.length / 1000),
  });
  await assert.rejects(sink.write(Buffer.from("x")), /closed/);
});

test("an empty volume completes as one empty part; abort discards the upload", async () => {
  const storage = new FakeMultipart();
  const empty = await MultipartSink.open(storage, "k/empty.zip", "application/zip", 1000);
  assert.equal((await empty.complete()).sizeBytes, 0);
  assert.deepEqual(storage.completed.get("k/empty.zip"), Buffer.alloc(0));

  const lost = await MultipartSink.open(storage, "k/lost.zip", "application/zip", 1000);
  await lost.write(Buffer.alloc(2500));
  await lost.abort();
  assert.deepEqual(storage.aborted, [lost.uploadId]);
  assert.equal(storage.completed.has("k/lost.zip"), false);
  await assert.rejects(lost.write(Buffer.from("x")), /closed/);
});

test("the local backend, through getStorage(), assembles a zip volume that reads back and aborts cleanly", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "export-multipart-"));
  const envKeys = ["S3_ENDPOINT", "S3_DIRECT_UPLOAD_ENDPOINT", "UPLOADS_LOCAL", "UPLOADS_DIR"] as const;
  const previous = new Map(envKeys.map((key) => [key, process.env[key]]));
  try {
    delete process.env.S3_ENDPOINT; delete process.env.S3_DIRECT_UPLOAD_ENDPOINT;
    process.env.UPLOADS_LOCAL = "true"; process.env.UPLOADS_DIR = dir;
    resetStorageForTests();
    const storage = getStorage();
    assert.ok(storage?.multipart, "the routed local backend offers multipart");
    await assert.rejects(storage.multipart.createMultipartUpload("attachments/v2/s/server/a/o", "image/png"), /only for data export keys/);
    await assert.rejects(storage.multipart.createMultipartUpload("data-exports/../../x", "application/zip"), /traversal|invalid/i);

    const key = "data-exports/v1/test-export/1.zip";
    const sink = await MultipartSink.open(storage.multipart, key, "application/zip", 64 * 1024);
    const zip = new StreamingZipWriter(sink, new Date("2026-11-18T00:00:00Z"));
    const random = randomBytes(300 * 1024); // incompressible: several parts
    await zip.addBytes("a.bin", random);
    await zip.addBytes("说明.txt", Buffer.from("你好"));
    await zip.finish();
    const volume = await sink.complete();
    assert.ok(volume.parts >= 2, "the volume took several parts");

    const stored = fs.readFileSync(path.join(dir, key));
    assert.equal(stored.length, volume.sizeBytes);
    assert.equal(createHash("sha256").update(stored).digest("hex"), volume.sha256);
    assert.equal(stored.readUInt32LE(stored.length - 22), 0x06054b50, "ends with the zip end record");
    assert.deepEqual(fs.readdirSync(path.dirname(path.join(dir, key))), ["1.zip"], "no parts left behind");

    const lost = await MultipartSink.open(storage.multipart, "data-exports/v1/test-export/2.zip", "application/zip", 1024);
    await lost.write(Buffer.alloc(4096, 1));
    // An unfinished upload is listed under its prefix (whoever recorded its id); a finished one is not.
    const listed = await storage.multipart.listMultipartUploads("data-exports/");
    assert.deepEqual(listed.map(({ key, uploadId }) => ({ key, uploadId })), [{ key: "data-exports/v1/test-export/2.zip", uploadId: lost.uploadId }]);
    assert.ok(listed[0]!.initiatedAt instanceof Date);
    assert.deepEqual(await storage.multipart.listMultipartUploads("data-exports/v1/other/"), []);
    await assert.rejects(storage.multipart.listMultipartUploads("attachments/"), /only for data export keys/);
    await lost.abort();
    assert.deepEqual(await storage.multipart.listMultipartUploads("data-exports/"), []);
    assert.deepEqual(fs.readdirSync(path.dirname(path.join(dir, key))), ["1.zip"], "abort leaves nothing");
    await storage.multipart.abortMultipartUpload("data-exports/v1/test-export/2.zip", lost.uploadId);
  } finally {
    for (const [key, value] of previous) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
    resetStorageForTests();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("on S3, export keys go to the private legacy bucket as create, parts, complete; abort ignores a finished upload", async () => {
  const envKeys = ["S3_ENDPOINT", "S3_REGION", "S3_ACCESS_KEY_ID", "S3_SECRET_ACCESS_KEY", "S3_ATTACHMENTS_BUCKET",
    "S3_DIRECT_UPLOAD_ENDPOINT", "S3_DIRECT_UPLOAD_ACCESS_KEY_ID", "S3_DIRECT_UPLOAD_SECRET_ACCESS_KEY",
    "S3_DIRECT_UPLOAD_BUCKET", "UPLOADS_LOCAL"] as const;
  const previous = new Map(envKeys.map((key) => [key, process.env[key]]));
  const originalSend = S3Client.prototype.send;
  const calls: string[] = [];
  try {
    Object.assign(process.env, { S3_ENDPOINT: "https://legacy.example.test", S3_REGION: "auto",
      S3_ACCESS_KEY_ID: "test-key", S3_SECRET_ACCESS_KEY: "test-secret", S3_ATTACHMENTS_BUCKET: "legacy",
      S3_DIRECT_UPLOAD_ENDPOINT: "https://direct.example.test", S3_DIRECT_UPLOAD_ACCESS_KEY_ID: "test-direct-key",
      S3_DIRECT_UPLOAD_SECRET_ACCESS_KEY: "test-direct-secret", S3_DIRECT_UPLOAD_BUCKET: "direct", UPLOADS_LOCAL: "false" });
    resetStorageForTests();
    (S3Client.prototype as unknown as { send: typeof originalSend }).send = (async (command: unknown) => {
      if (command instanceof CreateMultipartUploadCommand) {
        calls.push(`create ${command.input.Bucket} ${command.input.Key} ${command.input.ContentType}`);
        return { UploadId: "up-1" };
      }
      if (command instanceof UploadPartCommand) {
        calls.push(`part ${command.input.PartNumber} ${(command.input.Body as Buffer).length} ${command.input.UploadId}`);
        return { ETag: `"e${command.input.PartNumber}"` };
      }
      if (command instanceof CompleteMultipartUploadCommand) {
        calls.push(`complete ${JSON.stringify(command.input.MultipartUpload?.Parts)}`);
        return {};
      }
      if (command instanceof AbortMultipartUploadCommand) {
        calls.push(`abort ${command.input.UploadId}`);
        throw Object.assign(new Error("gone"), { name: "NoSuchUpload" });
      }
      throw new Error("unexpected command");
    }) as typeof originalSend;
    const storage = getStorage();
    assert.ok(storage?.multipart);
    const sink = await MultipartSink.open(storage.multipart, "data-exports/v1/e1/1.zip", "application/zip", 4);
    await sink.write(Buffer.from("0123456789"));
    await sink.complete();
    await sink.abort();
    assert.deepEqual(calls, [
      "create legacy data-exports/v1/e1/1.zip application/zip",
      "part 1 4 up-1",
      "part 2 4 up-1",
      "part 3 2 up-1",
      `complete ${JSON.stringify([{ PartNumber: 1, ETag: '"e1"' }, { PartNumber: 2, ETag: '"e2"' }, { PartNumber: 3, ETag: '"e3"' }])}`,
      "abort up-1",
    ]);
  } finally {
    S3Client.prototype.send = originalSend;
    for (const [key, value] of previous) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
    resetStorageForTests();
  }
});

test("on S3, listing unfinished export uploads follows every page's markers", async () => {
  const envKeys = ["S3_ENDPOINT", "S3_REGION", "S3_ACCESS_KEY_ID", "S3_SECRET_ACCESS_KEY", "S3_ATTACHMENTS_BUCKET",
    "S3_DIRECT_UPLOAD_ENDPOINT", "UPLOADS_LOCAL"] as const;
  const previous = new Map(envKeys.map((key) => [key, process.env[key]]));
  const originalSend = S3Client.prototype.send;
  const calls: string[] = [];
  try {
    Object.assign(process.env, { S3_ENDPOINT: "https://legacy.example.test", S3_REGION: "auto",
      S3_ACCESS_KEY_ID: "test-key", S3_SECRET_ACCESS_KEY: "test-secret", S3_ATTACHMENTS_BUCKET: "legacy", UPLOADS_LOCAL: "false" });
    delete process.env.S3_DIRECT_UPLOAD_ENDPOINT;
    resetStorageForTests();
    const initiated = new Date("2026-11-17T00:00:00Z");
    (S3Client.prototype as unknown as { send: typeof originalSend }).send = (async (command: unknown) => {
      if (!(command instanceof ListMultipartUploadsCommand)) throw new Error("unexpected command");
      const { Bucket, Prefix, KeyMarker, UploadIdMarker } = command.input;
      calls.push(`list ${Bucket} ${Prefix} ${KeyMarker ?? "-"} ${UploadIdMarker ?? "-"}`);
      if (!KeyMarker) {
        return { IsTruncated: true, NextKeyMarker: "data-exports/v1/a/1.zip", NextUploadIdMarker: "u2",
          Uploads: [{ Key: "data-exports/v1/a/1.zip", UploadId: "u1", Initiated: initiated }, { Key: "data-exports/v1/a/1.zip", UploadId: "u2", Initiated: initiated }] };
      }
      return { IsTruncated: false, Uploads: [{ Key: "data-exports/v1/b/1.zip", UploadId: "u3", Initiated: initiated }] };
    }) as typeof originalSend;
    const storage = getStorage();
    assert.ok(storage?.multipart);
    const listed = await storage.multipart.listMultipartUploads("data-exports/");
    assert.deepEqual(listed.map((upload) => upload.uploadId), ["u1", "u2", "u3"]);
    assert.deepEqual(listed[2], { key: "data-exports/v1/b/1.zip", uploadId: "u3", initiatedAt: initiated });
    assert.deepEqual(calls, [
      "list legacy data-exports/ - -",
      "list legacy data-exports/ data-exports/v1/a/1.zip u2",
    ]);
  } finally {
    S3Client.prototype.send = originalSend;
    for (const [key, value] of previous) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
    resetStorageForTests();
  }
});
