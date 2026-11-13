import assert from "node:assert/strict";
import { AGENT_ACTIVITY_DETAIL_KINDS, type AgentActivityDetailKind, type AgentActivityKind } from "@botiverse/raft-shared";
import { createAgentLifecycleEvent } from "./agentLifecycleEvents";
import {
  CANONICAL_DAEMON_ACTIVITY_BY_DETAIL_KIND,
  LEGACY_DAEMON_ACTIVITY_COMPAT_RULE_BY_DETAIL_KIND,
  buildAgentLifecycleStateSnapshot,
  reduceDaemonActivitySignal,
  rewriteDaemonActivityEntries,
  reduceDaemonActivityLifecycle,
  reduceDaemonSessionLifecycle,
  reduceDaemonStatusLifecycle,
  reduceExternalActivityLifecycle,
  reduceSyntheticRepairLifecycle,
  reduceMachineDisconnectLifecycle,
  reduceMachineShutdownLifecycle,
  reduceReadyReconcileLifecycle,
  reduceRuntimeProfileControlLifecycle,
  reduceRuntimeErrorActivityAction,
  runtimeErrorClearsOnlyOnModelOutput,
  isModelOutputRecoveryFrame,
  reduceStartLifecycle,
  reduceStopLifecycle,
  shouldEmitLiveActivity,
} from "./agentLifecycleReducer";

function state(input: Parameters<typeof buildAgentLifecycleStateSnapshot>[0]) {
  return buildAgentLifecycleStateSnapshot({
    machineId: "machine-1",
    ...input,
  });
}

function lifecycleEvent(overrides: Partial<Parameters<typeof createAgentLifecycleEvent>[0]> = {}) {
  return createAgentLifecycleEvent(
    {
      serverId: "server-1",
      agentId: "agent-1",
      machineId: "machine-1",
      eventType: "runtime_interrupted",
      actor: "daemon",
      source: "ready_reconcile",
      reason: "daemon_restart",
      correlationId: "correlation-1",
      occurredAt: "2026-05-13T00:00:00.000Z",
      ...overrides,
    },
    { createId: () => "event-1" },
  );
}

test("ready reconcile reducer keeps manual stopped agents wake-ineligible", () => {
  const plan = reduceReadyReconcileLifecycle({
    action: "force-stop-and-stay-offline",
    activityDedupeKey: "dedupe-1",
    event: lifecycleEvent(),
    state: state({ dbStatus: "stopped" }),
  });

  assert.equal(plan.dbStatus.kind, "skip");
  assert.equal(plan.wakeEligibility.eligible, false);
  assert.equal(plan.wakeEligibility.blockReason, "manual_stopped");
  assert.deepEqual(plan.sideEffects, {
    sendStopToMachine: "best_effort",
    updateCache: { machineId: "machine-1", status: "stopped" },
  });
  assert.deepEqual(plan.liveActivity, {
    kind: "emit",
    activity: "offline",
    detail: "Stopped",
    dedupeKey: "dedupe-1",
    detailKind: "stopped",
  });
});

test("ready reconcile reducer keeps missing active runtime wakeable and online", () => {
  const plan = reduceReadyReconcileLifecycle({
    action: "mark-wakeable-not-running",
    activityDedupeKey: "dedupe-2",
    event: lifecycleEvent(),
    state: state({ dbStatus: "active", runtimeState: "not_running" }),
  });

  assert.deepEqual(plan.dbStatus, {
    kind: "skip",
    skippedReason: "runtime_absent_but_agent_wakeable",
    attrs: { legacy_status: "active", runtime_state: "not_running" },
  });
  assert.deepEqual(plan.wakeEligibility, { eligible: true });
  assert.deepEqual(plan.sideEffects, {
    clearLaunchGuard: true,
    releaseWakeLock: true,
    updateCache: { machineId: "machine-1", runtimeState: "not_running", status: "active" },
  });
  assert.equal(plan.liveActivity.kind, "ready_online");
  assert.equal(plan.activityLog.labelKind, "ready_wakeable_not_running");
});

test("machine disconnect reducer preserves status but blocks wake on reachability", () => {
  const plan = reduceMachineDisconnectLifecycle({
    activityDedupeKey: "disconnect-dedupe",
    event: lifecycleEvent(),
    state: state({
      dbStatus: "active",
      machineReachability: "unreachable",
      runtimeState: "interrupted",
    }),
  });

  assert.equal(plan.dbStatus.kind, "skip");
  assert.equal(plan.dbStatus.attrs?.machine_reachability, "unreachable");
  assert.equal(plan.wakeEligibility.eligible, false);
  assert.equal(plan.wakeEligibility.blockReason, "machine_unreachable");
  assert.equal(plan.liveActivity.kind, "emit");
  assert.equal(plan.liveActivity.kind === "emit" ? plan.liveActivity.detail : null, "Machine disconnected");
});

