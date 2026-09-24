import { strict as assert } from "node:assert";
import { describe, test } from "vitest";

import {
  deriveComputerAffordances,
  deriveTrayHealth,
  deriveWorkspaceAffordanceState,
  getComputerActionConfirmation,
  semverGreater,
  type ComputerSurfaceAction,
  type WorkspaceAffordance,
} from "./affordances.js";
import { getComputerActionAvailability, type ComputerActionId } from "./actions.js";
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

const STATUS_CELLS: Array<{ name: string; report: ComputerStatusReport | null }> = [
  { name: "checking", report: null },
  { name: "signed-out", report: status({ loggedIn: false, userId: null, servers: [] }) },
  { name: "signed-in-empty", report: status({ servers: [] }) },
  {
    name: "online",
    report: status({
      servers: [server({ serverId: "online", health: "ok", daemon: { running: true, pid: 2 }, serverConnected: true })],
    }),
  },
  {
    name: "verifying",
    report: status({
      servers: [server({ serverId: "verifying", health: "ok", daemon: { running: true, pid: 3 }, serverConnected: false })],
    }),
  },
  {
    name: "degraded",
    report: status({
      servers: [server({ serverId: "degraded", health: "degraded", daemon: { running: true, pid: 4 } })],
    }),
  },
  {
    name: "offline",
    report: status({
      servers: [server({ serverId: "offline", health: "offline", daemon: { running: false } })],
    }),
  },
  {
    name: "unlinked",
    report: status({
      servers: [server({ serverId: "unlinked", health: "unlinked", daemon: { running: true, pid: 5 } })],
    }),
  },
];

const ACTION_AXES = [
  { latestVersion: null, inFlight: null },
  { latestVersion: "0.72.0", inFlight: null },
  { latestVersion: "0.73.0", inFlight: null },
  { latestVersion: "0.73.0", inFlight: "Restarting service..." },
] as const;

const MODEL_STATE_CELL_COUNT = STATUS_CELLS.length * ACTION_AXES.length;

