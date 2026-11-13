import assert from "node:assert/strict";
import { mapSlackBridgeLifecycleBatches } from "./slackBridgeLifecycleBatch";
import {
  applySlackBridgeWorkerEvent,
  planSlackBridgeWorkerLifecycle,
  startSlackBridgePersistentWorker,
  type SlackBridgeBindingRuntime,
  type SlackBridgeLifecycleExecutionReceipt,
  type SlackBridgeLifecyclePolicy,
  type SlackBridgePersistentWorkerClock,
  type SlackBridgeProbeRequest,
  type SlackBridgeWorkerCommand,
} from "./slackBridgeWorkerLifecycle";

const nowMs = Date.parse("2026-08-11T02:30:00.000Z");

function basePolicy(overrides: Partial<SlackBridgeLifecyclePolicy> = {}): SlackBridgeLifecyclePolicy {
  return {
    orchestratorId: "orchestrator-a",
    nowMs,
    probeFreshnessMs: 60_000,
    maxPendingEvents: 50,
    maxOldestPendingEventAgeMs: 120_000,
    trigger: "periodic",
    ...overrides,
  };
}

function activeBinding(overrides: Partial<SlackBridgeBindingRuntime> = {}): SlackBridgeBindingRuntime {
  return {
    bindingId: "binding-1",
    mode: "active",
    desiredEpoch: 7,
    authority: {
      appInstallState: "active",
      channelBindingState: "active",
      credentialState: "active",
      audienceStatus: "matched",
    },
    worker: {
      state: "running",
      epoch: 7,
      leaseId: "lease-a",
      leaseOwnerId: "orchestrator-a",
      leaseExpiresAtMs: nowMs + 30_000,
    },
    backlog: {
      pendingEvents: 0,
      oldestPendingEventAgeMs: 0,
    },
    probes: {
      slack: { surface: "slack", ok: true, observedAtMs: nowMs - 10_000, trigger: "periodic" },
      raft: { surface: "raft", ok: true, observedAtMs: nowMs - 8_000, trigger: "periodic" },
    },
    ...overrides,
  };
}

async function refreshAudience(binding: SlackBridgeBindingRuntime) {
  return {
    bindingId: binding.bindingId,
    audienceStatus: "matched" as const,
    observedAtMs: nowMs,
    revision: 2,
  };
}

test("connected active binding produces no worker command and no provider probe calls while probes are fresh", () => {
  const [plan] = planSlackBridgeWorkerLifecycle([activeBinding()], basePolicy());

  assert.equal(plan.command, null);
  assert.deepEqual(plan.probeRequests, []);
  assert.deepEqual(plan.health, {
    state: "Connected",
    reason: null,
    failingSurface: null,
    lastVerifiedAtMs: nowMs - 10_000,
  });
});

test("active binding without a worker starts exactly one owned epoch", () => {
  const [plan] = planSlackBridgeWorkerLifecycle([
    activeBinding({
      worker: {
        state: "not_running",
        epoch: 0,
        leaseId: null,
        leaseOwnerId: null,
        leaseExpiresAtMs: null,
      },
      probes: {},
    }),
  ], basePolicy());

  assert.deepEqual(plan.command, {
    type: "start",
    bindingId: "binding-1",
    nextEpoch: 7,
    reason: "active_binding_without_worker",
  });
  assert.deepEqual(plan.probeRequests, []);
  assert.deepEqual(plan.health, {
    state: "Unverified",
    reason: "worker_not_running",
    failingSurface: "worker",
    lastVerifiedAtMs: null,
  });
});

test("inactive binding stops an existing worker and reports disconnected with typed reason", () => {
  const [plan] = planSlackBridgeWorkerLifecycle([
    activeBinding({ mode: "paused" }),
  ], basePolicy());

  assert.deepEqual(plan.command, {
    type: "stop",
    bindingId: "binding-1",
    nextEpoch: 7,
    reason: "inactive_binding",
  });
  assert.deepEqual(plan.probeRequests, []);
  assert.deepEqual(plan.health, {
    state: "Disconnected",
    reason: "binding_paused",
    failingSurface: "binding",
    lastVerifiedAtMs: null,
  });
});

