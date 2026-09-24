import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "vitest";
import {
  acknowledgeOperation,
  loadOperation,
  persistOperation,
  type OperationRecord,
} from "@botiverse/k-carrier";
import {
  acknowledgeTerminalUpgradeReceipt,
  type TerminalUpgradeReceiptAcknowledgementDeps,
} from "./kOperationAcknowledgement.js";
import { inspectKUpgradeStart } from "./kUpgradeProcess.js";
import { kStateDir } from "./kPaths.js";
import { buildStatusReport } from "./status.js";

const OPERATION_ID = "terminal-k-operation";

function operation(overrides: Partial<OperationRecord> = {}): OperationRecord {
  return {
    formatVersion: 1,
    id: OPERATION_ID,
    startedAtMs: 1,
    updatedAtMs: 2,
    fromVersion: "1.0.18",
    targetVersion: "1.0.23",
    previousStableVersion: "1.0.18",
    phase: "rolled-back",
    outcome: "rolled-back",
    reason: "stable version restored",
    provenance: { who: "local", carrier: "cli" },
    metadata: {
      trigger: "cli",
      upgradeScopeVersion: "1",
      upgradeScope: "local",
      priorProcessIdentities: JSON.stringify(["service:5500", "runner:server-a:5501"]),
      coordinatorPid: "5502",
    },
    acknowledgedAtMs: null,
    ...overrides,
  };
}

function verifiedDeps(
  overrides: Partial<TerminalUpgradeReceiptAcknowledgementDeps> = {},
): TerminalUpgradeReceiptAcknowledgementDeps {
  return {
    readServiceAttestationFn: async () => ({
      computerVersion: "1.0.18",
      serviceGeneration: "stable-generation",
      servicePid: 5600,
      managedServerIds: [],
      managedSetRevision: "stable-revision",
    }),
    isProcessAliveFn: () => false,
    isKQuiescentFn: async () => true,
    ...overrides,
  };
}

async function withHome<T>(fn: (home: string) => Promise<T>): Promise<T> {
  const home = await mkdtemp(join(tmpdir(), "computer-k-ack-"));
  try {
    return await fn(home);
  } finally {
    await rm(home, { recursive: true, force: true });
  }
}

test("exact terminal acknowledgement is durable and preserves the receipt", async () => {
  await withHome(async (home) => {
    await persistOperation(kStateDir(home), operation());
    const result = await acknowledgeTerminalUpgradeReceipt(home, OPERATION_ID, verifiedDeps({
      nowMs: () => 7,
    }));
    assert.deepEqual(result, {
      status: "acknowledged",
      operationId: OPERATION_ID,
      outcome: "rolled-back",
      acknowledgedAt: "1970-01-01T00:00:00.007Z",
    });
    const after = await loadOperation(kStateDir(home));
    assert.equal(after.kind, "observed");
    if (after.kind === "observed") {
      assert.equal(after.operation.outcome, "rolled-back");
      assert.equal(after.operation.acknowledgedAtMs, 7);
    }
    assert.equal((await buildStatusReport(home)).upgrade, null);
    assert.equal(await inspectKUpgradeStart(home, {
      carrier: "k",
      mode: "upgrade",
      requestId: "next-operation",
      fromVersion: "1.0.18",
      targetVersion: "1.0.23",
      startedAt: "2026-08-31T00:00:00.000Z",
      currentBinaryPath: "/installed/raft-computer",
      scope: "local",
      trigger: "cli",
    }), "fresh");
  });
});

test("already-acknowledged exact receipt is idempotent and keeps first delivery time", async () => {
  await withHome(async (home) => {
    await persistOperation(kStateDir(home), operation({ updatedAtMs: 5, acknowledgedAtMs: 5 }));
    let writes = 0;
    const result = await acknowledgeTerminalUpgradeReceipt(home, OPERATION_ID, verifiedDeps({
      acknowledge: async () => {
        writes += 1;
        return "acknowledged";
      },
      nowMs: () => 9,
    }));
    assert.equal(result.status, "already-acknowledged");
    assert.equal(result.acknowledgedAt, "1970-01-01T00:00:00.005Z");
    assert.equal(writes, 0);
  });
});

