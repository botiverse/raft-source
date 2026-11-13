import assert from "node:assert/strict";
import {
  chunkScopeDbAppendLines,
  classifyScopeDbAppendFailure,
  encodeScopeDbAppendLine,
  ScopeDbAppendEncodingError,
  type ScopeDbAppendColumns,
} from "./scopeDbAppend";
import {
  createTraceContext,
  encodeTraceEventRowV2AppendLine,
  TRACE_EVENT_ROW_V2_PROJECTION_COLUMNS,
  traceEventRowForRecord,
  assertTraceEventRowV2TableSchema,
  TRACE_EVENT_ROW_V2_SCHEMA_RECHECK_MS,
  traceEventRowV2SchemaCheckSkipReason,
  traceEventRowV2SchemaFieldsFromCatalog,
  traceSpanFactRowForSpan,
} from "./index";

const COLUMNS = [
  ["id", "string"],
  ["count", "int"],
  ["at", "timestamp"],
  ["props", "object"],
] as const satisfies ScopeDbAppendColumns;

test("Append encoding writes exactly the listed columns in order, with explicit nulls", () => {
  assert.equal(
    encodeScopeDbAppendLine({ props: { a: 1 }, extra: "dropped", id: "x", count: 3, at: "2026-10-29T01:02:03.456Z" }, COLUMNS),
    '{"id":"x","count":3,"at":"2026-10-29T01:02:03.456Z","props":{"a":1}}',
  );
  assert.equal(
    encodeScopeDbAppendLine({ id: null, count: undefined }, COLUMNS),
    '{"id":null,"count":null,"at":null,"props":null}',
  );
});

test("Append encoding turns epoch milliseconds and Dates into RFC 3339 UTC and keeps valid RFC 3339 text", () => {
  assert.equal(encodeScopeDbAppendLine({ at: 1_001 }, [["at", "timestamp"]]), '{"at":"1970-01-01T00:00:01.001Z"}');
  assert.equal(encodeScopeDbAppendLine({ at: new Date(0) }, [["at", "timestamp"]]), '{"at":"1970-01-01T00:00:00.000Z"}');
  assert.equal(
    encodeScopeDbAppendLine({ at: "2026-10-23T20:34:56.123456789+08:00" }, [["at", "timestamp"]]),
    '{"at":"2026-10-23T20:34:56.123456789+08:00"}',
  );
  for (const bad of ["2026-10-23", "2026-10-23T12:00:00", "2026-10-23 12:00:00Z", "1730000000000", "2026-13-45T00:00:00Z"]) {
    assert.throws(() => encodeScopeDbAppendLine({ at: bad }, [["at", "timestamp"]]), ScopeDbAppendEncodingError, bad);
  }
  assert.throws(() => encodeScopeDbAppendLine({ at: Number.NaN }, [["at", "timestamp"]]), ScopeDbAppendEncodingError);
  // Date.parse would roll these over to another day; ScopeDB would reject the text.
  for (const impossible of ["2026-02-30T00:00:00Z", "2025-02-29T00:00:00Z", "2026-04-31T00:00:00Z", "2026-13-01T00:00:00Z",
    "2026-10-23T24:00:00Z", "2026-10-23T12:60:00Z", "2026-10-23T12:00:60Z", "2026-10-23T12:00:00+24:00"]) {
    assert.throws(() => encodeScopeDbAppendLine({ at: impossible }, [["at", "timestamp"]]), /real calendar/, impossible);
  }
  assert.equal(encodeScopeDbAppendLine({ at: "2024-02-29T23:59:59.999+14:00" }, [["at", "timestamp"]]), '{"at":"2024-02-29T23:59:59.999+14:00"}');
  // Beyond signed 64-bit nanoseconds (2262-04-11).
  assert.throws(() => encodeScopeDbAppendLine({ at: Date.UTC(2300, 0, 1) }, [["at", "timestamp"]]), /64-bit nanosecond/);
});

test("Append encoding writes int columns as integer tokens", () => {
  const columns = [["n", "int"]] as const;
  assert.equal(encodeScopeDbAppendLine({ n: 42 }, columns), '{"n":42}');
  assert.equal(encodeScopeDbAppendLine({ n: -42 }, columns), '{"n":-42}');
  assert.equal(encodeScopeDbAppendLine({ n: 12.9 }, columns), '{"n":12}');
  assert.equal(encodeScopeDbAppendLine({ n: -0.5 }, columns), '{"n":0}');
  assert.throws(() => encodeScopeDbAppendLine({ n: "42" }, columns), ScopeDbAppendEncodingError);
  assert.throws(() => encodeScopeDbAppendLine({ n: Number.POSITIVE_INFINITY }, columns), ScopeDbAppendEncodingError);
  assert.throws(() => encodeScopeDbAppendLine({ n: 2 ** 60 }, columns), /exactly representable/);
});

