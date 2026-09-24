import assert from "node:assert/strict";
import { test } from "vitest";
import type { OperationRecord, Upgrader, UpgradeOutcome } from "@botiverse/k-carrier";

import { runKUpgradeCoordinator, type KUpgradeCoordinatorRequest } from "./kUpgradeCoordinator.js";

const request: KUpgradeCoordinatorRequest = {
  carrier: "k",
  mode: "upgrade",
  scope: "remote",
  requestId: "k-op-1",
  originServerId: "server-1",
  fromVersion: "1.0.16",
  targetVersion: "1.1.0",
  startedAt: "2026-08-14T08:00:00.000Z",
  currentBinaryPath: "/installed/raft-computer",
  trigger: "web",
  priorProcessIdentities: ["service:41", "runner:server-1:42"],
};

function operation(outcome: OperationRecord["outcome"]): OperationRecord {
  return {
    formatVersion: 1,
    id: request.requestId,
    startedAtMs: Date.parse(request.startedAt),
    updatedAtMs: Date.parse(request.startedAt),
    fromVersion: request.fromVersion,
    targetVersion: request.targetVersion,
    previousStableVersion: request.fromVersion,
    phase: outcome ?? "recovering",
    outcome,
    reason: null,
    provenance: { who: "server-1", carrier: "web" },
    metadata: {
      upgradeScopeVersion: "1",
      upgradeScope: "remote",
      originServerId: "server-1",
      trigger: "web",
      priorProcessIdentities: JSON.stringify(request.priorProcessIdentities),
    },
    acknowledgedAtMs: null,
  };
}

function fakeUpgrader(outcome: UpgradeOutcome, acknowledgements: string[] = []): Upgrader {
  let receipt = operation(outcome.result === "promoted" ? "promoted" : null);
  return {
    recover: async () => { receipt = operation("rolled-back"); },
    check: async () => ({ current: request.fromVersion, target: request.targetVersion }),
    upgrade: async () => outcome,
    upgradeTo: async () => outcome,
    rollback: async () => "rolled-back",
    retireLegacyManager: async () => "retired",
    state: async () => ({
      phase: outcome.result === "promoted" ? "promoted" : "rolled-back",
      stableVersion: outcome.result === "promoted" ? request.targetVersion : request.fromVersion,
      experimentVersion: null,
      rollbackReason: null,
    }),
    status: async () => ({
      phase: "idle",
      stable: request.fromVersion,
      experiment: null,
      predicates: { kind: "genesis" },
      policy: "confirm",
      provenance: null,
    }),
    operation: async () => ({ kind: "observed", operation: receipt }),
    acknowledgeOperation: async (id) => {
      acknowledgements.push(id);
      receipt = { ...receipt, acknowledgedAtMs: 99 };
      return "acknowledged";
    },
    quarantineState: async () => ({ status: "not-found", sourcePath: "/state", quarantinePath: "/backup", operationId: "none", timestampMs: 0 }),
  };
}

const localRequest: KUpgradeCoordinatorRequest = {
  carrier: "k",
  mode: "upgrade",
  scope: "local",
  requestId: request.requestId,
  fromVersion: request.fromVersion,
  targetVersion: request.targetVersion,
  startedAt: request.startedAt,
  currentBinaryPath: request.currentBinaryPath,
  trigger: "cli",
};

function promotedOutcome(): UpgradeOutcome {
  return {
    result: "promoted",
    report: {
      version: request.targetVersion,
      binaryAtTarget: { passed: true, source: "live", observedAtMs: 1, detail: {} },
      hostLifecycleConverged: null,
    },
  };
}

test("detached driver bootstraps then passes exact operation ownership to K", async () => {
  const order: string[] = [];
  let driven: { version: string; opts: unknown } | null = null;
  const upgrader = fakeUpgrader({
    result: "promoted",
    report: {
      version: request.targetVersion,
      binaryAtTarget: { passed: true, source: "live", observedAtMs: 1, detail: {} },
      hostLifecycleConverged: null,
    },
  });
  upgrader.upgradeTo = async (version, opts) => {
    order.push("upgrade");
    driven = { version, opts };
    return {
      result: "promoted",
      report: {
        version,
        binaryAtTarget: { passed: true, source: "live", observedAtMs: 1, detail: {} },
        hostLifecycleConverged: null,
      },
    };
  };

  const result = await runKUpgradeCoordinator("/home", request, {
    bootstrapStableFn: async () => { order.push("bootstrap"); return "bootstrapped"; },
    createUpgraderFn: () => upgrader,
  });
  assert.equal(result, "promoted");
  assert.deepEqual(order, ["bootstrap", "upgrade"]);
  assert.deepEqual(driven, {
    version: request.targetVersion,
    opts: {
      consented: true,
      provenance: { who: "server-1", carrier: "web" },
      operation: {
        id: request.requestId,
        startedAtMs: Date.parse(request.startedAt),
        metadata: {
          upgradeScopeVersion: "1",
          upgradeScope: "remote",
          coordinatorPid: String(process.pid),
          originServerId: "server-1",
          trigger: "web",
          priorProcessIdentities: JSON.stringify(request.priorProcessIdentities),
        },
      },
    },
  });
});

