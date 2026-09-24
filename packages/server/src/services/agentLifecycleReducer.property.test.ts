import assert from "node:assert/strict";
import { test } from "vitest";

// Lifecycle-v2 P1-B harness slice (#458).
//
// This is intentionally behavior-neutral: it codifies the target reducer/model
// contract and RED witness controls without asserting current legacy scaffold
// behavior where #457 source-boundary schema and #459 shadow diff are still
// pending. PR implementation audit:
// - I2: only `reducer` is a semantic writer; projection writer remains a plan
//   applier with no model event input.
// - I3: current-generation observed runtime truth may move both up and down;
//   authority priority only arbitrates same-tick conflicts / non-observed facts.
// - I6: liveness requires observed provenance; synthetic/replayed facts cannot
//   create or refresh liveness.
// - I7: timing uses injected virtual time and deterministic timer ordering.
// Pending ledger: production event provenance/source admission belongs to #457;
// production projection-diff shadowing belongs to #459.
type EventProvenance = "observed" | "synthetic" | "replayed";
type ModelProjection = "offline" | "online" | "idle" | "working" | "thinking" | "error" | "stopping" | "unknown";
type RuntimeTruth = "absent" | "idle" | "working" | "thinking" | "error" | "stopping" | "unknown";
type Writer = "reducer" | "legacy-writer" | "projection-writer";

interface ModelState {
  currentGeneration: string;
  freshnessUpdatedAt: number;
  intent: "running_allowed" | "manual_stopped";
  lastObservedAt: number;
  machineReachability: "local" | "remote-owner" | "disconnected" | "unknown";
  projection: ModelProjection;
  runtime: RuntimeTruth;
  writer: Writer;
}

interface ModelEvent {
  at: number;
  generation?: string;
  kind:
    | "activity"
    | "disconnect"
    | "error"
    | "heartbeat"
    | "launch-signal"
    | "process-liveness"
    | "reconnect"
    | "remote-owner-proof"
    | "repair"
    | "stale-sweep"
    | "stop";
  projection?: ModelProjection;
  provenance: EventProvenance;
  runtime?: RuntimeTruth;
}

interface ModelOptions {
  disconnectGraceMs: number;
  heartbeatStaleMs: number;
  ignoreObservedProcessLiveness?: boolean;
  ignoreRemoteOwnerInSweep?: boolean;
  observedSignalsUsePriorityRatchet?: boolean;
  probeTimeoutMs: number;
  staleHeartbeatReplayRefreshes?: boolean;
  staleLaunchClearsNonStarting?: boolean;
  staleLaunchPromotes?: boolean;
  syntheticMayUpgrade?: boolean;
  treatMissingLocalAsDead?: boolean;
  useLastWriteWinsPriority?: boolean;
}

const contractOptions: ModelOptions = {
  disconnectGraceMs: 2_000,
  heartbeatStaleMs: 15 * 60_000,
  probeTimeoutMs: 1_000,
};

const baseState: ModelState = {
  currentGeneration: "launch-new",
  freshnessUpdatedAt: 0,
  intent: "running_allowed",
  lastObservedAt: 0,
  machineReachability: "local",
  projection: "working",
  runtime: "working",
  writer: "reducer",
};

const priority: Record<ModelProjection, number> = {
  unknown: 0,
  offline: 1,
  online: 2,
  idle: 3,
  working: 4,
  thinking: 5,
  stopping: 6,
  error: 7,
};

