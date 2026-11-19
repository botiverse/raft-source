import assert from "node:assert/strict";
import {
  computerUpgradeInstallerReportOfError,
  computerUpgradeInstallerReportOfReceipt,
  parseComputerUpgradeInstallerReport,
  withComputerUpgradeInstallerReport,
} from "./index";

test("the installer report keeps a closed outcome and code-shaped tokens; anything else is dropped", () => {
  assert.deepEqual(
    parseComputerUpgradeInstallerReport({ installerOutcome: "failed", installerCode: "install_failed", installerDiagnosticCode: "DOWNLOAD_FAILED" }),
    { installerOutcome: "failed", installerCode: "install_failed", installerDiagnosticCode: "DOWNLOAD_FAILED" },
  );
  // Absent or unknown outcome: no report at all (an older Computer).
  assert.equal(parseComputerUpgradeInstallerReport({}), null);
  assert.equal(parseComputerUpgradeInstallerReport(null), null);
  assert.equal(parseComputerUpgradeInstallerReport({ installerOutcome: "promoted", installerCode: "install_failed" }), null);
  assert.equal(parseComputerUpgradeInstallerReport({ installerOutcome: "rolled-back" }), null);
  assert.equal(parseComputerUpgradeInstallerReport({ installerOutcome: ["failed"] }), null);
  // Codes that are text, the wrong case, too long or not strings are left out.
  for (const installerCode of ["release_resolution_failed: no", "RELEASE_RESOLUTION_FAILED", "a".repeat(65), "", 7, null]) {
    assert.deepEqual(parseComputerUpgradeInstallerReport({ installerOutcome: "failed", installerCode }), { installerOutcome: "failed" }, JSON.stringify(installerCode));
  }
  for (const installerDiagnosticCode of ["DOWNLOAD_FAILED: idle timeout", "download_failed", "A".repeat(65), {}]) {
    assert.deepEqual(parseComputerUpgradeInstallerReport({ installerOutcome: "held", installerDiagnosticCode }), { installerOutcome: "held" }, JSON.stringify(installerDiagnosticCode));
  }
});

test("the installer report from a ready receipt needs the receipt's code; from an error, it rides on the error", () => {
  assert.deepEqual(
    computerUpgradeInstallerReportOfReceipt({ targetVersion: "1.0.60", outcome: "failed", reason: "x", code: "release_resolution_failed" }),
    { installerOutcome: "failed", installerCode: "release_resolution_failed" },
  );
  assert.equal(computerUpgradeInstallerReportOfReceipt({ targetVersion: "1.0.60", outcome: "failed", reason: "DOWNLOAD_FAILED: x" }), null);
  assert.equal(computerUpgradeInstallerReportOfReceipt({ targetVersion: "1.0.60", outcome: "promoted", code: "install_failed" }), null);

  const error = withComputerUpgradeInstallerReport(new Error("UPGRADE_INSTALLER_FAILED: x"), { installerOutcome: "unresolved", installerCode: "recovery_unresolved" });
  assert.equal(error.message, "UPGRADE_INSTALLER_FAILED: x");
  assert.deepEqual(computerUpgradeInstallerReportOfError(error), { installerOutcome: "unresolved", installerCode: "recovery_unresolved" });
  assert.equal(computerUpgradeInstallerReportOfError(new Error("plain")), null);
  assert.equal(computerUpgradeInstallerReportOfError("UPGRADE_INSTALLER_FAILED: x"), null);
  assert.equal(computerUpgradeInstallerReportOfError(Object.assign(new Error("x"), { computerUpgradeInstallerReport: { installerOutcome: "anything" } })), null);
});
