import assert from "node:assert/strict";
import type { ChildProcess } from "node:child_process";
import { EventEmitter } from "node:events";
import { logger } from "../logger";
import { AGENT_STOP_KILL_GRACE_MS } from "./processStop";
import { guardRuntimeChild, runtimeChildProcessGroupOptions, takeEarlyChildEvents } from "./runtimeChild";

type FakeChild = ChildProcess & EventEmitter & { kills: string[] };

function fakeChild(): FakeChild {
  const child = new EventEmitter() as unknown as FakeChild;
  const stdout = Object.assign(new EventEmitter(), { resume: () => stdout });
  const stderr = Object.assign(new EventEmitter(), { resume: () => stderr });
  Object.assign(child, {
    pid: 4242,
    exitCode: null,
    signalCode: null,
    kills: [] as string[],
    stdout,
    stderr,
    stdin: new EventEmitter(),
    kill(signal: string) {
      child.kills.push(signal);
      return true;
    },
  });
  return child;
}

const out = (child: FakeChild) => child.stdout as unknown as EventEmitter;

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

test("task #366: a child no session takes over is abandoned: logged, output dropped, terminated", () => {
  vi.useFakeTimers();
  const warn = vi.spyOn(logger, "warn").mockImplementation(() => {});
  const child = fakeChild();
  guardRuntimeChild(child);
  out(child).emit("data", Buffer.from("partial"));
  child.emit("error", Object.assign(new Error("boom"), { code: "EACCES" }));
  assert.equal(warn.mock.calls.length, 0, "recorded quietly while a hand-off may still come");

  vi.advanceTimersByTime(10_000);
  assert.equal(warn.mock.calls.length, 1);
  assert.match(String(warn.mock.calls[0]![0]), /abandoning .*not taken over within 10000ms.*errors=EACCES/);
  assert.deepEqual(child.kills, ["SIGTERM"]);
  // Reconciler step 5: the one stop grace (was a separate 5 s here).
  vi.advanceTimersByTime(AGENT_STOP_KILL_GRACE_MS - 1);
  assert.deepEqual(child.kills, ["SIGTERM"]);
  vi.advanceTimersByTime(1);
  assert.deepEqual(child.kills, ["SIGTERM", "SIGKILL"], "still alive after SIGTERM: SIGKILL");

  out(child).emit("data", Buffer.from("more"));
  child.emit("exit", null, "SIGKILL");
  const early = takeEarlyChildEvents(child);
  assert.match(early!.abandoned ?? "", /not taken over/);
  assert.deepEqual(early!.events.map((event) => event.kind), ["error", "exit"], "no output is held or replayed after abandonment");
});

test("task #366: output past the cap before a hand-off abandons the child instead of truncating it", () => {
  vi.spyOn(logger, "warn").mockImplementation(() => {});
  const child = fakeChild();
  guardRuntimeChild(child);
  const chunk = Buffer.alloc(1024 * 1024, 120);
  for (let i = 0; i < 10; i += 1) out(child).emit("data", chunk);
  const early = takeEarlyChildEvents(child);
  assert.match(early!.abandoned ?? "", /exceeded/);
  assert.equal(early!.events.filter((event) => event.kind === "stdout").length, 0, "nothing partial is offered for replay");
  assert.deepEqual(child.kills, ["SIGTERM"]);
});

test("task #366: a child handed over in time is never abandoned, and the hand-off returns the recorded events once", () => {
  vi.useFakeTimers();
  const warn = vi.spyOn(logger, "warn").mockImplementation(() => {});
  const child = fakeChild();
  guardRuntimeChild(child);
  out(child).emit("data", Buffer.from("a"));
  child.emit("exit", 0, null);

  const early = takeEarlyChildEvents(child);
  assert.equal(early?.abandoned, null);
  assert.deepEqual(early?.events.map((event) => event.kind), ["stdout", "exit"]);
  assert.equal(takeEarlyChildEvents(child), null, "taken only once");
  vi.advanceTimersByTime(60_000);
  assert.equal(warn.mock.calls.length, 0);
  assert.deepEqual(child.kills, []);
});

test("reconciler step 5: an abandoned child's SIGKILL takes its tree (its process group)", () => {
  vi.useFakeTimers();
  vi.spyOn(logger, "warn").mockImplementation(() => {});
  const child = fakeChild();
  const trees: number[] = [];
  guardRuntimeChild(child, { killTree: (pid) => void trees.push(pid) });

  vi.advanceTimersByTime(10_000 + AGENT_STOP_KILL_GRACE_MS);

  assert.deepEqual(trees, [4242]);
  assert.deepEqual(child.kills, ["SIGTERM", "SIGKILL"]);
});

test("reconciler step 5: runtime children lead their own process group on POSIX; Windows keeps the console (taskkill /T walks the tree)", () => {
  assert.deepEqual(runtimeChildProcessGroupOptions("linux"), { detached: true });
  assert.deepEqual(runtimeChildProcessGroupOptions("darwin"), { detached: true });
  assert.deepEqual(runtimeChildProcessGroupOptions("win32"), { detached: false });
});