test("local driver persists an explicit local scope marker without a Server origin", async () => {
  const localRequest: KUpgradeCoordinatorRequest = {
    ...request,
    scope: "local",
    trigger: "tray",
    originServerId: undefined,
  };
  const driven: Array<{ operation?: { metadata?: Record<string, string> } }> = [];
  const upgrader = fakeUpgrader({
    result: "promoted",
    report: {
      version: localRequest.targetVersion,
      binaryAtTarget: { passed: true, source: "live", observedAtMs: 1, detail: {} },
      hostLifecycleConverged: null,
    },
  });
  upgrader.upgradeTo = async (_version, opts) => {
    driven.push(opts as typeof driven[number]);
    return {
      result: "promoted",
      report: {
        version: localRequest.targetVersion,
        binaryAtTarget: { passed: true, source: "live", observedAtMs: 1, detail: {} },
        hostLifecycleConverged: null,
      },
    };
  };

  await runKUpgradeCoordinator("/home", localRequest, {
    bootstrapStableFn: async () => "bootstrapped",
    createUpgraderFn: () => upgrader,
  });
  assert.deepEqual(driven[0]?.operation?.metadata, {
    trigger: "tray",
    upgradeScopeVersion: "1",
    upgradeScope: "local",
    coordinatorPid: String(process.pid),
    priorProcessIdentities: JSON.stringify(localRequest.priorProcessIdentities),
  });
});

test("recovery consults only K's active operation and settles it", async () => {
  const upgrader = fakeUpgrader({ result: "up-to-date" });
  const result = await runKUpgradeCoordinator("/home", { ...request, mode: "recover" }, {
    bootstrapStableFn: async () => "already-initialized",
    createUpgraderFn: () => upgrader,
  });
  assert.equal(result, "recovered-terminal");
  const receipt = await upgrader.operation();
  assert.equal(receipt.kind, "observed");
  if (receipt.kind === "observed") assert.equal(receipt.operation.outcome, "rolled-back");
});

test("a local-scope driver acknowledges its own promoted receipt: nobody else delivers a local upgrade", async () => {
  const acknowledgements: string[] = [];
  const upgrader = fakeUpgrader(promotedOutcome(), acknowledgements);
  assert.equal(
    await runKUpgradeCoordinator("/home", localRequest, {
      bootstrapStableFn: async () => "bootstrapped" as const,
      createUpgraderFn: () => upgrader,
    }),
    "promoted",
  );
  assert.deepEqual(acknowledgements, [request.requestId]);
});

test("a local-scope driver acknowledges an up-to-date receipt so a no-op never blocks the next upgrade", async () => {
  const acknowledgements: string[] = [];
  const upgrader = fakeUpgrader({ result: "up-to-date" }, acknowledgements);
  assert.equal(
    await runKUpgradeCoordinator("/home", localRequest, {
      bootstrapStableFn: async () => "bootstrapped" as const,
      createUpgraderFn: () => upgrader,
    }),
    "up-to-date",
  );
  assert.deepEqual(acknowledgements, [request.requestId]);
});

test("a local-scope driver leaves a rolled-back receipt unacknowledged so status still surfaces the failure", async () => {
  const acknowledgements: string[] = [];
  const upgrader = fakeUpgrader({ result: "rolled-back", reason: "successor never attested", report: null }, acknowledgements);
  assert.equal(
    await runKUpgradeCoordinator("/home", localRequest, {
      bootstrapStableFn: async () => "bootstrapped" as const,
      createUpgraderFn: () => upgrader,
    }),
    "rolled-back",
  );
  assert.deepEqual(acknowledgements, []);
});

test("a remote-scope driver never acknowledges: the Server delivers remote receipts", async () => {
  const acknowledgements: string[] = [];
  const upgrader = fakeUpgrader(promotedOutcome(), acknowledgements);
  assert.equal(
    await runKUpgradeCoordinator("/home", request, {
      bootstrapStableFn: async () => "bootstrapped" as const,
      createUpgraderFn: () => upgrader,
    }),
    "promoted",
  );
  assert.deepEqual(acknowledgements, []);
});
