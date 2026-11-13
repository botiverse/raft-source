// Rollback contract of `performServiceSelfRestart` (task #912).
//
// `spawnDetachedService` registers the replacement pid in `run/service.pid`
// as soon as it spawns the candidate. When the takeover fails (the candidate
// never proves exclusive IPC ownership — the Windows field case was a
// named-pipe bind failure), the incumbent kills the candidate and tries to
// re-own the endpoint. That restoration can itself fail (EADDRINUSE). The
// incumbent is still the live service either way, so the pidfile must name
// it again before `SELF_RELAUNCH_UNAVAILABLE` surfaces — otherwise
// `raft-computer stop` reads a dead pid, reports stale_pidfile_cleared, and
// leaves the service and its runners running.
import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { writePidfileAt } from "./internal/process-primitives";
import { ServiceClientError } from "./lib/types";
import { servicePidPath } from "./paths";
import {
  awaitRestartOutcomeAfterConnectionLoss,
  isServiceConnectionLoss,
  performServiceSelfRestart,
  requestServiceUpgradeStartViaIpc,
} from "./serviceControl";

async function withHome<T>(fn: (home: string) => Promise<T>): Promise<T> {
  const home = await mkdtemp(join(tmpdir(), "raft-service-control-"));
  try {
    return await fn(home);
  } finally {
    await rm(home, { recursive: true, force: true });
  }
}

const REPLACEMENT_PID = 777_777;

function failingTakeoverDeps(home: string, restoreOwnership: () => Promise<void>) {
  let clock = 0;
  const killed: Array<[number, NodeJS.Signals]> = [];
  return {
    killed,
    deps: {
      // Mirrors the real spawner: the candidate pid lands in the pidfile.
      spawnDetachedServiceFn: async () => {
        await writePidfileAt(servicePidPath(home), REPLACEMENT_PID);
        return REPLACEMENT_PID;
      },
      // The candidate never attests (bind failure): no takeover proof.
      readReplacementAttestationFn: async () => null,
      listManagedServerIdsFn: async () => ["server-a"],
      readManagedMachineIdentitiesFn: async () => ({ "server-a": "machine-a" }),
      isProcessAliveFn: () => false,
      killProcess: (pid: number, signal: NodeJS.Signals) => {
        killed.push([pid, signal]);
      },
      releaseServiceOwnership: async () => {},
      restoreServiceOwnership: restoreOwnership,
      now: () => clock,
      sleep: async (ms: number) => {
        clock += Math.max(1, ms);
      },
      takeoverTimeoutMs: 5,
      candidateShutdownTimeoutMs: 1,
      restoreOwnershipTimeoutMs: 5,
    },
  };
}

test("self-restart rollback: incumbent pid is restored even when ownership restoration fails", async () => {
  await withHome(async (home) => {
    const { deps, killed } = failingTakeoverDeps(home, async () => {
      throw new Error("listen EADDRINUSE: named pipe is busy");
    });
    await assert.rejects(
      () => performServiceSelfRestart(home, deps),
      (err: unknown) =>
        err instanceof ServiceClientError &&
        err.code === "SELF_RELAUNCH_UNAVAILABLE" &&
        err.message.includes("incumbent ownership restore failed: listen EADDRINUSE"),
    );
    // The candidate was told to go away…
    assert.deepEqual(killed[0], [REPLACEMENT_PID, "SIGTERM"]);
    // …and the pidfile names the live incumbent again, not the dead candidate.
    assert.equal((await readFile(servicePidPath(home), "utf8")).trim(), String(process.pid));
  });
});

test("self-restart rollback: incumbent pid is restored before ownership restoration runs", async () => {
  await withHome(async (home) => {
    let pidfileAtRestore: string | null = null;
    const { deps } = failingTakeoverDeps(home, async () => {
      pidfileAtRestore = (await readFile(servicePidPath(home), "utf8")).trim();
    });
    await assert.rejects(
      () => performServiceSelfRestart(home, deps),
      (err: unknown) => err instanceof ServiceClientError && err.code === "SELF_RELAUNCH_UNAVAILABLE",
    );
    assert.equal(pidfileAtRestore, String(process.pid));
    assert.equal((await readFile(servicePidPath(home), "utf8")).trim(), String(process.pid));
  });
});

test("self-restart rollback: a pidfile write failure is reported, not swallowed", async () => {
  await withHome(async (home) => {
    const { deps } = failingTakeoverDeps(home, async () => {});
    await assert.rejects(
      () => performServiceSelfRestart(home, { ...deps, writeIncumbentPidfile: async () => { throw new Error("EACCES: run/"); } }),
      (err: unknown) =>
        err instanceof ServiceClientError &&
        err.code === "SELF_RELAUNCH_UNAVAILABLE" &&
        err.message.includes("incumbent pidfile restore failed: EACCES: run/"),
    );
  });
});

