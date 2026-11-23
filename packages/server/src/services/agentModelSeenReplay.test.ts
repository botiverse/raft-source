import assert from "node:assert/strict";

import { afterEach, beforeEach, test, vi } from "vitest";

import {
  __clearAgentModelSeenReplaysForTests,
  applyAgentModelSeenWithReplay,
  contiguousSeenWalk,
  pendingAgentModelSeenReplayCount,
  type AgentModelSeenOutcome,
  type AgentModelSeenReplayEvent,
} from "./agentModelSeen";

const DELAY = 3_250;
const input = (seqs: number[], channelId = "c1") => ({ agentId: "a1", serverId: "s1", channelId, seqs });

/** A stand-in for the real apply: a read position, and the seqs still too new. */
function conversation(start: { position: number; tooNew: number[]; rows: number[] }) {
  const state = { ...start, calls: [] as number[][] };
  const apply = async (args: { seqs: readonly number[] }): Promise<AgentModelSeenOutcome> => {
    state.calls.push([...args.seqs]);
    const reported = new Set(args.seqs.filter((seq) => seq > state.position));
    if (reported.size === 0) return { outcome: "unchanged", reason: "not_after_read_position" };
    const from = state.position;
    let unsettled = false;
    for (const seq of state.rows) {
      if (seq <= state.position) continue;
      if (!reported.has(seq)) break;
      if (state.tooNew.includes(seq)) { unsettled = true; break; }
      state.position = seq;
    }
    const held = unsettled ? { unsettledSeqs: [...reported].filter((seq) => seq > state.position).sort((a, b) => a - b) } : {};
    return state.position > from
      ? { outcome: "advanced", fromSeq: from, toSeq: state.position, ...held }
      : { outcome: "unchanged", reason: "gap", ...held };
  };
  return { state, apply };
}

beforeEach(() => {
  vi.useFakeTimers();
});

afterEach(() => {
  __clearAgentModelSeenReplaysForTests();
  vi.useRealTimers();
});

test("the walk says a too-new reported row stopped it, and does not say so for a message that was not shown", () => {
  const rows = [{ seq: 11, createdAtMs: 0 }, { seq: 12, createdAtMs: 5_000 }, { seq: 13, createdAtMs: 5_000 }];
  assert.deepEqual(contiguousSeenWalk(10, new Set([11, 12, 13]), rows, 1_000), { upTo: 11, unsettled: true });
  assert.deepEqual(contiguousSeenWalk(10, new Set([11, 13]), rows, 1_000), { upTo: 11, unsettled: false });
  assert.deepEqual(contiguousSeenWalk(10, new Set([11]), rows, 1_000), { upTo: 11, unsettled: false });
});

test("a report kept back by the settle window is applied by one timer after it, and says it moved", async () => {
  const { state, apply } = conversation({ position: 10, tooNew: [11], rows: [11] });
  const events: AgentModelSeenReplayEvent[] = [];
  const first = await applyAgentModelSeenWithReplay(input([11]), { apply, record: (event) => events.push(event), delayMs: DELAY });
  assert.deepEqual(first, { outcome: "unchanged", reason: "gap", unsettledSeqs: [11] });
  assert.equal(pendingAgentModelSeenReplayCount(), 1);

  await vi.advanceTimersByTimeAsync(DELAY - 1);
  assert.equal(state.position, 10, "nothing before the window has passed");
  state.tooNew = [];
  await vi.advanceTimersByTimeAsync(1);
  assert.equal(state.position, 11);
  assert.equal(pendingAgentModelSeenReplayCount(), 0);
  assert.deepEqual(events, [{ outcome: "advanced", trigger: "timer", agent_id: "a1", channel_id: "c1", held_count: 1, from_seq: 10, to_seq: 11 }]);

  await vi.advanceTimersByTimeAsync(DELAY * 4);
  assert.equal(state.calls.length, 2, "one second look, no more");
});

test("a message committed late below the kept-back one still stops the second look, and that is recorded", async () => {
  const { state, apply } = conversation({ position: 10, tooNew: [12], rows: [12] });
  const events: AgentModelSeenReplayEvent[] = [];
  await applyAgentModelSeenWithReplay(input([12]), { apply, record: (event) => events.push(event), delayMs: DELAY });
  // Seq 11 commits inside the window; the model was never shown it.
  state.rows = [11, 12];
  state.tooNew = [];
  await vi.advanceTimersByTimeAsync(DELAY);
  assert.equal(state.position, 10, "the position does not pass a message that was not shown");
  assert.deepEqual(events, [{ outcome: "unchanged", trigger: "timer", reason: "gap", agent_id: "a1", channel_id: "c1", held_count: 1 }]);
});

