import assert from "node:assert/strict";
import { createDbLivenessTracker, LIVEZ_DB_STALE_MS, livezStatus } from "./dbLiveness";

function harness(pingOutcome: () => Promise<unknown>) {
  let clock = 1_000_000;
  let pings = 0;
  const tracker = createDbLivenessTracker({
    now: () => clock,
    ping: async () => {
      pings += 1;
      return pingOutcome();
    },
  });
  return {
    tracker,
    advance: (ms: number) => {
      clock += ms;
    },
    pings: () => pings,
  };
}

test("an unstarted tracker reports ok as unmonitored, never a failure", () => {
  const { tracker } = harness(async () => undefined);
  assert.deepEqual(tracker.verdict(), { ok: true, db: "unmonitored", msSinceDbSuccess: null });
});

test("reading the verdict never pings the database", async () => {
  const h = harness(async () => undefined);
  await h.tracker.probeOnce();
  const before = h.pings();
  for (let i = 0; i < 10; i++) h.tracker.verdict();
  assert.equal(h.pings(), before, "verdict() must not query the database");
});

test("a short database pause keeps the task alive", async () => {
  let failing = false;
  const h = harness(async () => {
    if (failing) throw new Error("Connection terminated");
  });
  await h.tracker.probeOnce();
  failing = true;
  h.advance(2_200); // a typical Neon compute pause
  await h.tracker.probeOnce();
  assert.equal(h.tracker.verdict().ok, true);
});

test("a database unanswered for longer than the stale window turns 503, and recovery returns 200", async () => {
  let failing = false;
  const h = harness(async () => {
    if (failing) throw new Error("Connection terminated");
  });
  await h.tracker.probeOnce();

  failing = true;
  h.advance(LIVEZ_DB_STALE_MS);
  await h.tracker.probeOnce();
  assert.equal(h.tracker.verdict().ok, true, "exactly at the window is still alive");

  h.advance(1);
  await h.tracker.probeOnce();
  const dead = h.tracker.verdict();
  assert.equal(dead.ok, false);
  assert.equal(dead.db, "stale");
  assert.equal(dead.msSinceDbSuccess, LIVEZ_DB_STALE_MS + 1);

  failing = false;
  await h.tracker.probeOnce();
  assert.deepEqual(h.tracker.verdict(), { ok: true, db: "ok", msSinceDbSuccess: 0 });
});

test("a fresh task is not alive until the database has answered once", async () => {
  let failing = true;
  const h = harness(async () => {
    if (failing) throw new Error("password authentication failed");
  });

  // No success yet: not ok from the first probe on, not only after the stale
  // window. A task that cannot reach the database must never pass the ALB
  // check, or ECS would count it healthy and stop good tasks.
  await h.tracker.probeOnce();
  const starting = { ok: false, db: "starting" as const, msSinceDbSuccess: null };
  assert.deepEqual(h.tracker.verdict(), starting);
  assert.equal(livezStatus(h.tracker.verdict(), "production"), 503);

  h.advance(LIVEZ_DB_STALE_MS - 1);
  await h.tracker.probeOnce();
  assert.deepEqual(h.tracker.verdict(), starting, "still starting inside what used to be the free window");

  h.advance(LIVEZ_DB_STALE_MS);
  await h.tracker.probeOnce();
  assert.deepEqual(h.tracker.verdict(), starting, "never stale without a first success");

  // The first answer makes it alive, and the stale window counts from there.
  failing = false;
  await h.tracker.probeOnce();
  assert.deepEqual(h.tracker.verdict(), { ok: true, db: "ok", msSinceDbSuccess: 0 });
  assert.equal(livezStatus(h.tracker.verdict(), "production"), 200);

  failing = true;
  h.advance(LIVEZ_DB_STALE_MS);
  await h.tracker.probeOnce();
  assert.equal(h.tracker.verdict().ok, true, "after a success the full window applies");
  h.advance(1);
  assert.equal(h.tracker.verdict().db, "stale");
});

test("a hung ping does not stack further pings behind it", async () => {
  let release: () => void = () => {};
  const h = harness(() => new Promise<void>((resolve) => { release = resolve; }));
  const first = h.tracker.probeOnce();
  await h.tracker.probeOnce();
  await h.tracker.probeOnce();
  assert.equal(h.pings(), 1);
  release();
  await first;
});

test("production refuses an unmonitored tracker instead of a silent 200", () => {
  const unmonitored = { ok: true, db: "unmonitored" as const, msSinceDbSuccess: null };
  assert.equal(livezStatus(unmonitored, "production"), 503);
  assert.equal(livezStatus(unmonitored, "test"), 200);
  assert.equal(livezStatus({ ok: true, db: "ok", msSinceDbSuccess: 10 }, "production"), 200);
  assert.equal(livezStatus({ ok: false, db: "stale", msSinceDbSuccess: 60_001 }, "production"), 503);
  assert.equal(livezStatus({ ok: false, db: "starting", msSinceDbSuccess: null }, "production"), 503);
  assert.equal(livezStatus({ ok: false, db: "starting", msSinceDbSuccess: null }, "test"), 503);
});

test("start() marks the tracker monitored before the first ping resolves, and a hung first ping is not alive", () => {
  const tracker = createDbLivenessTracker({ ping: () => new Promise(() => {}), intervalMs: 60_000 });
  tracker.start();
  assert.deepEqual(tracker.verdict(), { ok: false, db: "starting", msSinceDbSuccess: null });
  tracker.stop();
});
