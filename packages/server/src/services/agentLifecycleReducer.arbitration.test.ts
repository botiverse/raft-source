import assert from "node:assert/strict";
import { test } from "vitest";

import {
  arbitrateLifecycleProjection,
  foldLifecycleArbitration,
  LIFECYCLE_AUTHORITY_PRIORITY,
  type LifecycleArbitrationSignal,
  type LifecycleArbitrationState,
  type LifecycleArbitrationVerdict,
  type LifecycleCanonicalProjection,
  type LifecycleObservationClass,
} from "./agentLifecycleReducer.js";

// Lifecycle-v2 P1 binding tests (task #460, PR-alpha).
//
// Truth surface: production `arbitrateLifecycleProjection` /
// `foldLifecycleArbitration` outputs only. No broadcast, trace-row, or mock
// proxies appear in any assertion.
//
// These tests REPLAY the #3829 spec witnesses (agentLifecycleReducer.property
// .test.ts, merged 33a267b5) against the production arbitration kernel. The
// spec file stays the single spec source and is not edited here; witnesses are
// restated in the spec's own event vocabulary and mapped through a test-side
// adapter to the #457 reducer-facing shape (launchGeneration /
// observationClass / atMs). Adapter fidelity has its own proofs below so the
// binding cannot pass on a distorted input stream.
//
// Direction-symmetry obligation: every comparison/priority witness binds both
// directions (upgrade and downgrade, A-then-B and B-then-A).
//
// RED discipline: reference mutants (last-write-wins, priority ratchet,
// unconditional stale cleanup, synthetic upgrade) run through the SAME binding
// assertions and must fail deterministically. Mutation-on-demand against the
// real production function (docs/sops/mutation-evidence.md) is recorded in the PR
// body as the production-surface RED proof.

// --- Spec-side witness vocabulary (mirrors #3829 ModelEvent rows) -----------

interface SpecWitnessEvent {
  at: number;
  generation?: string;
  projection: LifecycleCanonicalProjection;
  provenance: "observed" | "synthetic" | "replayed";
}

const SPEC_BASE_STATE = {
  currentGeneration: "launch-new",
  lastObservedAt: 0,
  projection: "working" as LifecycleCanonicalProjection,
  startingAffordance: false,
};

// The spec model writes the Starting affordance as projection "unknown"; the
// production shape carries it as an explicit fail-closed bit (production
// truth: activity==working && detailKind in {starting, runtime_starting}).
// The adapter maps the spec's Starting state to the explicit bit — it never
// infers the bit from "unknown".
const SPEC_STARTING_STATE = {
  currentGeneration: "launch-new",
  lastObservedAt: 0,
  projection: "unknown" as LifecycleCanonicalProjection,
  startingAffordance: true,
};

// An unknown that is NOT a Starting spinner (e.g. observed-absent runtime).
// Stale launch noise must preserve it, not "resolve" it.
const SPEC_ABSENT_UNKNOWN_STATE = {
  currentGeneration: "launch-new",
  lastObservedAt: 0,
  projection: "unknown" as LifecycleCanonicalProjection,
  startingAffordance: false,
};

// --- Test-side adapter: spec witness -> #457 reducer-facing shape -----------

function adaptState(spec: typeof SPEC_BASE_STATE): LifecycleArbitrationState {
  return {
    currentLaunchGeneration: spec.currentGeneration,
    lastObservedAtMs: spec.lastObservedAt,
    projection: spec.projection,
    startingAffordance: spec.startingAffordance,
  };
}

function adaptEvent(event: SpecWitnessEvent): LifecycleArbitrationSignal {
  return {
    atMs: event.at,
    launchGeneration: event.generation ?? null,
    observationClass: event.provenance,
    projection: event.projection,
  };
}

function invertEvent(signal: LifecycleArbitrationSignal): SpecWitnessEvent {
  return {
    at: signal.atMs,
    ...(signal.launchGeneration != null ? { generation: signal.launchGeneration } : {}),
    projection: signal.projection,
    provenance: signal.observationClass as SpecWitnessEvent["provenance"],
  };
}

type Kernel = (
  state: LifecycleArbitrationState,
  signal: LifecycleArbitrationSignal,
) => LifecycleArbitrationVerdict;

