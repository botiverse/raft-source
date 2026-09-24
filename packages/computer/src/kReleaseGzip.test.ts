import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { createRequire } from "node:module";
import { pathToFileURL } from "node:url";
import { gzipSync } from "node:zlib";
import { test } from "vitest";
import type { Release } from "@botiverse/k-carrier";
// Resolve the installed package so this exercises the pinned dependency patch.
const { downloadVerified } = await import(new URL("./artifact/download.ts", pathToFileURL(createRequire(import.meta.url).resolve("@botiverse/k-carrier"))).href) as {
  downloadVerified(release: Release, options: { fetchImpl: typeof fetch }): Promise<Uint8Array>;
};
import { createComputerReleaseSource } from "./kReleaseSource.js";

const raw = Buffer.from("Computer binary payload".repeat(20));
const gz = gzipSync(raw);
const hash = (bytes: Uint8Array) => createHash("sha256").update(bytes).digest("hex");
const rawUrl = "https://download.example/computer";
const gzUrl = `${rawUrl}.gz`;
function response(gzip: boolean) {
  return {
    update_available: true,
    app: { id: "app", slug: "raft-computer-cli" },
    release: { id: "release", revision: 1, channel: "main", channel_id: "main",
      version: "1.0.30", version_code: 1000030, version_relation: "upgrade", published_at: 1 },
    artifact: { id: "artifact", download_url: rawUrl, size_bytes: raw.length, sha256: hash(raw),
      ...(gzip ? { gzip: { download_url: gzUrl, size_bytes: gz.length, sha256: hash(gz) } } : {}) },
  };
}
const ctx = { currentVersion: "1.0.29", platformKey: "linux-x64" };
const options = {
  backend: "hands" as const,
  handsApiOrigin: "https://hands.example",
  channelProvider: () => "latest" as const,
  getHandsDeviceIdFn: async () => "123e4567-e89b-4d3a-a456-426614174000",
};

test.each([true, false])("real SDK → Computer → K downloads the advertised representation (gzip=%s)", async (gzip) => {
  const source = createComputerReleaseSource("https://unused.example", {
    ...options, fetchFn: async () => Response.json(response(gzip)),
  });
  const release = await source.checkForUpdate(ctx);
  assert.ok(release);
  assert.equal(release.sha256, hash(raw));
  assert.equal(release.size, raw.length);
  const calls: string[] = [];
  const bytes = await downloadVerified(release, { fetchImpl: async (url) => {
    calls.push(String(url));
    return new Response(gzip ? gz : raw);
  } });
  assert.deepEqual(Buffer.from(bytes), raw);
  assert.deepEqual(calls, [gzip ? gzUrl : rawUrl]);
});

test("observed gzip identity cannot change between update check and exact fetch", async () => {
  const payload = response(true);
  const source = createComputerReleaseSource("https://unused.example", {
    ...options, fetchFn: async () => Response.json(payload),
  });
  await source.checkForUpdate(ctx);
  payload.artifact.gzip!.sha256 = "0".repeat(64);
  await assert.rejects(source.fetchRelease("1.0.30", ctx), /K_SOURCE_IDENTITY_DRIFT/);
});

test("corrupt gz fails before staging without falling back to a second download", async () => {
  const source = createComputerReleaseSource("https://unused.example", {
    ...options, fetchFn: async () => Response.json(response(true)),
  });
  const release = await source.checkForUpdate(ctx);
  assert.ok(release);
  let requests = 0;
  await assert.rejects(downloadVerified(release, { fetchImpl: async () => {
    requests++;
    return new Response(Buffer.from("corrupt"));
  } }), /SHA256_MISMATCH/);
  assert.equal(requests, 1);
});