test("valid peer lease prevents duplicate owner start and stays explicitly unverified", () => {
  const [plan] = planSlackBridgeWorkerLifecycle([
    activeBinding({
      worker: {
        state: "running",
        epoch: 7,
        leaseId: "peer-lease",
        leaseOwnerId: "orchestrator-b",
        leaseExpiresAtMs: nowMs + 30_000,
      },
    }),
  ], basePolicy());

  assert.equal(plan.command, null);
  assert.deepEqual(plan.probeRequests, []);
  assert.deepEqual(plan.health, {
    state: "Unverified",
    reason: "lease_held_by_peer",
    failingSurface: "worker",
    lastVerifiedAtMs: null,
  });
});

test("failed owned worker restarts with a new epoch and typed degraded reason", () => {
  const [plan] = planSlackBridgeWorkerLifecycle([
    activeBinding({
      worker: {
        state: "failed",
        epoch: 7,
        leaseId: "lease-a",
        leaseOwnerId: "orchestrator-a",
        leaseExpiresAtMs: nowMs + 30_000,
      },
    }),
  ], basePolicy());

  assert.deepEqual(plan.command, {
    type: "restart",
    bindingId: "binding-1",
    nextEpoch: 8,
    reason: "worker_failed",
  });
  assert.deepEqual(plan.health, {
    state: "Degraded",
    reason: "worker_failed",
    failingSurface: "worker",
    lastVerifiedAtMs: null,
  });
});

test("backlog threshold degrades health without hiding the worker lease", () => {
  const [plan] = planSlackBridgeWorkerLifecycle([
    activeBinding({
      backlog: {
        pendingEvents: 51,
        oldestPendingEventAgeMs: 10_000,
      },
    }),
  ], basePolicy());

  assert.equal(plan.command, null);
  assert.deepEqual(plan.health, {
    state: "Degraded",
    reason: "backlog_backpressure",
    failingSurface: "backlog",
    lastVerifiedAtMs: null,
  });
});

test("authority projection keeps reauth and quarantine as distinct product reasons", () => {
  const [reauthPlan, quarantinedPlan] = planSlackBridgeWorkerLifecycle([
    activeBinding({
      authority: {
        appInstallState: "reauth_required",
        channelBindingState: "active",
        credentialState: "active",
        audienceStatus: "matched",
      },
    }),
    activeBinding({
      bindingId: "binding-2",
      authority: {
        appInstallState: "quarantined",
        channelBindingState: "active",
        credentialState: "active",
        audienceStatus: "matched",
      },
    }),
  ], basePolicy());

  assert.deepEqual(reauthPlan.health, {
    state: "Degraded",
    reason: "app_reauth_required",
    failingSurface: "app_install",
    lastVerifiedAtMs: null,
  });
  assert.deepEqual(quarantinedPlan.health, {
    state: "Degraded",
    reason: "app_quarantined",
    failingSurface: "app_install",
    lastVerifiedAtMs: null,
  });
});

test("authority projection does not flatten audience unavailable into mismatch", () => {
  const [unavailablePlan, mismatchPlan] = planSlackBridgeWorkerLifecycle([
    activeBinding({
      authority: {
        appInstallState: "active",
        channelBindingState: "active",
        credentialState: "active",
        audienceStatus: "unavailable",
      },
    }),
    activeBinding({
      bindingId: "binding-2",
      authority: {
        appInstallState: "active",
        channelBindingState: "active",
        credentialState: "active",
        audienceStatus: "mismatch",
      },
    }),
  ], basePolicy());

  assert.deepEqual(unavailablePlan.health, {
    state: "Unverified",
    reason: "audience_unavailable",
    failingSurface: "audience",
    lastVerifiedAtMs: null,
  });
  assert.deepEqual(mismatchPlan.health, {
    state: "Degraded",
    reason: "audience_mismatch",
    failingSurface: "audience",
    lastVerifiedAtMs: null,
  });
});

