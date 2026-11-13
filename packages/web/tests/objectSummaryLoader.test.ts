// The first-party object summary loader (src/objects/objectSummaryLoader.ts):
// every caller's lookups in the same few milliseconds go out as one
// `POST /api/objects/summaries` per (server, kind), each reference once, at
// most OBJECT_SUMMARIES_MAX_REFS a request; answers are kept briefly per page;
// failures are not kept, and a 429 holds the next request for its Retry-After.
import assert from "node:assert/strict";
import "./helpers/domSetup";
import { afterEach, beforeEach, test, vi } from "vitest";
import type { AxiosAdapter, InternalAxiosRequestConfig } from "axios";
import { OBJECT_SUMMARIES_MAX_REFS } from "@botiverse/raft-shared";
import type { ArtifactObjectRef, ObjectSummaries, ObjectSummariesInput } from "@botiverse/raft-shared";

import api from "../src/api/client";
import {
  OBJECT_SUMMARY_BATCH_WINDOW_MS,
  OBJECT_SUMMARY_OK_TTL_MS,
  OBJECT_SUMMARY_UNAVAILABLE_TTL_MS,
  clearObjectSummaries,
  createObjectSummaryLoader,
  invalidateObjectSummary,
  loadObjectSummaries,
  objectRefKey,
} from "../src/objects/objectSummaryLoader";
import type { ObjectSummaryLoader } from "../src/objects/objectSummaryLoader";
import { useAuthStore } from "../src/store/authStore";
import { useServerStore } from "../src/store/serverStore";

/** An unsigned access token for `sub` (the client reads only its claims). */
const accessTokenFor = (sub: string) => `h.${globalThis.btoa(JSON.stringify({ sub, type: "access" })).replace(/=+$/, "")}.s`;

type Sent = { serverId: string | null; input: ObjectSummariesInput };
let sent: Sent[] = [];
/** Which ids the fake server says are visible; the rest are `unavailable`. */
let hidden = new Set<string>();
let fail: ((input: ObjectSummariesInput) => unknown) | null = null;
let loader: ObjectSummaryLoader;

function answer(input: ObjectSummariesInput): ObjectSummaries {
  return {
    kind: input.kind,
    summaries: input.refs.map((ref) => (hidden.has(ref.id)
      ? { ref, ok: false as const, reason: "unavailable" as const }
      : { ref, ok: true as const, summary: { id: ref.id, title: `card ${ref.id}`, version: ref.version ?? 9 } as never })),
  };
}

beforeEach(() => {
  vi.useFakeTimers();
  sent = [];
  hidden = new Set();
  fail = null;
  loader = createObjectSummaryLoader({
    post: async (serverId, input) => {
      sent.push({ serverId, input });
      if (fail) throw fail(input);
      return answer(input);
    },
  });
});

afterEach(() => {
  vi.useRealTimers();
});

const ref = (id: string, version?: number): ArtifactObjectRef => (version === undefined ? { id: id as never } : { id: id as never, version });

/** Lets the batch window pass and the requests answer. */
async function settle(ms = OBJECT_SUMMARY_BATCH_WINDOW_MS) {
  await vi.advanceTimersByTimeAsync(ms);
}

test("N callers in the same tick (one message each): one request for all of their refs", async () => {
  const calls = Array.from({ length: 5 }, (_, i) => loader.load("s1", "artifact", [ref(`a${i}`), ref("shared")]));
  await settle();
  const results = await Promise.all(calls);
  assert.equal(sent.length, 1);
  assert.deepEqual(sent[0], { serverId: "s1", input: { kind: "artifact", refs: [ref("a0"), ref("shared"), ref("a1"), ref("a2"), ref("a3"), ref("a4")] } });
  results.forEach((result, i) => {
    assert.deepEqual([...result.keys()], [objectRefKey(ref(`a${i}`)), objectRefKey(ref("shared"))], "each caller gets its own refs, in its order");
    const card = result.get(objectRefKey(ref(`a${i}`)));
    assert.ok(card?.status === "ok" && card.summary.id === `a${i}`);
  });
});

test("the same ref twice (one caller or several) is asked once; latest and a pinned version are different refs", async () => {
  const first = loader.load("s1", "artifact", [ref("x"), ref("x"), ref("x", 2)]);
  const second = loader.load("s1", "artifact", [ref("x", 2)]);
  await settle();
  await Promise.all([first, second]);
  assert.deepEqual(sent.map((s) => s.input.refs), [[ref("x"), ref("x", 2)]]);
  assert.equal((await first).size, 2);
  assert.notEqual(objectRefKey(ref("x")), objectRefKey(ref("x", 2)));
  assert.equal(objectRefKey({ id: "x", version: undefined } as never), objectRefKey(ref("x")), "an undefined field is no field");
});

