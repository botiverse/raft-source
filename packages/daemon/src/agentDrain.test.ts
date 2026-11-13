// Reconciler step 13: the drain's waiter on its own (agentDrain.ts), on a
// fake clock. The hosts' holding is tested beside each host
// (agentProcessManager.drain.test.ts, agentHost/oarAgentHost.drain.test.ts).
//
// RED proof: decide once when the deadline timer fires (no re-arm) and the
// early-firing test resolves `deadline` before the deadline; drop the clamp
// and the 1 h request waits 1 h.

import assert from "node:assert/strict";
import { AGENT_DRAIN_MAX_DEADLINE_MS, AGENT_DRAIN_RELEASE_GRACE_MS, AgentDrain, clampAgentDrainDeadlineMs, type AgentDrainProgress } from "./agentDrain";

type Timer = ReturnType<typeof setTimeout>;

/** A clock whose timers fire when the test says, and whose `now` the test sets. */
function fakeTimers() {
  let nowMs = 1_000;
  let nextId = 1;
  const timers = new Map<number, { at: number; fn: () => void }>();
  return {
    now: () => nowMs,
    set: (ms: number) => { nowMs = ms; },
    setTimer: (fn: () => void, ms: number) => {
      const id = nextId++;
      timers.set(id, { at: nowMs + ms, fn });
      return id as unknown as Timer;
    },
    clearTimer: (timer: Timer) => { timers.delete(timer as unknown as number); },
    /** Fire the earliest timer now, whatever the clock says (a timer that fires early). */
    fireNext(): number | null {
      const [id, timer] = [...timers.entries()].sort((a, b) => a[1].at - b[1].at)[0] ?? [];
      if (id === undefined || !timer) return null;
      timers.delete(id);
      timer.fn();
      return timer.at;
    },
    /** Move the clock and fire every timer due by then. */
    advance(ms: number): void {
      const target = nowMs + ms;
      for (;;) {
        const due = [...timers.entries()].filter(([, timer]) => timer.at <= target).sort((a, b) => a[1].at - b[1].at)[0];
        if (!due) break;
        nowMs = due[1].at;
        timers.delete(due[0]);
        due[1].fn();
      }
      nowMs = target;
    },
    pending: () => [...timers.values()].map((timer) => timer.at).sort((a, b) => a - b),
  };
}

function drainWith(state: { progress: AgentDrainProgress }, clock = fakeTimers()) {
  const events: Array<{ name: string; attrs: Record<string, unknown> }> = [];
  let released = 0;
  const drain = new AgentDrain({
    host: "legacy",
    progress: () => state.progress,
    release: () => { released += 1; },
    recordEvent: (name, attrs) => events.push({ name, attrs }),
    now: clock.now,
    setTimer: clock.setTimer,
    clearTimer: clock.clearTimer,
    pollMs: 1_000,
  });
  return { drain, clock, events, released: () => released };
}

const busy = (agentId: string) => ({ live: 1, notQuiet: [{ agentId, reason: "agent_busy" as const }] });
const quiet = { live: 1, notQuiet: [] };

async function settledWithin<T>(promise: Promise<T>): Promise<T | "pending"> {
  return Promise.race([promise, new Promise<"pending">((resolve) => setImmediate(() => resolve("pending")))]);
}

test("the deadline is clamped to 10 minutes; nonsense is 0", () => {
  assert.equal(AGENT_DRAIN_MAX_DEADLINE_MS, 600_000);
  assert.equal(clampAgentDrainDeadlineMs(60 * 60_000), 600_000);
  assert.equal(clampAgentDrainDeadlineMs(30_000), 30_000);
  assert.equal(clampAgentDrainDeadlineMs(-5), 0);
  assert.equal(clampAgentDrainDeadlineMs(Number.NaN), 0);
  assert.equal(clampAgentDrainDeadlineMs(Number.POSITIVE_INFINITY), 0);
});

test("all quiet: resolves at once, and keeps holding until end", async () => {
  const { drain, released } = drainWith({ progress: quiet });
  const summary = await drain.begin({ deadlineMs: 60_000 });
  assert.equal(summary.finished, "quiet");
  assert.deepEqual(summary.waitedFor, []);
  assert.equal(drain.holding, true, "the shutdown comes next: still held");
  drain.end();
  assert.equal(drain.holding, false);
  assert.equal(released(), 1);
});

test("a busy agent: resolves at the check after it turned quiet, naming who it waited for", async () => {
  const state = { progress: busy("agent-a") as AgentDrainProgress };
  const { drain } = drainWith(state);
  const waiting = drain.begin({ deadlineMs: 60_000 });
  drain.check();
  assert.equal(await settledWithin(waiting), "pending");
  state.progress = quiet;
  drain.check();
  const summary = await waiting;
  assert.equal(summary.finished, "quiet");
  assert.deepEqual(summary.waitedFor, ["agent-a"]);
  assert.deepEqual(summary.notQuiet, []);
});

