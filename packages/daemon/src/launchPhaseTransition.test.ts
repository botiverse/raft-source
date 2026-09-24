import { test } from "vitest";
import assert from "node:assert/strict";

import {
  LAUNCH_RUNTIME_READINESS_TRANSITION_SPAN,
  assertLaunchReadinessPairing,
  buildLaunchReadinessCloseAttrs,
  buildLaunchReadinessEnterAttrs,
  launchReadinessNegativeEvidence,
  type LaunchIdentityAttrs,
  type LaunchReadinessTransitionState,
  type LaunchTransitionRow,
} from "./launchPhaseTransition.js";

function identity(overrides: Partial<LaunchIdentityAttrs> = {}): LaunchIdentityAttrs {
  return {
    agent_launch_id: "launch-1",
    agent_id: "agent-1",
    server_id: "server-1",
    machine_id: "machine-1",
    runtime: "codex",
    driver: "codex",
    launch_source: "wake_message",
    ...overrides,
  };
}

function transition(overrides: Partial<LaunchReadinessTransitionState> = {}): LaunchReadinessTransitionState {
  const id = overrides.identity ?? identity();
  return {
    stateInstanceId: "state-1",
    enterSeq: 0,
    identity: id,
    fenceKind: "runtime_startup_timeout",
    deadlineUnixMs: 1_000,
    negativeEvidenceBucket: launchReadinessNegativeEvidence(id),
    ...overrides,
  };
}

function rowsFor(state: LaunchReadinessTransitionState, closeResult: Parameters<typeof buildLaunchReadinessCloseAttrs>[1] = "advanced"): LaunchTransitionRow[] {
  return [
    { name: LAUNCH_RUNTIME_READINESS_TRANSITION_SPAN, attrs: buildLaunchReadinessEnterAttrs(state) },
    { name: LAUNCH_RUNTIME_READINESS_TRANSITION_SPAN, attrs: buildLaunchReadinessCloseAttrs(state, closeResult, state.enterSeq + 1) },
  ];
}

test("enter row carries identity spine + wait-state fence contract", () => {
  const attrs = buildLaunchReadinessEnterAttrs(transition());
  assert.equal(attrs.span_name, LAUNCH_RUNTIME_READINESS_TRANSITION_SPAN);
  assert.equal(attrs.phase, "runtime_readiness");
  assert.equal(attrs.transition_kind, "enter");
  assert.equal(attrs.phase_result, "entered");
  assert.equal(attrs.state, "awaiting_runtime_ready");
  assert.equal(attrs.state_instance_id, "state-1");
  assert.equal(attrs.transition_seq, 0);
  assert.equal(attrs.is_wait_state, true);
  assert.equal(attrs.fence_kind, "runtime_startup_timeout");
  assert.equal(attrs.deadline_unix_ms, 1_000);
  // identity spine
  assert.equal(attrs.agent_launch_id, "launch-1");
  assert.equal(attrs.agent_id, "agent-1");
  assert.equal(attrs.server_id, "server-1");
  assert.equal(attrs.machine_id, "machine-1");
  assert.equal(attrs.runtime, "codex");
  assert.equal(attrs.driver, "codex");
  assert.equal(attrs.launch_source, "wake_message");
  assert.equal(attrs.negative_evidence_bucket, undefined);
});

test("close row keeps pairing key + closed close_result", () => {
  const state = transition();
  const attrs = buildLaunchReadinessCloseAttrs(state, "timeout", 1);
  assert.equal(attrs.transition_kind, "close");
  assert.equal(attrs.state_instance_id, "state-1");
  assert.equal(attrs.transition_seq, 1);
  assert.equal(attrs.close_result, "timeout");
});

test("missing launch id flags negative evidence on enter and close", () => {
  const state = transition({ identity: identity({ agent_launch_id: null }) });
  assert.equal(state.negativeEvidenceBucket, "missing_launch_id");
  const enter = buildLaunchReadinessEnterAttrs(state);
  const close = buildLaunchReadinessCloseAttrs(state, "lineage_failed", 1);
  assert.equal(enter.negative_evidence_bucket, "missing_launch_id");
  assert.equal(close.negative_evidence_bucket, "missing_launch_id");
  assert.equal(enter.agent_launch_id, null);
});

test("valid enter+close pairing passes the contract assertion", () => {
  assert.doesNotThrow(() => assertLaunchReadinessPairing("valid", rowsFor(transition())));
});