function runWitness(
  events: SpecWitnessEvent[],
  initial: typeof SPEC_BASE_STATE = SPEC_BASE_STATE,
  kernel: Kernel = arbitrateLifecycleProjection,
): LifecycleArbitrationState {
  let state = adaptState(initial);
  for (const event of events) {
    const signal = adaptEvent(event);
    const verdict = kernel(state, signal);
    const observedAdmitted = verdict.action === "replace" || verdict.action === "arbitrate";
    state = {
      currentLaunchGeneration: state.currentLaunchGeneration,
      lastObservedAtMs: observedAdmitted ? Math.max(state.lastObservedAtMs, signal.atMs) : state.lastObservedAtMs,
      projection: verdict.projection,
      startingAffordance:
        observedAdmitted || verdict.action === "resolve_starting" ? false : state.startingAffordance,
    };
  }
  return state;
}

// --- Adapter fidelity proofs (binding is only as honest as the adapter) -----

const FIDELITY_SAMPLE: SpecWitnessEvent[] = [
  { at: 1, projection: "working", provenance: "observed" },
  { at: 2, generation: "launch-old", projection: "idle", provenance: "observed" },
  { at: 3, projection: "online", provenance: "synthetic" },
  { at: 4, projection: "working", provenance: "replayed" },
  { at: 5, generation: "launch-new", projection: "unknown", provenance: "synthetic" },
];

test("adapter fidelity: round-trip identity over provenance/generation/time/projection", () => {
  for (const event of FIDELITY_SAMPLE) {
    assert.deepEqual(invertEvent(adaptEvent(event)), event);
  }
});

test("adapter fidelity: per-field mapping is exact, never defaulted", () => {
  for (const event of FIDELITY_SAMPLE) {
    const signal = adaptEvent(event);
    assert.equal(signal.atMs, event.at);
    assert.equal(signal.observationClass, event.provenance);
    assert.equal(signal.projection, event.projection);
    assert.equal(signal.launchGeneration, event.generation ?? null);
  }
  // The Starting affordance is carried explicitly, never inferred from
  // projection "unknown" (production truth: working + starting detailKind).
  assert.equal(adaptState(SPEC_STARTING_STATE).startingAffordance, true);
  assert.equal(adaptState(SPEC_ABSENT_UNKNOWN_STATE).startingAffordance, false);
  assert.equal(adaptState(SPEC_BASE_STATE).startingAffordance, false);
});

test("adapter fidelity RED: a provenance-dropping adapter is caught by the prop7 binding", () => {
  const provenanceDroppingAdapt = (event: SpecWitnessEvent): LifecycleArbitrationSignal => ({
    ...adaptEvent(event),
    observationClass: "observed" as LifecycleObservationClass,
  });
  const uncertain = { ...SPEC_BASE_STATE, projection: "unknown" as LifecycleCanonicalProjection };
  const distorted = arbitrateLifecycleProjection(
    adaptState(uncertain),
    provenanceDroppingAdapt({ at: 1, projection: "online", provenance: "synthetic" }),
  );
  // The distorted stream upgrades to online; the faithful binding below pins
  // preserve/unknown. If this ever stops diverging, the fidelity proof is dead.
  assert.equal(distorted.projection, "online");
  const faithful = arbitrateLifecycleProjection(
    adaptState(uncertain),
    adaptEvent({ at: 1, projection: "online", provenance: "synthetic" }),
  );
  assert.equal(faithful.action, "preserve");
  assert.equal(faithful.projection, "unknown");
});

test("turn_active authority: delivery-accepted work advances observed freshness and rejects later synthetic idle", () => {
  const initial: LifecycleArbitrationState = {
    currentLaunchGeneration: "launch-new",
    lastObservedAtMs: 0,
    projection: "online",
    startingAffordance: false,
  };
  const turnActive = arbitrateLifecycleProjection(initial, {
    atMs: 10,
    launchGeneration: "launch-new",
    observationClass: "observed_turn_active",
    projection: "working",
  });
  assert.equal(turnActive.action, "replace");
  assert.equal(turnActive.projection, "working");
  assert.equal(turnActive.freshnessAdvanced, true);

  const folded = foldLifecycleArbitration(initial, {
    atMs: 10,
    launchGeneration: "launch-new",
    observationClass: "observed_turn_active",
    projection: "working",
  }).state;
  assert.equal(folded.lastObservedAtMs, 10);
  assert.equal(folded.projection, "working");

  const syntheticIdle = arbitrateLifecycleProjection(folded, {
    atMs: 11,
    launchGeneration: "launch-new",
    observationClass: "synthetic",
    projection: "online",
  });
  assert.equal(syntheticIdle.action, "preserve");
  assert.equal(syntheticIdle.reason, "synthetic_no_authority");
  assert.equal(syntheticIdle.projection, "working");
});