test("a row still too new at the second look is dropped, not tried for ever", async () => {
  const { state, apply } = conversation({ position: 10, tooNew: [11], rows: [11] });
  const events: AgentModelSeenReplayEvent[] = [];
  await applyAgentModelSeenWithReplay(input([11]), { apply, record: (event) => events.push(event), delayMs: DELAY });
  await vi.advanceTimersByTimeAsync(DELAY * 5);
  assert.equal(state.calls.length, 2);
  assert.equal(pendingAgentModelSeenReplayCount(), 0);
  assert.equal(events.length, 1);
  assert.equal(events[0]!.reason, "unsettled");
});

test("the next report carries what was kept back, so a steady run of reports does not wait for the timer", async () => {
  const { state, apply } = conversation({ position: 10, tooNew: [11], rows: [11, 12] });
  const events: AgentModelSeenReplayEvent[] = [];
  const deps = { apply, record: (event: AgentModelSeenReplayEvent) => events.push(event), delayMs: DELAY };
  await applyAgentModelSeenWithReplay(input([11]), deps);

  // Two seconds later 12 arrives and is reported: 11 is still too new, so both wait and nothing is said yet.
  await vi.advanceTimersByTimeAsync(2_000);
  state.tooNew = [11, 12];
  await applyAgentModelSeenWithReplay(input([12]), deps);
  assert.deepEqual(state.calls[1], [11, 12]);
  assert.equal(events.length, 0);
  assert.equal(pendingAgentModelSeenReplayCount(), 1);

  // The first timer is gone; the wait restarts from the newer report.
  await vi.advanceTimersByTimeAsync(DELAY - 1);
  assert.equal(state.calls.length, 2);
  state.tooNew = [];
  await vi.advanceTimersByTimeAsync(1);
  assert.equal(state.position, 12);
  assert.deepEqual(events.map((event) => [event.outcome, event.trigger, event.held_count, event.to_seq]), [["advanced", "timer", 2, 12]]);
});

test("a later report that finds the kept-back seqs settled moves over them and cancels the timer", async () => {
  const { state, apply } = conversation({ position: 10, tooNew: [11], rows: [11, 12] });
  const events: AgentModelSeenReplayEvent[] = [];
  const deps = { apply, record: (event: AgentModelSeenReplayEvent) => events.push(event), delayMs: DELAY };
  await applyAgentModelSeenWithReplay(input([11]), deps);
  state.tooNew = [12];
  const second = await applyAgentModelSeenWithReplay(input([12]), deps);
  assert.deepEqual(second, { outcome: "advanced", fromSeq: 10, toSeq: 11, unsettledSeqs: [12] });
  assert.deepEqual(events.map((event) => [event.outcome, event.trigger]), [["advanced", "next_report"]]);
  state.tooNew = [];
  await vi.advanceTimersByTimeAsync(DELAY);
  assert.equal(state.position, 12);
  assert.equal(state.calls.length, 3);
});

test("running the second look twice changes nothing, and conversations wait apart", async () => {
  const one = conversation({ position: 10, tooNew: [11], rows: [11] });
  const two = conversation({ position: 20, tooNew: [21], rows: [21] });
  await applyAgentModelSeenWithReplay(input([11], "c1"), { apply: one.apply, delayMs: DELAY });
  await applyAgentModelSeenWithReplay(input([21], "c2"), { apply: two.apply, delayMs: DELAY });
  assert.equal(pendingAgentModelSeenReplayCount(), 2);
  one.state.tooNew = [];
  two.state.tooNew = [];
  await vi.advanceTimersByTimeAsync(DELAY);
  assert.deepEqual([one.state.position, two.state.position], [11, 21]);
  assert.deepEqual(await one.apply({ seqs: [11] }), { outcome: "unchanged", reason: "not_after_read_position" });
  assert.equal(one.state.position, 11);
});

test("a report nothing kept back leaves no timer, and a recorder that throws changes no answer", async () => {
  const { apply } = conversation({ position: 10, tooNew: [], rows: [11] });
  const result = await applyAgentModelSeenWithReplay(input([11]), { apply, delayMs: DELAY });
  assert.deepEqual(result, { outcome: "advanced", fromSeq: 10, toSeq: 11 });
  assert.equal(pendingAgentModelSeenReplayCount(), 0);

  const held = conversation({ position: 10, tooNew: [11], rows: [11] });
  await applyAgentModelSeenWithReplay(input([11], "c9"), { apply: held.apply, record: () => { throw new Error("recorder down"); }, delayMs: DELAY });
  held.state.tooNew = [];
  await vi.advanceTimersByTimeAsync(DELAY);
  assert.equal(held.state.position, 11);
});