test("multiple distinct launches each pair independently", () => {
  const a = transition({ stateInstanceId: "s-a", enterSeq: 0, identity: identity({ agent_launch_id: "launch-a" }) });
  const b = transition({ stateInstanceId: "s-b", enterSeq: 2, identity: identity({ agent_launch_id: "launch-b" }) });
  const rows = [
    { name: LAUNCH_RUNTIME_READINESS_TRANSITION_SPAN, attrs: buildLaunchReadinessEnterAttrs(a) },
    { name: LAUNCH_RUNTIME_READINESS_TRANSITION_SPAN, attrs: buildLaunchReadinessEnterAttrs(b) },
    { name: LAUNCH_RUNTIME_READINESS_TRANSITION_SPAN, attrs: buildLaunchReadinessCloseAttrs(a, "advanced", 1) },
    { name: LAUNCH_RUNTIME_READINESS_TRANSITION_SPAN, attrs: buildLaunchReadinessCloseAttrs(b, "terminal", 3) },
  ];
  assert.doesNotThrow(() => assertLaunchReadinessPairing("two-launch", rows));
});

// --- RED cases: the contract assertion must catch each violation ---

test("RED: enter without close is caught", () => {
  const rows = [{ name: LAUNCH_RUNTIME_READINESS_TRANSITION_SPAN, attrs: buildLaunchReadinessEnterAttrs(transition()) }];
  assert.throws(() => assertLaunchReadinessPairing("no-close", rows), /exactly-one close/);
});

test("RED: double close is caught", () => {
  const state = transition();
  const rows = [
    { name: LAUNCH_RUNTIME_READINESS_TRANSITION_SPAN, attrs: buildLaunchReadinessEnterAttrs(state) },
    { name: LAUNCH_RUNTIME_READINESS_TRANSITION_SPAN, attrs: buildLaunchReadinessCloseAttrs(state, "advanced", 1) },
    { name: LAUNCH_RUNTIME_READINESS_TRANSITION_SPAN, attrs: buildLaunchReadinessCloseAttrs(state, "terminal", 2) },
  ];
  assert.throws(() => assertLaunchReadinessPairing("double-close", rows), /exactly-one close/);
});

test("RED: close without enter is caught", () => {
  const rows = [{ name: LAUNCH_RUNTIME_READINESS_TRANSITION_SPAN, attrs: buildLaunchReadinessCloseAttrs(transition(), "advanced", 1) }];
  assert.throws(() => assertLaunchReadinessPairing("orphan-close", rows), /close without enter/);
});

test("RED: reused transition_seq is caught (ordering must be unique)", () => {
  const state = transition();
  const rows = [
    { name: LAUNCH_RUNTIME_READINESS_TRANSITION_SPAN, attrs: buildLaunchReadinessEnterAttrs(state) },
    // close reusing the enter's seq (0) violates monotonic/unique ordering
    { name: LAUNCH_RUNTIME_READINESS_TRANSITION_SPAN, attrs: buildLaunchReadinessCloseAttrs(state, "advanced", 0) },
  ];
  assert.throws(() => assertLaunchReadinessPairing("reused-seq", rows), /reused/);
});

test("RED: forbidden raw attr key is caught (Q8 scrub)", () => {
  const state = transition();
  const enter = buildLaunchReadinessEnterAttrs(state);
  const leaked = { ...enter, prompt_text: "do not leak this" };
  const rows = [
    { name: LAUNCH_RUNTIME_READINESS_TRANSITION_SPAN, attrs: leaked },
    { name: LAUNCH_RUNTIME_READINESS_TRANSITION_SPAN, attrs: buildLaunchReadinessCloseAttrs(state, "advanced", 1) },
  ];
  assert.throws(() => assertLaunchReadinessPairing("q8", rows), /forbidden attr/);
});

test("built-in enter/close attrs never trip the Q8 forbidden scan", () => {
  // The closed attr set produced by the builders must be scrub-clean for every
  // close_result, including the negative-evidence (missing launch id) shape.
  assert.doesNotThrow(() => assertLaunchReadinessPairing("builder-scrub-advanced", rowsFor(transition(), "advanced")));
  assert.doesNotThrow(() => assertLaunchReadinessPairing("builder-scrub-terminal", rowsFor(transition(), "terminal")));
  const missing = transition({ identity: identity({ agent_launch_id: null }) });
  assert.doesNotThrow(() => assertLaunchReadinessPairing("builder-scrub-missing-launch", rowsFor(missing, "lineage_failed")));
});

// --- Phase 6: activation delivery contract ---
import {
  LAUNCH_ACTIVATION_DELIVERY_TRANSITION_SPAN,
  assertLaunchActivationPairing,
  buildLaunchActivationCloseAttrs,
  buildLaunchActivationEnterAttrs,
  type LaunchActivationTransitionState,
  type LaunchDeliveredVia,
} from "./launchPhaseTransition.js";

