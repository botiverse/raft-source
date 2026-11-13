// ApiClient.requestRawBody (an Artifact upload's raw bytes) and the refusal
// body kept as errorBody, so `details` reach the CLI's text.
import assert from "node:assert/strict";
import { afterEach, beforeEach } from "vitest";

import type { AgentContext } from "./auth/env";
import { ApiClient, globalFetchJsonTransport, setJsonTransportForTests } from "./client";

let previousJsonTransport: ReturnType<typeof setJsonTransportForTests>;
beforeEach(() => { previousJsonTransport = setJsonTransportForTests(globalFetchJsonTransport); });
afterEach(() => { setJsonTransportForTests(previousJsonTransport); });

const ctx: AgentContext = {
  agentId: "agent-1",
  serverUrl: "http://localhost:9999",
  serverId: "server-1",
  token: "token-1",
  clientMode: "self-hosted-runner",
  secretSource: "profile-credential-file",
  activeCapabilities: null,
};

async function withFetch<T>(reply: Response, run: (calls: Array<{ url: string; init: RequestInit }>) => Promise<T>): Promise<T> {
  const original = globalThis.fetch;
  const calls: Array<{ url: string; init: RequestInit }> = [];
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    calls.push({ url: String(input), init: init ?? {} });
    return reply;
  }) as typeof fetch;
  try {
    return await run(calls);
  } finally {
    globalThis.fetch = original;
  }
}

test("requestRawBody PUTs the bytes as octet-stream with the agent's auth; 204 is ok", async () => {
  await withFetch(new Response(null, { status: 204 }), async (calls) => {
    const res = await new ApiClient(ctx).requestRawBody("PUT", "/internal/agent-api/artifacts/uploads/abc", new Uint8Array([1, 2, 3]));
    assert.equal(res.ok, true);
    assert.equal(calls.length, 1);
    assert.ok(calls[0]!.url.endsWith("/internal/agent-api/artifacts/uploads/abc"));
    assert.equal(calls[0]!.init.method, "PUT");
    const headers = new Headers(calls[0]!.init.headers);
    assert.equal(headers.get("content-type"), "application/octet-stream");
    assert.equal(headers.get("X-Agent-Id"), "agent-1");
    assert.deepEqual([...new Uint8Array(calls[0]!.init.body as Uint8Array)], [1, 2, 3]);
  });
});

test("a refusal keeps its code and its whole body (details) as errorBody", async () => {
  const body = { error: "too large", code: "FILE_TOO_LARGE", details: { path: "a.mp4", size: 20, limit: 15 } };
  await withFetch(new Response(JSON.stringify(body), { status: 413, headers: { "content-type": "application/json" } }), async () => {
    const res = await new ApiClient(ctx).requestRawBody("PUT", "/internal/agent-api/artifacts/uploads/abc", new Uint8Array([1]));
    assert.equal(res.ok, false);
    assert.equal(res.errorCode, "FILE_TOO_LARGE");
    assert.deepEqual(res.errorBody, body);
  });
});
