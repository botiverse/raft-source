// Cross-package smoke test: REAL daemon-side producer output through the REAL
// worker ingest path. Every other worker test hand-builds its JSONL fixtures;
// this test instead emits spans via @botiverse/raft-trace-client's
// LocalRotatingTraceSink (the same sink the daemon runs), reads back the
// actual daemon-trace-*.jsonl bytes, and feeds them through the worker's
// gzipped-bundle ingest + V2 projection path.
//
// Direction-of-failure contract: this test must FAIL if the daemon record
// shape drifts incompatibly — hence the explicit type/schema_version pins and
// the per-line isLocalTraceRecord gate — not pass vacuously on any bytes.
//
// Substitution, named explicitly: instead of the full HTTP route
// (POST /api/trace-bundles -> PUT .../object -> scheduled ingest), this test
// drives `ingestTraceBundleObject` directly — the exact internal function the
// PUT route schedules via scheduleTraceBundleIngest — because the HTTP layer
// only adds attestation/token plumbing that index.test.ts already covers.

import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtemp, readFile, readdir, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { gzipSync } from "node:zlib";
import { BasicTracer, TRACE_EVENT_ROW_V2_PROJECTION_COLUMNS } from "@botiverse/raft-shared";
import { LocalRotatingTraceSink } from "@botiverse/raft-trace-client";
import type { Client } from "scopedb";
import { ingestTraceBundleObject, isLocalTraceRecord, type TraceUploadWorkerEnv } from "./index.js";

