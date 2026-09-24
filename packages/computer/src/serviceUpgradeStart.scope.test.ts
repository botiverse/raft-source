import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import type { ChildProcess } from "node:child_process";
import { test } from "vitest";

import type { KUpgradeCoordinatorRequest } from "./kUpgradeCoordinator.js";
import { createServiceUpgradeStart } from "./serviceUpgradeStart.js";

function childProcess(pid = 4312): ChildProcess {
  const child = new EventEmitter() as ChildProcess;
  Object.defineProperty(child, "pid", { value: pid });
  Object.defineProperty(child, "exitCode", { value: null, writable: true });
  Object.defineProperty(child, "signalCode", { value: null, writable: true });
  return child;
}

function harness() {
  const spawned: KUpgradeCoordinatorRequest[] = [];
  let control: { requestId: string; owner: symbol } | null = null;
  const start = createServiceUpgradeStart({
    slockHome: "/computer-home",
    currentBinaryPath: "/installed/raft-computer",
    servicePid: 4100,
    priorProcessIdentities: () => ["runner:server-a:4101"],
    isSeaBinaryFn: () => true,
    readChannelFn: async () => "latest",
    inspectKUpgradeStartFn: async () => "fresh",
    spawnKUpgradeCoordinatorFn: async (_home, request) => {
      spawned.push(request);
      return childProcess();
    },
    waitForKUpgradeStartFn: async () => {},
    checkControlAvailability: (requestId) => control?.requestId === requestId ? "replay" : "available",
    claimControl: (requestId) => {
      const owner = Symbol(requestId);
      control = { requestId, owner };
      return owner;
    },
    releaseControl: (owner) => {
      if (control?.owner !== owner) return false;
      control = null;
      return true;
    },
  });
  return { start, spawned };
}

test("local and remote upgrade-start variants converge on one K seam with exact scope", async () => {
  const local = harness();
  assert.deepEqual(await local.start({
    scope: "local",
    requestId: "local-request",
    targetVersion: "1.0.25",
    trigger: "cli",
  }), {
    status: "started",
    upgradeId: "local-request",
    targetVersion: "1.0.25",
  });
  assert.equal(local.spawned.length, 1);
  assert.equal((local.spawned[0] as KUpgradeCoordinatorRequest & { scope?: string }).scope, "local");
  assert.equal("originServerId" in local.spawned[0]!, false);

  const remote = harness();
  assert.deepEqual(await remote.start({
    scope: "remote",
    requestId: "remote-request",
    originServerId: "server-a",
    targetVersion: "1.0.25",
    trigger: "web",
  }), {
    status: "started",
    upgradeId: "remote-request",
    targetVersion: "1.0.25",
  });
  assert.equal(remote.spawned.length, 1);
  assert.equal((remote.spawned[0] as KUpgradeCoordinatorRequest & { scope?: string }).scope, "remote");
  assert.equal(remote.spawned[0]?.originServerId, "server-a");
});

test("same request id with a different local/remote identity is not an exact replay", async () => {
  const { start } = harness();
  await start({
    scope: "local",
    requestId: "same-request",
    targetVersion: "1.0.25",
    trigger: "tray",
  });

  await assert.rejects(
    start({
      scope: "remote",
      requestId: "same-request",
      originServerId: "server-a",
      targetVersion: "1.0.25",
      trigger: "web",
    }),
    /exact upgrade request identity does not match/u,
  );
});
