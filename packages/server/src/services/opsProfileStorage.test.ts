import assert from "node:assert/strict";
import { afterEach, describe, it, vi } from "vitest";
import { getOpsProfileStorage, resetStorageForTests, resolveOpsProfileStorageConfig } from "./storageService";

const MAIN = { S3_ENDPOINT: "https://main.example", S3_ACCESS_KEY_ID: "main-key", S3_SECRET_ACCESS_KEY: "main-secret" };
const DEDICATED = {
  OPS_PROFILE_S3_ENDPOINT: "https://ops.example",
  OPS_PROFILE_S3_ACCESS_KEY_ID: "ops-key",
  OPS_PROFILE_S3_SECRET_ACCESS_KEY: "ops-secret",
};
const BUCKET = { S3_OPS_PROFILE_BUCKET: "ops-profiles" };

describe("resolveOpsProfileStorageConfig", () => {
  it("is disabled without a bucket, even with credentials", () => {
    assert.deepEqual(resolveOpsProfileStorageConfig({ ...MAIN, ...DEDICATED }), { kind: "disabled" });
  });

  it("uses the dedicated client when all three OPS_PROFILE_S3_* are set", () => {
    const config = resolveOpsProfileStorageConfig({ ...BUCKET, ...MAIN, ...DEDICATED, OPS_PROFILE_S3_REGION: "weur" });
    assert.equal(config.kind, "dedicated");
    assert.ok(config.kind === "dedicated");
    assert.equal(config.endpoint, "https://ops.example");
    assert.equal(config.accessKeyId, "ops-key");
    assert.equal(config.secretAccessKey, "ops-secret");
    assert.equal(config.region, "weur");
    assert.equal(config.bucket, "ops-profiles");
  });

  it("defaults the dedicated region to auto and does not need main credentials", () => {
    const config = resolveOpsProfileStorageConfig({ ...BUCKET, ...DEDICATED });
    assert.ok(config.kind === "dedicated");
    assert.equal(config.region, "auto");
  });

  it("falls back to the main credentials only when no OPS_PROFILE_S3_* is set", () => {
    const config = resolveOpsProfileStorageConfig({ ...BUCKET, ...MAIN });
    assert.ok(config.kind === "main");
    assert.equal(config.endpoint, "https://main.example");
    assert.equal(config.accessKeyId, "main-key");
  });

  it("is disabled with a bucket but neither dedicated nor main credentials", () => {
    assert.deepEqual(resolveOpsProfileStorageConfig({ ...BUCKET }), { kind: "disabled" });
  });

  for (const omitted of Object.keys(DEDICATED)) {
    it(`treats a partial dedicated set (missing ${omitted}) as misconfigured, not main`, () => {
      const env: NodeJS.ProcessEnv = { ...BUCKET, ...MAIN, ...DEDICATED };
      delete env[omitted];
      assert.deepEqual(resolveOpsProfileStorageConfig(env), { kind: "misconfigured", missing: [omitted] });
    });
  }

  it("treats blank dedicated values as unset", () => {
    const config = resolveOpsProfileStorageConfig({ ...BUCKET, ...MAIN, ...DEDICATED, OPS_PROFILE_S3_SECRET_ACCESS_KEY: "  " });
    assert.deepEqual(config, { kind: "misconfigured", missing: ["OPS_PROFILE_S3_SECRET_ACCESS_KEY"] });
  });
});

describe("getOpsProfileStorage", () => {
  afterEach(() => {
    vi.unstubAllEnvs();
    vi.restoreAllMocks();
    resetStorageForTests();
  });

  it("stays closed on a partial dedicated set and logs names, never values", () => {
    for (const [name, value] of Object.entries({ ...BUCKET, ...MAIN })) vi.stubEnv(name, value);
    vi.stubEnv("OPS_PROFILE_S3_ENDPOINT", DEDICATED.OPS_PROFILE_S3_ENDPOINT);
    vi.stubEnv("OPS_PROFILE_S3_ACCESS_KEY_ID", DEDICATED.OPS_PROFILE_S3_ACCESS_KEY_ID);
    vi.stubEnv("OPS_PROFILE_S3_SECRET_ACCESS_KEY", "");
    const error = vi.spyOn(console, "error").mockImplementation(() => {});
    resetStorageForTests();

    assert.equal(getOpsProfileStorage(), null);
    assert.equal(error.mock.calls.length, 1);
    const logged = error.mock.calls.flat().join(" ");
    assert.match(logged, /OPS_PROFILE_S3_SECRET_ACCESS_KEY/);
    for (const secret of ["ops-key", "main-key", "main-secret", "https://ops.example"]) {
      assert.ok(!logged.includes(secret), `log must not contain ${secret}`);
    }
  });

  it("builds a client when the dedicated set is complete", () => {
    for (const [name, value] of Object.entries({ ...BUCKET, ...DEDICATED })) vi.stubEnv(name, value);
    resetStorageForTests();
    assert.notEqual(getOpsProfileStorage(), null);
  });
});
