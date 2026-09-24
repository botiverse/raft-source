import assert from "node:assert/strict";
import { test } from "vitest";
import type { Server as SocketServer } from "socket.io";
import {
  startAgentMigrationReceiptOutboxWorker,
} from "./agentMigrationReceiptService.js";
import {
  startAgentMigrationRemediationWorker,
} from "./agentMigrationRemediationWorker.js";
import type { AgentOrchestrator } from "./agentOrchestrator.js";
import {
  createAgentMigrationWorkerObservability,
  type AgentMigrationWorkerDrainOutcome,
  type AgentMigrationWorkerObservation,
  type AgentMigrationWorkerObservability,
} from "./agentMigrationWorkerObservability.js";

const BUILD_IDENTITY = {
  ok: true as const,
  identity: {
    sha: "0123456789abcdef0123456789abcdef01234567",
    builtAt: "2026-08-21T20:00:00.000Z",
    branch: "staging",
  },
};

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((resolvePromise) => {
    resolve = resolvePromise;
  });
  return { promise, resolve };
}

function captureObservability(worker: "receipt_outbox" | "remediation") {
  const observations: AgentMigrationWorkerObservation[] = [];
  let nowMs = Date.parse("2026-08-21T20:01:00.000Z");
  const observability = createAgentMigrationWorkerObservability({
    worker,
    now: () => new Date(nowMs),
    runtimeId: "7f94335a-8ebc-4dbb-bec7-b13a991cb684",
    serverVersion: "1.9.6",
    buildIdentity: BUILD_IDENTITY,
    outcomeHeartbeatMs: 300_000,
    emit: (observation) => observations.push(observation),
  });
  return {
    observations,
    observability,
    advance(ms: number) {
      nowMs += ms;
    },
  };
}

