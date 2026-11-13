import assert from "node:assert/strict";

import type { Database } from "../db/index";
import {
  createExternalInboundAttachmentWorkerRuntime,
  type ExternalInboundAttachmentWorkerDependencies,
} from "./externalInboundAttachmentWorkerService";
import { createExternalInboundWorkerRuntime, type ExternalInboundWorkerDependencies } from "./externalInboundWorkerService";

const NOW = new Date("2026-10-28T12:00:00.000Z");

function deferred() {
  let reject!: (error: Error) => void;
  const promise = new Promise<never>((_resolve, rejectPromise) => { reject = rejectPromise; });
  return { promise, reject };
}

test("inbound worker runtimes report a failed tick and every non-idle result", async () => {
  const errors: unknown[] = [];
  const failure = new Error("database unavailable");
  let reported!: () => void;
  const errorReported = new Promise<void>((resolve) => { reported = resolve; });
  const events = createExternalInboundWorkerRuntime({
    db: { transaction: async () => { throw failure; } } as unknown as Database,
    leaseOwner: "inbound-test",
    dependencies: { now: () => NOW } as unknown as ExternalInboundWorkerDependencies,
    intervalMs: 60_000,
    onError: (error) => { errors.push(error); reported(); },
  });
  events.start();
  await errorReported;
  await events.stop();
  assert.deepEqual([...errors], [failure], "a thrown tick is reported, not swallowed");

  const results: string[] = [];
  let observed!: () => void;
  const resultObserved = new Promise<void>((resolve) => { observed = resolve; });
  const attachments = createExternalInboundAttachmentWorkerRuntime({
    db: { transaction: async () => null } as unknown as Database,
    leaseOwner: "inbound-attachment-test",
    dependencies: { now: () => NOW } as unknown as ExternalInboundAttachmentWorkerDependencies,
    intervalMs: 60_000,
    onResult: (result) => { results.push(result.kind); observed(); },
    onError: (error) => errors.push(error),
  });
  attachments.start();
  await resultObserved;
  await attachments.stop();
  assert.deepEqual(results, ["empty"]);
  assert.equal(errors.length, 1);
});

test("a tick aborted by stop is not reported as a worker failure", async () => {
  const errors: unknown[] = [];
  const pending = deferred();
  const runtime = createExternalInboundAttachmentWorkerRuntime({
    db: { transaction: () => pending.promise } as unknown as Database,
    leaseOwner: "inbound-attachment-test",
    dependencies: { now: () => NOW } as unknown as ExternalInboundAttachmentWorkerDependencies,
    intervalMs: 60_000,
    onError: (error) => errors.push(error),
  });
  runtime.start();
  const stopped = runtime.stop();
  pending.reject(new Error("aborted during shutdown"));
  await stopped;
  assert.deepEqual(errors, []);
});

test("durable Slack fanout reports all worker failures and observer errors", async () => {
  const failures: unknown[] = [];
  const failure = new Error("database unavailable");
  let reported!: () => void;
  const allReported = new Promise<void>((resolve) => { reported = resolve; });
  const runtime = createExternalInboundWorkerRuntime({
    db: { transaction: async () => { throw failure; } } as unknown as Database,
    leaseOwner: "durable-inbound-test",
    dependencies: { now: () => NOW } as unknown as ExternalInboundWorkerDependencies,
    durableSlackMode: true, intervalMs: 60_000,
    onError: (error) => { failures.push(error); if (failures.length === 5) reported(); },
  });
  runtime.start();
  try {
    await Promise.race([allReported, new Promise<never>((_, reject) => setTimeout(() => reject(new Error("not all failures reported")), 250))]);
  } finally { await runtime.stop(); }
  assert.equal(failures.length, 5);
  assert.ok(failures.every(error => error === failure));

  const observerFailure = new Error("observer failed");
  const observedErrors: unknown[] = [];
  let count = 0;
  let observed!: () => void;
  const allObserved = new Promise<void>((resolve) => { observed = resolve; });
  const successes = createExternalInboundWorkerRuntime({
    db: { transaction: async () => null } as unknown as Database,
    leaseOwner: "durable-inbound-test",
    dependencies: { now: () => NOW } as unknown as ExternalInboundWorkerDependencies,
    durableSlackMode: true, intervalMs: 60_000,
    onResult: () => { count += 1; if (count === 5) observed(); if (count === 1) throw observerFailure; },
    onError: error => { observedErrors.push(error); },
  });
  successes.start(); await allObserved; await successes.stop();
  assert.equal(count, 5); assert.deepEqual(observedErrors, [observerFailure]);
});
