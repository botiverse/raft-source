/**
 * The trace id an error shows (#proj-o11y:#18): the server's X-Trace-Id wins,
 * the request's own traceparent is the fallback, and only a recent failure is
 * attached to an error toast.
 */

import { strict as assert } from "node:assert";
import {
  RECENT_FAILURE_MS,
  __resetFailedRequestTraceIdForTest,
  recentFailedRequestTraceId,
  recordFailedRequestTraceId,
  traceIdFromError,
  traceIdFromTraceparent,
} from "../src/utils/requestTraceId";

const SERVER_ID = "4bf92f3577b34da6a3ce929d0e0e4736";
const CLIENT_ID = "0af7651916cd43dd8448eb211c80319c";

test("traceparent parsing keeps only a valid, non-zero 32-hex trace id", () => {
  assert.equal(traceIdFromTraceparent(`00-${CLIENT_ID}-b7ad6b7169203331-01`), CLIENT_ID);
  assert.equal(traceIdFromTraceparent(`00-${"0".repeat(32)}-b7ad6b7169203331-01`), null);
  assert.equal(traceIdFromTraceparent("garbage"), null);
  assert.equal(traceIdFromTraceparent(undefined), null);
});

test("the server's X-Trace-Id wins over the request's traceparent", () => {
  const error = {
    response: { headers: { "x-trace-id": SERVER_ID } },
    config: { headers: { traceparent: `00-${CLIENT_ID}-b7ad6b7169203331-01` } },
  };
  assert.equal(traceIdFromError(error), SERVER_ID);
});

test("a request with no response falls back to its own traceparent; none at all gives null", () => {
  assert.equal(traceIdFromError({ config: { headers: { traceparent: `00-${CLIENT_ID}-b7ad6b7169203331-01` } } }), CLIENT_ID);
  assert.equal(traceIdFromError({ response: { headers: { "x-trace-id": "not-an-id" } } }), null);
  assert.equal(traceIdFromError(new Error("plain")), null);
  assert.equal(traceIdFromError(null), null);
});

test("axios-style headers with get() are read too", () => {
  const headers = { get: (name: string) => (name === "x-trace-id" ? SERVER_ID : undefined) };
  assert.equal(traceIdFromError({ response: { headers } }), SERVER_ID);
});

test("only a failure within the recent window is offered to an error toast", () => {
  __resetFailedRequestTraceIdForTest();
  assert.equal(recentFailedRequestTraceId(1_000), null);
  recordFailedRequestTraceId({ response: { headers: { "x-trace-id": SERVER_ID } } }, 1_000);
  assert.equal(recentFailedRequestTraceId(1_000 + RECENT_FAILURE_MS), SERVER_ID);
  assert.equal(recentFailedRequestTraceId(1_000 + RECENT_FAILURE_MS + 1), null);
  recordFailedRequestTraceId(new Error("no id"), 2_000);
  assert.equal(recentFailedRequestTraceId(2_000), SERVER_ID, "a failure without an id does not erase the last one");
  __resetFailedRequestTraceIdForTest();
});