test("promoted and failed local receipts use their distinct live-service proofs", async () => {
  await withHome(async (home) => {
    await persistOperation(kStateDir(home), operation({
      phase: "promoted",
      outcome: "promoted",
      reason: null,
    }));
    assert.equal((await acknowledgeTerminalUpgradeReceipt(home, OPERATION_ID, verifiedDeps({
      readServiceAttestationFn: async () => ({
        computerVersion: "1.0.23",
        serviceGeneration: "successor-generation",
        servicePid: 5600,
        managedServerIds: [],
        managedSetRevision: "successor-revision",
      }),
      nowMs: () => 8,
    }))).status, "acknowledged");

    await persistOperation(kStateDir(home), operation({
      phase: "failed",
      outcome: "failed",
      reason: "pre-swap failure",
    }));
    assert.equal((await acknowledgeTerminalUpgradeReceipt(home, OPERATION_ID, verifiedDeps({
      readServiceAttestationFn: async () => ({
        computerVersion: "1.0.18",
        serviceGeneration: "original-generation",
        servicePid: 5500,
        managedServerIds: [],
        managedSetRevision: "original-revision",
      }),
      isProcessAliveFn: (pid: number) => pid === 5500,
      isKQuiescentFn: async () => true,
      nowMs: () => 9,
    }))).status, "acknowledged");
  });
});

test("missing, wrong-id, and active receipts fail closed without acknowledgement", async () => {
  await withHome(async (home) => {
    let writes = 0;
    const acknowledge: typeof acknowledgeOperation = async (...args) => {
      writes += 1;
      return acknowledgeOperation(...args);
    };
    await assert.rejects(
      acknowledgeTerminalUpgradeReceipt(home, OPERATION_ID, { acknowledge }),
      (error: unknown) => error instanceof Error && error.message.includes("No K operation receipt exists"),
    );

    await persistOperation(kStateDir(home), operation());
    await assert.rejects(
      acknowledgeTerminalUpgradeReceipt(home, "another-id", { acknowledge }),
      (error: unknown) => error instanceof Error && error.message.includes("not another-id"),
    );

    await persistOperation(kStateDir(home), operation({ phase: "downloading", outcome: null }));
    await assert.rejects(
      acknowledgeTerminalUpgradeReceipt(home, OPERATION_ID, { acknowledge }),
      (error: unknown) => error instanceof Error && error.message.includes("still active"),
    );
    assert.equal(writes, 0);
  });
});

test("local acknowledgement rejects remote identity and a mismatched successor version", async () => {
  await withHome(async (home) => {
    let writes = 0;
    const acknowledge: typeof acknowledgeOperation = async (...args) => {
      writes += 1;
      return acknowledgeOperation(...args);
    };

    await persistOperation(kStateDir(home), operation({
      phase: "promoted",
      outcome: "promoted",
      metadata: {
        ...operation().metadata,
        upgradeScope: "remote",
        originServerId: "server-a",
      },
      provenance: { who: "server-a", carrier: "web" },
    }));
    await assert.rejects(
      acknowledgeTerminalUpgradeReceipt(home, OPERATION_ID, verifiedDeps({
        acknowledge,
        readServiceAttestationFn: async () => ({
          computerVersion: "1.0.23",
          serviceGeneration: "remote-successor-generation",
          servicePid: 5600,
          managedServerIds: [],
          managedSetRevision: "remote-successor-revision",
        }),
      })),
      /local scope/u,
    );

    await persistOperation(kStateDir(home), operation({
      phase: "promoted",
      outcome: "promoted",
    }));
    await assert.rejects(
      acknowledgeTerminalUpgradeReceipt(home, OPERATION_ID, verifiedDeps({
        acknowledge,
        readServiceAttestationFn: async () => ({
          computerVersion: "1.0.24",
          serviceGeneration: "wrong-generation",
          servicePid: 5600,
          managedServerIds: [],
          managedSetRevision: "wrong-revision",
        }),
      })),
      /successor version/u,
    );
    assert.equal(writes, 0);
  });
});