test("a 1 h request waits 10 minutes at most and returns the busy list", async () => {
  const state = { progress: busy("agent-a") as AgentDrainProgress };
  const { drain, clock } = drainWith(state);
  const waiting = drain.begin({ deadlineMs: 60 * 60_000 });
  clock.advance(AGENT_DRAIN_MAX_DEADLINE_MS - 1);
  assert.equal(await settledWithin(waiting), "pending");
  clock.advance(1);
  const summary = await waiting;
  assert.equal(summary.finished, "deadline");
  assert.equal(summary.deadlineAtMs - 1_000, AGENT_DRAIN_MAX_DEADLINE_MS);
  assert.deepEqual(summary.notQuiet, [{ agentId: "agent-a", reason: "agent_busy" }]);
});

// #13385: a timer may fire before the clock moved its full delay.
test("a deadline timer that fires early re-arms for the time left", async () => {
  const state = { progress: busy("agent-a") as AgentDrainProgress };
  const { drain, clock } = drainWith(state);
  const waiting = drain.begin({ deadlineMs: 5_000 });
  // The poll (at 2 s) and the deadline (at 6 s) are armed. The clock is at
  // 5 s when both fire: the poll re-arms, and the deadline fires 1 s early.
  // (The hold cap at 6 s + 5 min is armed too.)
  assert.deepEqual(clock.pending(), [2_000, 6_000, 306_000]);
  clock.set(5_000);
  assert.equal(clock.fireNext(), 2_000);
  assert.equal(clock.fireNext(), 6_000);
  assert.equal(await settledWithin(waiting), "pending", "not before the deadline");
  assert.deepEqual(clock.pending(), [6_000, 6_000, 306_000], "the poll, and the deadline armed again for the second left");
  clock.advance(1_000);
  assert.equal((await waiting).finished, "deadline");
});

test("the poll is the backstop for an edge no reconcile saw", async () => {
  const state = { progress: busy("agent-a") as AgentDrainProgress };
  const { drain, clock } = drainWith(state);
  const waiting = drain.begin({ deadlineMs: 60_000 });
  state.progress = { live: 0, notQuiet: [] };
  clock.advance(1_000);
  assert.equal((await waiting).finished, "quiet");
  assert.deepEqual(clock.pending(), [61_000 + AGENT_DRAIN_RELEASE_GRACE_MS], "only the hold cap is left: the hold goes on");
});

test("a second begin is the same wait; end before quiet resolves ended and releases starts", async () => {
  const state = { progress: busy("agent-a") as AgentDrainProgress };
  const { drain, released, clock } = drainWith(state);
  const first = drain.begin({ deadlineMs: 60_000 });
  assert.equal(drain.begin({ deadlineMs: 1 }), first);
  const starts = drain.startsReleased();
  assert.equal(await settledWithin(starts), "pending");
  drain.end();
  assert.equal((await first).finished, "ended");
  await starts;
  assert.equal(released(), 1);
  assert.deepEqual(clock.pending(), []);
  assert.equal(await settledWithin(drain.startsReleased()), undefined, "no drain: not held");
});

// Tenny f8ae3b79 condition 1: a hold nobody ends (the upgrade never stopped
// this process) ends itself at the deadline plus the grace, at most 15 min.
// RED proof: drop armRelease and the drain holds for good.
test("a hold nobody ends ends itself at the deadline plus the grace and is traced expired", async () => {
  const state = { progress: busy("agent-a") as AgentDrainProgress };
  const { drain, clock, events, released } = drainWith(state);
  const waiting = drain.begin({ deadlineMs: 60 * 60_000 });
  clock.advance(AGENT_DRAIN_MAX_DEADLINE_MS);
  assert.equal((await waiting).finished, "deadline");
  assert.equal(drain.holding, true, "after the deadline the shutdown is expected: still held");
  clock.advance(AGENT_DRAIN_RELEASE_GRACE_MS - 1);
  assert.equal(drain.holding, true);
  clock.advance(1);
  assert.equal(drain.holding, false, "released at 15 min");
  assert.equal(released(), 1);
  const expired = events.find((event) => event.name === "daemon.agent.drain.expired");
  assert.deepEqual(expired?.attrs, { host: "legacy", held_ms: 15 * 60_000, deadline_ms: AGENT_DRAIN_MAX_DEADLINE_MS });
  assert.ok(AGENT_DRAIN_MAX_DEADLINE_MS + AGENT_DRAIN_RELEASE_GRACE_MS <= 15 * 60_000);
  assert.deepEqual(clock.pending(), [], "no timer left");
});

test("an end before the cap clears it; a quiet drain's hold is capped as well", async () => {
  const { drain, clock, events } = drainWith({ progress: quiet });
  assert.equal((await drain.begin({ deadlineMs: 60_000 })).finished, "quiet");
  assert.deepEqual(clock.pending(), [61_000 + AGENT_DRAIN_RELEASE_GRACE_MS]);
  drain.end();
  assert.deepEqual(clock.pending(), []);
  assert.equal(events.some((event) => event.name === "daemon.agent.drain.expired"), false);
});
