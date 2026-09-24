import { strict as assert } from "node:assert";
import { describe, test } from "node:test";

import {
  aggregateHealth,
  actionInvocationForMenuItem,
  buildMenuModel,
  crashSummary,
  deriveWorkspaceState,
  semverGreater,
  trayIconBasename,
  type AppState,
  type MenuItem,
  type MenuNode,
  type RolledUpHealth,
} from "./menuModel.js";
import { buildLegacyMenuModelForEquivalence } from "./menuModelLegacy.testHelper.js";

function asItem(node: MenuNode | undefined): MenuItem {
  assert.ok(node, "expected a menu node");
  assert.ok(!node.separator, "expected a menu item, got a separator");
  return node;
}

function isServerRow(n: MenuNode): n is MenuItem {
  return !n.separator && n.submenu !== undefined && /^[•◦*] /.test(n.label);
}
import type { ComputerStatusReport, ServerStatusRow } from "@botiverse/raft-computer/lib";

const DEPS = { localVersion: "0.0.59", dashboardUrl: "https://app.slock.ai" };
const VERSION_MISSING = {
  version: null,
  evidencePath: "/tmp/version.json",
  evidencePid: null,
  evidenceWrittenAt: null,
    shellEnvironment: null,
};

function makeServer(partial: Partial<ServerStatusRow> & Pick<ServerStatusRow, "serverId">): ServerStatusRow {
  return {
    serverId: partial.serverId,
    serverSlug: partial.serverSlug ?? "alpha",
    serverMachineId: partial.serverMachineId ?? "cm-" + partial.serverId,
    machineId: partial.machineId === undefined ? "machine-" + partial.serverId : partial.machineId,
    serverUrl: partial.serverUrl ?? "https://api.example.test",
    attachedAt: partial.attachedAt ?? null,
    serverRunnerLogPath: partial.serverRunnerLogPath ?? "/tmp/runner.log",
    runnerVersion: partial.runnerVersion ?? VERSION_MISSING,
    daemon: partial.daemon ?? { running: false },
    health: partial.health ?? "ok",
    serverConnected: partial.serverConnected ?? false,
  };
}

type StatusOverride = Omit<Partial<ComputerStatusReport>, "service"> & {
  service?: Partial<ComputerStatusReport["service"]>;
};

function makeService(partial: Partial<ComputerStatusReport["service"]> | undefined): ComputerStatusReport["service"] {
  const base = {
    logPath: partial?.logPath ?? "/tmp/svc.log",
    version: partial?.version ?? VERSION_MISSING,
  };
  return partial?.running ? { ...base, running: true, pid: partial.pid ?? 1 } : { ...base, running: false };
}

function makeStatus(partial: StatusOverride): ComputerStatusReport {
  return {
    slockHome: partial.slockHome ?? "/tmp/test",
    cliVersion: partial.cliVersion ?? "0.0.59",
    loggedIn: partial.loggedIn ?? false,
    userId: partial.userId ?? null,
    userName: partial.userName ?? null,
    userDisplayName: partial.userDisplayName ?? null,
    userEmail: partial.userEmail ?? null,
    loginServerUrl: partial.loginServerUrl ?? null,
    userSessionError: partial.userSessionError ?? null,
    service: makeService(partial.service),
    upgrade: partial.upgrade ?? null,
    hostLifecycle: partial.hostLifecycle ?? null,
    servers: partial.servers ?? [],
  };
}

function makeState(partial: Partial<AppState> = {}): AppState {
  return {
    status: partial.status ?? null,
    latestVersion: partial.latestVersion ?? null,
    inFlight: partial.inFlight ?? null,
    serverCrashReasons: partial.serverCrashReasons ?? {},
    launchAtLogin: partial.launchAtLogin ?? false,
  };
}

const P1B_STATUS_CELLS: Array<{ name: string; report: ComputerStatusReport | null }> = [
  { name: "checking", report: null },
  { name: "signed-out", report: makeStatus({ loggedIn: false, userId: null, servers: [] }) },
  { name: "signed-in-empty", report: makeStatus({ loggedIn: true, userId: "user-a", servers: [] }) },
  {
    name: "online",
    report: makeStatus({
      loggedIn: true,
      userId: "user-a",
      servers: [makeServer({ serverId: "online", health: "ok", serverConnected: true, daemon: { running: true, pid: 2 } })],
    }),
  },
  {
    name: "verifying",
    report: makeStatus({
      loggedIn: true,
      userId: "user-a",
      servers: [makeServer({ serverId: "verifying", health: "ok", serverConnected: false, daemon: { running: true, pid: 3 } })],
    }),
  },
  {
    name: "degraded",
    report: makeStatus({
      loggedIn: true,
      userId: "user-a",
      servers: [makeServer({ serverId: "degraded", health: "degraded", serverConnected: false, daemon: { running: true, pid: 4 } })],
    }),
  },
  {
    name: "offline",
    report: makeStatus({
      loggedIn: true,
      userId: "user-a",
      servers: [makeServer({ serverId: "offline", health: "offline", serverConnected: false, daemon: { running: false } })],
    }),
  },
  {
    name: "unlinked",
    report: makeStatus({
      loggedIn: true,
      userId: "user-a",
      servers: [makeServer({ serverId: "unlinked", health: "unlinked", serverConnected: false, daemon: { running: true, pid: 5 } })],
    }),
  },
];

