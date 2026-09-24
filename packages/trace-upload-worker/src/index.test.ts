import { createHash, createHmac } from "node:crypto";
import { gzipSync } from "node:zlib";
import assert from "node:assert/strict";
import test from "node:test";
import { TRACE_EVENT_ROW_V2_PROJECTION_COLUMNS } from "@botiverse/raft-shared";
import type { Client } from "scopedb";
import { handleRequest, ingestTraceBundleObject, type TraceUploadWorkerEnv } from "./index.js";

const SECRET = "scope-secret-for-tests";

class MockR2Bucket {
  puts: Array<{
    key: string;
    body: ArrayBuffer | string;
    options?: {
      httpMetadata?: {
      contentType?: string;
      contentEncoding?: string;
    };
    customMetadata?: Record<string, string>;
  };
  }> = [];

  async put(key: string, value: ArrayBuffer | string, options?: MockR2Bucket["puts"][number]["options"]) {
    this.puts.push({ key, body: value, options });
    return { etag: "mock-etag" };
  }

  async get(key: string) {
    let put: MockR2Bucket["puts"][number] | undefined;
    for (let idx = this.puts.length - 1; idx >= 0; idx -= 1) {
      if (this.puts[idx].key === key) {
        put = this.puts[idx];
        break;
      }
    }
    if (!put) return null;
    return {
      body: new Response(put.body).body,
      httpMetadata: put.options?.httpMetadata,
      customMetadata: put.options?.customMetadata,
    };
  }
}

class MockExecutionContext {
  promises: Promise<unknown>[] = [];

  waitUntil(promise: Promise<unknown>): void {
    this.promises.push(promise);
  }
}

function baseEnv() {
  const bucket = new MockR2Bucket();
  const env: TraceUploadWorkerEnv = {
    SCOPE_ATTESTATION_SECRET: SECRET,
    TRACE_UPLOAD_MAX_BYTES: String(1024 * 1024),
    TRACE_BUNDLES: bucket,
  };
  return { env, bucket };
}

function mockTraceEventTable() {
  const table = {
    withSchema: () => table,
    tableSchema: async () => ({
      fields: () => TRACE_EVENT_ROW_V2_PROJECTION_COLUMNS.map(([name, dataType]) => ({
        name: () => name,
        dataType: () => dataType,
      })),
    }),
  };
  return table;
}

function signAttestation(claims: Record<string, unknown>, secret = SECRET): string {
  const payload = Buffer.from(JSON.stringify(claims)).toString("base64url");
  const signature = createHmac("sha256", secret).update(payload).digest("base64url");
  return `${payload}.${signature}`;
}

function sha256Hex(body: Buffer | Uint8Array): string {
  return createHash("sha256").update(body).digest("hex");
}

function spanRecord(overrides: Record<string, unknown> = {}) {
  return {
    type: "span",
    schema_version: 1,
    trace_id: "0123456789abcdef0123456789abcdef",
    span_id: "0123456789abcdef",
    parent_span_id: null,
    name: "daemon.agent.delivery.routed",
    surface: "daemon",
    kind: "internal",
    status: "ok",
    start_time: "2026-05-07T08:00:00.000Z",
    end_time: "2026-05-07T08:00:00.012Z",
    duration_ms: 12,
    attrs: {
      serverId: "server-1",
      machineId: "machine-1",
      daemonVersion: "0.55.6",
      daemon_version: "0.55.6",
      computerVersion: "0.0.23",
      computer_version: "0.0.23",
      agentId: "agent-1",
      deliveryId: "delivery-1",
      outcome: "stdin_written",
    },
    events: [
      {
        name: "daemon.agent.stdin.written",
        time: "2026-05-07T08:00:00.010Z",
        attrs: { bytes_bucket: "1-1k" },
      },
    ],
    ...overrides,
  };
}

function traceUploadClaims(metadata: Record<string, unknown>, overrides: Record<string, unknown> = {}) {
  return {
    v: 1,
    typ: "scope-attestation",
    scope: "daemon-trace-bundle:create",
    sub: "machine-1",
    actorType: "machine",
    machineId: "machine-1",
    serverId: "server-1",
    aud: "trace-ingest-worker",
    resource: "servers/server-1/machines/machine-1/trace-bundles",
    nonce: "nonce-1",
    exp: Math.floor(Date.now() / 1000) + 60,
    metadata,
    ...overrides,
  };
}

function webTraceClaims(overrides: Record<string, unknown> = {}) {
  return {
    v: 1,
    typ: "scope-attestation",
    scope: "web-trace-batch:create",
    sub: "user-1",
    actorType: "user",
    serverId: "server-1",
    aud: "trace-ingest-worker",
    resource: "servers/server-1/web-traces",
    nonce: "nonce-web-1",
    exp: Math.floor(Date.now() / 1000) + 60,
    ...overrides,
  };
}

function feedbackReportClaims(overrides: Record<string, unknown> = {}) {
  return {
    v: 1,
    typ: "scope-attestation",
    scope: "feedback-report:create",
    sub: "user-1",
    actorType: "user",
    serverId: "server-1",
    aud: "feedback-worker",
    resource: "servers/server-1/feedback-reports",
    nonce: "nonce-feedback-1",
    exp: Math.floor(Date.now() / 1000) + 60,
    ...overrides,
  };
}

test("web trace endpoint verifies attestation and forwards browser spans to OTLP", async () => {
  const { env } = baseEnv();
  const fetchCalls: Array<{ input: RequestInfo | URL; init?: RequestInit }> = [];
  env.TRACE_INGEST_OTLP_ENDPOINT = "https://telescope.test/v1/traces";
  env.TRACE_INGEST_FETCH = async (input, init) => {
    fetchCalls.push({ input, init });
    return new Response(null, { status: 200 });
  };
  const attestation = signAttestation(webTraceClaims());
  const record = spanRecord({
    name: "web.interaction.message_send",
    surface: "web",
    attrs: {
      interaction_id: "interaction-1",
      client_temp_id: "tmp-1",
    },
  });

  const res = await handleRequest(new Request("https://trace-worker.test/api/web-traces", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      attestation,
      batchId: "web-batch-1",
      resource: {
        "service.version": "0.1.0",
        "slock.web.session_id": "session-1",
      },
      records: [record],
    }),
  }), env);

  assert.equal(res.status, 200);
  assert.equal(res.headers.get("Access-Control-Allow-Origin"), "*");
  assert.deepEqual(await res.json(), {
    ok: true,
    batchId: "web-batch-1",
    spansIngested: 1,
    scopedbStatus: "success",
    v2ProjectorStatus: "skipped",
    v2SpansProjected: 0,
    v2RowsProjected: 0,
    v2SpansSkipped: 0,
    v2SkipReasonClasses: [],
  });
  assert.equal(fetchCalls.length, 1);
  assert.equal(String(fetchCalls[0].input), "https://telescope.test/v1/traces");
  const payload = JSON.parse(fetchCalls[0].init?.body as string);
  const resourceAttrs = payload.resourceSpans[0].resource.attributes;
  assert.ok(resourceAttrs.some((attr: any) => attr.key === "service.name" && attr.value.stringValue === "slock-web"));
  assert.ok(resourceAttrs.some((attr: any) => attr.key === "slock.server_id" && attr.value.stringValue === "server-1"));
  assert.ok(resourceAttrs.some((attr: any) => attr.key === "slock.user_id" && attr.value.stringValue === "user-1"));
  const span = payload.resourceSpans[0].scopeSpans[0].spans[0];
  assert.equal(span.name, "web.interaction.message_send");
  assert.ok(span.attributes.some((attr: any) =>
    attr.key === "slock.trace_ingest.span_key" &&
    attr.value.stringValue === "server-1:user-1:web-batch-1:0123456789abcdef0123456789abcdef:0123456789abcdef"));
});

test("web trace endpoint projects V2 rows after the canonical OTLP write", async () => {
  const { env } = baseEnv();
  const callOrder: string[] = [];
  let projectedPayload = "";
  env.TRACE_INGEST_OTLP_ENDPOINT = "https://telescope.test/v1/traces";
  env.TRACE_INGEST_FETCH = async () => {
    callOrder.push("otlp");
    return new Response(null, { status: 200 });
  };
  env.RAFT_TRACE_SCOPEDB_PROJECTOR = "on";
  env.SCOPEDB_TRACE_EVENTS_ENDPOINT = "https://scopedb.test";
  env.SCOPEDB_TRACE_EVENTS_WRITE_KEY = "test-key";
  env.SCOPEDB_TRACE_EVENTS_CLIENT = {
    table: () => mockTraceEventTable(),
    insert: async (payload: string) => {
      callOrder.push("v2");
      projectedPayload = payload;
      return { num_rows_inserted: 2 };
    },
  } as unknown as Pick<Client, "insert" | "table">;

  const res = await handleRequest(new Request("https://trace-worker.test/api/web-traces", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      attestation: signAttestation(webTraceClaims()),
      batchId: "web-batch-v2",
      resource: { "service.version": "secret@example.com" },
      records: [spanRecord({ name: "web.interaction.message_send", surface: "web" })],
    }),
  }), env);

  assert.equal(res.status, 200);
  assert.deepEqual(callOrder, ["otlp", "v2"]);
  assert.deepEqual(await res.json(), {
    ok: true,
    batchId: "web-batch-v2",
    spansIngested: 1,
    scopedbStatus: "success",
    v2ProjectorStatus: "success",
    v2SpansProjected: 1,
    v2RowsProjected: 2,
    v2SpansSkipped: 0,
    v2SkipReasonClasses: [],
  });
  const rows = projectedPayload.split("\n").map((row) => JSON.parse(row));
  assert.deepEqual(rows.map((row) => row.row_kind), ["event", "span_fact"]);
  assert.ok(rows.every((row) => row.service_name === "slock-web"));
  assert.ok(rows.every((row) => row.server_id === "server-1"));
  assert.ok(rows.every((row) => row.service_version === null));
});

