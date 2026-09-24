import { strict as assert } from "node:assert";
import { describe, test } from "vitest";

import {
  COMPUTER_ACTION_DESCRIPTORS,
  getComputerActionAvailability,
  getComputerActionAvailabilityMap,
} from "./actions.js";
import type { ComputerStatusReport, ServerStatusRow } from "./index.js";

const VERSION_MISSING = {
  version: null,
  evidencePath: "/tmp/version.json",
  evidencePid: null,
  evidenceWrittenAt: null,
    shellEnvironment: null,
};

function server(partial: Partial<ServerStatusRow> & Pick<ServerStatusRow, "serverId">): ServerStatusRow {
  return {
    serverId: partial.serverId,
    serverSlug: partial.serverSlug ?? "alpha",
    serverMachineId: partial.serverMachineId ?? "cm-" + partial.serverId,
    machineId: partial.machineId ?? "machine-" + partial.serverId,
    serverUrl: partial.serverUrl ?? "https://api.example.test",
    attachedAt: partial.attachedAt ?? null,
    serverRunnerLogPath: partial.serverRunnerLogPath ?? "/tmp/runner.log",
    runnerVersion: partial.runnerVersion ?? VERSION_MISSING,
    daemon: partial.daemon ?? { running: false },
    health: partial.health ?? "ok",
    serverConnected: partial.serverConnected ?? false,
  };
}

function status(partial: Partial<ComputerStatusReport> = {}): ComputerStatusReport {
  return {
    slockHome: partial.slockHome ?? "/tmp/test",
    cliVersion: partial.cliVersion ?? "0.0.0-test",
    loggedIn: partial.loggedIn ?? true,
    userId: partial.userId ?? "user-a",
    userName: partial.userName ?? null,
    userDisplayName: partial.userDisplayName ?? null,
    userEmail: partial.userEmail ?? null,
    loginServerUrl: partial.loginServerUrl ?? "https://api.example.test",
    userSessionError: partial.userSessionError ?? null,
    service: partial.service ?? {
      running: true,
      pid: 1,
      logPath: "/tmp/service.log",
      version: VERSION_MISSING,
    },
    upgrade: partial.upgrade ?? null,
    hostLifecycle: partial.hostLifecycle ?? null,
    servers: partial.servers ?? [],
  };
}

describe("Computer action availability model", () => {
  test("descriptors classify steady-state service-dispatch mutations separately from bootstrap exceptions", () => {
    assert.equal(COMPUTER_ACTION_DESCRIPTORS.restartRunner.route, "service-dispatch");
    assert.equal(COMPUTER_ACTION_DESCRIPTORS.restartRunner.steadyStateMutation, true);
    assert.equal(COMPUTER_ACTION_DESCRIPTORS.connectWorkspace.route, "bootstrap");
    assert.equal(COMPUTER_ACTION_DESCRIPTORS.connectWorkspace.bootstrapException, true);
  });

  test("restartRunner is available only for the targeted degraded server", () => {
    const report = status({
      servers: [
        server({ serverId: "ok", health: "ok", daemon: { running: true, pid: 1 }, serverConnected: true }),
        server({ serverId: "bad", health: "degraded", daemon: { running: true, pid: 2 } }),
      ],
    });

    assert.equal(
      getComputerActionAvailability("restartRunner", { status: report, serverId: "bad" }).available,
      true,
    );
    assert.equal(
      getComputerActionAvailability("restartRunner", { status: report, serverId: "ok" }).reason,
      "server-not-degraded",
    );
    assert.equal(
      getComputerActionAvailability("restartRunner", { status: report, serverId: "missing" }).reason,
      "server-missing",
    );
  });

  test("in-flight state rejects steady-state mutations but keeps bootstrap/navigation available", () => {
    const map = getComputerActionAvailabilityMap({
      status: status(),
      updateAvailable: true,
      inFlight: "Restarting service...",
    });

    assert.equal(map.restartService.reason, "in-flight");
    assert.equal(map.upgrade.reason, "in-flight");
    assert.equal(map.connectWorkspace.available, true);
    assert.equal(map.openUrl.available, true);
  });

  test("upgrade availability is driven by the shared update flag", () => {
    assert.equal(
      getComputerActionAvailability("upgrade", { status: status(), updateAvailable: false }).reason,
      "update-unavailable",
    );
    assert.equal(
      getComputerActionAvailability("upgrade", { status: status(), updateAvailable: true }).available,
      true,
    );
  });
});