function activationState(overrides: Partial<LaunchActivationTransitionState> = {}): LaunchActivationTransitionState {
  const id = overrides.identity ?? identity();
  return {
    stateInstanceId: "act-1",
    enterSeq: 0,
    identity: id,
    negativeEvidenceBucket: launchReadinessNegativeEvidence(id),
    ...overrides,
  };
}

function activationRows(state: LaunchActivationTransitionState, closeResult: Parameters<typeof buildLaunchActivationCloseAttrs>[1] = "advanced", deliveredVia: LaunchDeliveredVia | undefined = "spawn_prompt"): LaunchTransitionRow[] {
  return [
    { name: LAUNCH_ACTIVATION_DELIVERY_TRANSITION_SPAN, attrs: buildLaunchActivationEnterAttrs(state) },
    { name: LAUNCH_ACTIVATION_DELIVERY_TRANSITION_SPAN, attrs: buildLaunchActivationCloseAttrs(state, closeResult, state.enterSeq + 1, deliveredVia) },
  ];
}

test("activation enter row carries identity spine + wait-state contract", () => {
  const attrs = buildLaunchActivationEnterAttrs(activationState());
  assert.equal(attrs.span_name, LAUNCH_ACTIVATION_DELIVERY_TRANSITION_SPAN);
  assert.equal(attrs.phase, "activation_delivery");
  assert.equal(attrs.transition_kind, "enter");
  assert.equal(attrs.state, "awaiting_activation_delivery");
  assert.equal(attrs.state_instance_id, "act-1");
  assert.equal(attrs.is_wait_state, true);
  assert.equal(attrs.fence_kind, "none");
  assert.equal(attrs.agent_launch_id, "launch-1");
  assert.equal(attrs.agent_id, "agent-1");
});

test("activation close row keeps delivered_via + closed close_result", () => {
  const spawn = buildLaunchActivationCloseAttrs(activationState(), "advanced", 1, "spawn_prompt");
  assert.equal(spawn.transition_kind, "close");
  assert.equal(spawn.close_result, "advanced");
  assert.equal(spawn.delivered_via, "spawn_prompt");
  const stdin = buildLaunchActivationCloseAttrs(activationState(), "advanced", 1, "stdin");
  assert.equal(stdin.delivered_via, "stdin");
  const terminal = buildLaunchActivationCloseAttrs(activationState(), "terminal", 1);
  assert.equal(terminal.close_result, "terminal");
  assert.equal(terminal.delivered_via, undefined);
});

test("valid activation enter+close pairing passes", () => {
  assert.doesNotThrow(() => assertLaunchActivationPairing("act-valid", activationRows(activationState())));
  assert.doesNotThrow(() => assertLaunchActivationPairing("act-stdin", activationRows(activationState(), "advanced", "stdin")));
  assert.doesNotThrow(() => assertLaunchActivationPairing("act-terminal", activationRows(activationState(), "terminal", undefined)));
});

test("RED: activation enter without close is caught", () => {
  const rows = [{ name: LAUNCH_ACTIVATION_DELIVERY_TRANSITION_SPAN, attrs: buildLaunchActivationEnterAttrs(activationState()) }];
  assert.throws(() => assertLaunchActivationPairing("act-no-close", rows), /exactly-one close/);
});

test("RED: activation double close is caught", () => {
  const s = activationState();
  const rows = [
    { name: LAUNCH_ACTIVATION_DELIVERY_TRANSITION_SPAN, attrs: buildLaunchActivationEnterAttrs(s) },
    { name: LAUNCH_ACTIVATION_DELIVERY_TRANSITION_SPAN, attrs: buildLaunchActivationCloseAttrs(s, "advanced", 1, "stdin") },
    { name: LAUNCH_ACTIVATION_DELIVERY_TRANSITION_SPAN, attrs: buildLaunchActivationCloseAttrs(s, "terminal", 2) },
  ];
  assert.throws(() => assertLaunchActivationPairing("act-double", rows), /exactly-one close/);
});

test("activation builder attrs never trip the Q8 forbidden scan (delivered_via=spawn_prompt is a closed value, not a key)", () => {
  // "spawn_prompt" contains "prompt" but it's a closed enum VALUE under the
  // delivered_via key; the scrub scan is key-based, so this must pass.
  assert.doesNotThrow(() => assertLaunchActivationPairing("act-q8", activationRows(activationState(), "advanced", "spawn_prompt")));
});

test("readiness and activation rows in one export pair independently by span", () => {
  const rRows = rowsFor(transition());
  const aRows = activationRows(activationState({ stateInstanceId: "act-x" }), "advanced", "stdin");
  const all = [...rRows, ...aRows];
  assert.doesNotThrow(() => assertLaunchReadinessPairing("mixed", all));
  assert.doesNotThrow(() => assertLaunchActivationPairing("mixed", all));
});
