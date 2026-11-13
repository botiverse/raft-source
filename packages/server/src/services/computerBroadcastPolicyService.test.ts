import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { dbTest } from "../test/integration/dbTest";
import { featureFlagRules, featureFlags } from "../db/schema";
import { REMOTE_COMPUTER_UPGRADE_PLATFORM_HOLD_FEATURE_FLAG_KEYS } from "@botiverse/raft-shared";
import {
  COMPUTER_HANDS_MAIN_URL,
  createBatchBroadcastPolicyEvaluator,
  evaluateBroadcastPolicy,
  isQueuedComputerUpgradePolicyCompatible,
  normalizeComputerPlatform,
  type ComputerHandsResolutionDependencies,
  type EvaluateComputerBroadcastPolicyInput,
} from "./computerBroadcastPolicyService";
import { setPrivacyModeForTest } from "../config/privacyMode";

// Hands resolution with no platform held, so these stay tests of resolution and
// nothing else; the holds are tested at the bottom of this file.
function evaluateUnheld(
  input: EvaluateComputerBroadcastPolicyInput,
  deps: ComputerHandsResolutionDependencies,
) {
  return evaluateBroadcastPolicy(input, { isPlatformHeld: () => false, ...deps });
}

function release() {
  return {
    app: { slug: "raft-computer-cli", platform: "node" }, channel: "main",
    build: { id: "build-31", version: "1.0.31" },
    scoped: { release_id: "release-31" },
    assets: [{ platform: "darwin", arch: "arm64", variant: null, filetype: "binary",
      sha256: "a".repeat(64), size_bytes: 100, download_url: "https://hands.build/artifact" }],
  };
}
function input(overrides: Partial<EvaluateComputerBroadcastPolicyInput> = {}): EvaluateComputerBroadcastPolicyInput {
  return { source: { version: "1.0.23", observedAt: "2026-01-01T00:00:00Z", provenance: "owner_connection" },
    platform: { os: "macos", architecture: "arm64" }, now: new Date("2026-09-10T00:00:00Z"), serverId: "server-test", ...overrides };
}
function respond(body = release()): typeof fetch {
  return async (url) => {
    assert.equal(url, COMPUTER_HANDS_MAIN_URL);
    assert.equal(new URL(String(url)).searchParams.get("channel"), "main");
    return Response.json(body);
  };
}

