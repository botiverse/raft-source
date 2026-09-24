import assert from "node:assert/strict";
import { test } from "vitest";

import type { OperationRead, Upgrader } from "@botiverse/k-carrier";
import type { MachineServiceAttestation } from "./lib/types.js";
import { reconcileKUpgradeOnConnect } from "./kUpgradeReconcile.js";
import {
  acknowledgeKReadyReceipt,
  bindKUpgradeReadyAcknowledgement,
} from "./residentLifecycleBridge.js";
import { COMPUTER_VERSION } from "./version.js";

const SERVER_ID = "11111111-1111-4111-8111-111111111111";
const OPERATION_ID = "22222222-2222-4222-8222-222222222222";

function operation(overrides: Partial<OperationRead & { kind: "observed" }> = {}): OperationRead {
  return {
    kind: "observed",
    operation: {
      formatVersion: 1,
      id: OPERATION_ID,
      startedAtMs: 1,
      updatedAtMs: 2,
      fromVersion: "1.0.15",
      targetVersion: COMPUTER_VERSION,
      previousStableVersion: "1.0.15",
      phase: "promoted",
      outcome: "promoted",
      reason: null,
      provenance: { who: SERVER_ID, carrier: "web" },
      metadata: {
        trigger: "web",
        originServerId: SERVER_ID,
        priorProcessIdentities: JSON.stringify(["service:41", `runner:${SERVER_ID}:42`]),
      },
      acknowledgedAtMs: null,
    },
    ...overrides,
  };
}

const service: MachineServiceAttestation = {
  computerVersion: COMPUTER_VERSION,
  serviceGeneration: "generation-new",
  servicePid: 51,
  serviceExecutablePath: "/computer/k/slots/experiment/artifact",
  managedServerIds: [SERVER_ID],
  managedMachineIdentities: { [SERVER_ID]: "machine-1" },
  managedSetRevision: "revision-new",
};

test("K ready acknowledgement binds the exact promoted receipt and proves every prior pid dead", () => {
  const acknowledgement = bindKUpgradeReadyAcknowledgement({
    acknowledgement: {
      operationId: OPERATION_ID,
      action: "upgrade",
      phase: "ready",
      loadedComputerVersion: COMPUTER_VERSION,
    },
    serverId: SERVER_ID,
    operation: operation(),
    service,
    isAlive: () => false,
  });
  assert.deepEqual(acknowledgement, {
    operationId: OPERATION_ID,
    action: "upgrade",
    phase: "ready",
    loadedComputerVersion: COMPUTER_VERSION,
    serviceGeneration: "generation-new",
    managedSetRevision: "revision-new",
    oldProcessIdentitiesDead: true,
    deadProcessIdentities: ["service:41", `runner:${SERVER_ID}:42`],
  });
});

test("K ready acknowledgement fails closed while any prior process remains alive", () => {
  const acknowledgement = bindKUpgradeReadyAcknowledgement({
    acknowledgement: {
      operationId: OPERATION_ID,
      action: "upgrade",
      phase: "ready",
      loadedComputerVersion: COMPUTER_VERSION,
    },
    serverId: SERVER_ID,
    operation: operation(),
    service,
    isAlive: (pid) => pid === 42,
  });
  assert.equal(acknowledgement, null);
});

test("K ready acknowledgement rejects another origin, target, or malformed process evidence", () => {
  const base = operation();
  assert.equal(base.kind, "observed");
  for (const mutate of [
    () => ({ ...base.operation, metadata: { ...base.operation.metadata, originServerId: "other" } }),
    () => ({ ...base.operation, targetVersion: "9.9.9" }),
    () => ({ ...base.operation, metadata: { ...base.operation.metadata, priorProcessIdentities: "[]" } }),
  ]) {
    assert.equal(bindKUpgradeReadyAcknowledgement({
      acknowledgement: {
        operationId: OPERATION_ID,
        action: "upgrade",
        phase: "ready",
        loadedComputerVersion: COMPUTER_VERSION,
      },
      serverId: SERVER_ID,
      operation: { kind: "observed", operation: mutate() },
      service,
      isAlive: () => false,
    }), null);
  }
});

test("reconnect projects the terminal K operation without acknowledging it early", async () => {
  let acknowledged = 0;
  const emitted: unknown[] = [];
  const fakeUpgrader = {
    operation: async () => operation(),
    acknowledgeOperation: async () => {
      acknowledged += 1;
      return "acknowledged" as const;
    },
  } satisfies Pick<Upgrader, "operation" | "acknowledgeOperation">;

  assert.equal(await reconcileKUpgradeOnConnect({
    slockHome: "/unused",
    serverId: SERVER_ID,
    runnerVersion: COMPUTER_VERSION,
    emitDone: (done) => emitted.push(done),
  }, {
    createUpgrader: () => fakeUpgrader,
  }), true);
  assert.equal(acknowledged, 0);
  assert.deepEqual(emitted, [{
    requestId: OPERATION_ID,
    ok: true,
    newVersion: COMPUTER_VERSION,
  }]);
});

test("only an exact Server ready receipt acknowledges K's terminal operation", async () => {
  const calls: Array<{ stateDir: string; operationId: string; nowMs: number }> = [];
  const acknowledge = async (stateDir: string, operationId: string, nowMs: number) => {
    calls.push({ stateDir, operationId, nowMs });
    return "acknowledged" as const;
  };
  await acknowledgeKReadyReceipt({
    slockHome: "/computer-home",
    operationId: OPERATION_ID,
    phase: "shutdown",
  }, { acknowledge, nowMs: () => 7 });
  assert.deepEqual(calls, []);

  await acknowledgeKReadyReceipt({
    slockHome: "/computer-home",
    operationId: OPERATION_ID,
    phase: "ready",
  }, { acknowledge, nowMs: () => 7 });
  assert.deepEqual(calls, [{
    stateDir: "/computer-home/computer/k",
    operationId: OPERATION_ID,
    nowMs: 7,
  }]);
});
