import assert from "node:assert/strict";
import { computerUpgradeHints } from "../src/components/machine/computerUpgradeHints";
import type { MachineUpgradeRequest } from "../src/store/machineStore";

const failed = (failureHint: MachineUpgradeRequest["failureHint"], extra: Partial<MachineUpgradeRequest> = {}): MachineUpgradeRequest => ({
  id: "req-1",
  targetVersion: "1.25.4",
  requestedAt: "2026-11-15T12:00:00.000Z",
  state: "failed",
  observedVersion: "1.25.3",
  reason: "x",
  resolvedAt: "2026-11-15T12:01:00.000Z",
  failureHint,
  ...extra,
});
const hints = (upgradeRequest: MachineUpgradeRequest | null, overrides: Partial<Parameters<typeof computerUpgradeHints>[0]> = {}) =>
  computerUpgradeHints({ oneClick: true, upgradeRequest, computerVersion: "1.25.3", installerRepairHint: false, ...overrides });

test("earlier_recovery_pending shows the repair banner, not the systemd-unit steps", () => {
  assert.deepEqual(hints(failed({ reason: "earlier_recovery_pending" })), { upgradeFailureHint: null, recommendRepair: true });
});

test("a systemd-unit failure shows its steps; the installer state's repair hint is kept beside it", () => {
  const unit = { reason: "installation_held", unit: "raft-computer.service", scope: "user" } as const;
  assert.deepEqual(hints(failed(unit)), { upgradeFailureHint: unit, recommendRepair: false });
  assert.deepEqual(hints(failed(unit), { installerRepairHint: true }), { upgradeFailureHint: unit, recommendRepair: true });
});

test("the failure's advice clears once the Computer's version changes or a newer request replaces it", () => {
  const earlier = failed({ reason: "earlier_recovery_pending" });
  // Repaired by hand onto the target, or onto another version than the one it failed on.
  assert.deepEqual(hints(earlier, { computerVersion: "1.25.4" }), { upgradeFailureHint: null, recommendRepair: false });
  assert.deepEqual(hints(earlier, { computerVersion: "1.25.3-rc.2" }), { upgradeFailureHint: null, recommendRepair: false });
  // A newer request is the latest: open, or failed for another reason.
  assert.deepEqual(hints(failed({ reason: "earlier_recovery_pending" }, { id: "req-2", state: "pending" })), { upgradeFailureHint: null, recommendRepair: false });
  assert.deepEqual(hints(failed(null, { id: "req-2" })), { upgradeFailureHint: null, recommendRepair: false });
  // The installer state's own hint still stands on its own.
  assert.deepEqual(hints(failed(null, { id: "req-2" }), { installerRepairHint: true }), { upgradeFailureHint: null, recommendRepair: true });
});

test("nothing is recommended where no one-click Upgrade is offered", () => {
  assert.deepEqual(hints(failed({ reason: "earlier_recovery_pending" }), { oneClick: false, installerRepairHint: true }), { upgradeFailureHint: null, recommendRepair: false });
});
