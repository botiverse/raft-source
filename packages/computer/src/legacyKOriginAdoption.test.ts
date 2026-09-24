import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "vitest";

import {
  loadOperation,
  persistOperation,
  type OperationRead,
  type OperationRecord,
} from "@botiverse/k-carrier";

import { inspectKUpgradeStart } from "./kUpgradeProcess.js";
import { kStateDir } from "./kPaths.js";
import { adoptLegacyKUpgradeOrigin } from "./legacyKOriginAdoption.js";
import {
  acknowledgeKReadyReceipt,
  bindKUpgradeReadyAcknowledgement,
} from "./residentLifecycleBridge.js";
import { COMPUTER_VERSION } from "./version.js";

const SERVER_ID = "11111111-1111-4111-8111-111111111111";
const SECOND_SERVER_ID = "22222222-2222-4222-8222-222222222222";
const OPERATION_ID = "33333333-3333-4333-8333-333333333333";
const NEXT_OPERATION_ID = "44444444-4444-4444-8444-444444444444";

function legacyOperation(overrides: Partial<OperationRecord> = {}): OperationRecord {
  return {
    formatVersion: 1,
    id: OPERATION_ID,
    startedAtMs: 1,
    updatedAtMs: 2,
    fromVersion: "1.0.18",
    targetVersion: COMPUTER_VERSION,
    previousStableVersion: "1.0.18",
    phase: "promoted",
    outcome: "promoted",
    reason: null,
    provenance: { who: "local", carrier: "cli" },
    metadata: {
      trigger: "cli",
      priorProcessIdentities: JSON.stringify([
        "service:5500",
        `runner:${SERVER_ID}:5555`,
      ]),
    },
    acknowledgedAtMs: null,
    ...overrides,
  };
}

test("resident core wiring cannot silently drop legacy K adoption", async () => {
  const serviceSource = await readFile(new URL("./service.ts", import.meta.url), "utf8");
  assert.match(
    serviceSource,
    /reconcileComputerLifecycleOrigin:\s*\(\)\s*=>\s*adoptLegacyKUpgradeOrigin\(\{\s*slockHome,\s*serverId:\s*creds\.serverId\s*\}\)/u,
  );
});

test("successor adopts the exact legacy K receipt, projects a ready ack, and unlocks repromote only after receipt", async () => {
  const home = await mkdtemp(join(tmpdir(), "raft-computer-legacy-k-adoption-"));
  const prepareCalls: Array<{
    serverId: string;
    operationId: string;
    targetVersion: string;
    trigger: string;
  }> = [];
  try {
    await persistOperation(kStateDir(home), legacyOperation());
    assert.deepEqual(await adoptLegacyKUpgradeOrigin({ slockHome: home, serverId: SERVER_ID }, {
      prepareExactLifecycleFn: async (_home, serverId, operationId, targetVersion, trigger) => {
        prepareCalls.push({ serverId, operationId, targetVersion, trigger });
        return { status: "prepared", operation: { serverId, operationId, trigger } };
      },
      isAlive: () => false,
    }), { status: "adopted", operationId: OPERATION_ID });
    assert.deepEqual(prepareCalls, [{
      serverId: SERVER_ID,
      operationId: OPERATION_ID,
      targetVersion: COMPUTER_VERSION,
      trigger: "cli",
    }]);

    const adopted = await loadOperation(kStateDir(home));
    assert.equal(adopted.kind, "observed");
    if (adopted.kind !== "observed") return;
    assert.equal(adopted.operation.id, OPERATION_ID);
    assert.equal(adopted.operation.metadata.originServerId, SERVER_ID);
    assert.equal(adopted.operation.metadata.originBinding, "legacy-local-k/v1");
    assert.deepEqual(adopted.operation.provenance, { who: SERVER_ID, carrier: "cli" });

    assert.ok(bindKUpgradeReadyAcknowledgement({
      acknowledgement: {
        operationId: OPERATION_ID,
        action: "upgrade",
        phase: "ready",
        loadedComputerVersion: COMPUTER_VERSION,
      },
      serverId: SERVER_ID,
      operation: adopted,
      service: {
        computerVersion: COMPUTER_VERSION,
        serviceGeneration: "generation-new",
        servicePid: 5962,
        managedServerIds: [SERVER_ID],
        managedSetRevision: "revision-new",
      },
      isAlive: () => false,
    }));

    await acknowledgeKReadyReceipt({ slockHome: home, operationId: OPERATION_ID, phase: "ready" }, {
      nowMs: () => 3,
    });
    const acknowledged = await loadOperation(kStateDir(home));
    assert.equal(acknowledged.kind === "observed" && acknowledged.operation.acknowledgedAtMs, 3);
    assert.equal(await inspectKUpgradeStart(home, {
      carrier: "k",
      mode: "upgrade",
      scope: "remote",
      requestId: NEXT_OPERATION_ID,
      originServerId: SERVER_ID,
      fromVersion: COMPUTER_VERSION,
      targetVersion: "1.0.18",
      startedAt: new Date(4).toISOString(),
      currentBinaryPath: "/computer/current",
      trigger: "web",
    }), "fresh");
  } finally {
    await rm(home, { recursive: true, force: true });
  }
});