test("authority projection preserves credential persist_unknown as unverified", () => {
  const [plan] = planSlackBridgeWorkerLifecycle([
    activeBinding({
      authority: {
        appInstallState: "active",
        channelBindingState: "active",
        credentialState: "persist_unknown",
        audienceStatus: "matched",
      },
    }),
  ], basePolicy());

  assert.deepEqual(plan.health, {
    state: "Unverified",
    reason: "credential_persist_unknown",
    failingSurface: "credential",
    lastVerifiedAtMs: null,
  });
});

test("periodic probes request only stale or missing surfaces", () => {
  const [plan] = planSlackBridgeWorkerLifecycle([
    activeBinding({
      probes: {
        slack: { surface: "slack", ok: true, observedAtMs: nowMs - 10_000, trigger: "periodic" },
        raft: { surface: "raft", ok: true, observedAtMs: nowMs - 120_000, trigger: "periodic" },
      },
    }),
  ], basePolicy());

  assert.deepEqual(plan.probeRequests, [
    { bindingId: "binding-1", surface: "raft", trigger: "periodic" },
  ]);
  assert.deepEqual(plan.health, {
    state: "Unverified",
    reason: "probe_stale",
    failingSurface: "raft",
    lastVerifiedAtMs: null,
  });
});

test("event-triggered probes request both sides to re-check a changed binding", () => {
  const [plan] = planSlackBridgeWorkerLifecycle([activeBinding()], basePolicy({ trigger: "event" }));

  assert.deepEqual(plan.probeRequests, [
    { bindingId: "binding-1", surface: "slack", trigger: "event" },
    { bindingId: "binding-1", surface: "raft", trigger: "event" },
  ]);
});

test("dual probe failures identify the failing authority surface", () => {
  const [plan] = planSlackBridgeWorkerLifecycle([
    activeBinding({
      probes: {
        slack: { surface: "slack", ok: true, observedAtMs: nowMs - 10_000, trigger: "periodic" },
        raft: {
          surface: "raft",
          ok: false,
          observedAtMs: nowMs - 8_000,
          trigger: "periodic",
          failureReason: "channel_archived",
        },
      },
    }),
  ], basePolicy());

  assert.deepEqual(plan.health, {
    state: "Degraded",
    reason: "raft_probe_failed",
    failingSurface: "raft",
    lastVerifiedAtMs: null,
  });
});

test("worker event fence rejects stale epochs and mismatched leases", () => {
  const current = activeBinding();

  assert.deepEqual(applySlackBridgeWorkerEvent(current, {
    bindingId: "binding-1",
    epoch: 6,
    leaseId: "lease-a",
    state: "running",
    leaseOwnerId: "orchestrator-a",
    leaseExpiresAtMs: nowMs + 60_000,
  }), {
    accepted: false,
    reason: "stale_epoch",
    worker: current.worker,
  });

  assert.deepEqual(applySlackBridgeWorkerEvent(current, {
    bindingId: "binding-1",
    epoch: 7,
    leaseId: "lease-b",
    state: "running",
    leaseOwnerId: "orchestrator-a",
    leaseExpiresAtMs: nowMs + 60_000,
  }), {
    accepted: false,
    reason: "lease_mismatch",
    worker: current.worker,
  });

  assert.deepEqual(applySlackBridgeWorkerEvent(current, {
    bindingId: "binding-1",
    epoch: 7,
    leaseId: null,
    state: "failed",
    leaseOwnerId: null,
    leaseExpiresAtMs: null,
  }), {
    accepted: false,
    reason: "lease_mismatch",
    worker: current.worker,
  });
});