// --- Reference mutants (deterministic RED controls, test-local only) --------

const lastWriteWinsKernel: Kernel = (state, signal) => {
  const verdict = arbitrateLifecycleProjection(state, signal);
  if (verdict.action === "arbitrate") {
    return { ...verdict, projection: signal.projection };
  }
  return verdict;
};

const priorityRatchetKernel: Kernel = (state, signal) => {
  const verdict = arbitrateLifecycleProjection(state, signal);
  if (verdict.action === "replace") {
    const ratcheted =
      LIFECYCLE_AUTHORITY_PRIORITY[signal.projection] >= LIFECYCLE_AUTHORITY_PRIORITY[state.projection]
        ? signal.projection
        : state.projection;
    return { ...verdict, projection: ratcheted };
  }
  return verdict;
};

const unconditionalStaleCleanupKernel: Kernel = (state, signal) => {
  const verdict = arbitrateLifecycleProjection(state, signal);
  if (verdict.action === "preserve" && verdict.reason === "stale_generation") {
    return { action: "resolve_starting", projection: "idle", reason: "stale_generation_starting_cleanup" };
  }
  return verdict;
};

const syntheticUpgradeKernel: Kernel = (state, signal) => {
  const verdict = arbitrateLifecycleProjection(state, signal);
  if (verdict.action === "preserve" && verdict.reason === "synthetic_no_authority") {
    return { action: "replace", freshnessAdvanced: false, projection: signal.projection, reason: "fresh_observed_same_generation" };
  }
  return verdict;
};

const unknownShorthandKernel: Kernel = (state, signal) => {
  const verdict = arbitrateLifecycleProjection(state, signal);
  if (verdict.action === "preserve" && verdict.reason === "stale_generation" && state.projection === "unknown") {
    return { action: "resolve_starting", projection: "idle", reason: "stale_generation_starting_cleanup" };
  }
  return verdict;
};

// --- prop8 binding (I3 same-tick arbitration, both arrival orders) ----------

test("binding prop8: same-tick conflicts resolve by authority table, independent of arrival order", () => {
  const errorThenWorking = runWitness([
    { at: 1, projection: "error", provenance: "observed" },
    { at: 1, projection: "working", provenance: "observed" },
  ]);
  const workingThenError = runWitness([
    { at: 1, projection: "working", provenance: "observed" },
    { at: 1, projection: "error", provenance: "observed" },
  ]);
  assert.equal(errorThenWorking.projection, "error");
  assert.equal(workingThenError.projection, "error");

  const stoppingThenOnline = runWitness([
    { at: 1, projection: "stopping", provenance: "observed" },
    { at: 1, projection: "online", provenance: "observed" },
  ]);
  const onlineThenStopping = runWitness([
    { at: 1, projection: "online", provenance: "observed" },
    { at: 1, projection: "stopping", provenance: "observed" },
  ]);
  assert.equal(stoppingThenOnline.projection, "stopping");
  assert.equal(onlineThenStopping.projection, "stopping");

  assert.throws(() => {
    const mutant = runWitness(
      [
        { at: 1, projection: "error", provenance: "observed" },
        { at: 1, projection: "working", provenance: "observed" },
      ],
      SPEC_BASE_STATE,
      lastWriteWinsKernel,
    );
    assert.equal(mutant.projection, "error", "last-write-wins let working override same-tick error");
  }, /last-write-wins/);
});

// --- prop9 binding (I3 legal movement, BOTH directions) ----------------------

