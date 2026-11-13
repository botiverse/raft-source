import assert from "node:assert/strict";
import { test } from "vitest";
import { cdnStorageConnection } from "./storageService";

const main = { S3_ENDPOINT: "https://main.example", S3_ACCESS_KEY_ID: "main-id", S3_SECRET_ACCESS_KEY: "main-secret" };

test("CDN connection: its own S3_CDN_* when complete, otherwise the main storage's", () => {
  assert.deepEqual(cdnStorageConnection(main), {
    endpoint: "https://main.example", region: "auto", accessKeyId: "main-id", secretAccessKey: "main-secret", forcePathStyle: false,
  });
  assert.deepEqual(cdnStorageConnection({
    ...main,
    S3_CDN_ENDPOINT: "https://cdn.example",
    S3_CDN_ACCESS_KEY_ID: "cdn-id",
    S3_CDN_SECRET_ACCESS_KEY: "cdn-secret",
    S3_CDN_FORCE_PATH_STYLE: "true",
  }), {
    endpoint: "https://cdn.example", region: "auto", accessKeyId: "cdn-id", secretAccessKey: "cdn-secret", forcePathStyle: true,
  });
  // Partial: never a mix of the two accounts.
  assert.equal(cdnStorageConnection({ ...main, S3_CDN_ACCESS_KEY_ID: "cdn-id" }).accessKeyId, "main-id");
  assert.equal(cdnStorageConnection({ ...main, S3_CDN_ACCESS_KEY_ID: "cdn-id" }).endpoint, "https://main.example");
});