describe("Computer affordance model", () => {
  test("model harness covers the expected status/action-axis cells", () => {
    assert.equal(STATUS_CELLS.length, 8);
    assert.equal(ACTION_AXES.length, 4);
    assert.equal(MODEL_STATE_CELL_COUNT, 32);
  });

  test("derives account, tray, and workspace state from the current status table", () => {
    const rows = new Map<string, {
      account: "checking" | "signed_out" | "signed_in";
      trayHealth: "ok" | "degraded" | "stopped";
      workspaceState: WorkspaceAffordance["state"] | null;
      primaryKind: ComputerSurfaceAction["kind"] | null;
    }>([
      ["checking", { account: "checking", trayHealth: "stopped", workspaceState: null, primaryKind: null }],
      ["signed-out", { account: "signed_out", trayHealth: "ok", workspaceState: null, primaryKind: null }],
      ["signed-in-empty", { account: "signed_in", trayHealth: "ok", workspaceState: null, primaryKind: null }],
      ["online", { account: "signed_in", trayHealth: "ok", workspaceState: "online", primaryKind: "open-computer" }],
      ["verifying", { account: "signed_in", trayHealth: "ok", workspaceState: "verifying", primaryKind: "connect-workspace" }],
      ["degraded", { account: "signed_in", trayHealth: "degraded", workspaceState: "needs_attention", primaryKind: "restart-runner" }],
      ["offline", { account: "signed_in", trayHealth: "ok", workspaceState: "offline", primaryKind: "start-service" }],
      ["unlinked", { account: "signed_in", trayHealth: "ok", workspaceState: "offline", primaryKind: null }],
    ]);

    for (const cell of STATUS_CELLS) {
      const expected = rows.get(cell.name);
      assert.ok(expected, `missing expected row for ${cell.name}`);
      const model = deriveComputerAffordances({
        status: cell.report,
        localVersion: "0.72.0",
        latestVersion: null,
        inFlight: null,
      });

      assert.equal(accountKind(model.account), expected.account, cell.name);
      assert.equal(model.trayHealth, expected.trayHealth, cell.name);
      assert.equal(model.workspaces[0]?.state ?? null, expected.workspaceState, cell.name);
      assert.equal(model.workspaces[0]?.primary?.kind ?? null, expected.primaryKind, cell.name);
    }
  });

  test("workspace-row-is-local: a degraded sibling only changes tray health", () => {
    const first = server({
      serverId: "first",
      serverSlug: "first",
      health: "ok",
      daemon: { running: true, pid: 10 },
      serverConnected: true,
    });
    const base = status({ servers: [first] });
    const withSibling = status({
      servers: [
        first,
        server({ serverId: "bad", serverSlug: "bad", health: "degraded", daemon: { running: true, pid: 11 } }),
      ],
    });

    const baseModel = deriveComputerAffordances({
      status: base,
      localVersion: "0.72.0",
      latestVersion: null,
      inFlight: null,
    });
    const siblingModel = deriveComputerAffordances({
      status: withSibling,
      localVersion: "0.72.0",
      latestVersion: null,
      inFlight: null,
    });

    assert.equal(baseModel.trayHealth, "ok");
    assert.equal(siblingModel.trayHealth, "degraded");
    assert.deepEqual(siblingModel.workspaces[0], baseModel.workspaces[0]);
  });

  test("shared-action-gate: in-flight blocks mutations but keeps bootstrap and browser affordances", () => {
    const report = status({
      servers: [server({ serverId: "bad", health: "degraded", daemon: { running: true, pid: 12 } })],
    });
    const model = deriveComputerAffordances({
      status: report,
      localVersion: "0.72.0",
      latestVersion: "0.73.0",
      inFlight: "Restarting service...",
    });

    const workspace = model.workspaces[0];
    assert.equal(workspace?.state, "needs_attention");
    assert.equal(workspace?.primary, null);
    assert.equal(model.blocked["restart-runner:bad"]?.reason, "in-flight");
    assert.deepEqual(model.blocked["restart-runner:bad"]?.action, {
      kind: "restart-runner",
      risk: "confirm",
      serverId: "bad",
    });
    assert.equal(model.blocked.upgrade?.reason, "in-flight");
    assert.deepEqual(model.blocked.upgrade?.action, {
      kind: "upgrade",
      risk: "confirm",
      targetVersion: "0.73.0",
    });
    assert.equal(model.globalActions.some((action) => action.kind === "upgrade"), false);
    assert.equal(workspace?.secondary.some((action) => action.kind === "open-computer"), true);
    assert.equal(model.globalActions.some((action) => action.kind === "connect-workspace"), true);
  });

  test("surface-projection-only: emitted actions are shared-gate-available and carry kernel-owned risk", () => {
    for (const cell of STATUS_CELLS) {
      for (const axis of ACTION_AXES) {
        const model = deriveComputerAffordances({
          status: cell.report,
          localVersion: "0.72.0",
          latestVersion: axis.latestVersion,
          inFlight: axis.inFlight,
        });
        const actions = [
          ...model.globalActions,
          ...model.workspaces.flatMap((workspace) => [
            workspace.primary,
            ...workspace.secondary,
          ]),
        ].filter((action): action is ComputerSurfaceAction => action !== null);

        for (const action of actions) {
          assert.ok(["safe", "confirm", "destructive"].includes(action.risk), `${cell.name}:${action.kind}`);
          assert.notEqual(action.risk, "destructive", "P1a must not emit destructive actions");
          const availability = getComputerActionAvailability(actionAvailabilityId(action), {
            status: cell.report,
            serverId: actionServerId(action),
            updateAvailable: action.kind === "upgrade",
            inFlight: axis.inFlight,
          });
          assert.equal(availability.available, true, `${cell.name}:${action.kind}`);
        }
      }
    }
  });

  test("status-preservation helpers keep current row and version semantics stable", () => {
    const okDisconnected = server({ serverId: "ok", health: "ok", daemon: { running: true, pid: 20 }, serverConnected: false });
    const okConnected = server({ serverId: "ok", health: "ok", daemon: { running: true, pid: 21 }, serverConnected: true });
    const degraded = server({ serverId: "bad", health: "degraded", daemon: { running: false } });

    assert.equal(deriveWorkspaceAffordanceState(okDisconnected), "verifying");
    assert.equal(deriveWorkspaceAffordanceState(okConnected), "online");
    assert.equal(deriveWorkspaceAffordanceState(degraded), "needs_attention");
    assert.equal(deriveTrayHealth(null), "stopped");
    assert.equal(deriveTrayHealth(status({ service: { running: false, logPath: "/tmp/service.log", version: VERSION_MISSING } })), "stopped");
    assert.equal(deriveTrayHealth(status({ servers: [degraded] })), "degraded");
    assert.equal(semverGreater("0.73.0", "0.72.9"), true);
    assert.equal(semverGreater("0.72.0-alpha", "0.72.0"), false);
  });

  test("status-preservation keeps the menu identity fallback glyph byte-exact", () => {
    const model = deriveComputerAffordances({
      status: status({
        userId: "user-123456789",
        userName: null,
        userDisplayName: null,
        userEmail: null,
      }),
      localVersion: "0.72.0",
      latestVersion: null,
      inFlight: null,
    });

    assert.deepEqual(model.account, { signedInAs: "user-123…" });
  });

  test("confirm-risk copy is shared and byte-exact for restart runner and upgrade", () => {
    assert.deepEqual(
      getComputerActionConfirmation({
        kind: "restart-runner",
        risk: "confirm",
        serverId: "12345678-1234-4123-8123-123456789abc",
      }),
      {
        message: "Restart this workspace runner?",
        detail:
          "Raft Desktop will restart the runner for server 12345678…. Agents on this workspace will briefly go offline until the connection recovers.",
      },
    );
    assert.deepEqual(
      getComputerActionConfirmation({
        kind: "upgrade",
        risk: "confirm",
        targetVersion: "0.73.0",
      }),
      {
        message: "Upgrade Raft Desktop to v0.73.0?",
        detail:
          "Raft Desktop will download and verify the update, replace the Computer binary, and restart its service. Connected workspaces may briefly go offline.",
      },
    );
  });

  test("future confirm actions receive a generic warning without a presenter allowlist", () => {
    assert.deepEqual(
      getComputerActionConfirmation({ kind: "run-doctor", risk: "safe" }),
      {
        message: "Confirm this Raft Desktop action?",
        detail: "Raft Desktop requires confirmation before running “run-doctor”.",
      },
    );
  });
});