test("binding prop9: fresh observed same-generation truth moves down (turn end, error recovery)", () => {
  const turnEnd = runWitness([
    { at: 1, projection: "working", provenance: "observed" },
    { at: 2, projection: "idle", provenance: "observed" },
  ]);
  assert.equal(turnEnd.projection, "idle");
  assert.equal(turnEnd.lastObservedAtMs, 2);

  const recoveredFromError = runWitness([
    { at: 1, projection: "error", provenance: "observed" },
    { at: 2, projection: "idle", provenance: "observed" },
  ]);
  assert.equal(recoveredFromError.projection, "idle");

  assert.throws(() => {
    const mutant = runWitness(
      [
        { at: 1, projection: "working", provenance: "observed" },
        { at: 2, projection: "idle", provenance: "observed" },
      ],
      SPEC_BASE_STATE,
      priorityRatchetKernel,
    );
    assert.equal(mutant.projection, "idle", "priority ratchet blocked an observed downgrade");
  }, /priority ratchet/);
});

test("binding prop9 (upgrade direction): fresh observed same-generation truth moves up", () => {
  const wake = runWitness([
    { at: 1, projection: "idle", provenance: "observed" },
    { at: 2, projection: "working", provenance: "observed" },
  ]);
  assert.equal(wake.projection, "working");

  const escalated = runWitness([
    { at: 1, projection: "working", provenance: "observed" },
    { at: 2, projection: "error", provenance: "observed" },
  ]);
  assert.equal(escalated.projection, "error");
});

test("binding prop9.1: out-of-order observed delivery uses observed time, not arrival order", () => {
  const staleHighAuthority = runWitness([
    { at: 20, projection: "working", provenance: "observed" },
    { at: 10, projection: "error", provenance: "observed" },
  ]);
  assert.equal(staleHighAuthority.projection, "working", "older observed error must not win by arrival order");
  assert.equal(staleHighAuthority.lastObservedAtMs, 20);

  const deliveredInObservedOrder = runWitness([
    { at: 10, projection: "error", provenance: "observed" },
    { at: 20, projection: "working", provenance: "observed" },
  ]);
  assert.equal(deliveredInObservedOrder.projection, "working", "newer observed working recovers from older error");
  assert.equal(deliveredInObservedOrder.lastObservedAtMs, 20);

  const verdict = arbitrateLifecycleProjection(
    { ...adaptState(SPEC_BASE_STATE), lastObservedAtMs: 20, projection: "working" },
    adaptEvent({ at: 10, projection: "error", provenance: "observed" }),
  );
  assert.equal(verdict.action, "preserve");
  assert.equal(verdict.reason, "stale_observed");
  assert.equal(verdict.projection, "working");
});

// --- prop3 binding (stale-generation scope gate, both directions) -----------

test("binding prop3: stale launch resolves only the Starting affordance", () => {
  const startingCleanup = arbitrateLifecycleProjection(
    adaptState(SPEC_STARTING_STATE),
    adaptEvent({ at: 10, generation: "launch-old", projection: "working", provenance: "observed" }),
  );
  assert.equal(startingCleanup.action, "resolve_starting");
  assert.equal(startingCleanup.projection, "idle");

  const currentGenPromotes = arbitrateLifecycleProjection(
    adaptState(SPEC_STARTING_STATE),
    adaptEvent({ at: 10, generation: "launch-new", projection: "working", provenance: "observed" }),
  );
  assert.equal(currentGenPromotes.projection, "working");
});

test("binding prop3 (fail-closed): unknown without the Starting affordance survives stale launch noise", () => {
  const absentUnknown = runWitness(
    [{ at: 10, generation: "launch-old", projection: "idle", provenance: "observed" }],
    SPEC_ABSENT_UNKNOWN_STATE,
  );
  assert.equal(absentUnknown.projection, "unknown");

  // Fail-closed also means an ABSENT bit is not Starting: a caller that never
  // learned about the affordance field must get preserve, not cleanup.
  const bitAbsent = arbitrateLifecycleProjection(
    { currentLaunchGeneration: "launch-new", lastObservedAtMs: 0, projection: "unknown" },
    adaptEvent({ at: 10, generation: "launch-old", projection: "idle", provenance: "observed" }),
  );
  assert.equal(bitAbsent.action, "preserve");
  assert.equal(bitAbsent.projection, "unknown");

  assert.throws(() => {
    const mutant = runWitness(
      [{ at: 10, generation: "launch-old", projection: "idle", provenance: "observed" }],
      SPEC_ABSENT_UNKNOWN_STATE,
      unknownShorthandKernel,
    );
    assert.equal(mutant.projection, "unknown", "unknown-shorthand treated a non-Starting unknown as Starting");
  }, /unknown-shorthand/);
});