const P1B_ACTION_AXES = [
  { name: "no-latest", latestVersion: null, inFlight: null, launchAtLogin: false },
  { name: "same-version", latestVersion: "0.0.59", inFlight: null, launchAtLogin: true },
  { name: "upgrade-ready", latestVersion: "0.0.60", inFlight: null, launchAtLogin: false },
  { name: "upgrade-busy", latestVersion: "0.0.60", inFlight: "Restarting service…", launchAtLogin: true },
] as const;

function legacyCompatibilityShape(nodes: MenuNode[]): unknown[] {
  return nodes.map((node) => {
    if (node.separator) return { separator: true };
    return {
      label: node.label,
      ...(node.enabled === undefined ? {} : { enabled: node.enabled }),
      ...(node.click === undefined ? {} : { click: node.click }),
      ...(node.submenu === undefined ? {} : { submenu: legacyCompatibilityShape(node.submenu) }),
      ...(node.role === undefined ? {} : { role: node.role }),
      ...(node.checked === undefined ? {} : { checked: node.checked }),
    };
  });
}

// --- semverGreater (unchanged) ---

describe("semverGreater", () => {
  test("returns true on patch / minor / major bump", () => {
    assert.equal(semverGreater("0.0.59", "0.0.58"), true);
    assert.equal(semverGreater("0.1.0", "0.0.59"), true);
    assert.equal(semverGreater("1.0.0", "0.99.99"), true);
  });
  test("returns false on equal or smaller", () => {
    assert.equal(semverGreater("0.0.59", "0.0.59"), false);
    assert.equal(semverGreater("0.0.58", "0.0.59"), false);
  });
  test("returns false on malformed input", () => {
    assert.equal(semverGreater("v0.0.59", "0.0.58"), false);
    assert.equal(semverGreater("not-semver", "0.0.58"), false);
    assert.equal(semverGreater("0.0.59-pre", "0.0.58"), false);
  });
});

// --- aggregateHealth (unchanged) ---

describe("aggregateHealth", () => {
  test("null status → stopped", () => {
    assert.equal(aggregateHealth(null), "stopped");
  });
  test("running service + no servers → ok", () => {
    assert.equal(
      aggregateHealth(makeStatus({ service: { running: true, pid: 1, logPath: "" } })),
      "ok",
    );
  });
  test("any runner degraded → degraded (worst-of)", () => {
    const status = makeStatus({
      service: { running: true, pid: 1, logPath: "" },
      servers: [
        makeServer({ serverId: "a-degraded", health: "degraded" }),
        makeServer({ serverId: "b-ok", health: "ok" }),
      ],
    });
    assert.equal(aggregateHealth(status), "degraded");
  });
  test("service stopped, no degraded runners → stopped", () => {
    assert.equal(
      aggregateHealth(
        makeStatus({
          service: { running: false, logPath: "" },
          servers: [makeServer({ serverId: "a", health: "offline" })],
        }),
      ),
      "stopped",
    );
  });
  test("running service + offline (not degraded) runner → ok", () => {
    assert.equal(
      aggregateHealth(
        makeStatus({
          service: { running: true, pid: 1, logPath: "" },
          servers: [makeServer({ serverId: "a", health: "offline" })],
        }),
      ),
      "ok",
    );
  });
  test("degraded runner wins even over a stopped service", () => {
    assert.equal(
      aggregateHealth(
        makeStatus({
          service: { running: false, logPath: "" },
          servers: [makeServer({ serverId: "a", health: "degraded" })],
        }),
      ),
      "degraded",
    );
  });
});

// --- crashSummary (unchanged) ---

describe("crashSummary", () => {
  const FT = (_iso: string) => "T";
  test("empty / undefined history → 'no recorded crash'", () => {
    assert.equal(crashSummary([], FT), "no recorded crash");
    assert.equal(crashSummary(undefined, FT), "no recorded crash");
  });
  test("uses the MOST RECENT crash (last element)", () => {
    assert.equal(
      crashSummary(
        [
          { at: "2026-06-20T00:00:00Z", exitCode: 1, signal: null },
          { at: "2026-06-20T01:00:00Z", exitCode: null, signal: "SIGKILL" },
        ],
        FT,
      ),
      "SIGKILL (T)",
    );
  });
  test("prefers signal over exit code", () => {
    assert.equal(crashSummary([{ at: "x", exitCode: 137, signal: "SIGKILL" }], FT), "SIGKILL (T)");
  });
  test("falls back to 'exit <code>'", () => {
    assert.equal(crashSummary([{ at: "x", exitCode: 1, signal: null }], FT), "exit 1 (T)");
  });
  test("falls back to 'exit ?'", () => {
    assert.equal(crashSummary([{ at: "x", exitCode: null, signal: null }], FT), "exit ? (T)");
  });
});

