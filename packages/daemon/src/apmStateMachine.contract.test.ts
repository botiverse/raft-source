import assert from "node:assert/strict";
import {
  APM_STATUS_TRANSITION_CONTRACT,
  type ApmStatusTransitionContractId,
  type ApmStatusTransitionContractRow,
  type ApmUserVisibleStatus,
  getApmStatusTransitionContract,
} from "./apmStateMachineContract";
import {
  type ApmControlPlaneEventReduction,
  type ApmStalledRecoveryTerminationReduction,
  type ApmStartupTimeoutTerminationReduction,
  commitApmGatedSteeringDecisionState,
  createInitialApmGatedSteeringState,
  projectApmRuntimeProgressStalledTrace,
  projectApmRuntimeStallDiagnostic,
  projectRuntimeToolDiagnosticActivity,
  projectApmRuntimeTerminationTrace,
  reduceApmControlPlaneEvent,
  reduceApmToolUse,
  reduceApmStalledRecoveryTermination,
  reduceApmStartupTimeoutTermination,
} from "./apmStateMachine";
import { STALLED_WITH_WORK_THRESHOLDS } from "./stalledWithWork";
import { classifyDaemonConnectionTraceEvent } from "./connection";

const EXECUTABLE_REDUCER_ROW_IDS = [
  "direct-stdin-tool-output-stale-queued-message",
  "recent-runtime-progress-blocks-stalled-recovery",
  "active-tool-without-direct-recovery-evidence-blocks-restart",
  "startup-no-ready-timeout-terminates",
  "startup-progress-started-blocks-timeout",
] as const satisfies readonly ApmStatusTransitionContractId[];

const EXECUTABLE_CONTROL_PLANE_ROW_IDS = [
  "control-plane-reconnect-does-not-imply-runtime-recovery",
] as const satisfies readonly ApmStatusTransitionContractId[];

test("APM status transition contract uses stable low-cardinality rows", () => {
  const ids = new Set<string>();
  for (const row of APM_STATUS_TRANSITION_CONTRACT) {
    assert.match(row.id, /^[a-z0-9-]+$/);
    assert.equal(ids.has(row.id), false, `duplicate row id ${row.id}`);
    ids.add(row.id);
    assert.ok(row.invariant.length > 20, `${row.id} should name the protected invariant`);
    assert.equal(
      row.expectation.resumeErrorClass === "permission_denied" && row.expectation.recoveryAction === "fallback_fresh_thread",
      false,
      `${row.id} must not mark permission-denied as fresh-thread recovery`,
    );
  }
});

test("APM status transition contract marks executable rows separately from future anchors", () => {
  const executableIds: ReadonlySet<string> = new Set([
    ...EXECUTABLE_REDUCER_ROW_IDS,
    ...EXECUTABLE_CONTROL_PLANE_ROW_IDS,
  ]);
  for (const row of APM_STATUS_TRANSITION_CONTRACT) {
    if (row.testStatus === "executable") {
      assert.equal(executableIds.has(row.id), true, `${row.id} needs an executable test`);
      continue;
    }

    assert.match(
      row.coverage,
      /^(driver_error_classifier|control_plane_boundary)$/,
      `${row.id} anchor must name the future slice that will make it executable`,
    );
  }
});

test("APM gated steering commit replaces the full reducer-owned state", () => {
  const previous = {
    ...createInitialApmGatedSteeringState(),
    outstandingToolUses: 2,
  };
  const next = {
    isIdle: true,
    expectedTerminationReason: "turn_end" as const,
    outstandingToolUses: 0,
    compacting: true,
    reviewing: true,
  };

  const committed = commitApmGatedSteeringDecisionState(next);

  assert.deepEqual(committed, next);
  assert.notEqual(committed, previous);
  assert.equal(previous.outstandingToolUses, 2);
});

