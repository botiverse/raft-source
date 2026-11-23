import assert from "node:assert/strict";
import { DAEMON_CAPABILITY_INTERRUPT_SUBAGENT, DAEMON_CAPABILITY_PROC_STOP } from "@botiverse/raft-shared";

import { AgentOrchestrator } from "./agentOrchestrator";
import { ProcJobsCacheService, procJobsCacheKey, PROC_JOBS_CACHE_TTL_SECONDS } from "./procJobsCacheService";

// docs/contracts/proc-jobs.md, the server side: the snapshot is kept only
// from the current connection of an attached Computer, strictly parsed, cut
// to the agents assigned to the machine and to the caps; a person's Stop
// reaches only a Computer that offers it, named by (agent, name).
// RED proofs: drop the boundary check and the replaced connection's snapshot
// is written; drop capProcJobsSnapshotJobs and the stranger's job is kept.

type Proto = Record<string, (...args: unknown[]) => unknown>;
const proto = AgentOrchestrator.prototype as unknown as Proto;

function ingestHarness(options: { principalKind?: string; attachedBy?: string | null; assigned?: string[] } = {}) {
  const conn = { principalKind: options.principalKind ?? "computer", serverId: "server-1" };
  const writes: Array<{ machineId: string; snapshot: { jobs: Array<{ agentId: string; name: string }> } }> = [];
  const self = {
    machineConnections: new Map<string, unknown>([["machine-1", conn]]),
    loadRuntimeAccountUsageAttacher: async () => (options.attachedBy === undefined ? "user-1" : options.attachedBy),
    isRuntimeAccountUsageDataBoundaryAuthorized: proto.isRuntimeAccountUsageDataBoundaryAuthorized,
    recordEvent: () => {},
    loadProcJobsAssignedAgentIds: async () => new Set(options.assigned ?? ["agent-1"]),
    writeProcJobsSnapshot: async (machineId: string, snapshot: never) => { writes.push({ machineId, snapshot }); },
  };
  const ingest = (value: unknown, connection: unknown = conn) => proto.ingestProcJobsSnapshot!.call(self, "machine-1", connection, value) as Promise<boolean>;
  return { conn, self, writes, ingest };
}

const job = (agentId: string, name: string, extra: Record<string, unknown> = {}) => ({ agentId, name, state: "running", startedAt: "2026-11-19T10:00:00.000Z", ...extra });
const snapshot = (jobs: unknown[]) => ({ protocolVersion: 1, reportedAt: "2026-11-19T10:05:00.000Z", jobs });

test("a snapshot from the current connection of an attached Computer is kept, without jobs of agents not assigned to it", async () => {
  const h = ingestHarness({ assigned: ["agent-1"] });
  assert.equal(await h.ingest(snapshot([job("agent-1", "web"), job("agent-stranger", "x")])), true);
  assert.deepEqual(h.writes.map((write) => write.snapshot.jobs.map((entry) => `${entry.agentId}/${entry.name}`)), [["agent-1/web"]]);
  assert.equal(h.writes[0]!.machineId, "machine-1");
});

test("at most 20 jobs per agent and 200 per Computer are kept", async () => {
  const agentIds = Array.from({ length: 12 }, (_, index) => `agent-${String(index).padStart(2, "0")}`);
  const h = ingestHarness({ assigned: agentIds });
  const jobs = agentIds.flatMap((agentId) => Array.from({ length: 25 }, (_, index) => job(agentId, `job-${index}`)));
  assert.equal(await h.ingest(snapshot(jobs)), true);
  const kept = h.writes[0]!.snapshot.jobs;
  assert.equal(kept.length, 200);
  assert.ok(agentIds.every((agentId) => kept.filter((entry) => entry.agentId === agentId).length <= 20));
});

test("a raw daemon, an unattached Computer, a replaced connection or a malformed snapshot write nothing", async () => {
  for (const h of [ingestHarness({ principalKind: "legacy_machine" }), ingestHarness({ attachedBy: null })]) {
    assert.equal(await h.ingest(snapshot([job("agent-1", "web")])), false);
    assert.deepEqual(h.writes, []);
  }
  const replaced = ingestHarness();
  assert.equal(await replaced.ingest(snapshot([job("agent-1", "web")]), { principalKind: "computer", serverId: "server-1" }), false);
  assert.deepEqual(replaced.writes, []);
  const malformed = ingestHarness();
  for (const bad of [
    snapshot([job("agent-1", "web", { command: "node server.js" })]),
    snapshot([job("agent-1", "web", { cwd: "/home/q" })]),
    snapshot([job("agent-1", "web; rm -rf /")]),
    { ...snapshot([]), extra: true },
    null,
  ]) {
    assert.equal(await malformed.ingest(bad), false, JSON.stringify(bad));
  }
  assert.deepEqual(malformed.writes, []);
});