function reduceModel(state: ModelState, event: ModelEvent, options: ModelOptions): ModelState {
  assert.equal(state.writer, "reducer", "I2: only the reducer may own lifecycle semantics");

  const staleGeneration = event.generation !== undefined && event.generation !== state.currentGeneration;
  const syntheticOrReplay = event.provenance !== "observed";
  const next = { ...state };

  if (event.kind === "remote-owner-proof" && event.provenance === "observed") {
    next.machineReachability = "remote-owner";
    return next;
  }

  if (event.kind === "stale-sweep") {
    if (state.machineReachability === "remote-owner" && !options.ignoreRemoteOwnerInSweep) {
      return next;
    }
    if (options.treatMissingLocalAsDead) {
      next.projection = "online";
      next.runtime = "idle";
    } else {
      next.projection = "unknown";
      next.runtime = "unknown";
    }
    return next;
  }

  if (event.kind === "disconnect") {
    next.machineReachability = "disconnected";
    return next;
  }

  if (event.kind === "reconnect" && event.provenance === "observed") {
    next.machineReachability = "local";
    next.projection = state.projection === "offline" ? "online" : state.projection;
    return next;
  }

  if (event.kind === "process-liveness") {
    if (options.ignoreObservedProcessLiveness) {
      return next;
    }
    if (event.provenance !== "observed") {
      return next;
    }
    next.runtime = event.runtime ?? next.runtime;
    if (event.runtime === "absent") {
      next.projection = "unknown";
      next.lastObservedAt = event.at;
    } else if (event.runtime === "working" || event.runtime === "thinking") {
      next.projection = event.runtime;
      next.freshnessUpdatedAt = event.at;
      next.lastObservedAt = event.at;
    }
    return next;
  }

  if (event.kind === "heartbeat") {
    if (event.provenance === "observed" || options.staleHeartbeatReplayRefreshes) {
      next.freshnessUpdatedAt = event.at;
      if (event.projection) {
        next.projection = event.provenance === "observed"
          ? chooseObservedProjection(next, event.projection, event.at, options)
          : event.projection;
        next.runtime = event.projection === "working" || event.projection === "thinking" ? event.projection : next.runtime;
        if (event.provenance === "observed") {
          next.lastObservedAt = Math.max(next.lastObservedAt, event.at);
        }
      }
    }
    return next;
  }

  if (event.kind === "launch-signal" && staleGeneration && !options.staleLaunchPromotes) {
    if (state.projection === "unknown" || options.staleLaunchClearsNonStarting) {
      // `unknown` is the model's Starting affordance; production resolves that
      // visual placeholder to non-busy without letting stale launch truth win.
      next.projection = "idle";
    }
    return next;
  }

  if (syntheticOrReplay && !options.syntheticMayUpgrade) {
    if (event.projection === "unknown") {
      next.projection = "unknown";
      next.runtime = "unknown";
    }
    return next;
  }

  if (event.projection) {
    next.projection = event.provenance === "observed" && !staleGeneration
      ? chooseObservedProjection(next, event.projection, event.at, options)
      : chooseProjection(next.projection, event.projection, options);
    next.runtime = event.runtime ?? projectionToRuntime(next.projection);
    if (event.provenance === "observed" && (next.projection === "working" || next.projection === "thinking")) {
      next.freshnessUpdatedAt = event.at;
    }
    if (event.provenance === "observed" && !staleGeneration) {
      next.lastObservedAt = Math.max(next.lastObservedAt, event.at);
    }
  }

  return next;
}

function chooseObservedProjection(
  current: ModelState,
  incoming: ModelProjection,
  at: number,
  options: ModelOptions,
): ModelProjection {
  if (options.observedSignalsUsePriorityRatchet) {
    return chooseProjection(current.projection, incoming, options);
  }
  if (at > current.lastObservedAt) {
    return incoming;
  }
  return chooseProjection(current.projection, incoming, options);
}

function chooseProjection(current: ModelProjection, incoming: ModelProjection, options: ModelOptions): ModelProjection {
  if (options.useLastWriteWinsPriority) {
    return incoming;
  }
  return priority[incoming] >= priority[current] ? incoming : current;
}

function projectionToRuntime(projection: ModelProjection): RuntimeTruth {
  if (projection === "idle") return "idle";
  if (projection === "working") return "working";
  if (projection === "thinking") return "thinking";
  if (projection === "error") return "error";
  if (projection === "stopping") return "stopping";
  if (projection === "offline") return "absent";
  return "unknown";
}

function runWitness(events: ModelEvent[], options: ModelOptions = contractOptions, initial: ModelState = baseState) {
  return events.reduce((state, event) => reduceModel(state, event, options), initial);
}

function assertNoIllegalState(state: ModelState) {
  assert.equal(state.writer, "reducer", "I2: non-reducer writer produced lifecycle projection");
  assert.notEqual(state.intent === "manual_stopped" && priority[state.projection] >= priority.working, true);
  assert.notEqual(state.machineReachability === "remote-owner" && state.projection === "online", true);
}