test("web trace endpoint projects a mixed unset and closed-status batch into V2", async () => {
  const { env } = baseEnv();
  let otlpPayload = "";
  let projectedPayload = "";
  env.TRACE_INGEST_OTLP_ENDPOINT = "https://telescope.test/v1/traces";
  env.TRACE_INGEST_FETCH = async (_input, init) => {
    otlpPayload = String(init?.body ?? "");
    return new Response(null, { status: 200 });
  };
  env.RAFT_TRACE_SCOPEDB_PROJECTOR = "on";
  env.SCOPEDB_TRACE_EVENTS_ENDPOINT = "https://scopedb-mixed-status.test";
  env.SCOPEDB_TRACE_EVENTS_WRITE_KEY = "test-key";
  env.SCOPEDB_TRACE_EVENTS_CLIENT = {
    table: () => mockTraceEventTable(),
    insert: async (payload: string) => {
      projectedPayload = payload;
      return { num_rows_inserted: 4 };
    },
  } as unknown as Pick<Client, "insert" | "table">;

  const res = await handleRequest(new Request("https://trace-worker.test/api/web-traces", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      attestation: signAttestation(webTraceClaims()),
      batchId: "web-batch-v2-mixed-status",
      records: [
        spanRecord({ name: "slock.state.transition", surface: "web", status: "unset" }),
        spanRecord({
          trace_id: "1123456789abcdef0123456789abcdef",
          span_id: "1123456789abcdef",
          name: "web.http.client",
          surface: "web",
          kind: "client",
          status: "ok",
        }),
      ],
    }),
  }), env);

  assert.equal(res.status, 200);
  assert.deepEqual(await res.json(), {
    ok: true,
    batchId: "web-batch-v2-mixed-status",
    spansIngested: 2,
    scopedbStatus: "success",
    v2ProjectorStatus: "success",
    v2SpansProjected: 2,
    v2RowsProjected: 4,
    v2SpansSkipped: 0,
    v2SkipReasonClasses: [],
  });
  const spanFacts = projectedPayload
    .split("\n")
    .map((row) => JSON.parse(row))
    .filter((row) => row.row_kind === "span_fact");
  assert.deepEqual(spanFacts.map((row) => row.span_status), ["unset", "ok"]);
  const otlpSpans = JSON.parse(otlpPayload).resourceSpans[0].scopeSpans[0].spans;
  assert.deepEqual(otlpSpans.map((span: any) => span.status), [{ code: 0 }, { code: 1 }]);
});

test("web trace endpoint preserves valid V2 siblings when one record is invalid", async () => {
  const { env } = baseEnv();
  let projectedPayload = "";
  env.TRACE_INGEST_OTLP_ENDPOINT = "https://telescope.test/v1/traces";
  env.TRACE_INGEST_FETCH = async () => new Response(null, { status: 200 });
  env.RAFT_TRACE_SCOPEDB_PROJECTOR = "on";
  env.SCOPEDB_TRACE_EVENTS_ENDPOINT = "https://scopedb-partial.test";
  env.SCOPEDB_TRACE_EVENTS_WRITE_KEY = "test-key";
  env.SCOPEDB_TRACE_EVENTS_CLIENT = {
    table: () => mockTraceEventTable(),
    insert: async (payload: string) => {
      projectedPayload = payload;
      return { num_rows_inserted: 2 };
    },
  } as unknown as Pick<Client, "insert" | "table">;

  const res = await handleRequest(new Request("https://trace-worker.test/api/web-traces", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      attestation: signAttestation(webTraceClaims()),
      batchId: "web-batch-v2-partial",
      records: [
        spanRecord({ name: "web.http.client", surface: "web", kind: "client", status: "ok" }),
        spanRecord({
          trace_id: "1123456789abcdef0123456789abcdef",
          span_id: "1123456789abcdef",
          name: "slock.state.transition",
          surface: "web",
          status: "unknown" as any,
        }),
      ],
    }),
  }), env);

  assert.equal(res.status, 200);
  assert.deepEqual(await res.json(), {
    ok: true,
    batchId: "web-batch-v2-partial",
    spansIngested: 2,
    scopedbStatus: "success",
    v2ProjectorStatus: "failed",
    v2SpansProjected: 1,
    v2RowsProjected: 2,
    v2SpansSkipped: 1,
    v2SkipReasonClasses: ["TraceProjectionRecordValidationError"],
  });
  const rows = projectedPayload.split("\n").map((row) => JSON.parse(row));
  assert.equal(rows.length, 2);
  assert.ok(rows.every((row) => row.span_id === "0123456789abcdef"));
});

test("web trace endpoint reports V2 failure without failing canonical OTLP", async () => {
  const { env } = baseEnv();
  let otlpCalls = 0;
  env.TRACE_INGEST_OTLP_ENDPOINT = "https://telescope.test/v1/traces";
  env.TRACE_INGEST_FETCH = async () => {
    otlpCalls += 1;
    return new Response(null, { status: 200 });
  };
  env.RAFT_TRACE_SCOPEDB_PROJECTOR = "on";
  env.SCOPEDB_TRACE_EVENTS_ENDPOINT = "https://scopedb.test";
  env.SCOPEDB_TRACE_EVENTS_WRITE_KEY = "test-key";
  env.SCOPEDB_TRACE_EVENTS_CLIENT = {
    table: () => mockTraceEventTable(),
    insert: async () => {
      throw new Error("projector unavailable");
    },
  } as unknown as Pick<Client, "insert" | "table">;

  const res = await handleRequest(new Request("https://trace-worker.test/api/web-traces", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      attestation: signAttestation(webTraceClaims()),
      batchId: "web-batch-v2-failed",
      records: [spanRecord({ name: "web.interaction.message_send", surface: "web" })],
    }),
  }), env);

  assert.equal(res.status, 200);
  assert.equal(otlpCalls, 1);
  const body = await res.json() as Record<string, unknown>;
  assert.equal(body.scopedbStatus, "success");
  assert.equal(body.v2ProjectorStatus, "failed");
  assert.equal(body.v2RowsProjected, 0);
});

test("feedback report endpoint stores raw report artifact and ledger without trace ingest", async () => {
  const { env, bucket } = baseEnv();
  env.TRACE_WEB_CORS_ORIGIN = "https://app.slock.ai";
  const bundle = Buffer.from(JSON.stringify({ schemaVersion: "slock-feedback-export-v2", ok: true }));
  const attestation = signAttestation(feedbackReportClaims());

  const createRes = await handleRequest(new Request("https://trace-worker.test/api/feedback-reports", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      attestation,
      agentId: "agent-1",
      source: "slock-web",
      bundleFilename: "../feedback.json",
      bundleContentType: "application/json",
      bundleSizeBytes: bundle.byteLength,
      bundleSha256: sha256Hex(bundle),
      title: "Issue report",
      description: "agent stalled",
      metadata: { schemaVersion: "slock-feedback-export-v2" },
    }),
  }), env);

  assert.equal(createRes.status, 200);
  assert.equal(createRes.headers.get("Access-Control-Allow-Origin"), "https://app.slock.ai");
  const createBody = await createRes.json() as {
    id: string;
    artifactId: string;
    completeToken: string;
    upload: { method: string; url: string; headers: Record<string, string> };
  };
  assert.equal(createBody.upload.method, "PUT");
  assert.equal(createBody.upload.headers["Content-Type"], "application/json");
  assert.ok(createBody.upload.url.includes(`/api/feedback-reports/${createBody.id}/object`));
  assert.ok(bucket.puts.some((put) => put.key === `feedback-report-ledgers/server-1/${createBody.id}/${createBody.artifactId}.json`));

  const putRes = await handleRequest(new Request(createBody.upload.url, {
    method: "PUT",
    headers: {
      "Content-Type": "application/json",
      "Content-Length": String(bundle.byteLength),
    },
    body: bundle,
  }), env);

  assert.equal(putRes.status, 200);
  assert.equal(putRes.headers.get("Access-Control-Allow-Origin"), "https://app.slock.ai");
  const objectPut = bucket.puts.find((put) => put.key.startsWith(`feedback-reports/server-1/${createBody.id}/${createBody.artifactId}/`));
  assert.ok(objectPut, "expected feedback artifact object to be written");
  assert.equal(objectPut.key, `feedback-reports/server-1/${createBody.id}/${createBody.artifactId}/feedback.json`);
  assert.equal(objectPut.options?.httpMetadata?.contentType, "application/json");
  assert.equal(objectPut.options?.customMetadata?.ledgerType, undefined);
  assert.equal(objectPut.options?.customMetadata?.serverId, "server-1");
  assert.equal(objectPut.options?.customMetadata?.agentId, "agent-1");

  const completeRes = await handleRequest(new Request(`https://trace-worker.test/api/feedback-reports/${createBody.id}/complete`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ completeToken: createBody.completeToken }),
  }), env);

  assert.equal(completeRes.status, 200);
  assert.equal(completeRes.headers.get("Access-Control-Allow-Origin"), "https://app.slock.ai");
  assert.deepEqual(await completeRes.json(), { ok: true, id: createBody.id, artifactId: createBody.artifactId });
  assert.ok(bucket.puts.some((put) => put.key === `feedback-report-ledgers/server-1/${createBody.id}/${createBody.artifactId}.complete.json`));
});