test("machine shutdown stop row preserves agent status and exposes computer-stopped provenance", () => {
  const plan = reduceMachineShutdownLifecycle({
    activityDedupeKey: "shutdown-dedupe",
    event: lifecycleEvent({
      eventType: "daemon_shutdown",
      actor: "daemon",
      source: "daemon",
      reason: "runtime_exit",
    }),
    shutdownReason: "computer_stop",
    state: state({
      dbStatus: "active",
      runtimeState: "not_running",
    }),
  });

  assert.equal(plan.event.eventType, "daemon_shutdown");
  assert.equal(plan.event.actor, "daemon");
  assert.equal(plan.event.source, "daemon");
  assert.equal(plan.liveActivity.kind, "emit");
  assert.equal(plan.liveActivity.kind === "emit" ? plan.liveActivity.activity : null, "offline");
  assert.equal(plan.liveActivity.kind === "emit" ? plan.liveActivity.detailKind : null, "stopped");
  assert.equal(plan.liveActivity.kind === "emit" ? plan.liveActivity.detail : null, "Computer stopped");
  assert.deepEqual(plan.dbStatus, {
    kind: "skip",
    skippedReason: "machine_shutdown_preserves_agent_status",
    attrs: {
      legacy_status: "active",
      machine_reachability: "unreachable",
      shutdown_reason: "computer_stop",
    },
  });
  assert.equal(plan.activityLog.labelKind, "stopped");
  assert.deepEqual(plan.activityLog.attrs, {
    legacy_status: "active",
    machine_reachability: "unreachable",
    shutdown_reason: "computer_stop",
    stop_source: "computer",
  });
});

test("manual stop reducer makes silence explicit via wake block and visible activity", () => {
  const plan = reduceStopLifecycle({
    activityDedupeKey: "stop-dedupe",
    event: lifecycleEvent({
      eventType: "manual_stop_requested",
      actor: "human",
      source: "web",
      reason: "manual_stop",
    }),
    nextStatus: "stopped",
    state: state({
      dbStatus: "active",
      intentState: "manual_stopped",
      runtimeState: "not_running",
    }),
  });

  assert.deepEqual(plan.dbStatus, {
    kind: "apply",
    status: "stopped",
    writer: "direct",
    attrs: {
      intent_state: "manual_stopped",
      legacy_status: "stopped",
      runtime_state: "not_running",
    },
  });
  assert.equal(plan.wakeEligibility.eligible, false);
  assert.equal(plan.wakeEligibility.blockReason, "manual_stopped");
  assert.equal(plan.event.eventType, "manual_stop_requested");
  assert.equal(plan.event.actor, "human");
  assert.equal(plan.event.source, "web");
  assert.equal(plan.liveActivity.kind, "emit");
  assert.equal(plan.liveActivity.kind === "emit" ? plan.liveActivity.activity : null, "offline");
  assert.equal(plan.liveActivity.kind === "emit" ? plan.liveActivity.detailKind : null, "stopped");
  assert.equal(plan.liveActivity.kind === "emit" ? plan.liveActivity.detail : null, "Agent stopped by user");
  assert.equal(plan.activityLog.labelKind, "stopped");
  assert.deepEqual(plan.activityLog.attrs, {
    intent_state: "manual_stopped",
    legacy_status: "stopped",
    runtime_state: "not_running",
    stop_source: "user",
  });
  assert.equal(shouldEmitLiveActivity({
    liveActivity: plan.liveActivity,
    nextStatus: "stopped",
    stopSent: true,
  }), true);
});

test("internal stop only emits stopped activity if the daemon stop could not be sent", () => {
  const plan = reduceStopLifecycle({
    activityDedupeKey: "stop-dedupe",
    event: lifecycleEvent(),
    nextStatus: "inactive",
    state: state({
      dbStatus: "active",
      intentState: "running_allowed",
      runtimeState: "not_running",
    }),
  });

  assert.equal(shouldEmitLiveActivity({
    liveActivity: plan.liveActivity,
    nextStatus: "inactive",
    stopSent: true,
  }), false);
  assert.equal(shouldEmitLiveActivity({
    liveActivity: plan.liveActivity,
    nextStatus: "inactive",
    stopSent: false,
  }), true);
});

test("runtime profile migration gate is control-only and wake-ineligible", () => {
  const plan = reduceRuntimeProfileControlLifecycle({
    event: lifecycleEvent(),
    state: state({ controlGate: "runtime_profile_migration", dbStatus: "active" }),
  });

  assert.deepEqual(plan.dbStatus, {
    kind: "skip",
    skippedReason: "control_gate_only",
    attrs: { control_gate: "runtime_profile_migration" },
  });
  assert.equal(plan.wakeEligibility.eligible, false);
  assert.equal(plan.wakeEligibility.blockReason, "control_gate");
  assert.equal(plan.liveActivity.kind, "skip");
});

