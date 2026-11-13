import assert from "node:assert/strict";
import { afterEach, test, vi } from "vitest";
import {
  scopeDbTraceExportSummaryWriter,
  TRACE_EXPORT_SUMMARY_COLUMNS,
  traceExportSummaryAppendLine,
  TraceExportSummary,
  type TraceExportSummaryRow,
  type TraceExportSummaryWriter,
} from "./traceExportSummary";

afterEach(() => {
  vi.restoreAllMocks();
});

const RESOURCE = {
  serviceName: "slock-server",
  serviceVersion: "1.21.34",
  serviceRevision: "abc123",
  serviceInstanceId: "ecs:opaque",
  ecsTaskId: "task-1",
  deploymentEnvironment: "production",
};

const at = (iso: string) => Date.parse(iso);

function harness(startIso = "2026-10-24T08:45:00Z") {
  let now = at(startIso);
  const writes: TraceExportSummaryRow[][] = [];
  let fail = 0;
  const writer: TraceExportSummaryWriter = {
    write: async (rows) => {
      if (fail > 0) {
        fail -= 1;
        throw Object.assign(new Error("HTTP 429 rejected row 1111"), { name: "ScopeDBError" });
      }
      writes.push([...rows]);
    },
  };
  const summary = new TraceExportSummary(writer, RESOURCE, () => now);
  return {
    summary,
    writes,
    setNow: (iso: string) => { now = at(iso); },
    failNext: (times: number) => { fail = times; },
  };
}

test("a window reports what each signal sent, dropped and failed, with per-kind failure times", async () => {
  const h = harness();
  h.summary.queueDepth("traces", 40);
  h.summary.queueDepth("traces", 4096);
  h.summary.exported("traces", 64, 120);
  h.setNow("2026-10-24T08:45:31.250Z");
  h.summary.exportFailed("traces", 64, 3_001, { kind: "timeout" });
  h.setNow("2026-10-24T08:45:40.500Z");
  h.summary.exportFailed("traces", 64, 900, { kind: "http_5xx", httpStatus: 503 });
  h.setNow("2026-10-24T08:45:52.000Z");
  h.summary.exportFailed("traces", 10, 3_002, { kind: "timeout" });
  h.summary.droppedQueueFull("traces", 1);
  h.summary.droppedQueueFull("traces", 1);
  h.summary.exported("logs", 30, 15);
  h.setNow("2026-10-24T08:46:00Z");
  await h.summary.report();

  assert.equal(h.writes.length, 1);
  const [traces, logs] = h.writes[0]!;
  assert.deepEqual(
    {
      window_start: traces!.window_start,
      window_end: traces!.window_end,
      window_s: traces!.window_s,
      signal: traces!.signal,
      exported: traces!.exported,
      exported_batches: traces!.exported_batches,
      dropped_queue_full: traces!.dropped_queue_full,
      dropped_export_failed: traces!.dropped_export_failed,
      failed_batches: traces!.failed_batches,
      timeout: [traces!.timeout_batches, traces!.timeout_first_at, traces!.timeout_last_at],
      http_5xx: [traces!.http_5xx_batches, traces!.http_5xx_first_at, traces!.http_5xx_last_at],
      http_429: [traces!.http_429_batches, traces!.http_429_first_at, traces!.http_429_last_at],
      last_http_status: traces!.last_http_status,
      max_queue_depth: traces!.max_queue_depth,
      export_ms_max: traces!.export_ms_max,
      self_write_failed: traces!.self_write_failed,
    },
    {
      window_start: "2026-10-24T08:45:00.000Z",
      window_end: "2026-10-24T08:46:00.000Z",
      window_s: 60,
      signal: "traces",
      exported: 64,
      exported_batches: 1,
      dropped_queue_full: 2,
      dropped_export_failed: 138,
      failed_batches: 3,
      timeout: [2, "2026-10-24T08:45:31.250Z", "2026-10-24T08:45:52.000Z"],
      http_5xx: [1, "2026-10-24T08:45:40.500Z", "2026-10-24T08:45:40.500Z"],
      http_429: [0, null, null],
      last_http_status: 503,
      max_queue_depth: 4096,
      export_ms_max: 3_002,
      self_write_failed: 0,
    },
  );
  assert.equal(logs!.signal, "logs");
  assert.equal(logs!.exported, 30);
  assert.equal(logs!.failed_batches, 0);
  assert.equal(logs!.service_instance_id, "ecs:opaque");
  assert.equal(logs!.deployment_environment, "production");
});

