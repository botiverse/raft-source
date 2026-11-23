import assert from "node:assert/strict";
import { COMPUTER_CHECKS_CLOCK_SKEW_MS, currentTimeMs, DAEMON_CAPABILITY_COMPUTER_CHECKS, DAEMON_CAPABILITY_PROC_STOP } from "@botiverse/raft-shared";

import { AgentOrchestrator } from "./agentOrchestrator";
import {
  ComputerChecksCacheService,
  computerChecksRefreshKey,
  computerChecksReportKey,
  scrubComputerCheckText,
  type ComputerChecksCacheBackend,
} from "./computerChecksCacheService";

// docs/contracts/computer-checks.md, the server side: a report is kept only
// from the current connection of an attached Computer, re-read and scrubbed;
// config and refresh go only to a Computer that advertises computer-checks@1,
// and only while the server's flag is on; the cache keeps one report per
// machine for 7 days and one refresh claim for 30 s.
// RED proofs: drop the boundary check and the replaced connection's report is
// written; drop the capability check and the old Computer gets a config; drop
// the flag check in ingest and the flag-off report is kept; handle reports
// concurrently and the slow older one overwrites the newer one.

type Proto = Record<string, (...args: unknown[]) => unknown>;
const proto = AgentOrchestrator.prototype as unknown as Proto;
const FAKE_TOKEN = `ghp_${"Z".repeat(36)}`;

function memoryBackend() {
  const values = new Map<string, { value: string; ttlSeconds: number }>();
  const backend: ComputerChecksCacheBackend = {
    async get(key) { return values.get(key)?.value ?? null; },
    async set(key, value, ttlSeconds) { values.set(key, { value, ttlSeconds }); },
    async setIfAbsent(key, value, ttlSeconds) {
      if (values.has(key)) return false;
      values.set(key, { value, ttlSeconds });
      return true;
    },
    async delete(key) { values.delete(key); },
  };
  return { values, backend };
}

const report = (checkedAt = "2026-11-19T10:00:00.000Z", value = "2.60.0") => ({
  schemaVersion: 1,
  checkedAt,
  plugins: [{ id: "github", items: [{ key: "gh.version", label: "GitHub CLI", value, status: "ok" }], durationMs: 3 }],
});

function ingestHarness(options: { principalKind?: string; attachedBy?: string | null; enabled?: boolean; writeDelayMs?: (value: unknown) => number } = {}) {
  const conn: Record<string, unknown> = { principalKind: options.principalKind ?? "computer", serverId: "server-1" };
  const memory = memoryBackend();
  const cache = new ComputerChecksCacheService(memory.backend);
  const events: Array<Record<string, unknown>> = [];
  const self = {
    machineConnections: new Map<string, unknown>([["machine-1", conn]]),
    loadRuntimeAccountUsageAttacher: async () => (options.attachedBy === undefined ? "user-1" : options.attachedBy),
    isRuntimeAccountUsageDataBoundaryAuthorized: proto.isRuntimeAccountUsageDataBoundaryAuthorized,
    recordEvent: (_name: string, attrs: Record<string, unknown>) => { events.push(attrs); },
    computerChecksEnabledFor: async () => (options.enabled === false ? null : { github: true }),
    ingestComputerChecksReportNow: proto.ingestComputerChecksReportNow,
    writeComputerChecksReport: async (machineId: string, value: unknown) => {
      const delay = options.writeDelayMs?.(value) ?? 0;
      if (delay) await new Promise((resolve) => setTimeout(resolve, delay));
      return (await cache.write(machineId, value)) !== null;
    },
  };
  const ingest = (value: unknown, connection: unknown = conn) => proto.ingestComputerChecksReport!.call(self, "machine-1", connection, value) as Promise<boolean>;
  return { conn, memory, cache, events, ingest };
}