test("Append encoding keeps strings, casts JSON scalars like the legacy ::string, and rejects objects", () => {
  const columns = [["s", "string"]] as const;
  assert.equal(encodeScopeDbAppendLine({ s: "a\"b" }, columns), '{"s":"a\\"b"}');
  assert.equal(encodeScopeDbAppendLine({ s: 7 }, columns), '{"s":"7"}');
  assert.equal(encodeScopeDbAppendLine({ s: true }, columns), '{"s":"true"}');
  assert.throws(() => encodeScopeDbAppendLine({ s: { a: 1 } }, columns), ScopeDbAppendEncodingError);
});

test("Append encoding passes object columns as JSON objects, never as serialized strings", () => {
  const columns = [["o", "object"]] as const;
  assert.equal(
    encodeScopeDbAppendLine({ o: { $device_type: "mobile", n: 1.5, ok: true, nested: { a: [1, null] } } }, columns),
    '{"o":{"$device_type":"mobile","n":1.5,"ok":true,"nested":{"a":[1,null]}}}',
  );
  assert.throws(() => encodeScopeDbAppendLine({ o: '{"a":1}' }, columns), /JSON object/);
  assert.throws(() => encodeScopeDbAppendLine({ o: [1] }, columns), /JSON object/);
  assert.throws(() => encodeScopeDbAppendLine({ o: { big: 1e19 } }, columns), /64-bit range/);
});

test("chunkScopeDbAppendLines splits by bytes and rows without reordering", () => {
  assert.deepEqual(chunkScopeDbAppendLines([]), []);
  assert.deepEqual(chunkScopeDbAppendLines(["a", "b", "c"], 4), [
    { ndjson: "a\nb", rows: 2 },
    { ndjson: "c", rows: 1 },
  ]);
  assert.deepEqual(chunkScopeDbAppendLines(["a", "b", "c"], 1_000, 2), [
    { ndjson: "a\nb", rows: 2 },
    { ndjson: "c", rows: 1 },
  ]);
  assert.deepEqual(chunkScopeDbAppendLines(["toolong", "b"], 3), [
    { ndjson: "toolong", rows: 1 },
    { ndjson: "b", rows: 1 },
  ]);
});

test("Trace V2 Append lines carry exactly the 67 projection columns in projection order", () => {
  const row = traceEventRowForRecord({
    span: {
      context: createTraceContext({ traceId: "1".repeat(32), spanId: "2".repeat(16) }),
      name: "server.agent.activity.resolve",
      surface: "server",
      kind: "internal",
      startTimeMs: 1_000,
      attrs: { agent_id: "agent-1", operation_id: "op-1" },
    },
    event: {
      name: "activity.hint.candidate",
      timeMs: 1_001,
      attrs: { replay_status: 503, timeout_ms: 30, error_message: "boom" },
    },
    eventIndex: 0,
  }, { serviceName: "svc" });

  const line = encodeTraceEventRowV2AppendLine(row);
  const record = JSON.parse(line) as Record<string, unknown>;
  assert.deepEqual(Object.keys(record), TRACE_EVENT_ROW_V2_PROJECTION_COLUMNS.map(([column]) => column));
  // Not in the projection, so never sent (Append would reject unknown fields).
  assert.equal("operation_id" in record, false);
  assert.equal("timeout_ms" in record, false);
  assert.equal(record.event_time, "1970-01-01T00:00:01.001Z");
  assert.equal(record.event_time_ms, 1_001);
  assert.equal(record.span_start_time_ms, 1_000);
  assert.equal(record.span_end_time_ms, null);
  assert.equal(record.event_index, 0);
  assert.equal(record.replay_status, 503);
  assert.equal(record.error_message, "boom");
  assert.equal(record.deployment_environment, null);
  assert.ok(line.startsWith(
    '{"row_kind":"event","service_name":"svc","deployment_environment":null,"service_version":null,',
  ));
  assert.ok(line.endsWith('"replay_status":503,"db_system":null,"query_name":null,"phase":null,"sqlstate":null,'
    + '"query_fingerprint":null,"timeout_bucket":null,"retryable":null,"error_message":"boom"}'));

  const fact = JSON.parse(encodeTraceEventRowV2AppendLine(traceSpanFactRowForSpan({
    context: createTraceContext({ traceId: "3".repeat(32), spanId: "4".repeat(16) }),
    name: "span",
    surface: "server",
    kind: "internal",
    status: "ok",
    startTimeMs: 2_000,
    endTimeMs: 2_030.7,
    durationMs: 30.7,
    events: [],
  }, { serviceName: "svc" }))) as Record<string, unknown>;
  assert.equal(fact.row_kind, "span_fact");
  assert.equal(fact.event_index, null);
  // Fractional clock values become integer tokens; event_time keeps the ms.
  assert.equal(fact.span_end_time_ms, 2_030);
  assert.equal(fact.event_time_ms, 2_030);
  assert.equal(fact.event_time, "1970-01-01T00:00:02.030Z");
});