test("legacy adoption rejects near misses without preparing an intent or modifying K", async () => {
  const cases: Array<{
    name: string;
    operation: OperationRecord;
    serverId?: string;
    isAlive?: (pid: number) => boolean;
  }> = [
    {
      name: "new attachment is absent from prior runner identities",
      operation: legacyOperation(),
      serverId: SECOND_SERVER_ID,
    },
    {
      name: "one predecessor remains alive",
      operation: legacyOperation(),
      isAlive: (pid) => pid === 5555,
    },
    {
      name: "target does not equal the successor",
      operation: legacyOperation({ targetVersion: "9.9.9" }),
    },
    {
      name: "receipt already has an origin",
      operation: legacyOperation({
        provenance: { who: SECOND_SERVER_ID, carrier: "cli" },
        metadata: {
          ...legacyOperation().metadata,
          originServerId: SECOND_SERVER_ID,
        },
      }),
    },
    {
      name: "new versioned local receipt is not legacy-adoptable",
      operation: legacyOperation({
        metadata: {
          ...legacyOperation().metadata,
          upgradeScopeVersion: "1",
          upgradeScope: "local",
        },
      }),
    },
    {
      name: "operation id is not a Server-compatible UUID",
      operation: legacyOperation({ id: "not-a-uuid" }),
    },
    {
      name: "trigger is not the stable local CLI origin",
      operation: legacyOperation({
        metadata: { ...legacyOperation().metadata, trigger: "tray" },
      }),
    },
    {
      name: "provenance is not local CLI",
      operation: legacyOperation({ provenance: { who: SECOND_SERVER_ID, carrier: "cli" } }),
    },
    {
      name: "service predecessor evidence is absent",
      operation: legacyOperation({
        metadata: {
          ...legacyOperation().metadata,
          priorProcessIdentities: JSON.stringify([`runner:${SERVER_ID}:5555`]),
        },
      }),
    },
  ];

  for (const entry of cases) {
    let current: OperationRead = { kind: "observed", operation: entry.operation };
    let prepares = 0;
    let persists = 0;
    assert.deepEqual(await adoptLegacyKUpgradeOrigin({
      slockHome: "/unused",
      serverId: entry.serverId ?? SERVER_ID,
    }, {
      loadOperationFn: async () => structuredClone(current),
      persistOperationFn: async (_stateDir, operation) => {
        persists += 1;
        current = { kind: "observed", operation };
      },
      prepareExactLifecycleFn: async (_home, serverId, operationId, _target, trigger) => {
        prepares += 1;
        return { status: "prepared", operation: { serverId, operationId, trigger } };
      },
      isAlive: entry.isAlive ?? (() => false),
    }), { status: "not_adopted" }, entry.name);
    assert.equal(prepares, 0, `${entry.name}: Server intent must not be prepared`);
    assert.equal(persists, 0, `${entry.name}: K receipt must remain unchanged`);
  }
});

