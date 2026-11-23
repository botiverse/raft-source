import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import type { MachineToServerMessage } from "@botiverse/raft-shared";
import { DaemonCore } from "./core";
import type { WebSocketLike } from "./connection";
import {
  flushWithinBound,
  isStartFailureFrame,
  START_FAILURE_FLUSH_DELAY_MS,
  StartFailureFlushScheduler,
  STOP_FLUSH_DEADLINE_MS,
  STOP_FLUSH_TIMEOUT_MS,
  stopFlushBudgetMs,
} from "./telemetryFlush";

// The daemon flushes telemetry after a failed agent start and on shutdown, so a
// short session's failure reaches us without waiting for the next rotation.

const startFailure = {
  type: "agent:activity",
  agentId: "agent-1",
  detail: "Runtime not found",
  detailKind: "runtime_unavailable",
  launchId: "launch-1",
  spawnFailure: { reason: "runtime_spawn_failed" },
} as unknown as MachineToServerMessage;

test("a start failure is the activity frame carrying spawnFailure, and nothing else", () => {
  assert.equal(isStartFailureFrame(startFailure), true);
  assert.equal(isStartFailureFrame({ type: "agent:activity", agentId: "a", detail: "working" } as MachineToServerMessage), false);
  assert.equal(isStartFailureFrame({ type: "agent:status", agentId: "a", status: "inactive" } as unknown as MachineToServerMessage), false);
});

test("the scheduler flushes once after its delay, coalescing requests, and cancel drops a pending one and refuses later requests", async () => {
  let flushes = 0;
  const scheduler = new StartFailureFlushScheduler({ flush: async () => { flushes += 1; }, delayMs: 10 });
  scheduler.request();
  scheduler.request();
  assert.equal(flushes, 0, "never inside the failing call: its trace records come first");
  await new Promise((resolve) => setTimeout(resolve, 40));
  assert.equal(flushes, 1);

  scheduler.request();
  scheduler.cancel();
  await new Promise((resolve) => setTimeout(resolve, 40));
  assert.equal(flushes, 1);

  // After cancel (the daemon is stopping) a start failure arms nothing.
  scheduler.request();
  await new Promise((resolve) => setTimeout(resolve, 40));
  assert.equal(flushes, 1, "no flush armed once stopping began");

  // A failing flush is swallowed.
  const failing = new StartFailureFlushScheduler({ flush: async () => { throw new Error("boom"); }, delayMs: 1 });
  failing.request();
  await new Promise((resolve) => setTimeout(resolve, 20));
});

test("flushWithinBound returns at the bound when the flush hangs, and reports failures without throwing", async () => {
  const started = Date.now();
  assert.equal(await flushWithinBound(() => new Promise(() => undefined), 30), "timed_out");
  assert.ok(Date.now() - started < 1000);
  assert.equal(await flushWithinBound(async () => { throw new Error("boom"); }, 30), "failed");
  assert.equal(await flushWithinBound(() => { throw new Error("sync boom"); }, 30), "failed");
  assert.equal(await flushWithinBound(async () => undefined, 30), "done");
  assert.ok(STOP_FLUSH_TIMEOUT_MS <= 3000, "shutdown waits at most three seconds");
});

test("the shutdown flush gets what is left of the stop budget, at most three seconds", () => {
  assert.equal(stopFlushBudgetMs(0), STOP_FLUSH_TIMEOUT_MS);
  assert.equal(stopFlushBudgetMs(STOP_FLUSH_DEADLINE_MS - 1000), 1000, "agents took most of the budget");
  assert.equal(stopFlushBudgetMs(STOP_FLUSH_DEADLINE_MS + 5), 0, "none left: no flush");
  // The Computer SIGKILLs a runner 18 s after SIGTERM (SHUTDOWN_CHILD_WAIT_TIMEOUT_MS).
  assert.ok(STOP_FLUSH_DEADLINE_MS < 18_000);
});

class FakeWebSocket extends EventEmitter implements WebSocketLike {
  readyState = 0;
  send(): void {}
  close(): void { this.readyState = 3; this.emit("close", 1000, Buffer.from("")); }
  terminate(): void { this.readyState = 3; this.emit("close", 1006, Buffer.from("")); }
  emitOpen(): void { this.readyState = 1; this.emit("open"); }
}

