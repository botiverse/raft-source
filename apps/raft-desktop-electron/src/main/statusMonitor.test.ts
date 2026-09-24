import assert from "node:assert/strict";
import test from "node:test";
import { createStatusMonitor } from "./statusMonitor.ts";

const settle = () => new Promise<void>((resolve) => setImmediate(resolve));

test("concurrent IPC and poll reads share one sample; equal snapshots do not publish", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  let reads = 0;
  let state = 1;
  const published: number[] = [];
  const monitor = createStatusMonitor({
    read: async () => { reads++; return { nested: { state } }; },
    publish: (s) => published.push(s.nested.state), intervalMs: 5000,
  });
  monitor.setActive(true);
  const a = monitor.read();
  const b = monitor.read();
  assert.deepEqual(await a, await b);
  await settle();
  assert.equal(reads, 1);
  assert.deepEqual(published, [1]);
  t.mock.timers.tick(5000);
  await settle();
  assert.equal(reads, 2);
  assert.deepEqual(published, [1]);
  state = 2;
  t.mock.timers.tick(5000);
  await settle();
  assert.deepEqual(published, [1, 2]);
  monitor.setActive(false);
});

test("no-window state stops timers; reopening samples immediately", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  let reads = 0;
  let publications = 0;
  const monitor = createStatusMonitor({ read: async () => ++reads, publish: () => publications++, intervalMs: 5000 });
  t.mock.timers.tick(60000);
  assert.equal(reads, 0);
  monitor.setActive(true);
  await settle();
  monitor.setActive(false);
  t.mock.timers.tick(60000);
  await settle();
  assert.equal(reads, 1);
  monitor.setActive(true);
  await settle();
  assert.equal(reads, 2);
  assert.equal(publications, 2);
  monitor.setActive(false);
});

test("closing during slow read suppresses stale delivery; reopening creates only one loop", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  let finish!: (value: number) => void;
  let reads = 0;
  const published: number[] = [];
  const monitor = createStatusMonitor({
    read: () => { reads++; return new Promise<number>((r) => { finish = r; }); },
    publish: (s) => published.push(s), intervalMs: 5000,
  });
  monitor.setActive(true);
  await settle();
  t.mock.timers.tick(60000);
  assert.equal(reads, 1);
  monitor.setActive(false);
  finish(1);
  await settle();
  assert.deepEqual(published, []);
  monitor.setActive(true);
  await settle();
  finish(2);
  await settle();
  assert.deepEqual(published, [2]);
  t.mock.timers.tick(5000);
  await settle();
  assert.equal(reads, 3);
  monitor.setActive(false);
  finish(3);
  await settle();
});

test("failed read is cleared and later reads recover", async () => {
  let fail = true;
  const monitor = createStatusMonitor({ read: async () => { if (fail) throw new Error("temporary"); return 2; }, publish: () => {}, intervalMs: 5000 });
  await assert.rejects(monitor.read(), /temporary/);
  fail = false;
  assert.equal(await monitor.read(), 2);
});

test("an operation invalidates an older sample without overlapping reads or publishing stale state", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  let finish!: (value: number) => void;
  let reads = 0;
  const published: number[] = [];
  const monitor = createStatusMonitor({
    read: () => { reads++; return new Promise<number>((r) => { finish = r; }); },
    publish: (s) => published.push(s), intervalMs: 5000,
  });
  monitor.setActive(true);
  const ipc = monitor.read();
  await settle();
  assert.equal(await monitor.afterOperation(async () => "started"), "started");
  monitor.refresh(); // another completion coalesces into the same fresh sample
  assert.equal(reads, 1);
  finish(1);
  await settle();
  assert.equal(reads, 2);
  assert.deepEqual(published, []);
  finish(2);
  assert.equal(await ipc, 2);
  await settle();
  assert.deepEqual(published, [2]);
  assert.equal(reads, 2, "invalidation must not create a redundant third sample");
  t.mock.timers.tick(5000);
  await settle();
  assert.equal(reads, 3, "only one periodic loop survives refresh");
  monitor.setActive(false);
  finish(3);
});

test("failed operations refresh display state; hidden operations defer polling until restore", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  let state = 0;
  let reads = 0;
  const published: number[] = [];
  const monitor = createStatusMonitor({
    read: async () => { reads++; return state; },
    publish: (s) => published.push(s), intervalMs: 5000,
  });
  monitor.setActive(true);
  await settle();
  await assert.rejects(monitor.afterOperation(async () => { state = 1; throw new Error("partial failure"); }), /partial failure/);
  await settle();
  assert.deepEqual(published, [0, 1]);
  monitor.setActive(false);
  await monitor.afterOperation(async () => { state = 2; });
  t.mock.timers.tick(60000);
  await settle();
  assert.equal(reads, 2);
  monitor.setActive(true);
  await settle();
  assert.deepEqual(published, [0, 1, 2]);
  monitor.setActive(false);
});

test("restore while an old read is pending waits for a fresh sample", async () => {
  const finishes: Array<(value: number) => void> = [];
  const published: number[] = [];
  const monitor = createStatusMonitor({
    read: () => new Promise<number>((r) => finishes.push(r)),
    publish: (s) => published.push(s), intervalMs: 5000,
  });
  monitor.setActive(true);
  await settle();
  monitor.setActive(false);
  monitor.setActive(true);
  finishes[0](1);
  await settle();
  assert.deepEqual(published, []);
  assert.equal(finishes.length, 2);
  finishes[1](2);
  await settle();
  assert.deepEqual(published, [2]);
  monitor.setActive(false);
});


test("IPC and polling reject a sample when the operation finishes in the same microtask turn", async () => {
  let finishSample!: (value: number) => void;
  let finishOperation!: () => void;
  let reads = 0;
  const published: number[] = [];
  const monitor = createStatusMonitor({
    read: () => { reads++; return new Promise<number>((resolve) => { finishSample = resolve; }); },
    publish: (value) => published.push(value), intervalMs: 5000,
  });
  monitor.setActive(true);
  const ipc = monitor.read();
  const operation = monitor.afterOperation(() => new Promise<void>((resolve) => { finishOperation = resolve; }));
  await settle();
  finishSample(1);
  finishOperation();
  await operation;
  const afterOperation = monitor.read();
  await settle();
  assert.deepEqual(published, []);
  assert.equal(reads, 2);
  finishSample(2);
  assert.deepEqual(await Promise.all([ipc, afterOperation]), [2, 2],
    "both existing and post-operation IPC requests must return the fresh sample");
  await settle();
  assert.deepEqual(published, [2]);
  assert.equal(reads, 2);
  monitor.setActive(false);
});