// --- trayIconBasename (unchanged) ---

describe("trayIconBasename", () => {
  test("ok → iconTemplate.png, template", () => {
    assert.deepEqual(trayIconBasename("ok"), { basename: "iconTemplate.png", isTemplate: true });
  });
  test("degraded → iconAttentionTemplate.png, template", () => {
    assert.deepEqual(trayIconBasename("degraded"), { basename: "iconAttentionTemplate.png", isTemplate: true });
  });
  test("stopped → iconDimmedTemplate.png, template", () => {
    assert.deepEqual(trayIconBasename("stopped"), { basename: "iconDimmedTemplate.png", isTemplate: true });
  });
  test("all variants are template images", () => {
    const all: RolledUpHealth[] = ["ok", "degraded", "stopped"];
    const nonTemplate = all.filter((h) => !trayIconBasename(h).isTemplate);
    assert.deepEqual(nonTemplate, []);
  });
  test("each health maps to a distinct basename", () => {
    const all: RolledUpHealth[] = ["ok", "degraded", "stopped"];
    const basenames = all.map((h) => trayIconBasename(h).basename);
    assert.equal(new Set(basenames).size, all.length);
  });
});

// --- deriveWorkspaceState (v14 per-workspace derivation) ---

describe("deriveWorkspaceState", () => {
  test("health=ok + serverConnected=true → online", () => {
    assert.equal(
      deriveWorkspaceState(makeServer({ serverId: "a", health: "ok", serverConnected: true, daemon: { running: true, pid: 1 } })),
      "online",
    );
  });

  test("health=degraded → needs-attention (regardless of serverConnected)", () => {
    assert.equal(
      deriveWorkspaceState(makeServer({ serverId: "a", health: "degraded", serverConnected: false })),
      "needs-attention",
    );
    assert.equal(
      deriveWorkspaceState(makeServer({ serverId: "a", health: "degraded", serverConnected: true })),
      "needs-attention",
    );
  });

  test("health=ok + !serverConnected → verifying (runner up, not yet connected)", () => {
    assert.equal(
      deriveWorkspaceState(makeServer({ serverId: "a", health: "ok", serverConnected: false, daemon: { running: true, pid: 1 } })),
      "verifying",
    );
  });

  test("health=offline → offline", () => {
    assert.equal(
      deriveWorkspaceState(makeServer({ serverId: "a", health: "offline", serverConnected: false })),
      "offline",
    );
  });

  test("fatalConfig degraded stays at needs-attention (lib isDegraded sticky)", () => {
    // fatalConfig sets health=degraded in the lib's deriveHealth — the menu model
    // just sees health=degraded and maps to needs-attention. This test pins that
    // the menu model doesn't try to override or decay it.
    assert.equal(
      deriveWorkspaceState(makeServer({ serverId: "a", health: "degraded", serverConnected: false, daemon: { running: false } })),
      "needs-attention",
    );
  });
});

// --- trayIconBasename ∘ aggregateHealth (end-to-end) ---

describe("trayIconBasename ∘ aggregateHealth", () => {
  test("null status → dimmed", () => {
    assert.deepEqual(trayIconBasename(aggregateHealth(null)), {
      basename: "iconDimmedTemplate.png",
      isTemplate: true,
    });
  });
  test("running service, all ok → ok icon", () => {
    const status = makeStatus({
      service: { running: true, pid: 1, logPath: "" },
      servers: [makeServer({ serverId: "a", health: "ok" })],
    });
    assert.deepEqual(trayIconBasename(aggregateHealth(status)), {
      basename: "iconTemplate.png",
      isTemplate: true,
    });
  });
  test("one runner degraded → attention icon", () => {
    const status = makeStatus({
      service: { running: true, pid: 1, logPath: "" },
      servers: [
        makeServer({ serverId: "a", health: "ok" }),
        makeServer({ serverId: "b", health: "degraded" }),
      ],
    });
    assert.deepEqual(trayIconBasename(aggregateHealth(status)), {
      basename: "iconAttentionTemplate.png",
      isTemplate: true,
    });
  });
  test("stopped service, runners offline → dimmed", () => {
    const status = makeStatus({
      service: { running: false, logPath: "" },
      servers: [makeServer({ serverId: "a", health: "offline" })],
    });
    assert.deepEqual(trayIconBasename(aggregateHealth(status)), {
      basename: "iconDimmedTemplate.png",
      isTemplate: true,
    });
  });
});

