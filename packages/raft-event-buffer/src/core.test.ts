import assert from "node:assert/strict";
import test from "node:test";
import {
  TRACE_EVENT_ROW_V2_LEGACY_SCHEMA_FINGERPRINT,
  TRACE_EVENT_ROW_V2_SCHEMA_FINGERPRINT,
  TRACE_EVENT_ROW_V2_TABLE,
} from "@botiverse/raft-shared";
import {
  EventBuffer,
  type EventBufferEnvelope,
  type EventBufferExportResult,
  type EventBufferExporter,
  type EventBufferOptions,
} from "./core.js";

const ENVELOPE = {
  table: TRACE_EVENT_ROW_V2_TABLE,
  schemaFingerprint: TRACE_EVENT_ROW_V2_SCHEMA_FINGERPRINT,
} as const;

test("accepts legacy additive rows and exports them under the current fingerprint", async () => {
  const batches: EventBufferEnvelope[] = [];
  const buffer = makeBuffer(async (envelope) => {
    batches.push(envelope);
    return { outcome: "committed", committedRows: envelope.rows.length };
  }, { maxBatchRows: 1 });

  const receipt = buffer.enqueue({
    table: TRACE_EVENT_ROW_V2_TABLE,
    schemaFingerprint: TRACE_EVENT_ROW_V2_LEGACY_SCHEMA_FINGERPRINT,
    rows: [{ event_name: "legacy-row" }],
  });
  assert.equal(receipt.state, "queued");
  await buffer.waitUntilIdle();
  assert.equal(batches[0]?.schemaFingerprint, TRACE_EVENT_ROW_V2_SCHEMA_FINGERPRINT);
  assert.deepEqual(batches[0]?.rows, [{ event_name: "legacy-row" }]);
});

test("returns an honest memory-only queued receipt before exact commit", async () => {
  const batches: EventBufferEnvelope[] = [];
  const buffer = makeBuffer(async (envelope) => {
    batches.push(envelope);
    return { outcome: "committed", committedRows: envelope.rows.length };
  }, { maxBatchRows: 2 });

  const receipt = buffer.enqueue({ ...ENVELOPE, rows: [{ id: 1 }, { id: 2 }] });
  assert.deepEqual(receipt, {
    state: "queued",
    durability: "memory_only",
    acceptedRows: 2,
    rejectedRows: 0,
    acceptedBytes: 16,
    queueDepthRows: 2,
    committedRows: 0,
  });
  await buffer.waitUntilIdle();

  assert.equal(batches.length, 1);
  assert.deepEqual(batches[0]?.rows, [{ id: 1 }, { id: 2 }]);
  const metrics = buffer.metrics.snapshot();
  assert.equal(metrics.ingressAcceptedRows, 2);
  assert.equal(metrics.attemptedRows, 2);
  assert.equal(metrics.committedRows, 2);
});

test("isolates oversized rows without rejecting valid siblings", async () => {
  const batches: EventBufferEnvelope[] = [];
  const buffer = makeBuffer(async (envelope) => {
    batches.push(envelope);
    return { outcome: "committed", committedRows: envelope.rows.length };
  }, { maxBatchRows: 2, maxBatchBytes: 32 });

  const receipt = buffer.enqueue({
    ...ENVELOPE,
    rows: [{ id: 1 }, { payload: "x".repeat(64) }],
  });
  assert.deepEqual(receipt, {
    state: "queued",
    durability: "memory_only",
    acceptedRows: 1,
    rejectedRows: 1,
    acceptedBytes: 8,
    queueDepthRows: 1,
    committedRows: 0,
  });
  await buffer.waitUntilIdle();

  assert.deepEqual(batches.map((batch) => batch.rows), [[{ id: 1 }]]);
  assert.equal(buffer.metrics.snapshot().ingressRejectedRows.row_too_large, 1);
  assert.deepEqual(
    buffer.enqueue({ ...ENVELOPE, rows: [{ payload: "x".repeat(64) }] }),
    { state: "rejected", reason: "row_too_large" },
  );
  assert.equal(buffer.metrics.snapshot().ingressRejectedRows.row_too_large, 2);
  assert.equal(buffer.metrics.snapshot().rejectedBatches.row_too_large, 1);
});

test("flushes a partial batch when its oldest row reaches max age", async () => {
  const attemptedAt: number[] = [];
  const buffer = makeBuffer(async (envelope) => {
    attemptedAt.push(Date.now());
    return { outcome: "committed", committedRows: envelope.rows.length };
  }, { maxBatchRows: 4, maxBatchAgeMs: 30 });
  const startedAt = Date.now();

  buffer.enqueue({ ...ENVELOPE, rows: [{ id: 1 }] });
  await buffer.waitUntilIdle();

  assert.equal(attemptedAt.length, 1);
  assert.ok(attemptedAt[0]! - startedAt >= 20, `flushed too early after ${attemptedAt[0]! - startedAt}ms`);
});

