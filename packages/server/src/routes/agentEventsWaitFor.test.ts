// `/events?wait_for=`: parsing, and the wait for the inbox chain to catch up
// to a notice (backoff, cap, since, overload, waiter limit). Fake clock and
// sleep: no test sleeps for real.
import assert from "node:assert/strict";

import { RisingWaveOverloadedError } from "../db/risingwave";
import type { AgentInboxChainSeqRow } from "../services/channelService";
import {
  __setAgentEventsWaitForDepsForTests,
  agentEventsActiveWaiters,
  agentEventsRetryAfterMs,
  parseAgentEventsWaitAttempt,
  parseAgentEventsWaitFor,
  resolveAgentEventsMaxWaiters,
  resolveAgentEventsWaitMaxMs,
  unsatisfiedAfterPull,
  waitForAgentInboxChain,
} from "./agentEventsWaitFor";

const AGENT = "00000000-0000-4000-8000-0000000000aa";
const T1 = "00000000-0000-4000-8000-000000000001";
const T2 = "00000000-0000-4000-8000-000000000002";

function row(targetId: string, latestSeq: number | null, extra: Partial<AgentInboxChainSeqRow> = {}): AgentInboxChainSeqRow {
  return { targetId, latestSeq, maxMentionSeq: null, lastReadSeq: 0, inAgentInbox: true, targetLatestSeq: null, ...extra };
}

/** Fake clock + sleep; `answers[i]` is what the i-th chain read returns (the last repeats). */
function harness(answers: Array<AgentInboxChainSeqRow[] | null | Error>, opts: { overloaded?: () => boolean } = {}) {
  let nowMs = 1_000_000;
  const sleeps: number[] = [];
  const reads: Array<readonly string[]> = [];
  __setAgentEventsWaitForDepsForTests({
    now: () => nowMs,
    sleep: async (ms) => {
      sleeps.push(ms);
      nowMs += ms;
    },
    overloaded: opts.overloaded ?? (() => false),
    readSeqs: async (agentId, targetIds) => {
      assert.equal(agentId, AGENT);
      reads.push(targetIds);
      const answer = answers[Math.min(reads.length - 1, answers.length - 1)]!;
      if (answer instanceof Error) throw answer;
      return answer;
    },
  });
  return { sleeps, reads };
}

afterEach(() => {
  __setAgentEventsWaitForDepsForTests({});
});

test("parse: pairs, dedupe to the highest seq, empty is none; malformed or too many is an error", () => {
  assert.deepEqual(parseAgentEventsWaitFor(undefined), { ok: true, pairs: [] });
  assert.deepEqual(parseAgentEventsWaitFor("  "), { ok: true, pairs: [] });
  assert.deepEqual(parseAgentEventsWaitFor(`${T1}:5, ${T2.toUpperCase()}:7,${T1}:9`), {
    ok: true,
    pairs: [{ targetId: T1, seq: 9 }, { targetId: T2, seq: 7 }],
  });
  for (const bad of [`${T1}`, `${T1}:`, `${T1}:0`, `${T1}:-1`, `${T1}:1.5`, `${T1}:1e3`, "general:5", `${T1}:5,`, `:5`, `${T1}:99999999999999999`]) {
    assert.equal(parseAgentEventsWaitFor(bad).ok, false, bad);
  }
  assert.equal(parseAgentEventsWaitFor([`${T1}:5`, `${T2}:6`]).ok, false, "given twice");
  const twenty = Array.from({ length: 20 }, (_, i) => `00000000-0000-4000-8000-${String(i).padStart(12, "0")}:${i + 1}`);
  assert.equal(parseAgentEventsWaitFor(twenty.join(",")).ok, true);
  assert.equal(parseAgentEventsWaitFor([...twenty, `${T1}:1`].join(",")).ok, false, "21 pairs");
});

test("env: cap and waiter limit default to 6000 ms / 100 and are configurable", () => {
  assert.equal(resolveAgentEventsWaitMaxMs({}), 6_000);
  assert.equal(resolveAgentEventsWaitMaxMs({ AGENT_EVENTS_WAIT_FOR_CHAIN_MAX_MS: "2500" }), 2_500);
  assert.equal(resolveAgentEventsWaitMaxMs({ AGENT_EVENTS_WAIT_FOR_CHAIN_MAX_MS: "0" }), 0);
  assert.equal(resolveAgentEventsWaitMaxMs({ AGENT_EVENTS_WAIT_FOR_CHAIN_MAX_MS: "nope" }), 6_000);
  assert.equal(resolveAgentEventsWaitMaxMs({ AGENT_EVENTS_WAIT_FOR_CHAIN_MAX_MS: "999999" }), 30_000);
  assert.equal(resolveAgentEventsMaxWaiters({}), 100);
  assert.equal(resolveAgentEventsMaxWaiters({ AGENT_EVENTS_WAIT_FOR_CHAIN_MAX_WAITERS: "3" }), 3);
});

