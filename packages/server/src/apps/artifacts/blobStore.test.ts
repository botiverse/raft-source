// Artifacts' blob store on the object storage core hands it (the platform's
// app-content bucket, APP_STORAGE_R2_*, built by core's storage code): what
// each operation sends to the bucket, at Artifacts' prefix, that a put is
// counted by core's S3 put metrics under the app-content bucket, and that the
// SDK's logger prints no command input (keys, the start of a put's bytes).
import assert from "node:assert/strict";
import { Readable } from "node:stream";
import { inspect } from "node:util";
import { DeleteObjectCommand, GetObjectCommand, NoSuchBucket, NoSuchKey, PutObjectCommand, S3Client } from "@aws-sdk/client-s3";
import { NodeHttpHandler } from "@smithy/node-http-handler";
import { s3PutRequestsTotal } from "../../metrics";
import { appObjectStorage } from "../../services/appObjectStorage";
import { resetStorageForTests } from "../../services/storageService";
import { artifactBlobStore, r2KeyOf } from "./blobStore";
import type { ArtifactBlobRow } from "./schema";

const config = {
  endpoint: "https://r2.app-objects.test",
  accessKeyId: "app-objects-key",
  secretAccessKey: "app-objects-secret",
  bucket: "app-objects-bucket",
};
const key = r2KeyOf("server-1", "a".repeat(64), "blob-1");
/** Where the platform keeps it: Artifacts' prefix, then the row's key. */
const bucketKey = `apps/artifacts/${key}`;
const blob = { r2Key: key, sizeBytes: 5 } as ArtifactBlobRow;
const createStore = () => artifactBlobStore(appObjectStorage("artifacts"));

const originalSend = S3Client.prototype.send;
let sent: unknown[] = [];
let readSignals: Array<AbortSignal | undefined> = [];
let answer: (command: unknown) => unknown = () => ({});

beforeEach(() => {
  vi.stubEnv("APP_STORAGE_R2_ENDPOINT", config.endpoint);
  vi.stubEnv("APP_STORAGE_R2_ACCESS_KEY_ID", config.accessKeyId);
  vi.stubEnv("APP_STORAGE_R2_SECRET_ACCESS_KEY", config.secretAccessKey);
  vi.stubEnv("APP_STORAGE_R2_BUCKET", config.bucket);
  resetStorageForTests();
  sent = [];
  readSignals = [];
  answer = () => ({});
  (S3Client.prototype as unknown as { send: (command: unknown, options?: { abortSignal?: AbortSignal }) => Promise<unknown> }).send = async function (command: unknown, options?: { abortSignal?: AbortSignal }) {
    sent.push(command);
    if (command instanceof GetObjectCommand) readSignals.push(options?.abortSignal);
    return answer(command);
  };
});

afterEach(() => {
  S3Client.prototype.send = originalSend;
  vi.unstubAllEnvs();
  resetStorageForTests();
});

async function putCount(outcome: string): Promise<number> {
  const metric = await s3PutRequestsTotal.get();
  return metric.values.find((v) => v.labels.bucket === config.bucket && v.labels.endpoint_host === "r2.app-objects.test" && v.labels.outcome === outcome)?.value ?? 0;
}

test("a put goes to the app-content bucket at Artifacts' prefix and the blob key, counted by core's S3 put metrics", async () => {
  const store = createStore();
  const before = await putCount("ok");
  await store.put(key, Buffer.from("hello"));
  assert.equal(sent.length, 1);
  const command = sent[0];
  assert.ok(command instanceof PutObjectCommand);
  assert.equal(command.input.Bucket, config.bucket);
  assert.equal(command.input.Key, bucketKey);
  assert.equal(command.input.ContentLength, 5);
  assert.equal(command.input.ContentType, "application/octet-stream");
  assert.equal(await putCount("ok"), before + 1);
});