test("start reducer owns active starting projection", () => {
  const plan = reduceStartLifecycle({
    event: lifecycleEvent(),
    state: state({ dbStatus: "inactive", runtimeState: "starting" }),
  });

  assert.deepEqual(plan.dbStatus, {
    kind: "apply",
    status: "active",
    writer: "direct",
    attrs: {
      intent_state: "running_allowed",
      legacy_status: "active",
      previous_status: "inactive",
      runtime_state: "starting",
    },
  });
  assert.deepEqual(plan.wakeEligibility, { eligible: true });
  assert.deepEqual(plan.sideEffects, { updateCache: { runtimeState: "starting", status: "active" } });
  assert.deepEqual(plan.liveActivity, {
    kind: "emit",
    activity: "working",
    detail: "Starting…",
    detailKind: "runtime_starting",
  });
  assert.equal(plan.activityLog.labelKind, "runtime_starting");
});

test("daemon activity reducer emits activity without changing DB status", () => {
  const plan = reduceDaemonActivityLifecycle({
    action: "broadcast-activity",
    activity: "working",
    detail: "Message received",
    detailKind: "message_received",
    entries: [{ kind: "status", activity: "working", activityKind: "working", detail: "Message received", detailKind: "message_received" }],
    event: lifecycleEvent(),
    state: state({ dbStatus: "active", runtimeState: "working" }),
  });

  assert.deepEqual(plan.dbStatus, {
    kind: "skip",
    skippedReason: "daemon_activity_does_not_change_db_status",
    attrs: { activity_status: "working" },
  });
  assert.deepEqual(plan.wakeEligibility, { eligible: true });
  assert.equal(plan.liveActivity.kind, "emit");
  assert.equal(plan.liveActivity.kind === "emit" ? plan.liveActivity.detailKind : null, "message_received");
  assert.equal(plan.activityLog.labelKind, "daemon_activity");
});

test("daemon activity signal reducer has exhaustive non-overlapping canonical and compat coverage", () => {
  const canonical = Object.keys(CANONICAL_DAEMON_ACTIVITY_BY_DETAIL_KIND);
  const legacy = Object.keys(LEGACY_DAEMON_ACTIVITY_COMPAT_RULE_BY_DETAIL_KIND);

  assert.deepEqual(
    [...canonical, ...legacy].sort(),
    [...AGENT_ACTIVITY_DETAIL_KINDS].sort(),
  );
  assert.equal(canonical.some((kind) => legacy.includes(kind as never)), false);
});

test("canonical daemon activity signal reducer computes activityKind without trusting producer activity", () => {
  const cases = [
    ["runtime_error", "error"],
    ["runtime_crashed", "offline"],
    ["idle", "online"],
    ["thinking_started", "thinking"],
    ["thinking_end", "working"],
    ["model_request_started", "working"],
    ["provider_request_status", "working"],
    ["model_response_started", "working"],
    ["tool_end", "working"],
  ] as const;

  for (const [detailKind, expectedActivity] of cases) {
    const reduced = reduceDaemonActivitySignal({
      detailKind,
      legacyActivity: expectedActivity === "error" ? "working" : "error",
    });
    assert.deepEqual(reduced, {
      activity: expectedActivity,
      detailKind,
      source: "canonical",
    });
  }
});

test("a provider-limit or billing runtime error is cleared only by real model output", () => {
  assert.equal(runtimeErrorClearsOnlyOnModelOutput({ errorClass: "RateLimitError" }), true);
  assert.equal(runtimeErrorClearsOnlyOnModelOutput({ errorClass: "BillingError" }), true);
  assert.equal(runtimeErrorClearsOnlyOnModelOutput({ errorClass: "AuthError" }), false);
  assert.equal(runtimeErrorClearsOnlyOnModelOutput({ errorClass: "ProviderConnectionError" }), false);
  assert.equal(runtimeErrorClearsOnlyOnModelOutput({}), false);
  assert.equal(runtimeErrorClearsOnlyOnModelOutput(null), false);
  const action = (detailKind: AgentActivityDetailKind, currentErrorClearsOnlyOnModelOutput: boolean) => reduceRuntimeErrorActivityAction({
    signal: reduceDaemonActivitySignal({ detailKind, legacyActivity: "working" }),
    currentErrorPresent: true,
    currentErrorClearsOnlyOnModelOutput,
    isHeartbeat: false,
  });
  for (const detailKind of ["model_request_started", "runtime_progress", "tool_end", "subagent_activity", "compaction_finished"] as AgentActivityDetailKind[]) {
    assert.equal(action(detailKind, true), "preserve", `${detailKind} keeps a provider-limit error`);
    assert.equal(action(detailKind, false), "clear", `${detailKind} still clears any other error`);
  }
  for (const detailKind of ["model_response_started", "thinking_started", "tool_started", "running_command", "checking_messages"] as AgentActivityDetailKind[]) {
    assert.equal(action(detailKind, true), "clear", `${detailKind} is model output`);
  }
});