test("an idle minute writes nothing, and an idle signal writes no row", async () => {
  const h = harness();
  h.summary.queueDepth("logs", 3); // queued but not yet sent is not activity
  h.setNow("2026-10-24T08:46:00Z");
  await h.summary.report();
  assert.equal(h.writes.length, 0);

  h.summary.exported("logs", 5, 10);
  h.setNow("2026-10-24T08:47:00Z");
  await h.summary.report();
  assert.deepEqual(h.writes.map((rows) => rows.map((row) => [row.signal, row.window_start])), [
    [["logs", "2026-10-24T08:46:00.000Z"]],
  ]);
});

test("a window that fails to write is folded into the next: real span, sums, earliest and latest times, maxima", async () => {
  const h = harness();
  const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
  h.summary.exported("traces", 64, 100);
  h.summary.queueDepth("traces", 900);
  h.setNow("2026-10-24T08:45:20Z");
  h.summary.exportFailed("traces", 64, 3_000, { kind: "http_429", httpStatus: 429 });
  h.setNow("2026-10-24T08:46:00Z");
  h.failNext(1);
  await h.summary.report();
  assert.equal(h.writes.length, 0);
  assert.ok(warn.mock.calls.every((call) => !call.join(" ").includes("1111")), "error class only, never the store's text");

  h.summary.exported("traces", 10, 50);
  h.summary.queueDepth("traces", 12);
  h.setNow("2026-10-24T08:46:30Z");
  h.summary.exportFailed("traces", 64, 1_200, { kind: "http_429", httpStatus: 429 });
  h.setNow("2026-10-24T08:47:00Z");
  await h.summary.report();

  assert.equal(h.writes.length, 1);
  const [row] = h.writes[0]!;
  assert.deepEqual(
    [row!.window_start, row!.window_end, row!.window_s, row!.exported, row!.exported_batches, row!.dropped_export_failed],
    ["2026-10-24T08:45:00.000Z", "2026-10-24T08:47:00.000Z", 120, 74, 2, 128],
  );
  assert.deepEqual(
    [row!.http_429_batches, row!.http_429_first_at, row!.http_429_last_at],
    [2, "2026-10-24T08:45:20.000Z", "2026-10-24T08:46:30.000Z"],
  );
  assert.equal(row!.max_queue_depth, 900, "the folded window's maximum is kept");
  assert.equal(row!.export_ms_max, 3_000);
  assert.equal(row!.self_write_failed, 1);
});

test("counts that arrive while a write is in flight go to the next window", async () => {
  let release: () => void = () => {};
  const writes: TraceExportSummaryRow[][] = [];
  let now = at("2026-10-24T08:45:00Z");
  const summary = new TraceExportSummary({
    write: (rows) => new Promise<void>((resolve) => {
      release = () => { writes.push([...rows]); resolve(); };
    }),
  }, RESOURCE, () => now);
  summary.exported("traces", 1, 1);
  now = at("2026-10-24T08:46:00Z");
  const first = summary.report();
  summary.exported("traces", 2, 1);
  now = at("2026-10-24T08:47:00Z");
  const overlapping = summary.report();
  assert.equal(overlapping, first, "a tick during a write waits for it");
  release();
  await first;
  const second = summary.report();
  release();
  await second;

  assert.deepEqual(writes.map((rows) => [rows[0]!.window_start, rows[0]!.exported]), [
    ["2026-10-24T08:45:00.000Z", 1],
    ["2026-10-24T08:46:00.000Z", 2],
  ]);
});

