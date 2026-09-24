import assert from "node:assert/strict";
import { test } from "vitest";
import { getLatestDaemonVersion, __resetLatestDaemonVersionForTest } from "./daemonVersionService.js";

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((res) => {
    resolve = res;
  });
  return { promise, resolve };
}

test("getLatestDaemonVersion returns stale cache immediately and refreshes in background", async () => {
  __resetLatestDaemonVersionForTest();
  const originalFetch = globalThis.fetch;
  const firstFetch = deferred<Response>();
  const secondFetch = deferred<Response>();
  const fetchCalls: string[] = [];
  globalThis.fetch = (async (input: RequestInfo | URL) => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
    fetchCalls.push(url);
    return fetchCalls.length === 1 ? firstFetch.promise : secondFetch.promise;
  }) as typeof fetch;

  try {
    assert.equal(await getLatestDaemonVersion(), null);
    assert.deepEqual(fetchCalls, ["https://registry.npmjs.org/@botiverse/raft-daemon/latest"]);

    firstFetch.resolve(new Response(JSON.stringify({ version: "0.42.0" }), {
      status: 200,
      headers: { "Content-Type": "application/json" },
    }));
    await new Promise((resolve) => setImmediate(resolve));

    assert.equal(await getLatestDaemonVersion(), "0.42.0");
    assert.equal(fetchCalls.length, 1);

    __resetLatestDaemonVersionForTest();
    assert.equal(await getLatestDaemonVersion(), null);
    assert.equal(fetchCalls.length, 2);
    secondFetch.resolve(new Response(JSON.stringify({ version: "0.43.0" }), {
      status: 200,
      headers: { "Content-Type": "application/json" },
    }));
    await new Promise((resolve) => setImmediate(resolve));

    assert.equal(await getLatestDaemonVersion(), "0.43.0");
  } finally {
    globalThis.fetch = originalFetch;
    __resetLatestDaemonVersionForTest();
  }
});

test("getLatestDaemonVersion coalesces concurrent cold refreshes", async () => {
  __resetLatestDaemonVersionForTest();
  const originalFetch = globalThis.fetch;
  const firstFetch = deferred<Response>();
  let fetchCount = 0;
  globalThis.fetch = (async () => {
    fetchCount += 1;
    return firstFetch.promise;
  }) as typeof fetch;

  try {
    assert.equal(await getLatestDaemonVersion(), null);
    assert.equal(await getLatestDaemonVersion(), null);
    assert.equal(fetchCount, 1);

    firstFetch.resolve(new Response(JSON.stringify({ version: "0.42.1" }), {
      status: 200,
      headers: { "Content-Type": "application/json" },
    }));
    await new Promise((resolve) => setImmediate(resolve));

    assert.equal(await getLatestDaemonVersion(), "0.42.1");
    assert.equal(fetchCount, 1);
  } finally {
    globalThis.fetch = originalFetch;
    __resetLatestDaemonVersionForTest();
  }
});
