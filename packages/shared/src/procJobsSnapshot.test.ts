import assert from "node:assert/strict";
import { test } from "vitest";

import {
  formatProcOwnerStopExit,
  parseProcJobLedger,
} from "./procJobs";
import {
  capProcJobsSnapshotJobs,
  PROC_JOBS_SNAPSHOT_MAX_JOBS_PER_AGENT,
  PROC_JOBS_SNAPSHOT_MAX_JOBS_PER_MACHINE,
  safeParseProcJobsSnapshot,
  type ProcJobsSnapshotJob,
} from "./procJobsSnapshot";

const job = (overrides: Partial<ProcJobsSnapshotJob> = {}): ProcJobsSnapshotJob => ({
  agentId: "agent-1",
  name: "web",
  state: "running",
  startedAt: "2026-11-19T10:00:00.000Z",
  ...overrides,
});
const snapshot = (jobs: unknown[]) => ({ protocolVersion: 1, reportedAt: "2026-11-19T10:05:00.000Z", jobs });

test("the snapshot schema reads the job fields it names", () => {
  const parsed = safeParseProcJobsSnapshot(snapshot([
    job(),
    job({ name: "bot", state: "exited", exitedAt: "2026-11-19T10:04:00.000Z", exitCode: null, exitSignal: "SIGTERM", exitReason: "owner_stop", stoppedBy: "tygg", memoryMaxBytes: 4 * 1024 ** 3, rssBytes: 1024 }),
  ]));
  assert.ok(parsed.success);
  assert.equal(parsed.data.jobs.length, 2);
});

test("the snapshot schema drops a payload that carries a command, argv, cwd, env or log path", () => {
  for (const extra of [{ command: "node" }, { argv: ["node", "x"] }, { cwd: "/home/q" }, { env: { A: "1" } }, { logPath: "/x.log" }, { pid: 1 }]) {
    assert.equal(safeParseProcJobsSnapshot(snapshot([{ ...job(), ...extra }])).success, false, JSON.stringify(extra));
  }
  assert.equal(safeParseProcJobsSnapshot({ ...snapshot([job()]), hostname: "h" }).success, false);
});

test("the snapshot schema refuses a bad name, a bad stopper and an unbounded reason", () => {
  for (const bad of [
    job({ name: "a b" }),
    job({ name: "x".repeat(41) }),
    job({ name: "" }),
    job({ name: "../etc" }),
    job({ stoppedBy: "a b" }),
    job({ stoppedBy: "x".repeat(65) }),
    job({ exitReason: "Owner Stop" }),
    job({ exitSignal: "kill -9" }),
    job({ agentId: "../agent" }),
  ]) {
    assert.equal(safeParseProcJobsSnapshot(snapshot([bad])).success, false, JSON.stringify(bad));
  }
});

test("the server keeps at most 20 jobs per agent and 200 per Computer, running and newest first, only assigned agents", () => {
  const many: ProcJobsSnapshotJob[] = [];
  for (let a = 0; a < 12; a += 1) {
    for (let j = 0; j < 25; j += 1) {
      many.push(job({
        agentId: `agent-${String(a).padStart(2, "0")}`,
        name: `job-${j}`,
        state: j % 2 === 0 ? "exited" : "running",
        startedAt: new Date(Date.UTC(2026, 10, 19, 0, j)).toISOString(),
      }));
    }
  }
  many.push(job({ agentId: "stranger", name: "x" }));
  const allowed = new Set(many.map((entry) => entry.agentId).filter((id) => id !== "stranger"));
  const kept = capProcJobsSnapshotJobs(many, allowed);
  assert.equal(kept.length, PROC_JOBS_SNAPSHOT_MAX_JOBS_PER_MACHINE);
  assert.ok(!kept.some((entry) => entry.agentId === "stranger"));
  const first = kept.filter((entry) => entry.agentId === "agent-00");
  assert.equal(first.length, PROC_JOBS_SNAPSHOT_MAX_JOBS_PER_AGENT);
  // All 12 running ones first, newest first, then the newest exited ones.
  assert.deepEqual(first.slice(0, 2).map((entry) => entry.name), ["job-23", "job-21"]);
  assert.ok(first.slice(0, 12).every((entry) => entry.state === "running"));
  // Agents in id order: the 11th and 12th get nothing past 200.
  assert.equal(kept.filter((entry) => entry.agentId === "agent-10").length, 0);
  // Same input in another order, same answer.
  assert.deepEqual(capProcJobsSnapshotJobs([...many].reverse(), allowed), kept);
});

test("a repeated (agent, name) is kept once", () => {
  assert.equal(capProcJobsSnapshotJobs([job(), job()], new Set(["agent-1"])).length, 1);
});

test("the owner-stop text names the stopper, or a person", () => {
  assert.equal(formatProcOwnerStopExit("tygg"), "exited: stopped by @tygg");
  assert.equal(formatProcOwnerStopExit(null), "exited: stopped by a person");
  assert.equal(formatProcOwnerStopExit("not a handle"), "exited: stopped by a person");
});

test("the ledger keeps a valid stopper with owner_stop and drops a malformed one", () => {
  const entry = {
    agentId: "agent-1", name: "web", pid: 10, pgid: 10, startIdentity: "linux:1", command: "node", startedAtMs: 1,
    logPath: "/x", scope: "none", state: "exited", exitCode: null, exitSignal: "SIGTERM", exitedAtMs: 2, adopted: false,
  };
  const read = (extra: Record<string, unknown>) => parseProcJobLedger(JSON.stringify({ version: 1, jobs: [{ ...entry, ...extra }] }))[0]!;
  assert.equal(read({ exitReason: "owner_stop", stoppedBy: "tygg" }).stoppedBy, "tygg");
  assert.equal(read({ exitReason: "owner_stop" }).exitReason, "owner_stop");
  assert.equal("stoppedBy" in read({ exitReason: "owner_stop", stoppedBy: "a b; rm -rf" }), false);
  assert.equal("stoppedBy" in read({ exitReason: "owner_stop", stoppedBy: "x".repeat(65) }), false);
  assert.equal("stoppedBy" in read({ exitReason: "owner_stop", stoppedBy: 7 }), false);
  // A stopper without the reason it belongs to is not kept.
  assert.equal("stoppedBy" in read({ exitReason: "memory_limit", stoppedBy: "tygg" }), false);
});