test("shutdown reports the last, partial window and stops the timer", async () => {
  vi.useFakeTimers({ now: at("2026-10-24T08:45:00Z") });
  try {
    const writes: TraceExportSummaryRow[][] = [];
    const summary = new TraceExportSummary({ write: async (rows) => { writes.push([...rows]); } }, RESOURCE);
    summary.start(60_000);
    summary.exported("logs", 3, 5);
    await vi.advanceTimersByTimeAsync(60_000);
    summary.exported("logs", 4, 5);
    await vi.advanceTimersByTimeAsync(15_000);
    await summary.stop();
    summary.exported("logs", 9, 5);
    await vi.advanceTimersByTimeAsync(120_000);

    assert.deepEqual(writes.map((rows) => [rows[0]!.exported, rows[0]!.window_s]), [[3, 60], [4, 15]]);
  } finally {
    vi.useRealTimers();
  }
});

test("the ScopeDB writer commits one Append of every row to raft.trace_export_summary", async () => {
  const appends: Array<{ table: string; data: string; signal?: AbortSignal }> = [];
  const writer = scopeDbTraceExportSummaryWriter("https://scope.example", "key", {
    table: (name: string, options?: { schema?: string }) => ({
      append: async (data: string, appendOptions?: { signal?: AbortSignal }) => {
        appends.push({ table: `${options?.schema}.${name}`, data, signal: appendOptions?.signal });
        return { status: "committed", num_rows_inserted: data.split("\n").length };
      },
    }),
  } as never);
  const h = harness();
  h.summary.exported("traces", 1, 1);
  h.summary.exported("logs", 2, 1);
  h.setNow("2026-10-24T08:46:00Z");
  await h.summary.report();
  const deadline = AbortSignal.timeout(1_000);
  await writer.write(h.writes[0]!, deadline);

  assert.equal(appends.length, 1);
  assert.equal(appends[0]!.table, "raft.trace_export_summary");
  assert.equal(appends[0]!.signal, deadline);
  assert.deepEqual(appends[0]!.data.split("\n").map((line) => JSON.parse(line).signal), ["traces", "logs"]);
});

test("Append lines encode timestamps as RFC 3339, counts as integer tokens and absent times as null", () => {
  const row = {
    window_start: "2026-10-24T08:45:00.000Z",
    window_end: "2026-10-24T08:46:00.000Z",
    window_s: 60,
    signal: "traces",
    exported: 64,
    exported_batches: 1,
    dropped_queue_full: 0,
    dropped_export_failed: 10,
    failed_batches: 1,
    timeout_batches: 1,
    timeout_first_at: "2026-10-24T08:45:31.250Z",
    timeout_last_at: "2026-10-24T08:45:31.250Z",
    network_batches: 0,
    network_first_at: null,
    network_last_at: null,
    http_429_batches: 0,
    http_429_first_at: null,
    http_429_last_at: null,
    http_4xx_batches: 0,
    http_4xx_first_at: null,
    http_4xx_last_at: null,
    http_5xx_batches: 0,
    http_5xx_first_at: null,
    http_5xx_last_at: null,
    last_http_status: null,
    max_queue_depth: 4096,
    export_ms_max: 3_001,
    self_write_failed: 0,
    service_name: "slock-server",
    service_version: "1.21.34",
    service_revision: null,
    service_instance_id: null,
    ecs_task_id: null,
    deployment_environment: "production",
  } satisfies TraceExportSummaryRow;
  assert.equal(traceExportSummaryAppendLine(row), JSON.stringify(row));
  assert.equal(
    traceExportSummaryAppendLine({ ...row, export_ms_max: 3_001.6, extra: "dropped" } as TraceExportSummaryRow),
    JSON.stringify({ ...row, export_ms_max: 3_001 }),
  );
});

test("the Append columns name every row field, and only those", async () => {
  const h = harness();
  h.summary.exported("traces", 1, 1);
  h.setNow("2026-10-24T08:46:00Z");
  await h.summary.report();
  const rowKeys = Object.keys(h.writes[0]![0]!).sort();
  assert.deepEqual(TRACE_EXPORT_SUMMARY_COLUMNS.map(([column]) => column).sort(), rowKeys);
});