test("APM contract matrix: stale direct-stdin tool output enters stalled recovery once", () => {
  const row = getApmStatusTransitionContract("direct-stdin-tool-output-stale-queued-message");
  assert.equal(row.coverage, "stalled_recovery_reducer");
  assertExecutableRow(row, {
    from: "running",
    eventClass: "tool_output_no_progress_stale",
  });
  assert.ok(row.fakeClock);

  const afterToolCall = reduceApmToolUse(createInitialApmGatedSteeringState(), {
    kind: "tool_call",
  }).nextState;
  const afterToolOutput = reduceApmToolUse(afterToolCall, { kind: "tool_output" }).nextState;
  const reduction = reduceApmStalledRecoveryTermination(afterToolOutput, {
    inboxLength: 1,
    appInboxNoticeWaiting: false,
    supportsStdinNotification: true,
    busyDeliveryMode: "direct",
    hasSession: true,
    hasDirectStdinRecoveryEvidence: false,
    runtimeProgressIsStale: true,
    staleForMs: row.fakeClock.nowMs - row.fakeClock.lastRuntimeProgressAtMs,
    turnInProgress: true,
    deliveryHold: null,
    openToolHoldsNoLiveWork: false,
    processAlive: undefined,
  }, { ...STALLED_WITH_WORK_THRESHOLDS, stallMs: row.fakeClock.staleThresholdMs });

  assert.equal(reduction.shouldTerminate, row.expectation.shouldTerminate);
  assert.equal(reduction.blockedReason, row.expectation.stalledRecoveryBlockReason);
  assert.equal(reduction.nextState.expectedTerminationReason, row.expectation.expectedTerminationReason);
  assert.equal(projectStalledRecoveryStatus(reduction), row.to);

  const projection = projectApmRuntimeTerminationTrace({
    reason: "stalled_recovery",
    turnReason: "harness_post_tool_silent_wedge",
    staleForMs: row.fakeClock.nowMs - row.fakeClock.lastRuntimeProgressAtMs,
    lastActivity: "working",
    lastActivityDetailPresent: true,
    lastActivityDetailKind: "running_command",
    pendingMessages: 1,
    recoveryAction: "terminate_for_queued_message",
  });
  assert.equal(projection.runtimeEventName, row.expectation.runtimeTraceEvent);
  assert.deepEqual(projection.runtimeEventAttrs, {
    turn_outcome: "failed",
    turn_subtype: "runtime_stalled",
    turn_reason: "harness_post_tool_silent_wedge",
    pendingMessages: 1,
    recovery: row.expectation.recoveryAction,
  });
  assert.deepEqual(projection.runtimeSpanAttrs, {
    ...projection.runtimeEventAttrs,
    ageMs: row.fakeClock.nowMs - row.fakeClock.lastRuntimeProgressAtMs,
    lastActivity: "working",
    lastActivityDetailPresent: true,
    lastActivityDetailKind: "running_command",
  });
  assert.deepEqual(projection.processExitAttrs, {
    stop_source: "stalled_recovery",
    expectedTerminationReason: "stalled_recovery",
    queued_messages_count: 1,
  });
  assert.equal(projection.runtimeStopReason, "stalled_recovery");

  const repeated = reduceApmStalledRecoveryTermination(reduction.nextState, {
    inboxLength: 1,
    appInboxNoticeWaiting: false,
    supportsStdinNotification: true,
    busyDeliveryMode: "direct",
    hasSession: true,
    hasDirectStdinRecoveryEvidence: false,
    runtimeProgressIsStale: true,
    staleForMs: row.fakeClock.nowMs - row.fakeClock.lastRuntimeProgressAtMs,
    turnInProgress: true,
    deliveryHold: null,
    openToolHoldsNoLiveWork: false,
    processAlive: undefined,
  }, { ...STALLED_WITH_WORK_THRESHOLDS, stallMs: row.fakeClock.staleThresholdMs });
  assert.equal(repeated.alreadyRecovering, true);
  assert.equal(repeated.shouldTerminate, false);
});

test("APM runtime termination projection centralizes turn_end process-stop attrs", () => {
  const projection = projectApmRuntimeTerminationTrace({ reason: "turn_end" });

  assert.deepEqual(projection.processExitAttrs, {
    stop_source: "turn_end",
    expectedTerminationReason: "turn_end",
  });
  assert.equal(projection.runtimeStopReason, "turn_end");
  assert.equal("runtimeEventName" in projection, false);
});

test("APM runtime stalled projection centralizes non-terminating trace attrs", () => {
  const projection = projectApmRuntimeProgressStalledTrace({
    turnReason: "harness_post_tool_silent_wedge",
    staleForMs: 960_000,
    lastActivity: "working",
    lastActivityDetailPresent: true,
    lastActivityDetailKind: "running_command",
  });

  assert.equal(projection.runtimeEventName, "runtime.progress.stalled");
  assert.deepEqual(projection.runtimeEventAttrs, {
    turn_outcome: "failed",
    turn_subtype: "runtime_stalled",
    turn_reason: "harness_post_tool_silent_wedge",
  });
  assert.deepEqual(projection.runtimeSpanAttrs, {
    ...projection.runtimeEventAttrs,
    ageMs: 960_000,
    lastActivity: "working",
    lastActivityDetailPresent: true,
    lastActivityDetailKind: "running_command",
  });
});

