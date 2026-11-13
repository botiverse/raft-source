import assert from "node:assert/strict";

import {
  createRuntimeAccountUsageRoutingBackend,
  RuntimeAccountUsageCacheService,
  type RuntimeAccountUsageCacheBackend,
} from "./runtimeAccountUsageCacheService";

function makeBackend(): RuntimeAccountUsageCacheBackend & { values: Map<string, string> } {
  const values = new Map<string, string>();
  return {
    values,
    async get(key) { return values.get(key) ?? null; },
    async set(key, value) { values.set(key, value); },
    async setIfAbsent(key, value) {
      if (values.has(key)) return false;
      values.set(key, value);
      return true;
    },
  };
}

function snapshot(overrides: Record<string, unknown> = {}) {
  return {
    protocolVersion: 2,
    provider: "codex",
    collectedAt: "2026-08-02T02:00:00.000Z",
    staleAfter: "2026-08-02T02:30:00.000Z",
    collectorVersion: "0.1.0",
    sourceVersion: "0.54.0",
    accounts: [{
      accountKey: "b".repeat(64),
      planLabel: "Pro",
      health: "ok",
      windows: [{
        id: "primary",
        label: "7 days",
        status: "ok",
        usedRatio: 0.4,
        resetsAt: "2026-08-08T02:00:00.000Z",
      }],
    }],
    ...overrides,
  };
}

test("writes only validated sanitized snapshots and classifies freshness", async () => {
  const backend = makeBackend();
  const service = new RuntimeAccountUsageCacheService(backend, () => Date.parse("2026-08-02T02:20:00.000Z"));
  assert.ok(await service.write("machine-1", snapshot()));
  assert.deepEqual((await service.read("machine-1", "codex")).state, "fresh");

  const staleService = new RuntimeAccountUsageCacheService(backend, () => Date.parse("2026-08-02T02:31:00.000Z"));
  assert.deepEqual((await staleService.read("machine-1", "codex")).state, "stale");
});

test("stores and serves each window's scope as the Computer sent it", async () => {
  const backend = makeBackend();
  const service = new RuntimeAccountUsageCacheService(backend, () => Date.parse("2026-08-02T02:20:00.000Z"));
  const windows = [
    { id: "w0_aaaaaaaaaaaa", label: "Current week (all models)", status: "ok", usedRatio: 0.6, scope: { kind: "account" } },
    { id: "w1_bbbbbbbbbbbb", label: "Current week (Opus)", status: "limit_reached", usedRatio: 1, scope: { kind: "model", name: "Opus" } },
    { id: "w2_cccccccccccc", label: "Current week (OAuth apps)", status: "ok", usedRatio: 0.1 },
  ];
  const sent = snapshot({ provider: "claude", accounts: [{ accountKey: "b".repeat(64), health: "ok", windows }] });
  assert.ok(await service.write("machine-1", sent));
  const read = await service.read("machine-1", "claude");
  assert.deepEqual(read.snapshot?.accounts[0]?.windows, windows);
});

test("stores and serves a models scope (Antigravity's model groups) as the Computer sent it", async () => {
  const backend = makeBackend();
  const service = new RuntimeAccountUsageCacheService(backend, () => Date.parse("2026-08-02T02:20:00.000Z"));
  const windows = [
    { id: "w0_aaaaaaaaaaaa", label: "Gemini Models · Weekly", status: "limit_reached", usedRatio: 1, scope: { kind: "models", name: "Gemini Models" } },
    { id: "w1_bbbbbbbbbbbb", label: "Claude and GPT models · 5h", status: "ok", usedRatio: 0.2, scope: { kind: "models", name: "Claude and GPT models" } },
  ];
  const sent = snapshot({ provider: "antigravity", accounts: [{ accountKey: "b".repeat(64), health: "ok", windows }] });
  assert.ok(await service.write("machine-1", sent));
  assert.deepEqual((await service.read("machine-1", "antigravity")).snapshot?.accounts[0]?.windows, windows);
});