async function waitForObservation(
  observations: AgentMigrationWorkerObservation[],
  predicate: (observation: AgentMigrationWorkerObservation) => boolean,
): Promise<void> {
  const deadline = Date.now() + 1_000;
  while (!observations.some(predicate)) {
    if (Date.now() >= deadline) throw new Error("OBSERVATION_TIMEOUT");
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}

test("worker observability emits one bounded, release-bound, privacy-safe lifecycle", () => {
  const capture = captureObservability("receipt_outbox");
  capture.observability.startup();
  capture.observability.startup();
  capture.observability.drain("empty");
  capture.advance(5_000);
  capture.observability.drain("served");
  capture.observability.drain("empty");
  capture.advance(295_000);
  capture.observability.drain("served");

  assert.deepEqual(capture.observations.map(({ event, outcome }) => ({ event, outcome })), [
    { event: "startup", outcome: "started" },
    { event: "drain", outcome: "empty" },
    { event: "drain", outcome: "served" },
  ]);
  assert.deepEqual(Object.keys(capture.observations[0]!).sort(), [
    "event",
    "observed_at",
    "outcome",
    "release_branch",
    "release_built_at",
    "release_identity",
    "release_sha",
    "runtime_id",
    "server_version",
    "worker",
  ]);
  assert.deepEqual(capture.observations[0], {
    event: "startup",
    worker: "receipt_outbox",
    outcome: "started",
    observed_at: "2026-08-21T20:01:00.000Z",
    runtime_id: "7f94335a-8ebc-4dbb-bec7-b13a991cb684",
    server_version: "1.9.6",
    release_identity: "available",
    release_sha: "0123456789abcdef0123456789abcdef01234567",
    release_branch: "staging",
    release_built_at: "2026-08-21T20:00:00.000Z",
  });
});

test("worker observability emits a failure transition immediately, bounds repeats, and never controls work", () => {
  const capture = captureObservability("remediation");
  capture.observability.startup();
  capture.observability.drain("empty");
  capture.advance(5_000);
  capture.observability.drain("failed");
  capture.advance(5_000);
  capture.observability.drain("failed");
  assert.deepEqual(capture.observations.map(({ event, outcome }) => ({ event, outcome })), [
    { event: "startup", outcome: "started" },
    { event: "drain", outcome: "empty" },
    { event: "drain", outcome: "failed" },
  ]);

  const throwing = createAgentMigrationWorkerObservability({
    worker: "remediation",
    buildIdentity: BUILD_IDENTITY,
    emit: () => {
      throw new Error("sink unavailable");
    },
  });
  assert.doesNotThrow(() => {
    throwing.startup();
    throwing.drain("served");
  });
});

test("unavailable build identity never reflects invalid environment candidates", () => {
  const observations: AgentMigrationWorkerObservation[] = [];
  const observability = createAgentMigrationWorkerObservability({
    worker: "receipt_outbox",
    buildIdentity: {
      ok: false,
      code: "build_identity_unavailable",
      reason: "invalid",
      identity: {
        sha: "credential-shaped-value",
        branch: "private-branch-value",
        builtAt: "invalid-time-value",
      },
    },
    emit: (observation) => observations.push(observation),
  });
  observability.startup();
  assert.equal(observations[0]!.release_identity, "unavailable");
  assert.equal(observations[0]!.release_sha, null);
  assert.equal(observations[0]!.release_branch, null);
  assert.equal(observations[0]!.release_built_at, null);
  assert.equal(JSON.stringify(observations).includes("credential-shaped-value"), false);
});

test("receipt worker classifies empty, served, returned failure, and thrown failure without leaking drain data", async () => {
  const cases: Array<{
    name: string;
    result?: { attempted: number; sent: number; failed: number; migrationId?: string; payload?: string };
    error?: Error;
    expected: AgentMigrationWorkerDrainOutcome;
  }> = [
    { name: "empty", result: { attempted: 0, sent: 0, failed: 0 }, expected: "empty" },
    {
      name: "served",
      result: { attempted: 1, sent: 1, failed: 0, migrationId: "must-not-leak", payload: "must-not-leak" },
      expected: "served",
    },
    { name: "returned failure", result: { attempted: 1, sent: 0, failed: 1 }, expected: "failed" },
    { name: "thrown failure", error: new Error("raw-secret-must-not-enter-observation"), expected: "failed" },
  ];

  for (const entry of cases) {
    const capture = captureObservability("receipt_outbox");
    const drained = deferred<void>();
    const originalConsoleError = console.error;
    console.error = () => undefined;
    try {
      const worker = startAgentMigrationReceiptOutboxWorker({
        io: {} as SocketServer,
        orchestrator: {} as AgentOrchestrator,
        intervalMs: 60_000,
        observability: capture.observability,
        drainOutbox: async () => {
          drained.resolve();
          if (entry.error) throw entry.error;
          return entry.result!;
        },
      });
      await drained.promise;
      await waitForObservation(capture.observations, (observation) => observation.outcome === entry.expected);
      worker.stop();
    } finally {
      console.error = originalConsoleError;
    }
    assert.equal(
      capture.observations.filter((observation) => observation.event === "startup").length,
      1,
      `${entry.name} must emit exactly one receipt-worker startup`,
    );
    const serialized = JSON.stringify(capture.observations);
    assert.equal(serialized.includes("must-not-leak"), false, entry.name);
    assert.equal(serialized.includes("raw-secret"), false, entry.name);
  }
});

test("remediation worker reports work only when a remediation path served", async () => {
  for (const entry of [
    { result: { autoStart: false, cancellation: false }, expected: "empty" as const },
    { result: { autoStart: true, cancellation: false }, expected: "served" as const },
    { result: { autoStart: false, cancellation: true }, expected: "served" as const },
  ]) {
    const capture = captureObservability("remediation");
    const drained = deferred<void>();
    const worker = startAgentMigrationRemediationWorker({
      io: {} as SocketServer,
      orchestrator: {} as AgentOrchestrator,
      intervalMs: 60_000,
      observability: capture.observability,
      drainRemediation: async () => {
        drained.resolve();
        return entry.result;
      },
    });
    await drained.promise;
    await waitForObservation(capture.observations, (observation) => observation.outcome === entry.expected);
    worker.stop();
    assert.equal(
      capture.observations.filter((observation) => observation.event === "startup").length,
      1,
      "remediation worker must emit exactly one startup",
    );
  }
});
