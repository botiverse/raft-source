// The platform's app-content bucket and each app's handle on it: the handle
// adds `apps/<id>/` to every key and refuses a key that could leave it,
// before any request; the bucket is configured all or nothing from
// APP_STORAGE_R2_* and never from another bucket's settings.
import assert from "node:assert/strict";
import { Readable } from "node:stream";
import keyVectors from "@botiverse/raft-shared/src/testVectors/appObjectKeys.vectors.json" with { type: "json" };
import { appObjectStorage, AppObjectStorageUnavailableError, InvalidAppObjectKeyError, objectFilesStorage } from "./appObjectStorage";
import { getAppObjectsBucket, resetStorageForTests, type S3BucketStorage } from "./storageService";

type Call = [op: string, key: string];

function fakeBucket(opts: { missing?: string } = {}): { bucket: S3BucketStorage; calls: Call[] } {
  const calls: Call[] = [];
  const bucket: S3BucketStorage = {
    async put(key) {
      calls.push(["put", key]);
    },
    async get(key) {
      calls.push(["get", key]);
      if (key === opts.missing) throw Object.assign(new Error("missing"), { name: "NoSuchKey" });
      return Readable.from([Buffer.from("x")]);
    },
    async delete(key) {
      calls.push(["delete", key]);
    },
    async getPresignedUrl(key) {
      calls.push(["presign", key]);
      return `https://bucket.test/${key}`;
    },
  };
  return { bucket, calls };
}

test("every operation is at the app's own prefix", async () => {
  const { bucket, calls } = fakeBucket();
  const storage = appObjectStorage("artifacts", () => bucket);
  const key = "servers/0b6e/blobs/ab12/b_1";
  assert.equal(storage.configured, true);
  await storage.put(key, Buffer.from("x"), "application/octet-stream");
  await storage.get(key);
  await storage.delete(key);
  assert.equal(await storage.presignGet(key, { expiresInSeconds: 60 }), `https://bucket.test/apps/artifacts/${key}`);
  assert.deepEqual(calls, [
    ["put", `apps/artifacts/${key}`],
    ["get", `apps/artifacts/${key}`],
    ["delete", `apps/artifacts/${key}`],
    ["presign", `apps/artifacts/${key}`],
  ]);
  // Another app's handle on the same bucket is under its own prefix.
  await appObjectStorage("reminder-two", () => bucket).delete(key);
  assert.deepEqual(calls.at(-1), ["delete", `apps/reminder-two/${key}`]);
});

test("core's object files are under objects/, outside every app's prefix, by the same key rule", async () => {
  const { bucket, calls } = fakeBucket();
  const storage = objectFilesStorage(() => bucket);
  const key = "servers/0b6e/files/5f0c";
  await storage.put(key, Buffer.from("x"), "image/png");
  await storage.delete(key);
  assert.deepEqual(calls, [["put", `objects/${key}`], ["delete", `objects/${key}`]]);
  for (const refused of ["../apps/artifacts/x", "/apps/artifacts/x", "a//b"]) {
    await assert.rejects(storage.delete(refused), InvalidAppObjectKeyError, refused);
  }
  assert.equal(calls.length, 2);
});

test("a key that could leave the app's prefix is refused before any request", async () => {
  const { bucket, calls } = fakeBucket();
  const storage = appObjectStorage("artifacts", () => bucket);
  const refused = [
    "",
    "/servers/a",
    "/",
    "..",
    "../other/x",
    "a/../../other/x",
    "a/..",
    "a..b",
    "a/./b",
    ".",
    "./a",
    "a//b",
    "a/",
    "a\\..\\b",
    "a\\b",
    "a/%2e%2e/b",
    "a b",
    "a\nb",
    "a\0b",
    "ünïcode",
    "x".repeat(1024 - "apps/artifacts/".length + 1),
  ];
  for (const key of refused) {
    await assert.rejects(storage.put(key, Buffer.from("x"), "text/plain"), InvalidAppObjectKeyError, JSON.stringify(key));
    await assert.rejects(storage.get(key), InvalidAppObjectKeyError, JSON.stringify(key));
    await assert.rejects(storage.delete(key), InvalidAppObjectKeyError, JSON.stringify(key));
    await assert.rejects(storage.presignGet(key, { expiresInSeconds: 60 }), InvalidAppObjectKeyError, JSON.stringify(key));
  }
  assert.equal(calls.length, 0, `no refused key reached the bucket: ${JSON.stringify(calls)}`);
  // Accepted, at the prefix: the longest key that fits with it, and keys with dots that are not . or .. segments.
  const longest = "x".repeat(1024 - "apps/artifacts/".length);
  for (const key of [longest, "a", "a.b", "a_b-c~d", "servers/0b6e/blobs/ab12/b_1", ".hidden", "a/.b"]) {
    await storage.delete(key);
    assert.deepEqual(calls.at(-1), ["delete", `apps/artifacts/${key}`], key);
  }
  assert.equal(calls.at(0)?.[1].length, 1024);
});