test("rolled-back and failed receipts remain unacknowledged until processes and K are quiescent", async () => {
  await withHome(async (home) => {
    let writes = 0;
    const acknowledge = async () => {
      writes += 1;
      return "acknowledged" as const;
    };

    await persistOperation(kStateDir(home), operation());
    await assert.rejects(
      acknowledgeTerminalUpgradeReceipt(home, OPERATION_ID, verifiedDeps({
        acknowledge,
        isProcessAliveFn: (pid: number) => pid === 5501,
      })),
      /predecessor process/u,
    );

    await persistOperation(kStateDir(home), operation({
      phase: "failed",
      outcome: "failed",
      reason: "pre-swap failure",
    }));
    await assert.rejects(
      acknowledgeTerminalUpgradeReceipt(home, OPERATION_ID, verifiedDeps({
        acknowledge,
        isProcessAliveFn: (pid: number) => pid === 5500,
        isKQuiescentFn: async () => false,
      })),
      /K coordinator or lock/u,
    );
    assert.equal(writes, 0);
  });
});

// --- official installer receipts (task #761) ---------------------------------

const INSTALLER_OPERATION_ID = "installer-ca1568ce";
const INSTALLER_SHA = "c".repeat(64);

function installerOperation(overrides: Partial<OperationRecord> = {}): OperationRecord {
  return {
    formatVersion: 1,
    id: INSTALLER_OPERATION_ID,
    startedAtMs: 1,
    updatedAtMs: 2,
    fromVersion: "1.0.26",
    targetVersion: "1.0.26",
    previousStableVersion: "1.0.26",
    phase: "up-to-date",
    outcome: "up-to-date",
    reason: null,
    provenance: { who: "local", carrier: "installer" },
    metadata: {
      trigger: "cli",
      installer: "official",
      targetVersion: "1.0.26",
      artifactSha256: INSTALLER_SHA,
      artifactSize: "123",
    },
    acknowledgedAtMs: null,
    ...overrides,
  };
}

function installerDeps(
  overrides: Partial<TerminalUpgradeReceiptAcknowledgementDeps> = {},
): TerminalUpgradeReceiptAcknowledgementDeps {
  return {
    readServiceAttestationFn: async () => null,
    readStableSlotFn: async () => ({ version: "1.0.26", sha256: INSTALLER_SHA }),
    isKLockLiveFn: async () => false,
    isProcessAliveFn: () => false,
    ...overrides,
  };
}

test("an official installer up-to-date receipt is acknowledgeable from exact stable bytes with no live service", async () => {
  await withHome(async (home) => {
    await persistOperation(kStateDir(home), installerOperation());
    const result = await acknowledgeTerminalUpgradeReceipt(home, INSTALLER_OPERATION_ID, installerDeps({ nowMs: () => 11 }));
    assert.deepEqual(result, {
      status: "acknowledged",
      operationId: INSTALLER_OPERATION_ID,
      outcome: "up-to-date",
      acknowledgedAt: "1970-01-01T00:00:00.011Z",
    });
    const after = await loadOperation(kStateDir(home));
    assert.equal(after.kind, "observed");
    if (after.kind === "observed") assert.equal(after.operation.acknowledgedAtMs, 11);
    assert.equal((await buildStatusReport(home)).upgrade, null);
  });
});