test("a read streams the object with the blob row's size; a missing object is null, a missing bucket an error", async () => {
  const store = createStore();
  // The row's verified size is what counts, not the response's.
  answer = () => ({ Body: Readable.from([Buffer.from("hello")]), ContentLength: 7 });
  const bytes = await store.read(blob);
  assert.ok(bytes);
  assert.equal(bytes.size, 5);
  const chunks: Buffer[] = [];
  for await (const chunk of bytes.stream) chunks.push(Buffer.from(chunk));
  assert.equal(Buffer.concat(chunks).toString(), "hello");
  const command = sent[0];
  assert.ok(command instanceof GetObjectCommand);
  assert.equal(command.input.Bucket, config.bucket);
  assert.equal(command.input.Key, bucketKey);

  answer = () => { throw new NoSuchKey({ message: "missing", $metadata: { httpStatusCode: 404 } }); };
  assert.equal(await store.read(blob), null);

  answer = () => { throw new NoSuchBucket({ message: "no bucket", $metadata: { httpStatusCode: 404 } }); };
  await assert.rejects(store.read(blob), (error: Error) => error.name === "NoSuchBucket");

  answer = () => { throw new Error("socket hang up"); };
  await assert.rejects(store.read(blob), /socket hang up/);
});

test("a canceled Artifact read reaches the SDK through both storage handles", async () => {
  const controller = new AbortController();
  answer = () => ({ Body: Readable.from([Buffer.from("hello")]) });
  const bytes = await createStore().read(blob, controller.signal);
  bytes?.stream.destroy();
  assert.equal(readSignals.length, 1);
  assert.ok(readSignals[0] === controller.signal, "the caller's cancellation reaches the bucket GET");
  controller.abort();
  assert.equal(readSignals[0]?.aborted, true);
});

test("a presigned GET names the bucket and key and fixes the response type and disposition", async () => {
  const store = createStore();
  const url = new URL(await store.presign(blob, {
    expiresInSeconds: 300,
    contentType: "image/png",
    contentDisposition: "attachment; filename=\"a.png\"",
  }) ?? "");
  // Path style: the bucket is the first path segment, as R2 needs.
  assert.equal(url.host, "r2.app-objects.test");
  assert.equal(decodeURIComponent(url.pathname), `/${config.bucket}/${bucketKey}`);
  assert.equal(url.searchParams.get("response-content-type"), "image/png");
  assert.equal(url.searchParams.get("response-content-disposition"), "attachment; filename=\"a.png\"");
  assert.equal(url.searchParams.get("X-Amz-Expires"), "300");
  assert.match(url.searchParams.get("X-Amz-Credential") ?? "", /^app-objects-key\//);
  assert.equal(sent.length, 0);
});

test("a delete removes the key at Artifacts' prefix from the app-content bucket", async () => {
  const store = createStore();
  await store.delete(key);
  const command = sent[0];
  assert.ok(command instanceof DeleteObjectCommand);
  assert.equal(command.input.Bucket, config.bucket);
  assert.equal(command.input.Key, bucketKey);
});

test("no key or bytes reach the console on a put or a read, succeeding or failing", async () => {
  // Through the SDK's own middleware (its logger runs there, at info on success and error on failure),
  // with only the HTTP handler stubbed.
  S3Client.prototype.send = originalSend;
  const originalHandle = NodeHttpHandler.prototype.handle;
  const logged: unknown[][] = [];
  const spies = (["trace", "debug", "info", "log", "warn", "error"] as const).map((level) => vi.spyOn(console, level).mockImplementation((...args: unknown[]) => { logged.push(args); }));
  let statusCode = 200;
  NodeHttpHandler.prototype.handle = async function () {
    return { response: { statusCode, headers: { "content-length": "5" }, body: Readable.from([Buffer.from("SECRET")]) } } as never;
  };
  try {
    const store = createStore();
    await store.put(key, Buffer.from("SECRET"));
    (await store.read(blob))?.stream.destroy();
    statusCode = 500;
    await assert.rejects(store.put(key, Buffer.from("SECRET")));
    await assert.rejects(store.read(blob));
  } finally {
    NodeHttpHandler.prototype.handle = originalHandle;
    for (const spy of spies) spy.mockRestore();
  }
  assert.ok(logged.length > 0, "a failure is still logged");
  const text = logged.map((args) => args.map((arg) => typeof arg === "string" ? arg : inspect(arg, { depth: 6 })).join(" ")).join("\n");
  assert.doesNotMatch(text, /SECRET|53 45 43 52 45 54/);
  // A failure names the command, never its input; core's own put-failure log names the key, as for attachments.
  assert.doesNotMatch(text, /Body:/);
});