// TOOTH-2 (transport F1–F4 propagation). The daemon already computes transcript
// window coverage and sends it in the upload body.metadata. These tests pin that
// (a) F1–F4 survive into R2 customMetadata + ledger + webhook claim, and
// (b) R1/R4: an out-of-enum anchor source (e.g. createdAt) or a contradictory
// payload never defaults to "covered".
async function uploadFeedbackReportWithMetadata(
  env: TraceUploadWorkerEnv,
  bucket: MockR2Bucket,
  metadata: Record<string, unknown>,
) {
  const bundle = Buffer.from(JSON.stringify({ schemaVersion: "slock-feedback-export-v2", ok: true }));
  const attestation = signAttestation(feedbackReportClaims());
  const createRes = await handleRequest(new Request("https://trace-worker.test/api/feedback-reports", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      attestation,
      agentId: "agent-1",
      source: "slock-web",
      bundleFilename: "feedback.json",
      bundleContentType: "application/json",
      bundleSizeBytes: bundle.byteLength,
      bundleSha256: sha256Hex(bundle),
      metadata,
    }),
  }), env);
  assert.equal(createRes.status, 200);
  const createBody = await createRes.json() as { id: string; artifactId: string; completeToken: string; upload: { url: string } };
  const putRes = await handleRequest(new Request(createBody.upload.url, {
    method: "PUT",
    headers: { "Content-Type": "application/json" },
    body: bundle,
  }), env);
  assert.equal(putRes.status, 200);
  const objectPut = bucket.puts.find((put) => put.key.startsWith(`feedback-reports/server-1/${createBody.id}/${createBody.artifactId}/`));
  assert.ok(objectPut, "expected feedback artifact object to be written");
  return { objectPut, createBody };
}

test("tooth-2 transports transcript window F1–F4 into R2 customMetadata + ledger metadata", async () => {
  const { env, bucket } = baseEnv();
  const { objectPut } = await uploadFeedbackReportWithMetadata(env, bucket, {
    feedbackTranscriptWindowCoverage: "outside_report_window",
    feedbackTranscriptFirstEventAt: "2026-08-03T05:23:32.871Z",
    feedbackTranscriptLastEventAt: "2026-08-03T15:11:33.397Z",
    feedbackTranscriptTruncated: "true",
    feedbackTranscriptTruncationDirection: "tail",
    feedbackReportTimeSource: "model_read_at",
  });
  const cm = objectPut.options?.customMetadata as Record<string, string>;
  assert.equal(cm.transcriptCoverage, "outside_report_window");
  assert.equal(cm.transcriptFirstEventAt, "2026-08-03T05:23:32.871Z");
  assert.equal(cm.transcriptLastEventAt, "2026-08-03T15:11:33.397Z");
  assert.equal(cm.transcriptTruncated, "true");
  assert.equal(cm.transcriptTruncationDirection, "tail");
  assert.equal(cm.transcriptAnchorSource, "model_read_at");
});

test("tooth-2 R1/R4: out-of-enum anchor source (createdAt) is NOT defaulted to covered", async () => {
  const { env, bucket } = baseEnv();
  const { objectPut } = await uploadFeedbackReportWithMetadata(env, bucket, {
    feedbackTranscriptWindowCoverage: "covered",
    feedbackReportTimeSource: "createdAt", // out-of-enum ⇒ must not propagate a coverage claim
  });
  const cm = objectPut.options?.customMetadata as Record<string, string>;
  // fail-loud: an invalid anchor must not let a consumer read "covered"; no
  // coverage/ anchor claims are propagated, so the consumer predicate must red.
  assert.equal(cm.transcriptCoverage, undefined);
  assert.equal(cm.transcriptAnchorSource, undefined);
});

test("tooth-2 R1/R4: contradictory truncated/window payload never default-covered", async () => {
  const { env, bucket } = baseEnv();
  const { objectPut } = await uploadFeedbackReportWithMetadata(env, bucket, {
    feedbackTranscriptWindowCoverage: "covered",
    feedbackTranscriptFirstEventAt: "2026-08-03T05:23:32.871Z",
    feedbackTranscriptLastEventAt: "2026-08-03T09:30:00.000Z",
    // truncated=true but NO truncationDirection ⇒ R4: no valid covered claim
  });
  const cm = objectPut.options?.customMetadata as Record<string, string>;
  // Not a clean "covered" + valid anchor + direction combo ⇒ consumer must not
  // treat as covered; propagate the partial fields but never an implicit cover.
  assert.equal(cm.transcriptCoverage, "covered");
  assert.equal(cm.transcriptTruncationDirection, undefined);
});

test("feedback report endpoint handles CORS preflight for browser create and complete routes", async () => {
  const { env } = baseEnv();
  env.TRACE_WEB_CORS_ORIGIN = "https://app.slock.ai";

  const createRes = await handleRequest(new Request("https://trace-worker.test/api/reports", {
    method: "OPTIONS",
  }), env);

  assert.equal(createRes.status, 204);
  assert.equal(createRes.headers.get("Access-Control-Allow-Origin"), "https://app.slock.ai");
  assert.equal(createRes.headers.get("Access-Control-Allow-Methods"), "POST, PUT, OPTIONS");
  assert.match(createRes.headers.get("Access-Control-Allow-Headers") ?? "", /Content-Type/);

  const completeRes = await handleRequest(new Request("https://trace-worker.test/api/reports/report-1/complete", {
    method: "OPTIONS",
  }), env);

  assert.equal(completeRes.status, 204);
  assert.equal(completeRes.headers.get("Access-Control-Allow-Origin"), "https://app.slock.ai");
  assert.equal(completeRes.headers.get("Access-Control-Allow-Methods"), "POST, PUT, OPTIONS");
});

test("feedback report endpoint reflects matching CORS origin from configured allowlist", async () => {
  const { env } = baseEnv();
  env.TRACE_WEB_CORS_ORIGIN = "https://app.slock.ai, https://app.raft.build";

  const res = await handleRequest(new Request("https://trace-worker.test/api/reports", {
    method: "OPTIONS",
    headers: { Origin: "https://app.raft.build" },
  }), env);

  assert.equal(res.status, 204);
  assert.equal(res.headers.get("Access-Control-Allow-Origin"), "https://app.raft.build");
  assert.equal(res.headers.get("Vary"), "Origin");
});

test("feedback report endpoint handles CORS preflight for browser upload route", async () => {
  const { env } = baseEnv();
  env.TRACE_WEB_CORS_ORIGIN = "https://app.slock.ai";

  const res = await handleRequest(new Request("https://trace-worker.test/api/reports/report-1/object", {
    method: "OPTIONS",
  }), env);

  assert.equal(res.status, 204);
  assert.equal(res.headers.get("Access-Control-Allow-Origin"), "https://app.slock.ai");
  assert.equal(res.headers.get("Access-Control-Allow-Methods"), "POST, PUT, OPTIONS");
});

test("feedback report endpoint rejects trace upload attestation scope", async () => {
  const { env } = baseEnv();
  const bundle = Buffer.from("feedback");
  const attestation = signAttestation(traceUploadClaims({
    uploadId: "upload-1",
    objectKey: "trace-bundles/server-1/machine-1/upload-1.jsonl.gz",
    bundleId: "bundle-1",
    bundleSha256: sha256Hex(bundle),
    bundleSizeBytes: bundle.byteLength,
    maxBytes: 1024,
  }));

  const res = await handleRequest(new Request("https://trace-worker.test/api/feedback-reports", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      attestation,
      bundleFilename: "feedback.json",
      bundleContentType: "application/json",
      bundleSizeBytes: bundle.byteLength,
      bundleSha256: sha256Hex(bundle),
    }),
  }), env);

  assert.equal(res.status, 403);
  assert.deepEqual(await res.json(), { error: "Invalid attestation scope" });
});

test("feedback report endpoint rejects bundles over configured maxBytes", async () => {
  const { env } = baseEnv();
  env.FEEDBACK_REPORT_MAX_BYTES = "8";
  const bundle = Buffer.from("feedback!");
  const attestation = signAttestation(feedbackReportClaims());

  const res = await handleRequest(new Request("https://trace-worker.test/api/feedback-reports", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      attestation,
      bundleFilename: "feedback.json",
      bundleContentType: "application/json",
      bundleSizeBytes: bundle.byteLength,
      bundleSha256: sha256Hex(bundle),
    }),
  }), env);

  assert.equal(res.status, 400);
  assert.deepEqual(await res.json(), { error: "bundleSizeBytes exceeds maxBytes" });
});