test("honors byte batching without splitting an opaque row", async () => {
  const batches: EventBufferEnvelope[] = [];
  const buffer = makeBuffer(async (envelope) => {
    batches.push(envelope);
    return { outcome: "committed", committedRows: envelope.rows.length };
  }, { maxBatchRows: 8, maxBatchBytes: 24, maxBatchAgeMs: 5 });

  buffer.enqueue({ ...ENVELOPE, rows: [{ value: "aaaa" }, { value: "bbbb" }] });
  await buffer.waitUntilIdle();

  assert.equal(batches.length, 2);
  assert.deepEqual(batches.map((batch) => batch.rows.length), [1, 1]);
});

test("queue bounds include the in-flight batch", async () => {
  let releaseFirst!: () => void;
  const firstBlocked = new Promise<void>((resolve) => { releaseFirst = resolve; });
  let attempts = 0;
  const buffer = makeBuffer(async (envelope) => {
    attempts += 1;
    if (attempts === 1) await firstBlocked;
    return { outcome: "committed", committedRows: envelope.rows.length };
  }, { maxQueueRows: 2, maxBatchRows: 1, maxBatchAgeMs: 1 });

  assert.equal(buffer.enqueue({ ...ENVELOPE, rows: [{ id: 1 }] }).state, "queued");
  await waitFor(() => attempts === 1);
  assert.equal(buffer.enqueue({ ...ENVELOPE, rows: [{ id: 2 }] }).state, "queued");
  assert.deepEqual(
    buffer.enqueue({ ...ENVELOPE, rows: [{ id: 3 }] }),
    { state: "rejected", reason: "queue_full" },
  );
  releaseFirst();
  await buffer.waitUntilIdle();

  assert.equal(buffer.metrics.snapshot().rejectedBatches.queue_full, 1);
});

test("429 backoff merges the old batch with rows accepted before retry", async () => {
  const batches: EventBufferEnvelope[] = [];
  const buffer = makeBuffer(async (envelope) => {
    batches.push(envelope);
    if (batches.length === 1) return { outcome: "rate_limited", retryAfterMs: 20 };
    return { outcome: "committed", committedRows: envelope.rows.length };
  }, {
    maxBatchRows: 4,
    maxBatchAgeMs: 5,
    rateLimitBackoffMs: 20,
    maxRateLimitBackoffMs: 50,
  });

  buffer.enqueue({ ...ENVELOPE, rows: [{ id: 1 }, { id: 2 }] });
  await waitFor(() => batches.length === 1);
  buffer.enqueue({ ...ENVELOPE, rows: [{ id: 3 }, { id: 4 }] });
  await buffer.waitUntilIdle();

  assert.deepEqual(batches.map((batch) => batch.rows), [
    [{ id: 1 }, { id: 2 }],
    [{ id: 1 }, { id: 2 }, { id: 3 }, { id: 4 }],
  ]);
  const metrics = buffer.metrics.snapshot();
  assert.equal(metrics.exportAttempts, 2);
  assert.equal(metrics.attemptedRows, 6);
  assert.equal(metrics.committedRows, 4);
  assert.equal(metrics.rateLimitedAttempts, 1);
  assert.equal(metrics.droppedRows.export_failure, 0);
});

test("single-token bucket never attempts above the hard 3 qps ceiling", async () => {
  const attemptedAt: number[] = [];
  const buffer = makeBuffer(async (envelope) => {
    attemptedAt.push(Date.now());
    return { outcome: "committed", committedRows: envelope.rows.length };
  }, { maxBatchRows: 1, maxBatchAgeMs: 1, maxQps: 3 });

  buffer.enqueue({
    ...ENVELOPE,
    rows: [{ id: 1 }, { id: 2 }, { id: 3 }, { id: 4 }, { id: 5 }],
  });
  await buffer.waitUntilIdle();

  assert.equal(attemptedAt.length, 5);
  for (let index = 1; index < attemptedAt.length; index += 1) {
    assert.ok(attemptedAt[index]! - attemptedAt[index - 1]! >= 333);
  }
  for (let index = 3; index < attemptedAt.length; index += 1) {
    assert.ok(
      attemptedAt[index]! - attemptedAt[index - 3]! >= 1_000,
      `four attempts exceeded 3 qps: ${attemptedAt.slice(index - 3, index + 1).join(",")}`,
    );
  }
  assert.throws(
    () => makeBuffer(async () => ({ outcome: "committed", committedRows: 1 }), { maxQps: 3.01 }),
    /maxQps must be <= 3/,
  );
});