test("an installer receipt is refused when the stable slot does not hold the receipted bytes or version", async () => {
  await withHome(async (home) => {
    await persistOperation(kStateDir(home), installerOperation());
    await assert.rejects(
      acknowledgeTerminalUpgradeReceipt(home, INSTALLER_OPERATION_ID, installerDeps({
        readStableSlotFn: async () => ({ version: "1.0.26", sha256: "d".repeat(64) }),
      })),
      { code: "UPGRADE_RECEIPT_STABLE_MISMATCH" },
    );
    await assert.rejects(
      acknowledgeTerminalUpgradeReceipt(home, INSTALLER_OPERATION_ID, installerDeps({
        readStableSlotFn: async () => ({ version: "1.0.25", sha256: INSTALLER_SHA }),
      })),
      { code: "UPGRADE_RECEIPT_VERSION_MISMATCH" },
    );
    const after = await loadOperation(kStateDir(home));
    if (after.kind === "observed") assert.equal(after.operation.acknowledgedAtMs, null);
  });
});

test("an installer receipt is refused while a live service attests a different version or K's lock is live", async () => {
  await withHome(async (home) => {
    await persistOperation(kStateDir(home), installerOperation());
    await assert.rejects(
      acknowledgeTerminalUpgradeReceipt(home, INSTALLER_OPERATION_ID, installerDeps({
        readServiceAttestationFn: async () => ({
          computerVersion: "1.0.23",
          serviceGeneration: "stale",
          servicePid: 4242,
          managedServerIds: [],
          managedSetRevision: "r",
        }),
      })),
      { code: "UPGRADE_RECEIPT_VERSION_MISMATCH" },
    );
    await assert.rejects(
      acknowledgeTerminalUpgradeReceipt(home, INSTALLER_OPERATION_ID, installerDeps({
        isKLockLiveFn: async () => true,
      })),
      { code: "UPGRADE_RECEIPT_K_ACTIVE" },
    );
    // A live service attesting the receipted version is fine.
    assert.equal((await acknowledgeTerminalUpgradeReceipt(home, INSTALLER_OPERATION_ID, installerDeps({
      readServiceAttestationFn: async () => ({
        computerVersion: "1.0.26",
        serviceGeneration: "g",
        servicePid: 4242,
        managedServerIds: [],
        managedSetRevision: "r",
      }),
    }))).status, "acknowledged");
  });
});

test("only exact official installer receipts qualify: a Server origin or a non-official marker is still scope-mismatched", async () => {
  await withHome(async (home) => {
    await persistOperation(kStateDir(home), installerOperation({
      metadata: { ...installerOperation().metadata, originServerId: "server-a" },
    }));
    await assert.rejects(
      acknowledgeTerminalUpgradeReceipt(home, INSTALLER_OPERATION_ID, installerDeps()),
      { code: "UPGRADE_RECEIPT_SCOPE_MISMATCH" },
    );
    await persistOperation(kStateDir(home), installerOperation({
      metadata: { ...installerOperation().metadata, installer: "shadow" },
    }));
    await assert.rejects(
      acknowledgeTerminalUpgradeReceipt(home, INSTALLER_OPERATION_ID, installerDeps()),
      { code: "UPGRADE_RECEIPT_SCOPE_MISMATCH" },
    );
  });
});

test("a failed installer receipt is acknowledgeable only once stable is back on the pre-install version", async () => {
  await withHome(async (home) => {
    await persistOperation(kStateDir(home), installerOperation({
      fromVersion: "1.0.25",
      targetVersion: "1.0.26",
      previousStableVersion: "1.0.25",
      phase: "failed",
      outcome: "failed",
      reason: "candidate refused",
    }));
    await assert.rejects(
      acknowledgeTerminalUpgradeReceipt(home, INSTALLER_OPERATION_ID, installerDeps({
        readStableSlotFn: async () => ({ version: "1.0.26", sha256: INSTALLER_SHA }),
      })),
      { code: "UPGRADE_RECEIPT_VERSION_MISMATCH" },
    );
    assert.equal((await acknowledgeTerminalUpgradeReceipt(home, INSTALLER_OPERATION_ID, installerDeps({
      readStableSlotFn: async () => ({ version: "1.0.25", sha256: "e".repeat(64) }),
    }))).status, "acknowledged");
  });
});