test("legacy adoption refuses mismatched Server acceptance and a changed K receipt", async () => {
  for (const mode of ["server-rejected", "wrong-operation", "changed-receipt"] as const) {
    let current: OperationRead = { kind: "observed", operation: legacyOperation() };
    let persists = 0;
    assert.deepEqual(await adoptLegacyKUpgradeOrigin({ slockHome: "/unused", serverId: SERVER_ID }, {
      loadOperationFn: async () => structuredClone(current),
      persistOperationFn: async (_stateDir, operation) => {
        persists += 1;
        current = { kind: "observed", operation };
      },
      prepareExactLifecycleFn: async (_home, serverId, operationId, _target, trigger) => {
        if (mode === "server-rejected") return { status: "rejected", code: "permanent_rejection" };
        if (mode === "changed-receipt" && current.kind === "observed") {
          current.operation = { ...current.operation, updatedAtMs: current.operation.updatedAtMs + 1 };
        }
        return {
          status: "prepared",
          operation: {
            serverId,
            operationId: mode === "wrong-operation" ? NEXT_OPERATION_ID : operationId,
            trigger,
          },
        };
      },
      isAlive: () => false,
    }), { status: "not_adopted" });
    assert.equal(persists, 0);
  }
});

test("two prior-server successors race through one exact Server operation id and only the winner binds K", async () => {
  let current: OperationRead = {
    kind: "observed",
    operation: legacyOperation({
      metadata: {
        ...legacyOperation().metadata,
        priorProcessIdentities: JSON.stringify([
          "service:5500",
          `runner:${SERVER_ID}:5555`,
          `runner:${SECOND_SERVER_ID}:5666`,
        ]),
      },
    }),
  };
  let winner: string | null = null;
  const preparedIds: string[] = [];
  const persistedOwners: string[] = [];
  const prepare = async (
    _home: string,
    serverId: string,
    operationId: string,
    _targetVersion: string,
    trigger: "cli" | "web" | "tray",
  ) => {
    preparedIds.push(operationId);
    if (winner === null) winner = serverId;
    await new Promise<void>((resolve) => setImmediate(resolve));
    return winner === serverId
      ? { status: "prepared" as const, operation: { serverId, operationId, trigger } }
      : { status: "rejected" as const, code: "operation_conflict" };
  };
  const deps = {
    loadOperationFn: async () => structuredClone(current),
    persistOperationFn: async (_stateDir: string, operation: OperationRecord) => {
      persistedOwners.push(operation.metadata.originServerId ?? "missing");
      current = { kind: "observed", operation };
    },
    prepareExactLifecycleFn: prepare,
    isAlive: () => false,
  };

  const results = await Promise.all([
    adoptLegacyKUpgradeOrigin({ slockHome: "/unused", serverId: SERVER_ID }, deps),
    adoptLegacyKUpgradeOrigin({ slockHome: "/unused", serverId: SECOND_SERVER_ID }, deps),
  ]);
  assert.deepEqual(
    results.sort((left, right) => left.status.localeCompare(right.status)),
    [
      { status: "adopted", operationId: OPERATION_ID },
      { status: "not_adopted" },
    ],
  );
  assert.deepEqual(preparedIds, [OPERATION_ID, OPERATION_ID], "both candidates arbitrate the same K id");
  assert.deepEqual(persistedOwners, [winner]);
  assert.equal(current.kind === "observed" && current.operation.id, OPERATION_ID);
  assert.equal(current.kind === "observed" && current.operation.metadata.originServerId, winner);
});

test("legacy adoption exposes only the narrow ready-pending rejection for same-K retry", async () => {
  for (const code of [
    "computer_offline",
    "computer_lifecycle_completion_ready_pending",
  ] as const) {
    const result = await adoptLegacyKUpgradeOrigin({
      slockHome: "/unused",
      serverId: SERVER_ID,
    }, {
      loadOperationFn: async () => ({ kind: "observed", operation: legacyOperation() }),
      persistOperationFn: async () => {
        assert.fail("a transient ready rejection must not bind K");
      },
      prepareExactLifecycleFn: async () => ({ status: "retryable_ready_pending", code }),
      isAlive: () => false,
    });
    assert.deepEqual(result, { status: "retryable_ready_pending", operationId: OPERATION_ID, code });
  }
});