test("failed and partial commits become visible bounded drops", async () => {
  const results: EventBufferExportResult[] = [
    { outcome: "failed" },
    { outcome: "committed", committedRows: 0 },
  ];
  const buffer = makeBuffer(async () => results.shift()!, { maxBatchRows: 1, maxBatchAgeMs: 1 });

  buffer.enqueue({ ...ENVELOPE, rows: [{ id: 1 }, { id: 2 }] });
  await buffer.waitUntilIdle();

  assert.deepEqual(buffer.metrics.snapshot().droppedRows, {
    export_failure: 1,
    commit_mismatch: 1,
    drain_timeout: 0,
  });
});

test("drain bypasses max age and reports success only after commit", async () => {
  const buffer = makeBuffer(async (envelope) => (
    { outcome: "committed", committedRows: envelope.rows.length }
  ), { maxBatchAgeMs: 10_000 });
  buffer.enqueue({ ...ENVELOPE, rows: [{ id: 1 }] });

  assert.deepEqual(await buffer.drain(1_000), { state: "drained", pendingRows: 0 });
  assert.equal(buffer.metrics.snapshot().committedRows, 1);
  assert.deepEqual(
    buffer.enqueue({ ...ENVELOPE, rows: [{ id: 2 }] }),
    { state: "rejected", reason: "shutting_down" },
  );
});

test("drain timeout accounts for the accepted memory-only tail", async () => {
  const never = new Promise<EventBufferExportResult>(() => {});
  const buffer = makeBuffer(async () => never, { maxBatchRows: 1, maxBatchAgeMs: 1 });
  buffer.enqueue({ ...ENVELOPE, rows: [{ id: 1 }, { id: 2 }] });

  const receipt = await buffer.drain(10);

  assert.deepEqual(receipt, {
    state: "timed_out",
    pendingRows: 2,
    droppedRows: 1,
    abandonedInFlightRows: 1,
  });
  assert.equal(buffer.metrics.snapshot().droppedRows.drain_timeout, 1);
  assert.equal(buffer.metrics.snapshot().outcomeUnknownRows.abandoned_in_flight, 1);
  assert.equal(buffer.queueMetrics().depthRows, 0);
});

test("non-JSON rows and unbounded retry-after values fail closed", async () => {
  const buffer = makeBuffer(async (envelope) => (
    { outcome: "committed", committedRows: envelope.rows.length }
  ));
  const circular: Record<string, unknown> = {};
  circular.self = circular;
  assert.deepEqual(
    buffer.enqueue({ ...ENVELOPE, rows: [circular] }),
    { state: "rejected", reason: "invalid_envelope" },
  );

  const attempts: number[] = [];
  const retrying = makeBuffer(async (envelope) => {
    attempts.push(Date.now());
    if (attempts.length === 1) return { outcome: "rate_limited", retryAfterMs: Number.POSITIVE_INFINITY };
    return { outcome: "committed", committedRows: envelope.rows.length };
  }, {
    maxBatchRows: 1,
    maxBatchAgeMs: 1,
    rateLimitBackoffMs: 10,
    maxRateLimitBackoffMs: 50,
  });
  retrying.enqueue({ ...ENVELOPE, rows: [{ id: 1 }] });
  await retrying.waitUntilIdle();
  assert.equal(attempts.length, 2);
  assert.ok(attempts[1]! - attempts[0]! < 1_000);

  assert.throws(
    () => makeBuffer(async () => ({ outcome: "committed", committedRows: 1 }), { maxQueueRows: 1.5 }),
    /maxQueueRows must be a positive integer/,
  );
  assert.throws(
    () => makeBuffer(async () => ({ outcome: "committed", committedRows: 1 }), {
      maxRateLimitBackoffMs: Number.POSITIVE_INFINITY,
    }),
    /maxRateLimitBackoffMs must be >= rateLimitBackoffMs/,
  );
});

function makeBuffer(
  exportFn: EventBufferExporter["export"],
  overrides: Partial<Omit<EventBufferOptions, "exporter">> = {},
): EventBuffer {
  return new EventBuffer({
    exporter: { export: exportFn },
    maxQueueRows: 16,
    maxQueueBytes: 16_384,
    maxBatchRows: 4,
    maxBatchBytes: 4_096,
    maxBatchAgeMs: 10,
    maxQps: 3,
    rateLimitBackoffMs: 10,
    maxRateLimitBackoffMs: 100,
    ...overrides,
  });
}

async function waitFor(predicate: () => boolean, timeoutMs = 1_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!predicate()) {
    if (Date.now() >= deadline) throw new Error("condition not reached before timeout");
    await new Promise((resolve) => setTimeout(resolve, 2));
  }
}
