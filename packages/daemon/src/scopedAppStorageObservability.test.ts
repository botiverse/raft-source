import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import {
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "vitest";
import { fileURLToPath } from "node:url";

import { FakeClock } from "./testing/fakeClock.js";
import {
  createScopedAppStorageFactory,
  type ScopedAppStorageFailureEvent,
} from "./scopedAppStorage.js";
import {
  createScopedAppStorageObserver,
  evaluateScopedAppStorageInstrumentation,
  renderScopedAppStorageCoverageMatrix,
  SCOPED_APP_STORAGE_OBSERVATION_FAMILIES,
} from "./scopedAppStorageObservability.js";

const BASE_EVENT = {
  store: "app_state",
  appId: "system.reminder",
  serverId: "server-a",
  writerEpoch: "writer-1",
  outcome: "failed",
} as const;

test("the observation family set and event routing are closed and exhaustive", () => {
  assert.deepEqual(SCOPED_APP_STORAGE_OBSERVATION_FAMILIES, [
    "access_failure",
    "read_failure",
    "write_failure",
    "invalid_payload",
    "internal_error",
    "legacy_quarantine_failure",
  ]);
  const traces: Array<{ name: string; attrs: Record<string, unknown> }> = [];
  const clock = new FakeClock();
  const observer = createScopedAppStorageObserver({
    clock,
    trace: (name, attrs) => traces.push({ name, attrs }),
    serverId: "server-a",
    writerEpoch: "writer-1",
    rateThreshold: 99,
  });
  try {
    const inputs: Array<Pick<ScopedAppStorageFailureEvent, "operation" | "reason">> = [
      { operation: "access", reason: "capability_revoked" },
      { operation: "read", reason: "storage_io" },
      { operation: "write", reason: "lock_contention" },
      { operation: "decode", reason: "invalid_payload" },
      { operation: "decode", reason: "internal_error" },
      { operation: "legacy_quarantine", reason: "storage_io" },
    ];
    for (const input of inputs) {
      observer.observe({ ...BASE_EVENT, ...input });
    }
    assert.deepEqual(
      traces.filter((trace) => trace.name === "daemon.app_storage.counter")
        .map((trace) => trace.attrs.family),
      SCOPED_APP_STORAGE_OBSERVATION_FAMILIES,
    );
  } finally {
    observer.stop();
  }
});

test("real per-store write storms increment scoped counters and emit class-named alerts", () => {
  const root = mkdtempSync(path.join(os.tmpdir(), "raft-task229-write-storm-"));
  const slockHome = path.join(root, "not-a-directory");
  writeFileSync(slockHome, "blocks the real scoped-storage write path");
  const clock = new FakeClock();
  const traces: Array<{ name: string; attrs: Record<string, unknown>; status?: "ok" | "error" }> = [];
  const observer = createScopedAppStorageObserver({
    clock,
    trace: (name, attrs, status) => traces.push({ name, attrs, status }),
    serverId: "server-a",
    writerEpoch: "writer-1",
    rateThreshold: 3,
  });
  try {
    const factory = createScopedAppStorageFactory({
      slockHome,
      owner: { machineId: "machine-1", serverId: "server-a" },
      writerEpoch: "writer-1",
      onFailure: (event) => observer.observe(event),
    });
    for (const appId of ["system.reminder", "system.agent-inbox"]) {
      const storage = factory.open({ appId });
      for (let attempt = 0; attempt < 3; attempt += 1) {
        assert.throws(() => storage.writeTextAtomic("payload must not enter telemetry"));
      }
    }

    const counters = traces.filter((trace) => trace.name === "daemon.app_storage.counter");
    for (const appId of ["system.reminder", "system.agent-inbox"]) {
      const scoped = counters.filter((trace) => trace.attrs.app === appId);
      assert.deepEqual(scoped.map((trace) => trace.attrs.count), [1, 2, 3]);
      assert.equal(scoped.every((trace) => trace.attrs.outcome === "failed"), true);
      assert.equal(scoped.every((trace) => trace.attrs.reason === "storage_io"), true);
      assert.equal(scoped.every((trace) => trace.attrs.server_id === "server-a"), true);
      assert.equal(scoped.every((trace) => trace.attrs.writer_epoch === "writer-1"), true);
    }
    assert.deepEqual(
      traces.filter((trace) => trace.name === "daemon.app_storage.alert").map((trace) => ({
        appId: trace.attrs.app,
        reason: trace.attrs.reason,
        operation: trace.attrs.operation,
        outcome: trace.attrs.outcome,
        failureReason: trace.attrs.failure_reason,
        family: trace.attrs.family,
        status: trace.status,
      })),
      ["system.reminder", "system.agent-inbox"].map((appId) => ({
        appId,
        reason: "write_failure_rate",
        operation: "write",
        outcome: "failed",
        failureReason: "storage_io",
        family: "write_failure",
        status: "error",
      })),
    );
    const serialized = JSON.stringify(traces);
    assert.equal(serialized.includes("payload must not enter telemetry"), false);
    assert.equal(serialized.includes(slockHome), false);
  } finally {
    observer.stop();
    rmSync(root, { recursive: true, force: true });
  }
});

test("both persisted stores retain EDGE versus repeated LEVEL identity and alert by class", () => {
  const clock = new FakeClock();
  const traces: Array<{ name: string; attrs: Record<string, unknown>; status?: "ok" | "error" }> = [];
  const observer = createScopedAppStorageObserver({
    clock,
    trace: (name, attrs, status) => traces.push({ name, attrs, status }),
    serverId: "server-a",
    writerEpoch: "writer-1",
    rateThreshold: 2,
  });
  try {
    for (const appId of ["system.reminder", "system.agent-inbox"]) {
      observer.observe({
        ...BASE_EVENT,
        appId,
        operation: "decode",
        reason: "invalid_payload",
        failureInstanceId: `opaque-generation-${appId}`,
        observation: "edge",
      });
      observer.observe({
        ...BASE_EVENT,
        appId,
        operation: "decode",
        reason: "invalid_payload",
        failureInstanceId: `opaque-generation-${appId}`,
        observation: "level",
      });
    }
    assert.deepEqual(
      traces.filter((trace) => trace.name === "daemon.app_storage.alert").map((alert) => ({
        appId: alert.attrs.app,
        reason: alert.attrs.reason,
        corruptionClass: alert.attrs.corruption_class,
        status: alert.status,
      })),
      ["system.reminder", "system.agent-inbox"].map((appId) => ({
        appId,
        reason: "invalid_payload_rate",
        corruptionClass: "level",
        status: "error",
      })),
    );
  } finally {
    observer.stop();
  }
});

test("fresh complete heartbeat proves healthy zero while missing or stale family is INSTRUMENT_FAILED", () => {
  const clock = new FakeClock();
  const traces: Array<{ name: string; attrs: Record<string, unknown> }> = [];
  const observer = createScopedAppStorageObserver({
    clock,
    trace: (name, attrs) => traces.push({ name, attrs }),
    serverId: "server-a",
    writerEpoch: "writer-1",
  });
  try {
    const heartbeats = traces.filter((trace) => trace.name === "daemon.app_storage.heartbeat");
    assert.equal(heartbeats.length, SCOPED_APP_STORAGE_OBSERVATION_FAMILIES.length);
    assert.deepEqual(
      evaluateScopedAppStorageInstrumentation({
        heartbeats,
        serverId: "server-a",
        writerEpoch: "writer-1",
        nowMs: clock.now(),
      }),
      { status: "healthy_zero" },
    );
    assert.deepEqual(
      evaluateScopedAppStorageInstrumentation({
        heartbeats: heartbeats.slice(1),
        serverId: "server-a",
        writerEpoch: "writer-1",
        nowMs: clock.now(),
      }),
      { status: "instrument_failed", reason: "counter_missing" },
    );
    assert.deepEqual(
      evaluateScopedAppStorageInstrumentation({
        heartbeats,
        serverId: "server-a",
        writerEpoch: "writer-from-another-process-life",
        nowMs: clock.now(),
      }),
      { status: "instrument_failed", reason: "counter_missing" },
      "a prior writer epoch cannot prove a healthy zero after restart",
    );
    observer.heartbeat();
    assert.equal(
      traces.filter((trace) => trace.name === "daemon.app_storage.heartbeat").length,
      2 * SCOPED_APP_STORAGE_OBSERVATION_FAMILIES.length,
    );
    clock.advanceBy(60_000);
    assert.equal(
      traces.filter((trace) => trace.name === "daemon.app_storage.heartbeat").length,
      3 * SCOPED_APP_STORAGE_OBSERVATION_FAMILIES.length,
      "a manual heartbeat must replace rather than multiply the pending timer",
    );
    clock.advanceBy(2 * 60 * 1_000 + 1);
    assert.deepEqual(
      evaluateScopedAppStorageInstrumentation({
        heartbeats,
        serverId: "server-a",
        writerEpoch: "writer-1",
        nowMs: clock.now(),
      }),
      { status: "instrument_failed", reason: "heartbeat_stale" },
    );
  } finally {
    observer.stop();
  }
});

test("an unregistered failure family emits INSTRUMENT_FAILED instead of a zero", () => {
  const traces: Array<{ name: string; attrs: Record<string, unknown>; status?: "ok" | "error" }> = [];
  const clock = new FakeClock();
  const observer = createScopedAppStorageObserver({
    clock,
    trace: (name, attrs, status) => traces.push({ name, attrs, status }),
    serverId: "server-a",
    writerEpoch: "writer-1",
    registeredFamilies: SCOPED_APP_STORAGE_OBSERVATION_FAMILIES.filter((family) =>
      family !== "read_failure"
    ),
  });
  try {
    observer.observe({
      ...BASE_EVENT,
      operation: "read",
      reason: "storage_io",
    });
    assert.equal(
      traces.some((trace) => trace.name === "daemon.app_storage.counter"),
      false,
    );
    const [failure] = traces.filter((trace) =>
      trace.name === "daemon.app_storage.instrumentation"
    );
    assert.deepEqual(failure && {
      family: failure.attrs.family,
      outcome: failure.attrs.outcome,
      reason: failure.attrs.reason,
      status: failure.status,
    }, {
      family: "read_failure",
      outcome: "instrument_failed",
      reason: "counter_missing",
      status: "error",
    });
  } finally {
    observer.stop();
  }
});

test("coverage report renders the complete two-store by three-dimension matrix", () => {
  const matrix = renderScopedAppStorageCoverageMatrix([
    {
      appId: "system.reminder",
      dimensions: {
        W: { status: "covered", arm: "A1" },
        D: { status: "covered", arm: "A2" },
        P: { status: "covered", arm: "A5" },
      },
    },
    {
      appId: "system.agent-inbox",
      dimensions: {
        W: { status: "covered", arm: "A1" },
        D: {
          status: "not_applicable",
          reason: "all production read routes are enumerated and caught",
        },
        P: { status: "covered", arm: "A5" },
      },
    },
  ]);
  assert.equal(matrix.length, 2 * 3);
  assert.deepEqual(
    matrix.map((cell) => `${cell.appId}:${cell.dimension}`).sort(),
    [
      "system.agent-inbox:D",
      "system.agent-inbox:P",
      "system.agent-inbox:W",
      "system.reminder:D",
      "system.reminder:P",
      "system.reminder:W",
    ],
  );
  assert.deepEqual(
    matrix.filter((cell) => cell.status === "not_applicable"),
    [{
      appId: "system.agent-inbox",
      dimension: "D",
      status: "not_applicable",
      reason: "all production read routes are enumerated and caught",
    }],
  );
});

test("a fatal Reminder write failure leaves an epoch-bound durable counter before restart", () => {
  const machineDir = mkdtempSync(path.join(os.tmpdir(), "raft-task229-crash-"));
  const slockHome = path.join(machineDir, "not-a-directory");
  writeFileSync(slockHome, "blocks the real scoped-storage write path");
  const observerUrl = new URL("./scopedAppStorageObservability.ts", import.meta.url).href;
  const storageUrl = new URL("./scopedAppStorage.ts", import.meta.url).href;
  const connectionUrl = new URL("./connection.ts", import.meta.url).href;
  const traceClientUrl = new URL("../../trace-client/src/index.ts", import.meta.url).href;
  const script = `
    import { createScopedAppStorageObserver } from ${JSON.stringify(observerUrl)};
    import { createScopedAppStorageFactory } from ${JSON.stringify(storageUrl)};
    import { systemClock } from ${JSON.stringify(connectionUrl)};
    import { createTraceClient, LocalRotatingTraceSink } from ${JSON.stringify(traceClientUrl)};
    const sink = new LocalRotatingTraceSink({ machineDir: process.env.TASK229_MACHINE_DIR });
    const tracer = createTraceClient({ source: "daemon", sinks: [sink] });
    const observer = createScopedAppStorageObserver({
      clock: systemClock,
      serverId: "server-a",
      writerEpoch: "crash-epoch",
      trace(name, attrs, status = "ok") {
        const span = tracer.startSpan(name, { surface: "daemon", kind: "internal", attrs });
        span.end(status);
      },
    });
    const storage = createScopedAppStorageFactory({
      slockHome: process.env.TASK229_SLOCK_HOME,
      owner: { machineId: "machine-1", serverId: "server-a" },
      writerEpoch: "crash-epoch",
      onFailure(event) {
        observer.observe(event);
      },
    }).open({
      appId: "system.reminder",
    });
    let failed = false;
    try {
      storage.writeTextAtomic("payload must not enter telemetry");
    } catch {
      failed = true;
    }
    if (!failed) process.exit(24);
    process.exit(23);
  `;
  try {
    const child = spawnSync(process.execPath, [
      "--import",
      "tsx",
      "--input-type=module",
      "--eval",
      script,
    ], {
      cwd: path.dirname(fileURLToPath(import.meta.url)),
      env: {
        ...process.env,
        TASK229_MACHINE_DIR: machineDir,
        TASK229_SLOCK_HOME: slockHome,
      },
      encoding: "utf8",
    });
    assert.equal(child.status, 23, `child must actually die: ${child.stderr}`);
    const traceDir = path.join(machineDir, "traces");
    const records = readdirSync(traceDir).flatMap((file) =>
      readFileSync(path.join(traceDir, file), "utf8")
        .trim()
        .split("\n")
        .filter(Boolean)
        .map((line) => JSON.parse(line) as { name: string; attrs: Record<string, unknown> })
    );
    const counter = records.find((record) =>
      record.name === "daemon.app_storage.counter"
      && record.attrs.writer_epoch === "crash-epoch"
    );
    assert.deepEqual(counter?.attrs && {
      appId: counter.attrs.app,
      count: counter.attrs.count,
      reason: counter.attrs.reason,
      writerEpoch: counter.attrs.writer_epoch,
    }, {
      appId: "system.reminder",
      count: 1,
      reason: "storage_io",
      writerEpoch: "crash-epoch",
    });
  } finally {
    rmSync(machineDir, { recursive: true, force: true });
  }
});