test("callers on different servers go in different requests, each naming its server", async () => {
  const a = loader.load("s1", "artifact", [ref("x")]);
  const b = loader.load("s2", "artifact", [ref("x")]);
  await settle();
  await Promise.all([a, b]);
  assert.deepEqual(sent.map((s) => [s.serverId, s.input.refs.length]), [["s1", 1], ["s2", 1]]);
});

test("asked again within the TTL: no request, and peek answers synchronously; after the TTL: asked again", async () => {
  hidden.add("gone");
  const first = loader.load("s1", "artifact", [ref("x"), ref("gone")]);
  await settle();
  await first;
  assert.equal(sent.length, 1);

  const peeked = loader.peek("s1", "artifact", [ref("x"), ref("gone")]);
  assert.ok(peeked, "all cached");
  assert.equal(peeked.get(objectRefKey(ref("gone")))?.status, "unavailable");
  assert.equal(loader.peek("s1", "artifact", [ref("x"), ref("other")]), null, "one missing: nothing to peek");

  const again = await loader.load("s1", "artifact", [ref("x"), ref("gone")]);
  assert.equal(sent.length, 1, "remount within the TTL: no request");
  assert.equal(again.get(objectRefKey(ref("x")))?.status, "ok");

  // `unavailable` is kept for a shorter time than a card.
  await settle(OBJECT_SUMMARY_UNAVAILABLE_TTL_MS + 1);
  const later = loader.load("s1", "artifact", [ref("x"), ref("gone")]);
  await settle();
  await later;
  assert.deepEqual(sent.map((s) => s.input.refs), [[ref("x"), ref("gone")], [ref("gone")]], "only the unavailable one expired");

  await settle(OBJECT_SUMMARY_OK_TTL_MS);
  const expired = loader.load("s1", "artifact", [ref("x")]);
  await settle();
  await expired;
  assert.deepEqual(sent.at(-1)!.input.refs, [ref("x")], "after the TTL: asked again");
});

test("a load while the same ref's request is out waits on that request", async () => {
  let release!: () => void;
  const held = new Promise<void>((resolve) => { release = resolve; });
  const slow = createObjectSummaryLoader({ post: async (serverId, input) => { sent.push({ serverId, input }); await held; return answer(input); } });
  const a = slow.load("s1", "artifact", [ref("y")]);
  await settle();
  const b = slow.load("s1", "artifact", [ref("y")]);
  await settle();
  release();
  const [ra, rb] = await Promise.all([a, b]);
  assert.equal(sent.length, 1, "the second waits on the first's request");
  assert.deepEqual(ra.get(objectRefKey(ref("y"))), rb.get(objectRefKey(ref("y"))));
});

test("more refs than OBJECT_SUMMARIES_MAX_REFS: requests of at most that many, every ref once, in order", async () => {
  const refs = Array.from({ length: 2 * OBJECT_SUMMARIES_MAX_REFS + 3 }, (_, i) => ref(`r${i}`));
  const half = Math.floor(refs.length / 2);
  const a = loader.load("s1", "artifact", refs.slice(0, half));
  const b = loader.load("s1", "artifact", refs.slice(half));
  await settle();
  const [ra, rb] = await Promise.all([a, b]);
  assert.deepEqual(sent.map((s) => s.input.refs.length), [OBJECT_SUMMARIES_MAX_REFS, OBJECT_SUMMARIES_MAX_REFS, 3]);
  assert.deepEqual(sent.flatMap((s) => s.input.refs), refs);
  assert.equal(ra.size + rb.size, refs.length);
});

test("an answer is matched by the ref it echoes; a ref left unanswered is unavailable, and not kept", async () => {
  const reversed = createObjectSummaryLoader({
    post: async (serverId, input) => {
      sent.push({ serverId, input });
      const data = answer(input);
      return { ...data, summaries: data.summaries.filter((s) => s.ref.id !== "skipped").reverse() };
    },
  });
  const call = reversed.load("s1", "artifact", [ref("x", 1), ref("x", 2), ref("skipped")]);
  await settle();
  const result = await call;
  const v1 = result.get(objectRefKey(ref("x", 1)));
  const v2 = result.get(objectRefKey(ref("x", 2)));
  assert.ok(v1?.status === "ok" && v1.summary.version === 1);
  assert.ok(v2?.status === "ok" && v2.summary.version === 2);
  assert.equal(result.get(objectRefKey(ref("skipped")))?.status, "unavailable");
  assert.equal(reversed.peek("s1", "artifact", [ref("skipped")]), null);
});