test("task #1351: only a canonical, non-heartbeat model-output frame may prove a BillingError recovered", () => {
  const output = [{ kind: "text", text: "Hello" }];
  const frame = (detailKind: AgentActivityDetailKind | undefined, isHeartbeat?: boolean, entries: unknown[] = output) =>
    isModelOutputRecoveryFrame({ signal: reduceDaemonActivitySignal({ detailKind, legacyActivity: "working" }), isHeartbeat, entries });
  // Text and thinking need their own non-empty output entry: an empty frame is
  // the daemon's turn-start bookkeeping, and earlier turns' summaries (or a
  // status row) riding on it are not this request's output.
  const summary = { kind: "turn_summary", outcome: "completed", text: "earlier turn" };
  for (const detailKind of ["model_response_started", "thinking_started"] as AgentActivityDetailKind[]) {
    assert.equal(frame(detailKind, false, []), false, `empty ${detailKind}`);
    assert.equal(frame(detailKind, false, [summary]), false, `${detailKind} with only a turn summary`);
    assert.equal(frame(detailKind, false, [{ kind: "status", activity: "thinking", detail: "", detailKind }]), false, `${detailKind} with only a status row`);
    assert.equal(frame(detailKind, false, [{ kind: "text", text: "  " }]), false, `${detailKind} with blank text`);
    assert.equal(frame(detailKind, false, [summary, { kind: "thinking", text: "Planning" }]), true, `${detailKind} with output after a summary`);
  }
  for (const detailKind of ["tool_started", "running_command", "checking_messages"] as AgentActivityDetailKind[]) {
    assert.equal(frame(detailKind, false, []), true, `${detailKind} is a tool call`);
  }
  for (const detailKind of ["model_response_started", "thinking_started", "tool_started", "running_command", "checking_messages"] as AgentActivityDetailKind[]) {
    assert.equal(frame(detailKind, false), true, detailKind);
    assert.equal(frame(detailKind, true), false, `${detailKind} heartbeat`);
    assert.equal(frame(detailKind), false, `${detailKind} without the heartbeat bit`);
  }
  for (const detailKind of ["model_request_started", "runtime_progress", "tool_end", "subagent_activity"] as AgentActivityDetailKind[]) {
    assert.equal(frame(detailKind, false), false, detailKind);
  }
  assert.equal(frame(undefined, false), false, "a legacy frame without a detailKind");
});

test("provider request observation preserves existing runtime error authority", () => {
  const signal = reduceDaemonActivitySignal({ detailKind: "provider_request_status", legacyActivity: "error" });
  for (const currentErrorPresent of [false, true]) {
    assert.equal(reduceRuntimeErrorActivityAction({ signal, currentErrorPresent, isHeartbeat: false }), "preserve");
  }
});

test("detailKind-less legacy daemon compatibility is deterministic and never clears runtime errors", () => {
  for (const legacyActivity of ["online", "thinking", "working", "error", "offline"] as AgentActivityKind[]) {
    const signal = reduceDaemonActivitySignal({ detailKind: undefined, legacyActivity });
    assert.deepEqual(signal, {
      activity: legacyActivity,
      detailKind: "other",
      source: "legacy_detail_kind_missing",
    });
    assert.notEqual(
      reduceRuntimeErrorActivityAction({
        signal,
        currentErrorPresent: true,
        isHeartbeat: false,
      }),
      "clear",
    );
  }
});

test("#triage:eedc43fe: delivery_unconsumed is a diagnostic, so it keeps the activity the daemon sent", () => {
  const signal = reduceDaemonActivitySignal({ detailKind: "delivery_unconsumed", legacyActivity: "working" });
  assert.equal(signal.activity, "working", "an agent mid-turn doesn't read as idle");
  assert.equal(signal.detailKind, "delivery_unconsumed");
  assert.equal(reduceDaemonActivitySignal({ detailKind: "delivery_unconsumed" }).activity, "online", "online only when the daemon sent none");
  const [entry] = rewriteDaemonActivityEntries(
    [{ kind: "status", activity: "online", activityKind: "online", detail: "3 deliveries written, runtime not consuming", detailKind: "delivery_unconsumed" }] as never,
    signal,
  )!;
  assert.equal((entry as { activity?: string }).activity, "working", "its status entry agrees");
});

test("only detailKind-less legacy frames retain producer activity during the deprecation window", () => {
  const legacy = reduceDaemonActivitySignal({
    detailKind: undefined,
    legacyActivity: "thinking",
  });
  assert.deepEqual(legacy, {
    activity: "thinking",
    detailKind: "other",
    source: "legacy_detail_kind_missing",
  });
  for (const detailKind of Object.keys(LEGACY_DAEMON_ACTIVITY_COMPAT_RULE_BY_DETAIL_KIND)) {
    assert.throws(() => reduceDaemonActivitySignal({
      detailKind: detailKind as AgentActivityDetailKind,
      legacyActivity: "error",
    }), /Non-fact daemon activity detail kind/);
  }
});

test("legacy producer error conclusion cannot persist runtime error state", () => {
  const signal = reduceDaemonActivitySignal({
    detailKind: undefined,
    legacyActivity: "error",
  });
  assert.equal(reduceRuntimeErrorActivityAction({
    signal,
    currentErrorPresent: false,
    isHeartbeat: false,
  }), "preserve");
});