test("legacy source with no Server matrix row resolves the current Hands stable (main) release", async () => {
  const result = await evaluateUnheld(input(), { fetchFn: respond() });
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
    assert.equal((await evaluateUnheld(input({ platform: { os, architecture } }),
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
    const result = await evaluateUnheld(input(), { fetchFn: respond(body) });
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
    // task #805: an alpha response must never be projected as the stable target.
    (body: ReturnType<typeof release>) => { body.channel = "alpha"; },
    (body: ReturnType<typeof release>) => { body.app.slug = "other"; },
  ]) {
    const body = release(); change(body);
    assert.equal((await evaluateUnheld(input(), { fetchFn: respond(body) })).reasonCode, "hands_response_invalid");
  }
});

test("Hands HTTP/network/JSON failures never fall back to a compiled target or CDN", async () => {
  for (const fetchFn of [
    async () => new Response("unavailable", { status: 503 }),
    async () => { throw new Error("network unavailable"); },
    async () => new Response("not JSON"),
  ] satisfies Array<typeof fetch>) {
    const result = await evaluateUnheld(input(), { fetchFn });
    assert.equal(result.eligibility, "no_broadcast"); assert.equal(result.targetVersion, null);
  }
});

test("deadline aborts the actual pending request", async () => {
  let aborted = false;
  const fetchFn: typeof fetch = async (_url, init) => new Promise((_resolve, reject) => {
    init?.signal?.addEventListener("abort", () => { aborted = true; reject(new Error("aborted")); }, { once: true });
  });
  const result = await evaluateUnheld(input(), { fetchFn, timeoutMs: 10 });
  assert.equal(aborted, true); assert.equal(result.reasonCode, "hands_unavailable");
});

test("current or newer Computer is not downgraded, including prerelease precedence", async () => {
  for (const [source, target, eligible] of [
    ["1.0.31", "1.0.31", false], ["1.0.32", "1.0.31", false],
    ["1.0.31-rc.2", "1.0.31", true], ["1.0.31", "1.0.31-rc.2", false],
    ["1.0.31-rc.9", "1.0.31-rc.10", true], ["1.0.31+build1", "1.0.31+build2", false],
  ] as const) {
    const body = release(); body.build.version = target;
    const result = await evaluateUnheld(input({ source: { version: source, observedAt: null, provenance: null } }), { fetchFn: respond(body) });
    assert.equal(result.eligibility === "eligible", eligible, `${source} -> ${target}`);
  }
});

test("requested target cannot override the active Hands stable release", async () => {
  assert.equal((await evaluateUnheld(input({ requestedTargetVersion: "1.0.28" }), { fetchFn: respond() })).reasonCode, "requested_target_mismatch");
});

test("unknown source/platform is rejected before fetching", async () => {
  for (const value of [input({ source: null }), input({ source: { version: "invalid", observedAt: null, provenance: null } }), input({ platform: null })]) {
    const result = await evaluateUnheld(value, { fetchFn: async () => { assert.fail("must not fetch"); } });
    assert.equal(result.eligibility, "no_broadcast");
  }
});

test("RAFT_PRIVACY_MODE: Hands is never contacted and the decision is hands_unavailable", async () => {
  setPrivacyModeForTest(true);
  try {
    const result = await evaluateUnheld(input(), { fetchFn: async () => { assert.fail("must not fetch"); } });
    assert.equal(result.eligibility, "no_broadcast");
    assert.equal(result.reasonCode, "hands_unavailable");
  } finally {
    setPrivacyModeForTest(false);
  }
  assert.equal((await evaluateUnheld(input(), { fetchFn: respond() })).eligibility, "eligible", "off: unchanged");
});

test("queued dispatch preserves exact release identity, rejects old matrix receipts and changed assets", async () => {
  const original = await evaluateUnheld(input(), { fetchFn: respond() });
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

// Per-platform hold (10-24, #proj-o11y:ae66286a): the emergency stop for one OS.
test("a held platform blocks its Computers without contacting Hands; other platforms still resolve", async () => {
  const seen: string[] = [];
  const isPlatformHeld = (_serverId: string | null, os: string) => { seen.push(os); return os === "windows"; };
  const held = await evaluateBroadcastPolicy(input({ platform: { os: "windows", architecture: "x64" } }), {
    isPlatformHeld,
    fetchFn: async () => { assert.fail("a held platform must not reach Hands"); },
  });
  assert.equal(held.eligibility, "no_broadcast");
  assert.equal(held.reasonCode, "platform_held");
  assert.equal(held.targetVersion, null);

  const other = await evaluateBroadcastPolicy(input(), { isPlatformHeld, fetchFn: respond() });
  assert.equal(other.eligibility, "eligible");
  assert.deepEqual(seen, ["windows", "macos"]);
});

// A Computer whose runner cannot reach its own service (Windows pipe failures,
// 10-27: 27 on 7 machines) gets the manual commands, not a doomed Upgrade.
test("a Computer that cannot reach its service is not offered a web upgrade, without contacting Hands", async () => {
  const unreachable = await evaluateBroadcastPolicy(input({ serviceUnreachable: true }), {
    isPlatformHeld: () => false,
    fetchFn: async () => { assert.fail("an unreachable service must not reach Hands"); },
  });
  assert.equal(unreachable.eligibility, "no_broadcast");
  assert.equal(unreachable.reasonCode, "service_unreachable");
  const reachable = await evaluateBroadcastPolicy(input({ serviceUnreachable: false }), {
    isPlatformHeld: () => false, fetchFn: respond(),
  });
  assert.equal(reachable.eligibility, "eligible");
});

// Raft Desktop's bundled Computer (ready.installKind "electron") is updated by
// Desktop; the standalone installer a web upgrade drives cannot replace it
// (10-30: two failed web upgrades of a Desktop Computer, 1.0.57 -> 1.0.59).
test("a Computer bundled in Raft Desktop is not offered a web upgrade, without contacting Hands", async () => {
  const desktop = await evaluateBroadcastPolicy(input({ installKind: "electron" }), {
    isPlatformHeld: () => false,
    fetchFn: async () => { assert.fail("a Desktop-managed Computer must not reach Hands"); },
  });
  assert.equal(desktop.eligibility, "no_broadcast");
  assert.equal(desktop.reasonCode, "managed_by_desktop");
  assert.equal(desktop.targetVersion, null);
  // The batch evaluator (machine list) decides the same way.
  const batch = await createBatchBroadcastPolicyEvaluator({
    isPlatformHeld: () => false,
    fetchFn: async () => { assert.fail("a Desktop-managed Computer must not reach Hands"); },
  })(input({ installKind: "electron" }));
  assert.equal(batch.reasonCode, "managed_by_desktop");
  // Standalone installs and older daemons that report no install kind: unchanged.
  for (const installKind of ["sea", "node", null, undefined] as const) {
    const result = await evaluateBroadcastPolicy(input({ installKind }), {
      isPlatformHeld: () => false, fetchFn: respond(),
    });
    assert.equal(result.eligibility, "eligible", String(installKind));
    assert.equal(result.targetVersion, "1.0.31");
  }
  // Decided before the hold: a held platform's Desktop Computer is still
  // Desktop's, not "run the install commands"; the hold is not even read.
  const held = await evaluateBroadcastPolicy(input({ installKind: "electron" }), {
    isPlatformHeld: () => { assert.fail("a Desktop-managed Computer is decided before the hold"); },
    fetchFn: async () => { assert.fail("must not fetch"); },
  });
  assert.equal(held.reasonCode, "managed_by_desktop");
});

test("an unreadable hold fails closed", async () => {
  const unreadable = await evaluateBroadcastPolicy(input(), {
    isPlatformHeld: () => { throw new Error("flag store unreachable"); },
    fetchFn: async () => { assert.fail("an unreadable hold must not reach Hands"); },
  });
  assert.equal(unreadable.reasonCode, "broadcast_gate_unavailable");
});

test("the batch evaluator reads each server's hold once per platform", async () => {
  const serverId = "95f993fa-2a68-4797-b8ae-7beb7d984ada";
  const seen: string[] = [];
  const evaluate = createBatchBroadcastPolicyEvaluator({
    isPlatformHeld: async (id, os) => { seen.push(`${id}:${os}`); return os === "windows"; },
    fetchFn: respond(),
  });
  const windows = { os: "windows", architecture: "x64" } as const;
  const results = await Promise.all([
    evaluate(input({ serverId })), evaluate(input({ serverId })),
    evaluate(input({ serverId, platform: windows })), evaluate(input({ serverId, platform: windows })),
  ]);
  assert.deepEqual(seen, [`${serverId}:macos`, `${serverId}:windows`]);
  assert.deepEqual(results.map((r) => r.reasonCode), ["eligible", "eligible", "platform_held", "platform_held"]);
});

// The holds' real flag evaluation against a flag store, with no other upgrade
// flag present: an unheld platform resolves.
dbTest("the hold reads remote_computer_upgrade_hold_<os>: missing is not held, allowed for the server holds that OS only", async ({ db }) => {
  const serverId = randomUUID();
  const windows = input({ serverId, platform: { os: "windows", architecture: "x64" } });
  const body = release();
  body.assets.push({ ...body.assets[0]!, platform: "win32", arch: "x64" });

  // No hold flag: nothing changes.
  assert.equal((await evaluateBroadcastPolicy(windows, { fetchFn: respond(body) })).reasonCode, "eligible");

  const holdKey = REMOTE_COMPUTER_UPGRADE_PLATFORM_HOLD_FEATURE_FLAG_KEYS.windows;
  await db.insert(featureFlags).values({
    key: holdKey,
    description: "test remote computer upgrade hold",
    enabled: true,
    killSwitch: false,
    randomizationUnit: "server",
    defaultEnabled: false,
    salt: "broadcast-policy-hold-test",
  });
  await db.insert(featureFlagRules).values({
    id: randomUUID(), flagKey: holdKey, stage: "server", priority: 0, decision: "allow", values: [serverId],
  });
  const held = await evaluateBroadcastPolicy(windows, {
    fetchFn: async () => { assert.fail("a held platform must not reach Hands"); },
  });
  assert.equal(held.reasonCode, "platform_held");
  assert.equal((await evaluateBroadcastPolicy(input({ serverId }), { fetchFn: respond(body) })).reasonCode, "eligible");
});
