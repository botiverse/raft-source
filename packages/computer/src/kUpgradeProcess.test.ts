import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { mkdtemp, mkdir } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { test } from "vitest";
import type { ChildProcess } from "node:child_process";
import type { OperationRecord, Upgrader } from "@botiverse/k-carrier";

import {
  inspectKUpgradeStart,
  readKUpgradeCoordinatorRequest,
  spawnKUpgradeCoordinator,
  spawnPendingKUpgradeRecovery,
  waitForKUpgradeStart,
} from "./kUpgradeProcess.js";
import { serviceRunDir } from "./paths.js";
import type { KUpgradeCoordinatorRequest } from "./kUpgradeCoordinator.js";

const REQUEST: KUpgradeCoordinatorRequest = {
  carrier: "k",
  mode: "upgrade",
  scope: "local",
  requestId: "request-1",
  fromVersion: "1.0.16",
  targetVersion: "1.1.0",
  startedAt: "2026-08-14T10:00:00.000Z",
  currentBinaryPath: "/installed/raft-computer",
  trigger: "cli",
  priorProcessIdentities: ["service:41", "runner:server-1:42"],
};

async function withHome(run: (home: string) => Promise<void>): Promise<void> {
  const home = await mkdtemp(path.join(os.tmpdir(), "computer-k-process-"));
  await mkdir(serviceRunDir(home), { recursive: true });
  await run(home);
}

function fakeUpgrader(operation: OperationRecord): Upgrader {
  return {
    recover: async () => {},
    check: async () => ({ current: operation.fromVersion, target: operation.targetVersion }),
    upgrade: async () => ({ result: "up-to-date" }),
    upgradeTo: async () => ({ result: "up-to-date" }),
    rollback: async () => "rolled-back",
    retireLegacyManager: async () => "retired",
    state: async () => ({ phase: "idle", stableVersion: operation.fromVersion, experimentVersion: null, rollbackReason: null }),
    status: async () => ({ phase: "idle", stable: operation.fromVersion, experiment: null, predicates: { kind: "genesis" }, policy: "confirm", provenance: null }),
    operation: async () => ({ kind: "observed", operation }),
    acknowledgeOperation: async () => "acknowledged",
    quarantineState: async () => ({ status: "not-found", sourcePath: "/state", quarantinePath: "/backup", operationId: "none", timestampMs: 0 }),
  };
}

function operationForRequest(
  request: KUpgradeCoordinatorRequest,
  overrides: Partial<OperationRecord> = {},
): OperationRecord {
  return {
    formatVersion: 1,
    id: request.requestId,
    startedAtMs: Date.parse(request.startedAt),
    updatedAtMs: Date.parse(request.startedAt),
    fromVersion: request.fromVersion,
    targetVersion: request.targetVersion,
    previousStableVersion: request.fromVersion,
    phase: "checking",
    outcome: null,
    reason: null,
    provenance: { who: request.originServerId ?? "local", carrier: request.trigger },
    metadata: {
      upgradeScopeVersion: "1",
      upgradeScope: request.scope,
      coordinatorPid: "9000",
      trigger: request.trigger,
      ...(request.scope === "remote" ? { originServerId: request.originServerId } : {}),
      ...(request.priorProcessIdentities?.length
        ? { priorProcessIdentities: JSON.stringify(request.priorProcessIdentities) }
        : {}),
    },
    acknowledgedAtMs: null,
    ...overrides,
  };
}

test("spawn passes one encoded non-secret request directly to the detached SEA", async () => {
  await withHome(async (home) => {
    const resident = path.join(home, "computer", "k", "slots", "stable", "artifact.bin");
    let args: readonly string[] = [];
    const child = new EventEmitter() as ChildProcess;
    Object.defineProperty(child, "pid", { value: 4321 });
    child.unref = () => child;
    await spawnKUpgradeCoordinator(home, REQUEST, {
      isSeaBinaryFn: () => true,
      resolveKResidentBinaryFn: async () => resident,
      spawnFn: ((_command: string, next: readonly string[]) => {
        args = next;
        return child;
      }) as never,
    });
    assert.equal(args[0], "__k-upgrade");
    assert.equal(args.length, 2);
    assert.deepEqual(readKUpgradeCoordinatorRequest(args[1]!), REQUEST);
  });
});

test("encoded request parser is closed and rejects traversal-shaped ids", () => {
  const malformed = Buffer.from(JSON.stringify({ ...REQUEST, requestId: "../escape" })).toString("base64url");
  assert.throws(() => readKUpgradeCoordinatorRequest(malformed), /K_COORDINATOR_REQUEST_INVALID/u);
  assert.throws(() => readKUpgradeCoordinatorRequest("not-json"), /K_COORDINATOR_REQUEST_INVALID/u);
});