test("a report from the current connection of an attached Computer is kept, scrubbed, replacing the last", async () => {
  const h = ingestHarness();
  assert.equal(await h.ingest(report("2026-11-19T10:00:00.000Z", `2.60.0 ${FAKE_TOKEN}`)), true);
  const stored = await h.cache.read("machine-1");
  assert.equal(stored?.report.plugins[0]!.items[0]!.value?.startsWith("2.60.0 "), true);
  assert.ok(![...h.memory.values.values()].some((entry) => entry.value.includes(FAKE_TOKEN)));
  assert.ok(!JSON.stringify(h.events).includes(FAKE_TOKEN));
  assert.equal(h.memory.values.get(computerChecksReportKey("machine-1"))!.ttlSeconds, 7 * 24 * 60 * 60);

  assert.equal(await h.ingest(report("2026-11-19T10:05:00.000Z", "2.61.0")), true);
  assert.equal((await h.cache.read("machine-1"))?.report.plugins[0]!.items[0]!.value, "2.61.0");
  // An older round of the same connection does not overwrite a newer one.
  assert.equal(await h.ingest(report("2026-11-19T10:01:00.000Z", "2.59.0")), false);
  assert.equal((await h.cache.read("machine-1"))?.report.plugins[0]!.items[0]!.value, "2.61.0");
});

test("a raw daemon, an unattached Computer, a replaced connection or a malformed report write nothing", async () => {
  for (const h of [ingestHarness({ principalKind: "legacy_machine" }), ingestHarness({ attachedBy: null })]) {
    assert.equal(await h.ingest(report()), false);
    assert.equal(h.memory.values.size, 0);
  }
  const replaced = ingestHarness();
  assert.equal(await replaced.ingest(report(), { principalKind: "computer", serverId: "server-1" }), false);
  const malformed = ingestHarness();
  for (const bad of [null, { ...report(), schemaVersion: 2 }, { ...report(), plugins: [{ id: "x; rm", items: [], durationMs: 0 }] }]) {
    assert.equal(await malformed.ingest(bad), false);
  }
  assert.equal(replaced.memory.values.size + malformed.memory.values.size, 0);
});

function sendHarness(options: { capabilities: string[] | null; enabled?: boolean }) {
  const sent: Array<{ machineId: string; msg: { type: string } }> = [];
  const conn = { capabilities: new Set(options.capabilities ?? []), serverId: "server-1" };
  const self = {
    machineConnections: new Map<string, unknown>([["machine-1", conn]]),
    readProbeCarrierFact: async () => (options.capabilities ? { capabilities: options.capabilities } : null),
    computerChecksEnabledFor: async () => (options.enabled === false ? null : { github: true, node: true }),
    computerChecksAvailability: proto.computerChecksAvailability,
    sendToMachine: async (machineId: string, msg: { type: string }) => { sent.push({ machineId, msg }); return true; },
    recordEvent: () => {},
  };
  return {
    sent,
    config: () => proto.sendComputerChecksConfig!.call(self, "machine-1", conn) as Promise<void>,
    refresh: () => proto.requestComputerChecksRefresh!.call(self, "machine-1", "server-1") as Promise<boolean>,
  };
}

test("config on ready and a refresh go only to a Computer with the capability, config first", async () => {
  const h = sendHarness({ capabilities: [DAEMON_CAPABILITY_COMPUTER_CHECKS] });
  await h.config();
  assert.equal(await h.refresh(), true);
  assert.deepEqual(h.sent.map((entry) => entry.msg), [
    { type: "computer:checks:config", enabled: { github: true, node: true } },
    { type: "computer:checks:config", enabled: { github: true, node: true } },
    { type: "computer:checks:refresh" },
  ]);
});

test("an older Computer, an offline one, or a server with the flag off gets nothing", async () => {
  for (const h of [
    sendHarness({ capabilities: [DAEMON_CAPABILITY_PROC_STOP] }),
    sendHarness({ capabilities: null }),
    sendHarness({ capabilities: [DAEMON_CAPABILITY_COMPUTER_CHECKS], enabled: false }),
  ]) {
    await h.config();
    assert.equal(await h.refresh(), false);
    assert.deepEqual(h.sent, []);
  }
});