test("APM runtime tool diagnostic projection preserves every closed-set row", () => {
  assert.equal(projectRuntimeToolDiagnosticActivity([
    {
      classification: "running_with_recent_progress",
      toolAgeMs: 70_000,
      lastProgressAgeMs: 5_000,
    },
    {
      classification: "completion_loss",
      toolAgeMs: 90_000,
    },
  ], "legacy generic"), [
    "Bash tool has been running for 1m; process is alive; progress observed 5s ago.",
    "Tool process exited, but the runtime has not completed the tool call.",
  ].join(" "));
});

test("APM runtime tool diagnostic projection keeps generic investigation only for no pending tool", () => {
  assert.equal(projectRuntimeToolDiagnosticActivity([
    { classification: "runtime_inactive_without_pending_tool" },
  ], "legacy generic"), "Runtime is inactive; no pending tool call was found.");
  assert.equal(projectRuntimeToolDiagnosticActivity([], "legacy generic"), "legacy generic");
});

test("APM runtime stall diagnostic projection centralizes detail and trace attrs", () => {
  const projection = projectApmRuntimeStallDiagnostic({
    staleForMs: 960_000,
    staleForMinutes: 16,
    lastActivityKind: "working",
    lastActivity: "working",
    lastActivityDetail: "Running command…",
    lastActivityDetailKind: "running_command",
    runtimeProgressLastEventKind: "tool_output",
    runtime: "claude",
    model: "opus",
    platform: "darwin",
    arch: "arm64",
    launchId: "launch-1",
    sessionIdPresent: true,
    inboxCount: 2,
    pendingNotificationCount: 1,
    processPidPresent: true,
    driverBusyDeliveryMode: "direct",
    supportsStdinNotification: true,
    outstandingToolUses: 0,
    compacting: false,
    recentStderrCount: 3,
    recentStdoutCount: 4,
    runtimeTraceCounterAttrs: {
      runtime_events_count: 9,
      runtime_tool_outputs_count: 1,
    },
  });

  assert.equal(
    projection.detail,
    "Runtime stalled: no runtime events for 16m (after Running command…, queued=2)",
  );
  assert.equal(projection.turnReason, "harness_post_tool_silent_wedge");
  assert.equal(projection.lastActivityDetailPresent, true);
  assert.equal(projection.lastActivityDetailKind, "running_command");
  assert.deepEqual(projection.traceAttrs, {
    ageMs: 960_000,
    staleForMinutes: 16,
    lastActivity: "working",
    lastActivityDetailPresent: true,
    lastActivityDetailKind: "running_command",
    runtime: "claude",
    model: "opus",
    platform: "darwin",
    arch: "arm64",
    launchId: "launch-1",
    sessionIdPresent: true,
    inboxCount: 2,
    pendingNotificationCount: 1,
    processPidPresent: true,
    busyDeliveryMode: "direct",
    supportsStdinNotification: true,
    outstandingToolUses: 0,
    compacting: false,
    recentStderrCount: 3,
    recentStdoutCount: 4,
    runtime_events_count: 9,
    runtime_tool_outputs_count: 1,
  });

  const noDetail = projectApmRuntimeStallDiagnostic({
    ...runtimeStallDiagnosticInputWithoutDetail(),
    runtimeProgressLastEventKind: "text",
    inboxCount: 0,
  });
  assert.equal(noDetail.detail, "Runtime stalled: no runtime events for 1m");
  assert.equal(noDetail.turnReason, "no_runtime_events");
  assert.equal(noDetail.lastActivityDetailPresent, false);
  assert.equal(noDetail.lastActivityDetailKind, undefined);
});

