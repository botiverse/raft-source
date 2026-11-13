import assert from "node:assert/strict";
import api from "../src/api/client";
import { __setHeldReadClockForTest, createHeldRead } from "../src/store/heldRead";
import { useServerStore } from "../src/store/serverStore";
import { __resetMessageHistoryRequestsForTests } from "../src/store/messageStore";
import { __resetMessagePagePrefetchForTest, prefetchMessagePage } from "../src/store/messagePagePrefetch";
import { startingSyncHorizonSafe } from "../src/store/startingSyncHorizon";

// Fetch at click (#triage:8c0d2318): a read sent at the click is held for the
// view's loader: taken once, for a while, by the same person on the same
// server; a failed one is let go so the next opening reads afresh.

const originalGet = api.get;
let gets: string[] = [];
let fail = false;
let now = 1_000;

beforeEach(() => {
  gets = [];
  fail = false;
  now = 1_000;
  __setHeldReadClockForTest(() => now);
  api.get = (async (url: string) => {
    gets.push(url);
    if (fail) throw Object.assign(new Error("503"), { response: { status: 503 } });
    return { data: { url } };
  }) as typeof api.get;
});

afterEach(() => {
  api.get = originalGet;
  __setHeldReadClockForTest();
});

const page = { url: "/messages/channel/c1?limit=50" };

test("taken once by the same request, then gone", async () => {
  const slot = createHeldRead();
  slot.send(page, "u1");
  slot.send(page, "u1");
  assert.deepEqual(gets, [page.url], "sent once");
  assert.equal(slot.take({ url: "/messages/channel/c2?limit=50" }, "u1"), null, "another request is not it");
  slot.send(page, "u1");
  const taken = slot.take(page, "u1");
  assert.ok(taken);
  assert.deepEqual((await taken.request).data, { url: page.url });
  assert.equal(slot.take(page, "u1"), null, "taken once");
});

test("not taken by another person, on another server epoch, or after the hold", () => {
  const slot = createHeldRead();
  slot.send(page, "u1");
  assert.equal(slot.take(page, "u2"), null);

  slot.send(page, "u1");
  const epoch = useServerStore.getState().serverEpoch;
  useServerStore.setState({ serverEpoch: epoch + 1 });
  try {
    assert.equal(slot.take(page, "u1"), null);
  } finally {
    useServerStore.setState({ serverEpoch: epoch });
  }

  slot.send(page, "u1");
  now += 10_000;
  assert.equal(slot.take(page, "u1"), null, "too old");
});

test("a failed read is its view's to report, once; a new send of it reads afresh", async () => {
  const slot = createHeldRead();
  fail = true;
  slot.send(page, "u1");
  await new Promise((resolve) => setTimeout(resolve, 0));
  const failed = slot.take(page, "u1");
  assert.ok(failed, "the view takes the failure: no second read for one open");
  await assert.rejects(failed.request);
  assert.equal(gets.length, 1);

  slot.send(page, "u1");
  await new Promise((resolve) => setTimeout(resolve, 0));
  fail = false;
  slot.send(page, "u1");
  assert.equal(gets.length, 3, "opened again: a held failure is not reused, it reads afresh");
  const fresh = slot.take(page, "u1");
  assert.ok(fresh);
  assert.deepEqual((await fresh.request).data, { url: page.url });
});

test("an answered read is taken only shortly after its answer; one in flight stays joinable", async () => {
  const slot = createHeldRead();
  slot.send(page, "u1");
  await new Promise((resolve) => setTimeout(resolve, 0));
  now += 2_000;
  assert.equal(slot.take(page, "u1"), null, "answered 2 s ago: the view reads again (edits since are not undone)");

  api.get = (() => new Promise(() => {})) as typeof api.get;
  slot.send(page, "u1");
  now += 5_000;
  assert.ok(slot.take(page, "u1"), "still in flight: joined");
});

test("the click's page read counts as a history read at once: the socket's starting horizon is no longer safe", () => {
  __resetMessageHistoryRequestsForTests();
  __resetMessagePagePrefetchForTest();
  assert.equal(startingSyncHorizonSafe(), true);
  prefetchMessagePage({ url: "/messages/channel/c9?limit=50" }, "u1", []);
  assert.equal(startingSyncHorizonSafe(), false);
  __resetMessagePagePrefetchForTest();
  __resetMessageHistoryRequestsForTests();
});

test("takeInFlight takes only an unanswered read; an answered one is dropped, not left for later", async () => {
  const slot = createHeldRead();
  slot.send(page, "u1");
  assert.ok(slot.takeInFlight(page, "u1"), "in flight: taken");

  slot.send(page, "u1");
  await new Promise((resolve) => setTimeout(resolve, 0));
  assert.equal(slot.takeInFlight(page, "u1"), null, "answered: not taken");
  assert.equal(slot.take(page, "u1"), null, "and dropped");
});