test("Catalog table definitions feed the Trace V2 schema assertion, with computed columns treated as missing", () => {
  const columns = TRACE_EVENT_ROW_V2_PROJECTION_COLUMNS.map(([name, dataType]) => ({ name, data_type: dataType }));
  assert.doesNotThrow(() => assertTraceEventRowV2TableSchema(traceEventRowV2SchemaFieldsFromCatalog({ columns })));
  assert.deepEqual(traceEventRowV2SchemaFieldsFromCatalog({}), []);
  const computed = columns.map((column) => column.name === "event_time_ms"
    ? { ...column, expression: "to_unix_millis(event_time)" }
    : { ...column, expression: null });
  assert.throws(
    () => assertTraceEventRowV2TableSchema(traceEventRowV2SchemaFieldsFromCatalog({ columns: computed })),
    /required column event_time_ms is missing/,
  );
});

test("classifyScopeDbAppendFailure reads throttling from the HTTP status, not the SDK outcome", () => {
  // Shapes the scopedb 0.4 SDK throws (see the real-SDK sink/projector/product tests).
  // The SDK's synthesized ambiguous for a plain-body response keeps the HTTP failure as cause.
  const plainCause = { httpStatus: 429 };
  assert.deepEqual(classifyScopeDbAppendFailure({ outcome: "ambiguous", httpStatus: 429, retryAfterMs: 2_000, cause: plainCause }),
    { class: "throttled", retryable: true, httpStatus: 429, retryAfterMs: 2_000 });
  assert.deepEqual(classifyScopeDbAppendFailure({ outcome: "ambiguous", httpStatus: 503, cause: { httpStatus: 503 } }),
    { class: "unavailable", retryable: true, httpStatus: 503 });
  // A structured "ambiguous" from the server (no cause) may have committed, even on 503.
  assert.deepEqual(classifyScopeDbAppendFailure({ outcome: "ambiguous", httpStatus: 503 }),
    { class: "unknown", retryable: false, httpStatus: 503 });
  // ...also when a stream wraps it.
  assert.deepEqual(classifyScopeDbAppendFailure({ outcome: "ambiguous", httpStatus: 503, cause: { outcome: "ambiguous", httpStatus: 503 } }),
    { class: "unknown", retryable: false, httpStatus: 503 });
  assert.deepEqual(classifyScopeDbAppendFailure({ outcome: "ambiguous", httpStatus: 429, writeDetails: { reason: "timeout", outcome: "ambiguous" } }),
    { class: "unknown", retryable: false, httpStatus: 429 });
  assert.deepEqual(classifyScopeDbAppendFailure({ outcome: "ambiguous", httpStatus: 502, cause: { httpStatus: 502 } }),
    { class: "unknown", retryable: false, httpStatus: 502 });
  // An exhausted stream retry on a temporary rejection: persistent, named "AppendRowsError", with a retries context.
  assert.deepEqual(classifyScopeDbAppendFailure({
    name: "AppendRowsError", outcome: "failed", httpStatus: 500, isTemporary: () => false, context: () => new Map([["retries", "2"]]),
  }), { class: "rejected", retryable: true, httpStatus: 500 });
  assert.deepEqual(classifyScopeDbAppendFailure({ outcome: "ambiguous" }), { class: "unknown", retryable: false });
  assert.deepEqual(classifyScopeDbAppendFailure({ outcome: "failed", httpStatus: 400, isTemporary: () => false }),
    { class: "rejected", retryable: false, httpStatus: 400 });
  assert.deepEqual(classifyScopeDbAppendFailure({ outcome: "failed", httpStatus: 500, isTemporary: () => true }),
    { class: "rejected", retryable: true, httpStatus: 500 });
  assert.deepEqual(classifyScopeDbAppendFailure(new Error("boom")), { class: "local", retryable: false });
  assert.deepEqual(classifyScopeDbAppendFailure("boom"), { class: "local", retryable: false });
});

