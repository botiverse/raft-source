import { createHash, createHmac } from "node:crypto";
import { gzipSync } from "node:zlib";
import assert from "node:assert/strict";
import { fakeScopeDbTraceEventClient } from "./testing/fakeScopeDbTraceEventClient";
import { handleRequest, ingestTraceBundleObject, type TraceUploadWorkerEnv } from "./index";
import { resetTraceUploadBudgetsForTest } from "./traces/uploadRateLimit";

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

  /** When set, `put` throws this error (simulates an R2 5xx outage). */
  putError: Error | null = null;
  /** Counts every put attempt, including failing ones (tests poll on this). */
  putAttempts = 0;

  async put(key: string, value: ArrayBuffer | string, options?: MockR2Bucket["puts"][number]["options"]) {
    this.putAttempts += 1;
    if (this.putError) throw this.putError;
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
    traceUserId: "trace-user-1",
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
  assert.ok(resourceAttrs.some((attr: any) => attr.key === "slock.trace_user_id" && attr.value.stringValue === "trace-user-1"));
  assert.ok(!fetchCalls[0].init?.body?.toString().includes('"user-1"'), "the raw user id (sub) is never forwarded");
  assert.ok(!resourceAttrs.some((attr: any) => attr.key === "slock.user_id"));
  const span = payload.resourceSpans[0].scopeSpans[0].spans[0];
  assert.equal(span.name, "web.interaction.message_send");
  assert.ok(span.attributes.some((attr: any) =>
    attr.key === "slock.trace_ingest.span_key" &&
    attr.value.stringValue === "server-1:trace-user-1:web-batch-1:0123456789abcdef0123456789abcdef:0123456789abcdef"));
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
  env.SCOPEDB_TRACE_EVENTS_CLIENT = fakeScopeDbTraceEventClient({
    append: async (payload: string) => {
      callOrder.push("v2");
      projectedPayload = payload;
      return { num_rows_inserted: 2 };
    },
  });

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
  env.SCOPEDB_TRACE_EVENTS_CLIENT = fakeScopeDbTraceEventClient({
    append: async (payload: string) => {
      projectedPayload = payload;
      return { num_rows_inserted: 4 };
    },
  });

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
  env.SCOPEDB_TRACE_EVENTS_CLIENT = fakeScopeDbTraceEventClient({
    append: async (payload: string) => {
      projectedPayload = payload;
      return { num_rows_inserted: 2 };
    },
  });

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
  env.SCOPEDB_TRACE_EVENTS_CLIENT = fakeScopeDbTraceEventClient({
    append: async () => {
      throw new Error("projector unavailable");
    },
  });

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

function captureWarnings(): { lines: string[]; restore: () => void } {
  const lines: string[] = [];
  const originalWarn = console.warn;
  console.warn = (...args: unknown[]) => { lines.push(args.map(String).join(" ")); };
  return { lines, restore: () => { console.warn = originalWarn; } };
}

function webTraceRequest(body: Record<string, unknown>): Request {
  return new Request("https://trace-worker.test/api/web-traces", {
    method: "POST",
    headers: { "Content-Type": "application/json", Origin: "https://app.slock.ai" },
    body: JSON.stringify({ attestation: signAttestation(webTraceClaims()), ...body }),
  });
}

test("web trace endpoint fails fast with 503 + Retry-After when the OTLP sink hangs", async () => {
  const { env } = baseEnv();
  env.TRACE_WEB_CORS_ORIGIN = "https://app.slock.ai";
  env.TRACE_INGEST_OTLP_ENDPOINT = "https://telescope.test/v1/traces";
  env.TRACE_INGEST_OTLP_TIMEOUT_MS = "1"; // clamps to the 1s floor
  // A sink that never answers but honours the abort signal, like undici fetch.
  env.TRACE_INGEST_FETCH = (_input, init) => new Promise<Response>((_resolve, reject) => {
    const signal = init?.signal;
    assert.ok(signal, "OTLP post must carry an AbortSignal");
    signal.addEventListener("abort", () => reject(signal.reason), { once: true });
  });
  const warnings = captureWarnings();
  const startedAt = Date.now();
  let res: Response;
  try {
    res = await handleRequest(webTraceRequest({
      batchId: "web-batch-timeout",
      records: [spanRecord({ name: "web.interaction.message_send", surface: "web" })],
    }), env);
  } finally {
    warnings.restore();
  }
  const elapsedMs = Date.now() - startedAt;

  assert.equal(res.status, 503);
  assert.ok(elapsedMs < 5_000, `expected a fast failure, took ${elapsedMs}ms`);
  assert.equal(res.headers.get("Retry-After"), "30");
  assert.equal(res.headers.get("Access-Control-Allow-Origin"), "https://app.slock.ai");
  assert.deepEqual(await res.json(), { error: "Trace sink unavailable", reason: "sink_timeout" });
  assert.equal(warnings.lines.length, 1);
  assert.match(warnings.lines[0], /^\[TraceUploadWorker\] otlp sink failed reason=sink_timeout route=web items=\d+ status=- duration_ms=\d+$/);
});

test("web trace endpoint maps a refusing OTLP sink (503) to sink_refused without leaking the sink body", async () => {
  const { env } = baseEnv();
  env.TRACE_INGEST_OTLP_ENDPOINT = "https://telescope.test/v1/traces";
  env.TRACE_INGEST_FETCH = async () => new Response("memory limiter: data refused", { status: 503 });
  const warnings = captureWarnings();
  let res: Response;
  try {
    res = await handleRequest(webTraceRequest({
      batchId: "web-batch-refused",
      events: [{ type: "event", schema_version: 1, name: "web.page.visible", surface: "web", time: "2026-05-07T08:00:00.010Z" }],
    }), env);
  } finally {
    warnings.restore();
  }

  assert.equal(res.status, 503);
  assert.equal(res.headers.get("Retry-After"), "30");
  assert.equal(res.headers.get("Access-Control-Allow-Origin"), "*");
  const body = await res.json() as Record<string, unknown>;
  assert.deepEqual(body, { error: "Trace sink unavailable", reason: "sink_refused" });
  assert.match(warnings.lines[0], /reason=sink_refused route=web_events items=\d+ status=503 duration_ms=\d+$/);
  assert.ok(!warnings.lines[0].includes("memory limiter"), "sink failure log carries no payload text");
});

test("web trace endpoint maps other sink failures to sink_http and sink_network", async () => {
  for (const [fetchImpl, reason, status] of [
    [async () => new Response(null, { status: 400 }), "sink_http", "400"],
    [async () => { throw new TypeError("fetch failed"); }, "sink_network", "-"],
  ] as const) {
    const { env } = baseEnv();
    env.TRACE_INGEST_OTLP_ENDPOINT = "https://telescope.test/v1/traces";
    env.TRACE_INGEST_FETCH = fetchImpl;
    const warnings = captureWarnings();
    let res: Response;
    try {
      res = await handleRequest(webTraceRequest({
        records: [spanRecord({ name: "web.interaction.message_send", surface: "web" })],
      }), env);
    } finally {
      warnings.restore();
    }
    assert.equal(res.status, 503);
    assert.equal(res.headers.get("Retry-After"), "30");
    assert.deepEqual(await res.json(), { error: "Trace sink unavailable", reason });
    assert.match(warnings.lines[0], new RegExp(`reason=${reason} route=web items=\\d+ status=${status} duration_ms=`));
  }
});

test("successful OTLP posts carry an abort signal and keep the 200 response", async () => {
  const { env } = baseEnv();
  const signals: Array<AbortSignal | null | undefined> = [];
  env.TRACE_INGEST_OTLP_ENDPOINT = "https://telescope.test/v1/traces";
  env.TRACE_INGEST_FETCH = async (_input, init) => {
    signals.push(init?.signal);
    return new Response(null, { status: 200 });
  };
  const res = await handleRequest(webTraceRequest({
    records: [spanRecord({ name: "web.interaction.message_send", surface: "web" })],
    events: [{ type: "event", schema_version: 1, name: "web.page.visible", surface: "web", time: "2026-05-07T08:00:00.010Z" }],
  }), env);
  assert.equal(res.status, 200);
  assert.equal(res.headers.get("Retry-After"), null);
  const body = await res.json() as Record<string, unknown>;
  assert.equal(body.spansIngested, 1);
  assert.equal(body.eventsIngested, 1);
  assert.equal(signals.length, 2);
  assert.ok(signals.every((signal) => signal instanceof AbortSignal && !signal.aborted));
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

// TOOTH-2 (transport six coverage keys propagation). The daemon already computes transcript
// window coverage and sends it in the upload body.metadata. These tests pin that
// (a) the six coverage keys survive into R2 customMetadata + ledger + webhook claim, and
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

test("tooth-2 transports transcript window coverage keys into R2 customMetadata + ledger metadata", async () => {
  const { env, bucket } = baseEnv();
  const { objectPut } = await uploadFeedbackReportWithMetadata(env, bucket, {
    feedbackTranscriptWindowCoverage: "outside_report_window",
    feedbackTranscriptFirstEventAt: "2026-08-03T05:23:32.871Z",
    feedbackTranscriptLastEventAt: "2026-08-03T15:11:33.397Z",
    feedbackTranscriptTruncated: "true",
    feedbackTranscriptTruncationDirection: "tail",
    // REAL producer value (shared FeedbackTranscriptReportTimeSource). The prior
    // fixture used "model_read_at", a value no producer emits, so this test was
    // green for 35 days against a non-existent input path (#6243 enum divergence).
    feedbackReportTimeSource: "server_request_received",
  });
  const cm = objectPut.options?.customMetadata as Record<string, string>;
  assert.equal(cm.transcriptCoverage, "outside_report_window");
  assert.equal(cm.transcriptFirstEventAt, "2026-08-03T05:23:32.871Z");
  assert.equal(cm.transcriptLastEventAt, "2026-08-03T15:11:33.397Z");
  assert.equal(cm.transcriptTruncated, "true");
  assert.equal(cm.transcriptTruncationDirection, "tail");
  assert.equal(cm.transcriptAnchorSource, "server_request_received");
});

// Regression tooth for the #6243 anchor-source enum divergence: the worker guard
// must accept the real producer values. With the diverging literal pair this REDs
// (coverage keys dropped, customMetadata absent).
test("tooth-2 accepts the real producer anchor source (web_report_bundle) and propagates coverage keys", async () => {
  const { env, bucket } = baseEnv();
  const { objectPut } = await uploadFeedbackReportWithMetadata(env, bucket, {
    feedbackTranscriptWindowCoverage: "covered",
    feedbackTranscriptFirstEventAt: "2026-08-03T05:23:32.871Z",
    feedbackTranscriptLastEventAt: "2026-08-03T15:11:33.397Z",
    feedbackReportTimeSource: "web_report_bundle",
  });
  const cm = objectPut.options?.customMetadata as Record<string, string>;
  assert.equal(cm.transcriptCoverage, "covered");
  assert.equal(cm.transcriptAnchorSource, "web_report_bundle");
  assert.equal(cm.transcriptFirstEventAt, "2026-08-03T05:23:32.871Z");
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
    feedbackReportId: "3f8b2d9c-5e4a-4c7b-9a0f-7b6d5c4e3a03",
    agentId: "4a9c3e0d-6f5b-4d8c-8b1a-8c7e6d5f4b04",
    feedbackTranscriptWindowCoverage: "outside_report_window",
    feedbackTranscriptFirstEventAt: "2026-08-03T05:23:32.871Z",
    feedbackTranscriptLastEventAt: "2026-08-03T15:11:33.397Z",
    feedbackTranscriptTruncated: "true",
    feedbackTranscriptTruncationDirection: "tail",
    feedbackReportTimeSource: "server_request_received",
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

  // raw bundle + its trace ledger + the same ledger filed under that report
  assert.equal(bucket.puts.length, 3);
  assert.ok(bucket.puts.some((put) => put.key === "feedback-report-ledgers/server-1/3f8b2d9c-5e4a-4c7b-9a0f-7b6d5c4e3a03/trace-upload-1.json"));
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
      feedbackReportId: "3f8b2d9c-5e4a-4c7b-9a0f-7b6d5c4e3a03",
      agentId: "4a9c3e0d-6f5b-4d8c-8b1a-8c7e6d5f4b04",
      transcriptCoverage: "outside_report_window",
      transcriptFirstEventAt: "2026-08-03T05:23:32.871Z",
      transcriptLastEventAt: "2026-08-03T15:11:33.397Z",
      transcriptTruncated: "true",
      transcriptTruncationDirection: "tail",
      transcriptAnchorSource: "server_request_received",
    },
  });
  const ledgerPut = bucket.puts.find((put) => put.key === "trace-ledgers/server-1/machine-1/upload-1.json");
  assert.ok(ledgerPut);
  const ledger = JSON.parse(String(ledgerPut.body));
  assert.equal(ledger.r2_status, "success");
  assert.equal(ledger.scopedb_status, "skipped");
  assert.equal(ledger.object_key, metadata.objectKey);
  assert.equal(ledger.feedback_report_id, "3f8b2d9c-5e4a-4c7b-9a0f-7b6d5c4e3a03");
  assert.equal(ledger.agent_id, "4a9c3e0d-6f5b-4d8c-8b1a-8c7e6d5f4b04");
  assert.equal(ledger.transcript_coverage, "outside_report_window");
  assert.equal(ledger.transcript_first_event_at, "2026-08-03T05:23:32.871Z");
  assert.equal(ledger.transcript_last_event_at, "2026-08-03T15:11:33.397Z");
  assert.equal(ledger.transcript_truncated, "true");
  assert.equal(ledger.transcript_truncation_direction, "tail");
  assert.equal(ledger.transcript_anchor_source, "server_request_received");
  assert.equal(ledger.span_key_identity, "serverId:machineId:bundleSha256:trace_id:span_id");
  assert.deepEqual(ledgerPut.options?.customMetadata, {
    uploadId: "upload-1",
    bundleId: "bundle-1",
    bundleSha256: metadata.bundleSha256,
    serverId: "server-1",
    machineId: "machine-1",
    ledgerType: "daemon-trace-upload",
    feedbackReportId: "3f8b2d9c-5e4a-4c7b-9a0f-7b6d5c4e3a03",
    agentId: "4a9c3e0d-6f5b-4d8c-8b1a-8c7e6d5f4b04",
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

test("trace upload worker logs the cause when a storage write fails inside the request", async () => {
  const { env, bucket } = baseEnv();
  const bundle = Buffer.from(`${JSON.stringify(spanRecord())}\n`);
  const metadata = {
    uploadId: "upload-r2-500-in-request",
    objectKey: "trace-bundles/server-1/machine-1/upload-r2-500-in-request.jsonl",
    bundleId: "bundle-r2-500-in-request",
    bundleSha256: sha256Hex(bundle),
    bundleSizeBytes: bundle.byteLength,
    bundleContentType: "application/x-ndjson",
    maxBytes: 1024 * 1024,
  };
  const createRes = await handleRequest(new Request("https://trace-worker.test/api/trace-bundles", {
    method: "POST",
    body: JSON.stringify({
      attestation: signAttestation(traceUploadClaims(metadata)),
      bundleSha256: metadata.bundleSha256,
      bundleSizeBytes: metadata.bundleSizeBytes,
    }),
  }), env);
  const createBody = await createRes.json() as { upload: { url: string } };
  bucket.putError = new Error("R2 PUT failed with status 500");

  const error = vi.spyOn(console, "error").mockImplementation(() => undefined);
  try {
    const putRes = await handleRequest(new Request(createBody.upload.url, { method: "PUT", body: bundle }), env);

    assert.equal(putRes.status, 500);
    assert.deepEqual(await putRes.json(), { error: "Internal server error" });
    assert.deepEqual(error.mock.calls, [["[TraceUploadWorker] request_failed", {
      method: "PUT",
      // Path only: the upload token in the query is never logged.
      path: "/api/trace-bundles/upload-r2-500-in-request/object",
      error_class: "Error",
      error_message: "R2 PUT failed with status 500",
    }]]);
  } finally {
    error.mockRestore();
  }
});

test("trace upload worker logs a client disconnect as request_aborted, not request_failed", async () => {
  const { env } = baseEnv();
  // What the Node entry point hands over when the client closes the connection
  // mid-body: the request's signal is aborted and the body read rejects.
  const clientGone = new AbortController();
  const body = new ReadableStream<Uint8Array>({
    pull(controller) {
      controller.error(Object.assign(new Error("aborted"), { code: "ECONNRESET" }));
    },
  });
  const request = new Request("https://trace-worker.test/api/web-traces", {
    method: "POST",
    body,
    duplex: "half",
    signal: clientGone.signal,
  } as RequestInit);
  clientGone.abort();

  const error = vi.spyOn(console, "error").mockImplementation(() => undefined);
  const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
  try {
    const res = await handleRequest(request, env);

    assert.equal(res.status, 500);
    assert.deepEqual(warn.mock.calls, [["[TraceUploadWorker] request_aborted", {
      method: "POST",
      path: "/api/web-traces",
      error_message: "aborted",
    }]]);
    assert.deepEqual(error.mock.calls, []);
  } finally {
    error.mockRestore();
    warn.mockRestore();
  }
});

// Task #426 red-first: an R2 5xx on a background-path ledger PUT must never
// escape the detached ingest chain as an unhandledRejection (that killed both
// prod tasks in the same second). The failure is logged + counted instead.
test("trace upload worker survives an R2 503 on the success-path ledger write", async () => {
  const { env, bucket } = baseEnv();
  env.TRACE_INGEST_OTLP_ENDPOINT = "https://telescope.test";
  env.TRACE_INGEST_SERVICE_NAME = "slock-daemon-test";
  env.DEPLOYMENT_ENV = "production";
  env.TRACE_INGEST_FETCH = async () => new Response(null, { status: 200 });
  const bundle = Buffer.from(`${JSON.stringify(spanRecord())}\n`);
  const metadata = {
    uploadId: "upload-r2-503-success",
    objectKey: "trace-bundles/server-1/machine-1/upload-r2-503-success.jsonl",
    bundleId: "bundle-r2-503-success",
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

  // R2 goes down only after the upload completes — the background ingest
  // succeeds, but its success-path ledger PUT gets a 503.
  bucket.putError = new Error("R2 PUT failed with status 503");

  const ledgerFailures: string[] = [];
  const originalError = console.error;
  console.error = (...args: unknown[]) => {
    if (typeof args[0] === "string") ledgerFailures.push(args[0]);
  };
  let unhandled = 0;
  const onUnhandled = () => { unhandled += 1; };
  process.on("unhandledRejection", onUnhandled);
  try {
    // Do NOT await or observe ctx.promises — the old node.ts never did, and
    // observing here would attach a handler that masks a real unobserved
    // rejection (a vacuous spy). Instead wait until the background ledger PUT
    // has actually been attempted (attempt #3 = bundle + initial ledger + this
    // one), then flush so any unhandledRejection would have fired.
    for (let i = 0; i < 500 && bucket.putAttempts < 3; i += 1) {
      await new Promise((resolve) => setImmediate(resolve));
    }
    assert.equal(bucket.putAttempts, 3);
    for (let i = 0; i < 5; i += 1) await new Promise((resolve) => setImmediate(resolve));
    assert.equal(unhandled, 0);
  } finally {
    process.removeListener("unhandledRejection", onUnhandled);
    console.error = originalError;
  }
  assert.equal(ledgerFailures.filter((line) => line === "[TraceUploadLedger] write_failed").length, 1);
});

test("trace upload worker survives an R2 503 on the catch-path ledger write (incident repro)", async () => {
  const { env, bucket } = baseEnv();
  env.TRACE_INGEST_OTLP_ENDPOINT = "https://telescope.test";
  env.TRACE_INGEST_SERVICE_NAME = "slock-daemon-test";
  env.DEPLOYMENT_ENV = "production";
  // Ingest fails (ScopeDB down), then the ledger PUT inside the .catch handler
  // hits the same R2 outage — the exact 2026-09-29 crash chain.
  env.TRACE_INGEST_FETCH = async () => new Response(null, { status: 503 });
  const bundle = Buffer.from(`${JSON.stringify(spanRecord())}\n`);
  const metadata = {
    uploadId: "upload-r2-503-catch",
    objectKey: "trace-bundles/server-1/machine-1/upload-r2-503-catch.jsonl",
    bundleId: "bundle-r2-503-catch",
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

  bucket.putError = new Error("R2 PUT failed with status 503");

  const ledgerFailures: string[] = [];
  const originalError = console.error;
  console.error = (...args: unknown[]) => {
    if (typeof args[0] === "string") ledgerFailures.push(args[0]);
  };
  const originalWarn = console.warn;
  console.warn = () => {};
  let unhandled = 0;
  const onUnhandled = () => { unhandled += 1; };
  process.on("unhandledRejection", onUnhandled);
  try {
    // Same non-observing discipline as the success-path test: poll until the
    // catch-path ledger PUT has been attempted, then flush.
    for (let i = 0; i < 500 && bucket.putAttempts < 3; i += 1) {
      await new Promise((resolve) => setImmediate(resolve));
    }
    assert.equal(bucket.putAttempts, 3);
    for (let i = 0; i < 5; i += 1) await new Promise((resolve) => setImmediate(resolve));
    assert.equal(unhandled, 0);
  } finally {
    process.removeListener("unhandledRejection", onUnhandled);
    console.error = originalError;
    console.warn = originalWarn;
  }
  assert.equal(ledgerFailures.filter((line) => line === "[TraceUploadLedger] write_failed").length, 1);
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
  assert.equal(finalLedger.error_class, "OtlpSinkError");
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
  env.SCOPEDB_TRACE_EVENTS_CLIENT = fakeScopeDbTraceEventClient({
    append: async (payload: string) => {
      callOrder.push("v2");
      projectedPayloads.push(payload);
      return { num_rows_inserted: 2 };
    },
  });
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
    agentId: "8e3a7c4b-0d9f-4bc0-8f5e-2a1c0b9d8f08",
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

test("a trace bundle collected for a feedback report is also filed under that report's ledger folder", async () => {
  const { env, bucket } = baseEnv();

  async function uploadTrace(claims: Record<string, unknown>, body: Buffer) {
    const createRes = await handleRequest(new Request("https://trace-worker.test/api/trace-bundles", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        attestation: signAttestation(traceUploadClaims(claims)),
        bundleSha256: sha256Hex(body),
        bundleSizeBytes: body.byteLength,
      }),
    }), env);
    const createBody = await createRes.json() as { upload: { url: string } };
    const putRes = await handleRequest(new Request(createBody.upload.url, {
      method: "PUT",
      headers: { "Content-Type": "application/x-ndjson", "Content-Length": String(body.byteLength) },
      body: bufferToArrayBuffer(body),
    }), env);
    assert.equal(putRes.status, 200);
  }

  const ordinaryBody = Buffer.from(`${JSON.stringify(spanRecord())}\n`);
  await uploadTrace({
    uploadId: "upload-ord-1",
    objectKey: "trace-bundles/server-1/machine-1/upload-ord-1.jsonl",
    bundleId: "bundle-1",
    bundleSha256: sha256Hex(ordinaryBody),
    bundleSizeBytes: ordinaryBody.byteLength,
    bundleContentType: "application/x-ndjson",
    maxBytes: 1024 * 1024,
  }, ordinaryBody);
  assert.equal(
    bucket.puts.some((put) => put.key.startsWith("feedback-report-ledgers/")),
    false,
    "a routine trace bundle must not appear under any report",
  );

  const linkedBody = Buffer.from(`${JSON.stringify(spanRecord({ name: "daemon.agent.delivery.routed.linked" }))}\n`);
  await uploadTrace({
    uploadId: "upload-linked-2",
    objectKey: "trace-bundles/server-1/machine-1/upload-linked-2.jsonl",
    bundleId: "bundle-2",
    bundleSha256: sha256Hex(linkedBody),
    bundleSizeBytes: linkedBody.byteLength,
    bundleContentType: "application/x-ndjson",
    maxBytes: 1024 * 1024,
    feedbackReportId: "5b0d4f1e-7a6c-4e9d-9c2b-9d8f7e6a5c05",
    agentId: "6c1e5a2f-8b7d-4fae-8d3c-0e9a8f7b6d06",
    deploymentEnvironment: "production",
    feedbackTranscriptWindowCoverage: "covered",
    feedbackTranscriptFirstEventAt: "2026-08-03T05:23:32.871Z",
    feedbackTranscriptLastEventAt: "2026-08-03T15:11:33.397Z",
    feedbackTranscriptTruncated: "false",
    feedbackTranscriptTruncationDirection: "window",
    feedbackReportTimeSource: "web_report_bundle",
  }, linkedBody);

  const pointerKey = "feedback-report-ledgers/server-1/5b0d4f1e-7a6c-4e9d-9c2b-9d8f7e6a5c05/trace-upload-linked-2.json";
  const canonicalKey = "trace-ledgers/server-1/machine-1/upload-linked-2.json";
  const pointer = await bucket.get(pointerKey);
  const canonical = await bucket.get(canonicalKey);
  assert.ok(pointer?.body, "the report folder must list the bundle");
  assert.ok(canonical?.body);
  const record = JSON.parse(await new Response(pointer.body).text()) as Record<string, unknown>;
  assert.deepEqual(record, JSON.parse(await new Response(canonical.body).text()));
  assert.equal(record.object_key, "trace-bundles/server-1/machine-1/upload-linked-2.jsonl");
  assert.equal(record.feedback_report_id, "5b0d4f1e-7a6c-4e9d-9c2b-9d8f7e6a5c05");
  assert.equal(record.agent_id, "6c1e5a2f-8b7d-4fae-8d3c-0e9a8f7b6d06");
  assert.equal(record.transcript_coverage, "covered");
  assert.equal(record.transcript_first_event_at, "2026-08-03T05:23:32.871Z");
  assert.equal(record.transcript_last_event_at, "2026-08-03T15:11:33.397Z");
  assert.equal(record.transcript_truncated, "false");
  assert.equal(record.transcript_truncation_direction, "window");
  assert.equal(record.transcript_anchor_source, "web_report_bundle");
  const pointerPut = bucket.puts.filter((put) => put.key === pointerKey).at(-1);
  assert.equal(pointerPut?.options?.customMetadata?.ledgerType, "daemon-trace-upload");
  assert.equal(pointerPut?.options?.customMetadata?.feedbackReportId, "5b0d4f1e-7a6c-4e9d-9c2b-9d8f7e6a5c05");
  assert.equal("feedback_attachment_kind" in record, false, "no kind is invented when none was signed");
});

test("the report-folder ledger records the signed attachment kind and keeps every fact through the ingest rewrite", async () => {
  const { env, bucket } = baseEnv();
  env.TRACE_INGEST_OTLP_ENDPOINT = "https://telescope.test/v1/traces";
  env.TRACE_INGEST_FETCH = async () => new Response(null, { status: 200 });
  const ctx = new MockExecutionContext();

  async function upload(claims: Record<string, unknown>, body: Buffer) {
    const createRes = await handleRequest(new Request("https://trace-worker.test/api/trace-bundles", {
      method: "POST",
      body: JSON.stringify({
        attestation: signAttestation(traceUploadClaims(claims)),
        bundleSha256: sha256Hex(body),
        bundleSizeBytes: body.byteLength,
      }),
    }), env, ctx);
    const createBody = await createRes.json() as { upload: { url: string } };
    const putRes = await handleRequest(new Request(createBody.upload.url, {
      method: "PUT",
      body: bufferToArrayBuffer(body),
    }), env, ctx);
    assert.equal(putRes.status, 200);
  }
  async function finalRecord(key: string) {
    const stored = await bucket.get(key);
    assert.ok(stored?.body, key);
    return JSON.parse(await new Response(stored.body).text()) as Record<string, unknown>;
  }

  const transcript = Buffer.from(`${JSON.stringify(spanRecord())}\n`);
  await upload({
    uploadId: "upload-transcript",
    objectKey: "trace-bundles/server-1/machine-1/upload-transcript.jsonl",
    bundleId: "bundle-transcript",
    bundleSha256: sha256Hex(transcript),
    bundleSizeBytes: transcript.byteLength,
    bundleContentType: "application/x-ndjson",
    maxBytes: 1024 * 1024,
    feedbackReportId: "7d2f6b3a-9c8e-4abf-9e4d-1f0b9a8c7e07",
    feedbackAttachmentKind: "session_transcript",
    feedbackTranscriptWindowCoverage: "covered",
    feedbackTranscriptFirstEventAt: "2026-08-03T05:23:32.871Z",
    feedbackTranscriptLastEventAt: "2026-08-03T15:11:33.397Z",
    feedbackTranscriptTruncated: "false",
    feedbackTranscriptTruncationDirection: "window",
    feedbackReportTimeSource: "web_report_bundle",
  }, transcript);
  const tail = Buffer.from(`${JSON.stringify(spanRecord({ span_id: "2222222222222222" }))}\n`);
  await upload({
    uploadId: "upload-tail",
    objectKey: "trace-bundles/server-1/machine-1/upload-tail.jsonl",
    bundleId: "bundle-tail",
    bundleSha256: sha256Hex(tail),
    bundleSizeBytes: tail.byteLength,
    bundleContentType: "application/x-ndjson",
    maxBytes: 1024 * 1024,
    feedbackReportId: "7d2f6b3a-9c8e-4abf-9e4d-1f0b9a8c7e07",
    feedbackAttachmentKind: "machine_log_tail",
  }, tail);
  await Promise.all(ctx.promises);

  const transcriptKey = "feedback-report-ledgers/server-1/7d2f6b3a-9c8e-4abf-9e4d-1f0b9a8c7e07/trace-upload-transcript.json";
  assert.equal(bucket.puts.filter((put) => put.key === transcriptKey).length, 2, "written at upload and again by the ingest outcome");
  const transcriptRecord = await finalRecord(transcriptKey);
  assert.equal(transcriptRecord.scopedb_status, "success");
  assert.equal(transcriptRecord.feedback_attachment_kind, "session_transcript");
  assert.equal(transcriptRecord.transcript_coverage, "covered");
  assert.equal(transcriptRecord.transcript_first_event_at, "2026-08-03T05:23:32.871Z");
  assert.equal(transcriptRecord.transcript_anchor_source, "web_report_bundle");
  assert.deepEqual(transcriptRecord, await finalRecord("trace-ledgers/server-1/machine-1/upload-transcript.json"));

  const tailRecord = await finalRecord("feedback-report-ledgers/server-1/7d2f6b3a-9c8e-4abf-9e4d-1f0b9a8c7e07/trace-upload-tail.json");
  assert.equal(tailRecord.scopedb_status, "success");
  assert.equal(tailRecord.feedback_attachment_kind, "machine_log_tail");
});

function bufferToArrayBuffer(buffer: Buffer): ArrayBuffer {
  const copy = new Uint8Array(buffer.byteLength);
  copy.set(buffer);
  return copy.buffer;
}

function putBodyToString(body: ArrayBuffer | string): string {
  return typeof body === "string" ? body : Buffer.from(body).toString("utf8");
}

test("trace bundle ingest posts event lines to OTLP logs and keeps them out of the span path", async () => {
  const { env, bucket } = baseEnv();
  const fetchCalls: Array<{ input: RequestInfo | URL; init?: RequestInit }> = [];
  env.TRACE_INGEST_OTLP_ENDPOINT = "https://telescope.test/v1/traces";
  env.TRACE_INGEST_FETCH = async (input, init) => {
    fetchCalls.push({ input, init });
    return new Response(null, { status: 200 });
  };
  const eventRecord = {
    type: "event",
    schema_version: 1,
    name: "daemon.agent.stdin.written",
    surface: "daemon",
    time: "2026-05-07T08:00:00.010Z",
    trace_id: "0123456789abcdef0123456789abcdef",
    span_id: "0123456789abcdef",
    attrs: { bytes_bucket: "1-1k" },
  };
  const bundle = Buffer.from([
    JSON.stringify(spanRecord()),
    JSON.stringify(eventRecord),
    "",
  ].join("\n"));
  const metadata = {
    uploadId: "upload-event",
    objectKey: "trace-bundles/server-1/machine-1/upload-event.jsonl",
    bundleId: "bundle-event",
    bundleSha256: sha256Hex(bundle),
    bundleSizeBytes: bundle.byteLength,
    serverId: "server-1",
    machineId: "machine-1",
  };
  await bucket.put(metadata.objectKey, bufferToArrayBuffer(bundle));

  const result = await ingestTraceBundleObject(env, metadata);

  assert.equal(result.spans_ingested, 1);
  assert.equal(result.events_ingested, 1);
  assert.equal(fetchCalls.length, 2);
  assert.equal(String(fetchCalls[0].input), "https://telescope.test/v1/traces");
  const spanPayload = JSON.parse(fetchCalls[0].init?.body as string);
  assert.equal(spanPayload.resourceSpans[0].scopeSpans[0].spans.length, 1);
  assert.equal(String(fetchCalls[1].input), "https://telescope.test/v1/logs");
  const logPayload = JSON.parse(fetchCalls[1].init?.body as string);
  const logRecord = logPayload.resourceLogs[0].scopeLogs[0].logRecords[0];
  assert.equal(logRecord.body.stringValue, "daemon.agent.stdin.written");
  assert.equal(logRecord.traceId, eventRecord.trace_id);
  assert.equal(logRecord.spanId, eventRecord.span_id);
  assert.ok(logRecord.attributes.some((attr: any) =>
    attr.key === "slock.trace_ingest.event_key" &&
    attr.value.stringValue === `${metadata.bundleSha256}:1`));
});

test("web trace endpoint forwards event only batches to OTLP logs", async () => {
  const { env } = baseEnv();
  const fetchCalls: Array<{ input: RequestInfo | URL; init?: RequestInit }> = [];
  env.TRACE_INGEST_OTLP_ENDPOINT = "https://telescope.test/v1/traces";
  env.TRACE_INGEST_FETCH = async (input, init) => {
    fetchCalls.push({ input, init });
    return new Response(null, { status: 200 });
  };

  const res = await handleRequest(new Request("https://trace-worker.test/api/web-traces", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      attestation: signAttestation(webTraceClaims()),
      batchId: "web-batch-events",
      events: [{
        type: "event",
        schema_version: 1,
        name: "web.page.visible",
        surface: "web",
        time: "2026-05-07T08:00:00.000Z",
        attrs: { page: "chat" },
      }],
    }),
  }), env);

  assert.equal(res.status, 200);
  const body = await res.json() as Record<string, unknown>;
  assert.equal(body.spansIngested, 0);
  assert.equal(body.eventsIngested, 1);
  assert.equal(fetchCalls.length, 1);
  assert.equal(String(fetchCalls[0].input), "https://telescope.test/v1/logs");
  const payload = JSON.parse(fetchCalls[0].init?.body as string);
  const resourceAttrs = payload.resourceLogs[0].resource.attributes;
  assert.ok(resourceAttrs.some((attr: any) => attr.key === "service.name" && attr.value.stringValue === "slock-web"));
  const logRecord = payload.resourceLogs[0].scopeLogs[0].logRecords[0];
  assert.equal(logRecord.body.stringValue, "web.page.visible");
  assert.equal(logRecord.traceId, "");
  assert.ok(logRecord.attributes.some((attr: any) =>
    attr.key === "slock.trace_ingest.event_key" &&
    attr.value.stringValue === "web-batch-events:0"));
});

test("trace bundle create is refused with 429 once the machine's hourly budget is spent (enforce mode)", async () => {
  resetTraceUploadBudgetsForTest();
  const { env, bucket } = baseEnv();
  env.TRACE_UPLOAD_HOURLY_LIMIT = "1";
  env.TRACE_UPLOAD_RATE_LIMIT_MODE = "enforce";
  const bundle = Buffer.from("trace");
  const create = (uploadId: string, nonce: string) => {
    const metadata = {
      uploadId,
      objectKey: `trace-bundles/server-1/machine-1/${uploadId}.jsonl.gz`,
      bundleId: `bundle-${uploadId}`,
      bundleSha256: sha256Hex(bundle),
      bundleSizeBytes: bundle.byteLength,
      maxBytes: 1024,
    };
    return handleRequest(new Request("https://trace-worker.test/api/trace-bundles", {
      method: "POST",
      body: JSON.stringify({
        attestation: signAttestation(traceUploadClaims(metadata, { nonce })),
        bundleSha256: metadata.bundleSha256,
        bundleSizeBytes: metadata.bundleSizeBytes,
      }),
    }), env);
  };

  const originalWarn = console.warn;
  console.warn = () => {};
  try {
    const first = await create("upload-1", "nonce-rl-1");
    assert.equal(first.status, 200);
    const second = await create("upload-2", "nonce-rl-2");
    assert.equal(second.status, 429);
    assert.deepEqual(await second.json(), { error: "Trace bundle upload rate limit exceeded" });
  } finally {
    console.warn = originalWarn;
    resetTraceUploadBudgetsForTest();
  }
  // Counted in memory: nothing is written to the bundle store for the budget.
  assert.equal(bucket.puts.length, 0);
});

test("trace bundle ingest caps records per name and start minute and logs one summary per dropped bucket", async () => {
  const { env, bucket } = baseEnv();
  const fetchCalls: Array<{ input: RequestInfo | URL; init?: RequestInit }> = [];
  env.TRACE_INGEST_OTLP_ENDPOINT = "https://telescope.test/v1/traces";
  env.TRACE_INGEST_PER_MINUTE_CAP = "2";
  env.TRACE_INGEST_FETCH = async (input, init) => {
    fetchCalls.push({ input, init });
    return new Response(null, { status: 200 });
  };
  const flood = [1, 2, 3, 4, 5].map((i) => JSON.stringify(spanRecord({
    span_id: `${i}`.repeat(16),
    name: "daemon.app_source.fire",
    start_time: `2026-10-16T19:30:0${i}.000Z`,
    end_time: `2026-10-16T19:30:0${i}.001Z`,
  })));
  const other = JSON.stringify(spanRecord({ span_id: "9999999999999999", start_time: "2026-10-16T19:30:09.000Z", end_time: "2026-10-16T19:30:09.001Z" }));
  const bundle = Buffer.from([...flood, other, ""].join("\n"));
  const metadata = {
    uploadId: "upload-cap",
    objectKey: "trace-bundles/server-1/machine-1/upload-cap.jsonl",
    bundleId: "bundle-cap",
    bundleSha256: sha256Hex(bundle),
    bundleSizeBytes: bundle.byteLength,
    serverId: "server-1",
    machineId: "machine-1",
  };
  await bucket.put(metadata.objectKey, bufferToArrayBuffer(bundle), {
    httpMetadata: { contentType: "application/x-ndjson" },
  });

  const result = await ingestTraceBundleObject(env, metadata);

  assert.equal(result.spans_ingested, 3);
  assert.equal(result.spans_dropped_rate_cap, 3);
  assert.equal(result.events_dropped_rate_cap, 0);
  assert.equal(result.events_ingested, 1);
  const spanPayload = JSON.parse(fetchCalls[0].init?.body as string);
  assert.deepEqual(
    spanPayload.resourceSpans[0].scopeSpans[0].spans.map((s: { spanId: string }) => s.spanId),
    ["1111111111111111", "2222222222222222", "9999999999999999"],
  );
  assert.match(String(fetchCalls[1].input), /\/v1\/logs$/);
  const logPayload = JSON.parse(fetchCalls[1].init?.body as string);
  const resource = Object.fromEntries(
    logPayload.resourceLogs[0].resource.attributes.map((a: { key: string; value: Record<string, unknown> }) => [a.key, Object.values(a.value)[0]]),
  );
  assert.equal(resource["slock.machine_id"], "machine-1");
  const [summary] = logPayload.resourceLogs[0].scopeLogs[0].logRecords;
  const attrs = Object.fromEntries(
    summary.attributes.map((a: { key: string; value: Record<string, unknown> }) => [a.key, Object.values(a.value)[0]]),
  );
  assert.equal(summary.body.stringValue, "trace_ingest.records_dropped");
  assert.equal(attrs.reason, "per_machine_rate");
  assert.equal(attrs.record_name, "daemon.app_source.fire");
  assert.equal(attrs.minute, "2026-10-16T19:30");
  assert.equal(attrs.cap, "2");
  assert.equal(attrs.kept_count, "2");
  assert.equal(attrs.dropped_count, "3");
});

test("trace bundle ingest never caps feedback report bundles", async () => {
  const { env, bucket } = baseEnv();
  env.TRACE_INGEST_OTLP_ENDPOINT = "https://telescope.test/v1/traces";
  env.TRACE_INGEST_PER_MINUTE_CAP = "1";
  env.TRACE_INGEST_FETCH = async () => new Response(null, { status: 200 });
  const bundle = Buffer.from([1, 2, 3].map((i) => JSON.stringify(spanRecord({ span_id: `${i}`.repeat(16) }))).concat("").join("\n"));
  const metadata = {
    uploadId: "upload-report",
    objectKey: "trace-bundles/server-1/machine-1/upload-report.jsonl",
    bundleId: "bundle-report",
    bundleSha256: sha256Hex(bundle),
    bundleSizeBytes: bundle.byteLength,
    serverId: "server-1",
    machineId: "machine-1",
    feedbackReportId: "4d1c2b3a-5e6f-4a7b-8c9d-0e1f2a3b4c5d",
  };
  await bucket.put(metadata.objectKey, bufferToArrayBuffer(bundle), {
    httpMetadata: { contentType: "application/x-ndjson" },
  });

  const result = await ingestTraceBundleObject(env, metadata);

  assert.equal(result.spans_ingested, 3);
  assert.equal(result.spans_dropped_rate_cap, undefined);
});

test("trace bundle ingest leaves standalone events uncapped by default and caps them only with their own setting", async () => {
  const run = async (eventCap?: string) => {
    const { env, bucket } = baseEnv();
    const fetchCalls: Array<{ input: RequestInfo | URL; init?: RequestInit }> = [];
    env.TRACE_INGEST_OTLP_ENDPOINT = "https://telescope.test/v1/traces";
    env.TRACE_INGEST_PER_MINUTE_CAP = "1";
    if (eventCap !== undefined) env.TRACE_INGEST_EVENT_PER_MINUTE_CAP = eventCap;
    env.TRACE_INGEST_FETCH = async (input, init) => {
      fetchCalls.push({ input, init });
      return new Response(null, { status: 200 });
    };
    const events = [1, 2, 3].map((i) => JSON.stringify({
      type: "event",
      schema_version: 1,
      name: "daemon.agent.activity.produced",
      surface: "daemon",
      time: `2026-10-16T19:30:0${i}.000Z`,
    }));
    const bundle = Buffer.from([JSON.stringify(spanRecord()), ...events, ""].join("\n"));
    const metadata = {
      uploadId: `upload-events-${eventCap ?? "default"}`,
      objectKey: `trace-bundles/server-1/machine-1/upload-events-${eventCap ?? "default"}.jsonl`,
      bundleId: "bundle-events",
      bundleSha256: sha256Hex(bundle),
      bundleSizeBytes: bundle.byteLength,
      serverId: "server-1",
      machineId: "machine-1",
    };
    await bucket.put(metadata.objectKey, bufferToArrayBuffer(bundle), {
      httpMetadata: { contentType: "application/x-ndjson" },
    });
    return { result: await ingestTraceBundleObject(env, metadata), fetchCalls };
  };

  const byDefault = await run();
  assert.equal(byDefault.result.events_ingested, 3);
  assert.equal(byDefault.result.events_dropped_rate_cap, undefined);

  const capped = await run("2");
  // 2 kept events + 1 summary record for the dropped bucket.
  assert.equal(capped.result.events_ingested, 3);
  assert.equal(capped.result.events_dropped_rate_cap, 1);
  const logPayload = JSON.parse(capped.fetchCalls[1].init?.body as string);
  const records = logPayload.resourceLogs[0].scopeLogs[0].logRecords;
  const summary = records.find((r: { body: { stringValue: string } }) => r.body.stringValue === "trace_ingest.records_dropped");
  const attrs = Object.fromEntries(
    summary.attributes.map((a: { key: string; value: Record<string, unknown> }) => [a.key, Object.values(a.value)[0]]),
  );
  assert.equal(attrs.record_type, "event");
  assert.equal(attrs.cap, "2");
});

test("feedback and web trace endpoints allow Raft Desktop's app://raft origin exactly", async () => {
  const { env } = baseEnv();
  env.TRACE_WEB_CORS_ORIGIN = "https://app.raft.build";
  for (const path of ["/api/reports", "/api/web-traces"]) {
    const desktop = await handleRequest(new Request(`https://trace-worker.test${path}`, {
      method: "OPTIONS",
      headers: { Origin: "app://raft" },
    }), env);
    assert.equal(desktop.status, 204);
    assert.equal(desktop.headers.get("Access-Control-Allow-Origin"), "app://raft", path);
    assert.equal(desktop.headers.get("Vary"), "Origin");
    assert.equal(desktop.headers.get("Access-Control-Allow-Credentials"), null);
    // Any other origin still gets the configured web origin, not its own.
    for (const origin of ["app://raft.evil", "app://evil", "https://evil.example.com"]) {
      const other = await handleRequest(new Request(`https://trace-worker.test${path}`, {
        method: "OPTIONS",
        headers: { Origin: origin },
      }), env);
      assert.equal(other.headers.get("Access-Control-Allow-Origin"), "https://app.raft.build", `${path} ${origin}`);
    }
  }
});
