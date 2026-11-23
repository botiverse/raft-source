import assert from "node:assert/strict";

import { runtimeInstallCopy, runtimeInstallRefusal } from "../runtimeInstallCopy";
import { runtimeUpgradeCopy, runtimeUpgradeRefusal } from "../runtimeUpgradeOutcomeCopy";

// The upgrade and install routes limit presses per person and Computer and
// answer 429 rate_limited past it; the web read that as "Couldn't upgrade.
// Try again.", which pressing again can't fix for minutes (#triage
// msg=83dd24b2). Each refusal the server names gets its own sentence;
// anything else stays the generic one.
test("the server's refusal codes each read as their own sentence; an unknown one is the generic error", () => {
  const cases: Array<[string | null, string]> = [
    ["rate_limited", "machine.runtimeAuth.provider.error.rateLimited"],
    ["computer_timeout", "machine.runtimeUpgrade.timeout"],
    ["computer_offline", "machine.runtimeUpgrade.computerOffline"],
    ["computer_upgrade_required", "machine.runtimeUpgrade.computerTooOld"],
    ["runtime_not_upgradable", "machine.runtimeUpgrade.error"],
    [null, "machine.runtimeUpgrade.error"],
  ];
  for (const [code, id] of cases) {
    const copy = runtimeUpgradeCopy({ kind: "refused", reason: runtimeUpgradeRefusal(code) });
    assert.deepEqual(copy, { id, tone: "warning" }, String(code));
  }
});

test("Install reads a rate-limited press the same way; its other refusals keep their sentences", () => {
  const cases: Array<[string | null, string]> = [
    ["rate_limited", "machine.runtimeAuth.provider.error.rateLimited"],
    ["computer_timeout", "machine.runtimeInstall.timeout"],
    ["runtime_not_installable", "machine.runtimeInstall.error"],
  ];
  for (const [code, id] of cases) {
    const copy = runtimeInstallCopy({ kind: "refused", runtime: "claude", reason: runtimeInstallRefusal(code) });
    assert.deepEqual(copy, { id, tone: "warning" }, String(code));
  }
});