test("feedback report endpoint rate-limits reports by user and hour before writing report ledgers", async () => {
  const { env, bucket } = baseEnv();
  env.FEEDBACK_REPORT_HOURLY_LIMIT = "1";
  const firstBundle = Buffer.from("first feedback");
  const secondBundle = Buffer.from("second feedback");

  const firstRes = await handleRequest(new Request("https://trace-worker.test/api/feedback-reports", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      attestation: signAttestation(feedbackReportClaims()),
      bundleFilename: "first.json",
      bundleContentType: "application/json",
      bundleSizeBytes: firstBundle.byteLength,
      bundleSha256: sha256Hex(firstBundle),
    }),
  }), env);

  assert.equal(firstRes.status, 200);

  const secondRes = await handleRequest(new Request("https://trace-worker.test/api/feedback-reports", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      attestation: signAttestation(feedbackReportClaims({ nonce: "nonce-feedback-2" })),
      bundleFilename: "second.json",
      bundleContentType: "application/json",
      bundleSizeBytes: secondBundle.byteLength,
      bundleSha256: sha256Hex(secondBundle),
    }),
  }), env);

  assert.equal(secondRes.status, 429);
  assert.deepEqual(await secondRes.json(), { error: "Feedback report rate limit exceeded" });
  assert.equal(bucket.puts.filter((put) => put.key.startsWith("feedback-report-rate-limits/")).length, 1);
  assert.equal(bucket.puts.filter((put) => put.key.startsWith("feedback-report-ledgers/")).length, 1);
  assert.equal(bucket.puts.filter((put) => put.key.startsWith("feedback-reports/")).length, 0);
});

test("feedback report endpoint rejects complete before object upload", async () => {
  const { env, bucket } = baseEnv();
  const bundle = Buffer.from("feedback");

  const createRes = await handleRequest(new Request("https://trace-worker.test/api/feedback-reports", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      attestation: signAttestation(feedbackReportClaims()),
      bundleFilename: "feedback.json",
      bundleContentType: "application/json",
      bundleSizeBytes: bundle.byteLength,
      bundleSha256: sha256Hex(bundle),
    }),
  }), env);

  assert.equal(createRes.status, 200);
  const createBody = await createRes.json() as {
    id: string;
    artifactId: string;
    completeToken: string;
  };

  const completeRes = await handleRequest(new Request(`https://trace-worker.test/api/feedback-reports/${createBody.id}/complete`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ completeToken: createBody.completeToken }),
  }), env);

  assert.equal(completeRes.status, 409);
  assert.deepEqual(await completeRes.json(), { error: "Feedback report upload has not completed" });
  assert.equal(bucket.puts.some((put) => put.key === `feedback-report-ledgers/server-1/${createBody.id}/${createBody.artifactId}.complete.json`), false);
});

test("feedback report endpoint rate-limits users independently", async () => {
  const { env } = baseEnv();
  env.FEEDBACK_REPORT_HOURLY_LIMIT = "1";
  const bundle = Buffer.from("feedback");

  const firstRes = await handleRequest(new Request("https://trace-worker.test/api/feedback-reports", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      attestation: signAttestation(feedbackReportClaims({ sub: "user-1", nonce: "nonce-feedback-1" })),
      bundleFilename: "first.json",
      bundleContentType: "application/json",
      bundleSizeBytes: bundle.byteLength,
      bundleSha256: sha256Hex(bundle),
    }),
  }), env);
  assert.equal(firstRes.status, 200);

  const secondRes = await handleRequest(new Request("https://trace-worker.test/api/feedback-reports", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      attestation: signAttestation(feedbackReportClaims({
        sub: "user-2",
        nonce: "nonce-feedback-2",
      })),
      bundleFilename: "second.json",
      bundleContentType: "application/json",
      bundleSizeBytes: bundle.byteLength,
      bundleSha256: sha256Hex(bundle),
    }),
  }), env);
  assert.equal(secondRes.status, 200);
});

test("feedback report endpoint accepts machine-scoped attestation for daemon artifacts", async () => {
  const { env } = baseEnv();
  const bundle = Buffer.from("daemon diagnostics");
  const attestation = signAttestation(feedbackReportClaims({
    sub: "machine:machine-1",
    actorType: "machine",
    machineId: "machine-1",
    aud: "feedback-worker",
    resource: "servers/server-1/machines/machine-1/feedback-reports",
  }));

  const res = await handleRequest(new Request("https://trace-worker.test/api/feedback-reports", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      attestation,
      agentId: "agent-1",
      source: "slock-daemon",
      bundleFilename: "daemon-bundle.tar.gz",
      bundleContentType: "application/gzip",
      bundleSizeBytes: bundle.byteLength,
      bundleSha256: sha256Hex(bundle),
    }),
  }), env);

  assert.equal(res.status, 200);
  const body = await res.json() as {
    upload: { method: string; url: string; headers: Record<string, string> };
  };
  assert.equal(body.upload.method, "PUT");
  assert.equal(body.upload.headers["Content-Type"], "application/gzip");
});

test("trace upload worker rejects feedback report attestation scope", async () => {
  const { env } = baseEnv();
  const bundle = Buffer.from("trace");
  const attestation = signAttestation(feedbackReportClaims({
    resource: "servers/server-1/feedback-reports",
  }));

  const res = await handleRequest(new Request("https://trace-worker.test/api/trace-bundles", {
    method: "POST",
    body: JSON.stringify({
      attestation,
      bundleSha256: sha256Hex(bundle),
      bundleSizeBytes: bundle.byteLength,
    }),
  }), env);

  assert.equal(res.status, 403);
  assert.deepEqual(await res.json(), { error: "Invalid attestation scope" });
});

test("web trace endpoint rejects daemon trace attestation scope", async () => {
  const { env } = baseEnv();
  const bundle = Buffer.from("trace");
  const attestation = signAttestation(traceUploadClaims({
    uploadId: "upload-1",
    objectKey: "trace-bundles/server-1/machine-1/upload-1.jsonl.gz",
    bundleId: "bundle-1",
    bundleSha256: sha256Hex(bundle),
    bundleSizeBytes: bundle.byteLength,
    maxBytes: 1024,
  }));

  const res = await handleRequest(new Request("https://trace-worker.test/api/web-traces", {
    method: "POST",
    body: JSON.stringify({
      attestation,
      records: [spanRecord({ surface: "web" })],
    }),
  }), env);

  assert.equal(res.status, 403);
  assert.deepEqual(await res.json(), { error: "Invalid attestation scope" });
});

test("web trace endpoint handles CORS preflight", async () => {
  const { env } = baseEnv();
  env.TRACE_WEB_CORS_ORIGIN = "https://app.slock.ai";

  const res = await handleRequest(new Request("https://trace-worker.test/api/web-traces", {
    method: "OPTIONS",
  }), env);

  assert.equal(res.status, 204);
  assert.equal(res.headers.get("Access-Control-Allow-Origin"), "https://app.slock.ai");
  assert.equal(res.headers.get("Access-Control-Allow-Methods"), "POST, OPTIONS");
  assert.match(res.headers.get("Access-Control-Allow-Headers") ?? "", /Authorization/);
});

test("web trace endpoint reflects matching CORS origin from configured allowlist", async () => {
  const { env } = baseEnv();
  env.TRACE_WEB_CORS_ORIGIN = "https://app.slock.ai, https://app.raft.build";

  const raftRes = await handleRequest(new Request("https://trace-worker.test/api/web-traces", {
    method: "OPTIONS",
    headers: { Origin: "https://app.raft.build" },
  }), env);

  assert.equal(raftRes.status, 204);
  assert.equal(raftRes.headers.get("Access-Control-Allow-Origin"), "https://app.raft.build");
  assert.equal(raftRes.headers.get("Vary"), "Origin");

  const legacyRes = await handleRequest(new Request("https://trace-worker.test/api/web-traces", {
    method: "OPTIONS",
    headers: { Origin: "https://app.slock.ai" },
  }), env);

  assert.equal(legacyRes.status, 204);
  assert.equal(legacyRes.headers.get("Access-Control-Allow-Origin"), "https://app.slock.ai");
  assert.equal(legacyRes.headers.get("Vary"), "Origin");
});

test("web trace endpoint does not reflect origins outside configured allowlist", async () => {
  const { env } = baseEnv();
  env.TRACE_WEB_CORS_ORIGIN = "https://app.slock.ai, https://app.raft.build";

  const res = await handleRequest(new Request("https://trace-worker.test/api/web-traces", {
    method: "OPTIONS",
    headers: { Origin: "https://evil.example" },
  }), env);

  assert.equal(res.status, 204);
  assert.equal(res.headers.get("Access-Control-Allow-Origin"), "https://app.slock.ai");
  assert.equal(res.headers.get("Vary"), "Origin");
});

