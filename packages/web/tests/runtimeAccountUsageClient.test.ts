import assert from "node:assert/strict";

import type { RuntimeAccountUsageSnapshot } from "@botiverse/raft-shared";
import { RuntimeAccountUsageClient } from "../src/utils/runtimeAccountUsageClient";

function validSnapshot(): RuntimeAccountUsageSnapshot {
  return {
    protocolVersion: 2,
    provider: "codex",
    collectedAt: "2026-11-02T03:00:00.000Z",
    staleAfter: "2026-11-02T03:25:00.000Z",
    collectorVersion: "1.6.2",
    accounts: [{
      accountKey: "d".repeat(64),
      maskedLabel: "man****email@company.com",
      planLabel: "Pro",
      health: "ok",
      windows: [{ id: "primary", label: "7 days", status: "ok", usedRatio: 0.42, resetsAt: "2026-11-09T03:00:00.000Z" }],
    }],
  };
}

test("dedupes cache reads and keeps a 60-second client cache", async () => {
  let now = 1_000;
  let calls = 0;
  let resolveRead!: (value: any) => void;
  const client = new RuntimeAccountUsageClient(
    async () => {
      calls += 1;
      return new Promise((resolve) => { resolveRead = resolve; });
    },
    async () => ({ accepted: true, state: "requested" }),
    () => now,
  );
  const first = client.read("server", "machine", "codex");
  const duplicate = client.read("server", "machine", "codex");
  assert.equal(calls, 1);
  resolveRead({ state: "missing", snapshot: null });
  assert.equal(await first, await duplicate);
  assert.equal((await client.read("server", "machine", "codex")).state, "missing");
  assert.equal(calls, 1);
  now += 60_001;
  void client.read("server", "machine", "codex");
  assert.equal(calls, 2);
});

test("dedupes refreshes and enforces a two-minute client cooldown", async () => {
  let now = 1_000;
  let calls = 0;
  const client = new RuntimeAccountUsageClient(
    async () => ({ state: "missing", snapshot: null }),
    async () => {
      calls += 1;
      return { accepted: true, state: "requested" };
    },
    () => now,
  );
  assert.deepEqual(await client.refresh("server", "machine", "claude", "stale_or_missing"), {
    accepted: true,
    state: "requested",
  });
  assert.deepEqual(await client.refresh("server", "machine", "claude", "manual"), {
    accepted: false,
    state: "cooldown",
  });
  assert.equal(calls, 1);
  now += 120_001;
  await client.refresh("server", "machine", "claude", "manual");
  assert.equal(calls, 2);
});

test("a fresh refresh result is written into the read cache in the read-path shape", async () => {
  let now = 1_000;
  let reads = 0;
  const freshSnapshot = validSnapshot();
  const client = new RuntimeAccountUsageClient(
    async () => {
      reads += 1;
      return { state: "missing", snapshot: null };
    },
    async () => ({ accepted: true, state: "fresh" as const, snapshot: freshSnapshot }),
    () => now,
  );
  const result = await client.refresh("server", "machine", "codex", "manual");
  assert.equal(result.state, "fresh");
  assert.deepEqual(await client.read("server", "machine", "codex"), {
    state: "fresh",
    snapshot: freshSnapshot,
  });
  assert.equal(reads, 0);
});

test("a refresh whose snapshot is outside the schema is neither returned nor cached", async () => {
  // The Computers page crashed on `windows.find` when a computer reported an
  // account whose `windows` was not an array (#triage:#151).
  const snapshot = validSnapshot();
  const malformed = { ...snapshot, accounts: [{ ...snapshot.accounts[0]!, windows: { primary: snapshot.accounts[0]!.windows[0] } }] };
  const client = new RuntimeAccountUsageClient(
    async () => ({ state: "missing", snapshot: null }),
    async () => ({ accepted: true, state: "fresh" as const, snapshot: malformed as never }),
  );
  assert.deepEqual(await client.refresh("server", "machine", "codex", "manual"), {
    accepted: true,
    state: "fresh",
    snapshot: null,
  });
  assert.deepEqual(await client.read("server", "machine", "codex"), { state: "missing", snapshot: null });
});

test("a timed-out refresh result passes through unchanged", async () => {
  const client = new RuntimeAccountUsageClient(
    async () => ({ state: "missing", snapshot: null }),
    async () => ({ accepted: true, state: "timeout" as const }),
  );
  assert.deepEqual(await client.refresh("server", "machine", "claude", "manual"), {
    accepted: true,
    state: "timeout",
  });
});

test("a read's answer without a snapshot holding its accounts is `missing`, never a crash for the views that read `snapshot.accounts`", async () => {
  const answers: unknown[] = [
    undefined,
    {},
    { state: "missing" },
    { state: "fresh" },
    { state: "stale", snapshot: { accounts: "not a list" } },
    { state: "later-state", snapshot: null },
  ];
  for (const answer of answers) {
    const client = new RuntimeAccountUsageClient(async () => answer as never, async () => ({ accepted: false, state: "cooldown" }));
    assert.deepEqual(await client.read("server-1", "machine-1", "codex"), { state: "missing", snapshot: null }, JSON.stringify(answer));
  }
  const unsupported = new RuntimeAccountUsageClient(async () => ({ state: "unsupported", snapshot: null }), async () => ({ accepted: false, state: "unsupported" }));
  assert.deepEqual(await unsupported.read("server-1", "machine-1", "antigravity"), { state: "unsupported", snapshot: null });
  const fresh = new RuntimeAccountUsageClient(async () => ({ state: "fresh", snapshot: validSnapshot() }), async () => ({ accepted: false, state: "cooldown" }));
  assert.deepEqual(await fresh.read("server-1", "machine-1", "codex"), { state: "fresh", snapshot: validSnapshot() });
});
