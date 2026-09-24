import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { test, vi } from "vitest";
import { kimiRuntime, utcInstantFromDate, type AccountUsageSnapshot } from "@botiverse/oar";

import { runtimeAccountUsageSnapshotSchema } from "@botiverse/raft-shared";
import { createRuntimeAccountUsageCollector } from "./collector.js";
import { projectOarAccountUsageSnapshot } from "./oarAdapter.js";

const base = {
  provider: "kimi",
  localAccountSlot: "/fixture/kimi-home",
  collectorVersion: "test",
  observedAtMs: Date.parse("2026-08-01T20:00:00.000Z"),
} as const;

function project(snapshot: AccountUsageSnapshot) {
  const result = projectOarAccountUsageSnapshot({ ...base, snapshot });
  assert.equal(runtimeAccountUsageSnapshotSchema.safeParse(result).success, true);
  return result.accounts[0]!;
}

// The SDK-specific tests now protect the same usage/privacy/failure boundaries
// through OAR's published format, which owns Kimi's provider payload parsing.
test("Kimi OAR windows preserve percentages, resets and masked account identity", () => {
  const resetsAt = utcInstantFromDate(new Date("2026-08-08T20:00:00.000Z"));
  assert.ok(resetsAt);
  const account = project({
    kind: "available",
    email: "alpha@example.com",
    plan: "Moderato",
    rateLimited: false,
    windows: [
      { label: "Weekly limit", usedRatio: 0.4, resetsAt },
      { label: "5h limit", usedRatio: 0.48, resetsAt },
    ],
  });
  assert.equal(account.maskedLabel, "a****@example.com");
  assert.equal(account.planLabel, "Moderato");
  assert.deepEqual(account.windows.map((window) => [window.label, window.usedRatio, window.resetsAt]), [
    ["Weekly limit", 0.4, resetsAt],
    ["5h limit", 0.48, resetsAt],
  ]);
  assert.ok(!JSON.stringify(account).includes("alpha@example.com"));
});

test("Kimi extra usage headroom keeps OAR account health even when a subscription window is full", () => {
  const account = project({
    kind: "available",
    rateLimited: false,
    windows: [
      { label: "Weekly limit", usedRatio: 1 },
      { label: "Extra Usage monthly limit", usedRatio: 0.25 },
    ],
  });
  assert.equal(account.health, "ok");
  assert.equal(account.windows[0]?.status, "limit_reached");
  assert.equal(account.windows[1]?.usedRatio, 0.25);
  assert.equal(account.windows[1]?.status, "ok");
  assert.equal(account.windows[1]?.resetsAt, undefined);
});

test("Kimi uses the same provider-slot identity for successful and failed readings", () => {
  for (const kind of ["available", "reauth_required", "unsupported"] as const) {
    const account = project(kind === "available"
      ? { kind, rateLimited: true, windows: [{ label: "Weekly limit", usedRatio: 1 }] }
      : { kind });
    assert.equal(account.accountKey, createHash("sha256").update(`kimi\0${base.localAccountSlot}`).digest("hex"));
    assert.equal(account.health, kind === "available" ? "rate_limited" : kind);
    if (kind !== "available") assert.deepEqual(account.windows, []);
  }
});

test("Kimi percentage without a reset is usable under the OAR contract", () => {
  const account = project({ kind: "available", rateLimited: false, windows: [{ label: "Weekly limit", usedRatio: 0.25 }] });
  assert.equal(account.windows[0]?.status, "ok");
  assert.equal(account.windows[0]?.usedRatio, 0.25);
  assert.equal(account.windows[0]?.resetsAt, undefined);
  assert.equal(account.parseErrorCode, undefined);
});

test("the Kimi collector uses the real OAR runtime boundary and classifies typed failures", async () => {
  const installation = { kind: "available", via: "executable", command: "/fixture/kimi" } as const;
  const probe = vi.spyOn(kimiRuntime, "installation").mockResolvedValue(installation);
  const reader = vi.spyOn(kimiRuntime, "accountUsage");
  try {
    const collect = createRuntimeAccountUsageCollector({ ...base, now: () => base.observedAtMs });
    for (const kind of ["available", "reauth_required", "unsupported"] as const) {
      reader.mockResolvedValue(kind === "available"
        ? { kind, rateLimited: false, windows: [{ label: "Weekly limit", usedRatio: 0.4 }] }
        : { kind });
      const result = await collect("kimi");

      assert.equal(result.accounts[0]?.health, kind === "available" ? "ok" : kind);
      assert.deepEqual(result.accounts[0]?.windows.map((window) => window.usedRatio), kind === "available" ? [0.4] : []);
    }
    assert.equal(probe.mock.calls.length, 3);
    assert.equal(reader.mock.calls[0]?.[0], installation);
  } finally {
    vi.restoreAllMocks();
  }
});

test("Kimi without an OAR installation has no invented usage and never reads credentials", async () => {
  vi.spyOn(kimiRuntime, "installation").mockResolvedValue({ kind: "not_found" });
  const reader = vi.spyOn(kimiRuntime, "accountUsage");
  try {
    const collect = createRuntimeAccountUsageCollector({ ...base, now: () => base.observedAtMs });
    const result = await collect("kimi");
    assert.equal(result.accounts[0]?.health, "unsupported");
    assert.deepEqual(result.accounts[0]?.windows, []);
    assert.equal(reader.mock.calls.length, 0);
  } finally {
    vi.restoreAllMocks();
  }
});

test("unrelated Kimi OAR failures remain errors instead of sending users through login", async () => {
  vi.spyOn(kimiRuntime, "installation").mockResolvedValue({ kind: "available", via: "executable", command: "/fixture/kimi" });
  vi.spyOn(kimiRuntime, "accountUsage").mockRejectedValue(new Error("secret-provider-message"));
  try {
    const collect = createRuntimeAccountUsageCollector({ ...base, now: () => base.observedAtMs });
    const result = await collect("kimi");
    assert.equal(result.accounts[0]?.health, "error");
    assert.deepEqual(result.accounts[0]?.windows, []);
    assert.ok(!JSON.stringify(result).includes("secret-provider-message"));
  } finally {
    vi.restoreAllMocks();
  }
});