test("the refresh claim: once per Computer for 30 s", async () => {
  const memory = memoryBackend();
  const cache = new ComputerChecksCacheService(memory.backend);
  assert.equal(await cache.tryClaimRefresh("machine-1", 1_000), true);
  assert.equal(await cache.tryClaimRefresh("machine-1", 2_000), false);
  assert.equal(await cache.tryClaimRefresh("machine-2", 2_000), true);
  assert.equal(memory.values.get(computerChecksRefreshKey("machine-1"))!.ttlSeconds, 30);
  assert.equal(await cache.refreshRequestedAtMs("machine-1"), 1_000);
  // Expired (Redis drops the key): claimable again.
  memory.values.delete(computerChecksRefreshKey("machine-1"));
  assert.equal(await cache.tryClaimRefresh("machine-1", 31_000), true);
});

test("with the flag off for the server, a report is dropped", async () => {
  const h = ingestHarness({ enabled: false });
  assert.equal(await h.ingest(report()), false);
  assert.equal(h.memory.values.size, 0);
  assert.equal(h.events.at(-1)!.outcome, "disabled");
});

test("reports of one connection are handled in arrival order: an older one still being written never lands after a newer one", async () => {
  // The older round's write is slow; the newer one arrives while it is in progress.
  const h = ingestHarness({ writeDelayMs: (value) => ((value as { checkedAt: string }).checkedAt.endsWith("10:01:00.000Z") ? 50 : 0) });
  const older = h.ingest(report("2026-11-19T10:01:00.000Z", "2.59.0"));
  const newer = h.ingest(report("2026-11-19T10:05:00.000Z", "2.61.0"));
  assert.deepEqual(await Promise.all([older, newer]), [true, true]);
  assert.equal((await h.cache.read("machine-1"))?.report.plugins[0]!.items[0]!.value, "2.61.0");
  // And one older than what was kept, arriving after it, is dropped.
  assert.equal(await h.ingest(report("2026-11-19T10:03:00.000Z", "2.60.0")), false);
});

test("a claim is given back only by the refresh that made it", async () => {
  const memory = memoryBackend();
  const cache = new ComputerChecksCacheService(memory.backend);
  assert.equal(await cache.tryClaimRefresh("machine-1", 1_000), true);
  await cache.releaseRefresh("machine-1", 999);
  assert.equal(await cache.refreshRequestedAtMs("machine-1"), 1_000, "another claim's release leaves it");
  await cache.releaseRefresh("machine-1", 1_000);
  assert.equal(await cache.tryClaimRefresh("machine-1", 1_500), true);
});

test("a report whose checkedAt is ahead of the server's clock by more than 2 minutes is refused, so it cannot pin itself over later reports", async () => {
  assert.equal(COMPUTER_CHECKS_CLOCK_SKEW_MS, 2 * 60_000);
  const h = ingestHarness();
  const ahead = (ms: number) => new Date(currentTimeMs() + ms).toISOString();
  assert.equal(await h.ingest(report(ahead(COMPUTER_CHECKS_CLOCK_SKEW_MS + 60_000), "9.9.9")), false);
  assert.equal(h.events.at(-1)!.outcome, "future");
  assert.equal(h.memory.values.size, 0);
  // Within the skew it is kept, and a later real report still lands after it.
  assert.equal(await h.ingest(report(ahead(60_000), "2.60.0")), true);
  assert.equal(await h.ingest(report(ahead(90_000), "2.61.0")), true);
  assert.equal((await h.cache.read("machine-1"))?.report.plugins[0]!.items[0]!.value, "2.61.0");
});

test("the server strips control, bidi and invisible characters from every key, label and value", async () => {
  assert.equal(scrubComputerCheckText("Ali‮ce​ \u0007Example⁦"), "Alice Example");
  const cache = new ComputerChecksCacheService(memoryBackend().backend);
  const stored = await cache.write("machine-1", {
    schemaVersion: 1,
    checkedAt: "2026-11-19T10:00:00.000Z",
    plugins: [{ id: "github", items: [{ key: "git.user.name‍", label: "Git‮ name", value: "Mallory‮gnp.exe", displayText: true, status: "local" }], durationMs: 1 }],
  });
  assert.deepEqual(stored?.report.plugins[0]!.items[0], { key: "git.user.name", label: "Git name", value: "Mallorygnp.exe", displayText: true, status: "local" });
});