test("worker event fence accepts a newer epoch owner transition", () => {
  const current = activeBinding();

  assert.deepEqual(applySlackBridgeWorkerEvent(current, {
    bindingId: "binding-1",
    epoch: 8,
    leaseId: "lease-c",
    state: "running",
    leaseOwnerId: "orchestrator-a",
    leaseExpiresAtMs: nowMs + 60_000,
  }), {
    accepted: true,
    reason: "accepted",
    worker: {
      state: "running",
      epoch: 8,
      leaseId: "lease-c",
      leaseOwnerId: "orchestrator-a",
      leaseExpiresAtMs: nowMs + 60_000,
    },
  });
});

function createManualClock(): SlackBridgePersistentWorkerClock & {
  tick(): void;
  activeIntervals(): number;
} {
  const intervals = new Set<() => void>();
  return {
    scheduleEvery(fn) {
      intervals.add(fn);
      return fn;
    },
    clear(handle) {
      intervals.delete(handle as () => void);
    },
    tick() {
      // Timer callbacks may remove or add registrations during this tick.
      // oxlint-disable-next-line unicorn/no-useless-spread
      for (const fn of [...intervals]) fn();
    },
    activeIntervals() {
      return intervals.size;
    },
  };
}

test("persistent worker executes planner commands and persists receipts on periodic drain", async () => {
  const commands: SlackBridgeWorkerCommand[] = [];
  const receipts: SlackBridgeLifecycleExecutionReceipt[] = [];
  const clock = createManualClock();
  const worker = startSlackBridgePersistentWorker({
    async loadBindings() {
      return [activeBinding({
        worker: {
          state: "not_running",
          epoch: 0,
          leaseId: null,
          leaseOwnerId: null,
          leaseExpiresAtMs: null,
        },
        probes: {},
      })];
    },
    refreshAudience,
    async executeCommand(command) {
      commands.push(command);
    },
    async runProbe() {
      throw new Error("unexpected probe");
    },
    async persistReceipt(receipt) {
      receipts.push(receipt);
    },
  }, {
    orchestratorId: "orchestrator-a",
    intervalMs: 1_000,
    probeFreshnessMs: 60_000,
    maxPendingEvents: 50,
    maxOldestPendingEventAgeMs: 120_000,
    nowMs: () => nowMs,
    clock,
  });

  const result = await worker.requestReconcile("periodic");
  worker.stop();

  assert.deepEqual(result, { kind: "completed", trigger: "periodic", bindingCount: 1 });
  assert.deepEqual(commands, [{
    type: "start",
    bindingId: "binding-1",
    nextEpoch: 7,
    reason: "active_binding_without_worker",
  }]);
  assert.equal(receipts.length, 1);
  assert.equal(receipts[0]!.commandExecuted, true);
  assert.deepEqual(receipts[0]!.probeObservations, []);
});

test("persistent worker preserves peer lease fence and never executes another holder restart", async () => {
  const commands: SlackBridgeWorkerCommand[] = [];
  const receipts: SlackBridgeLifecycleExecutionReceipt[] = [];
  const worker = startSlackBridgePersistentWorker({
    async loadBindings() {
      return [activeBinding({
        worker: {
          state: "failed",
          epoch: 7,
          leaseId: "peer-lease",
          leaseOwnerId: "orchestrator-b",
          leaseExpiresAtMs: nowMs + 30_000,
        },
      })];
    },
    refreshAudience,
    async executeCommand(command) {
      commands.push(command);
    },
    async runProbe() {
      throw new Error("unexpected probe");
    },
    async persistReceipt(receipt) {
      receipts.push(receipt);
    },
  }, {
    orchestratorId: "orchestrator-a",
    intervalMs: 1_000,
    probeFreshnessMs: 60_000,
    maxPendingEvents: 50,
    maxOldestPendingEventAgeMs: 120_000,
    nowMs: () => nowMs,
  });

  await worker.requestReconcile("periodic");
  worker.stop();

  assert.deepEqual(commands, []);
  assert.equal(receipts.length, 1);
  assert.deepEqual(receipts[0]!.plan.health, {
    state: "Unverified",
    reason: "lease_held_by_peer",
    failingSurface: "worker",
    lastVerifiedAtMs: null,
  });
});