test("runtime_crashed establishes durable authority only with a valid typed carrier (#688b)", () => {
  const crash = reduceDaemonActivitySignal({
    detailKind: "runtime_crashed",
    legacyActivity: "error",
  });
  // With a valid typed carrier: set durable typed authority.
  assert.equal(reduceRuntimeErrorActivityAction({
    signal: crash,
    currentErrorPresent: false,
    isHeartbeat: false,
    typedRuntimeCarrierPresent: true,
  }), "set");
  // Without a carrier: a crash is a weak signal — must not establish authority.
  assert.equal(reduceRuntimeErrorActivityAction({
    signal: crash,
    currentErrorPresent: false,
    isHeartbeat: false,
  }), "preserve");
  // And without a carrier it must not clear pre-existing authority either.
  assert.equal(reduceRuntimeErrorActivityAction({
    signal: crash,
    currentErrorPresent: true,
    isHeartbeat: false,
  }), "preserve");
});

test("server rewrites status-entry conclusions from the envelope fact reduction", () => {
  const signal = reduceDaemonActivitySignal({
    detailKind: "runtime_error",
    legacyActivity: "working",
  });
  assert.deepEqual(rewriteDaemonActivityEntries([{
    kind: "status",
    activity: "working",
    activityKind: "working",
    detail: "Runtime failed",
    detailKind: "runtime_error",
  }], signal), [{
    kind: "status",
    activity: "error",
    activityKind: "error",
    detail: "Runtime failed",
    detailKind: "runtime_error",
  }]);

  const readySignal = reduceDaemonActivitySignal({
    detailKind: "ready",
    legacyActivity: "error",
  });
  assert.deepEqual(rewriteDaemonActivityEntries([{
    kind: "status",
    activity: "error",
    activityKind: "error",
    detail: "Ready",
  }], readySignal), [{
    kind: "status",
    activity: "online",
    activityKind: "online",
    detail: "Ready",
  }]);
});

test("runtime error reducer clears only explicit non-heartbeat true-progress detail kinds", () => {
  const progress = reduceDaemonActivitySignal({
    detailKind: "runtime_progress",
    legacyActivity: "error",
  });
  assert.equal(reduceRuntimeErrorActivityAction({
    signal: progress,
    currentErrorPresent: true,
    isHeartbeat: false,
  }), "clear");
  assert.equal(reduceRuntimeErrorActivityAction({
    signal: progress,
    currentErrorPresent: true,
    isHeartbeat: true,
  }), "preserve");
  assert.equal(reduceRuntimeErrorActivityAction({
    signal: progress,
    currentErrorPresent: true,
  }), "preserve");
});

test("daemon activity reducer carries launchId/clientSeq/probeId/producerFactId into liveActivity when provided (task #136)", () => {
  const plan = reduceDaemonActivityLifecycle({
    action: "broadcast-activity",
    activity: "working",
    detail: "Thinking",
    detailKind: "daemon_activity",
    entries: [{ kind: "status", activity: "working", activityKind: "working", detail: "Thinking", detailKind: "daemon_activity" }],
    event: lifecycleEvent(),
    state: state({ dbStatus: "active", runtimeState: "working" }),
    launchId: "L-1",
    clientSeq: 7,
    probeId: "P-abc",
    producerFactId: "daemon_activity:agent-1:L-1:7",
  });

  assert.equal(plan.liveActivity.kind, "emit");
  if (plan.liveActivity.kind === "emit") {
    assert.equal(plan.liveActivity.launchId, "L-1");
    assert.equal(plan.liveActivity.clientSeq, 7);
    assert.equal(plan.liveActivity.probeId, "P-abc");
    assert.equal(plan.liveActivity.producerFactId, "daemon_activity:agent-1:L-1:7");
    assert.equal(plan.liveActivity.attrs?.source_producer_fact_id, "daemon_activity:agent-1:L-1:7");
  }
  assert.equal(plan.activityLog.attrs?.source_producer_fact_id, "daemon_activity:agent-1:L-1:7");
});

test("daemon activity reducer omits launchId/clientSeq/probeId/producerFactId on liveActivity when absent (no synthesis; task #136)", () => {
  const plan = reduceDaemonActivityLifecycle({
    action: "broadcast-activity",
    activity: "working",
    detail: "Older daemon",
    detailKind: "daemon_activity",
    entries: [{ kind: "status", activity: "working", activityKind: "working", detail: "Older daemon", detailKind: "daemon_activity" }],
    event: lifecycleEvent(),
    state: state({ dbStatus: "active", runtimeState: "working" }),
  });

  assert.equal(plan.liveActivity.kind, "emit");
  if (plan.liveActivity.kind === "emit") {
    assert.equal(plan.liveActivity.launchId, undefined);
    assert.equal(plan.liveActivity.clientSeq, undefined);
    assert.equal(plan.liveActivity.probeId, undefined);
    assert.equal(plan.liveActivity.producerFactId, undefined);
    assert.equal(Object.prototype.hasOwnProperty.call(plan.liveActivity, "launchId"), false);
    assert.equal(Object.prototype.hasOwnProperty.call(plan.liveActivity, "clientSeq"), false);
    assert.equal(Object.prototype.hasOwnProperty.call(plan.liveActivity, "probeId"), false);
    assert.equal(Object.prototype.hasOwnProperty.call(plan.liveActivity, "producerFactId"), false);
  }
});

