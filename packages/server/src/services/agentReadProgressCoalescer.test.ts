/**
 * Agent read progress coalescing (agentReadProgressCoalescer.ts): one flush per
 * conversation per interval with every agent's widest range, flushes of one
 * conversation never closer than the interval, bounded memory, and nothing
 * left behind once a conversation is idle.
 */
import assert from "node:assert/strict";
import {
  AgentReadProgressCoalescer,
  type AgentReadProgressBatch,
  type AgentReadProgressCoalescerOptions,
} from "./agentReadProgressCoalescer";

function fakeTimers() {
  let now = 0;
  let nextId = 1;
  const timers: Array<{ at: number; fn: () => void; id: number }> = [];
  return {
    setTimer: (fn: () => void, ms: number) => {
      const id = nextId++;
      timers.push({ at: now + ms, fn, id });
      return id;
    },
    clearTimer: (id: unknown) => {
      const index = timers.findIndex((timer) => timer.id === id);
      if (index >= 0) timers.splice(index, 1);
    },
    pending: () => timers.length,
    /** Move the clock, firing due timers, and let their flush promises settle. */
    async advance(ms: number) {
      const until = now + ms;
      for (;;) {
        timers.sort((left, right) => left.at - right.at);
        const due = timers[0];
        if (!due || due.at > until) break;
        timers.shift();
        now = due.at;
        due.fn();
        await settle();
      }
      now = until;
      await settle();
    },
  };
}

/** Let every pending promise continuation run (the flushes are async). */
async function settle() {
  await new Promise<void>((resolve) => setImmediate(resolve));
}

function setup(overrides: Partial<AgentReadProgressCoalescerOptions> = {}) {
  const timers = fakeTimers();
  const flushed: Array<{ scopeId: string; serverId: string; advances: Record<string, { from: number; to: number }> }> = [];
  const coalescer = new AgentReadProgressCoalescer({
    intervalMs: 300,
    maxScopes: 10,
    maxAgentsPerScope: 3,
    flush: async (batch: AgentReadProgressBatch) => {
      flushed.push({ scopeId: batch.scopeId, serverId: batch.serverId, advances: Object.fromEntries(batch.advances) });
    },
    setTimer: timers.setTimer,
    clearTimer: timers.clearTimer,
    ...overrides,
  });
  return { coalescer, timers, flushed };
}

const advance = (scopeId: string, agentId: string, from: number, to: number) => ({ serverId: "s1", scopeId, agentId, from, to });

test("advances within one interval flush once per conversation, with each agent's lowest from and highest to", async () => {
  const { coalescer, timers, flushed } = setup();
  assert.equal(coalescer.note(advance("c1", "a", 10, 20)), true);
  assert.equal(coalescer.note(advance("c1", "a", 20, 30)), true);
  assert.equal(coalescer.note(advance("c1", "b", 5, 7)), true);
  assert.equal(coalescer.note(advance("c2", "a", 1, 2)), true);
  assert.equal(timers.pending(), 2, "one timer per conversation, not per advance");

  await timers.advance(299);
  assert.deepEqual(flushed, [], "nothing before the interval");

  await timers.advance(1);
  assert.deepEqual(flushed, [
    { scopeId: "c1", serverId: "s1", advances: { a: { from: 10, to: 30 }, b: { from: 5, to: 7 } } },
    { scopeId: "c2", serverId: "s1", advances: { a: { from: 1, to: 2 } } },
  ]);
  assert.equal(coalescer.size, 0, "idle conversations are forgotten");
  assert.equal(timers.pending(), 0, "and leave no timer");
});

test("a move that is not forward is not noted", async () => {
  const { coalescer, timers, flushed } = setup();
  assert.equal(coalescer.note(advance("c1", "a", 20, 20)), false);
  assert.equal(coalescer.note(advance("c1", "a", 20, 10)), false);
  assert.equal(coalescer.note(advance("c1", "a", Number.NaN, 10)), false);
  assert.equal(coalescer.size, 0);
  await timers.advance(1_000);
  assert.deepEqual(flushed, []);
});

