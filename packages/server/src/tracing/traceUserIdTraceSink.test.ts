import assert from "node:assert/strict";
import { afterEach, beforeEach, test } from "vitest";
import { BasicTracer, MemoryTraceSink, type TraceLogEvent } from "@botiverse/raft-shared";
import { __traceUserIdForTests as cache, cachedTraceUserId, forgetTraceUserId, rememberTraceUserId } from "./traceUserId";
import { TraceUserIdTraceSink } from "./traceUserIdTraceSink";

const USER_ID = "0b1c2d3e-4f50-4617-8a9b-0c1d2e3f4a5b";
const TRACE_USER_ID = "9f8e7d6c-5b4a-4392-8180-7f6e5d4c3b2a";

let loads: string[][] = [];
beforeEach(() => {
  cache.reset();
  loads = [];
  cache.setLoader(async (ids) => {
    loads.push([...ids]);
    return new Map(ids.filter((id) => id === USER_ID).map((id) => [id, TRACE_USER_ID]));
  });
});
afterEach(() => {
  cache.setLoader(null);
  cache.setNow(null);
  cache.reset();
});

function exportedSpan(attrs: Record<string, string>, eventAttrs?: Record<string, string>) {
  const memory = new MemoryTraceSink();
  const tracer = new BasicTracer({ sink: new TraceUserIdTraceSink(memory) });
  const span = tracer.startSpan("server.http.request", { surface: "server", kind: "server", attrs });
  if (eventAttrs) span.addEvent("auth.refresh.completed", eventAttrs);
  span.addEvent("http.response.finished", { status_bucket: "2xx" });
  span.end();
  return memory.getAllSpans()[0]!;
}

test("a cached user exports as trace_user_id on the span and its events; the raw id never leaves", () => {
  rememberTraceUserId(USER_ID, TRACE_USER_ID);
  const out = exportedSpan({ user_id: USER_ID, method: "GET" }, { user_id: USER_ID, session_id: "session-1" });
  assert.deepEqual(out.attrs, { method: "GET", trace_user_id: TRACE_USER_ID });
  assert.deepEqual(out.events[0]!.attrs, { session_id: "session-1", trace_user_id: TRACE_USER_ID });
  assert.deepEqual(out.events[1]!.attrs, { status_bucket: "2xx" }, "attrs without a user id are untouched");
  assert.ok(!JSON.stringify(out).includes(USER_ID));
  assert.deepEqual(loads, [], "a cached user needs no load");
});

test("a cache miss drops the attribute, loads in the background, and later spans carry it", async () => {
  const first = exportedSpan({ user_id: USER_ID, method: "GET" });
  assert.deepEqual(first.attrs, { method: "GET" });
  assert.ok(!JSON.stringify(first).includes(USER_ID));
  await cache.flush();
  assert.deepEqual(loads, [[USER_ID]]);
  assert.deepEqual(exportedSpan({ user_id: USER_ID }).attrs, { trace_user_id: TRACE_USER_ID });
});

test("an unknown user (no trace_user_id yet) stays without the attribute", async () => {
  const other = "11111111-2222-4333-8444-555555555555";
  exportedSpan({ user_id: other });
  await cache.flush();
  assert.deepEqual(exportedSpan({ user_id: other }).attrs, {});
});

test("entries expire, and forgetting one (rotation) drops it at once", () => {
  let clock = 1_000;
  cache.setNow(() => clock);
  rememberTraceUserId(USER_ID, TRACE_USER_ID);
  assert.equal(cachedTraceUserId(USER_ID), TRACE_USER_ID);
  clock += 10 * 60_000 + 1;
  assert.equal(cachedTraceUserId(USER_ID), undefined, "expired after 10 minutes");
  rememberTraceUserId(USER_ID, TRACE_USER_ID);
  forgetTraceUserId(USER_ID);
  assert.equal(cachedTraceUserId(USER_ID), undefined);
});

test("a user still producing spans is reloaded before expiry, so no span loses the key", async () => {
  let clock = 1_000;
  cache.setNow(() => clock);
  rememberTraceUserId(USER_ID, TRACE_USER_ID);
  clock += 4 * 60_000;
  assert.equal(cachedTraceUserId(USER_ID), TRACE_USER_ID);
  await cache.flush();
  assert.deepEqual(loads, [], "no reload in the first half of the TTL");
  clock += 2 * 60_000; // 6 minutes old: past half
  assert.equal(cachedTraceUserId(USER_ID), TRACE_USER_ID, "still served while the reload runs");
  await cache.flush();
  assert.deepEqual(loads, [[USER_ID]]);
  clock += 5 * 60_000; // 11 minutes after the first remember: expired without the reload
  assert.deepEqual(exportedSpan({ user_id: USER_ID }).attrs, { trace_user_id: TRACE_USER_ID });
});

test("a load in flight when the user is forgotten does not write its old value back", async () => {
  // The rotation: the load reads the old trace id, then the account is retired
  // (new trace id committed, forgetTraceUserId), then the load resolves.
  let release!: () => void;
  const gate = new Promise<void>((resolve) => { release = resolve; });
  cache.setLoader(async (ids) => {
    loads.push([...ids]);
    await gate;
    return new Map(ids.map((id) => [id, TRACE_USER_ID]));
  });
  assert.equal(cachedTraceUserId(USER_ID), undefined, "a miss queues the load");
  const inFlight = cache.flush();
  forgetTraceUserId(USER_ID);
  release();
  await inFlight;
  assert.equal(cachedTraceUserId(USER_ID), undefined, "the stale value was discarded");

  // A load asked for after the forget is kept: it reads the rotated value.
  const ROTATED = "5a4b3c2d-1e0f-4a9b-8c7d-6e5f4a3b2c1d";
  cache.setLoader(async (ids) => new Map(ids.map((id) => [id, ROTATED])));
  await cache.flush();
  assert.equal(cachedTraceUserId(USER_ID), ROTATED);
});

test("forgetting one user does not discard another user's load in the same batch", async () => {
  const OTHER = "11111111-2222-4333-8444-555555555555";
  const OTHER_TRACE = "66666666-7777-4888-8999-aaaaaaaaaaaa";
  let release!: () => void;
  const gate = new Promise<void>((resolve) => { release = resolve; });
  cache.setLoader(async (ids) => {
    await gate;
    return new Map(ids.map((id) => [id, id === OTHER ? OTHER_TRACE : TRACE_USER_ID]));
  });
  cachedTraceUserId(USER_ID);
  cachedTraceUserId(OTHER);
  const inFlight = cache.flush();
  forgetTraceUserId(USER_ID);
  release();
  await inFlight;
  assert.equal(cachedTraceUserId(OTHER), OTHER_TRACE);
  assert.equal(cachedTraceUserId(USER_ID), undefined);
});

test("log events are rewritten too", () => {
  rememberTraceUserId(USER_ID, TRACE_USER_ID);
  const logs: TraceLogEvent[] = [];
  const sink = new TraceUserIdTraceSink({ record: () => undefined, recordLogEvent: (event) => { logs.push(event); } });
  sink.recordLogEvent({ name: "push.registration.unbound", timeMs: 1, surface: "server", context: null, attrs: { user_id: USER_ID, unbound_count: 1 } });
  assert.deepEqual(logs[0]!.attrs, { unbound_count: 1, trace_user_id: TRACE_USER_ID });
});
