import assert from "node:assert/strict";
import { test } from "vitest";
import { getLatestComputerVersion, resolveComputerUpgradeAvailable, __resetLatestComputerVersionForTest } from "./computerVersionService.js";

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((res) => {
    resolve = res;
  });
  return { promise, resolve };
}

test("getLatestComputerVersion returns stale cache immediately and refreshes in background", async () => {
  __resetLatestComputerVersionForTest();
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
    assert.equal(await getLatestComputerVersion(), null);
    assert.deepEqual(fetchCalls, ["https://cdn.raft.build/computer/manifest.json"]);

    firstFetch.resolve(new Response(JSON.stringify({ version: "0.0.62" }), {
      status: 200,
      headers: { "Content-Type": "application/json" },
    }));
    await new Promise((resolve) => setImmediate(resolve));

    assert.equal(await getLatestComputerVersion(), "0.0.62");
    assert.equal(fetchCalls.length, 1);

    __resetLatestComputerVersionForTest();
    assert.equal(await getLatestComputerVersion(), null);
    assert.equal(fetchCalls.length, 2);
    secondFetch.resolve(new Response(JSON.stringify({ version: "0.0.63" }), {
      status: 200,
      headers: { "Content-Type": "application/json" },
    }));
    await new Promise((resolve) => setImmediate(resolve));

    assert.equal(await getLatestComputerVersion(), "0.0.63");
  } finally {
    globalThis.fetch = originalFetch;
    __resetLatestComputerVersionForTest();
  }
});

test("getLatestComputerVersion coalesces concurrent cold refreshes", async () => {
  __resetLatestComputerVersionForTest();
  const originalFetch = globalThis.fetch;
  const firstFetch = deferred<Response>();
  let fetchCount = 0;
  globalThis.fetch = (async () => {
    fetchCount += 1;
    return firstFetch.promise;
  }) as typeof fetch;

  try {
    assert.equal(await getLatestComputerVersion(), null);
    assert.equal(await getLatestComputerVersion(), null);
    assert.equal(fetchCount, 1);

    firstFetch.resolve(new Response(JSON.stringify({ version: "0.0.62" }), {
      status: 200,
      headers: { "Content-Type": "application/json" },
    }));
    await new Promise((resolve) => setImmediate(resolve));

    assert.equal(await getLatestComputerVersion(), "0.0.62");
    assert.equal(fetchCount, 1);
  } finally {
    globalThis.fetch = originalFetch;
    __resetLatestComputerVersionForTest();
  }
});

test("getLatestComputerVersion swallows network/CDN errors and keeps the last cached value", async () => {
  __resetLatestComputerVersionForTest();
  const originalFetch = globalThis.fetch;

  // Seed a cached value via a successful fetch.
  globalThis.fetch = (async () =>
    new Response(JSON.stringify({ version: "0.0.62" }), {
      status: 200,
      headers: { "Content-Type": "application/json" },
    })) as typeof fetch;
  await getLatestComputerVersion();
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(await getLatestComputerVersion(), "0.0.62");

  // Force expiry, then make subsequent fetches throw — cached value must
  // survive (best-effort registry, not a critical path).
  __resetLatestComputerVersionForTest();
  globalThis.fetch = (async () =>
    new Response(JSON.stringify({ version: "0.0.63" }), {
      status: 200,
      headers: { "Content-Type": "application/json" },
    })) as typeof fetch;
  await getLatestComputerVersion();
  await new Promise((resolve) => setImmediate(resolve));

  globalThis.fetch = (async () => {
    throw new Error("network down");
  }) as typeof fetch;
  // Inside the cache window, getLatestComputerVersion does not refetch, so
  // the broken fetch is irrelevant — value is still 0.0.63.
  assert.equal(await getLatestComputerVersion(), "0.0.63");

  globalThis.fetch = originalFetch;
  __resetLatestComputerVersionForTest();
});

test("resolveComputerUpgradeAvailable: server asserts available/up-to-date/unknown states", () => {
  assert.equal(resolveComputerUpgradeAvailable(true, "0.0.61", "0.0.62"), true);
  assert.equal(resolveComputerUpgradeAvailable(true, "0.0.62", "0.0.62"), false);
  assert.equal(resolveComputerUpgradeAvailable(true, "0.0.63", "0.0.62"), false);

  assert.equal(resolveComputerUpgradeAvailable(false, "0.0.61", "0.0.62"), null);
  assert.equal(resolveComputerUpgradeAvailable(true, null, "0.0.62"), null);
  assert.equal(resolveComputerUpgradeAvailable(true, "0.0.61", null), null);
  assert.equal(resolveComputerUpgradeAvailable(true, "0.0.62-rc1", "0.0.62"), null);
  assert.equal(resolveComputerUpgradeAvailable(true, "0.0.62", "latest"), null);
});