test("rejects extra/raw fields instead of caching them", async () => {
  const backend = makeBackend();
  const service = new RuntimeAccountUsageCacheService(backend);
  assert.equal(await service.write("machine-1", snapshot({ rawResponse: { access_token: "secret" } })), null);
  assert.equal(backend.values.size, 0);
});

test("treats malformed cache data and unknown providers as missing", async () => {
  const backend = makeBackend();
  backend.values.set("slock:runtime-account-usage:v2:machine-1:codex", "not-json");
  const service = new RuntimeAccountUsageCacheService(backend);
  assert.deepEqual(await service.read("machine-1", "codex"), { state: "missing", snapshot: null });
  assert.deepEqual(await service.read("machine-1", "other"), { state: "missing", snapshot: null });
});

test("dedupes refresh requests with one cooldown key per machine and provider", async () => {
  const backend = makeBackend();
  const service = new RuntimeAccountUsageCacheService(backend);
  assert.equal(await service.tryAcquireRefresh("machine-1", "claude"), true);
  assert.equal(await service.tryAcquireRefresh("machine-1", "claude"), false);
  assert.equal(await service.tryAcquireRefresh("machine-1", "kimi"), true);
  assert.equal(await service.tryAcquireRefresh("machine-1", "unknown"), false);
});

test("routes each cache and lease operation after shared storage becomes available", async () => {
  const local = makeBackend();
  const shared = makeBackend();
  let sharedAvailable = false;
  const service = new RuntimeAccountUsageCacheService(createRuntimeAccountUsageRoutingBackend({
    isSharedAvailable: () => sharedAvailable,
    local,
    shared,
  }));

  assert.ok(await service.write("machine-local", snapshot()));
  assert.equal(await service.tryAcquireRefresh("machine-local", "codex"), true);
  assert.equal(local.values.size, 2);
  assert.equal(shared.values.size, 0);

  sharedAvailable = true;
  assert.ok(await service.write("machine-shared", snapshot()));
  assert.equal(await service.tryAcquireRefresh("machine-shared", "codex"), true);
  assert.equal((await service.read("machine-shared", "codex")).state, "stale");
  assert.equal(shared.values.size, 2);
  assert.equal(local.values.size, 2);
});

// OAR owns a whole reading. Cache writes must not revive windows or identity
// from a previous read, including successful reads that omit account metadata.
for (const provider of ["claude", "codex", "kimi", "grok"] as const) {
  for (const health of ["ok", "error", "reauth_required", "unsupported"] as const) {
    test(`${provider} ${health} replaces the whole previous OAR reading`, async () => {
      const service = new RuntimeAccountUsageCacheService(makeBackend(), () => Date.parse("2026-08-02T02:20:00.000Z"));
      assert.ok(await service.write("machine-1", snapshot({
        provider,
        accounts: [{
          accountKey: "b".repeat(64),
          maskedLabel: "old****user@example.com",
          planLabel: "Pro",
          health: "ok",
          windows: [{ id: "weekly", label: "Weekly", status: "ok", usedRatio: 0.9 }],
        }],
      })));
      const incoming = snapshot({
        provider,
        collectedAt: "2026-08-02T02:05:00.000Z",
        staleAfter: "2026-08-02T02:15:00.000Z",
        accounts: [{
          accountKey: "b".repeat(64),
          health,
          windows: health === "ok" ? [{ id: "session", label: "Session", status: "ok", usedRatio: 0.17 }] : [],
        }],
      });
      const written = await service.write("machine-1", incoming);
      assert.deepEqual(written, incoming);
      const read = await service.read("machine-1", provider);
      assert.equal(read.state, "stale");
      assert.deepEqual(read.snapshot, incoming);
    });
  }
}

test("legacy event snapshots cannot replace an OAR reading", async () => {
  const service = new RuntimeAccountUsageCacheService(makeBackend());
  const current = snapshot({ provider: "claude" });
  assert.ok(await service.write("machine-1", current));
  assert.equal(await service.write("machine-1", { ...current, protocolVersion: 1, acquisition: "structured_event" }), null);
  assert.deepEqual((await service.read("machine-1", "claude")).snapshot, current);
});