function accountKind(account: ReturnType<typeof deriveComputerAffordances>["account"]): "checking" | "signed_out" | "signed_in" {
  if (account === "checking" || account === "signed_out") return account;
  return "signed_in";
}

function actionAvailabilityId(action: ComputerSurfaceAction): ComputerActionId {
  switch (action.kind) {
    case "open-computer":
      return "openUrl";
    case "login":
      return "login";
    case "sign-out":
      return "signOut";
    case "connect-workspace":
      return "connectWorkspace";
    case "start-service":
      return "startService";
    case "restart-service":
      return "restartService";
    case "restart-runner":
      return "restartRunner";
    case "upgrade":
      return "upgrade";
    case "run-doctor":
      return "runDoctor";
    case "diagnostics-push":
      return "diagnosticsPush";
    case "view-log":
      return "viewLog";
    case "toggle-launch-at-login":
      return "toggleLaunchAtLogin";
    case "quit-app":
      return "quitApp";
  }
}

function actionServerId(action: ComputerSurfaceAction): string | null {
  switch (action.kind) {
    case "connect-workspace":
    case "start-service":
    case "restart-runner":
    case "open-computer":
      return action.serverId ?? null;
    case "login":
    case "sign-out":
    case "restart-service":
    case "upgrade":
    case "run-doctor":
    case "diagnostics-push":
    case "view-log":
    case "toggle-launch-at-login":
    case "quit-app":
      return null;
  }
}