test("APM contract matrix: recent progress blocks stalled recovery", () => {
  const row = getApmStatusTransitionContract("recent-runtime-progress-blocks-stalled-recovery");
  assert.equal(row.coverage, "stalled_recovery_reducer");
  assertExecutableRow(row, {
    from: "running",
    eventClass: "runtime_progress_recent",
  });
  assert.ok(row.fakeClock);

  const reduction = reduceApmStalledRecoveryTermination(createInitialApmGatedSteeringState(), {
    inboxLength: 1,
    appInboxNoticeWaiting: false,
    supportsStdinNotification: true,
    busyDeliveryMode: "direct",
    hasSession: true,
    hasDirectStdinRecoveryEvidence: false,
    runtimeProgressIsStale: false,
    staleForMs: row.fakeClock.nowMs - row.fakeClock.lastRuntimeProgressAtMs,
    turnInProgress: true,
    deliveryHold: null,
    openToolHoldsNoLiveWork: false,
    processAlive: undefined,
  }, { ...STALLED_WITH_WORK_THRESHOLDS, stallMs: row.fakeClock.staleThresholdMs });

  assert.equal(reduction.shouldTerminate, row.expectation.shouldTerminate);
  assert.equal(reduction.blockedReason, row.expectation.stalledRecoveryBlockReason);
  assert.equal(reduction.nextState.expectedTerminationReason, row.expectation.expectedTerminationReason);
  assert.equal(projectStalledRecoveryStatus(reduction), row.to);
});

test("APM contract matrix: active tool without recovery evidence blocks direct-stdin restart", () => {
  const row = getApmStatusTransitionContract("active-tool-without-direct-recovery-evidence-blocks-restart");
  assert.equal(row.coverage, "stalled_recovery_reducer");
  assertExecutableRow(row, {
    from: "running",
    eventClass: "active_tool_without_recovery_evidence",
  });
  assert.ok(row.fakeClock);

  const activeTool = reduceApmToolUse(createInitialApmGatedSteeringState(), {
    kind: "tool_call",
  }).nextState;
  const reduction = reduceApmStalledRecoveryTermination(activeTool, {
    inboxLength: 1,
    appInboxNoticeWaiting: false,
    supportsStdinNotification: true,
    busyDeliveryMode: "direct",
    hasSession: true,
    hasDirectStdinRecoveryEvidence: false,
    runtimeProgressIsStale: true,
    staleForMs: row.fakeClock.nowMs - row.fakeClock.lastRuntimeProgressAtMs,
    turnInProgress: true,
    deliveryHold: null,
    openToolHoldsNoLiveWork: false,
    processAlive: undefined,
  }, { ...STALLED_WITH_WORK_THRESHOLDS, stallMs: row.fakeClock.staleThresholdMs });

  assert.equal(reduction.shouldTerminate, row.expectation.shouldTerminate);
  assert.equal(reduction.blockedReason, row.expectation.stalledRecoveryBlockReason);
  assert.equal(reduction.nextState.expectedTerminationReason, row.expectation.expectedTerminationReason);
  assert.equal(projectStalledRecoveryStatus(reduction), row.to);
});

test("APM contract matrix: startup timeout separates no-ready from started-progress", () => {
  const noReady = getApmStatusTransitionContract("startup-no-ready-timeout-terminates");
  assertExecutableRow(noReady, {
    from: "starting",
    eventClass: "runtime_no_ready_timeout",
  });
  const noReadyReduction = reduceApmStartupTimeoutTermination(createInitialApmGatedSteeringState(), {
    hasRuntimeProgressEvent: false,
  });
  assert.equal(noReadyReduction.shouldTerminate, noReady.expectation.shouldTerminate);
  assert.equal(noReadyReduction.blockedReason, noReady.expectation.startupTimeoutBlockReason);
  assert.equal(noReadyReduction.nextState.expectedTerminationReason, noReady.expectation.expectedTerminationReason);
  assert.equal(noReadyReduction.nextState.isIdle, false);
  assert.equal(projectStartupTimeoutStatus(noReadyReduction), noReady.to);
  const noReadyProjection = projectApmRuntimeTerminationTrace({
    reason: "startup_timeout",
    timeoutMs: 2_500,
  });
  assert.equal(noReadyProjection.runtimeEventName, noReady.expectation.runtimeTraceEvent);
  assert.deepEqual(noReadyProjection.runtimeEventAttrs, {
    turn_outcome: "failed",
    turn_subtype: "runtime_stalled",
    turn_reason: "no_runtime_events",
    runtime_start_failure_kind: "runtime_start_timeout",
    timeout_ms: 2_500,
  });
  assert.deepEqual(noReadyProjection.runtimeSpanAttrs, noReadyProjection.runtimeEventAttrs);
  assert.deepEqual(noReadyProjection.processExitAttrs, {
    stop_source: "startup_timeout",
    expectedTerminationReason: "startup_timeout",
    timeout_ms: 2_500,
  });
  assert.equal(noReadyProjection.runtimeStopReason, "startup_timeout");

  const progressStarted = getApmStatusTransitionContract("startup-progress-started-blocks-timeout");
  assertExecutableRow(progressStarted, {
    from: "starting",
    eventClass: "runtime_progress_recent",
  });
  const progressStartedReduction = reduceApmStartupTimeoutTermination(createInitialApmGatedSteeringState(), {
    hasRuntimeProgressEvent: true,
  });
  assert.equal(progressStartedReduction.shouldTerminate, progressStarted.expectation.shouldTerminate);
  assert.equal(progressStartedReduction.blockedReason, progressStarted.expectation.startupTimeoutBlockReason);
  assert.equal(
    progressStartedReduction.nextState.expectedTerminationReason,
    progressStarted.expectation.expectedTerminationReason,
  );
  assert.equal(projectStartupTimeoutStatus(progressStartedReduction), progressStarted.to);
});