test("daemon activity reducer suppresses manually stopped agents", () => {
  const plan = reduceDaemonActivityLifecycle({
    action: "ignore",
    activity: "online",
    detail: "",
    detailKind: "none",
    event: lifecycleEvent(),
    state: state({ dbStatus: "stopped" }),
  });

  assert.equal(plan.dbStatus.kind, "skip");
  assert.equal(plan.wakeEligibility.eligible, false);
  assert.equal(plan.wakeEligibility.blockReason, "manual_stopped");
  assert.equal(plan.liveActivity.kind, "skip");
  assert.equal(plan.liveActivity.kind === "skip" ? plan.liveActivity.skippedReason : null, "manual_stopped_ignores_daemon_activity");
});

test("reset-window ignored status signal projects wake-ineligible", () => {
  const plan = reduceDaemonStatusLifecycle({
    action: "ignore",
    event: lifecycleEvent(),
    state: state({ dbStatus: "active", resetMode: "restart" }),
  });

  assert.equal(plan.dbStatus.kind, "skip");
  assert.equal(plan.wakeEligibility.eligible, false);
  assert.equal(plan.wakeEligibility.blockReason, "reset_window");
  assert.equal(plan.liveActivity.kind, "skip");
  assert.equal(plan.liveActivity.kind === "skip" ? plan.liveActivity.skippedReason : null, "reset_window_ignores_daemon_status");
});

test("reset-window ignored session signal projects wake-ineligible", () => {
  const plan = reduceDaemonSessionLifecycle({
    action: "ignore",
    event: lifecycleEvent(),
    sessionId: "session-1",
    state: state({ dbStatus: "active", resetMode: "restart" }),
  });

  assert.equal(plan.dbStatus.kind, "skip");
  assert.equal(plan.wakeEligibility.eligible, false);
  assert.equal(plan.wakeEligibility.blockReason, "reset_window");
  assert.equal(plan.liveActivity.kind, "skip");
  assert.equal(plan.liveActivity.kind === "skip" ? plan.liveActivity.skippedReason : null, "reset_window_ignores_daemon_session");
});

test("unchanged daemon status signal skips DB status projection but keeps side effects", () => {
  const plan = reduceDaemonStatusLifecycle({
    action: "persist-active",
    event: lifecycleEvent(),
    nextStatus: "active",
    state: state({ dbStatus: "active", runtimeState: "running_idle" }),
  });

  assert.deepEqual(plan.dbStatus, {
    kind: "skip",
    skippedReason: "daemon_status_unchanged",
    attrs: { legacy_status: "active" },
  });
  assert.deepEqual(plan.sideEffects, {
    resolveStartingActivity: true,
    updateCache: { runtimeState: "running_idle", status: "active" },
  });
});

test("unchanged daemon session signal skips DB status projection but preserves cache/session side effects", () => {
  const plan = reduceDaemonSessionLifecycle({
    action: "persist-active-session",
    event: lifecycleEvent(),
    sessionId: "session-1",
    state: state({ dbStatus: "active", runtimeState: "running_idle", sessionId: "session-1" }),
  });

  assert.deepEqual(plan.dbStatus, {
    kind: "skip",
    skippedReason: "daemon_session_unchanged",
    attrs: { legacy_status: "active", session_present: true },
  });
  assert.deepEqual(plan.sideEffects, {
    releaseWakeLock: true,
    resolveStartingActivity: true,
    updateCache: { runtimeState: "running_idle", sessionId: "session-1", status: "active" },
  });
});

test("new daemon session id still persists through the signal writer", () => {
  const plan = reduceDaemonSessionLifecycle({
    action: "persist-active-session",
    event: lifecycleEvent(),
    sessionId: "session-new",
    state: state({ dbStatus: "active", runtimeState: "running_idle", sessionId: "session-old" }),
  });

  assert.deepEqual(plan.dbStatus, {
    kind: "apply",
    sessionId: "session-new",
    status: "active",
    writer: "signal",
    attrs: { legacy_status: "active", session_present: true },
  });
});

test("reset-window ignored activity signal projects wake-ineligible", () => {
  const plan = reduceDaemonActivityLifecycle({
    action: "ignore",
    activity: "working",
    detail: "Still working",
    detailKind: "daemon_activity",
    event: lifecycleEvent(),
    state: state({ dbStatus: "active", resetMode: "restart" }),
  });

  assert.equal(plan.dbStatus.kind, "skip");
  assert.equal(plan.wakeEligibility.eligible, false);
  assert.equal(plan.wakeEligibility.blockReason, "reset_window");
  assert.equal(plan.liveActivity.kind, "skip");
  assert.equal(plan.liveActivity.kind === "skip" ? plan.liveActivity.skippedReason : null, "reset_window_ignores_daemon_activity");
});

