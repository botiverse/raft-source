import { tokenForHuman } from "../test/integration/credentials";
import { createApiTest } from "../test/integration/apiTest";
import assert from "node:assert/strict";

import { BasicTracer, MemoryTraceSink } from "@botiverse/raft-shared";
import { RisingWaveOverloadedError } from "../db/risingwave";
import { risingWaveUnavailableResponsesTotal } from "../metrics";
import { installRisingWaveReadReferences, uninstallRisingWaveReadReferences } from "../test/risingWaveReadReference";
import { __testRisingWaveInbox, addHuman, createChannel } from "../services/channelService";
import { createServer, headers, seedUser } from "./channels.api.fixtures";
import { __setStaleReadStoreForTests, STALE_RESPONSE_HEADER } from "./rwStaleRead";
import { getWebCorsOrigins } from "../config/appUrl";

const test = createApiTest();

// task #162: GET /api/channels/unread answers each RisingWave failure with its
// own status and code; only a failure that is not RisingWave's stays 500.
async function seedReader(label: string) {
  const owner = await seedUser(`unread-rw-${label}@slock.test`, `unread-rw-${label}`);
  const server = await createServer(`Unread RW ${label}`, `unread-rw-${label}`, owner.id);
  const channel = await createChannel(server.id, `unread-rw-${label}`);
  await addHuman(channel.id, owner.id);
  return { serverId: server.id, token: await tokenForHuman(owner.email) };
}

async function counterValue(code: string): Promise<number> {
  return (await risingWaveUnavailableResponsesTotal.get()).values
    .find((value) => value.labels.code === code && value.labels.route_pattern === "/api/channels/unread")?.value ?? 0;
}

function useTracer(app: { app: { set(name: string, value: unknown): void } }) {
  const sink = new MemoryTraceSink();
  app.app.set("serverTracer", new BasicTracer({
    sink,
    traceIdGenerator: () => "6".repeat(32),
    spanIdGenerator: (() => {
      let next = 1;
      return () => String(next++).padStart(16, "0");
    })(),
  }));
  return () => sink.getAllSpans().find((span) =>
    span.name === "server.http.request" && span.attrs?.route_pattern === "/api/channels/unread");
}

async function withRisingWave<T>(
  overrides: Parameters<typeof __testRisingWaveInbox.set>[0],
  fn: () => Promise<T>,
): Promise<T> {
  // Exercise the RisingWave reader itself: take the Postgres test reference away.
  uninstallRisingWaveReadReferences();
  __testRisingWaveInbox.set(overrides);
  try {
    return await fn();
  } finally {
    __testRisingWaveInbox.reset();
    installRisingWaveReadReferences();
  }
}

const configuredPool = () => ({}) as never;

for (const summary of [false, true]) {
  const path = summary ? "/api/channels/unread?summary=1" : "/api/channels/unread";

  test(`GET ${path}: a failed RisingWave query answers 502 rw_read_failed`, async ({ app }) => {
    const reader = await seedReader(summary ? "read-failed-summary" : "read-failed");
    const requestSpan = useTracer(app);
    const before = await counterValue("rw_read_failed");
    const res = await withRisingWave({
      getPool: configuredPool,
      query: (async () => { throw Object.assign(new Error("connect ECONNREFUSED 10.0.0.1:4566"), { code: "ECONNREFUSED" }); }) as never,
    }, () => fetch(`${app.baseUrl}${path}`, { headers: headers(reader.token, reader.serverId) }));

    assert.equal(res.status, 502);
    assert.equal(res.headers.get("retry-after"), null);
    assert.deepEqual(await res.json(), { error: "Read failed, retry shortly", code: "rw_read_failed", retryable: true });
    assert.equal(await counterValue("rw_read_failed") - before, 1);
    assert.equal(requestSpan()?.attrs?.error_code, "rw_read_failed");
  });

  test(`GET ${path}: RisingWave not configured answers 503 rw_unconfigured without Retry-After`, async ({ app }) => {
    const reader = await seedReader(summary ? "unconfigured-summary" : "unconfigured");
    const requestSpan = useTracer(app);
    const before = await counterValue("rw_unconfigured");
    const res = await withRisingWave({ getPool: () => null }, () =>
      fetch(`${app.baseUrl}${path}`, { headers: headers(reader.token, reader.serverId) }));

    assert.equal(res.status, 503);
    assert.equal(res.headers.get("retry-after"), null);
    assert.deepEqual(await res.json(), { error: "RisingWave is not configured", code: "rw_unconfigured", retryable: false });
    assert.equal(await counterValue("rw_unconfigured") - before, 1);
    assert.equal(requestSpan()?.attrs?.error_code, "rw_unconfigured");
  });
}

test("GET /api/channels/unread: an overloaded RisingWave pool keeps 503 rw_overloaded + Retry-After", async ({ app }) => {
  const reader = await seedReader("overloaded");
  const before = await counterValue("rw_overloaded");
  const res = await withRisingWave({
    getPool: configuredPool,
    query: (async () => { throw new RisingWaveOverloadedError(new Error("timeout exceeded when trying to connect")); }) as never,
  }, () => fetch(`${app.baseUrl}/api/channels/unread`, { headers: headers(reader.token, reader.serverId) }));

  assert.equal(res.status, 503);
  assert.equal(res.headers.get("retry-after"), "2");
  assert.deepEqual(await res.json(), { error: "Temporarily overloaded, retry shortly", code: "rw_overloaded", retryable: true });
  assert.equal(await counterValue("rw_overloaded") - before, 1);
});