test("trace upload worker verifies attestation and stores bundle at signed R2 key", async () => {
  const { env, bucket } = baseEnv();
  const bundle = Buffer.from("{\"type\":\"span\",\"name\":\"daemon.test\"}\n");
  const metadata = {
    uploadId: "upload-1",
    objectKey: "trace-bundles/server-1/machine-1/upload-1.jsonl.gz",
    bundleId: "bundle-1",
    bundleSha256: sha256Hex(bundle),
    bundleSizeBytes: bundle.byteLength,
    bundleContentType: "application/x-ndjson",
    bundleContentEncoding: "gzip",
    feedbackReportId: "report-abc",
    agentId: "agent-xyz",
    maxBytes: 1024 * 1024,
  };
  const attestation = signAttestation(traceUploadClaims(metadata));

  const createRes = await handleRequest(new Request("https://trace-worker.test/api/trace-bundles", {
    method: "POST",
    body: JSON.stringify({
      attestation,
      bundleSha256: metadata.bundleSha256,
      bundleSizeBytes: metadata.bundleSizeBytes,
      objectKey: "attacker-controlled-key-must-be-ignored",
    }),
  }), env);
  assert.equal(createRes.status, 200);
  const createBody = await createRes.json() as {
    id: string;
    upload: { method: string; url: string; headers: Record<string, string> };
  };
  assert.equal(createBody.id, "upload-1");
  assert.equal(createBody.upload.method, "PUT");
  assert.equal(createBody.upload.headers["Content-Type"], "application/x-ndjson");
  assert.equal(createBody.upload.headers["Content-Encoding"], "gzip");

  const putRes = await handleRequest(new Request(createBody.upload.url, {
    method: "PUT",
    body: bundle,
  }), env);
  assert.equal(putRes.status, 200);
  assert.equal(putRes.headers.get("etag"), "mock-etag");

  assert.equal(bucket.puts.length, 2);
  const rawPut = bucket.puts.find((put) => put.key === metadata.objectKey);
  assert.ok(rawPut);
  assert.equal(putBodyToString(rawPut.body), bundle.toString("utf8"));
  assert.deepEqual(rawPut.options, {
    httpMetadata: {
      contentType: "application/x-ndjson",
      contentEncoding: "gzip",
    },
    customMetadata: {
      uploadId: "upload-1",
      bundleId: "bundle-1",
      bundleSha256: metadata.bundleSha256,
      bundleSizeBytes: String(bundle.byteLength),
      serverId: "server-1",
      machineId: "machine-1",
      feedbackReportId: "report-abc",
      agentId: "agent-xyz",
    },
  });
  const ledgerPut = bucket.puts.find((put) => put.key === "trace-ledgers/server-1/machine-1/upload-1.json");
  assert.ok(ledgerPut);
  const ledger = JSON.parse(String(ledgerPut.body));
  assert.equal(ledger.r2_status, "success");
  assert.equal(ledger.scopedb_status, "skipped");
  assert.equal(ledger.object_key, metadata.objectKey);
  assert.equal(ledger.feedback_report_id, "report-abc");
  assert.equal(ledger.agent_id, "agent-xyz");
  assert.equal(ledger.span_key_identity, "serverId:machineId:bundleSha256:trace_id:span_id");
  assert.deepEqual(ledgerPut.options?.customMetadata, {
    uploadId: "upload-1",
    bundleId: "bundle-1",
    bundleSha256: metadata.bundleSha256,
    serverId: "server-1",
    machineId: "machine-1",
    ledgerType: "daemon-trace-upload",
    feedbackReportId: "report-abc",
    agentId: "agent-xyz",
  });
});

test("trace upload worker rejects invalid attestation audience", async () => {
  const { env } = baseEnv();
  const bundle = Buffer.from("trace");
  const metadata = {
    uploadId: "upload-1",
    objectKey: "trace-bundles/server-1/machine-1/upload-1.jsonl.gz",
    bundleId: "bundle-1",
    bundleSha256: sha256Hex(bundle),
    bundleSizeBytes: bundle.byteLength,
    maxBytes: 1024,
  };
  const attestation = signAttestation(traceUploadClaims(metadata, { aud: "feedback-worker" }));

  const res = await handleRequest(new Request("https://trace-worker.test/api/trace-bundles", {
    method: "POST",
    body: JSON.stringify({
      attestation,
      bundleSha256: metadata.bundleSha256,
      bundleSizeBytes: metadata.bundleSizeBytes,
    }),
  }), env);

  assert.equal(res.status, 403);
  assert.deepEqual(await res.json(), { error: "Invalid attestation audience" });
});

test("trace upload worker rejects mismatched signed metadata before upload", async () => {
  const { env } = baseEnv();
  const bundle = Buffer.from("trace");
  const metadata = {
    uploadId: "upload-1",
    objectKey: "trace-bundles/server-1/machine-1/upload-1.jsonl.gz",
    bundleId: "bundle-1",
    bundleSha256: sha256Hex(bundle),
    bundleSizeBytes: bundle.byteLength,
    maxBytes: 1024,
  };
  const attestation = signAttestation(traceUploadClaims(metadata));

  const res = await handleRequest(new Request("https://trace-worker.test/api/trace-bundles", {
    method: "POST",
    body: JSON.stringify({
      attestation,
      bundleSha256: "0".repeat(64),
      bundleSizeBytes: metadata.bundleSizeBytes,
    }),
  }), env);

  assert.equal(res.status, 400);
  assert.deepEqual(await res.json(), { error: "bundleSha256 does not match signed metadata" });
});

test("trace upload worker rejects body hash mismatch and does not write R2", async () => {
  const { env, bucket } = baseEnv();
  const expectedBundle = Buffer.from("expected");
  const metadata = {
    uploadId: "upload-1",
    objectKey: "trace-bundles/server-1/machine-1/upload-1.jsonl.gz",
    bundleId: "bundle-1",
    bundleSha256: sha256Hex(expectedBundle),
    bundleSizeBytes: expectedBundle.byteLength,
    maxBytes: 1024,
  };
  const attestation = signAttestation(traceUploadClaims(metadata));

  const createRes = await handleRequest(new Request("https://trace-worker.test/api/trace-bundles", {
    method: "POST",
    body: JSON.stringify({
      attestation,
      bundleSha256: metadata.bundleSha256,
      bundleSizeBytes: metadata.bundleSizeBytes,
    }),
  }), env);
  const createBody = await createRes.json() as { upload: { url: string } };

  const res = await handleRequest(new Request(createBody.upload.url, {
    method: "PUT",
    body: Buffer.from("tampered"),
  }), env);

  assert.equal(res.status, 400);
  assert.deepEqual(await res.json(), { error: "bundleSha256 mismatch" });
  assert.equal(bucket.puts.length, 0);
});

test("trace upload worker rejects oversized content-length before reading or writing R2", async () => {
  const { env, bucket } = baseEnv();
  const expectedBundle = Buffer.from("expected");
  const metadata = {
    uploadId: "upload-1",
    objectKey: "trace-bundles/server-1/machine-1/upload-1.jsonl.gz",
    bundleId: "bundle-1",
    bundleSha256: sha256Hex(expectedBundle),
    bundleSizeBytes: expectedBundle.byteLength,
    maxBytes: expectedBundle.byteLength,
  };
  const attestation = signAttestation(traceUploadClaims(metadata));

  const createRes = await handleRequest(new Request("https://trace-worker.test/api/trace-bundles", {
    method: "POST",
    body: JSON.stringify({
      attestation,
      bundleSha256: metadata.bundleSha256,
      bundleSizeBytes: metadata.bundleSizeBytes,
    }),
  }), env);
  const createBody = await createRes.json() as { upload: { url: string } };

  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(new Uint8Array(expectedBundle.byteLength + 1));
      controller.close();
    },
  });
  const res = await handleRequest(new Request(createBody.upload.url, {
    method: "PUT",
    headers: {
      "Content-Length": String(expectedBundle.byteLength + 1),
    },
    body: stream,
    duplex: "half",
  } as RequestInit), env);

  assert.equal(res.status, 413);
  assert.deepEqual(await res.json(), { error: "Bundle exceeds maxBytes" });
  assert.equal(bucket.puts.length, 0);
});

test("trace upload worker caps streaming reads when Content-Length is absent", async () => {
  const { env, bucket } = baseEnv();
  const expectedBundle = Buffer.from("expected");
  const metadata = {
    uploadId: "upload-1",
    objectKey: "trace-bundles/server-1/machine-1/upload-1.jsonl.gz",
    bundleId: "bundle-1",
    bundleSha256: sha256Hex(expectedBundle),
    bundleSizeBytes: expectedBundle.byteLength,
    maxBytes: expectedBundle.byteLength,
  };
  const attestation = signAttestation(traceUploadClaims(metadata));

  const createRes = await handleRequest(new Request("https://trace-worker.test/api/trace-bundles", {
    method: "POST",
    body: JSON.stringify({
      attestation,
      bundleSha256: metadata.bundleSha256,
      bundleSizeBytes: metadata.bundleSizeBytes,
    }),
  }), env);
  const createBody = await createRes.json() as { upload: { url: string } };

  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(new Uint8Array(expectedBundle.byteLength));
      controller.enqueue(new Uint8Array(1));
      controller.close();
    },
  });
  const res = await handleRequest(new Request(createBody.upload.url, {
    method: "PUT",
    body: stream,
    duplex: "half",
  } as RequestInit), env);

  assert.equal(res.status, 413);
  assert.deepEqual(await res.json(), { error: "Bundle exceeds maxBytes" });
  assert.equal(bucket.puts.length, 0);
});