test("already in the chain at the first check: no wait (outcome none, one read)", async () => {
  const h = harness([[row(T1, 10)]]);
  const result = await waitForAgentInboxChain({ agentId: AGENT, pairs: [{ targetId: T1, seq: 10 }], sinceSeq: null });
  assert.deepEqual(result, { outcome: "none", waitedMs: 0, checks: 1, unsatisfied: [] });
  assert.deepEqual(h.sleeps, []);
});

test("caught up after one re-check: one 200 ms sleep, outcome caught_up", async () => {
  const h = harness([[row(T1, 9)], [row(T1, 10)]]);
  const result = await waitForAgentInboxChain({ agentId: AGENT, pairs: [{ targetId: T1, seq: 10 }], sinceSeq: null });
  assert.equal(result.outcome, "caught_up");
  assert.equal(result.checks, 2);
  assert.equal(result.waitedMs, 200);
  assert.deepEqual(result.unsatisfied, []);
  assert.deepEqual(h.sleeps, [200]);
  assert.equal(agentEventsActiveWaiters(), 0, "the waiter slot is released");
});

test("a mention seq or the read position also satisfies a pair; re-checks read only what is still pending", async () => {
  const h = harness([
    [row(T1, 3, { maxMentionSeq: 10 }), row(T2, null)],
    [row(T2, null, { lastReadSeq: 20 })],
  ]);
  const result = await waitForAgentInboxChain({
    agentId: AGENT,
    pairs: [{ targetId: T1, seq: 10 }, { targetId: T2, seq: 20 }],
    sinceSeq: null,
  });
  assert.equal(result.outcome, "caught_up");
  assert.deepEqual(h.reads, [[T1, T2], [T2]]);
});

test("no agent row: the conversation's own latest seq decides; at or past the notice is caught up at once", async () => {
  // The agent already read the conversation (or the message was deleted, or it
  // can no longer see it): no agent inbox row, but the chain holds the message.
  const h = harness([[row(T1, null, { inAgentInbox: false, targetLatestSeq: 12 })]]);
  const result = await waitForAgentInboxChain({ agentId: AGENT, pairs: [{ targetId: T1, seq: 10 }], sinceSeq: null });
  assert.equal(result.outcome, "none");
  assert.equal(result.checks, 1);
  assert.deepEqual(h.sleeps, [], "no wait");
});

test("no agent row and the conversation is behind too: keep waiting", async () => {
  const h = harness([
    [row(T1, null, { inAgentInbox: false, targetLatestSeq: 9 })],
    [row(T1, null, { inAgentInbox: false, targetLatestSeq: 10 })],
  ]);
  const result = await waitForAgentInboxChain({ agentId: AGENT, pairs: [{ targetId: T1, seq: 10 }], sinceSeq: null });
  assert.equal(result.outcome, "caught_up");
  assert.deepEqual(h.sleeps, [200]);
});

test("still behind at the cap: backoff 200, 400, 800, ... cut at the cap; outcome cap with the pending pairs", async () => {
  const h = harness([[]]);
  const result = await waitForAgentInboxChain({
    agentId: AGENT, pairs: [{ targetId: T1, seq: 10 }], sinceSeq: null, maxWaitMs: 6_000,
  });
  assert.equal(result.outcome, "cap");
  assert.equal(result.waitedMs, 6_000);
  assert.deepEqual(h.sleeps, [200, 400, 800, 1_600, 3_000]);
  assert.equal(result.checks, 6, "a final check at the cap");
  assert.deepEqual(result.unsatisfied, [{ targetId: T1, seq: 10 }]);
  assert.equal(agentEventsActiveWaiters(), 0);
});

test("since at or above every seq: no wait and no chain read", async () => {
  const h = harness([[]]);
  const result = await waitForAgentInboxChain({ agentId: AGENT, pairs: [{ targetId: T1, seq: 10 }], sinceSeq: 10 });
  assert.deepEqual(result, { outcome: "none", waitedMs: 0, checks: 0, unsatisfied: [] });
  assert.deepEqual(h.reads, []);
  // Only the pair above since is checked.
  await waitForAgentInboxChain({ agentId: AGENT, pairs: [{ targetId: T1, seq: 10 }, { targetId: T2, seq: 11 }], sinceSeq: 10, maxWaitMs: 0 });
  assert.deepEqual(h.reads, [[T2]]);
});