test("service preflight admits only genesis/acknowledged terminal or exact replay", async () => {
  const exact = operationForRequest(REQUEST);
  assert.equal(await inspectKUpgradeStart("/home", REQUEST, async () => ({
    kind: "observed",
    operation: exact,
  })), "exact");
  assert.equal(await inspectKUpgradeStart("/home", REQUEST, async () => ({
    kind: "observed",
    operation: {
      ...exact,
      id: "previous-operation",
      phase: "promoted",
      outcome: "promoted",
      acknowledgedAtMs: exact.updatedAtMs,
    },
  })), "fresh");
  await assert.rejects(
    inspectKUpgradeStart("/home", REQUEST, async () => ({
      kind: "observed",
      operation: { ...exact, id: "unacknowledged-operation" },
    })),
    /K_UPGRADE_OPERATION_BLOCKED/u,
  );
  await assert.rejects(
    inspectKUpgradeStart("/home", REQUEST, async () => ({
      kind: "observed",
      operation: { ...exact, targetVersion: "9.9.9" },
    })),
    /K_UPGRADE_RECEIPT_IDENTITY_MISMATCH/u,
  );
  await assert.rejects(
    inspectKUpgradeStart("/home", REQUEST, async () => ({
      kind: "observed",
      operation: { ...exact, fromVersion: "0.0.0" },
    })),
    /K_UPGRADE_RECEIPT_IDENTITY_MISMATCH/u,
  );
});

test("detached start waits for the exact durable id/target/origin receipt", async () => {
  const request: KUpgradeCoordinatorRequest = {
    ...REQUEST,
    scope: "remote",
    originServerId: "server-1",
    trigger: "web",
  };
  let reads = 0;
  await waitForKUpgradeStart("/home", request, () => false, {
    loadOperationFn: async () => {
      reads += 1;
      return reads === 1
        ? { kind: "genesis" }
        : { kind: "observed", operation: operationForRequest(request) };
    },
    now: () => 0,
    sleep: async () => {},
  });
  assert.equal(reads, 2);

  await assert.rejects(
    waitForKUpgradeStart("/home", request, () => true, {
      loadOperationFn: async () => ({ kind: "genesis" }),
      now: () => 0,
      sleep: async () => {},
    }),
    /K_UPGRADE_COORDINATOR_REJECTED/u,
  );
  await assert.rejects(
    waitForKUpgradeStart("/home", request, () => true, {
      loadOperationFn: async () => ({
        kind: "observed",
        operation: operationForRequest(request),
      }),
      now: () => 0,
      sleep: async () => {},
    }),
    /K_UPGRADE_COORDINATOR_REJECTED/u,
  );
  await assert.rejects(
    waitForKUpgradeStart("/home", request, () => false, {
      loadOperationFn: async () => ({
        kind: "observed",
        operation: operationForRequest(request, {
          metadata: {
            upgradeScopeVersion: "1",
            upgradeScope: "remote",
            trigger: "web",
            originServerId: "wrong-server",
          },
        }),
      }),
      now: () => 0,
      sleep: async () => {},
    }),
    /K_UPGRADE_RECEIPT_IDENTITY_MISMATCH/u,
  );
});

test("startup recovery is derived only from K's active operation", async () => {
  const active: OperationRecord = {
    formatVersion: 1,
    id: REQUEST.requestId,
    startedAtMs: Date.parse(REQUEST.startedAt),
    updatedAtMs: Date.parse(REQUEST.startedAt),
    fromVersion: REQUEST.fromVersion,
    targetVersion: REQUEST.targetVersion,
    previousStableVersion: REQUEST.fromVersion,
    phase: "recovering",
    outcome: null,
    reason: null,
    provenance: { who: "local", carrier: "cli" },
    metadata: {
      upgradeScopeVersion: "1",
      upgradeScope: "local",
      trigger: "cli",
      priorProcessIdentities: JSON.stringify(REQUEST.priorProcessIdentities),
    },
    acknowledgedAtMs: null,
  };
  let spawned: KUpgradeCoordinatorRequest | null = null;
  const child = new EventEmitter() as ChildProcess;
  assert.equal(await spawnPendingKUpgradeRecovery("/home", "/stable", {
    createUpgraderFn: () => fakeUpgrader(active),
    spawnCoordinatorFn: async (_home, request) => { spawned = request; return child; },
  }), child);
  assert.deepEqual(spawned, { ...REQUEST, mode: "recover", currentBinaryPath: "/stable" });

  assert.equal(await spawnPendingKUpgradeRecovery("/home", "/stable", {
    createUpgraderFn: () => fakeUpgrader({ ...active, phase: "promoted", outcome: "promoted" }),
    spawnCoordinatorFn: async () => { throw new Error("terminal operation must not recover"); },
  }), null);
});
