import assert from "node:assert/strict";

import {
  countMachinesNeedingAttention,
  formatComputerAttentionCounts,
  getComputerAttentionDotTone,
  getComputerAttentionStatus,
  getComputerRowDotStatus,
  getComputerRowDotTitleDescriptor,
  getComputerRowDotLight,
  summarizeComputerAttention,
} from "../src/utils/computerUpgradeIndicator";

test("Computer attention status prioritizes upgrade over offline", () => {
  assert.equal(
    getComputerAttentionStatus({
      id: "computer-1",
      status: "offline",
      isComputer: true,
      computerUpgradeAvailable: true,
    }),
    "upgrade",
  );

  assert.equal(
    getComputerAttentionStatus({
      id: "computer-2",
      status: "offline",
      isComputer: true,
      computerUpgradeAvailable: false,
    }),
    "offline",
  );

  assert.equal(
    getComputerAttentionStatus({
      id: "legacy-daemon",
      status: "offline",
      isComputer: false,
      computerUpgradeAvailable: true,
    }),
    "none",
  );
});

test("Computer attention summary returns aggregate counts and dot priority", () => {
  const summary = summarizeComputerAttention([
    { id: "upgrade", status: "online", isComputer: true, computerUpgradeAvailable: true },
    { id: "offline", status: "offline", isComputer: true, computerUpgradeAvailable: false },
    { id: "ok", status: "online", isComputer: true, computerUpgradeAvailable: false },
    { id: "legacy", status: "offline", isComputer: false, computerUpgradeAvailable: false },
  ]);

  assert.equal(summary.status, "upgrade");
  assert.equal(summary.upgradeCount, 1);
  assert.equal(summary.offlineCount, 1);
  assert.deepEqual(summary.problemComputers.map((machine) => machine.id), ["upgrade", "offline"]);
  assert.equal(formatComputerAttentionCounts(summary), "1 needs upgrade · 1 offline");
  assert.equal(getComputerAttentionDotTone(summary.status), "bg-presence-error");
});

test("rail attention counts every affected machine once", () => {
  assert.equal(countMachinesNeedingAttention([
    { id: "both", status: "offline", isComputer: false, daemonVersion: "0.9.0" },
    { id: "update", status: "online", isComputer: true, computerUpgradeAvailable: true },
    { id: "healthy", status: "online", isComputer: true, computerUpgradeAvailable: false },
  ], "1.0.0"), 2);
});

test("Computer row dot is a single full-state signal for managed Computers and legacy daemons", () => {
  assert.equal(
    getComputerRowDotStatus({
      id: "managed-online",
      status: "online",
      isComputer: true,
      computerUpgradeAvailable: false,
    }),
    "online",
  );
  assert.equal(
    getComputerRowDotStatus({
      id: "managed-offline",
      status: "offline",
      isComputer: true,
      computerUpgradeAvailable: false,
    }),
    "offline",
  );
  assert.equal(
    getComputerRowDotStatus({
      id: "managed-offline-upgrade",
      status: "offline",
      isComputer: true,
      computerUpgradeAvailable: true,
    }),
    "upgrade",
  );
  assert.equal(
    getComputerRowDotStatus({
      id: "legacy-online",
      status: "online",
      isComputer: false,
      computerUpgradeAvailable: true,
    }),
    "online",
  );
  assert.equal(
    getComputerRowDotStatus({
      id: "legacy-offline",
      status: "offline",
      isComputer: false,
      computerUpgradeAvailable: true,
    }),
    "offline",
  );

  // Raft DS: presence lights are fixed (online lime, offline stone); an
  // update waiting for you needs handling: the orange error light (pink is
  // only for unread / new).
  assert.deepEqual(getComputerRowDotLight("online"), { presence: "online" });
  assert.deepEqual(getComputerRowDotLight("upgrade"), { presence: "error" });
  assert.deepEqual(getComputerRowDotLight("offline"), { presence: "offline" });
});

test("offline plus upgrade keeps upgrade primary while preserving offline in the dot title", () => {
  assert.deepEqual(
    getComputerRowDotTitleDescriptor("upgrade", "offline", "0.0.50"),
    {
      id: "machine.attention.upgradeAvailableOfflineWithVersion",
      values: { version: "0.0.50" },
    },
  );
  assert.deepEqual(
    getComputerRowDotTitleDescriptor("upgrade", "offline"),
    { id: "machine.attention.upgradeAvailableOffline" },
  );
  assert.deepEqual(
    getComputerRowDotTitleDescriptor("upgrade", "online", "0.0.50"),
    {
      id: "machine.attention.upgradeAvailableWithVersion",
      values: { version: "0.0.50" },
    },
  );
});
