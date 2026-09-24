import assert from "node:assert/strict";
import { test } from "vitest";
import {
  COMPUTER_HANDS_ALPHA_URL,
  evaluateBroadcastPolicy,
  isQueuedComputerUpgradePolicyCompatible,
  normalizeComputerPlatform,
  type EvaluateComputerBroadcastPolicyInput,
} from "./computerBroadcastPolicyService.js";

function release() {
  return {
    app: { slug: "raft-computer-cli", platform: "node" }, channel: "alpha",
    build: { id: "build-31", version: "1.0.31" },
    scoped: { release_id: "release-31" },
    assets: [{ platform: "darwin", arch: "arm64", variant: null, filetype: "binary",
      sha256: "a".repeat(64), size_bytes: 100, download_url: "https://hands.build/artifact" }],
  };
}
function input(overrides: Partial<EvaluateComputerBroadcastPolicyInput> = {}): EvaluateComputerBroadcastPolicyInput {
  return { source: { version: "1.0.23", observedAt: "2026-01-01T00:00:00Z", provenance: "owner_connection" },
    platform: { os: "macos", architecture: "arm64" }, now: new Date("2026-09-10T00:00:00Z"), ...overrides };
}
function respond(body = release()): typeof fetch {
  return async (url) => {
    assert.equal(url, COMPUTER_HANDS_ALPHA_URL);
    assert.equal(new URL(String(url)).searchParams.get("channel"), "alpha");
    return Response.json(body);
  };
}

test("legacy source with no Server matrix row resolves current Hands alpha after the former policy expiry", async () => {
  const result = await evaluateBroadcastPolicy(input(), { fetchFn: respond() });
  assert.equal(result.eligibility, "eligible");
  assert.equal(result.targetVersion, "1.0.31");
  assert.equal(result.policyRow, null);
  assert.equal(result.handsRelease?.releaseId, "release-31");
  assert.equal(result.handsRelease?.sha256, "a".repeat(64));
});

test("all five supported platform artifacts are selected by exact OS/architecture", async () => {
  for (const [os, platform, architecture] of [
    ["macos", "darwin", "arm64"], ["macos", "darwin", "x64"],
    ["linux", "linux", "arm64"], ["linux", "linux", "x64"], ["windows", "win32", "x64"],
  ] as const) {
    const body = release(); body.assets[0]!.platform = platform; body.assets[0]!.arch = architecture;
    assert.equal((await evaluateBroadcastPolicy(input({ platform: { os, architecture } }),
      { fetchFn: respond(body) })).eligibility, "eligible");
  }
});

test("rejects missing, mismatched, and duplicate raw platform artifacts", async () => {
  for (const change of [
    (body: ReturnType<typeof release>) => { body.assets = []; },
    (body: ReturnType<typeof release>) => { body.assets[0]!.arch = "x64"; },
    (body: ReturnType<typeof release>) => { body.assets.push({ ...body.assets[0]! }); },
  ]) {
    const body = release(); change(body);
    const result = await evaluateBroadcastPolicy(input(), { fetchFn: respond(body) });
    assert.equal(result.eligibility, "no_broadcast"); assert.equal(result.reasonCode, "hands_artifact_missing");
  }
});

test("rejects malformed version, identity, size, origin channel and app", async () => {
  for (const change of [
    (body: ReturnType<typeof release>) => { body.build.version = "1.0.031"; },
    (body: ReturnType<typeof release>) => { body.build.version = "1.0.31-01"; },
    (body: ReturnType<typeof release>) => { body.assets[0]!.sha256 = "bad"; },
    (body: ReturnType<typeof release>) => { body.assets[0]!.size_bytes = 0; },
    (body: ReturnType<typeof release>) => { body.assets[0]!.download_url = "http://hands.build/artifact"; },
    (body: ReturnType<typeof release>) => { body.channel = "main"; },
    (body: ReturnType<typeof release>) => { body.app.slug = "other"; },
  ]) {
    const body = release(); change(body);
    assert.equal((await evaluateBroadcastPolicy(input(), { fetchFn: respond(body) })).reasonCode, "hands_response_invalid");
  }
});

