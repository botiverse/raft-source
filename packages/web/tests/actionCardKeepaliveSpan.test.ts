import assert from "node:assert/strict";
import type { CompletedTraceSpan } from "@botiverse/raft-shared";

// Modules this one imports read localStorage when loaded: a stub is in place before the import.
const memoryStorage = new Map<string, string>();
Object.defineProperty(globalThis, "localStorage", {
  configurable: true,
  value: {
    get length() { return memoryStorage.size; },
    clear: () => memoryStorage.clear(),
    getItem: (key: string) => memoryStorage.get(key) ?? null,
    key: (index: number) => [...memoryStorage.keys()][index] ?? null,
    removeItem: (key: string) => { memoryStorage.delete(key); },
    setItem: (key: string, value: string) => { memoryStorage.set(key, value); },
  },
});
const { executeActionCardKeepalive } = await import("../src/components/actions/actionCardKeepaliveExecute");
const { __setWebHttpClientTraceSinkForTest } = await import("../src/utils/webHttpClientTrace");

// The keepalive answer of a question card is a `fetch`, not the api client:
// its web.http.client span still carries the route template, and a request
// that got no response its closed error_code.

const MESSAGE_ID = "3f1c2b7e-9a4d-4c1e-8b2a-0d9e8f7a6b5c";

async function keepaliveSpan(fetchStub: typeof fetch): Promise<{ span: CompletedTraceSpan; error: unknown }> {
  const spans: CompletedTraceSpan[] = [];
  const originalFetch = globalThis.fetch;
  globalThis.fetch = fetchStub;
  __setWebHttpClientTraceSinkForTest({ record: (span) => { spans.push(span); } });
  let error: unknown;
  try {
    await executeActionCardKeepalive(MESSAGE_ID, 1, {} as never);
  } catch (err) {
    error = err;
  } finally {
    __setWebHttpClientTraceSinkForTest(null);
    globalThis.fetch = originalFetch;
  }
  const httpSpans = spans.filter((span) => span.name === "web.http.client");
  assert.equal(httpSpans.length, 1);
  return { span: httpSpans[0]!, error };
}

test("a keepalive answer that never reached the server: route template and error_code ERR_NETWORK", async () => {
  const failure = new TypeError("Failed to fetch");
  const { span, error } = await keepaliveSpan(async () => {
    throw failure;
  });
  assert.equal(error, failure, "the fetch rejection is rethrown as it was");
  assert.equal(span.attrs["http.route"], "/api/actions/:id/execute");
  assert.equal(span.attrs.error_code, "ERR_NETWORK");
  assert.equal(span.attrs.status_bucket, "network_error");
  assert.equal(JSON.stringify(span.attrs).includes(MESSAGE_ID), false, "the message id never reaches the span");
});

test("a keepalive answer that succeeded: route template, status, no error_code", async () => {
  const { span, error } = await keepaliveSpan(async () =>
    new Response(JSON.stringify({ ok: true }), { status: 200, headers: { "Content-Type": "application/json" } }));
  assert.equal(error, undefined);
  assert.equal(span.attrs["http.route"], "/api/actions/:id/execute");
  assert.equal(span.attrs.status_code, 200);
  assert.equal("error_code" in span.attrs, false);
});