type FakeUploader = {
  flushNow: (reason: string) => Promise<unknown>;
  stopScheduling: () => void;
  stop: () => void;
  reasons: string[];
  stopped: boolean;
  order: string[];
};

async function startCore(flush: (reason: string) => Promise<unknown>) {
  const root = await mkdtemp(path.join(os.tmpdir(), "raft-daemon-telemetry-flush-"));
  let socket!: FakeWebSocket;
  const core = new DaemonCore({
    serverUrl: "http://localhost:13055",
    apiKey: `sk_machine_flush_${process.pid}`,
    slockHome: root,
    dataDir: path.join(root, "agents"),
    machineStateDir: path.join(root, "machines"),
    runtimeDetector: () => ({ ids: [], versions: {} }),
    connectionOptions: { wsFactory: () => { socket = new FakeWebSocket(); return socket; } },
  });
  core.start();
  socket.emitOpen();
  const order: string[] = [];
  const uploader: FakeUploader = {
    reasons: [],
    stopped: false,
    order,
    flushNow(reason) { this.reasons.push(reason); order.push(`flush:${reason}`); return flush(reason); },
    stopScheduling() { order.push("stop_scheduling"); },
    stop() { this.stopped = true; order.push("uploader_stop"); },
  };
  (core as unknown as { traceBundleUploader: FakeUploader }).traceBundleUploader = uploader;
  const hosts = (core as unknown as { agentHosts: { stopAll(): Promise<void> } }).agentHosts;
  const stopAll = hosts.stopAll.bind(hosts);
  hosts.stopAll = async () => { order.push("agents_stop_begin"); await stopAll(); order.push("agents_stopped"); };
  return { core, uploader, cleanup: () => rm(root, { recursive: true, force: true }) };
}

test("a start failure reported by the agent manager flushes telemetry shortly after", async () => {
  const { core, uploader, cleanup } = await startCore(async () => ({ outcome: "flushed" }));
  try {
    const manager = (core as unknown as {
      agentManager: { reportStartFailure(agentId: string, launchId: string, classification: unknown, model: string): void };
    }).agentManager;
    manager.reportStartFailure("agent-1", "launch-1", { reason: "runtime_spawn_failed", detail: "boom", userMessage: "boom" }, "m");
    manager.reportStartFailure("agent-2", "launch-2", { reason: "runtime_spawn_failed", detail: "boom", userMessage: "boom" }, "m");
    assert.deepEqual(uploader.reasons, [], "after the failure's own records, not inside the call");
    await new Promise((resolve) => setTimeout(resolve, START_FAILURE_FLUSH_DELAY_MS + 200));
    assert.deepEqual(uploader.reasons, ["agent_start_failure"], "two failures at once: one flush request");
  } finally {
    await core.stop();
    await cleanup();
  }
});

test("stop flushes after the agents stopped and before the uploader stops, and a hung upload holds it up only to the bound", async () => {
  const { core, uploader, cleanup } = await startCore(() => new Promise(() => undefined));
  try {
    const started = Date.now();
    await core.stop();
    const elapsed = Date.now() - started;
    assert.deepEqual(uploader.reasons, ["daemon_stop"]);
    assert.equal(uploader.stopped, true);
    assert.deepEqual(
      uploader.order,
      ["stop_scheduling", "agents_stop_begin", "agents_stopped", "flush:daemon_stop", "uploader_stop"],
      "a slow upload never delays the agents' stop",
    );
    assert.ok(elapsed < STOP_FLUSH_TIMEOUT_MS + 2000, `stop took ${elapsed} ms`);
  } finally {
    await cleanup();
  }
}, 20_000);

test("a stop on a revoked machine key does not flush (the key cannot authorize an upload) but still stops the uploader", async () => {
  const { core, uploader, cleanup } = await startCore(async () => ({ outcome: "flushed" }));
  try {
    await core.stop({ source: "machine_key_revoked" });
    assert.deepEqual(uploader.reasons, []);
    assert.equal(uploader.stopped, true);
  } finally {
    await cleanup();
  }
});