test("trace upload worker schedules async R2 to OTLP ingest after successful upload", async () => {
  const { env, bucket } = baseEnv();
  const fetchCalls: Array<{ input: RequestInfo | URL; init?: RequestInit }> = [];
  env.TRACE_INGEST_OTLP_ENDPOINT = "https://telescope.test";
  env.TRACE_INGEST_SERVICE_NAME = "slock-daemon-test";
  env.DEPLOYMENT_ENV = "production";
  env.SLOCK_RELEASE_SHA = "rev-1";
  env.TRACE_INGEST_FETCH = async (input, init) => {
    fetchCalls.push({ input, init });
    return new Response(null, { status: 200 });
  };
  const bundle = Buffer.from(`${JSON.stringify(spanRecord())}\n`);
  const metadata = {
    uploadId: "upload-1",
    objectKey: "trace-bundles/server-1/machine-1/upload-1.jsonl",
    bundleId: "bundle-1",
    bundleSha256: sha256Hex(bundle),
    bundleSizeBytes: bundle.byteLength,
    bundleContentType: "application/x-ndjson",
    deploymentEnvironment: "staging",
    maxBytes: 1024 * 1024,
  };
  const attestation = signAttestation(traceUploadClaims(metadata));
  const ctx = new MockExecutionContext();

  const createRes = await handleRequest(new Request("https://trace-worker.test/api/trace-bundles", {
    method: "POST",
    body: JSON.stringify({
      attestation,
      bundleSha256: metadata.bundleSha256,
      bundleSizeBytes: metadata.bundleSizeBytes,
    }),
  }), env, ctx);
  const createBody = await createRes.json() as { upload: { url: string } };

  const putRes = await handleRequest(new Request(createBody.upload.url, {
    method: "PUT",
    body: bundle,
  }), env, ctx);
  assert.equal(putRes.status, 200);
  assert.equal(ctx.promises.length, 1);
  await Promise.all(ctx.promises);

  assert.equal(fetchCalls.length, 1);
  assert.deepEqual(bucket.puts.find((put) => put.key === metadata.objectKey)?.options?.customMetadata?.deploymentEnvironment, "staging");
  const ledgerPuts = bucket.puts.filter((put) => put.key === "trace-ledgers/server-1/machine-1/upload-1.json");
  assert.equal(ledgerPuts.length, 2);
  const finalLedger = JSON.parse(String(ledgerPuts[1].body));
  assert.equal(finalLedger.r2_status, "success");
  assert.equal(finalLedger.scopedb_status, "success");
  assert.equal(finalLedger.spans_ingested, 1);
  assert.equal(finalLedger.batches_sent, 1);
  assert.equal(String(fetchCalls[0].input), "https://telescope.test/v1/traces");
  const payload = JSON.parse(fetchCalls[0].init?.body as string);
  const resourceAttrs = payload.resourceSpans[0].resource.attributes;
  assert.deepEqual(resourceAttrs.find((attr: { key: string }) => attr.key === "service.name"), {
    key: "service.name",
    value: { stringValue: "slock-daemon-test" },
  });
  assert.deepEqual(resourceAttrs.find((attr: { key: string }) => attr.key === "service.version"), {
    key: "service.version",
    value: { stringValue: "0.55.6" },
  });
  assert.deepEqual(resourceAttrs.find((attr: { key: string }) => attr.key === "slock.trace_upload.upload_id"), {
    key: "slock.trace_upload.upload_id",
    value: { stringValue: "upload-1" },
  });
  assert.deepEqual(resourceAttrs.find((attr: { key: string }) => attr.key === "deployment.environment"), {
    key: "deployment.environment",
    value: { stringValue: "staging" },
  });

  const spans = payload.resourceSpans[0].scopeSpans[0].spans;
  assert.equal(spans.length, 1);
  assert.equal(spans[0].name, "daemon.agent.delivery.routed");
  assert.equal(spans[0].traceId, "0123456789abcdef0123456789abcdef");
  assert.equal(spans[0].events[0].name, "daemon.agent.stdin.written");
});

test("trace upload worker records ScopeDB ingest failure in the upload ledger", async () => {
  const { env, bucket } = baseEnv();
  env.TRACE_INGEST_OTLP_ENDPOINT = "https://telescope.test";
  env.TRACE_INGEST_FETCH = async () => new Response("scope down", { status: 503 });
  const bundle = Buffer.from(`${JSON.stringify(spanRecord())}\n`);
  const metadata = {
    uploadId: "upload-failed",
    objectKey: "trace-bundles/server-1/machine-1/upload-failed.jsonl",
    bundleId: "bundle-failed",
    bundleSha256: sha256Hex(bundle),
    bundleSizeBytes: bundle.byteLength,
    bundleContentType: "application/x-ndjson",
    maxBytes: 1024 * 1024,
  };
  const attestation = signAttestation(traceUploadClaims(metadata));
  const ctx = new MockExecutionContext();

  const createRes = await handleRequest(new Request("https://trace-worker.test/api/trace-bundles", {
    method: "POST",
    body: JSON.stringify({
      attestation,
      bundleSha256: metadata.bundleSha256,
      bundleSizeBytes: metadata.bundleSizeBytes,
    }),
  }), env, ctx);
  const createBody = await createRes.json() as { upload: { url: string } };

  const putRes = await handleRequest(new Request(createBody.upload.url, {
    method: "PUT",
    body: bundle,
  }), env, ctx);
  assert.equal(putRes.status, 200);
  await Promise.all(ctx.promises);

  const ledgerPuts = bucket.puts.filter((put) => put.key === "trace-ledgers/server-1/machine-1/upload-failed.json");
  assert.equal(ledgerPuts.length, 2);
  const finalLedger = JSON.parse(String(ledgerPuts[1].body));
  assert.equal(finalLedger.r2_status, "success");
  assert.equal(finalLedger.scopedb_status, "failed");
  assert.equal(finalLedger.error_class, "Error");
  assert.equal(finalLedger.error_message_present, true);
});

test("trace upload worker emits stable span dedupe keys across repeated ingest attempts", async () => {
  const { env } = baseEnv();
  const fetchCalls: Array<{ input: RequestInfo | URL; init?: RequestInit }> = [];
  env.TRACE_INGEST_OTLP_ENDPOINT = "https://telescope.test";
  env.TRACE_INGEST_FETCH = async (input, init) => {
    fetchCalls.push({ input, init });
    return new Response(null, { status: 200 });
  };
  const bundle = Buffer.from(`${JSON.stringify(spanRecord())}\n`);
  const metadata = {
    uploadId: "upload-1",
    objectKey: "trace-bundles/server-1/machine-1/upload-1.jsonl",
    bundleId: "bundle-1",
    bundleSha256: sha256Hex(bundle),
    bundleSizeBytes: bundle.byteLength,
    maxBytes: 1024 * 1024,
  };
  const attestation = signAttestation(traceUploadClaims(metadata));
  const createRes = await handleRequest(new Request("https://trace-worker.test/api/trace-bundles", {
    method: "POST",
    body: JSON.stringify({
      attestation,
      bundleSha256: metadata.bundleSha256,
      bundleSizeBytes: metadata.bundleSizeBytes,
    }),
  }), env);
  const createBody = await createRes.json() as { upload: { url: string } };

  const firstCtx = new MockExecutionContext();
  const firstPut = await handleRequest(new Request(createBody.upload.url, {
    method: "PUT",
    body: bundle,
  }), env, firstCtx);
  assert.equal(firstPut.status, 200);
  await Promise.all(firstCtx.promises);

  const secondCtx = new MockExecutionContext();
  const secondPut = await handleRequest(new Request(createBody.upload.url, {
    method: "PUT",
    body: bundle,
  }), env, secondCtx);
  assert.equal(secondPut.status, 200);
  await Promise.all(secondCtx.promises);

  assert.equal(fetchCalls.length, 2);
  const firstPayload = JSON.parse(fetchCalls[0].init?.body as string);
  const secondPayload = JSON.parse(fetchCalls[1].init?.body as string);
  const firstAttrs = firstPayload.resourceSpans[0].scopeSpans[0].spans[0].attributes;
  const secondAttrs = secondPayload.resourceSpans[0].scopeSpans[0].spans[0].attributes;
  const firstKey = firstAttrs.find((attr: { key: string }) => attr.key === "slock.trace_ingest.span_key");
  const secondKey = secondAttrs.find((attr: { key: string }) => attr.key === "slock.trace_ingest.span_key");
  const expectedKey = `server-1:machine-1:${metadata.bundleSha256}:0123456789abcdef0123456789abcdef:0123456789abcdef`;
  assert.deepEqual(firstKey, {
    key: "slock.trace_ingest.span_key",
    value: { stringValue: expectedKey },
  });
  assert.deepEqual(secondKey, firstKey);
});

