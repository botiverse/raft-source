import assert from "node:assert/strict";
import { describe, it } from "vitest";
import { reportOpsCpuProfileStartup } from "./opsCpuProfile";
import { resolveOpsProfileStorageConfig, type StorageBackend } from "../services/storageService";

const TOKEN = "t".repeat(40);
const fakeStorage = {} as StorageBackend;

function run(env: NodeJS.ProcessEnv, storage: StorageBackend | null) {
  const lines: string[] = [];
  const result = reportOpsCpuProfileStartup(env, {
    getStorage: () => storage,
    resolve: resolveOpsProfileStorageConfig,
    log: line => lines.push(line),
  });
  return { result, lines };
}

describe("reportOpsCpuProfileStartup", () => {
  it("does nothing when profiling is off", () => {
    const { result, lines } = run({}, fakeStorage);
    assert.equal(result, null);
    assert.deepEqual(lines, []);
  });

  it("logs dedicated mode and an open endpoint, without values", () => {
    const env = {
      CPU_PROFILE_ENABLED: "true",
      OPS_PROFILE_TOKEN: TOKEN,
      S3_OPS_PROFILE_BUCKET: "ops-bucket",
      OPS_PROFILE_S3_ENDPOINT: "https://ops.example",
      OPS_PROFILE_S3_ACCESS_KEY_ID: "ops-key",
      OPS_PROFILE_S3_SECRET_ACCESS_KEY: "ops-secret",
    };
    const { lines } = run(env, fakeStorage);
    assert.equal(lines.length, 1);
    assert.match(lines[0], /storage mode=dedicated; endpoint open/);
    for (const value of [TOKEN, "ops-bucket", "https://ops.example", "ops-key", "ops-secret"]) {
      assert.ok(!lines[0].includes(value), `startup line must not contain ${value}`);
    }
  });

  it("reports misconfigured and closed for a partial dedicated set", () => {
    const env = {
      CPU_PROFILE_ENABLED: "true",
      OPS_PROFILE_TOKEN: TOKEN,
      S3_OPS_PROFILE_BUCKET: "ops-bucket",
      OPS_PROFILE_S3_ENDPOINT: "https://ops.example",
    };
    const { lines } = run(env, null);
    assert.match(lines[0], /storage mode=misconfigured; endpoint closed/);
  });

  it("reports closed when the token is missing even if storage resolves", () => {
    const env = { CPU_PROFILE_ENABLED: "true", S3_OPS_PROFILE_BUCKET: "b", S3_ENDPOINT: "e", S3_ACCESS_KEY_ID: "k", S3_SECRET_ACCESS_KEY: "s" };
    const { lines } = run(env, fakeStorage);
    assert.match(lines[0], /storage mode=main; endpoint closed/);
  });
});
