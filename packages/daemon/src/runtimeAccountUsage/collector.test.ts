import assert from "node:assert/strict";
import { test, vi } from "vitest";
import { claudeRuntime, codexRuntime, kimiRuntime, grokRuntime } from "@botiverse/oar";
import { runtimeAccountUsageSnapshotSchema } from "@botiverse/raft-shared";
import { createRuntimeAccountUsageCollector } from "./collector.js";

import type { AvailableInstallation, InstallationSnapshot, Runtime } from "@botiverse/oar";

import { readOarAccountUsage } from "./collector.js";

const BASE = {
  provider: "codex",
  localAccountSlot: "/home/agent/.slock",
  collectorVersion: "test",
  observedAtMs: Date.parse("2026-08-26T09:00:00.000Z"),
} as const;

/**
 * Builds a runtime that records how its probe and reader were used, so the
 * composition itself can be asserted rather than assumed.
 */
function recordingRuntime(installation: InstallationSnapshot) {
  const seen: { probeCalls: number; readerGot: unknown[] } = { probeCalls: 0, readerGot: [] };
  const runtime = {
    id: "recording",
    session: (() => {
      throw new Error("session must not be started by an account-usage read");
    }) as unknown as Runtime["session"],
    installation: async () => {
      seen.probeCalls += 1;
      return installation;
    },
    accountUsage: async (given: AvailableInstallation) => {
      seen.readerGot.push(given);
      return { kind: "unsupported" } as const;
    },
  } satisfies Runtime;
  return { runtime, seen };
}

test("installation is probed exactly once per read", async () => {
  const available: InstallationSnapshot = { kind: "available", via: "bundled" };
  const { runtime, seen } = recordingRuntime(available);

  await readOarAccountUsage({ ...BASE, deps: { runtime } });

  assert.equal(seen.probeCalls, 1, "OAR's installation() must be the sole probe, called once");
});

test("the exact object from installation() is handed to accountUsage()", async () => {
  // A distinguishable instance: identity, not structural equality, is the point.
  const available: InstallationSnapshot = {
    kind: "available",
    via: "executable",
    command: "/usr/local/bin/codex",
    version: "1.2.3",
  };
  const { runtime, seen } = recordingRuntime(available);

  await readOarAccountUsage({ ...BASE, deps: { runtime } });

  assert.equal(seen.readerGot.length, 1, "accountUsage must be called once");
  assert.equal(
    seen.readerGot[0],
    available,
    "accountUsage must receive the SAME object installation() returned, not a copy or a re-probe",
  );
});

test("an unavailable installation short-circuits without calling accountUsage", async () => {
  for (const snapshot of [
    { kind: "not_found" } as const,
    { kind: "unsupported", reason: "no parity" } as const,
  ]) {
    const { runtime, seen } = recordingRuntime(snapshot);
    const result = await readOarAccountUsage({ ...BASE, deps: { runtime } });

    assert.equal(seen.probeCalls, 1);
    assert.equal(seen.readerGot.length, 0, "a non-available installation must not be read from");
    assert.equal(result.accounts[0]?.health, "unsupported");
    assert.deepEqual(result.accounts[0]?.windows, [], "no window may be invented for an unavailable runtime");
  }
});

test("a runtime without a probe or reader is unsupported, not an error", async () => {
  const bare = {
    id: "bare",
    session: (() => {
      throw new Error("unused");
    }) as unknown as Runtime["session"],
  } satisfies Runtime;

  const result = await readOarAccountUsage({ ...BASE, deps: { runtime: bare } });
  assert.equal(result.accounts[0]?.health, "unsupported");
  assert.deepEqual(result.accounts[0]?.windows, []);
});

test("a thrown read becomes an explicit error account, never a zero reading", async () => {
  const throwing = {
    id: "throwing",
    session: (() => {
      throw new Error("unused");
    }) as unknown as Runtime["session"],
    installation: async (): Promise<InstallationSnapshot> => ({ kind: "available", via: "bundled" }),
    accountUsage: async () => {
      throw new Error("app-server unreachable");
    },
  } satisfies Runtime;

  const result = await readOarAccountUsage({ ...BASE, deps: { runtime: throwing } });
  assert.equal(result.accounts[0]?.health, "error");
  assert.deepEqual(result.accounts[0]?.windows, []);
  assert.ok(!JSON.stringify(result).includes("usedRatio"));
});


test("every usage provider routes to its OAR runtime and publishes the complete current format", async () => {
  const cases = [
    { provider: "claude", runtime: claudeRuntime, usedRatio: 0.17 },
    { provider: "codex", runtime: codexRuntime, usedRatio: 0.72 },
    { provider: "kimi", runtime: kimiRuntime, usedRatio: 0.4 },
    { provider: "grok", runtime: grokRuntime, usedRatio: 0.35 },
  ] as const;
  try {
    for (const { runtime, usedRatio } of cases) {
      vi.spyOn(runtime, "installation").mockResolvedValue({ kind: "available", via: "executable", command: "/fixture/runtime" });
      vi.spyOn(runtime, "accountUsage").mockResolvedValue({
        kind: "available",
        email: "alpha@example.com",
        plan: "Pro",
        rateLimited: false,
        windows: [{ label: "Current session", usedRatio }],
      });
    }
    const collect = createRuntimeAccountUsageCollector({ ...BASE, now: () => BASE.observedAtMs });
    for (const { provider, usedRatio } of cases) {
      const result = await collect(provider);
      assert.equal(runtimeAccountUsageSnapshotSchema.safeParse(result).success, true);
      assert.equal(result.provider, provider);


      assert.equal(result.accounts[0]?.planLabel, "Pro");
      assert.equal(result.accounts[0]?.maskedLabel, "a****@example.com");
      assert.equal(result.accounts[0]?.windows[0]?.usedRatio, usedRatio);
      assert.equal(result.accounts[0]?.windows[0]?.status, "ok");
      assert.equal(result.accounts[0]?.windows[0]?.resetsAt, undefined);
    }
  } finally {
    vi.restoreAllMocks();
  }
});