test("persistent worker event reconcile runs both probes and records observations", async () => {
  const probeRequests: SlackBridgeProbeRequest[] = [];
  const receipts: SlackBridgeLifecycleExecutionReceipt[] = [];
  const worker = startSlackBridgePersistentWorker({
    async loadBindings() {
      return [activeBinding()];
    },
    refreshAudience,
    async executeCommand() {
      throw new Error("unexpected command");
    },
    async runProbe(request) {
      probeRequests.push(request);
      return {
        surface: request.surface,
        ok: true,
        observedAtMs: nowMs,
        trigger: request.trigger,
      };
    },
    async persistReceipt(receipt) {
      receipts.push(receipt);
    },
  }, {
    orchestratorId: "orchestrator-a",
    intervalMs: 1_000,
    probeFreshnessMs: 60_000,
    maxPendingEvents: 50,
    maxOldestPendingEventAgeMs: 120_000,
    nowMs: () => nowMs,
  });

  await worker.requestReconcile("event");
  worker.stop();

  assert.deepEqual(probeRequests, [
    { bindingId: "binding-1", surface: "slack", trigger: "event" },
    { bindingId: "binding-1", surface: "raft", trigger: "event" },
  ]);
  assert.equal(receipts.length, 1);
  assert.deepEqual(receipts[0]!.probeObservations.map((probe) => probe.surface), ["slack", "raft"]);
});

test("persistent worker refreshes audience before planning and durably records unavailable", async () => {
  const order: string[] = [];
  const receipts: SlackBridgeLifecycleExecutionReceipt[] = [];
  const worker = startSlackBridgePersistentWorker({
    async loadBindings() {
      order.push("load");
      return [activeBinding()];
    },
    async refreshAudience(binding, context) {
      order.push(`refresh:${context.trigger}`);
      return {
        bindingId: binding.bindingId,
        audienceStatus: "unavailable",
        observedAtMs: nowMs,
        reason: "provider_unavailable",
        revision: 9,
      };
    },
    async executeCommand() {
      throw new Error("unexpected command");
    },
    async runProbe() {
      throw new Error("unexpected probe");
    },
    async persistReceipt(receipt) {
      order.push("persist");
      receipts.push(receipt);
    },
  }, {
    orchestratorId: "orchestrator-a",
    intervalMs: 1_000,
    probeFreshnessMs: 60_000,
    maxPendingEvents: 50,
    maxOldestPendingEventAgeMs: 120_000,
    nowMs: () => nowMs,
  });

  await worker.requestReconcile("periodic");
  worker.stop();

  assert.deepEqual(order, ["load", "refresh:periodic", "persist"]);
  assert.deepEqual(receipts[0]!.audienceRefresh, {
    bindingId: "binding-1",
    audienceStatus: "unavailable",
    observedAtMs: nowMs,
    reason: "provider_unavailable",
    revision: 9,
  });
  assert.deepEqual(receipts[0]!.plan.health, {
    state: "Unverified",
    reason: "audience_unavailable",
    failingSurface: "audience",
    lastVerifiedAtMs: null,
  });
});

