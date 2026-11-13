// #triage:#253: Kimi Code's usage on the bundled SDK when OAR finds no Kimi Code CLI.
import assert from "node:assert/strict";
import { kimiRuntime } from "@botiverse/oar";

import { runtimeAccountUsageSnapshotSchema } from "@botiverse/raft-shared";
import { createRuntimeAccountUsageCollector } from "./collector";
import { projectKimiManagedQuota, readKimiSdkUsage, type KimiManagedQuota } from "./kimiSdkUsage";

const quota = (over: Partial<KimiManagedQuota> = {}): KimiManagedQuota => ({
  usages: {
    limit5h: { usedRatio: 0.48, resetAt: "2026-11-09T14:00:00Z" },
    limit7d: { usedRatio: 0.4, resetAt: "2026-11-15T00:00:00.000Z" },
  },
  extraUsage: null,
  ...over,
});

test("the SDK's quota reads as OAR's Kimi reader reports it: same labels, ratios and resets", () => {
  assert.deepEqual(projectKimiManagedQuota(quota()), {
    kind: "available",
    rateLimited: false,
    windows: [
      { label: "5h limit", usedRatio: 0.48, resetsAt: "2026-11-09T14:00:00.000Z" },
      { label: "Weekly limit", usedRatio: 0.4, resetsAt: "2026-11-15T00:00:00.000Z" },
    ],
  });
});

test("a full window is rate limited unless Extra Usage has headroom; its monthly cap is a window", () => {
  const full = quota({ usages: { limit7d: { usedRatio: 1 } } });
  const fullOnly = projectKimiManagedQuota(full);
  assert.equal(fullOnly.kind === "available" && fullOnly.rateLimited, true);

  const extra = { balanceCents: 500, totalCents: 1000, monthlyChargeLimitEnabled: true, monthlyChargeLimitCents: 2000, monthlyUsedCents: 500, currency: "CNY" };
  const withHeadroom = projectKimiManagedQuota({ ...full, extraUsage: extra });
  assert.equal(withHeadroom.kind, "available");
  if (withHeadroom.kind !== "available") return;
  assert.equal(withHeadroom.rateLimited, false);
  assert.deepEqual(withHeadroom.windows.at(-1), { label: "Extra Usage monthly limit", usedRatio: 0.25 });

  const capped = projectKimiManagedQuota({ ...full, extraUsage: { ...extra, monthlyUsedCents: 2000 } });
  assert.equal(capped.kind === "available" && capped.rateLimited, true);
});

test("a bad reset is dropped, ratios are clamped, and a quota with no usable window throws (never zero usage)", () => {
  const odd = projectKimiManagedQuota(quota({ usages: { limit5h: { usedRatio: 1.7, resetAt: "not a date" } } }));
  assert.deepEqual(odd.kind === "available" ? odd.windows : null, [{ label: "5h limit", usedRatio: 1 }]);
  assert.throws(() => projectKimiManagedQuota(quota({ usages: {} })));
});

test("signed out: reauth without loading the SDK; 401/403 rejected; 404 unsupported; other errors throw", async () => {
  let loads = 0;
  const usage = (result: Awaited<ReturnType<Parameters<typeof readKimiSdkUsage>[0]["getManagedUsage"]>>) => async () => { loads += 1; return result; };
  assert.deepEqual(
    await readKimiSdkUsage({ status: async () => ({ kind: "logged_out" }), getManagedUsage: usage({ kind: "ok", quota: quota() }) }),
    { kind: "reauth_required", reason: "credentials_missing" },
  );
  assert.equal(loads, 0, "no SDK load when nothing is signed in");
  const signedIn = async () => ({ kind: "logged_in" as const });
  for (const status of [401, 403]) {
    assert.deepEqual(await readKimiSdkUsage({ status: signedIn, getManagedUsage: usage({ kind: "error", status, message: "no" }) }), { kind: "reauth_required", reason: "credentials_rejected" });
  }
  assert.deepEqual(await readKimiSdkUsage({ status: signedIn, getManagedUsage: usage({ kind: "error", status: 404, message: "no" }) }), { kind: "unsupported", reason: "endpoint_unavailable" });
  await assert.rejects(readKimiSdkUsage({ status: signedIn, getManagedUsage: usage({ kind: "error", status: 500, message: "down" }) }));
});

const base = { localAccountSlot: "/fixture/home", collectorVersion: "test", now: () => Date.parse("2026-11-09T09:00:00.000Z") } as const;

test("collector: without the Kimi Code CLI the SDK reads the usage; with it, OAR does and the SDK is never asked", async () => {
  let sdkReads = 0;
  const kimiSdkUsage = async () => { sdkReads += 1; return projectKimiManagedQuota(quota()); };
  const probe = vi.spyOn(kimiRuntime, "installation").mockResolvedValue({ kind: "not_found" });
  const reader = vi.spyOn(kimiRuntime, "accountUsage");
  try {
    const collect = createRuntimeAccountUsageCollector({ ...base, oar: { kimiSdkUsage } });
    const result = await collect("kimi");
    assert.equal(runtimeAccountUsageSnapshotSchema.safeParse(result).success, true);
    assert.equal(result.accounts[0]?.health, "ok");
    assert.deepEqual(result.accounts[0]?.windows.map((w) => [w.label, w.usedRatio]), [["5h limit", 0.48], ["Weekly limit", 0.4]]);
    assert.equal(sdkReads, 1);
    assert.equal(reader.mock.calls.length, 0);

    probe.mockResolvedValue({ kind: "available", via: "executable", command: "/fixture/kimi" });
    reader.mockResolvedValue({ kind: "available", rateLimited: false, windows: [{ label: "Weekly limit", usedRatio: 0.1 }] });
    const viaCli = await collect("kimi");
    assert.deepEqual(viaCli.accounts[0]?.windows.map((w) => w.usedRatio), [0.1]);
    assert.equal(sdkReads, 1, "the CLI path never asks the SDK");
  } finally {
    vi.restoreAllMocks();
  }
});

test("collector: an SDK read that throws or hangs is an error account, never zero usage", async () => {
  vi.spyOn(kimiRuntime, "installation").mockResolvedValue({ kind: "not_found" });
  try {
    const throwing = createRuntimeAccountUsageCollector({ ...base, oar: { kimiSdkUsage: async () => { throw new Error("boom"); } } });
    assert.equal((await throwing("kimi")).accounts[0]?.health, "error");
    const hanging = createRuntimeAccountUsageCollector({ ...base, oar: { timeoutMs: 10, kimiSdkUsage: () => new Promise(() => {}) } });
    const result = await hanging("kimi");
    assert.equal(result.accounts[0]?.health, "error");
    assert.deepEqual(result.accounts[0]?.windows, []);
  } finally {
    vi.restoreAllMocks();
  }
});

test("collector: other providers never use the Kimi SDK reader", async () => {
  let sdkReads = 0;
  const collect = createRuntimeAccountUsageCollector({ ...base, oar: { kimiSdkUsage: async () => { sdkReads += 1; return projectKimiManagedQuota(quota()); }, runtime: { id: "codex" } as never } });
  await collect("codex");
  assert.equal(sdkReads, 0);
});