test("binding prop3 (demote direction): stale launch must not demote a live non-Starting projection", () => {
  const liveBusy = runWitness([
    { at: 10, generation: "launch-old", projection: "idle", provenance: "observed" },
  ]);
  assert.equal(liveBusy.projection, "working");

  assert.throws(() => {
    const mutant = runWitness(
      [{ at: 10, generation: "launch-old", projection: "idle", provenance: "observed" }],
      SPEC_BASE_STATE,
      unconditionalStaleCleanupKernel,
    );
    assert.equal(mutant.projection, "working", "unconditional stale cleanup demoted a live projection");
  }, /unconditional stale cleanup/);
});

// --- prop7 binding (synthetic/repair no-authority) ---------------------------

test("binding prop7: synthetic provenance cannot create liveness or promote state", () => {
  const uncertain = { ...SPEC_BASE_STATE, projection: "unknown" as LifecycleCanonicalProjection };
  const synthetic = runWitness(
    [{ at: 1, projection: "online", provenance: "synthetic" }],
    uncertain,
  );
  assert.equal(synthetic.projection, "unknown");
  assert.equal(synthetic.lastObservedAtMs, 0);

  const observedControl = runWitness(
    [{ at: 1, projection: "online", provenance: "observed" }],
    uncertain,
  );
  assert.equal(observedControl.projection, "online");

  const syntheticSurrender = arbitrateLifecycleProjection(
    adaptState(SPEC_BASE_STATE),
    adaptEvent({ at: 1, projection: "unknown", provenance: "synthetic" }),
  );
  assert.equal(syntheticSurrender.action, "degrade_unknown");

  assert.throws(() => {
    const mutant = runWitness(
      [{ at: 1, projection: "online", provenance: "synthetic" }],
      uncertain,
      syntheticUpgradeKernel,
    );
    assert.equal(mutant.projection, "unknown", "synthetic provenance promoted to online");
  }, /synthetic provenance/);
});

// --- prop1 binding (synthetic sweep half) ------------------------------------

test("binding prop1 (kernel half): a synthetic sweep tick cannot normalize stale busy to online", () => {
  const sweep = runWitness([
    { at: 15 * 60_000 + 1, projection: "online", provenance: "synthetic" },
  ]);
  assert.equal(sweep.projection, "working");
});

// --- prop4 binding (kernel half: observed liveness in a quiet window) --------

test("binding prop4 (kernel half): observed process liveness sustains busy; observed absence surrenders it", () => {
  const quietAlive = runWitness([
    { at: 15 * 60_000 + 1, projection: "working", provenance: "observed" },
  ]);
  assert.equal(quietAlive.projection, "working");
  assert.equal(quietAlive.lastObservedAtMs, 15 * 60_000 + 1);

  const observedAbsent = runWitness([
    { at: 15 * 60_000 + 1, projection: "unknown", provenance: "observed" },
  ]);
  assert.equal(observedAbsent.projection, "unknown");
});

// --- prop5 binding (replayed signals cannot refresh liveness) ----------------

test("binding prop5: replayed busy signal preserves display state but never advances observation", () => {
  const replayed = runWitness([
    { at: 15 * 60_000 + 1, projection: "working", provenance: "replayed" },
  ]);
  assert.equal(replayed.projection, "working");
  assert.equal(replayed.lastObservedAtMs, 0);

  const replayedVerdict = arbitrateLifecycleProjection(
    adaptState(SPEC_BASE_STATE),
    adaptEvent({ at: 15 * 60_000 + 1, projection: "working", provenance: "replayed" }),
  );
  assert.equal(replayedVerdict.action, "preserve");

  const observedHeartbeat = arbitrateLifecycleProjection(
    adaptState(SPEC_BASE_STATE),
    adaptEvent({ at: 15 * 60_000 + 1, projection: "working", provenance: "observed" }),
  );
  assert.equal(observedHeartbeat.action, "replace");
  assert.equal(observedHeartbeat.action === "replace" && observedHeartbeat.freshnessAdvanced, true);
});