class VirtualClock {
  private nextOrder = 0;
  private nowMs = 0;
  private readonly timers: Array<{ at: number; order: number; callback: () => void }> = [];

  now() {
    return this.nowMs;
  }

  schedule(delayMs: number, callback: () => void) {
    this.timers.push({ at: this.nowMs + delayMs, order: this.nextOrder++, callback });
  }

  advanceTo(nextNow: number) {
    while (true) {
      this.timers.sort((a, b) => a.at - b.at || a.order - b.order);
      const timer = this.timers[0];
      if (!timer || timer.at > nextNow) break;
      this.timers.shift();
      this.nowMs = timer.at;
      timer.callback();
    }
    this.nowMs = nextNow;
  }
}

test("property 1 (#448): remote-owner sweep preserves busy truth and has a dead-sweep witness", () => {
  const positive = runWitness([
    { at: 1, kind: "remote-owner-proof", provenance: "observed" },
    { at: contractOptions.heartbeatStaleMs + 1, kind: "stale-sweep", provenance: "synthetic" },
  ]);
  assert.equal(positive.projection, "working");
  assert.equal(positive.machineReachability, "remote-owner");
  assertNoIllegalState(positive);

  const negative = runWitness([
    { at: contractOptions.heartbeatStaleMs + 1, kind: "stale-sweep", provenance: "synthetic" },
  ]);
  assert.equal(negative.projection, "unknown");

  assert.throws(() => {
    const control = runWitness(
      [
        { at: 1, kind: "remote-owner-proof", provenance: "observed" },
        { at: contractOptions.heartbeatStaleMs + 1, kind: "stale-sweep", provenance: "synthetic" },
      ],
      { ...contractOptions, ignoreRemoteOwnerInSweep: true, treatMissingLocalAsDead: true },
    );
    assert.equal(control.projection, "working", "remote-owner sweep degraded busy state");
  }, /remote-owner/);
});

test("property 2 (#449): virtual disconnect grace is order-sensitive but not immediate-offline", () => {
  const clock = new VirtualClock();
  let state = { ...baseState };
  state = reduceModel(state, { at: clock.now(), kind: "disconnect", provenance: "observed" }, contractOptions);
  clock.schedule(contractOptions.disconnectGraceMs, () => {
    if (state.machineReachability === "disconnected") {
      state = { ...state, projection: "offline", runtime: "absent" };
    }
  });
  clock.advanceTo(1_000);
  state = reduceModel(state, { at: clock.now(), kind: "reconnect", provenance: "observed" }, contractOptions);
  clock.advanceTo(2_001);
  assert.equal(state.projection, "working");
  assert.equal(state.machineReachability, "local");

  const negativeClock = new VirtualClock();
  let negative = { ...baseState };
  negative = reduceModel(negative, { at: negativeClock.now(), kind: "disconnect", provenance: "observed" }, contractOptions);
  negativeClock.schedule(contractOptions.disconnectGraceMs, () => {
    if (negative.machineReachability === "disconnected") {
      negative = { ...negative, projection: "offline", runtime: "absent" };
    }
  });
  negativeClock.advanceTo(2_001);
  assert.equal(negative.projection, "offline");

  const immediate = runWitness([{ at: 0, kind: "disconnect", projection: "offline", provenance: "observed" }]);
  assert.notEqual(immediate.projection, "offline", "control witness: immediate offline would violate grace");
});

test("property 3 (#450): stale launch signals may clear Starting affordance but not promote runtime truth", () => {
  const startingState: ModelState = { ...baseState, projection: "unknown", runtime: "unknown" };
  const positive = runWitness(
    [{ at: 10, generation: "launch-old", kind: "launch-signal", projection: "working", provenance: "observed" }],
    contractOptions,
    startingState,
  );
  assert.equal(positive.projection, "idle");
  assert.equal(positive.runtime, "unknown");

  const negative = runWitness(
    [{ at: 10, generation: "launch-new", kind: "launch-signal", projection: "working", provenance: "observed" }],
    contractOptions,
    startingState,
  );
  assert.equal(negative.projection, "working");

  assert.throws(() => {
    const control = runWitness(
      [{ at: 10, generation: "launch-old", kind: "launch-signal", projection: "working", provenance: "observed" }],
      { ...contractOptions, staleLaunchPromotes: true },
      startingState,
    );
    assert.notEqual(control.projection, "working", "stale generation promoted runtime truth");
  }, /stale generation/);
});