test("GET /api/channels/unread: a bug after the RisingWave query returned stays 500", async ({ app }) => {
  const reader = await seedReader("mapping-bug");
  const before = await counterValue("rw_read_failed");
  const res = await withRisingWave({
    getPool: configuredPool,
    // The query succeeds; mapping its result throws (no `rows`), which is our bug.
    query: (async () => ({ result: null })) as never,
  }, () => fetch(`${app.baseUrl}/api/channels/unread`, { headers: headers(reader.token, reader.serverId) }));

  assert.equal(res.status, 500);
  assert.deepEqual(await res.json(), { error: "Failed to get unread counts" });
  assert.equal(await counterValue("rw_read_failed") - before, 0);
});

// RW overload degraded mode (routes/rwStaleRead.ts): with a remembered body,
// rw_overloaded answers 200 with that body marked stale; nothing else does.
function memoryStaleStore() {
  const entries = new Map<string, string>();
  return {
    entries,
    store: {
      get: async (key: string) => entries.get(key) ?? null,
      set: async (key: string, value: string) => { entries.set(key, value); },
    },
  };
}

const overloadedQuery = (async () => {
  throw new RisingWaveOverloadedError(new Error("timeout exceeded when trying to connect"));
}) as never;

for (const summary of [false, true]) {
  const path = summary ? "/api/channels/unread?summary=1" : "/api/channels/unread";

  test(`GET ${path}: rw_overloaded serves the user's last good body, marked stale`, async ({ app }) => {
    const reader = await seedReader(summary ? "stale-summary" : "stale");
    const other = await seedReader(summary ? "stale-other-summary" : "stale-other");
    const memory = memoryStaleStore();
    __setStaleReadStoreForTests(memory.store);
    try {
      const fresh = await fetch(`${app.baseUrl}${path}`, { headers: headers(reader.token, reader.serverId) });
      assert.equal(fresh.status, 200);
      assert.equal(fresh.headers.get("x-raft-stale"), null);
      const freshBody = await fresh.json() as Record<string, unknown>;
      // The remembering write is fire-and-forget; let it land.
      await new Promise((resolve) => setImmediate(resolve));
      assert.equal(memory.entries.size, 1);

      const res = await withRisingWave({ getPool: configuredPool, query: overloadedQuery }, () =>
        fetch(`${app.baseUrl}${path}`, { headers: headers(reader.token, reader.serverId) }));
      assert.equal(res.status, 200);
      assert.equal(res.headers.get("x-raft-stale"), "rw_overloaded");
      assert.deepEqual(await res.json(), summary ? { ...freshBody, stale: true } : freshBody);

      // Another user's overload never sees this user's body: no remembered body, so 503.
      const otherRes = await withRisingWave({ getPool: configuredPool, query: overloadedQuery }, () =>
        fetch(`${app.baseUrl}${path}`, { headers: headers(other.token, other.serverId) }));
      assert.equal(otherRes.status, 503);

      // Any other RisingWave failure keeps its own error even with a remembered body.
      const failed = await withRisingWave({
        getPool: configuredPool,
        query: (async () => { throw Object.assign(new Error("connect ECONNREFUSED 10.0.0.1:4566"), { code: "ECONNREFUSED" }); }) as never,
      }, () => fetch(`${app.baseUrl}${path}`, { headers: headers(reader.token, reader.serverId) }));
      assert.equal(failed.status, 502);
    } finally {
      __setStaleReadStoreForTests(undefined);
    }
  });
}

// task #164: the web app is cross-origin, so its script reads X-Raft-Stale and
// Retry-After only if CORS exposes them; without that it can never say the
// counts may be out of date, nor pace its retries by the server's hint.
test("GET /api/channels/unread: a stale answer exposes X-Raft-Stale and Retry-After to the web origin", async ({ app }) => {
  const reader = await seedReader("stale-cors");
  const memory = memoryStaleStore();
  __setStaleReadStoreForTests(memory.store);
  const origin = getWebCorsOrigins()[0];
  assert.ok(origin);
  try {
    const fresh = await fetch(`${app.baseUrl}/api/channels/unread`, { headers: { ...headers(reader.token, reader.serverId), Origin: origin } });
    assert.equal(fresh.status, 200);
    await new Promise((resolve) => setImmediate(resolve));
    const res = await withRisingWave({ getPool: configuredPool, query: overloadedQuery }, () =>
      fetch(`${app.baseUrl}/api/channels/unread`, { headers: { ...headers(reader.token, reader.serverId), Origin: origin } }));
    assert.equal(res.status, 200);
    assert.equal(res.headers.get("x-raft-stale"), "rw_overloaded");
    const exposed = (res.headers.get("access-control-expose-headers") ?? "").toLowerCase().split(/\s*,\s*/);
    assert.ok(exposed.includes(STALE_RESPONSE_HEADER.toLowerCase()), `exposed: ${exposed.join(",")}`);
    assert.ok(exposed.includes("retry-after"), `exposed: ${exposed.join(",")}`);
  } finally {
    __setStaleReadStoreForTests(undefined);
  }
});