test("Hands HTTP/network/JSON failures never fall back to a compiled target or CDN", async () => {
  for (const fetchFn of [
    async () => new Response("unavailable", { status: 503 }),
    async () => { throw new Error("network unavailable"); },
    async () => new Response("not JSON"),
  ] satisfies Array<typeof fetch>) {
    const result = await evaluateBroadcastPolicy(input(), { fetchFn });
    assert.equal(result.eligibility, "no_broadcast"); assert.equal(result.targetVersion, null);
  }
});

test("deadline aborts the actual pending request", async () => {
  let aborted = false;
  const fetchFn: typeof fetch = async (_url, init) => new Promise((_resolve, reject) => {
    init?.signal?.addEventListener("abort", () => { aborted = true; reject(new Error("aborted")); }, { once: true });
  });
  const result = await evaluateBroadcastPolicy(input(), { fetchFn, timeoutMs: 10 });
  assert.equal(aborted, true); assert.equal(result.reasonCode, "hands_unavailable");
});

test("current or newer Computer is not downgraded, including prerelease precedence", async () => {
  for (const [source, target, eligible] of [
    ["1.0.31", "1.0.31", false], ["1.0.32", "1.0.31", false],
    ["1.0.31-rc.2", "1.0.31", true], ["1.0.31", "1.0.31-rc.2", false],
    ["1.0.31-rc.9", "1.0.31-rc.10", true], ["1.0.31+build1", "1.0.31+build2", false],
  ] as const) {
    const body = release(); body.build.version = target;
    const result = await evaluateBroadcastPolicy(input({ source: { version: source, observedAt: null, provenance: null } }), { fetchFn: respond(body) });
    assert.equal(result.eligibility === "eligible", eligible, `${source} -> ${target}`);
  }
});

test("requested target cannot override the active Hands alpha release", async () => {
  assert.equal((await evaluateBroadcastPolicy(input({ requestedTargetVersion: "1.0.28" }), { fetchFn: respond() })).reasonCode, "requested_target_mismatch");
});

test("unknown source/platform is rejected before fetching", async () => {
  for (const value of [input({ source: null }), input({ source: { version: "invalid", observedAt: null, provenance: null } }), input({ platform: null })]) {
    const result = await evaluateBroadcastPolicy(value, { fetchFn: async () => { assert.fail("must not fetch"); } });
    assert.equal(result.eligibility, "no_broadcast");
  }
});

test("queued dispatch preserves exact release identity, rejects old matrix receipts and changed assets", async () => {
  const original = await evaluateBroadcastPolicy(input(), { fetchFn: respond() });
  const next = { ...original, sourceObservedAt: "2026-09-10T01:00:00Z" };
  assert.equal(isQueuedComputerUpgradePolicyCompatible(original, next), true);
  for (const changed of [
    { ...next, sourceVersion: "1.0.24" },
    { ...next, handsRelease: { ...next.handsRelease!, releaseId: "other-release" } },
    { ...next, handsRelease: { ...next.handsRelease!, sha256: "b".repeat(64) } },
    { ...next, handsRelease: undefined },
  ]) assert.equal(isQueuedComputerUpgradePolicyCompatible(original, changed), false);
  assert.equal(isQueuedComputerUpgradePolicyCompatible({ ...original, handsRelease: undefined }, next), false);
});

test("platform normalization understands existing daemon OS strings", () => {
  assert.deepEqual(normalizeComputerPlatform("Darwin arm64"), { os: "macos", architecture: "arm64" });
  assert.deepEqual(normalizeComputerPlatform("linux x86_64"), { os: "linux", architecture: "x64" });
  assert.equal(normalizeComputerPlatform("linux"), null);
});