function externalActivityEvent() {
  return createAgentLifecycleEvent(
    {
      serverId: "server-1",
      agentId: "agent-1",
      eventType: "external_agent_signal",
      actor: "external",
      source: "external_cli",
      reason: "external_activity",
      correlationId: "correlation-ext-1",
      occurredAt: "2026-06-18T00:00:00.000Z",
    },
    { createId: () => "event-ext-1" },
  );
}

test("external activity always skips DB status projection", () => {
  const plan = reduceExternalActivityLifecycle({
    event: externalActivityEvent(),
    activity: "working",
    detail: "Using tool: Read",
    entries: [{ kind: "tool_start", toolName: "Read", toolInput: "/tmp/test.ts", producerFactId: "ext:fact-1" }],
    dedupeKey: "external-agent-activity:evt-1",
  });

  assert.deepEqual(plan.dbStatus, {
    kind: "skip",
    skippedReason: "external_activity_does_not_change_db_status",
    attrs: { activity_status: "working" },
  });
});

test("external activity emits live activity with entries and dedupeKey", () => {
  const entries = [{ kind: "tool_start" as const, toolName: "Read", toolInput: "/tmp/test.ts", producerFactId: "ext:fact-1" }];
  const plan = reduceExternalActivityLifecycle({
    event: externalActivityEvent(),
    activity: "working",
    detail: "Using tool: Read",
    entries,
    dedupeKey: "external-agent-activity:evt-1",
  });

  assert.equal(plan.liveActivity.kind, "emit");
  if (plan.liveActivity.kind === "emit") {
    assert.equal(plan.liveActivity.activity, "working");
    assert.equal(plan.liveActivity.detail, "Using tool: Read");
    assert.equal(plan.liveActivity.dedupeKey, "external-agent-activity:evt-1");
    assert.equal(plan.liveActivity.detailKind, "external_activity");
    assert.deepEqual(plan.liveActivity.entries, entries);
  }
});

test("external activity projects wake-eligible", () => {
  const plan = reduceExternalActivityLifecycle({
    event: externalActivityEvent(),
    activity: "online",
    detail: "",
  });

  assert.equal(plan.wakeEligibility.eligible, true);
  assert.equal(plan.wakeEligibility.blockReason, undefined);
});

test("external activity persists to activity log with external_activity labelKind", () => {
  const plan = reduceExternalActivityLifecycle({
    event: externalActivityEvent(),
    activity: "working",
    detail: "Using tool: Bash",
    dedupeKey: "external-agent-activity:evt-2",
  });

  assert.equal(plan.activityLog.labelKind, "external_activity");
  assert.equal(plan.activityLog.dedupeKey, "external-agent-activity:evt-2");
  assert.equal(plan.activityLog.skippedReason, undefined);
});

test("external activity has no side effects", () => {
  const plan = reduceExternalActivityLifecycle({
    event: externalActivityEvent(),
    activity: "working",
    detail: "Using tool: Read",
  });

  assert.equal(plan.sideEffects, undefined);
});

test("external activity passes occurredAtMs as nowOverride for timestamp fidelity", () => {
  const occurredAtMs = Date.parse("2026-06-17T12:00:00Z");
  const plan = reduceExternalActivityLifecycle({
    event: externalActivityEvent(),
    activity: "working",
    detail: "Using tool: Read",
    occurredAtMs,
  });

  assert.equal(plan.liveActivity.kind, "emit");
  if (plan.liveActivity.kind === "emit") {
    assert.equal(plan.liveActivity.nowOverride, occurredAtMs);
  }
});

test("external activity omits nowOverride when occurredAtMs is absent", () => {
  const plan = reduceExternalActivityLifecycle({
    event: externalActivityEvent(),
    activity: "online",
    detail: "",
  });

  assert.equal(plan.liveActivity.kind, "emit");
  if (plan.liveActivity.kind === "emit") {
    assert.equal(plan.liveActivity.nowOverride, undefined);
  }
});

function syntheticRepairEvent() {
  return createAgentLifecycleEvent(
    {
      serverId: "server-1",
      agentId: "agent-1",
      eventType: "activity_changed",
      actor: "server",
      source: "scheduler",
      reason: "runtime_idle",
      correlationId: "correlation-repair-1",
      occurredAt: "2026-06-18T01:00:00.000Z",
    },
    { createId: () => "event-repair-1" },
  );
}

test("synthetic repair skips DB status and marks attrs", () => {
  const plan = reduceSyntheticRepairLifecycle({
    event: syntheticRepairEvent(),
    repairKind: "stale_sweep",
  });

  assert.deepEqual(plan.dbStatus, {
    kind: "skip",
    skippedReason: "synthetic_repair_does_not_change_db_status",
    attrs: { synthetic_repair: true, repair_kind: "stale_sweep" },
  });
  assert.equal(plan.sideEffects, undefined);
});

