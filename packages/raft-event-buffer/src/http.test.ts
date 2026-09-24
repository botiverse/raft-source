import assert from "node:assert/strict";
import test from "node:test";
import {
  TRACE_EVENT_ROW_V2_LEGACY_SCHEMA_FINGERPRINT,
  TRACE_EVENT_ROW_V2_SCHEMA_FINGERPRINT,
  TRACE_EVENT_ROW_V2_TABLE,
} from "@botiverse/raft-shared";
import { EventBuffer } from "./core.js";
import { createEventBufferRequestHandler } from "./http.js";

const TOKEN = "internal-buffer-secret";

test("authenticated ingress returns queued rather than claiming commit", async () => {
  const buffer = makeBuffer();
  const handle = makeHandler(buffer);
  const response = await handle(batchRequest({
    table: TRACE_EVENT_ROW_V2_TABLE,
    schemaFingerprint: TRACE_EVENT_ROW_V2_SCHEMA_FINGERPRINT,
    rows: [{ event_name: "safe" }],
  }));

  assert.equal(response.status, 202);
  assert.deepEqual(await response.json(), {
    receipt: {
      state: "queued",
      durability: "memory_only",
      acceptedRows: 1,
      rejectedRows: 0,
      acceptedBytes: 21,
      queueDepthRows: 1,
      committedRows: 0,
    },
  });
  await buffer.waitUntilIdle();
  assert.equal(buffer.metrics.snapshot().committedRows, 1);
});

test("authenticated ingress accepts the legacy additive fingerprint during mixed rollout", async () => {
  const buffer = makeBuffer();
  const handle = makeHandler(buffer);
  const response = await handle(batchRequest({
    table: TRACE_EVENT_ROW_V2_TABLE,
    schemaFingerprint: TRACE_EVENT_ROW_V2_LEGACY_SCHEMA_FINGERPRINT,
    rows: [{ event_name: "legacy-row" }],
  }));

  assert.equal(response.status, 202);
  await buffer.waitUntilIdle();
  assert.equal(buffer.metrics.snapshot().committedRows, 1);
});

test("authenticated ingress reports isolated oversized rows", async () => {
  const buffer = makeBuffer(32);
  const handle = makeHandler(buffer);
  const response = await handle(batchRequest({
    ...validEnvelope(),
    rows: [{ id: 1 }, { payload: "x".repeat(64) }],
  }));

  assert.equal(response.status, 202);
  assert.deepEqual(await response.json(), {
    receipt: {
      state: "queued",
      durability: "memory_only",
      acceptedRows: 1,
      rejectedRows: 1,
      acceptedBytes: 8,
      queueDepthRows: 1,
      committedRows: 0,
    },
  });
  await buffer.waitUntilIdle();
  assert.equal(buffer.metrics.snapshot().ingressRejectedRows.row_too_large, 1);

  const allOversized = await handle(batchRequest({
    ...validEnvelope(),
    rows: [{ payload: "x".repeat(64) }],
  }));
  assert.equal(allOversized.status, 413);
  assert.deepEqual(await allOversized.json(), { error: "row_too_large" });
});

test("ingress fails closed on auth, table, fingerprint, shape, and size", async () => {
  const buffer = makeBuffer();
  const handle = makeHandler(buffer);

  const unauthorized = await handle(batchRequest(validEnvelope(), "wrong"));
  assert.equal(unauthorized.status, 401);
  assert.deepEqual(await unauthorized.json(), { error: "unauthorized" });

  const table = await handle(batchRequest({ ...validEnvelope(), table: "raft.other" }));
  assert.equal(table.status, 422);
  assert.deepEqual(await table.json(), { error: "table_not_allowed" });

  const schema = await handle(batchRequest({ ...validEnvelope(), schemaFingerprint: "sha256:stale" }));
  assert.equal(schema.status, 422);
  assert.deepEqual(await schema.json(), { error: "schema_mismatch" });

  const extraField = await handle(batchRequest({ ...validEnvelope(), extra: true }));
  assert.equal(extraField.status, 400);
  assert.deepEqual(await extraField.json(), { error: "invalid_envelope" });

  const invalidJson = await handle(new Request("http://buffer/internal/v1/batches", {
    method: "POST",
    headers: { authorization: `Bearer ${TOKEN}` },
    body: "{",
  }));
  assert.equal(invalidJson.status, 400);
  assert.deepEqual(await invalidJson.json(), { error: "invalid_json" });

  const tooManyRows = await handle(batchRequest({ ...validEnvelope(), rows: [{ id: 1 }, { id: 2 }, { id: 3 }] }));
  assert.equal(tooManyRows.status, 413);
  assert.deepEqual(await tooManyRows.json(), { error: "batch_too_large" });

  const oversized = await handle(new Request("http://buffer/internal/v1/batches", {
    method: "POST",
    headers: { authorization: `Bearer ${TOKEN}`, "content-length": "999" },
    body: "{}",
  }));
  assert.equal(oversized.status, 413);
  assert.deepEqual(await oversized.json(), { error: "request_too_large" });

  assert.deepEqual(buffer.metrics.snapshot().rejectedBatches, {
    unauthorized: 1,
    invalid_json: 1,
    invalid_envelope: 1,
    table_not_allowed: 1,
    schema_mismatch: 1,
    request_too_large: 1,
    batch_too_large: 1,
    row_too_large: 0,
    queue_full: 0,
    shutting_down: 0,
  });
});

test("health and metrics expose only bounded state, never row content", async () => {
  const buffer = makeBuffer();
  const handle = makeHandler(buffer);
  await handle(batchRequest({ ...validEnvelope(), rows: [{ secret_prompt: "do-not-export" }] }));

  const health = await handle(new Request("http://buffer/healthz"));
  assert.deepEqual(await health.json(), { status: "ok" });
  const metrics = await (await handle(new Request("http://buffer/metrics"))).text();
  assert.match(metrics, /raft_event_buffer_ingress_accepted_rows_total 1/);
  assert.match(metrics, /raft_event_buffer_ingress_rejected_rows_total\{reason="row_too_large"\} 0/);
  assert.match(metrics, /raft_event_buffer_outcome_unknown_rows_total\{reason="abandoned_in_flight"\} 0/);
  assert.match(metrics, /# TYPE raft_event_buffer_queue_depth_rows gauge/);
  assert.doesNotMatch(metrics, /do-not-export|secret_prompt/);
  await buffer.waitUntilIdle();
});

function makeBuffer(maxBatchBytes = 4_096): EventBuffer {
  return new EventBuffer({
    exporter: {
      export: async (envelope) => ({ outcome: "committed", committedRows: envelope.rows.length }),
    },
    maxQueueRows: 8,
    maxQueueBytes: 8_192,
    maxBatchRows: 1,
    maxBatchBytes,
    maxBatchAgeMs: 10,
    maxQps: 3,
  });
}

function makeHandler(buffer: EventBuffer) {
  return createEventBufferRequestHandler({
    buffer,
    authToken: TOKEN,
    maxRequestBytes: 256,
    maxRequestRows: 2,
  });
}

function batchRequest(body: unknown, token = TOKEN): Request {
  return new Request("http://buffer/internal/v1/batches", {
    method: "POST",
    headers: {
      authorization: `Bearer ${token}`,
      "content-type": "application/json",
    },
    body: JSON.stringify(body),
  });
}

function validEnvelope() {
  return {
    table: TRACE_EVENT_ROW_V2_TABLE,
    schemaFingerprint: TRACE_EVENT_ROW_V2_SCHEMA_FINGERPRINT,
    rows: [{ id: 1 }],
  };
}