function stopHarness(capabilities: string[] | null, outcome: unknown = "stopped") {
  const sent: unknown[] = [];
  const relayed: Array<Record<string, unknown>> = [];
  const self = {
    readProbeCarrierFact: async () => (capabilities ? { capabilities } : null),
    sendRequiredToMachine: async (_machineId: string, message: unknown) => { sent.push(message); },
    recordMachineResponseRelay: () => {},
    getMachineResponseRelay: () => ({
      request: async (request: Record<string, unknown>, _timeoutMs: number, send: () => Promise<unknown>) => {
        relayed.push(request);
        await send();
        return { type: "machine:proc_job:stop:result", requestId: request.requestId, agentId: request.agentId, name: "web", outcome };
      },
    }),
  };
  const stop = (stoppedBy: string | null = "tygg") => AgentOrchestrator.prototype.stopProcJob.call(self as never, "machine-1", "agent-1", "web", stoppedBy);
  return { sent, relayed, stop };
}

test("a person's Stop goes to a Computer that offers it, named by agent and name with the stopper; the answer comes back through the relay", async () => {
  const h = stopHarness([DAEMON_CAPABILITY_PROC_STOP]);
  assert.deepEqual(await h.stop(), { outcome: "stopped" });
  assert.equal(h.relayed[0]!.type, "machine:proc_job:stop:result");
  assert.equal(h.relayed[0]!.agentId, "agent-1");
  assert.deepEqual(h.sent, [{ type: "machine:proc_job:stop", requestId: h.relayed[0]!.requestId, agentId: "agent-1", name: "web", stoppedBy: "tygg" }]);
  // An outcome this server does not know is a failure, not passed on.
  assert.deepEqual(await stopHarness([DAEMON_CAPABILITY_PROC_STOP], "rm -rf").stop(), { outcome: "failed" });
});

test("an older Computer and an offline one get no request", async () => {
  const old = stopHarness([DAEMON_CAPABILITY_INTERRUPT_SUBAGENT]);
  assert.deepEqual(await old.stop(), { outcome: "computer_upgrade_required" });
  const offline = stopHarness(null);
  assert.deepEqual(await offline.stop(), { outcome: "computer_offline" });
  assert.equal(old.sent.length + offline.sent.length, 0);
});

test("the cache: re-validated on write under slock:proc-jobs:v1:<machineId> for 15 minutes; nothing or garbage reads as unknown", async () => {
  const store = new Map<string, { value: string; ttl: number }>();
  const cache = new ProcJobsCacheService({
    get: async (key) => store.get(key)?.value ?? null,
    set: async (key, value, ttl) => { store.set(key, { value, ttl }); },
  });
  assert.equal(await cache.read("machine-1"), null);
  assert.equal(await cache.write("machine-1", snapshot([job("agent-1", "web", { argv: ["x"] })])), null);
  assert.equal(store.size, 0);
  assert.ok(await cache.write("machine-1", snapshot([job("agent-1", "web")])));
  assert.equal(store.get(procJobsCacheKey("machine-1"))?.ttl, PROC_JOBS_CACHE_TTL_SECONDS);
  assert.equal(procJobsCacheKey("machine-1"), "slock:proc-jobs:v1:machine-1");
  assert.deepEqual((await cache.read("machine-1"))?.jobs.map((entry) => entry.name), ["web"]);
  store.set(procJobsCacheKey("machine-2"), { value: "{not json", ttl: 1 });
  assert.equal(await cache.read("machine-2"), null);
});

test("an older snapshot of the same connection never overwrites a newer one, even when it was sent first and read its agents last", async () => {
  const h = ingestHarness();
  let release: () => void = () => {};
  const gate = new Promise<void>((resolve) => { release = resolve; });
  let reads = 0;
  h.self.loadProcJobsAssignedAgentIds = async () => {
    reads += 1;
    if (reads === 1) await gate; // the first (older) snapshot is slow to read its agents
    return new Set(["agent-1"]);
  };
  const older = h.ingest({ protocolVersion: 1, reportedAt: "2026-11-19T10:05:00.000Z", jobs: [job("agent-1", "old")] });
  const newer = await h.ingest({ protocolVersion: 1, reportedAt: "2026-11-19T10:05:02.000Z", jobs: [job("agent-1", "new")] });
  release();
  assert.equal(newer, true);
  assert.equal(await older, false, "the older one is dropped after its slow read");
  assert.equal(await h.ingest({ protocolVersion: 1, reportedAt: "2026-11-19T10:04:00.000Z", jobs: [] }), false, "an older one arriving later is dropped at once");
  assert.deepEqual(h.writes.map((write) => write.snapshot.jobs.map((j) => j.name)), [["new"]]);
});