test("synthetic repair emits online activity with repair attrs", () => {
  const plan = reduceSyntheticRepairLifecycle({
    event: syntheticRepairEvent(),
    repairKind: "transient_normalization",
    nowOverride: 1718672400000,
  });

  assert.equal(plan.liveActivity.kind, "emit");
  if (plan.liveActivity.kind === "emit") {
    assert.equal(plan.liveActivity.activity, "online");
    assert.equal(plan.liveActivity.detail, "");
    assert.equal(plan.liveActivity.detailKind, "synthetic_repair");
    assert.equal(plan.liveActivity.nowOverride, 1718672400000);
    assert.deepEqual(plan.liveActivity.attrs, { synthetic_repair: true, repair_kind: "transient_normalization" });
  }
});

test("synthetic repair projects wake-eligible", () => {
  const plan = reduceSyntheticRepairLifecycle({
    event: syntheticRepairEvent(),
    repairKind: "stale_sweep",
  });

  assert.equal(plan.wakeEligibility.eligible, true);
});

test("synthetic repair activity log carries repair_kind", () => {
  const plan = reduceSyntheticRepairLifecycle({
    event: syntheticRepairEvent(),
    repairKind: "stale_sweep",
  });

  assert.equal(plan.activityLog.labelKind, "synthetic_repair");
  assert.deepEqual(plan.activityLog.attrs, { synthetic_repair: true, repair_kind: "stale_sweep" });
});

test("RFC 069 §8: activity from a sequenced-status daemon changes display only", () => {
  const plan = reduceDaemonActivityLifecycle({
    action: "broadcast-activity",
    activity: "thinking",
    detail: "Resumed output",
    detailKind: "daemon_activity",
    event: lifecycleEvent(),
    state: state({ dbStatus: "inactive", runtimeState: "not_running" }),
    activityDrivesInstanceState: false,
  });
  assert.equal(plan.sideEffects, undefined);
  assert.equal(plan.dbStatus.kind, "skip");
  assert.equal(plan.dbStatus.kind === "skip" ? plan.dbStatus.skippedReason : null, "status_reported_on_sequenced_channel");
  assert.equal(plan.liveActivity.kind, "emit");
});

test("RFC 069 §8: sequenced status is accepted in order and only from the connected daemon process", async () => {
  const { planSequencedStatus } = await import("./agentLifecycleReducer");
  assert.deepEqual(planSequencedStatus({ connectionInstanceId: "d2", frameInstanceId: undefined, frameSeq: undefined, last: undefined }), { kind: "unsequenced" });
  assert.deepEqual(planSequencedStatus({ connectionInstanceId: "d2", frameInstanceId: "d1", frameSeq: 50, last: undefined }), { kind: "stale_instance" });
  assert.deepEqual(planSequencedStatus({ connectionInstanceId: "d2", frameInstanceId: "d2", frameSeq: 3, last: { daemonInstanceId: "d2", clientSeq: 3 } }), { kind: "stale_seq" });
  assert.deepEqual(planSequencedStatus({ connectionInstanceId: "d2", frameInstanceId: "d2", frameSeq: 1, last: { daemonInstanceId: "d1", clientSeq: 90 } }), { kind: "accept", next: { daemonInstanceId: "d2", clientSeq: 1 } });
  assert.deepEqual(planSequencedStatus({ connectionInstanceId: "d2", frameInstanceId: "d2", frameSeq: 4, last: { daemonInstanceId: "d2", clientSeq: 3 } }), { kind: "accept", next: { daemonInstanceId: "d2", clientSeq: 4 } });
  assert.deepEqual(planSequencedStatus({ connectionInstanceId: null, frameInstanceId: "d1", frameSeq: 4, last: { daemonInstanceId: "d2", clientSeq: 3 } }), { kind: "unsequenced" });
});

test("claude_root_privileges establishes durable authority only with a valid typed carrier (#688b)", () => {
  const crash = reduceDaemonActivitySignal({
    detailKind: "claude_root_privileges",
    legacyActivity: "error",
  });
  // With a valid typed carrier: set durable typed authority.
  assert.equal(reduceRuntimeErrorActivityAction({
    signal: crash,
    currentErrorPresent: false,
    isHeartbeat: false,
    typedRuntimeCarrierPresent: true,
  }), "set");
  // Without a carrier: a crash is a weak signal — must not establish authority.
  assert.equal(reduceRuntimeErrorActivityAction({
    signal: crash,
    currentErrorPresent: false,
    isHeartbeat: false,
  }), "preserve");
  // And without a carrier it must not clear pre-existing authority either.
  assert.equal(reduceRuntimeErrorActivityAction({
    signal: crash,
    currentErrorPresent: true,
    isHeartbeat: false,
  }), "preserve");
});
