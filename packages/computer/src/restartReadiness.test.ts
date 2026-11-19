import assert from "node:assert/strict";

import type { MachineFacts, RunnerMachineFacts } from "./machineFacts";
import {
  callerIsRunnerHosted,
  classifyRestartReadiness,
  waitForRestartReadiness,
} from "./restartReadiness";

const VERSION = "9.9.9";

function runner(
  serverId: string,
  over: Partial<RunnerMachineFacts> = {},
): RunnerMachineFacts {
  return {
    serverId,
    pid: 100,
    alive: true,
    versionEvidence: { pid: 100, version: VERSION, installRoot: "/opt/raft", writtenAt: "2026-09-15T00:00:00.000Z" },
    connectionEvidence: { pid: 100, connectedAt: 2_000 },
    ...over,
  };
}

function facts(runners: RunnerMachineFacts[], managed = runners.map((r) => r.serverId)): MachineFacts {
  return { managedServerIds: managed, runners };
}

test("classify: a connection marker written before the restart request never counts as reconnected", () => {
  const snapshot = classifyRestartReadiness(facts([runner("s1")]), ["s1"], /* requestedAtMs */ 2_000, VERSION);
  assert.equal(snapshot.complete, false);
  assert.deepEqual(snapshot.runners, [
    { serverId: "s1", state: "pending", detail: "runner pid 100 still shows a connection from before this restart" },
  ]);
});

test("classify: a connection marker written after the request by the attested runner pid is connected", () => {
  const snapshot = classifyRestartReadiness(
    facts([runner("s1", { connectionEvidence: { pid: 100, connectedAt: 2_001 } })]),
    ["s1"],
    2_000,
    VERSION,
  );
  assert.deepEqual(snapshot, { complete: true, runners: [{ serverId: "s1", state: "connected", pid: 100 }] });
});

test("classify: readiness reasons become human pending detail per server", () => {
  const snapshot = classifyRestartReadiness(
    facts(
      [
        runner("absent", { pid: null, alive: false, versionEvidence: null, connectionEvidence: null }),
        runner("unattested", { versionEvidence: null }),
        runner("skew", { versionEvidence: { pid: 100, version: "1.0.0", installRoot: "/opt/raft", writtenAt: "2026-09-15T00:00:00.000Z" } }),
        runner("disconnected", { connectionEvidence: null }),
        runner("stale-pid", { connectionEvidence: { pid: 99, connectedAt: 9_000 } }),
      ],
      ["absent", "unattested", "skew", "disconnected", "stale-pid"],
    ),
    ["absent", "unattested", "skew", "disconnected", "stale-pid", "unmanaged"],
    2_000,
    VERSION,
  );
  assert.equal(snapshot.complete, false);
  assert.deepEqual(
    snapshot.runners.map((r) => [r.serverId, r.state === "pending" ? r.detail : "connected"]),
    [
      ["absent", "runner process not started yet"],
      ["disconnected", "runner starting (pid 100), not connected to the server yet"],
      ["skew", "runner pid 100 is version 1.0.0, expected 9.9.9"],
      ["stale-pid", "runner starting (pid 100), not connected to the server yet"],
      ["unattested", "runner starting (pid 100), version not attested yet"],
      ["unmanaged", "server is not managed by this Computer"],
    ],
  );
});

function fakeClock(startMs: number) {
  let nowMs = startMs;
  const sleeps: number[] = [];
  return {
    now: () => nowMs,
    sleep: async (ms: number) => {
      sleeps.push(ms);
      nowMs += ms;
    },
    sleeps,
    tick: () => nowMs,
  };
}

test("wait: a runner that never reconnects returns an incomplete snapshot exactly at the bound, without throwing", async () => {
  const clock = fakeClock(10_000);
  let polls = 0;
  const snapshot = await waitForRestartReadiness("/tmp/home", ["s1"], 10_000, {
    timeoutMs: 2_000,
    pollIntervalMs: 500,
    now: clock.now,
    sleep: clock.sleep,
    expectedVersion: VERSION,
    collectFacts: async () => {
      polls += 1;
      return facts([runner("s1", { connectionEvidence: null })]);
    },
  });
  assert.equal(snapshot.complete, false);
  assert.equal(snapshot.runners[0]?.state, "pending");
  assert.deepEqual(clock.sleeps, [500, 500, 500, 500]);
  assert.equal(polls, 5);
  assert.equal(clock.tick(), 12_000);
});

test("wait: a runner that reconnects at 5s completes early and announces each server once", async () => {
  const clock = fakeClock(10_000);
  const announced: string[] = [];
  const snapshot = await waitForRestartReadiness("/tmp/home", ["s1", "s2"], 10_000, {
    timeoutMs: 60_000,
    pollIntervalMs: 1_000,
    now: clock.now,
    sleep: clock.sleep,
    expectedVersion: VERSION,
    onConnected: (r) => announced.push(`${r.serverId}:${r.pid}`),
    collectFacts: async () => {
      const t = clock.now();
      return facts([
        // s1 connects at +2s, s2 at +5s; both markers post-date the request.
        runner("s1", { pid: 201, versionEvidence: { pid: 201, version: VERSION, installRoot: "/opt/raft", writtenAt: "2026-09-15T00:00:00.000Z" },
          connectionEvidence: t >= 12_000 ? { pid: 201, connectedAt: 12_000 } : null }),
        runner("s2", { pid: 202, versionEvidence: { pid: 202, version: VERSION, installRoot: "/opt/raft", writtenAt: "2026-09-15T00:00:00.000Z" },
          connectionEvidence: t >= 15_000 ? { pid: 202, connectedAt: 15_000 } : null }),
      ]);
    },
  });
  assert.equal(snapshot.complete, true);
  assert.equal(clock.tick(), 15_000);
  assert.deepEqual(announced, ["s1:201", "s2:202"]);
});

test("wait: an aborted signal stops polling", async () => {
  const controller = new AbortController();
  controller.abort();
  await assert.rejects(
    waitForRestartReadiness("/tmp/home", ["s1"], 0, {
      signal: controller.signal,
      collectFacts: async () => {
        throw new Error("must not poll");
      },
    }),
  );
});

test("callerIsRunnerHosted: only a non-empty SLOCK_AGENT_ID marks an agent-hosted caller", () => {
  assert.equal(callerIsRunnerHosted({}), false);
  assert.equal(callerIsRunnerHosted({ SLOCK_AGENT_ID: "" }), false);
  assert.equal(callerIsRunnerHosted({ SLOCK_AGENT_ID: "agent-1" }), true);
});

test("classify: a spawned runner that has not connected is named only for the live service's own spawn", () => {
  const nowMs = Date.UTC(2026, 10, 14, 12, 0, 0);
  const spawnedRunner = runner("s1", {
    pid: null,
    alive: false,
    connectionEvidence: null,
    versionEvidence: { pid: 300, version: VERSION, installRoot: "/opt/raft", writtenAt: "2026-11-14T11:59:00.000Z" },
    spawned: { pid: 300, servicePid: 900, spawnedAt: nowMs - 60_000, alive: true },
  });
  const detail = (servicePid: number) =>
    classifyRestartReadiness(facts([spawnedRunner]), ["s1"], 2_000, VERSION, { servicePid, nowMs }).runners[0];
  assert.deepEqual(detail(900), { serverId: "s1", state: "pending", detail: "runner starting (pid 300), not connected to the server yet" });
  // An orphan an earlier service spawned is not named as this service's runner.
  assert.deepEqual(detail(901), { serverId: "s1", state: "pending", detail: "runner process not started yet" });
});