test("a failed batch: each caller's refs are `error`, nothing is kept, and the next load asks again", async () => {
  fail = () => Object.assign(new Error("HTTP 500"), { response: { status: 500, headers: {} } });
  const a = loader.load("s1", "artifact", [ref("x")]);
  const b = loader.load("s1", "artifact", [ref("y")]);
  await settle();
  const [ra, rb] = await Promise.all([a, b]);
  assert.equal(sent.length, 1);
  const ex = ra.get(objectRefKey(ref("x")));
  assert.ok(ex?.status === "error" && ex.retryAfterMs === null);
  assert.deepEqual(ex.error, { status: 500, code: null }, "translated at the loader");
  assert.equal(rb.get(objectRefKey(ref("y")))?.status, "error");
  assert.equal(loader.peek("s1", "artifact", [ref("x")]), null);

  fail = null;
  const retry = loader.load("s1", "artifact", [ref("x")]);
  await settle();
  assert.equal((await retry).get(objectRefKey(ref("x")))?.status, "ok");
  assert.equal(sent.length, 2, "asked again at once");
});

test("429: the callers get `error` with the Retry-After; the server's next request waits for it", async () => {
  fail = () => Object.assign(new Error("HTTP 429"), { response: { status: 429, headers: { "retry-after": "3" }, data: { code: "RATE_LIMITED" } } });
  const first = loader.load("s1", "artifact", [ref("x")]);
  await settle();
  const limited = (await first).get(objectRefKey(ref("x")));
  assert.ok(limited?.status === "error" && limited.retryAfterMs === 3_000);
  assert.deepEqual(limited.error, { status: 429, code: "RATE_LIMITED" });

  fail = null;
  const next = loader.load("s1", "artifact", [ref("x")]);
  const otherServer = loader.load("s2", "artifact", [ref("x")]);
  await settle();
  await otherServer;
  assert.deepEqual(sent.map((s) => s.serverId), ["s1", "s2"], "another server is not held");
  await settle(2_000);
  assert.equal(sent.length, 2, "held until Retry-After");
  await settle(1_000);
  assert.equal((await next).get(objectRefKey(ref("x")))?.status, "ok");
  assert.deepEqual(sent.map((s) => s.serverId), ["s1", "s2", "s1"]);
});

test("429 with Retry-After: 0 still waits a second (no tight retry loop)", async () => {
  fail = () => Object.assign(new Error("HTTP 429"), { response: { status: 429, headers: { "retry-after": "0" } } });
  const first = loader.load("s1", "artifact", [ref("x")]);
  await settle();
  const limited = (await first).get(objectRefKey(ref("x")));
  assert.ok(limited?.status === "error" && limited.retryAfterMs === 1_000);

  fail = null;
  const next = loader.load("s1", "artifact", [ref("x")]);
  await settle(500);
  assert.equal(sent.length, 1, "held");
  await settle(500);
  assert.equal((await next).get(objectRefKey(ref("x")))?.status, "ok");
});

test("a network failure (no response) is `error` with neither status nor code", async () => {
  fail = () => new Error("Network Error");
  const first = loader.load("s1", "artifact", [ref("x")]);
  await settle();
  const failed = (await first).get(objectRefKey(ref("x")));
  assert.ok(failed?.status === "error");
  assert.deepEqual(failed.error, { status: null, code: null });
});

test("invalidate(kind, id) drops that object (every version) and tells subscribers; other objects stay", async () => {
  const changes: unknown[] = [];
  loader.subscribe((change) => changes.push(change));
  const first = loader.load("s1", "artifact", [ref("x"), ref("x", 2), ref("y")]);
  await settle();
  await first;
  loader.invalidate({ kind: "artifact", id: "x" });
  assert.deepEqual(changes, [{ kind: "artifact", id: "x" }]);
  assert.equal(loader.peek("s1", "artifact", [ref("x")]), null);
  assert.equal(loader.peek("s1", "artifact", [ref("x", 2)]), null);
  assert.ok(loader.peek("s1", "artifact", [ref("y")]));

  const again = loader.load("s1", "artifact", [ref("x"), ref("y")]);
  await settle();
  await again;
  assert.deepEqual(sent.at(-1)!.input.refs, [ref("x")]);
});

