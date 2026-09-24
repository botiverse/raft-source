import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { test } from "vitest";

import {
  BasicTracer,
  createSpanAttrContractTracer,
  MemoryTraceSink,
} from "@botiverse/raft-shared";
import { DAEMON_CORE_TRACE_ATTR_CONTRACTS } from "../core.js";
import {
  createPiToolExecutionObserver,
  PI_TOOL_PROGRESS_COALESCE_MS,
} from "./piToolExecutionObservability.js";

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
  });
  observer.beginRuntimeTurn();
  return { observer, sink };
}

function lastSnapshotAttrs(sink: MemoryTraceSink): Record<string, unknown> {
  const snapshots = sink
    .getAllSpans()
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
  assert.doesNotMatch(JSON.stringify(sink.getAllSpans()), /upstream-call-secret/);
  assert.doesNotMatch(JSON.stringify(sink.getAllSpans()), /command|args|cwd|stdout|stderr|pid/i);

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
  assert.doesNotMatch(JSON.stringify(sink.getAllSpans()), new RegExp(rawRuntimeToolCallId));
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
  const executionSpans = sink
    .getAllSpans()
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

  const names = sink.getAllSpans().map((span) => span.name);
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
    sink.getAllSpans().filter((span) => span.name === "daemon.runtime.tool.progress.observed").length,
    2,
  );
  hold.resolve();
  await running;
  assert.equal(
    sink.getAllSpans().filter((span) => span.name === "daemon.runtime.tool.progress.observed").length,
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
