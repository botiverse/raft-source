import assert from "node:assert/strict";
import type { ChildProcess } from "node:child_process";
import { EventEmitter } from "node:events";
import { test } from "vitest";
import { createChildProcessEventProbe, createEventProbe, FakeClock, waitForCount, waitForExactCount, waitForState } from "./drydock.js";

test("FakeClock advances timers deterministically and honors cancellation", () => {
  const clock = new FakeClock();
  const fired: string[] = [];
  const cancelled = clock.setTimeout(() => fired.push("cancelled"), 5);

  clock.setTimeout(() => fired.push("first-at-five"), 5);
  clock.setTimeout(() => fired.push("second-at-five"), 5);
  clock.setTimeout(() => fired.push("at-ten"), 10);
  clock.clearTimeout(cancelled);

  clock.advanceBy(4);
  assert.deepEqual(fired, []);
  assert.equal(clock.now(), 4);

  clock.advanceBy(1);
  assert.deepEqual(fired, ["first-at-five", "second-at-five"]);
  assert.equal(clock.now(), 5);

  clock.advanceBy(5);
  assert.deepEqual(fired, ["first-at-five", "second-at-five", "at-ten"]);
  assert.equal(clock.now(), 10);
});

test("event probe replays buffered events and resolves live semantic events", async () => {
  const probe = createEventProbe<{ kind: string; value: number }>();
  const buffered = { kind: "ready", value: 1 };
  probe.record(buffered);

  assert.equal(await probe.waitFor((event) => event.kind === "ready", "buffered ready"), buffered);

  const liveWait = probe.waitFor((event) => event.kind === "done", "live done");
  const live = { kind: "done", value: 2 };
  probe.record(live);
  assert.equal(await liveWait, live);
});

test("event probe fails closed with the semantic label when an event is missing", async () => {
  const probe = createEventProbe<{ kind: string }>({ timeoutMs: 10 });
  await assert.rejects(
    probe.waitFor((event) => event.kind === "missing", "semantic completion"),
    /Timed out waiting for semantic completion/,
  );
});

test("child-process event probe fails immediately when the child closes", async () => {
  const child = new EventEmitter() as ChildProcess;
  Object.assign(child, { exitCode: null, signalCode: null });
  const probe = createChildProcessEventProbe<{ kind: string }>(child, {
    processName: "Scripted runtime",
    timeoutMs: 5_000,
  });

  const wait = probe.waitFor((event) => event.kind === "done", "runtime completion");
  child.emit("close", 7, null);

  await assert.rejects(
    wait,
    /Scripted runtime closed before runtime completion \(code=7, signal=null\)/,
  );
});

test("waitForState resolves on an already-true predicate without polling", async () => {
  let polls = 0;
  await waitForState(() => { polls++; return true; }, "already satisfied");
  assert.equal(polls, 1);
});

test("waitForState resolves once a monotone predicate flips true", async () => {
  let ready = false;
  setTimeout(() => { ready = true; }, 15);
  await waitForState(() => ready, "delayed flag", { timeoutMs: 500, pollIntervalMs: 1 });
  assert.equal(ready, true);
});

test("waitForState timeout says the predicate was never observed true", async () => {
  await assert.rejects(
    () => waitForState(() => false, "never happens", { timeoutMs: 20, pollIntervalMs: 1 }),
    (error: Error) => {
      assert.match(error.message, /Timed out waiting for never happens/);
      // The message must state WHY, so a reader can tell this apart from the
      // overshoot case below rather than guessing.
      assert.match(error.message, /predicate never observed true/);
      return true;
    },
  );
});

test("waitForCount is monotone: a source that overshoots still satisfies it", async () => {
  const arr: number[] = [];
  // Both arrivals land before the first poll, so an `=== 1` wait would have
  // stepped straight over its own true window.
  arr.push(1, 2);
  await waitForCount(() => arr.length, 1, "appended entries", { timeoutMs: 50, pollIntervalMs: 1 });
});

test("waitForExactCount separates never-reached from sampled-past-it", async () => {
  const never: number[] = [];
  await assert.rejects(
    () => waitForExactCount(() => never.length, 2, "never arrives", { timeoutMs: 20, pollIntervalMs: 1 }),
    (error: Error) => {
      assert.match(error.message, /count never reached 2/);
      assert.match(error.message, /last observed 0/);
      assert.doesNotMatch(error.message, /exceeded/);
      return true;
    },
  );

  const overshot = [1, 2, 3];
  await assert.rejects(
    () => waitForExactCount(() => overshot.length, 2, "overshot", { timeoutMs: 20, pollIntervalMs: 1 }),
    (error: Error) => {
      assert.match(error.message, /observed 3, expected exactly 2/);
      // The message must not claim WHEN the overshoot happened — a sampling
      // waiter cannot know that.
      assert.doesNotMatch(error.message, /when first sampled/);
      assert.match(error.message, /cannot tell an overshoot/);
      // The two failures must not be reported the same way — that
      // indistinguishability is the defect this primitive exists to remove.
      assert.doesNotMatch(error.message, /never reached/);
      return true;
    },
  );
});