test("invalidate with `ref` drops that one reference; the object's other references stay", async () => {
  const first = loader.load("s1", "artifact", [ref("x"), ref("x", 2)]);
  await settle();
  await first;
  loader.invalidate({ serverId: "s1", kind: "artifact", id: "x", ref: ref("x") });
  assert.equal(loader.peek("s1", "artifact", [ref("x")]), null);
  assert.ok(loader.peek("s1", "artifact", [ref("x", 2)]), "the pinned version stays kept");
});

test("an answer to a request sent before an invalidation is delivered but not kept", async () => {
  let release!: () => void;
  const held = new Promise<void>((resolve) => { release = resolve; });
  const slow = createObjectSummaryLoader({ post: async (serverId, input) => { sent.push({ serverId, input }); await held; return answer(input); } });
  const call = slow.load("s1", "artifact", [ref("x")]);
  await settle();
  slow.invalidate({ serverId: "s1" });
  release();
  assert.equal((await call).get(objectRefKey(ref("x")))?.status, "ok");
  assert.equal(slow.peek("s1", "artifact", [ref("x")]), null);
});

test("the cache is bounded: the least recently used goes first", async () => {
  const small = createObjectSummaryLoader({ post: async (_serverId, input) => answer(input), maxEntries: 2 });
  const first = small.load("s1", "artifact", [ref("a"), ref("b")]);
  await settle();
  await first;
  assert.ok(small.peek("s1", "artifact", [ref("a")]), "a used: b is now the oldest");
  const second = small.load("s1", "artifact", [ref("c")]);
  await settle();
  await second;
  assert.ok(small.peek("s1", "artifact", [ref("a")]));
  assert.ok(small.peek("s1", "artifact", [ref("c")]));
  assert.equal(small.peek("s1", "artifact", [ref("b")]), null);
});

// ---- the page's own loader: the web API client, the current server ----

let requests: Array<{ url: string; serverId: unknown; data: ObjectSummariesInput }> = [];
const originalAdapter = api.defaults.adapter;

function useApi() {
  requests = [];
  api.defaults.adapter = (async (config: InternalAxiosRequestConfig) => {
    const data = JSON.parse(config.data as string) as ObjectSummariesInput;
    requests.push({ url: config.url ?? "", serverId: config.headers["X-Server-Id"], data });
    return { status: 200, statusText: "OK", data: answer(data), headers: {}, config, request: {} };
  }) as AxiosAdapter;
}

test("the page's loader posts to core's summaries route with the server it was given; switching servers clears it", async () => {
  useApi();
  try {
    clearObjectSummaries();
    useServerStore.setState({ current: { id: "srv-a", slug: "a" } } as never);
    const first = loadObjectSummaries("srv-a", "artifact", [ref("x")]);
    await settle();
    await first;
    assert.deepEqual(requests, [{ url: "/objects/summaries", serverId: "srv-a", data: { kind: "artifact", refs: [ref("x")] } }]);

    await loadObjectSummaries("srv-a", "artifact", [ref("x")]);
    assert.equal(requests.length, 1, "kept");

    invalidateObjectSummary("artifact", "x");
    const afterInvalidate = loadObjectSummaries("srv-a", "artifact", [ref("x")]);
    await settle();
    await afterInvalidate;
    assert.equal(requests.length, 2, "invalidated: asked again");

    useServerStore.setState({ current: { id: "srv-b", slug: "b" } } as never);
    useServerStore.setState({ current: { id: "srv-a", slug: "a" } } as never);
    const afterSwitch = loadObjectSummaries("srv-a", "artifact", [ref("x")]);
    await settle();
    await afterSwitch;
    assert.equal(requests.length, 3, "a server switch cleared it");

    // Another person's tokens arrive (another tab), same server: not their cards.
    useAuthStore.setState({ accessToken: accessTokenFor("user-1") });
    const asOne = loadObjectSummaries("srv-a", "artifact", [ref("x")]);
    await settle();
    await asOne;
    assert.equal(requests.length, 4, "the first token's person: cleared from the anonymous state");
    useAuthStore.setState({ accessToken: accessTokenFor("user-1") });
    await loadObjectSummaries("srv-a", "artifact", [ref("x")]);
    assert.equal(requests.length, 4, "the same person's new token: still kept");
    useAuthStore.setState({ accessToken: accessTokenFor("user-2") });
    const asTwo = loadObjectSummaries("srv-a", "artifact", [ref("x")]);
    await settle();
    await asTwo;
    assert.equal(requests.length, 5, "another person: cleared");
  } finally {
    api.defaults.adapter = originalAdapter;
    useAuthStore.setState({ accessToken: null });
    useServerStore.setState({ current: null } as never);
    clearObjectSummaries();
  }
});