test("the handle answers every shared key case as the shared rule does (the content Worker checks keys with it too)", async () => {
  const { bucket, calls } = fakeBucket();
  assert.equal(keyVectors.prefix, "apps/artifacts/");
  const storage = appObjectStorage("artifacts", () => bucket);
  for (const { why, key, problem } of keyVectors.cases) {
    calls.length = 0;
    if (problem === null) {
      await storage.delete(key);
      assert.deepEqual(calls, [["delete", `${keyVectors.prefix}${key}`]], why);
    } else {
      await assert.rejects(storage.delete(key), new InvalidAppObjectKeyError(problem), why);
      assert.equal(calls.length, 0, why);
    }
  }
});

test("an app id the registry would refuse gets no handle", () => {
  for (const id of ["", "Artifacts", "../x", "a/b", "1app", "a b", "apps/x"]) {
    assert.throws(() => appObjectStorage(id, () => null), /is not an app id/, JSON.stringify(id));
  }
});

test("the handle holds no bucket or credentials, and can't be changed", () => {
  const { bucket } = fakeBucket();
  const storage = appObjectStorage("artifacts", () => bucket);
  assert.deepEqual(Object.keys(storage).sort(), ["configured", "delete", "get", "presignGet", "put"]);
  assert.ok(Object.isFrozen(storage));
  assert.throws(() => {
    (storage as unknown as { put: unknown }).put = async () => {};
  }, TypeError);
});

test("a missing object reads as null; any other failure stays an error", async () => {
  const { bucket } = fakeBucket({ missing: "apps/artifacts/gone" });
  const storage = appObjectStorage("artifacts", () => bucket);
  assert.equal(await storage.get("gone"), null);
  const failing = appObjectStorage("artifacts", () => ({
    ...bucket,
    get: async () => {
      throw Object.assign(new Error("no bucket"), { name: "NoSuchBucket" });
    },
  }));
  await assert.rejects(failing.get("x"), (error: Error) => error.name === "NoSuchBucket");
});

test("without the bucket: not configured, every operation refuses", async () => {
  const storage = appObjectStorage("artifacts", () => null);
  assert.equal(storage.configured, false);
  await assert.rejects(storage.put("a", Buffer.from("x"), "text/plain"), AppObjectStorageUnavailableError);
  await assert.rejects(storage.get("a"), AppObjectStorageUnavailableError);
  await assert.rejects(storage.delete("a"), AppObjectStorageUnavailableError);
  await assert.rejects(storage.presignGet("a", { expiresInSeconds: 60 }), AppObjectStorageUnavailableError);
});

describe("the app-content bucket from APP_STORAGE_R2_*", () => {
  const full = {
    APP_STORAGE_R2_ENDPOINT: "https://r2.app-objects.test",
    APP_STORAGE_R2_ACCESS_KEY_ID: "AKID-VALUE",
    APP_STORAGE_R2_SECRET_ACCESS_KEY: "secret",
    APP_STORAGE_R2_BUCKET: "app-objects",
  };
  // The attachment bucket's settings: never used for app objects.
  const attachments = {
    S3_ENDPOINT: "https://r2.attachments.test",
    S3_ACCESS_KEY_ID: "attachments-key",
    S3_SECRET_ACCESS_KEY: "attachments-secret",
    S3_ATTACHMENTS_BUCKET: "attachments",
  };

  beforeEach(() => resetStorageForTests());
  afterEach(() => resetStorageForTests());

  test("all of it: a bucket", () => {
    const log = vi.spyOn(console, "log").mockImplementation(() => {});
    try {
      assert.ok(getAppObjectsBucket(full));
    } finally {
      log.mockRestore();
    }
  });

  test("none of it: none, even with the attachment bucket configured", () => {
    assert.equal(getAppObjectsBucket({ ...attachments }), null);
  });

  test("part of it: none, with a warning naming what is missing (never filled from the attachment settings)", () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    try {
      const { APP_STORAGE_R2_SECRET_ACCESS_KEY: _secret, APP_STORAGE_R2_BUCKET: _bucket, ...partial } = full;
      assert.equal(getAppObjectsBucket({ ...attachments, ...partial }), null);
      assert.deepEqual(warn.mock.calls.map(([, fields]) => fields), [{ missing: ["APP_STORAGE_R2_SECRET_ACCESS_KEY", "APP_STORAGE_R2_BUCKET"] }]);
      assert.doesNotMatch(JSON.stringify(warn.mock.calls), /AKID-VALUE/, "names settings, never values");
    } finally {
      warn.mockRestore();
    }
  });
});