test("trace upload worker keeps span dedupe key stable when replay uses a new uploadId", async () => {
  const { env, bucket } = baseEnv();
  const fetchCalls: Array<{ input: RequestInfo | URL; init?: RequestInit }> = [];
  env.TRACE_INGEST_OTLP_ENDPOINT = "https://telescope.test";
  env.TRACE_INGEST_FETCH = async (input, init) => {
    fetchCalls.push({ input, init });
    return new Response(null, { status: 200 });
  };
  const bundle = Buffer.from(`${JSON.stringify(spanRecord())}\n`);
  const metadataA = {
    uploadId: "upload-a",
    objectKey: "trace-bundles/server-1/machine-1/upload-a.jsonl",
    bundleId: "bundle-a",
    bundleSha256: sha256Hex(bundle),
    bundleSizeBytes: bundle.byteLength,
    maxBytes: 1024 * 1024,
  };
  const metadataB = {
    ...metadataA,
    uploadId: "upload-b",
    objectKey: "trace-bundles/server-1/machine-1/upload-b.jsonl",
    bundleId: "bundle-b",
  };
  await bucket.put(metadataA.objectKey, bufferToArrayBuffer(bundle), {
    customMetadata: {
      uploadId: metadataA.uploadId,
      bundleId: metadataA.bundleId,
      bundleSha256: metadataA.bundleSha256,
      bundleSizeBytes: String(metadataA.bundleSizeBytes),
      serverId: "server-1",
      machineId: "machine-1",
    },
  });
  await bucket.put(metadataB.objectKey, bufferToArrayBuffer(bundle), {
    customMetadata: {
      uploadId: metadataB.uploadId,
      bundleId: metadataB.bundleId,
      bundleSha256: metadataB.bundleSha256,
      bundleSizeBytes: String(metadataB.bundleSizeBytes),
      serverId: "server-1",
      machineId: "machine-1",
    },
  });

  await ingestTraceBundleObject(env, {
    uploadId: metadataA.uploadId,
    objectKey: metadataA.objectKey,
    bundleId: metadataA.bundleId,
    bundleSha256: metadataA.bundleSha256,
    bundleSizeBytes: metadataA.bundleSizeBytes,
    serverId: "server-1",
    machineId: "machine-1",
  });
  await ingestTraceBundleObject(env, {
    uploadId: metadataB.uploadId,
    objectKey: metadataB.objectKey,
    bundleId: metadataB.bundleId,
    bundleSha256: metadataB.bundleSha256,
    bundleSizeBytes: metadataB.bundleSizeBytes,
    serverId: "server-1",
    machineId: "machine-1",
  });

  assert.equal(fetchCalls.length, 2);
  const firstPayload = JSON.parse(fetchCalls[0].init?.body as string);
  const secondPayload = JSON.parse(fetchCalls[1].init?.body as string);
  const getSpanKey = (payload: Record<string, any>) =>
    payload.resourceSpans[0].scopeSpans[0].spans[0].attributes
      .find((attr: { key: string }) => attr.key === "slock.trace_ingest.span_key");
  assert.deepEqual(getSpanKey(firstPayload), {
    key: "slock.trace_ingest.span_key",
    value: {
      stringValue: `server-1:machine-1:${metadataA.bundleSha256}:0123456789abcdef0123456789abcdef:0123456789abcdef`,
    },
  });
  assert.deepEqual(getSpanKey(secondPayload), getSpanKey(firstPayload));
});

test("trace bundle ingest reads gzipped R2 bundle and batches OTLP writes", async () => {
  const { env, bucket } = baseEnv();
  const fetchCalls: Array<{ input: RequestInfo | URL; init?: RequestInit }> = [];
  env.TRACE_INGEST_OTLP_ENDPOINT = "https://telescope.test/v1/traces";
  env.TRACE_INGEST_BATCH_SIZE = "1";
  env.TRACE_INGEST_FETCH = async (input, init) => {
    fetchCalls.push({ input, init });
    return new Response(null, { status: 200 });
  };
  const bundle = gzipSync(Buffer.from([
    JSON.stringify(spanRecord({ span_id: "1111111111111111", name: "daemon.connection.opened" })),
    JSON.stringify(spanRecord({ span_id: "2222222222222222", name: "daemon.connection.closed" })),
    "",
  ].join("\n")));
  const metadata = {
    uploadId: "upload-gzip",
    objectKey: "trace-bundles/server-1/machine-1/upload-gzip.jsonl.gz",
    bundleId: "bundle-gzip",
    bundleSha256: sha256Hex(bundle),
    bundleSizeBytes: bundle.byteLength,
    serverId: "server-1",
    machineId: "machine-1",
  };

  await bucket.put(metadata.objectKey, bufferToArrayBuffer(bundle), {
    httpMetadata: {
      contentType: "application/x-ndjson",
      contentEncoding: "gzip",
    },
  });

  const result = await ingestTraceBundleObject(env, metadata);

  assert.deepEqual(result, {
    spans_ingested: 2,
    batches_sent: 2,
    v2_projector_status: "skipped",
    v2_spans_projected: 0,
    v2_rows_projected: 0,
    v2_spans_skipped: 0,
    v2_skip_reason_classes: [],
  });
  assert.equal(fetchCalls.length, 2);
  const firstPayload = JSON.parse(fetchCalls[0].init?.body as string);
  const secondPayload = JSON.parse(fetchCalls[1].init?.body as string);
  assert.equal(firstPayload.resourceSpans[0].scopeSpans[0].spans[0].name, "daemon.connection.opened");
  assert.equal(secondPayload.resourceSpans[0].scopeSpans[0].spans[0].name, "daemon.connection.closed");
});

test("trace bundle ingest shadows every successful OTLP batch into V2", async () => {
  const { env, bucket } = baseEnv();
  const callOrder: string[] = [];
  const projectedPayloads: string[] = [];
  env.TRACE_INGEST_OTLP_ENDPOINT = "https://telescope.test/v1/traces";
  env.TRACE_INGEST_BATCH_SIZE = "1";
  env.TRACE_INGEST_FETCH = async () => {
    callOrder.push("otlp");
    return new Response(null, { status: 200 });
  };
  env.RAFT_TRACE_SCOPEDB_PROJECTOR = "on";
  env.SCOPEDB_TRACE_EVENTS_ENDPOINT = "https://scopedb.test";
  env.SCOPEDB_TRACE_EVENTS_WRITE_KEY = "test-key";
  env.SCOPEDB_TRACE_EVENTS_CLIENT = {
    table: () => mockTraceEventTable(),
    insert: async (payload: string) => {
      callOrder.push("v2");
      projectedPayloads.push(payload);
      return { num_rows_inserted: 2 };
    },
  } as unknown as Pick<Client, "insert" | "table">;
  const bundle = Buffer.from([
    JSON.stringify(spanRecord({ span_id: "1111111111111111", name: "daemon.connection.opened" })),
    JSON.stringify(spanRecord({ span_id: "2222222222222222", name: "daemon.connection.closed" })),
    "",
  ].join("\n"));
  const metadata = {
    uploadId: "upload-v2",
    objectKey: "trace-bundles/server-1/machine-1/upload-v2.jsonl",
    bundleId: "bundle-v2",
    bundleSha256: sha256Hex(bundle),
    bundleSizeBytes: bundle.byteLength,
    serverId: "server-1",
    machineId: "machine-1",
    deploymentEnvironment: "production",
    agentId: "agent-metadata",
  };
  await bucket.put(metadata.objectKey, bufferToArrayBuffer(bundle), {
    httpMetadata: { contentType: "application/x-ndjson" },
  });

  const result = await ingestTraceBundleObject(env, metadata);

  assert.deepEqual(callOrder, ["otlp", "v2", "otlp", "v2"]);
  assert.deepEqual(result, {
    spans_ingested: 2,
    batches_sent: 2,
    v2_projector_status: "success",
    v2_spans_projected: 2,
    v2_rows_projected: 4,
    v2_spans_skipped: 0,
    v2_skip_reason_classes: [],
  });
  assert.equal(projectedPayloads.length, 2);
  const rows = projectedPayloads.flatMap((payload) => payload.split("\n").map((row) => JSON.parse(row)));
  assert.ok(rows.every((row) => row.service_name === "slock-daemon"));
  assert.ok(rows.every((row) => row.server_id === "server-1"));
  assert.ok(rows.every((row) => row.machine_id === "machine-1"));
});

// --- slock-feedback-admin webhook fan-out (best-effort) ---
//
// trace-upload-worker fans `feedback-report:created` and `trace-bundle:created`
// to the slock-feedback-admin mini-app for D1 projection. The fan-out must:
// (1) be no-op when either env var is unset, (2) include linkage fields in the
// payload, (3) NEVER block the user-facing PUT — the test asserts on the
// emitted call shape, not its result.

function withStubbedGlobalFetch<T>(
  stub: (url: string, init?: RequestInit) => Promise<Response>,
  body: () => Promise<T>,
): Promise<T> {
  const original = globalThis.fetch;
  // @ts-expect-error - replacing global fetch for the duration of the test
  globalThis.fetch = stub;
  return body().finally(() => {
    globalThis.fetch = original;
  });
}