class MockR2Bucket {
  puts: Array<{
    key: string;
    body: ArrayBuffer | string;
    options?: {
      httpMetadata?: { contentType?: string; contentEncoding?: string };
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

function sha256Hex(body: Buffer | Uint8Array): string {
  return createHash("sha256").update(body).digest("hex");
}

function bufferToArrayBuffer(buffer: Buffer): ArrayBuffer {
  const copy = new Uint8Array(buffer.byteLength);
  copy.set(buffer);
  return copy.buffer;
}

test("daemon-produced LocalRotatingTraceSink bytes round-trip through worker ingest and V2 projection", async () => {
  const machineDir = await mkdtemp(path.join(os.tmpdir(), "raft-worker-daemon-bundle-smoke-"));
  try {
    // --- 1. Real daemon-side producer emits real trace records -------------
    const sink = new LocalRotatingTraceSink({ machineDir, maxFileBytes: 1024 * 1024, maxFiles: 4 });
    const tracer = new BasicTracer({ sink });

    const normal = tracer.startSpan("daemon.runtime.turn", {
      surface: "daemon",
      kind: "internal",
      attrs: {
        serverId: "server-smoke",
        machineId: "machine-smoke",
        daemon_version: "0.0.0-smoke",
        runtime: "codex",
        outcome: "ok",
      },
    });
    normal.addEvent("daemon.turn.started", { seq: 1 });
    normal.end("ok");

    // db_query-ish span: mirrors the G2 15-second-knee contract columns
    // (db_system/query_name/phase/sqlstate/timeout_bucket/retryable) that the
    // `server.db.query` trace family registers for `trace_events_v2` reads.
    const dbQuery = tracer.startSpan("server.db.query", {
      surface: "daemon",
      kind: "client",
      attrs: {
        db_system: "postgresql",
        query_name: "messages.search",
        phase: "execute",
        sqlstate: "57014",
        timeout_bucket: ">15s",
        retryable: "false",
        query_fingerprint: "fp-smoke-1",
      },
    });
    dbQuery.end("error");

    // Negative-control span: attrs that LocalRotatingTraceSink's real scrub
    // contract (shouldDropAttr in localTraceSink.ts) MUST drop by name —
    // api_token / db_password hit the secret-token regex, request_body hits
    // the content-key regex. Each carries a unique marker so absence can be
    // asserted over whole serialized payloads. The kept attr on the SAME span
    // (`outcome`) proves selective scrubbing, not a total attr drop.
    // Right-cause: renaming any sensitive key to a non-dropped name (e.g.
    // `api_token` -> `api_tokenc`) leaks its marker into the JSONL and turns
    // this test red — verified locally by mutation, then reverted.
    const SENSITIVE_MARKERS = [
      "sk-live-SENSITIVE-MARKER-A",
      "SENSITIVE-MARKER-B",
      "SENSITIVE-MARKER-C",
    ];
    const KEPT_MARKER = "SCRUB-KEPT-MARKER";
    const scrubProbe = tracer.startSpan("daemon.scrub.probe", {
      surface: "daemon",
      kind: "internal",
      attrs: {
        api_token: SENSITIVE_MARKERS[0],
        db_password: SENSITIVE_MARKERS[1],
        request_body: SENSITIVE_MARKERS[2],
        outcome: KEPT_MARKER,
      },
    });
    scrubProbe.end("ok");

    const traceFiles = (await readdir(path.join(machineDir, "traces")))
      .filter((name) => name.startsWith("daemon-trace-") && name.endsWith(".jsonl"));
    assert.equal(traceFiles.length, 1, "expected exactly one daemon-trace-*.jsonl file");
    const rawJsonl = await readFile(path.join(machineDir, "traces", traceFiles[0]), "utf8");
    const lines = rawJsonl.split("\n").filter((line) => line.trim() !== "");
    assert.equal(lines.length, 3, "expected the three emitted spans as three JSONL lines");

    // (a) The sensitive markers must already be absent from the real bytes on
    // disk — the producer's scrub is the first and primary gate.
    for (const marker of SENSITIVE_MARKERS) {
      assert.equal(rawJsonl.includes(marker), false, `marker ${marker} must be scrubbed from the raw daemon JSONL`);
    }
    assert.ok(rawJsonl.includes(KEPT_MARKER), "the kept attr must survive the producer scrub");

    // --- 2. Shape gate: every real line must satisfy the worker validator --
    const records = lines.map((line) => {
      const parsed: unknown = JSON.parse(line);
      // Explicit pins, not just the validator: if LocalRotatingTraceSink ever
      // renames fields or bumps schema_version, this test must go red.
      const record = parsed as Record<string, unknown>;
      assert.equal(record.type, "span");
      assert.equal(record.schema_version, 1);
      assert.ok(isLocalTraceRecord(parsed), `real daemon record must pass isLocalTraceRecord: ${line}`);
      return parsed;
    });
    const realTraceIds = new Set(records.map((record) => record.trace_id));
    assert.equal(realTraceIds.size, 3, "each span gets its own trace id from the real producer");

    // --- 3. Feed the real bytes through the worker bundle ingest path ------
    const bucket = new MockR2Bucket();
    const otlpBodies: string[] = [];
    const projectedPayloads: string[] = [];
    const env: TraceUploadWorkerEnv = {
      SCOPE_ATTESTATION_SECRET: "scope-secret-for-smoke-test",
      TRACE_BUNDLES: bucket,
      TRACE_INGEST_OTLP_ENDPOINT: "https://telescope.test/v1/traces",
      TRACE_INGEST_FETCH: async (_input, init) => {
        otlpBodies.push(String(init?.body));
        return new Response(null, { status: 200 });
      },
      RAFT_TRACE_SCOPEDB_PROJECTOR: "on",
      // Unique endpoint: projectV2BestEffort caches live-schema validation per
      // endpoint, so this test must not share an endpoint with other tests.
      SCOPEDB_TRACE_EVENTS_ENDPOINT: "https://scopedb-daemon-bundle-smoke.test",
      SCOPEDB_TRACE_EVENTS_WRITE_KEY: "smoke-key",
      SCOPEDB_TRACE_EVENTS_CLIENT: {
        table: () => ({
          withSchema() { return this; },
          tableSchema: async () => ({
            fields: () => TRACE_EVENT_ROW_V2_PROJECTION_COLUMNS.map(([name, dataType]) => ({
              name: () => name,
              dataType: () => dataType,
            })),
          }),
        }),
        insert: async (payload: string) => {
          projectedPayloads.push(payload);
          return { num_rows_inserted: payload.split("\n").length };
        },
      } as unknown as Pick<Client, "insert" | "table">,
    };

    const bundle = gzipSync(Buffer.from(rawJsonl, "utf8"));
    const metadata = {
      uploadId: "upload-daemon-smoke",
      objectKey: "trace-bundles/server-smoke/machine-smoke/upload-daemon-smoke.jsonl.gz",
      bundleId: "bundle-daemon-smoke",
      bundleSha256: sha256Hex(bundle),
      bundleSizeBytes: bundle.byteLength,
      serverId: "server-smoke",
      machineId: "machine-smoke",
    };
    await bucket.put(metadata.objectKey, bufferToArrayBuffer(bundle), {
      httpMetadata: { contentType: "application/x-ndjson", contentEncoding: "gzip" },
    });

    const result = await ingestTraceBundleObject(env, metadata);

    assert.equal(result.spans_ingested, 3);
    assert.equal(result.v2_projector_status, "success");
    assert.equal(result.v2_spans_projected, 3);
    assert.equal(result.v2_spans_skipped, 0);
    assert.deepEqual(result.v2_skip_reason_classes, []);

    // --- 3a. OTLP POST carries the real spans with their real trace ids ----
    const otlpSpans = otlpBodies.flatMap((body) => {
      const payload = JSON.parse(body);
      return payload.resourceSpans.flatMap((rs: any) =>
        rs.scopeSpans.flatMap((ss: any) => ss.spans));
    });
    assert.equal(otlpSpans.length, 3);
    for (const span of otlpSpans) {
      assert.ok(realTraceIds.has(span.traceId), `OTLP span traceId ${span.traceId} must be a real producer trace id`);
    }
    assert.ok(otlpSpans.some((span: any) => span.name === "server.db.query"));

    // (b) No sensitive marker may cross into any OTLP POST body; the kept
    // attr must still be there (selective, not total, scrub).
    const otlpSerialized = otlpBodies.join("\n");
    for (const marker of SENSITIVE_MARKERS) {
      assert.equal(otlpSerialized.includes(marker), false, `marker ${marker} must not reach the OTLP POST body`);
    }
    assert.ok(otlpSerialized.includes(KEPT_MARKER), "the kept attr must flow to OTLP");

    // --- 3b. V2 projection keeps the promoted db-query attrs intact --------
    const rows = projectedPayloads.flatMap((payload) =>
      payload.split("\n").filter((line) => line.trim() !== "").map((line) => JSON.parse(line)));
    // 3 span_fact rows + 1 event row from the normal span's daemon.turn.started.
    assert.equal(rows.length, 4);
    // (c) No sensitive marker may appear in any projected V2 row; the kept
    // attr still flows, so the scrub is provably selective end to end.
    const projectedSerialized = projectedPayloads.join("\n");
    for (const marker of SENSITIVE_MARKERS) {
      assert.equal(projectedSerialized.includes(marker), false, `marker ${marker} must not reach V2 projected rows`);
    }
    const probeSpanFact = rows.find((row) => row.row_kind === "span_fact" && row.span_name === "daemon.scrub.probe");
    assert.ok(probeSpanFact, "expected a span_fact row for the scrub-probe span");
    assert.equal(probeSpanFact.outcome, KEPT_MARKER);
    const dbSpanFact = rows.find((row) => row.row_kind === "span_fact" && row.span_name === "server.db.query");
    assert.ok(dbSpanFact, "expected a span_fact row for the db_query-ish span");
    assert.ok(realTraceIds.has(dbSpanFact.trace_id));
    assert.equal(dbSpanFact.span_status, "error");
    assert.equal(dbSpanFact.db_system, "postgresql");
    assert.equal(dbSpanFact.query_name, "messages.search");
    assert.equal(dbSpanFact.phase, "execute");
    assert.equal(dbSpanFact.sqlstate, "57014");
    assert.equal(dbSpanFact.timeout_bucket, ">15s");
    assert.equal(dbSpanFact.retryable, "false");
    assert.equal(dbSpanFact.query_fingerprint, "fp-smoke-1");
    assert.equal(dbSpanFact.service_name, "slock-daemon");
    assert.equal(dbSpanFact.server_id, "server-smoke");
    assert.equal(dbSpanFact.machine_id, "machine-smoke");
  } finally {
    await rm(machineDir, { recursive: true, force: true });
  }
});