test("advances during a running flush wait for it and then a full interval", async () => {
  let release: () => void = () => {};
  const timers = fakeTimers();
  const starts: number[] = [];
  let clock = 0;
  const batches: Array<Record<string, { from: number; to: number }>> = [];
  const coalescer = new AgentReadProgressCoalescer({
    intervalMs: 300,
    maxScopes: 10,
    maxAgentsPerScope: 10,
    flush: async (batch) => {
      starts.push(clock);
      batches.push(Object.fromEntries(batch.advances));
      if (batches.length === 1) await new Promise<void>((resolve) => { release = resolve; });
    },
    setTimer: timers.setTimer,
    clearTimer: timers.clearTimer,
  });
  const tick = async (ms: number) => { clock += ms; await timers.advance(ms); };

  coalescer.note(advance("c1", "a", 0, 1));
  await tick(300);
  assert.deepEqual(starts, [300], "first flush is running");

  coalescer.note(advance("c1", "a", 1, 2));
  coalescer.note(advance("c1", "a", 2, 3));
  assert.equal(timers.pending(), 0, "no timer while the flush runs");
  await tick(500);
  assert.equal(starts.length, 1, "still waiting for the first flush");

  release();
  await settle();
  assert.equal(timers.pending(), 1, "the next flush is scheduled once the first is done");
  await tick(299);
  assert.equal(starts.length, 1);
  await tick(1);
  assert.deepEqual(starts, [300, 1_100], "a full interval after the first flush finished");
  assert.deepEqual(batches, [{ a: { from: 0, to: 1 } }, { a: { from: 1, to: 3 } }]);
  assert.equal(coalescer.size, 0);
});

test("a failed flush is reported and the conversation is forgotten", async () => {
  const errors: unknown[] = [];
  const { coalescer, timers } = setup({
    flush: async () => { throw new Error("boom"); },
    onFlushError: (error) => errors.push(error),
  });
  coalescer.note(advance("c1", "a", 0, 1));
  await timers.advance(300);
  assert.equal(errors.length, 1);
  assert.equal(coalescer.size, 0);
  assert.equal(timers.pending(), 0);
});

test("memory is bounded per conversation and in total", async () => {
  const { coalescer, timers, flushed } = setup({ maxScopes: 2, maxAgentsPerScope: 2 });
  assert.equal(coalescer.note(advance("c1", "a", 0, 1)), true);
  assert.equal(coalescer.note(advance("c1", "b", 0, 1)), true);
  assert.equal(coalescer.note(advance("c1", "c", 0, 1)), false, "a third agent in one conversation is dropped");
  assert.equal(coalescer.note(advance("c1", "a", 1, 5)), true, "an agent already pending still widens");
  assert.equal(coalescer.note(advance("c2", "a", 0, 1)), true);
  assert.equal(coalescer.note(advance("c3", "a", 0, 1)), false, "a third conversation is dropped");
  await timers.advance(300);
  assert.deepEqual(flushed.map((batch) => [batch.scopeId, batch.advances]), [
    ["c1", { a: { from: 0, to: 5 }, b: { from: 0, to: 1 } }],
    ["c2", { a: { from: 0, to: 1 } }],
  ]);
  assert.equal(coalescer.note(advance("c3", "a", 0, 1)), true, "room again once the others flushed");
});

test("clear cancels every timer and nothing flushes afterwards", async () => {
  const { coalescer, timers, flushed } = setup();
  coalescer.note(advance("c1", "a", 0, 1));
  coalescer.note(advance("c2", "a", 0, 1));
  coalescer.clear();
  assert.equal(coalescer.size, 0);
  assert.equal(timers.pending(), 0);
  await timers.advance(1_000);
  assert.deepEqual(flushed, []);
});