test("persistent worker serializes event reconcile behind an active periodic drain", async () => {
  let releaseFirstLoad!: () => void;
  const loadTriggers: string[] = [];
  const receipts: SlackBridgeLifecycleExecutionReceipt[] = [];
  const worker = startSlackBridgePersistentWorker({
    async loadBindings(context) {
      loadTriggers.push(context.trigger);
      if (loadTriggers.length === 1) {
        await new Promise<void>((resolve) => {
          releaseFirstLoad = resolve;
        });
      }
      return [activeBinding()];
    },
    refreshAudience,
    async executeCommand() {
      throw new Error("unexpected command");
    },
    async runProbe(request) {
      return {
        surface: request.surface,
        ok: true,
        observedAtMs: nowMs,
        trigger: request.trigger,
      };
    },
    async persistReceipt(receipt) {
      receipts.push(receipt);
    },
  }, {
    orchestratorId: "orchestrator-a",
    intervalMs: 1_000,
    probeFreshnessMs: 60_000,
    maxPendingEvents: 50,
    maxOldestPendingEventAgeMs: 120_000,
    nowMs: () => nowMs,
  });

  const first = worker.requestReconcile("periodic");
  const queued = await worker.requestReconcile("event");
  assert.deepEqual(queued, { kind: "queued" });
  const burst = await Promise.all(Array.from({ length: 25 }, () => worker.requestReconcile("event")));
  assert.ok(burst.every(result => result.kind === "queued"), "a burst shares one pending reconcile");
  assert.deepEqual(loadTriggers, ["periodic"]);

  releaseFirstLoad();
  const result = await first;
  worker.stop();

  assert.deepEqual(result, { kind: "completed", trigger: "event", bindingCount: 1 });
  assert.deepEqual(loadTriggers, ["periodic", "event"]);
  assert.equal(receipts.length, 2);
});

test("persistent worker stop clears interval and prevents future drains", async () => {
  const clock = createManualClock();
  let loads = 0;
  const worker = startSlackBridgePersistentWorker({
    async loadBindings() {
      loads += 1;
      return [];
    },
    refreshAudience,
    async executeCommand() {
      throw new Error("unexpected command");
    },
    async runProbe() {
      throw new Error("unexpected probe");
    },
    async persistReceipt() {},
  }, {
    orchestratorId: "orchestrator-a",
    intervalMs: 1_000,
    probeFreshnessMs: 60_000,
    maxPendingEvents: 50,
    maxOldestPendingEventAgeMs: 120_000,
    nowMs: () => nowMs,
    clock,
  });

  assert.equal(clock.activeIntervals(), 1);
  worker.stop();
  assert.equal(clock.activeIntervals(), 0);
  clock.tick();
  assert.equal(loads, 0);
  assert.deepEqual(await worker.requestReconcile("event"), { kind: "stopped" });
});


test("large lifecycle drains let socket/timer callbacks run between binding batches", async () => {
  const bindings = Array.from({ length: 2_001 }, (_, index) => activeBinding({ bindingId: `binding-${index}` }));
  let refreshed = 0;
  let refreshProgressAtTurn = 0;
  let persisted = 0;
  let persistProgressAtTurn = 0;
  const worker = startSlackBridgePersistentWorker({
    async loadBindings() { return bindings; },
    async refreshAudience(binding) {
      refreshed += 1;
      if (refreshed === 1) setImmediate(() => { refreshProgressAtTurn = refreshed; });
      return refreshAudience(binding);
    },
    async afterRefresh() { assert.equal(refreshed, bindings.length, "lifecycle polling must not delay privacy/audience refresh for later pairs"); },
    async executeCommand() { throw new Error("unexpected command"); },
    async runProbe(request) {
      return { surface: request.surface, trigger: request.trigger, ok: true, observedAtMs: nowMs };
    },
    async persistReceipt() {
      persisted += 1;
      if (persisted === 1) setImmediate(() => { persistProgressAtTurn = persisted; });
    },
  }, {
    orchestratorId: "orchestrator-a", intervalMs: 60_000, probeFreshnessMs: 60_000,
    maxPendingEvents: 50, maxOldestPendingEventAgeMs: 120_000,
    nowMs: () => nowMs, clock: createManualClock(),
  });
  try {
    const result = await worker.requestReconcile("periodic");
    assert.deepEqual(result, { kind: "completed", trigger: "periodic", bindingCount: bindings.length });
    assert.equal(refreshed, bindings.length);
    assert.equal(persisted, bindings.length);
    assert.ok(refreshProgressAtTurn > 0 && refreshProgressAtTurn <= 1_000,
      "resolved audience promises must not starve the first event-loop turn beyond a batch");
    assert.ok(persistProgressAtTurn > 0 && persistProgressAtTurn <= 1_000,
      "resolved persistence promises must not starve the first event-loop turn beyond a batch");
  } finally {
    worker.stop();
  }
});