test("APM contract matrix: control-plane reconnect stays outside runtime recovery", () => {
  const row = getApmStatusTransitionContract("control-plane-reconnect-does-not-imply-runtime-recovery");
  assertExecutableRow(row, {
    from: "running",
    eventClass: "control_plane_reconnect",
  });

  const scheduled = classifyDaemonConnectionTraceEvent("daemon.connection.reconnect_scheduled", {
    reconnect_attempt: 1,
    delay_ms: 1_000,
  });
  assert.ok(scheduled);
  assert.equal(scheduled.kind, "control_plane");
  assert.equal(scheduled.eventClass, row.eventClass);
  assert.equal(scheduled.traceEvent, row.expectation.controlPlaneTraceEvent);
  assert.equal(scheduled.shouldAffectRuntimeState, false);

  const disconnected = classifyDaemonConnectionTraceEvent("daemon.connection.disconnected", {
    reconnecting: true,
    close_code: 1006,
  });
  assert.equal(disconnected?.eventClass, row.eventClass);
  assert.equal(disconnected?.shouldAffectRuntimeState, false);

  const initialConnected = classifyDaemonConnectionTraceEvent("daemon.connection.connected", {
    reconnect_attempt: 0,
  });
  assert.equal(initialConnected, null);

  const reduction = reduceApmControlPlaneEvent(createInitialApmGatedSteeringState(), {
    eventClass: scheduled.eventClass,
  });
  assert.equal(reduction.shouldTerminate, row.expectation.shouldTerminate);
  assert.equal(reduction.nextState.expectedTerminationReason, row.expectation.expectedTerminationReason);
  assert.equal(reduction.shouldAffectRuntimeState, false);
  assert.equal(projectControlPlaneStatus(reduction), row.to);
});

function assertExecutableRow(
  row: ApmStatusTransitionContractRow,
  expected: { from: ApmUserVisibleStatus; eventClass: string },
): void {
  assert.equal(row.testStatus, "executable");
  assert.equal(row.from, expected.from);
  assert.equal(row.eventClass, expected.eventClass);
}

function projectStalledRecoveryStatus(
  reduction: ApmStalledRecoveryTerminationReduction,
): ApmUserVisibleStatus {
  if (reduction.alreadyRecovering || reduction.nextState.expectedTerminationReason === "stalled_recovery") {
    return "recovering";
  }
  return "running";
}

function projectStartupTimeoutStatus(
  reduction: ApmStartupTimeoutTerminationReduction,
): ApmUserVisibleStatus {
  if (reduction.nextState.expectedTerminationReason === "startup_timeout") {
    return "error";
  }
  return "running";
}

function projectControlPlaneStatus(
  reduction: ApmControlPlaneEventReduction,
): ApmUserVisibleStatus {
  if (reduction.nextState.expectedTerminationReason) {
    return "error";
  }
  return "running";
}

function runtimeStallDiagnosticInputWithoutDetail(): Parameters<typeof projectApmRuntimeStallDiagnostic>[0] {
  return {
    staleForMs: 60_000,
    staleForMinutes: 1,
    lastActivityKind: "thinking",
    lastActivity: "thinking",
    lastActivityDetail: null,
    lastActivityDetailKind: "none",
    runtimeProgressLastEventKind: null,
    runtime: "codex",
    model: "gpt",
    platform: "linux",
    arch: "x64",
    launchId: null,
    sessionIdPresent: false,
    inboxCount: 0,
    pendingNotificationCount: 0,
    processPidPresent: false,
    driverBusyDeliveryMode: "direct",
    supportsStdinNotification: false,
    outstandingToolUses: 0,
    compacting: false,
    recentStderrCount: 0,
    recentStdoutCount: 0,
  };
}