describe("account identity label (task #112)", () => {
  const labelFor = (over: StatusOverride): string => {
    const status = makeStatus({ loggedIn: true, userId: "user-12345-abcd", ...over });
    const tree = buildMenuModel(makeState({ status }), DEPS);
    const accountIdx = tree.findIndex((n) => !n.separator && n.label === "Account");
    const identityNode = asItem(tree[accountIdx + 1]);
    return identityNode.label;
  };

  test("prefers displayName when present", () => {
    assert.equal(labelFor({ userDisplayName: "Cindy", userName: "cindy zhao", userEmail: "c@x.io" }), "Cindy");
  });
  test("falls back to name when no displayName", () => {
    assert.equal(labelFor({ userDisplayName: null, userName: "cindy zhao", userEmail: "c@x.io" }), "cindy zhao");
  });
  test("falls back to email when no displayName/name", () => {
    assert.equal(labelFor({ userDisplayName: null, userName: null, userEmail: "c@x.io" }), "c@x.io");
  });
  test("falls back to short user-id when no identity fields (older session / offline /me)", () => {
    assert.equal(labelFor({ userDisplayName: null, userName: null, userEmail: null }), "user-123…");
  });
  test("signed-in identity has submenu with Sign out", () => {
    const status = makeStatus({ loggedIn: true, userId: "u", userDisplayName: "Alice" });
    const tree = buildMenuModel(makeState({ status }), DEPS);
    const accountIdx = tree.findIndex((n) => !n.separator && n.label === "Account");
    const identityNode = asItem(tree[accountIdx + 1]);
    assert.ok(identityNode.submenu, "identity row should have a submenu");
    assert.equal(asItem(identityNode.submenu![0]).label, "Sign out");
    assert.deepEqual(asItem(identityNode.submenu![0]).click, { kind: "signOut" });
  });
});

// --- buildMenuModel (v14 IA) ---