test("property 4 (#452): quiet but observed-alive runtime stays live without synthetic liveness", () => {
  const positive = runWitness([
    { at: contractOptions.heartbeatStaleMs + 1, kind: "process-liveness", provenance: "observed", runtime: "working" },
  ]);
  assert.equal(positive.projection, "working");
  assert.equal(positive.freshnessUpdatedAt, contractOptions.heartbeatStaleMs + 1);

  const negative = runWitness([
    { at: contractOptions.heartbeatStaleMs + 1, kind: "process-liveness", provenance: "observed", runtime: "absent" },
  ]);
  assert.equal(negative.projection, "unknown");

  assert.throws(() => {
    const control = runWitness(
      [{ at: contractOptions.heartbeatStaleMs + 1, kind: "process-liveness", provenance: "observed", runtime: "working" }],
      { ...contractOptions, ignoreObservedProcessLiveness: true },
      { ...baseState, freshnessUpdatedAt: -1, projection: "unknown", runtime: "unknown" },
    );
    assert.equal(control.projection, "working", "observed process liveness was ignored");
  }, /observed process liveness/);
});

test("property 5 (I6): replayed heartbeat cannot refresh liveness", () => {
  const positive = runWitness([
    { at: contractOptions.heartbeatStaleMs + 1, kind: "heartbeat", projection: "working", provenance: "replayed" },
  ]);
  assert.equal(positive.freshnessUpdatedAt, 0);
  assert.equal(positive.projection, "working");

  const negative = runWitness([
    { at: contractOptions.heartbeatStaleMs + 1, kind: "heartbeat", projection: "working", provenance: "observed" },
  ]);
  assert.equal(negative.freshnessUpdatedAt, contractOptions.heartbeatStaleMs + 1);

  assert.throws(() => {
    const control = runWitness(
      [{ at: contractOptions.heartbeatStaleMs + 1, kind: "heartbeat", projection: "working", provenance: "replayed" }],
      { ...contractOptions, staleHeartbeatReplayRefreshes: true },
    );
    assert.equal(control.freshnessUpdatedAt, 0, "replayed heartbeat refreshed liveness");
  }, /replayed heartbeat/);
});

test("property 6 (I7): virtual timing relations and timer ordering are injected", () => {
  assert.equal(contractOptions.heartbeatStaleMs > contractOptions.probeTimeoutMs, true);
  assert.equal(contractOptions.disconnectGraceMs > contractOptions.probeTimeoutMs, true);

  const clock = new VirtualClock();
  const fired: string[] = [];
  clock.schedule(contractOptions.probeTimeoutMs, () => fired.push("probe-timeout"));
  clock.schedule(contractOptions.disconnectGraceMs, () => fired.push("disconnect-grace"));
  clock.advanceTo(contractOptions.probeTimeoutMs - 1);
  assert.deepEqual(fired, []);
  clock.advanceTo(contractOptions.probeTimeoutMs);
  assert.deepEqual(fired, ["probe-timeout"]);
  clock.advanceTo(contractOptions.disconnectGraceMs);
  assert.deepEqual(fired, ["probe-timeout", "disconnect-grace"]);

  assert.throws(() => {
    const control = { ...contractOptions, disconnectGraceMs: 500 };
    assert.equal(control.disconnectGraceMs > control.probeTimeoutMs, true, "disconnect grace fired before probe timeout");
  }, /disconnect grace/);
});