test("lifecycle CPU projections yield before processing more than one batch", async () => {
  const rows = Array.from({ length: 2_001 }, (_, index) => index);
  let projected = 0;
  let progressAtTurn = 0;
  const result = await mapSlackBridgeLifecycleBatches(rows, (row) => {
    projected += 1;
    if (projected === 1) setImmediate(() => { progressAtTurn = projected; });
    return row + 1;
  });
  assert.equal(result.length, rows.length);
  assert.equal(result[0], 1);
  assert.equal(result.at(-1), rows.length);
  assert.ok(progressAtTurn > 0 && progressAtTurn <= 1_000,
    "CPU-only projection must let event-loop callbacks run between batches");
});

test("two replicas share one maintenance pass before any state or provider work", async () => {
  let claimed = false;
  let ended = 0;
  let loads = 0;
  let refreshed = 0;
  const options = {
    intervalMs: 1_000, probeFreshnessMs: 60_000,
    maxPendingEvents: 50, maxOldestPendingEventAgeMs: 120_000,
    nowMs: () => nowMs, clock: createManualClock(),
  };
  const dependencies = {
    async claimRun() {
      if (claimed) return null;
      claimed = true;
      return { held: async () => true, end() { ended += 1; } };
    },
    async loadBindings() { loads += 1; return [activeBinding()]; },
    async refreshAudience(binding: SlackBridgeBindingRuntime) {
      refreshed += 1;
      return { bindingId: binding.bindingId, audienceStatus: "matched" as const, observedAtMs: nowMs };
    },
    async executeCommand() {},
    async runProbe(request: SlackBridgeProbeRequest) {
      return { surface: request.surface, ok: true, observedAtMs: nowMs, trigger: request.trigger };
    },
    async persistReceipt() {},
  };
  const first = startSlackBridgePersistentWorker(dependencies, { ...options, orchestratorId: "first" });
  const second = startSlackBridgePersistentWorker(dependencies, { ...options, orchestratorId: "second" });
  try {
    await Promise.all([first.requestReconcile("periodic"), second.requestReconcile("periodic")]);
    assert.equal(loads, 1, "the losing replica cannot even load the maintenance inputs");
    assert.equal(refreshed, 1);
    assert.equal(ended, 1, "only the acquired claim stops its renewal");
    claimed = false; // The shared store's spacing window has elapsed.
    await second.requestReconcile("periodic");
    assert.equal(loads, 2, "another replica can take the next maintenance window");
  } finally { first.stop(); second.stop(); }
});

test("a lost maintenance claim stops later bindings and is ended even on load failure", async () => {
  for (const failLoad of [false, true]) {
    let held = true;
    let ended = 0;
    let refreshed = 0;
    const worker = startSlackBridgePersistentWorker({
      claimRun: async () => ({ held: async () => held, end() { ended += 1; } }),
      async loadBindings() {
        if (failLoad) throw new Error("load failed");
        return [activeBinding(), activeBinding({ bindingId: "second" })];
      },
      async refreshAudience(binding) {
        refreshed += 1;
        held = false;
        return { bindingId: binding.bindingId, audienceStatus: "matched", observedAtMs: nowMs };
      },
      async executeCommand() { assert.fail("a lost owner must not execute commands"); },
      async runProbe() { throw new Error("a lost owner must not probe"); },
      async persistReceipt() { assert.fail("a lost owner must not publish receipts"); },
    }, {
      orchestratorId: "owner", intervalMs: 1_000, probeFreshnessMs: 60_000,
      maxPendingEvents: 50, maxOldestPendingEventAgeMs: 120_000,
      nowMs: () => nowMs, clock: createManualClock(),
    });
    try {
      if (failLoad) await assert.rejects(worker.requestReconcile("periodic"), /load failed/);
      else { await worker.requestReconcile("periodic"); assert.equal(refreshed, 1); }
      assert.equal(ended, 1);
    } finally { worker.stop(); }
  }
});