describe("buildMenuModel", () => {
  test("P1b projector preserves the frozen legacy menu structure across all 32 affordance cells", () => {
    let compared = 0;
    const mismatches: Array<{ cell: string; projected: unknown[]; legacy: unknown[] }> = [];
    for (const statusCell of P1B_STATUS_CELLS) {
      for (const actionAxis of P1B_ACTION_AXES) {
        const state = makeState({
          status: statusCell.report,
          latestVersion: actionAxis.latestVersion,
          inFlight: actionAxis.inFlight,
          launchAtLogin: actionAxis.launchAtLogin,
        });
        const legacy = legacyCompatibilityShape(buildLegacyMenuModelForEquivalence(state, DEPS));
        const projected = legacyCompatibilityShape(buildMenuModel(state, DEPS));
        if (JSON.stringify(projected) !== JSON.stringify(legacy)) {
          mismatches.push({ cell: `${statusCell.name}:${actionAxis.name}`, projected, legacy });
        }
        compared += 1;
      }
    }
    assert.equal(compared, 32);
    assert.equal(mismatches.length, 1, "31 of 32 cells must remain canonical-byte equivalent");
    assert.equal(mismatches[0]?.cell, "checking:upgrade-busy");

    // Approved P1b honesty correction (#wg-raft-computer:ef54f6b1, msg ed93a412):
    // the legacy checking fast-path drew Quit as clickable while actionRunner's
    // shared runtime gate rejected the same in-flight mutation. The projector
    // now keeps the visual and execution contracts aligned.
    const checkingBusy = buildMenuModel(
      makeState({
        status: null,
        latestVersion: "0.0.60",
        inFlight: "Restarting service…",
        launchAtLogin: true,
      }),
      DEPS,
    );
    const quit = asItem(checkingBusy.find((node) => !node.separator && node.label === "Quit Raft Desktop"));
    assert.deepEqual(quit, {
      label: "Quit Raft Desktop",
      risk: "confirm",
      enabled: false,
      unavailableReason: "Another Raft Desktop action is already running: Restarting service…",
    });
  });

  test("P1b carries kernel risk and honest unavailable reasons without changing action behavior", () => {
    const status = makeStatus({
      loggedIn: true,
      userId: "u",
      service: { running: true, pid: 1, logPath: "/tmp/svc.log" },
      servers: [makeServer({
        serverId: "a",
        serverSlug: "botiverse",
        health: "degraded",
        serverConnected: false,
        daemon: { running: true, pid: 2 },
      })],
    });
    const tree = buildMenuModel(
      makeState({ status, latestVersion: "0.0.60", inFlight: "Restarting service…" }),
      DEPS,
    );

    const row = asItem(tree.find(isServerRow));
    const recover = asItem(row.submenu!.find((node) => !node.separator && node.label === "Recover connection"));
    assert.equal(recover.risk, "confirm");
    assert.equal(recover.confirmation, undefined);
    assert.equal(recover.enabled, false);
    assert.match(recover.unavailableReason ?? "", /already running/i);
    assert.equal(recover.click, undefined, "P1b must not bypass a blocked affordance");

    const open = asItem(row.submenu!.find((node) => !node.separator && node.label === "Open workspace"));
    assert.equal(open.risk, "safe");
    assert.equal(open.confirmation, undefined);
    assert.deepEqual(open.click, {
      kind: "openUrl",
      url: "https://app.slock.ai/s/botiverse/computer/machine-a",
    });

    const update = asItem(tree.find((node) => !node.separator && node.label.startsWith("Update available")));
    assert.equal(update.risk, "confirm");
    assert.equal(update.confirmation, undefined);
    assert.equal(update.enabled, false);
    assert.match(update.unavailableReason ?? "", /already running/i);

    const quit = asItem(tree.find((node) => !node.separator && node.label === "Quit Raft Desktop"));
    assert.equal(quit.risk, "confirm");
    assert.equal(quit.confirmation, undefined);
    assert.equal(quit.enabled, false);
    assert.match(quit.unavailableReason ?? "", /already running/i);

    const accountHeader = asItem(tree.find((node) => !node.separator && node.label === "Account"));
    assert.equal(accountHeader.unavailableReason, undefined, "structural info rows must not invent action reasons");
  });

  test("P1c projected confirm actions carry exact shared copy", () => {
    const status = makeStatus({
      loggedIn: true,
      userId: "u",
      service: { running: true, pid: 1, logPath: "/tmp/svc.log" },
      servers: [makeServer({
        serverId: "12345678-1234-4123-8123-123456789abc",
        serverSlug: "botiverse",
        health: "degraded",
        serverConnected: false,
        daemon: { running: true, pid: 2 },
      })],
    });
    const tree = buildMenuModel(makeState({ status, latestVersion: "0.0.60" }), DEPS);
    const row = asItem(tree.find(isServerRow));
    const recover = asItem(row.submenu!.find((node) => !node.separator && node.label === "Recover connection"));
    assert.deepEqual(recover.confirmation, {
      message: "Restart this workspace runner?",
      detail:
        "Raft Desktop will restart the runner for server 12345678…. Agents on this workspace will briefly go offline until the connection recovers.",
    });

    const update = asItem(tree.find((node) => !node.separator && node.label.startsWith("Update available")));
    assert.deepEqual(update.confirmation, {
      message: "Upgrade Raft Desktop to v0.0.60?",
      detail:
        "Raft Desktop will download and verify the update, replace the Computer binary, and restart its service. Connected workspaces may briefly go offline.",
    });

    const quit = asItem(tree.find((node) => !node.separator && node.label === "Quit Raft Desktop"));
    assert.deepEqual(quit.confirmation, {
      message: "Quit Raft Desktop?",
      detail: "Your connected workspaces will go offline on this Computer until you open Raft Desktop again.",
    });
  });

  test("P1c invocation adapter consumes menu risk and fails closed on incomplete metadata", () => {
    const safeAction = { kind: "openUrl", url: "https://example.test" } as const;
    assert.deepEqual(
      actionInvocationForMenuItem({ label: "Open", click: safeAction, risk: "safe" }, safeAction),
      { action: safeAction, risk: "safe" },
    );

    const confirmAction = { kind: "upgrade", targetVersion: "0.73.0" } as const;
    const confirmation = {
      message: "Upgrade Raft Desktop to v0.73.0?",
      detail: "Pinned detail",
    };
    assert.deepEqual(
      actionInvocationForMenuItem(
        { label: "Upgrade", click: confirmAction, risk: "confirm", confirmation },
        confirmAction,
      ),
      { action: confirmAction, risk: "confirm", confirmation },
    );

    assert.deepEqual(
      actionInvocationForMenuItem(
        { label: "Incomplete", click: confirmAction, risk: "confirm" },
        confirmAction,
      ),
      { action: confirmAction, risk: "destructive" },
    );
  });

  test("null status → minimal menu with 'Checking status…' + version + quit", () => {
    const tree = buildMenuModel(makeState(), DEPS);
    const labels = tree.map((n) => (n.separator ? "---" : n.label));
    assert.deepEqual(labels, [
      "Checking status…",
      "---",
      "Raft Desktop v0.0.59",
      "Quit Raft Desktop",
    ]);
  });

  test("signed out → Account + Sign in + version submenu + quit (no workspace info)", () => {
    const tree = buildMenuModel(makeState({ status: makeStatus({}) }), DEPS);
    const labels = tree.map((n) => (n.separator ? "---" : n.label));
    assert.deepEqual(labels, [
      "Account",
      "Sign in",
      "---",
      "Raft Desktop v0.0.59",
      "Quit Raft Desktop",
    ]);
    const signIn = asItem(tree.find((n) => !n.separator && n.label === "Sign in"));
    assert.deepEqual(signIn.click, { kind: "connectWorkspace" });
  });

  test("signed out + stale servers → no workspace rows, no Connect workspace", () => {
    const status = makeStatus({
      loggedIn: false,
      servers: [makeServer({ serverId: "a", serverSlug: "dev", health: "offline", serverConnected: false })],
    });
    const tree = buildMenuModel(makeState({ status }), DEPS);
    const labels = tree.map((n) => (n.separator ? "---" : n.label));
    assert.ok(!labels.some((l) => l.includes("dev")), "should not show workspace row when signed out");
    assert.ok(!labels.some((l) => l === "Connect server…"), "should not show Connect workspace when signed out");
    assert.ok(labels.includes("Account"), "should show Account header");
    assert.ok(labels.includes("Sign in"), "should still show Sign in");
  });

  test("signed in + 1 online workspace → Account + identity + servers + version submenu + quit", () => {
    const status = makeStatus({
      loggedIn: true,
      userId: "alice@slock.ai",
      userDisplayName: "Alice",
      service: { running: true, pid: 1, logPath: "/tmp/svc.log" },
      servers: [makeServer({ serverId: "a", serverSlug: "dev-workspace", health: "ok", serverConnected: true, daemon: { running: true, pid: 1 } })],
    });
    const tree = buildMenuModel(makeState({ status }), DEPS);
    const labels = tree.map((n) => (n.separator ? "---" : n.label));
    assert.deepEqual(labels, [
      "Account",
      "Alice",
      "---",
      "Servers",
      "•  dev-workspace",
      "Connect server…",
      "---",
      "Raft Desktop v0.0.59",
      "Quit Raft Desktop",
    ]);
    const aliceItem = asItem(tree.find((n) => !n.separator && n.label === "Alice"));
    assert.ok(aliceItem.submenu, "identity row should have a submenu");
    assert.equal(asItem(aliceItem.submenu![0]).label, "Sign out");
  });

  test("multiple workspaces with different states → correct dots per row", () => {
    const status = makeStatus({
      loggedIn: true,
      userId: "u",
      service: { running: true, pid: 1, logPath: "" },
      servers: [
        makeServer({ serverId: "a", serverSlug: "alpha", health: "ok", serverConnected: true, daemon: { running: true, pid: 1 } }),
        makeServer({ serverId: "b", serverSlug: "bravo", health: "offline", serverConnected: false }),
        makeServer({ serverId: "c", serverSlug: "charlie", health: "degraded", serverConnected: false }),
        makeServer({ serverId: "d", serverSlug: "delta", health: "ok", serverConnected: false, daemon: { running: true, pid: 1 } }),
      ],
    });
    const tree = buildMenuModel(makeState({ status }), DEPS);
    const serverRows = tree.filter(isServerRow);
    assert.deepEqual(
      serverRows.map((r) => r.label),
      ["•  alpha", "◦  bravo", "*  charlie", "*  delta"],
    );
  });

  test("online workspace submenu: Open workspace only (no Detach, no Send diagnostics)", () => {
    const status = makeStatus({
      loggedIn: true,
      userId: "u",
      service: { running: true, pid: 1, logPath: "" },
      servers: [makeServer({ serverId: "a", serverSlug: "botiverse", health: "ok", serverConnected: true, daemon: { running: true, pid: 1 } })],
    });
    const tree = buildMenuModel(makeState({ status }), DEPS);
    const row = asItem(tree.find(isServerRow));
    const sub = row.submenu!;
    assert.equal(asItem(sub[0]).label, "Online");
    assert.equal(asItem(sub[0]).enabled, false);
    // After separator
    assert.equal(asItem(sub[2]).label, "Open workspace");
    assert.deepEqual(asItem(sub[2]).click, { kind: "openUrl", url: "https://app.slock.ai/s/botiverse/computer/machine-a" });
    assert.ok(!sub.some((n) => !n.separator && n.label === "Detach"), "ordinary app menu must not expose Detach");
    assert.ok(!sub.some((n) => !n.separator && n.label === "Send diagnostics"), "no per-server Send diagnostics");
  });

  test("offline workspace submenu: Recover connection + Open workspace only", () => {
    const status = makeStatus({
      loggedIn: true,
      userId: "u",
      service: { running: true, pid: 1, logPath: "" },
      servers: [makeServer({ serverId: "a", serverSlug: "botiverse", health: "offline", serverConnected: false })],
    });
    const tree = buildMenuModel(makeState({ status }), DEPS);
    const row = asItem(tree.find(isServerRow));
    const sub = row.submenu!;
    assert.equal(asItem(sub[0]).label, "Offline");
    assert.equal(asItem(sub[2]).label, "Recover connection");
    assert.deepEqual(asItem(sub[2]).click, { kind: "startService", serverId: "a", serverLabel: "botiverse" });
    assert.equal(asItem(sub[3]).label, "Open workspace");
    assert.ok(!sub.some((n) => !n.separator && n.label === "Detach"), "ordinary app menu must not expose Detach");
  });

  test("needs-attention workspace submenu: Recover → restartRunner (not startService)", () => {
    const status = makeStatus({
      loggedIn: true,
      userId: "u",
      service: { running: true, pid: 1, logPath: "" },
      servers: [makeServer({ serverId: "a", serverSlug: "botiverse", health: "degraded", serverConnected: false })],
    });
    const tree = buildMenuModel(makeState({ status }), DEPS);
    const row = asItem(tree.find(isServerRow));
    const sub = row.submenu!;
    assert.equal(asItem(sub[0]).label, "Needs attention");
    assert.equal(asItem(sub[2]).label, "Recover connection");
    assert.equal(asItem(sub[3]).label, "Open workspace");
    assert.ok(!sub.some((n) => !n.separator && n.label === "Detach"), "ordinary app menu must not expose Detach");
  });

  test("verifying workspace submenu: Open setup progress + Open workspace (no Send diagnostics, no Detach)", () => {
    const status = makeStatus({
      loggedIn: true,
      userId: "u",
      service: { running: true, pid: 1, logPath: "" },
      servers: [makeServer({ serverId: "a", serverSlug: "botiverse", health: "ok", serverConnected: false, daemon: { running: true, pid: 1 } })],
    });
    const tree = buildMenuModel(makeState({ status }), DEPS);
    const row = asItem(tree.find(isServerRow));
    const sub = row.submenu!;
    assert.equal(asItem(sub[0]).label, "Verifying");
    assert.equal(asItem(sub[2]).label, "Open setup progress");
    assert.deepEqual(asItem(sub[2]).click, {
      kind: "connectWorkspace",
      serverId: "a",
      serverLabel: "botiverse",
    });
    assert.equal(asItem(sub[3]).label, "Open workspace");
    assert.ok(!sub.some((n) => !n.separator && n.label === "Send diagnostics"), "no per-server Send diagnostics");
    assert.ok(!sub.some((n) => !n.separator && n.label === "Detach"), "verifying submenu should not have Detach");
  });

  test("update available → shown in lifecycle section", () => {
    const status = makeStatus({ loggedIn: true, userId: "u" });
    const tree = buildMenuModel(makeState({ status, latestVersion: "0.0.60" }), DEPS);
    const update = asItem(tree.find((n) => !n.separator && n.label.startsWith("Update available")));
    assert.equal(update.label, "Update available · v0.0.60");
    assert.deepEqual(update.click, { kind: "upgrade", targetVersion: "0.0.60" });
  });

  test("in-flight state disables shared-model mutations but keeps presenter actions visible", () => {
    const status = makeStatus({
      loggedIn: true,
      userId: "u",
      service: { running: true, pid: 1, logPath: "/tmp/svc.log" },
      servers: [makeServer({ serverId: "a", serverSlug: "botiverse", health: "degraded", serverConnected: false })],
    });
    const tree = buildMenuModel(
      makeState({ status, latestVersion: "0.0.60", inFlight: "Restarting service…" }),
      DEPS,
    );

    const update = asItem(tree.find((n) => !n.separator && n.label.startsWith("Update available")));
    assert.equal(update.enabled, false);
    assert.equal(update.click, undefined);

    const row = asItem(tree.find(isServerRow));
    const recover = asItem(row.submenu!.find((n) => !n.separator && n.label === "Recover connection"));
    assert.equal(recover.enabled, false);
    assert.equal(recover.click, undefined);

    const openWs = asItem(row.submenu!.find((n) => !n.separator && n.label === "Open workspace"));
    assert.deepEqual(openWs.click, { kind: "openUrl", url: "https://app.slock.ai/s/botiverse/computer/machine-a" });
  });

  test("update not shown when local == cdn", () => {
    const tree = buildMenuModel(makeState({ status: makeStatus({}), latestVersion: "0.0.59" }), DEPS);
    assert.ok(!tree.some((n) => !n.separator && n.label.startsWith("Update available")));
  });

  test("Connect server… action wired to connectWorkspace", () => {
    const tree = buildMenuModel(makeState({ status: makeStatus({ loggedIn: true, userId: "u" }) }), DEPS);
    const connect = asItem(tree.find((n) => !n.separator && n.label === "Connect server…"));
    assert.deepEqual(connect.click, { kind: "connectWorkspace" });
  });

  test("Quit Raft Desktop wired to quitApp (not native role:quit)", () => {
    const tree = buildMenuModel(makeState({ status: makeStatus({}) }), DEPS);
    const quit = asItem(tree.find((n) => !n.separator && n.label === "Quit Raft Desktop"));
    assert.deepEqual(quit.click, { kind: "quitApp" });
    assert.equal(quit.role, undefined, "should not use native role:quit — quitApp shows a confirmation dialog");
  });

  test("version submenu contains Send diagnostics + View logs + Launch at login", () => {
    const status = makeStatus({ service: { running: true, pid: 1, logPath: "/tmp/svc.log" } });
    const tree = buildMenuModel(makeState({ status, launchAtLogin: true }), DEPS);
    const versionItem = asItem(tree.find((n) => !n.separator && n.label === "Raft Desktop v0.0.59"));
    assert.ok(versionItem.submenu, "version item should have a submenu");
    const diag = asItem(versionItem.submenu!.find((n) => !n.separator && n.label === "Send diagnostics"));
    assert.deepEqual(diag.click, { kind: "diagnosticsPush" });
    const logs = asItem(versionItem.submenu!.find((n) => !n.separator && n.label === "View logs"));
    assert.deepEqual(logs.click, { kind: "viewLog", path: "/tmp/svc.log" });
    const launch = asItem(versionItem.submenu!.find((n) => !n.separator && n.label === "Launch at login"));
    assert.equal(launch.checked, true);
    assert.deepEqual(launch.click, { kind: "toggleLaunchAtLogin", currentlyEnabled: true });
  });

  test("version submenu → View logs omitted when no logPath", () => {
    const status = makeStatus({ service: { running: false, logPath: "" } });
    const tree = buildMenuModel(makeState({ status }), DEPS);
    const versionItem = asItem(tree.find((n) => !n.separator && n.label === "Raft Desktop v0.0.59"));
    assert.ok(!versionItem.submenu!.some((n) => !n.separator && n.label === "View logs"));
  });

  test("session error + loggedIn=false → shows Sign in", () => {
    const status = makeStatus({ loggedIn: false, userSessionError: "token expired" });
    const tree = buildMenuModel(makeState({ status }), DEPS);
    assert.ok(tree.some((n) => !n.separator && n.label === "Account"), "should show Account header");
    assert.ok(tree.some((n) => !n.separator && n.label === "Sign in"), "should show Sign in");
  });

  test("loggedIn=true + userSessionError → menu still shows identity normally (daemon keeps running)", () => {
    const status = makeStatus({
      loggedIn: true,
      userId: "alice",
      userDisplayName: "Alice",
      userSessionError: "token expired",
      servers: [makeServer({ serverId: "a", serverSlug: "dev", health: "ok", serverConnected: true, daemon: { running: true, pid: 1 } })],
    });
    const tree = buildMenuModel(makeState({ status }), DEPS);
    const aliceItem = asItem(tree.find((n) => !n.separator && n.label === "Alice"));
    assert.ok(aliceItem.submenu, "identity row should have Sign out submenu");
    const labels = tree.map((n) => (n.separator ? "---" : n.label));
    assert.ok(!labels.includes("Session expired"), "menu should not show session expired");
    assert.ok(labels.some((l) => l.includes("dev")), "server rows should still be visible");
  });

  test("server row falls back to serverId.slice(0,8) when slug is null", () => {
    const status = makeStatus({
      loggedIn: true,
      userId: "u",
      service: { running: true, pid: 1, logPath: "" },
      servers: [{ ...makeServer({ serverId: "abcdef0123456789", health: "ok", serverConnected: true, daemon: { running: true, pid: 1 } }), serverSlug: null }],
    });
    const tree = buildMenuModel(makeState({ status }), DEPS);
    const serverRow = asItem(tree.find(isServerRow));
    assert.equal(serverRow.label, "•  abcdef01");
  });

  test("sibling rows keep independent status — one degraded does not relabel healthy rows", () => {
    const status = makeStatus({
      loggedIn: true,
      userId: "u",
      service: { running: true, pid: 1, logPath: "" },
      servers: [
        makeServer({ serverId: "a", serverSlug: "healthy", health: "ok", serverConnected: true, daemon: { running: true, pid: 1 } }),
        makeServer({ serverId: "b", serverSlug: "degraded", health: "degraded" }),
      ],
    });
    const tree = buildMenuModel(makeState({ status }), DEPS);
    const rows = tree.filter(isServerRow);
    assert.equal(rows[0]!.label, "•  healthy");
    assert.equal(rows[1]!.label, "*  degraded");
    // healthy row's submenu says Online
    assert.equal(asItem(rows[0]!.submenu![0]).label, "Online");
    // degraded row's submenu says Needs attention
    assert.equal(asItem(rows[1]!.submenu![0]).label, "Needs attention");
  });

  test("dashboard url with trailing slash is trimmed in workspace links", () => {
    const status = makeStatus({
      loggedIn: true,
      userId: "u",
      service: { running: true, pid: 1, logPath: "" },
      servers: [makeServer({ serverId: "a", serverSlug: "botiverse", health: "ok", serverConnected: true, daemon: { running: true, pid: 1 } })],
    });
    const tree = buildMenuModel(
      makeState({ status }),
      { ...DEPS, dashboardUrl: "https://app.slock.ai/" },
    );
    const row = asItem(tree.find(isServerRow));
    const openWs = asItem(row.submenu!.find((n) => !n.separator && n.label === "Open workspace"));
    assert.equal(
      (openWs.click as { kind: "openUrl"; url: string }).url,
      "https://app.slock.ai/s/botiverse/computer/machine-a",
    );
  });

  test("Open workspace falls back to /computers when machineId is null", () => {
    const status = makeStatus({
      loggedIn: true,
      userId: "u",
      service: { running: true, pid: 1, logPath: "" },
      servers: [makeServer({ serverId: "a", serverSlug: "botiverse", health: "ok", serverConnected: true, daemon: { running: true, pid: 1 }, machineId: null })],
    });
    const tree = buildMenuModel(makeState({ status }), DEPS);
    const row = asItem(tree.find(isServerRow));
    const openWs = asItem(row.submenu!.find((n) => !n.separator && n.label === "Open workspace"));
    assert.equal(
      (openWs.click as { kind: "openUrl"; url: string }).url,
      "https://app.slock.ai/s/botiverse/computers",
    );
  });

  test("product naming: 'Raft Desktop' not 'Raft Computer'", () => {
    const tree = buildMenuModel(makeState({ status: makeStatus({}) }), DEPS);
    const labels = tree.map((n) => (n.separator ? "" : n.label)).join(" ");
    assert.ok(labels.includes("Raft Desktop"), "should use 'Raft Desktop'");
    assert.ok(!labels.includes("Raft Computer"), "should NOT use 'Raft Computer'");
  });
});