// --- diagnostic class (production-only: #457 vocabulary, no spec analogue) ---

// The spec model knows three provenances; `diagnostic` exists only in the
// #457 interface (internal RPC / probe-timeout / export rows). This is a
// direct kernel test, not an adapter replay — the adapter must NEVER be able
// to produce it from spec witnesses, which is itself asserted by the fidelity
// round-trip. Contract: diagnostic signals have no projection authority at
// all (no liveness, no promote, no demote, no "Message received" family).
test("kernel: diagnostic provenance has zero projection authority", () => {
  const busy = adaptState(SPEC_BASE_STATE);
  const diagnosticSignal: LifecycleArbitrationSignal = {
    atMs: 10,
    launchGeneration: null,
    observationClass: "diagnostic",
    projection: "online",
  };
  const verdict = arbitrateLifecycleProjection(busy, diagnosticSignal);
  assert.equal(verdict.action, "preserve");
  assert.equal(verdict.projection, "working");
  assert.equal(verdict.action === "preserve" && verdict.reason, "diagnostic_no_authority");

  const folded = foldLifecycleArbitration(busy, diagnosticSignal);
  assert.equal(folded.state.lastObservedAtMs, 0);
  assert.equal(folded.state.projection, "working");

  // Diagnostic surrender-to-unknown is also denied liveness semantics: it may
  // degrade certainty exactly like other non-observed classes, nothing more.
  const degrade = arbitrateLifecycleProjection(busy, { ...diagnosticSignal, projection: "unknown" });
  assert.equal(degrade.action, "degrade_unknown");
});

// --- fold discipline (I2: applier is mechanical) ------------------------------

test("fold: lastObservedAtMs advances only for admitted observed signals", () => {
  const initial = adaptState(SPEC_BASE_STATE);
  const admitted = foldLifecycleArbitration(
    initial,
    adaptEvent({ at: 5, projection: "idle", provenance: "observed" }),
  );
  assert.equal(admitted.state.lastObservedAtMs, 5);
  assert.equal(admitted.state.projection, "idle");

  const rejected = foldLifecycleArbitration(
    initial,
    adaptEvent({ at: 5, projection: "online", provenance: "synthetic" }),
  );
  assert.equal(rejected.state.lastObservedAtMs, 0);
  assert.equal(rejected.state.projection, "working");
});

test("fold: the Starting affordance clears on resolution or admitted projection, persists otherwise", () => {
  const resolved = foldLifecycleArbitration(
    adaptState(SPEC_STARTING_STATE),
    adaptEvent({ at: 10, generation: "launch-old", projection: "working", provenance: "observed" }),
  );
  assert.equal(resolved.verdict.action, "resolve_starting");
  assert.equal(resolved.state.startingAffordance, false);

  const admitted = foldLifecycleArbitration(
    adaptState(SPEC_STARTING_STATE),
    adaptEvent({ at: 10, generation: "launch-new", projection: "working", provenance: "observed" }),
  );
  assert.equal(admitted.state.projection, "working");
  assert.equal(admitted.state.startingAffordance, false);

  const untouched = foldLifecycleArbitration(
    adaptState(SPEC_STARTING_STATE),
    adaptEvent({ at: 10, projection: "online", provenance: "synthetic" }),
  );
  assert.equal(untouched.state.startingAffordance, true);
});

// Pending ledger (binds in PR-beta, not here): prop1 remote-owner/reachability
// half, prop2 disconnect grace timers, prop4 process-liveness ingest path,
// prop6 I7 timing-relation module — all require the shadow wiring / injected
// clock at the orchestrator ingest sites and are declared in the #460
// coverage map as PR-beta scope.
//
// Null-generation semantics (#457 admission territory, named explicitly per
// archer's audit): the kernel's staleness gate requires BOTH generations
// non-null, so a legacy/no-launch cohort (state.currentLaunchGeneration ==
// null) is staleness-blind at this layer. #457 rules fail-closed: canonical
// I1 producers must carry a generation; legacy cohorts ride an explicit
// compat/proxy row and never participate in stale-generation judgment. Once
// #457 finalizes that row, #3829 and this file grow the corresponding
// witnesses.