test("RisingWave overloaded: no read, no wait; an overload during the wait ends it", async () => {
  const h = harness([[]], { overloaded: () => true });
  const result = await waitForAgentInboxChain({ agentId: AGENT, pairs: [{ targetId: T1, seq: 10 }], sinceSeq: null });
  assert.equal(result.outcome, "overloaded");
  assert.equal(result.checks, 0);
  assert.deepEqual(h.reads, []);
  assert.deepEqual(h.sleeps, []);
  assert.deepEqual(result.unsatisfied, [{ targetId: T1, seq: 10 }]);

  const thrown = harness([new RisingWaveOverloadedError(new Error("timeout exceeded when trying to connect"))]);
  const cut = await waitForAgentInboxChain({ agentId: AGENT, pairs: [{ targetId: T1, seq: 10 }], sinceSeq: null });
  assert.equal(cut.outcome, "overloaded");
  assert.deepEqual(thrown.sleeps, []);
});

test("another chain read failure or no RisingWave: unavailable, no wait", async () => {
  harness([new Error("syntax error")]);
  assert.equal((await waitForAgentInboxChain({ agentId: AGENT, pairs: [{ targetId: T1, seq: 1 }], sinceSeq: null })).outcome, "unavailable");
  harness([null]);
  assert.equal((await waitForAgentInboxChain({ agentId: AGENT, pairs: [{ targetId: T1, seq: 1 }], sinceSeq: null })).outcome, "unavailable");
});

test("waiter limit: past the per-process cap a request does not wait", async () => {
  let release!: () => void;
  const gate = new Promise<void>((resolve) => { release = resolve; });
  let nowMs = 0;
  __setAgentEventsWaitForDepsForTests({
    now: () => nowMs,
    overloaded: () => false,
    readSeqs: async () => [],
    // The first waiter sleeps until released.
    sleep: async (ms) => {
      await gate;
      nowMs += ms;
    },
  });
  const first = waitForAgentInboxChain({ agentId: AGENT, pairs: [{ targetId: T1, seq: 10 }], sinceSeq: null, maxWaiters: 1, maxWaitMs: 200 });
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(agentEventsActiveWaiters(), 1);
  const second = await waitForAgentInboxChain({ agentId: AGENT, pairs: [{ targetId: T2, seq: 10 }], sinceSeq: null, maxWaiters: 1, maxWaitMs: 200 });
  assert.equal(second.outcome, "waiter_limit");
  assert.equal(second.checks, 1);
  release();
  assert.equal((await first).outcome, "cap");
  assert.equal(agentEventsActiveWaiters(), 0);
});

test("after the pull: a pair whose message the pull found is satisfied", () => {
  const pending = [{ targetId: T1, seq: 10 }, { targetId: T2, seq: 20 }];
  assert.deepEqual(unsatisfiedAfterPull(pending, [{ channel_id: T1, seq: 10 }, { channel_id: T2, seq: 19 }]), [{ targetId: T2, seq: 20 }]);
  assert.deepEqual(unsatisfiedAfterPull([], [{ channel_id: T1, seq: 10 }]), []);
});

test("retry_after_ms: 1000 * 2^wait_attempt up to 8000; 8000 at once when RW was spared or unreadable", () => {
  assert.deepEqual([0, 1, 2, 3, 4, 10, 1_000].map((attempt) => agentEventsRetryAfterMs("cap", attempt)), [1_000, 2_000, 4_000, 8_000, 8_000, 8_000, 8_000]);
  for (const outcome of ["overloaded", "waiter_limit", "unavailable"] as const) {
    assert.equal(agentEventsRetryAfterMs(outcome, 0), 8_000, outcome);
  }
});

test("wait_attempt: absent or empty is 0, a non-negative integer, large values clamped; anything else an error", () => {
  assert.deepEqual(parseAgentEventsWaitAttempt(undefined), { ok: true, attempt: 0 });
  assert.deepEqual(parseAgentEventsWaitAttempt(" "), { ok: true, attempt: 0 });
  assert.deepEqual(parseAgentEventsWaitAttempt("3"), { ok: true, attempt: 3 });
  assert.deepEqual(parseAgentEventsWaitAttempt("99999999999999999999"), { ok: true, attempt: 1_000 });
  for (const bad of ["-1", "1.5", "abc", "1e3", "0x2"]) assert.equal(parseAgentEventsWaitAttempt(bad).ok, false, bad);
  assert.equal(parseAgentEventsWaitAttempt(["1", "2"]).ok, false, "given twice");
});