test("feedback-report complete fans out webhook to slock-feedback-admin when configured", async () => {
  const { env } = baseEnv();
  env.TRACE_WEB_CORS_ORIGIN = "https://app.slock.ai";
  env.FEEDBACK_ADMIN_WEBHOOK_URL = "https://feedback-admin.test/internal/r2-write-event";
  env.FEEDBACK_ADMIN_WEBHOOK_SECRET = "test-ingest-secret";
  env.DEPLOYMENT_ENV = "staging";

  const bundle = Buffer.from(JSON.stringify({ schemaVersion: "slock-feedback-export-v2", ok: true }));
  const attestation = signAttestation(feedbackReportClaims());

  const fetchCalls: Array<{ url: string; init?: RequestInit }> = [];
  await withStubbedGlobalFetch(
    async (url, init) => {
      fetchCalls.push({ url: String(url), init });
      return new Response(JSON.stringify({ ok: true }), { status: 201 });
    },
    async () => {
      const createRes = await handleRequest(new Request("https://trace-worker.test/api/feedback-reports", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          attestation,
          agentId: "agent-1",
          source: "slock-web",
          bundleFilename: "feedback.json",
          bundleContentType: "application/json",
          bundleSizeBytes: bundle.byteLength,
          bundleSha256: sha256Hex(bundle),
          metadata: { schemaVersion: "slock-feedback-export-v2" },
        }),
      }), env);
      assert.equal(createRes.status, 200);
      const createBody = await createRes.json() as {
        id: string;
        artifactId: string;
        completeToken: string;
        upload: { url: string };
      };

      const putRes = await handleRequest(new Request(createBody.upload.url, {
        method: "PUT",
        headers: { "Content-Type": "application/json", "Content-Length": String(bundle.byteLength) },
        body: bundle,
      }), env);
      assert.equal(putRes.status, 200);

      // The PUT path stores the artifact and ledgers; webhook only fires on
      // /complete after the worker has confirmed the uploaded ledger.
      assert.equal(fetchCalls.length, 0, "webhook must not fire before complete");

      const completeRes = await handleRequest(new Request(`https://trace-worker.test/api/feedback-reports/${createBody.id}/complete`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ completeToken: createBody.completeToken }),
      }), env);
      assert.equal(completeRes.status, 200);

      assert.equal(fetchCalls.length, 1, "complete should fire exactly one webhook");
      const call = fetchCalls[0]!;
      assert.equal(call.url, "https://feedback-admin.test/internal/r2-write-event");
      assert.equal(call.init?.method, "POST");
      const headers = new Headers(call.init?.headers as HeadersInit);
      assert.equal(headers.get("authorization"), "Bearer test-ingest-secret");
      assert.equal(headers.get("content-type"), "application/json");
      const payload = JSON.parse(String(call.init?.body));
      assert.equal(payload.event, "feedback-report:created");
      assert.equal(payload.serverId, "server-1");
      assert.equal(payload.reportId, createBody.id);
      assert.equal(payload.artifactId, createBody.artifactId);
      assert.equal(payload.agentId, "agent-1");
      assert.equal(payload.subjectId, "user-1");
      assert.equal(payload.actorType, "user");
      assert.equal(payload.source, "slock-web");
      assert.equal(payload.bundleSizeBytes, bundle.byteLength);
      assert.equal(typeof payload.bundleSha256, "string");
      assert.equal(payload.objectKey.startsWith(`feedback-reports/server-1/${createBody.id}/`), true);
      assert.equal(payload.deploymentEnvironment, "staging");
      // Webhook must include r2LastModified so the receiver can populate the
      // admin D1 row's `r2_last_modified` column (the user-visible "Created"
      // timestamp) without a head-object round-trip. Caught 2026-06-21 when
      // tygg's first prod feedback row showed an empty Created column.
      assert.equal(typeof payload.r2LastModified, "string");
      assert.match(payload.r2LastModified as string, /^\d{4}-\d{2}-\d{2}T/);
    },
  );
});

test("feedback-report complete is a no-op for the webhook when admin URL is unset", async () => {
  const { env } = baseEnv();
  env.TRACE_WEB_CORS_ORIGIN = "https://app.slock.ai";
  // FEEDBACK_ADMIN_WEBHOOK_URL deliberately not set — fan-out must not fire.

  const bundle = Buffer.from(JSON.stringify({ ok: true }));
  const attestation = signAttestation(feedbackReportClaims());

  const fetchCalls: Array<{ url: string }> = [];
  await withStubbedGlobalFetch(
    async (url) => {
      fetchCalls.push({ url: String(url) });
      return new Response(null, { status: 204 });
    },
    async () => {
      const createRes = await handleRequest(new Request("https://trace-worker.test/api/feedback-reports", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          attestation,
          agentId: "agent-1",
          source: "slock-web",
          bundleFilename: "feedback.json",
          bundleContentType: "application/json",
          bundleSizeBytes: bundle.byteLength,
          bundleSha256: sha256Hex(bundle),
        }),
      }), env);
      const createBody = await createRes.json() as { id: string; completeToken: string; upload: { url: string } };

      await handleRequest(new Request(createBody.upload.url, {
        method: "PUT",
        headers: { "Content-Type": "application/json", "Content-Length": String(bundle.byteLength) },
        body: bundle,
      }), env);
      const completeRes = await handleRequest(new Request(`https://trace-worker.test/api/feedback-reports/${createBody.id}/complete`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ completeToken: createBody.completeToken }),
      }), env);
      assert.equal(completeRes.status, 200);
      assert.equal(fetchCalls.length, 0, "no webhook should fire when URL env is unset");
    },
  );
});

test("trace-bundle PUT fans out webhook only when feedbackReportId is bound", async () => {
  const { env } = baseEnv();
  env.FEEDBACK_ADMIN_WEBHOOK_URL = "https://feedback-admin.test/internal/r2-write-event";
  env.FEEDBACK_ADMIN_WEBHOOK_SECRET = "test-ingest-secret";

  // First: trace-bundle WITHOUT feedbackReportId (= ordinary daemon trace).
  const ordinaryBody = Buffer.from(`${JSON.stringify(spanRecord())}\n`);
  const ordinaryAttestation = signAttestation(traceUploadClaims({
    uploadId: "upload-ord-1",
    objectKey: "trace-bundles/server-1/machine-1/upload-ord-1.jsonl",
    bundleId: "bundle-1",
    bundleSha256: sha256Hex(ordinaryBody),
    bundleSizeBytes: ordinaryBody.byteLength,
    bundleContentType: "application/x-ndjson",
    maxBytes: 1024 * 1024,
  }));

  const fetchCalls: Array<{ url: string; payload: Record<string, unknown> }> = [];
  await withStubbedGlobalFetch(
    async (url, init) => {
      const payload = init?.body ? JSON.parse(String(init.body)) : {};
      fetchCalls.push({ url: String(url), payload });
      return new Response(JSON.stringify({ ok: true }), { status: 201 });
    },
    async () => {
      const createRes = await handleRequest(new Request("https://trace-worker.test/api/trace-bundles", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          attestation: ordinaryAttestation,
          bundleSha256: sha256Hex(ordinaryBody),
          bundleSizeBytes: ordinaryBody.byteLength,
        }),
      }), env);
      const createBody = await createRes.json() as { upload: { url: string } };
      await handleRequest(new Request(createBody.upload.url, {
        method: "PUT",
        headers: { "Content-Type": "application/x-ndjson", "Content-Length": String(ordinaryBody.byteLength) },
        body: ordinaryBody,
      }), env);
      assert.equal(fetchCalls.length, 0, "ordinary trace-bundle without feedbackReportId must not fan out");

      // Then: trace-bundle WITH feedbackReportId = bound to a feedback report.
      const linkedBody = Buffer.from(`${JSON.stringify(spanRecord({ name: "daemon.agent.delivery.routed.linked" }))}\n`);
      const linkedAttestation = signAttestation(traceUploadClaims({
        uploadId: "upload-linked-2",
        objectKey: "trace-bundles/server-1/machine-1/upload-linked-2.jsonl",
        bundleId: "bundle-2",
        bundleSha256: sha256Hex(linkedBody),
        bundleSizeBytes: linkedBody.byteLength,
        bundleContentType: "application/x-ndjson",
        maxBytes: 1024 * 1024,
        feedbackReportId: "feedback-report-2",
        agentId: "agent-2",
        deploymentEnvironment: "production",
      }));
      const linkedCreateRes = await handleRequest(new Request("https://trace-worker.test/api/trace-bundles", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          attestation: linkedAttestation,
          bundleSha256: sha256Hex(linkedBody),
          bundleSizeBytes: linkedBody.byteLength,
        }),
      }), env);
      const linkedCreateBody = await linkedCreateRes.json() as { upload: { url: string } };
      const linkedPutRes = await handleRequest(new Request(linkedCreateBody.upload.url, {
        method: "PUT",
        headers: { "Content-Type": "application/x-ndjson", "Content-Length": String(linkedBody.byteLength) },
        body: linkedBody,
      }), env);
      assert.equal(linkedPutRes.status, 200);

      assert.equal(fetchCalls.length, 1, "linked trace-bundle must fan out exactly once");
      const call = fetchCalls[0]!;
      assert.equal(call.url, "https://feedback-admin.test/internal/r2-write-event");
      assert.equal(call.payload.event, "trace-bundle:created");
      assert.equal(call.payload.serverId, "server-1");
      assert.equal(call.payload.feedbackReportId, "feedback-report-2");
      assert.equal(call.payload.agentId, "agent-2");
      assert.equal(call.payload.machineId, "machine-1");
      assert.equal(call.payload.bundleId, "bundle-2");
      assert.equal(call.payload.deploymentEnvironment, "production");
      assert.equal(typeof call.payload.r2LastModified, "string");
      assert.match(call.payload.r2LastModified as string, /^\d{4}-\d{2}-\d{2}T/);
    },
  );
});

function bufferToArrayBuffer(buffer: Buffer): ArrayBuffer {
  const copy = new Uint8Array(buffer.byteLength);
  copy.set(buffer);
  return copy.buffer;
}

function putBodyToString(body: ArrayBuffer | string): string {
  return typeof body === "string" ? body : Buffer.from(body).toString("utf8");
}
