import assert from "node:assert/strict";
import { createServer } from "node:http";
import test from "node:test";
import { gzipSync } from "node:zlib";
import { S3TraceStorage } from "./nodeStorage.js";

test("S3TraceStorage writes objects to R2 path-style endpoint with metadata", async () => {
  const calls: Array<{ input: RequestInfo | URL; init?: RequestInit }> = [];
  const storage = new S3TraceStorage({
    endpoint: "https://account.r2.cloudflarestorage.com",
    bucket: "trace-bucket",
    accessKeyId: "access-key",
    secretAccessKey: "secret-key",
    fetch: async (input, init) => {
      calls.push({ input, init });
      return new Response("", { status: 200, headers: { etag: '"etag-1"' } });
    },
  });

  const result = await storage.put("trace-bundles/server/machine/upload.jsonl.gz", Buffer.from("bundle"), {
    httpMetadata: {
      contentType: "application/x-ndjson",
      contentEncoding: "gzip",
    },
    customMetadata: {
      uploadId: "upload-1",
      bundleSha256: "a".repeat(64),
    },
  });

  assert.deepEqual(result, { etag: '"etag-1"' });
  assert.equal(calls.length, 1);
  assert.equal(
    String(calls[0].input),
    "https://account.r2.cloudflarestorage.com/trace-bucket/trace-bundles/server/machine/upload.jsonl.gz",
  );
  const headers = new Headers(calls[0].init?.headers);
  assert.equal(headers.get("content-type"), "application/x-ndjson");
  assert.equal(headers.get("content-encoding"), "gzip");
  assert.equal(headers.get("x-amz-meta-uploadid"), "upload-1");
  assert.equal(headers.get("x-amz-meta-bundlesha256"), "a".repeat(64));
  assert.match(headers.get("authorization") ?? "", /^AWS4-HMAC-SHA256 Credential=access-key\/\d{8}\/auto\/s3\/aws4_request,/);
});

test("S3TraceStorage reads raw gzip bytes and maps R2 metadata", async () => {
  const rawBundle = Buffer.from('{"type":"span"}\n');
  const gzippedBundle = gzipSync(rawBundle);
  const server = createServer((request, response) => {
    assert.equal(request.method, "GET");
    assert.equal(request.url, "/trace-bucket/trace-bundles/server/machine/upload.jsonl.gz");
    response.writeHead(200, {
      "content-type": "application/x-ndjson",
      "content-encoding": "gzip",
      "x-amz-meta-uploadid": "upload-1",
    });
    response.end(gzippedBundle);
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  try {
    const address = server.address();
    assert.ok(address && typeof address === "object");
    const storage = new S3TraceStorage({
      endpoint: `http://127.0.0.1:${address.port}`,
      bucket: "trace-bucket",
      accessKeyId: "access-key",
      secretAccessKey: "secret-key",
    });

    const object = await storage.get("trace-bundles/server/machine/upload.jsonl.gz");

    assert.ok(object);
    assert.equal(object.httpMetadata?.contentType, "application/x-ndjson");
    assert.equal(object.httpMetadata?.contentEncoding, "gzip");
    assert.deepEqual(object.customMetadata, { uploadid: "upload-1" });
    assert.deepEqual(Buffer.from(await new Response(object.body).arrayBuffer()), gzippedBundle);
  } finally {
    await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
  }
});

test("S3TraceStorage returns null on missing objects", async () => {
  const server = createServer((_request, response) => {
    response.writeHead(404);
    response.end();
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  try {
    const address = server.address();
    assert.ok(address && typeof address === "object");
    const storage = new S3TraceStorage({
      endpoint: `http://127.0.0.1:${address.port}`,
      bucket: "trace-bucket",
      accessKeyId: "access-key",
      secretAccessKey: "secret-key",
    });

    assert.equal(await storage.get("missing.jsonl"), null);
  } finally {
    await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
  }
});
