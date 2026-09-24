import assert from "node:assert/strict";
import { test } from "vitest";
import {
  buildServerSystemNotificationsResponse,
  projectMachineSystemNotifications,
  type MachineNotificationReadModel,
} from "./systemNotificationService.js";

const EVALUATED_AT = new Date("2026-07-21T10:30:00.000Z");

function machine(
  id: string,
  overrides: Partial<MachineNotificationReadModel> = {},
): MachineNotificationReadModel {
  return {
    id,
    name: `machine-${id}`,
    status: "online",
    daemonVersion: "0.60.0",
    isComputer: false,
    ...overrides,
  };
}

test("projects canonical offline/outdated copy, severity, payload, and legacy-compatible ids", () => {
  const notifications = projectMachineSystemNotifications({
    machines: [
      machine("b", { name: "Beta", status: "offline", daemonVersion: "0.58.0" }),
      machine("a", { name: "Alpha", status: "offline", daemonVersion: "0.59.0" }),
      machine("c", { name: "Current", daemonVersion: "0.61.0" }),
      machine("d", { name: "Old", daemonVersion: "0.60.0" }),
      machine("e", { name: "Unknown", daemonVersion: null }),
    ],
    activeAgentCountByMachine: new Map([["b", 1], ["a", 2], ["d", 4]]),
    latestDaemonVersion: "0.61.0",
    evaluatedAt: EVALUATED_AT,
  });

  assert.deepEqual(notifications, [
    {
      id: "machine-offline:a,b",
      type: "machine.offline",
      schemaVersion: 1,
      state: "active",
      kind: "error",
      title: "Alpha, Beta are offline",
      body: "3 agents are active on these computers and can't run until they reconnect.",
      copy: {
        titleKey: "machine.offline.title.many",
        bodyKey: "machine.offline.body.active.many",
        actionLabelKey: "common.view",
        params: {
          machineNames: "Alpha, Beta",
          machineCount: 2,
          activeAgentCount: 3,
          targetDaemonVersion: null,
        },
      },
      action: { label: "View", targetType: "machine", targetId: "a" },
      payload: {
        machines: [{ id: "a", name: "Alpha" }, { id: "b", name: "Beta" }],
        activeAgentCount: 3,
        targetDaemonVersion: null,
        evaluation: {
          clock: "server",
          evaluatedAt: "2026-07-21T10:30:00.000Z",
          offlineAfterMs: 0,
          statusAuthority: "canonical_machine_read_model",
          runKind: "raw_daemon",
          versionAuthority: "latest_daemon_release",
        },
      },
    },
    {
      id: "machine-outdated:0.61.0:d",
      type: "machine.outdated",
      schemaVersion: 1,
      state: "active",
      kind: "warning",
      title: "Old is running an outdated daemon",
      body: "Stop the daemon and reconnect to update.",
      copy: {
        titleKey: "machine.outdated.title.one",
        bodyKey: "machine.outdated.body",
        actionLabelKey: "common.view",
        params: {
          machineNames: "Old",
          machineCount: 1,
          activeAgentCount: 4,
          targetDaemonVersion: "0.61.0",
        },
      },
      action: { label: "View", targetType: "machine", targetId: "d" },
      payload: {
        machines: [{ id: "d", name: "Old" }],
        activeAgentCount: 4,
        targetDaemonVersion: "0.61.0",
        evaluation: {
          clock: "server",
          evaluatedAt: "2026-07-21T10:30:00.000Z",
          offlineAfterMs: 0,
          statusAuthority: "canonical_machine_read_model",
          runKind: "raw_daemon",
          versionAuthority: "latest_daemon_release",
        },
      },
    },
  ]);
});

test("active snapshot resolves recovered/updated rows by absence and rekeys changed incidents", () => {
  const initial = projectMachineSystemNotifications({
    machines: [
      machine("offline", { status: "offline" }),
      machine("old", { daemonVersion: "0.60.0" }),
    ],
    activeAgentCountByMachine: new Map(),
    latestDaemonVersion: "0.61.0",
    evaluatedAt: EVALUATED_AT,
  });
  assert.deepEqual(initial.map((notification) => notification.id), [
    "machine-offline:offline",
    "machine-outdated:0.61.0:old",
  ]);

  const recoveredAndUpdated = projectMachineSystemNotifications({
    machines: [
      machine("offline", { status: "online", daemonVersion: "0.61.0" }),
      machine("old", { daemonVersion: "0.61.0" }),
    ],
    activeAgentCountByMachine: new Map(),
    latestDaemonVersion: "0.61.0",
    evaluatedAt: EVALUATED_AT,
  });
  assert.deepEqual(recoveredAndUpdated, [], "resolved conditions are omitted from the replacement snapshot");

  const newTarget = projectMachineSystemNotifications({
    machines: [machine("old", { daemonVersion: "0.61.0" })],
    activeAgentCountByMachine: new Map(),
    latestDaemonVersion: "0.62.0",
    evaluatedAt: EVALUATED_AT,
  });
  assert.equal(newTarget[0]?.id, "machine-outdated:0.62.0:old", "a new release gets a new dismissal identity");
});

test("missing or malformed target/current versions fail open without an outdated notice", () => {
  for (const [current, latest] of [
    ["0.60.0", null],
    [null, "0.61.0"],
    ["future", "0.61.0"],
    ["0.60.0", "latest"],
  ] as const) {
    const notifications = projectMachineSystemNotifications({
      machines: [machine("m", { daemonVersion: current })],
      activeAgentCountByMachine: new Map(),
      latestDaemonVersion: latest,
      evaluatedAt: EVALUATED_AT,
    });
    assert.deepEqual(notifications, [], `(${current}, ${latest}) must not mistrigger`);
  }
});

test("managed Computers never enter raw-daemon offline or outdated notifications", () => {
  const notifications = projectMachineSystemNotifications({
    machines: [
      machine("computer-offline", {
        status: "offline",
        daemonVersion: "0.1.0",
        isComputer: true,
      }),
      machine("computer-old", {
        status: "online",
        daemonVersion: "0.1.0",
        isComputer: true,
      }),
      machine("daemon-old", {
        status: "online",
        daemonVersion: "0.1.0",
      }),
    ],
    activeAgentCountByMachine: new Map([
      ["computer-offline", 3],
      ["daemon-old", 1],
    ]),
    latestDaemonVersion: "1.0.0",
    evaluatedAt: EVALUATED_AT,
  });

  assert.deepEqual(
    notifications.map((notification) => notification.id),
    ["machine-outdated:1.0.0:daemon-old"],
    "managed Computers use their separate source-aware aggregate attention contract",
  );
  assert.ok(notifications.every(
    (notification) => notification.payload.evaluation.runKind === "raw_daemon",
  ));
});

test("response freezes replace lifecycle, no-read, and local-dismiss semantics", () => {
  assert.deepEqual(buildServerSystemNotificationsResponse(EVALUATED_AT, []), {
    contractVersion: "server-system-notifications-v1",
    generatedAt: "2026-07-21T10:30:00.000Z",
    snapshotMode: "replace",
    clientState: {
      read: "none",
      dismiss: "local_by_notification_id",
    },
    notifications: [],
  });
});
