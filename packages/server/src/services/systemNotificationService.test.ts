import assert from "node:assert/strict";
import {
  buildServerSystemNotificationsResponse,
  projectMachineSystemNotifications,
  type MachineNotificationReadModel,
} from "./systemNotificationService";
import {
  planUsageLimitTransition,
  runtimeProviderForAgentRuntime,
  USAGE_LIMIT_STALE_AFTER_RESET_MS,
  USAGE_LIMIT_STALE_WITHOUT_RESET_MS,
} from "./usageLimitAttentionService";

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

test("projects canonical offline copy, severity, payload, and legacy-compatible ids", () => {
  const notifications = projectMachineSystemNotifications({
    machines: [
      machine("b", { name: "Beta", status: "offline", daemonVersion: "0.58.0" }),
      machine("a", { name: "Alpha", status: "offline", daemonVersion: "0.59.0" }),
      machine("c", { name: "Current", daemonVersion: "0.61.0" }),
      machine("d", { name: "Old", daemonVersion: "0.60.0" }),
      machine("e", { name: "Unknown", daemonVersion: null }),
    ],
    activeAgentCountByMachine: new Map([["b", 1], ["a", 2], ["d", 4]]),
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
  ]);
});

test("active snapshot resolves recovered rows by absence", () => {
  const initial = projectMachineSystemNotifications({
    machines: [
      machine("offline", { status: "offline" }),
      machine("old", { daemonVersion: "0.60.0" }),
    ],
    activeAgentCountByMachine: new Map(),
    evaluatedAt: EVALUATED_AT,
  });
  assert.deepEqual(initial.map((notification) => notification.id), [
    "machine-offline:offline",
  ]);

  const recovered = projectMachineSystemNotifications({
    machines: [
      machine("offline", { status: "online", daemonVersion: "0.61.0" }),
      machine("old", { daemonVersion: "0.61.0" }),
    ],
    activeAgentCountByMachine: new Map(),
    evaluatedAt: EVALUATED_AT,
  });
  assert.deepEqual(recovered, [], "resolved conditions are omitted from the replacement snapshot");
});

test("online raw daemons never produce an outdated notice: the daemon has no standalone release to trail", () => {
  for (const current of ["0.60.0", "0.1.0", null, "future"] as const) {
    const notifications = projectMachineSystemNotifications({
      machines: [machine("m", { daemonVersion: current })],
      activeAgentCountByMachine: new Map(),
      evaluatedAt: EVALUATED_AT,
    });
    assert.deepEqual(notifications, [], `(${current}) must not produce a notice`);
  }
});

test("managed Computers never enter raw-daemon offline notifications", () => {
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
      machine("daemon-offline", {
        status: "offline",
        daemonVersion: "0.1.0",
      }),
    ],
    activeAgentCountByMachine: new Map([
      ["computer-offline", 3],
      ["daemon-offline", 1],
    ]),
    evaluatedAt: EVALUATED_AT,
  });

  assert.deepEqual(
    notifications.map((notification) => notification.id),
    ["machine-offline:daemon-offline"],
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

test("usage-limit attention maps only runtimes sharing the provider account", () => {
  assert.equal(runtimeProviderForAgentRuntime("claude"), "claude");
  assert.equal(runtimeProviderForAgentRuntime("kimi-sdk"), "kimi");
  assert.equal(runtimeProviderForAgentRuntime("antigravity"), "antigravity");
  assert.equal(runtimeProviderForAgentRuntime("pi"), null);
});

test("usage-limit activation ignores stale/unknown data and resolves only on a newer authoritative ok", () => {
  const first = new Date("2026-10-11T00:00:00.000Z");
  const newer = new Date("2026-10-11T00:01:00.000Z");
  const active = { state: "active" as const, activationGeneration: 4, lastObservedAt: first, resetsAt: null };
  assert.deepEqual(planUsageLimitTransition({ latest: active, observedAt: newer, windowStatus: "limit_reached", now: newer }), {
    action: "update_active",
  });
  assert.deepEqual(planUsageLimitTransition({ latest: active, observedAt: first, windowStatus: "limit_reached", now: newer }), {
    action: "ignore",
  });
  assert.deepEqual(planUsageLimitTransition({ latest: active, observedAt: newer, windowStatus: "parse_unavailable", now: newer }), {
    action: "ignore",
  });
  assert.deepEqual(planUsageLimitTransition({ latest: active, observedAt: newer, windowStatus: "ok", now: newer }), {
    action: "resolve",
  });
  assert.deepEqual(planUsageLimitTransition({ latest: active, observedAt: first, windowStatus: "ok", now: newer }), {
    action: "ignore",
  });
});

test("usage-limit limit hit again on a stale active incident starts a new generation", () => {
  const first = new Date("2026-10-11T00:00:00.000Z");
  const resetsAt = new Date("2026-10-11T05:00:00.000Z");
  const active = { state: "active" as const, activationGeneration: 4, lastObservedAt: first, resetsAt };
  const withinGrace = new Date(resetsAt.getTime() + USAGE_LIMIT_STALE_AFTER_RESET_MS - 1);
  const pastGrace = new Date(resetsAt.getTime() + USAGE_LIMIT_STALE_AFTER_RESET_MS + 1);
  assert.deepEqual(
    planUsageLimitTransition({ latest: active, observedAt: withinGrace, windowStatus: "limit_reached", now: withinGrace }),
    { action: "update_active" },
  );
  assert.deepEqual(
    planUsageLimitTransition({ latest: active, observedAt: pastGrace, windowStatus: "limit_reached", now: pastGrace }),
    { action: "reactivate", generation: 5 },
  );
  const noReset = { ...active, resetsAt: null };
  const dayLater = new Date(first.getTime() + USAGE_LIMIT_STALE_WITHOUT_RESET_MS + 1);
  assert.deepEqual(
    planUsageLimitTransition({ latest: noReset, observedAt: dayLater, windowStatus: "limit_reached", now: dayLater }),
    { action: "reactivate", generation: 5 },
  );
  assert.deepEqual(
    planUsageLimitTransition({ latest: noReset, observedAt: dayLater, windowStatus: "ok", now: dayLater }),
    { action: "resolve" },
    "a stale incident still resolves on an authoritative ok",
  );
});

test("usage-limit recovered-to-limited creates a new activation generation", () => {
  const first = new Date("2026-10-11T00:00:00.000Z");
  const newer = new Date("2026-10-11T00:01:00.000Z");
  const resolved = { state: "resolved" as const, activationGeneration: 7, lastObservedAt: first, resetsAt: null };
  assert.deepEqual(planUsageLimitTransition({ latest: resolved, observedAt: newer, windowStatus: "limit_reached", now: newer }), {
    action: "activate",
    generation: 8,
  });
  assert.deepEqual(planUsageLimitTransition({ latest: null, observedAt: first, windowStatus: "limit_reached", now: newer }), {
    action: "activate",
    generation: 1,
  });
});
