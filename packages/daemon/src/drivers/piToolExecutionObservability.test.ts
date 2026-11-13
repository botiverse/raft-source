import assert from "node:assert/strict";
import { EventEmitter } from "node:events";

import {
  BasicTracer,
  createSpanAttrContractTracer,
  MemoryTraceSink,
} from "@botiverse/raft-shared";
import { DAEMON_CORE_TRACE_ATTR_CONTRACTS } from "../core";
import {
  createPiToolExecutionObserver,
  PI_TOOL_PROGRESS_COALESCE_MS,
} from "./piToolExecutionObservability";
import { createPiCommandTool } from "./piCommandTool";
import { traceRows } from "../testing/traceRows";

class FakeChildProcess extends EventEmitter {
  readonly pid = 4242;
  exitCode: number | null = null;
  signalCode: NodeJS.Signals | null = null;

  kill(_signal?: number | NodeJS.Signals): boolean {
    return true;
  }
}

function deferred(): {
  promise: Promise<void>;
  resolve: () => void;
} {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

function testObserver(input: {
  now: () => number;
  probeChildLiveness?: () => boolean | undefined;
  probeProcessGroupLiveness?: () => boolean | undefined;
  runtimeSessionId?: string | null;
}) {
  const sink = new MemoryTraceSink();
  const tracer = createSpanAttrContractTracer(
    new BasicTracer({ sink, clock: input.now }),
    DAEMON_CORE_TRACE_ATTR_CONTRACTS,
  );
  const observer = createPiToolExecutionObserver({
    tracer,
    serverId: "11111111-1111-4111-8111-111111111111",
    machineId: "22222222-2222-4222-8222-222222222222",
    agentId: "33333333-3333-4333-8333-333333333333",
    launchId: "44444444-4444-4444-8444-444444444444",
    runtimeVersion: "0.82.1",
    runtimeSessionId: input.runtimeSessionId === undefined ? "pi-session-1" : input.runtimeSessionId,
    now: input.now,
    probeChildLiveness: input.probeChildLiveness
      ? () => input.probeChildLiveness!()
      : () => true,
    ...(input.probeProcessGroupLiveness ? { probeProcessGroupLiveness: () => input.probeProcessGroupLiveness!() } : {}),
  });
  observer.beginRuntimeTurn();
  return { observer, sink };
}

function lastSnapshotAttrs(sink: MemoryTraceSink): Record<string, unknown> {
  const snapshots = traceRows(sink)
    .filter((span) => span.name === "daemon.runtime.tool.diagnostic.snapshot");
  assert.ok(snapshots.length > 0, "expected a diagnostic snapshot fact");
  return { ...(snapshots.at(-1)?.attrs ?? {}) };
}

test("Pi tool diagnostics classify recent and stale positive process evidence without causal claims", async () => {
  let now = 1_000;
  const { observer, sink } = testObserver({ now: () => now });
  const hold = deferred();
  const child = new FakeChildProcess();
  const running = observer.runToolExecution("upstream-call-secret", undefined, async () => {
    observer.observeProcessSpawned(child as never, {
      processTreeTracking: "process_group",
      stdioMode: "pipe",
    });
    observer.observeProcessProgress(64);
    observer.observeRuntimeUpdate("upstream-call-secret");
    await hold.promise;
  });

  now += 10_000;
  const recent = observer.emitDiagnosticSnapshots({
    trigger: "testbed_acceptance",
    runtimeInactivityAgeMs: 10_000,
    observationIntervalMs: 60_000,
  });
  assert.equal(recent.length, 1);
  assert.equal(recent[0]?.classification, "running_with_recent_progress");
  assert.equal(recent[0]?.processLiveness, "alive");
  assert.equal(recent[0]?.progressState, "recent");
  assert.equal(recent[0]?.toolAgeMs, 10_000);
  assert.equal(recent[0]?.lastProgressAgeMs, 10_000);
  assert.equal(recent[0]?.negativeEvidenceBucket, "none");

  now += 60_001;
  const stale = observer.emitDiagnosticSnapshots({
    trigger: "manual_probe",
    runtimeInactivityAgeMs: 70_001,
    observationIntervalMs: 60_000,
  });
  assert.equal(stale[0]?.classification, "running_no_observed_progress");
  assert.equal(stale[0]?.processLiveness, "alive");
  assert.equal(stale[0]?.progressState, "stale");
  assert.equal(stale[0]?.toolAgeMs, 70_001);
  assert.equal(stale[0]?.lastProgressAgeMs, 70_001);

  const attrs = lastSnapshotAttrs(sink);
  assert.equal(attrs.classification, "running_no_observed_progress");
  assert.equal(attrs.process_liveness_source, "child_handle_and_os_probe");
  assert.equal(attrs.runtime_tool_call_id_present, true);
  assert.equal(attrs.schema_version, "stuck_tool_v0");
  assert.doesNotMatch(JSON.stringify(traceRows(sink)), /upstream-call-secret/);
  assert.doesNotMatch(JSON.stringify(traceRows(sink)), /command|args|cwd|stdout|stderr|pid/i);

  hold.resolve();
  await running;
});

test("Pi tool diagnostics keep duplicate upstream IDs independent and ignore ambiguous SDK progress", async () => {
  let now = 3_000;
  const { observer, sink } = testObserver({ now: () => now });
  const firstHold = deferred();
  const secondHold = deferred();
  const allowFirstStdio = deferred();
  const firstStdioObserved = deferred();
  const rawRuntimeToolCallId = "duplicate-upstream-call-secret";

  const first = observer.runToolExecution(rawRuntimeToolCallId, undefined, async () => {
    observer.observeProcessSpawned(new FakeChildProcess() as never, {
      processTreeTracking: "process_group",
      stdioMode: "pipe",
    });
    await allowFirstStdio.promise;
    observer.observeProcessProgress(1);
    firstStdioObserved.resolve();
    await firstHold.promise;
  });
  const second = observer.runToolExecution(rawRuntimeToolCallId, undefined, async () => {
    observer.observeProcessSpawned(new FakeChildProcess() as never, {
      processTreeTracking: "process_group",
      stdioMode: "pipe",
    });
    await secondHold.promise;
  });

  observer.observeRuntimeUpdate(rawRuntimeToolCallId);
  let snapshots = observer.emitDiagnosticSnapshots({
    trigger: "testbed_acceptance",
    runtimeInactivityAgeMs: 1,
    observationIntervalMs: 60_000,
  });
  assert.equal(snapshots.length, 2);
  assert.notEqual(snapshots[0]?.toolExecutionInstanceId, snapshots[1]?.toolExecutionInstanceId);
  const secondExecutionId = snapshots[1]?.toolExecutionInstanceId;
  assert.deepEqual(
    snapshots.map((snapshot) => [snapshot.classification, snapshot.progressState]),
    [
      ["running_no_observed_progress", "never_observed"],
      ["running_no_observed_progress", "never_observed"],
    ],
    "a multi-match SDK update is ambiguous positive evidence and upgrades neither execution",
  );

  allowFirstStdio.resolve();
  await firstStdioObserved.promise;
  snapshots = observer.emitDiagnosticSnapshots({
    trigger: "manual_probe",
    runtimeInactivityAgeMs: 2,
    observationIntervalMs: 60_000,
  });
  assert.deepEqual(
    snapshots.map((snapshot) => [snapshot.classification, snapshot.progressState]),
    [
      ["running_with_recent_progress", "recent"],
      ["running_no_observed_progress", "never_observed"],
    ],
    "per-execution stdio upgrades only the execution that observed it",
  );

  firstHold.resolve();
  await first;
  snapshots = observer.emitDiagnosticSnapshots({
    trigger: "manual_probe",
    runtimeInactivityAgeMs: 3,
    observationIntervalMs: 60_000,
  });
  assert.equal(snapshots.length, 1);
  assert.equal(snapshots[0]?.toolExecutionInstanceId, secondExecutionId);
  assert.equal(snapshots[0]?.classification, "running_no_observed_progress");
  assert.equal(snapshots[0]?.progressState, "never_observed");

  observer.observeRuntimeUpdate(rawRuntimeToolCallId);
  snapshots = observer.emitDiagnosticSnapshots({
    trigger: "manual_probe",
    runtimeInactivityAgeMs: 4,
    observationIntervalMs: 60_000,
  });
  assert.equal(snapshots[0]?.classification, "running_with_recent_progress");
  assert.equal(snapshots[0]?.progressState, "recent");

  secondHold.resolve();
  await second;
  assert.equal(
    observer.emitDiagnosticSnapshots({
      trigger: "manual_probe",
      runtimeInactivityAgeMs: 5,
    })[0]?.toolPending,
    false,
  );
  assert.doesNotMatch(JSON.stringify(traceRows(sink)), new RegExp(rawRuntimeToolCallId));
});

test("Pi tool diagnostics keep empty upstream IDs independent and unindexed", async () => {
  const { observer, sink } = testObserver({ now: () => 4_000 });
  const firstHold = deferred();
  const secondHold = deferred();
  const first = observer.runToolExecution("", undefined, async () => {
    await firstHold.promise;
  });
  const second = observer.runToolExecution("", undefined, async () => {
    await secondHold.promise;
  });

  observer.observeRuntimeUpdate("");
  let snapshots = observer.emitDiagnosticSnapshots({
    trigger: "testbed_acceptance",
    runtimeInactivityAgeMs: 1,
  });
  assert.equal(snapshots.length, 2);
  assert.notEqual(snapshots[0]?.toolExecutionInstanceId, snapshots[1]?.toolExecutionInstanceId);
  const secondExecutionId = snapshots[1]?.toolExecutionInstanceId;
  assert.deepEqual(
    snapshots.map((snapshot) => snapshot.progressState),
    ["never_observed", "never_observed"],
  );

  firstHold.resolve();
  await first;
  observer.observeRuntimeUpdate("");
  snapshots = observer.emitDiagnosticSnapshots({
    trigger: "manual_probe",
    runtimeInactivityAgeMs: 2,
  });
  assert.equal(snapshots.length, 1);
  assert.equal(snapshots[0]?.toolExecutionInstanceId, secondExecutionId);
  assert.equal(snapshots[0]?.progressState, "never_observed");

  secondHold.resolve();
  await second;
  assert.equal(
    observer.emitDiagnosticSnapshots({
      trigger: "manual_probe",
      runtimeInactivityAgeMs: 3,
    })[0]?.toolPending,
    false,
  );
  const executionSpans = traceRows(sink)
    .filter((span) => span.name === "daemon.runtime.tool.execution.started");
  assert.equal(executionSpans.length, 2);
  for (const span of executionSpans) {
    const attrs = span.attrs ?? {};
    assert.equal(attrs.runtime_tool_call_id_present, false);
    assert.equal(Object.hasOwn(attrs, "runtime_tool_call_id"), false);
  }
});

test("Pi tool diagnostics separate completion loss from a running process", async () => {
  let now = 5_000;
  const { observer, sink } = testObserver({ now: () => now });
  const hold = deferred();
  const child = new FakeChildProcess();
  const running = observer.runToolExecution("call-completion", undefined, async () => {
    observer.observeProcessSpawned(child as never, {
      processTreeTracking: "process_group",
      stdioMode: "pipe",
    });
    now += 250;
    observer.observeProcessExit({ code: 0, signal: null });
    await hold.promise;
  });

  now += 1_000;
  const snapshots = observer.emitDiagnosticSnapshots({
    trigger: "testbed_acceptance",
    runtimeInactivityAgeMs: 1_000,
  });
  assert.equal(snapshots[0]?.classification, "completion_loss");
  assert.equal(snapshots[0]?.processLiveness, "exited");
  assert.equal(snapshots[0]?.negativeEvidenceBucket, "none");
  const attrs = lastSnapshotAttrs(sink);
  assert.equal(attrs.classification, "completion_loss");
  assert.equal(attrs.process_liveness_source, "child_handle");

  hold.resolve();
  await running;
});

test("Pi tool diagnostics keep a pending call with no carrier liveness-unknown", async () => {
  let now = 10_000;
  const { observer, sink } = testObserver({ now: () => now });
  const hold = deferred();
  const running = observer.runToolExecution("call-no-carrier", undefined, async () => {
    await hold.promise;
  });

  now += 500;
  const snapshots = observer.emitDiagnosticSnapshots({
    trigger: "testbed_acceptance",
    runtimeInactivityAgeMs: 500,
  });
  assert.equal(snapshots[0]?.classification, "pending_liveness_unknown");
  assert.equal(snapshots[0]?.processLiveness, "not_spawned");
  assert.equal(snapshots[0]?.negativeEvidenceBucket, "process_carrier_missing");
  assert.equal(lastSnapshotAttrs(sink).negative_evidence_bucket, "process_carrier_missing");

  hold.resolve();
  await running;
});

test("Pi tool diagnostics keep an unreadable process probe liveness-unknown", async () => {
  let now = 12_000;
  const { observer, sink } = testObserver({
    now: () => now,
    probeChildLiveness: () => undefined,
  });
  const hold = deferred();
  const child = new FakeChildProcess();
  const running = observer.runToolExecution("call-unreadable-probe", undefined, async () => {
    observer.observeProcessSpawned(child as never, {
      processTreeTracking: "process_group",
      stdioMode: "pipe",
    });
    await hold.promise;
  });

  now += 500;
  const snapshots = observer.emitDiagnosticSnapshots({
    trigger: "testbed_acceptance",
    runtimeInactivityAgeMs: 500,
  });
  assert.equal(snapshots[0]?.classification, "pending_liveness_unknown");
  assert.equal(snapshots[0]?.processLiveness, "unavailable");
  assert.equal(snapshots[0]?.negativeEvidenceBucket, "process_probe_unavailable");
  assert.equal(lastSnapshotAttrs(sink).process_liveness_source, "none");

  hold.resolve();
  await running;
});

test("Pi tool diagnostics do not promote a false liveness probe to an observed exit", async () => {
  let now = 13_000;
  const { observer, sink } = testObserver({
    now: () => now,
    probeChildLiveness: () => false,
  });
  const hold = deferred();
  const child = new FakeChildProcess();
  const running = observer.runToolExecution("call-false-probe", undefined, async () => {
    observer.observeProcessSpawned(child as never, {
      processTreeTracking: "process_group",
      stdioMode: "pipe",
    });
    await hold.promise;
  });

  now += 750;
  const snapshots = observer.emitDiagnosticSnapshots({
    trigger: "testbed_acceptance",
    runtimeInactivityAgeMs: 750,
  });
  assert.equal(snapshots[0]?.classification, "pending_liveness_unknown");
  assert.equal(snapshots[0]?.processLiveness, "unavailable");
  assert.equal(snapshots[0]?.negativeEvidenceBucket, "producer_stale_or_unreachable");
  assert.equal(lastSnapshotAttrs(sink).process_liveness_source, "none");

  hold.resolve();
  await running;
});

test("Pi tool diagnostics attribute inactivity without a pending tool", () => {
  const { observer, sink } = testObserver({ now: () => 20_000 });
  const snapshots = observer.emitDiagnosticSnapshots({
    trigger: "runtime_inactivity_tripwire",
    runtimeInactivityAgeMs: 15 * 60_000,
  });

  assert.equal(snapshots.length, 1);
  assert.equal(snapshots[0]?.classification, "runtime_inactive_without_pending_tool");
  assert.equal(snapshots[0]?.toolPending, false);
  assert.equal(snapshots[0]?.negativeEvidenceBucket, "none");
  assert.equal(lastSnapshotAttrs(sink).classification, "runtime_inactive_without_pending_tool");
});

test("Pi tool success emits ordered lifecycle facts with no residual pending diagnostic", async () => {
  let now = 30_000;
  const { observer, sink } = testObserver({ now: () => now });
  const child = new FakeChildProcess();
  await observer.runToolExecution("call-success", undefined, async () => {
    observer.observeProcessSpawned(child as never, {
      processTreeTracking: "process_group",
      stdioMode: "pipe",
    });
    observer.observeProcessProgress(8);
    now += 25;
    observer.observeProcessExit({ code: 0, signal: null });
  });

  const names = traceRows(sink).map((span) => span.name);
  assert.deepEqual(names, [
    "daemon.runtime.tool.execution.started",
    "daemon.runtime.tool.process.spawned",
    "daemon.runtime.tool.progress.observed",
    "daemon.runtime.tool.process.exited",
    "daemon.runtime.tool.execution.finished",
  ]);
  assert.equal(names.includes("daemon.runtime.tool.diagnostic.snapshot"), false);

  const snapshots = observer.emitDiagnosticSnapshots({
    trigger: "manual_probe",
    runtimeInactivityAgeMs: 0,
  });
  assert.equal(snapshots[0]?.classification, "runtime_inactive_without_pending_tool");
  assert.equal(snapshots[0]?.toolPending, false);
});

test("Pi progress facts coalesce to at most one per minute plus a final flush", async () => {
  let now = 100_000;
  const { observer, sink } = testObserver({ now: () => now });
  const hold = deferred();
  const child = new FakeChildProcess();
  const running = observer.runToolExecution("call-progress", undefined, async () => {
    observer.observeProcessSpawned(child as never, {
      processTreeTracking: "process_group",
      stdioMode: "pipe",
    });
    observer.observeProcessProgress(1);
    now += 1_000;
    observer.observeProcessProgress(2);
    observer.observeRuntimeUpdate("call-progress");
    now += PI_TOOL_PROGRESS_COALESCE_MS - 1_000;
    observer.observeProcessProgress(3);
    now += 1;
    observer.observeProcessProgress(4);
    await hold.promise;
  });

  assert.equal(
    traceRows(sink).filter((span) => span.name === "daemon.runtime.tool.progress.observed").length,
    2,
  );
  hold.resolve();
  await running;
  assert.equal(
    traceRows(sink).filter((span) => span.name === "daemon.runtime.tool.progress.observed").length,
    3,
    "the final dirty window is flushed before execution.finished",
  );
});

test("Pi diagnostic identity gaps remain explicit negative evidence", async () => {
  const { observer, sink } = testObserver({
    now: () => 200_000,
    runtimeSessionId: null,
  });
  const hold = deferred();
  const running = observer.runToolExecution("call-missing-session", undefined, async () => {
    await hold.promise;
  });
  const snapshots = observer.emitDiagnosticSnapshots({
    trigger: "manual_probe",
    runtimeInactivityAgeMs: 1,
  });

  assert.equal(snapshots[0]?.classification, "pending_liveness_unknown");
  assert.equal(snapshots[0]?.negativeEvidenceBucket, "runtime_session_identity_missing");
  assert.equal(lastSnapshotAttrs(sink).runtime_session_id_present, false);
  hold.resolve();
  await running;
});

test("Pi diagnostic turn identity gaps remain explicit negative evidence", async () => {
  const { observer, sink } = testObserver({ now: () => 210_000 });
  observer.observeRuntimeTurnEnd();
  const hold = deferred();
  const running = observer.runToolExecution("call-missing-turn", undefined, async () => {
    await hold.promise;
  });
  const snapshots = observer.emitDiagnosticSnapshots({
    trigger: "manual_probe",
    runtimeInactivityAgeMs: 1,
  });

  assert.equal(snapshots[0]?.classification, "pending_liveness_unknown");
  assert.equal(snapshots[0]?.negativeEvidenceBucket, "turn_identity_missing");
  assert.equal(lastSnapshotAttrs(sink).negative_evidence_bucket, "turn_identity_missing");
  hold.resolve();
  await running;
});

// Task #1302: a shell that exited can leave a backgrounded descendant working
// in its process group, and abort kills the whole group. completion_loss must
// say whether the group is gone before stalled recovery may cut the tool off.
test("Pi tool completion_loss reports process-group liveness only for process-group tracked tools", async () => {
  const cases: Array<{
    tracking: "process_group" | "unknown";
    groupAlive: boolean | undefined;
    expected: "alive" | "exited" | "unknown";
  }> = [
    { tracking: "process_group", groupAlive: true, expected: "alive" },
    { tracking: "process_group", groupAlive: false, expected: "exited" },
    { tracking: "process_group", groupAlive: undefined, expected: "unknown" },
    { tracking: "unknown", groupAlive: false, expected: "unknown" },
  ];
  for (const testCase of cases) {
    const now = 1_000;
    const { observer, sink } = testObserver({
      now: () => now,
      probeProcessGroupLiveness: () => testCase.groupAlive,
    });
    const hold = deferred();
    const child = new FakeChildProcess();
    const running = observer.runToolExecution("call-group", undefined, async () => {
      observer.observeProcessSpawned(child as never, { processTreeTracking: testCase.tracking, stdioMode: "pipe" });
      child.exitCode = 0;
      observer.observeProcessExit({ code: 0, signal: null });
      await hold.promise;
    });
    await new Promise((resolve) => setImmediate(resolve));
    const [snapshot] = observer.emitDiagnosticSnapshots({ trigger: "queued_message_recovery", runtimeInactivityAgeMs: 16 * 60_000 });
    assert.equal(snapshot?.classification, "completion_loss", JSON.stringify(testCase));
    assert.equal(snapshot?.processGroupLiveness, testCase.expected, JSON.stringify(testCase));
    assert.equal(snapshot?.runtimeToolCallId, "call-group", "in-memory id lets the daemon match the open call");
    assert.doesNotMatch(JSON.stringify(traceRows(sink)), /call-group/, "the raw call id never reaches a trace");
    assert.equal(lastSnapshotAttrs(sink).process_group_liveness, testCase.expected, "the fact survives the attr contract");
    hold.resolve();
    await running;
  }
});

// failure_reason on daemon.runtime.tool.execution.finished, through the real
// command tool (Raft's POSIX operations, Pi's bash tool, the observer wrapper)
// and the span attr contract, so a reason the contract drops would read as
// missing here.
function finishedAttrs(sink: MemoryTraceSink): Record<string, unknown> {
  const finished = traceRows(sink).filter((row) => row.name === "daemon.runtime.tool.execution.finished");
  assert.equal(finished.length, 1, "expected one finished fact");
  return { ...(finished[0]?.attrs ?? {}) };
}

function exitedAttrs(sink: MemoryTraceSink): Record<string, unknown> | undefined {
  return traceRows(sink).find((row) => row.name === "daemon.runtime.tool.process.exited")?.attrs;
}

function realCommandTool(deps: Omit<Parameters<typeof createPiCommandTool>[2], "observer"> = {}) {
  const { observer, sink } = testObserver({ now: Date.now });
  const tool = createPiCommandTool(process.cwd(), process.env, { platform: process.platform, ...deps, observer });
  return { observer, sink, tool };
}

const posixOnly = { skip: process.platform === "win32" };

test("failure_reason: a command that succeeds carries none", posixOnly, async () => {
  const { sink, tool } = realCommandTool();
  await tool.execute("call-ok", { command: "true" });
  const attrs = finishedAttrs(sink);
  assert.equal(attrs.execution_state, "succeeded");
  assert.equal("failure_reason" in attrs, false);
});

test("failure_reason: a non-zero exit is a result, not a failure; the exit kind carries it", posixOnly, async () => {
  const { sink, tool } = realCommandTool();
  const result = await tool.execute("call-exit", { command: "exit 3" });
  assert.equal((result as { isError?: boolean }).isError, true, "Pi resolves a non-zero exit with isError");
  const attrs = finishedAttrs(sink);
  assert.equal(attrs.execution_state, "succeeded");
  assert.equal("failure_reason" in attrs, false);
  assert.equal(exitedAttrs(sink)?.exit_kind, "code_nonzero");
});

test("failure_reason: a command killed by a signal it was not sent is killed_by_signal", posixOnly, async () => {
  const { sink, tool } = realCommandTool();
  await assert.rejects(tool.execute("call-signal", { command: "kill -KILL $$" }));
  const attrs = finishedAttrs(sink);
  assert.equal(attrs.execution_state, "failed");
  assert.equal(attrs.failure_reason, "killed_by_signal");
  assert.equal(exitedAttrs(sink)?.exit_kind, "signal");
});

test("failure_reason: the tool's own timeout, explicit or default, is timeout", posixOnly, async () => {
  for (const params of [{ command: "sleep 30", timeout: 0.3 }, { command: "sleep 30" }]) {
    const { sink, tool } = realCommandTool({ defaultTimeoutSeconds: 0.3 });
    await assert.rejects(tool.execute("call-timeout", params), /timed out/);
    const attrs = finishedAttrs(sink);
    assert.equal(attrs.execution_state, "failed", JSON.stringify(params));
    assert.equal(attrs.failure_reason, "timeout", JSON.stringify(params));
    // The timeout kills the group, so the exit alone would read as a signal.
    assert.equal(exitedAttrs(sink)?.exit_kind, "signal");
  }
});

test("failure_reason: a shell that cannot be spawned is spawn_failed", async () => {
  const spawnFails = (() => {
    const child = new FakeChildProcess() as FakeChildProcess & { stdout: EventEmitter; stderr: EventEmitter };
    child.stdout = new EventEmitter();
    child.stderr = new EventEmitter();
    queueMicrotask(() => child.emit("error", Object.assign(new Error("spawn ENOENT"), { code: "ENOENT" })));
    return child;
  }) as never;
  const { sink, tool } = realCommandTool({ platform: "linux", spawn: spawnFails });
  await assert.rejects(tool.execute("call-spawn", { command: "true" }));
  const attrs = finishedAttrs(sink);
  assert.equal(attrs.execution_state, "failed");
  assert.equal(attrs.failure_reason, "spawn_failed");
});

test("failure_reason: any other failure is other", posixOnly, async () => {
  const { sink, observer } = testObserver({ now: Date.now });
  const tool = createPiCommandTool("/nonexistent-raft-cwd", process.env, { platform: process.platform, observer });
  await assert.rejects(tool.execute("call-cwd", { command: "true" }), /Working directory does not exist/);
  const attrs = finishedAttrs(sink);
  assert.equal(attrs.execution_state, "failed");
  assert.equal(attrs.failure_reason, "other");
});

test("failure_reason: an abort is attributed to the cause recorded before it", posixOnly, async () => {
  const cases = [
    { cause: "stop", expected: "aborted_by_stop" },
    { cause: "interrupt", expected: "aborted_by_interrupt" },
    { cause: undefined, expected: "other" },
  ] as const;
  for (const testCase of cases) {
    const { observer, sink, tool } = realCommandTool();
    const abort = new AbortController();
    const run = tool.execute("call-abort", { command: "sleep 30", timeout: 60 }, abort.signal);
    await new Promise((resolve) => setTimeout(resolve, 100));
    if (testCase.cause) observer.observeAbortRequested(testCase.cause);
    abort.abort();
    await assert.rejects(run, /Command aborted/);
    const attrs = finishedAttrs(sink);
    assert.equal(attrs.execution_state, "aborted", JSON.stringify(testCase));
    assert.equal(attrs.failure_reason, testCase.expected, JSON.stringify(testCase));
  }
});

test("failure_reason: an abort cause only marks executions pending when it was recorded", async () => {
  const { observer, sink } = testObserver({ now: Date.now });
  observer.observeAbortRequested("stop");
  const abort = new AbortController();
  abort.abort();
  await assert.rejects(observer.runToolExecution("late", abort.signal, async () => {
    throw new Error("aborted");
  }));
  assert.equal(finishedAttrs(sink).failure_reason, "other");
});