// task #924: on Windows the restart request's connection is closed by the
// handoff itself, so the requester settles the restart from the marker.
function markerFor(serverId: string, requestId: string) {
  return { requestId, originServerId: serverId, startedAt: "2026-10-27T00:00:00.000Z" };
}

test("isServiceConnectionLoss: a closed or reset connection, not a typed service error", () => {
  assert.equal(isServiceConnectionLoss(new ServiceClientError("IPC_CLIENT_CLOSED", "closed")), true);
  const reset = Object.assign(new Error("read ECONNRESET"), { code: "ECONNRESET" });
  assert.equal(isServiceConnectionLoss(new ServiceClientError("IPC_MALFORMED_FRAME", "socket error: read ECONNRESET", reset)), true);
  assert.equal(isServiceConnectionLoss(new ServiceClientError("IPC_MALFORMED_FRAME", "frame decode failed")), false);
  assert.equal(isServiceConnectionLoss(new ServiceClientError("SELF_RELAUNCH_UNAVAILABLE", "x")), false);
  assert.equal(isServiceConnectionLoss(new Error("closed")), false);
});

test("awaitRestartOutcomeAfterConnectionLoss: cleared marker while alive is the failed takeover", async () => {
  const reads = [markerFor("server-a", "req-1"), markerFor("server-a", "req-1"), null];
  let t = 0;
  await assert.rejects(
    awaitRestartOutcomeAfterConnectionLoss("/tmp/raft-home", "server-a", "req-1", {
      readPendingRestartMarkerFn: async () => reads.shift() ?? null,
      now: () => t,
      sleep: async (ms) => { t += ms; },
      timeoutMs: 60_000,
    }),
    (error: unknown) =>
      error instanceof ServiceClientError &&
      error.code === "SELF_RELAUNCH_UNAVAILABLE" &&
      /did not complete/.test(error.message),
  );
  assert.equal(reads.length, 0);
});

test("awaitRestartOutcomeAfterConnectionLoss: a marker for another request is not this restart", async () => {
  await assert.rejects(
    awaitRestartOutcomeAfterConnectionLoss("/tmp/raft-home", "server-a", "req-1", {
      readPendingRestartMarkerFn: async () => markerFor("server-a", "req-2"),
    }),
    /did not complete/,
  );
});

test("awaitRestartOutcomeAfterConnectionLoss: keeps waiting while the handoff is pending, bounded", async () => {
  let t = 0;
  let readsCount = 0;
  await assert.rejects(
    awaitRestartOutcomeAfterConnectionLoss("/tmp/raft-home", "server-a", "req-1", {
      readPendingRestartMarkerFn: async () => {
        readsCount += 1;
        return markerFor("server-a", "req-1");
      },
      now: () => t,
      sleep: async (ms) => { t += ms; },
      timeoutMs: 1_000,
    }),
    /restart handoff did not finish/,
  );
  assert.ok(readsCount > 2, `polled ${readsCount} times`);
});

// Reconciler step 13: the runner relays the Server's (clamped) drain to the
// service; a `draining` answer is an accepted upgrade, as `started` is.
test("step 13: requestServiceUpgradeStartViaIpc relays drain and accepts draining", async () => {
  const requests: unknown[] = [];
  let answer: { status: string; upgradeId: string } = { status: "draining", upgradeId: "req-1" };
  const connectServiceFn = (async () => ({
    request: async (method: string, params: unknown) => { requests.push([method, params]); return answer; },
    close: async () => {},
  })) as unknown as NonNullable<Parameters<typeof requestServiceUpgradeStartViaIpc>[2]>["connectServiceFn"];
  await requestServiceUpgradeStartViaIpc("/unused", { requestId: "req-1", originServerId: "s", targetVersion: "1.0.9", drain: { deadlineMs: 600_000 } }, { connectServiceFn });
  await requestServiceUpgradeStartViaIpc("/unused", { requestId: "req-1", originServerId: "s" }, { connectServiceFn });
  assert.deepEqual(requests, [
    ["upgrade-start", { scope: "remote", requestId: "req-1", originServerId: "s", trigger: "web", targetVersion: "1.0.9", drain: { deadlineMs: 600_000 } }],
    ["upgrade-start", { scope: "remote", requestId: "req-1", originServerId: "s", trigger: "web" }],
  ]);
  answer = { status: "already-running", upgradeId: "req-0" };
  await assert.rejects(() => requestServiceUpgradeStartViaIpc("/unused", { requestId: "req-1", originServerId: "s" }, { connectServiceFn }), /UPGRADE_ALREADY_RUNNING/);
});
