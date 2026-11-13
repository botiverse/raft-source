// Reconciler step 5: the one stop. RED proof: drop the grace timer and a
// SIGTERM-ignoring process is never killed; drop `killTree` and only the pid
// is signalled; settle `done` before the exit and the first test fails.
import assert from "node:assert/strict";
import { AGENT_STOP_KILL_CONFIRM_MS, AGENT_STOP_KILL_GRACE_MS, stopProcess, type StoppableProcess } from "./processStop";

function fakeProcess(exitOn: ReadonlySet<NodeJS.Signals>) {
  const signals: NodeJS.Signals[] = [];
  const listeners: Array<() => void> = [];
  let exited = false;
  const exit = () => {
    if (exited) return;
    exited = true;
    for (const listener of listeners.splice(0)) listener();
  };
  const proc: StoppableProcess = {
    pid: 4242,
    exited: () => exited,
    onExit: (listener) => void listeners.push(listener),
    signal: (signal) => {
      signals.push(signal);
      if (exitOn.has(signal)) exit();
    },
  };
  return { proc, signals, exit };
}

afterEach(() => {
  vi.useRealTimers();
});

test("the grace is 10 s for every runtime and the exit is then awaited 5 s", () => {
  assert.equal(AGENT_STOP_KILL_GRACE_MS, 10_000);
  assert.equal(AGENT_STOP_KILL_CONFIRM_MS, 5_000);
});

test("SIGTERM, then after the grace the tree kill and SIGKILL; settles only on the observed exit", async () => {
  vi.useFakeTimers();
  const { proc, signals } = fakeProcess(new Set(["SIGKILL"]));
  const trees: number[] = [];
  const escalations: unknown[] = [];
  let outcome: unknown = null;
  const handle = stopProcess(proc, { killTree: () => (trees.push(1), 3), onEscalated: (escalation) => escalations.push(escalation) });
  void handle.done.then((value) => { outcome = value; });

  await vi.advanceTimersByTimeAsync(AGENT_STOP_KILL_GRACE_MS - 1);
  assert.deepEqual(signals, ["SIGTERM"]);
  assert.equal(outcome, null);
  await vi.advanceTimersByTimeAsync(1);
  assert.deepEqual(trees, [1], "the whole tree, not only the pid");
  assert.deepEqual(signals, ["SIGTERM", "SIGKILL"]);
  assert.deepEqual(escalations, [{ pid: 4242, graceMs: AGENT_STOP_KILL_GRACE_MS, treeKilledCount: 3 }]);
  assert.deepEqual(outcome, { kind: "exited", escalated: true, treeKilledCount: 3 });
});

test("a process that exits on SIGTERM is never escalated", async () => {
  vi.useFakeTimers();
  const { proc, signals } = fakeProcess(new Set(["SIGTERM"]));
  let trees = 0;
  const handle = stopProcess(proc, { killTree: () => ++trees });
  assert.deepEqual(await handle.done, { kind: "exited", escalated: false, treeKilledCount: 0 });
  await vi.advanceTimersByTimeAsync(AGENT_STOP_KILL_GRACE_MS * 2);
  assert.deepEqual(signals, ["SIGTERM"]);
  assert.equal(trees, 0);
});

test("no exit after the SIGKILL: given up as unconfirmed after the confirmation window", async () => {
  vi.useFakeTimers();
  const { proc } = fakeProcess(new Set());
  const unconfirmed: unknown[] = [];
  let outcome: unknown = null;
  const handle = stopProcess(proc, { graceMs: 100, confirmMs: 50, killTree: () => 1, onKillUnconfirmed: (info) => unconfirmed.push(info) });
  void handle.done.then((value) => { outcome = value; });

  await vi.advanceTimersByTimeAsync(149);
  assert.equal(outcome, null);
  await vi.advanceTimersByTimeAsync(1);
  assert.deepEqual(outcome, { kind: "kill_unconfirmed", treeKilledCount: 1 });
  assert.deepEqual(unconfirmed, [{ pid: 4242, graceMs: 100, confirmMs: 50 }]);
});

test("SIGKILL as the first signal, or escalateNow, skips the grace", async () => {
  vi.useFakeTimers();
  const first = fakeProcess(new Set(["SIGKILL"]));
  assert.deepEqual(await stopProcess(first.proc, { signal: "SIGKILL", killTree: () => 2 }).done, { kind: "exited", escalated: true, treeKilledCount: 2 });
  assert.deepEqual(first.signals, ["SIGKILL"]);

  const second = fakeProcess(new Set(["SIGKILL"]));
  const handle = stopProcess(second.proc, { killTree: () => 1 });
  await vi.advanceTimersByTimeAsync(1_000);
  handle.escalateNow();
  assert.deepEqual(await handle.done, { kind: "exited", escalated: true, treeKilledCount: 1 });
  assert.deepEqual(second.signals, ["SIGTERM", "SIGKILL"]);
});