test("classifyScopeDbAppendFailure reads the error shapes scopedb 0.4.0 throws", () => {
  // Hand-copied from the errors the published 0.4.0 Client throws for these HTTP responses
  // (src/client.ts appendRequest / responseToError): a non-JSON body is wrapped as
  // "ambiguous" with the outcome-less HTTP failure as cause; any JSON body becomes an
  // AppendRowsError with no cause: "failed" for a 4xx with ScopeDB's error code, else "ambiguous".
  // Plain-text 429 / 503 (gateway): re-sent.
  assert.deepEqual(classifyScopeDbAppendFailure({ outcome: "ambiguous", httpStatus: 429, retryAfterMs: 2_000, cause: { httpStatus: 429 } }),
    { class: "throttled", retryable: true, httpStatus: 429, retryAfterMs: 2_000 });
  assert.deepEqual(classifyScopeDbAppendFailure({ outcome: "ambiguous", httpStatus: 503, cause: { httpStatus: 503 } }),
    { class: "unavailable", retryable: true, httpStatus: 503 });
  // ScopeDB's own 429 ("failed", temporary) and a gateway's JSON 429 ("ambiguous", no cause): both throttled.
  assert.deepEqual(classifyScopeDbAppendFailure({ outcome: "failed", httpStatus: 429, isTemporary: () => true }),
    { class: "throttled", retryable: true, httpStatus: 429 });
  assert.deepEqual(classifyScopeDbAppendFailure({ outcome: "ambiguous", httpStatus: 429 }),
    { class: "throttled", retryable: true, httpStatus: 429 });
  // 429 wins even over a body that declared "may have committed" (0.3 legacy details.status "unknown").
  assert.deepEqual(classifyScopeDbAppendFailure({ outcome: "unknown", httpStatus: 429 }),
    { class: "throttled", retryable: true, httpStatus: 429 });
  // Any JSON 5xx (ScopeDB's service_unavailable included) is "ambiguous" with no cause: may have committed, not re-sent.
  assert.deepEqual(classifyScopeDbAppendFailure({ outcome: "ambiguous", httpStatus: 503 }),
    { class: "unknown", retryable: false, httpStatus: 503 });
  assert.deepEqual(classifyScopeDbAppendFailure({ outcome: "ambiguous", httpStatus: 500 }),
    { class: "unknown", retryable: false, httpStatus: 500 });
  // ScopeDB's structured 4xx: a permanent rejection (0.4 marks only 429 temporary).
  assert.deepEqual(classifyScopeDbAppendFailure({ outcome: "failed", httpStatus: 400, isTemporary: () => false }),
    { class: "rejected", retryable: false, httpStatus: 400 });
  // Timeout / cancellation carry writeDetails.
  assert.deepEqual(classifyScopeDbAppendFailure({ outcome: "ambiguous", httpStatus: 429, writeDetails: { reason: "timeout", outcome: "ambiguous" } }),
    { class: "unknown", retryable: false, httpStatus: 429 });
  // A stream that ran out of retries on a 429 (AppendRetryExhaustedError: name "AppendRowsError", retries context).
  assert.deepEqual(classifyScopeDbAppendFailure({
    name: "AppendRowsError", outcome: "failed", httpStatus: 429, isTemporary: () => false, context: () => new Map([["retries", "2"]]),
    cause: { outcome: "failed", httpStatus: 429 },
  }), { class: "throttled", retryable: true, httpStatus: 429 });
});

test("an unreadable catalog is classified as a skipped schema check, never a mismatch", () => {
  assert.equal(traceEventRowV2SchemaCheckSkipReason({ httpStatus: 403 }), "unauthorized");
  assert.equal(traceEventRowV2SchemaCheckSkipReason({ httpStatus: 401, code: "unauthorized" }), "unauthorized");
  assert.equal(traceEventRowV2SchemaCheckSkipReason({ code: "permission_denied" }), "unauthorized");
  assert.equal(traceEventRowV2SchemaCheckSkipReason({ httpStatus: 503 }), "catalog_error");
  assert.equal(traceEventRowV2SchemaCheckSkipReason(new DOMException("timed out", "TimeoutError")), "catalog_error");
  assert.equal(traceEventRowV2SchemaCheckSkipReason("boom"), "catalog_error");
  assert.deepEqual(TRACE_EVENT_ROW_V2_SCHEMA_RECHECK_MS, { unauthorized: 600_000, catalog_error: 60_000 });
});