test("property 7: synthetic and repair provenance cannot create liveness or promote state", () => {
  const uncertain: ModelState = { ...baseState, projection: "unknown", runtime: "unknown", freshnessUpdatedAt: 0 };
  const positive = runWitness(
    [{ at: 1, kind: "repair", projection: "online", provenance: "synthetic" }],
    contractOptions,
    uncertain,
  );
  assert.equal(positive.projection, "unknown");
  assert.equal(positive.freshnessUpdatedAt, 0);

  const negative = runWitness(
    [{ at: 1, kind: "activity", projection: "online", provenance: "observed" }],
    contractOptions,
    uncertain,
  );
  assert.equal(negative.projection, "online");

  assert.throws(() => {
    const control = runWitness(
      [{ at: 1, kind: "repair", projection: "online", provenance: "synthetic" }],
      { ...contractOptions, syntheticMayUpgrade: true },
      uncertain,
    );
    assert.equal(control.projection, "unknown", "synthetic provenance promoted to online");
  }, /synthetic provenance/);
});

test("property 8 (I3): authority priority arbitrates same-tick conflicts across adversarial orderings", () => {
  const errorThenWorking = runWitness([
    { at: 1, kind: "error", projection: "error", provenance: "observed" },
    { at: 1, kind: "activity", projection: "working", provenance: "observed" },
  ]);
  const workingThenError = runWitness([
    { at: 1, kind: "activity", projection: "working", provenance: "observed" },
    { at: 1, kind: "error", projection: "error", provenance: "observed" },
  ]);
  assert.equal(errorThenWorking.projection, "error");
  assert.equal(workingThenError.projection, "error");

  const stoppingThenOnline = runWitness([
    { at: 1, kind: "stop", projection: "stopping", provenance: "observed" },
    { at: 1, kind: "activity", projection: "online", provenance: "observed" },
  ]);
  assert.equal(stoppingThenOnline.projection, "stopping");

  assert.throws(() => {
    const control = runWitness(
      [
        { at: 1, kind: "error", projection: "error", provenance: "observed" },
        { at: 1, kind: "activity", projection: "working", provenance: "observed" },
      ],
      { ...contractOptions, useLastWriteWinsPriority: true },
    );
    assert.equal(control.projection, "error", "last-write-wins let lower-priority working override error");
  }, /last-write-wins/);
});

test("property 9 (I3): fresh observed same-generation runtime truth may legally downgrade", () => {
  const turnEnd = runWitness([
    { at: 1, kind: "activity", projection: "working", provenance: "observed" },
    { at: 2, kind: "activity", projection: "idle", provenance: "observed" },
  ]);
  assert.equal(turnEnd.projection, "idle");
  assert.equal(turnEnd.runtime, "idle");
  assert.equal(turnEnd.lastObservedAt, 2);

  const recoveredFromError = runWitness([
    { at: 1, kind: "error", projection: "error", provenance: "observed" },
    { at: 2, kind: "activity", projection: "idle", provenance: "observed" },
  ]);
  assert.equal(recoveredFromError.projection, "idle");

  const staleLaunchDoesNotDemoteLiveRuntime = runWitness([
    { at: 1, kind: "activity", projection: "working", provenance: "observed" },
    { at: 1, generation: "launch-old", kind: "launch-signal", projection: "idle", provenance: "observed" },
  ]);
  assert.equal(staleLaunchDoesNotDemoteLiveRuntime.projection, "working");
  assert.equal(staleLaunchDoesNotDemoteLiveRuntime.runtime, "working");

  assert.throws(() => {
    const control = runWitness(
      [
        { at: 1, kind: "activity", projection: "working", provenance: "observed" },
        { at: 2, kind: "activity", projection: "idle", provenance: "observed" },
      ],
      { ...contractOptions, observedSignalsUsePriorityRatchet: true },
    );
    assert.equal(control.projection, "idle", "observed same-generation downgrade was forced through priority ratchet");
  }, /priority ratchet/);

  assert.throws(() => {
    const control = runWitness(
      [
        { at: 1, kind: "activity", projection: "working", provenance: "observed" },
        { at: 1, generation: "launch-old", kind: "launch-signal", projection: "idle", provenance: "observed" },
      ],
      { ...contractOptions, staleLaunchClearsNonStarting: true },
    );
    assert.equal(control.projection, "working", "stale launch cleanup demoted a non-Starting live runtime");
  }, /non-Starting live runtime/);
});
