import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { test } from "vitest";
import { SERVER_CAPABILITY_MIGRATION_BACKUP_IGNORE_SOURCES_V1, SERVER_CAPABILITY_RUNTIME_DETECTION_ASYNC_V1, type MachineToServerMessage, type ServerToMachineMessage } from "@botiverse/raft-shared";
import { DaemonCore, migrationSummaryMayReportIgnoreSources, type RuntimeDetection } from "./core";
import type { WebSocketLike } from "./connection";
import type { RuntimeDetectionRoundOptions, RuntimeDetectionRoundResult } from "./runtimeDetectionRound";

type ReadyFrame = Extract<MachineToServerMessage, { type: "ready" }>;

class FakeWebSocket extends EventEmitter implements WebSocketLike {
  readyState = 0;
  readonly sent: unknown[] = [];
  send(data: string): void { this.sent.push(JSON.parse(data)); }
  close(): void { this.readyState = 3; this.emit("close", 1000, Buffer.from("")); }
  terminate(): void { this.readyState = 3; this.emit("close", 1006, Buffer.from("")); }
  /** The 101 response (`ws` emits it before `open`); `capabilities` null = no header at all. */
  emitUpgrade(capabilities: string[] | null): void {
    this.emit("upgrade", { headers: capabilities === null ? {} : { "raft-server-capabilities": capabilities.join(" ") } });
  }
  emitOpen(): void { this.readyState = 1; this.emit("open"); }
  emitServerMessage(message: ServerToMachineMessage): void { this.emit("message", Buffer.from(JSON.stringify(message))); }
  emitContext(capabilities?: string[]): void {
    this.emitServerMessage({ type: "machine:context", machineId: "machine-test", serverId: "server-test", ...(capabilities ? { capabilities } : {}) });
  }
  readyFrames(): ReadyFrame[] { return this.sent.filter((m): m is ReadyFrame => (m as { type?: string }).type === "ready"); }
}

/** An injectable round: the test settles it by hand and sees every start/cancel. */
class FakeRounds {
  readonly started: { options: RuntimeDetectionRoundOptions; settle: (r: RuntimeDetectionRoundResult) => void; cancelled: boolean }[] = [];
  run = (options: RuntimeDetectionRoundOptions) => {
    let settle!: (r: RuntimeDetectionRoundResult) => void;
    const result = new Promise<RuntimeDetectionRoundResult>((resolve) => { settle = resolve; });
    const entry = { options, settle, cancelled: false };
    this.started.push(entry);
    return { result, cancel: () => { entry.cancelled = true; } };
  };
}

let coreSeq = 0;
const SYNC_DETECTION: RuntimeDetection = { ids: ["sync-runtime"], versions: { "sync-runtime": "0.1" } };
// Fake runtime ids: a real id would make the model-catalog publish probe a real CLI after the round.
const ROUND_DETECTION: RuntimeDetection = { ids: ["round-alpha", "round-beta"], versions: { "round-alpha": "2.0.0" }, unavailableReasons: { grok: "not_installed" } };

async function withCore(
  fn: (ctx: { core: DaemonCore; sockets: FakeWebSocket[]; rounds: FakeRounds; detectorCalls: () => number }) => Promise<void>,
  extra: Partial<ConstructorParameters<typeof DaemonCore>[0]> = {},
): Promise<void> {
  const dataDir = await mkdtemp(path.join(os.tmpdir(), "raft-daemon-async-detect-"));
  const sockets: FakeWebSocket[] = [];
  const rounds = new FakeRounds();
  let detectorCalls = 0;
  // The daemon machine lock is keyed by server URL + API key under the shared
  // tmp root; a key of our own keeps this file from colliding with core.test.ts
  // when vitest runs both in parallel (CI did: DaemonMachineLockConflictError).
  const core = new DaemonCore({
    serverUrl: "https://daemon.example.com",
    apiKey: `sk_machine_detect_${process.pid}_${++coreSeq}`,
    dataDir,
    runtimeDetector: () => { detectorCalls += 1; return SYNC_DETECTION; },
    runtimeDetectionRound: rounds.run,
    connectionOptions: { wsFactory: () => { const s = new FakeWebSocket(); sockets.push(s); return s; }, minReconnectDelayMs: 10 },
    ...extra,
  });
  try {
    core.start();
    await fn({ core, sockets, rounds, detectorCalls: () => detectorCalls });
  } finally {
    await core.stop();
    await rm(dataDir, { recursive: true, force: true });
  }
}

const tick = () => new Promise((resolve) => setTimeout(resolve, 20));
/** DaemonConnection jitters reconnects up to its spread (seconds); tests wait past it. */
const RECONNECT_WAIT_MS = 20_000;
async function waitFor(condition: () => boolean, what: string, timeoutMs = 3000): Promise<void> {
  const until = Date.now() + timeoutMs;
  while (!condition()) {
    if (Date.now() > until) throw new Error(`timed out waiting for ${what}`);
    await tick();
  }
}

test("task #1268: old server (no header, no context capability) keeps synchronous detection: one ready with inventory and no runtimeDetection", async () => {
  await withCore(async ({ sockets, rounds, detectorCalls }) => {
    const socket = sockets[0]!;
    socket.emitUpgrade(null);
    socket.emitOpen();
    socket.emitContext();
    await tick();
    const frames = socket.readyFrames();
    assert.equal(frames.length, 1);
    assert.deepEqual(frames[0]!.runtimes, ["sync-runtime"]);
    assert.equal("runtimeDetection" in frames[0]!, false);
    assert.equal(rounds.started.length, 0);
    assert.equal(detectorCalls(), 1);
  });
});

test("task #1268: header capability → pending ready without inventory fields, one round, then a complete ready with the inventory", async () => {
  await withCore(async ({ sockets, rounds, detectorCalls }) => {
    const socket = sockets[0]!;
    socket.emitUpgrade([SERVER_CAPABILITY_RUNTIME_DETECTION_ASYNC_V1]);
    socket.emitOpen();
    socket.emitContext([SERVER_CAPABILITY_RUNTIME_DETECTION_ASYNC_V1]);
    await tick();
    const pending = socket.readyFrames();
    assert.equal(pending.length, 1);
    assert.deepEqual(pending[0]!.runtimeDetection, { status: "pending" });
    assert.equal("runtimes" in pending[0]!, false, "a pending ready carries no runtimes key");
    assert.equal("runtimeVersions" in pending[0]!, false);
    assert.equal(rounds.started.length, 1, "exactly one round per connection");
    assert.deepEqual(rounds.started[0]!.options.knownRuntimeIds.slice(0, 2), ["claude", "codex"]);
    assert.equal(detectorCalls(), 0, "the in-process detector is not used on the async path");

    rounds.started[0]!.settle({ status: "complete", detection: ROUND_DETECTION, durationMs: 1234 });
    await tick();
    const frames = socket.readyFrames();
    assert.equal(frames.length, 2);
    assert.deepEqual(frames[1]!.runtimes, ["round-alpha", "round-beta"]);
    assert.deepEqual(frames[1]!.runtimeVersions, { "round-alpha": "2.0.0" });
    assert.deepEqual(frames[1]!.runtimeDetection, { status: "complete", durationMs: 1234 });
  });
});

test("task #1268: an incomplete round reports the unfinished runtimes and the partial inventory", async () => {
  await withCore(async ({ sockets, rounds }) => {
    const socket = sockets[0]!;
    socket.emitUpgrade([SERVER_CAPABILITY_RUNTIME_DETECTION_ASYNC_V1]);
    socket.emitOpen();
    socket.emitContext([SERVER_CAPABILITY_RUNTIME_DETECTION_ASYNC_V1]);
    await tick();
    rounds.started[0]!.settle({ status: "incomplete", reason: "deadline", detection: { ids: ["claude"], versions: {} }, unfinishedRuntimes: ["codex", "grok"], durationMs: 90_000 });
    await tick();
    const frames = socket.readyFrames();
    assert.equal(frames.length, 2);
    assert.deepEqual(frames[1]!.runtimes, ["claude"]);
    assert.deepEqual(frames[1]!.runtimeDetection, { status: "incomplete", reason: "deadline", unfinishedRuntimes: ["codex", "grok"], durationMs: 90_000 });
  });
});

test("task #1268: header says async but machine:context does not → the started round still finishes with a full-inventory ready, no second round", async () => {
  await withCore(async ({ sockets, rounds }) => {
    const socket = sockets[0]!;
    socket.emitUpgrade([SERVER_CAPABILITY_RUNTIME_DETECTION_ASYNC_V1]);
    socket.emitOpen();
    socket.emitContext([]);
    await tick();
    assert.equal(socket.readyFrames().length, 1);
    assert.equal(rounds.started.length, 1);
    rounds.started[0]!.settle({ status: "complete", detection: ROUND_DETECTION, durationMs: 50 });
    await tick();
    const frames = socket.readyFrames();
    assert.equal(frames.length, 2, "pending is always followed by a frame that carries the inventory");
    assert.deepEqual(frames[1]!.runtimes, ["round-alpha", "round-beta"]);
    assert.equal(rounds.started.length, 1);
    // later rescans follow the context (synchronous)
    socket.emitServerMessage({ type: "machine:runtimes:rescan" });
    await tick();
    assert.equal(rounds.started.length, 1);
    assert.deepEqual(socket.readyFrames()[2]!.runtimes, ["sync-runtime"]);
  });
});

test("task #1268: no header but machine:context grants the capability → first ready synchronous, a later rescan uses a round", async () => {
  await withCore(async ({ sockets, rounds }) => {
    const socket = sockets[0]!;
    socket.emitUpgrade(null);
    socket.emitOpen();
    socket.emitContext([SERVER_CAPABILITY_RUNTIME_DETECTION_ASYNC_V1]);
    await tick();
    assert.deepEqual(socket.readyFrames()[0]!.runtimes, ["sync-runtime"]);
    assert.equal(rounds.started.length, 0);
    socket.emitServerMessage({ type: "machine:runtimes:rescan" });
    await tick();
    assert.equal(rounds.started.length, 1);
    assert.deepEqual(socket.readyFrames()[1]!.runtimeDetection, { status: "pending" });
  });
});

test("task #1268: a rescan during a round starts no parallel round; exactly one more round follows the current one", async () => {
  await withCore(async ({ sockets, rounds }) => {
    const socket = sockets[0]!;
    socket.emitUpgrade([SERVER_CAPABILITY_RUNTIME_DETECTION_ASYNC_V1]);
    socket.emitOpen();
    socket.emitContext([SERVER_CAPABILITY_RUNTIME_DETECTION_ASYNC_V1]);
    await tick();
    socket.emitServerMessage({ type: "machine:runtimes:rescan" });
    socket.emitServerMessage({ type: "machine:runtimes:rescan" });
    await tick();
    assert.equal(rounds.started.length, 1, "coalesced while in flight");
    rounds.started[0]!.settle({ status: "complete", detection: ROUND_DETECTION, durationMs: 10 });
    await tick();
    assert.equal(rounds.started.length, 2, "one follow-up round for the queued rescans");
    rounds.started[1]!.settle({ status: "complete", detection: ROUND_DETECTION, durationMs: 11 });
    await tick();
    assert.equal(rounds.started.length, 2);
    const statuses = socket.readyFrames().map((f) => f.runtimeDetection?.status);
    assert.deepEqual(statuses, ["pending", "complete", "pending", "complete"]);
  });
});

test("task #1268: a round is bound to its connection: disconnect cancels it and its late result never lands on the next connection", async () => {
  await withCore(async ({ sockets, rounds }) => {
    const first = sockets[0]!;
    first.emitUpgrade([SERVER_CAPABILITY_RUNTIME_DETECTION_ASYNC_V1]);
    first.emitOpen();
    first.emitContext([SERVER_CAPABILITY_RUNTIME_DETECTION_ASYNC_V1]);
    await tick();
    assert.equal(rounds.started.length, 1);
    first.terminate();
    await tick();
    assert.equal(rounds.started[0]!.cancelled, true, "disconnect kills the round's child tree");
    // reconnect: a fresh socket, fresh capabilities, a fresh round
    // the reconnect delay is jittered up to the connection's spread, so allow for it
    await waitFor(() => sockets.length === 2, "replacement websocket", RECONNECT_WAIT_MS);
    const second = sockets[1]!;
    second.emitUpgrade([SERVER_CAPABILITY_RUNTIME_DETECTION_ASYNC_V1]);
    second.emitOpen();
    second.emitContext([SERVER_CAPABILITY_RUNTIME_DETECTION_ASYNC_V1]);
    await tick();
    assert.equal(rounds.started.length, 2);
    // the old round's late result is ignored
    rounds.started[0]!.settle({ status: "complete", detection: { ids: ["stale"], versions: {} }, durationMs: 1 });
    await tick();
    assert.equal(second.readyFrames().length, 1, "only the new connection's pending frame");
    rounds.started[1]!.settle({ status: "complete", detection: ROUND_DETECTION, durationMs: 2 });
    await tick();
    assert.deepEqual(second.readyFrames()[1]!.runtimes, ["round-alpha", "round-beta"]);
  });
});

test("task #1268: capabilities do not leak across connections: a second connection without the header is synchronous again", async () => {
  await withCore(async ({ sockets, rounds }) => {
    const first = sockets[0]!;
    first.emitUpgrade([SERVER_CAPABILITY_RUNTIME_DETECTION_ASYNC_V1]);
    first.emitOpen();
    first.emitContext([SERVER_CAPABILITY_RUNTIME_DETECTION_ASYNC_V1]);
    await tick();
    rounds.started[0]!.settle({ status: "complete", detection: ROUND_DETECTION, durationMs: 1 });
    await tick();
    first.terminate();
    await waitFor(() => sockets.length === 2, "replacement websocket", RECONNECT_WAIT_MS);
    const second = sockets[1]!;
    second.emitUpgrade(null);
    second.emitOpen();
    second.emitContext();
    await tick();
    assert.equal(rounds.started.length, 1);
    assert.deepEqual(second.readyFrames()[0]!.runtimes, ["sync-runtime"]);
  });
});

// Reviewer counterexamples (Huaihuai, #9665), both through the public rescan entry.
test("reviewer: context downgrade rescan cannot be overwritten by an older async round (the round is abandoned and its child cancelled)", async () => {
  await withCore(async ({ sockets, rounds }) => {
    const socket = sockets[0]!;
    socket.emitUpgrade([SERVER_CAPABILITY_RUNTIME_DETECTION_ASYNC_V1]);
    socket.emitOpen();
    await tick();
    socket.emitContext([]);
    socket.emitServerMessage({ type: "machine:runtimes:rescan" });
    await tick();
    assert.deepEqual(socket.readyFrames().at(-1)!.runtimes, ["sync-runtime"]);
    assert.equal(rounds.started[0]!.cancelled, true, "the superseded round's child is killed, not left to finish");
    rounds.started[0]!.settle({ status: "complete", detection: { ids: ["stale"], versions: {} }, durationMs: 50 });
    await tick();
    assert.deepEqual(socket.readyFrames().at(-1)!.runtimes, ["sync-runtime"], "older result must not replace newer rescan");
    assert.equal(socket.readyFrames().length, 2, "pending, then the synchronous inventory; nothing after");
  });
});

test("reviewer: simultaneous rescans reserve a single starting round", async () => {
  await withCore(async ({ sockets, rounds }) => {
    const socket = sockets[0]!;
    socket.emitUpgrade(null);
    socket.emitOpen();
    socket.emitContext([SERVER_CAPABILITY_RUNTIME_DETECTION_ASYNC_V1]);
    await tick();
    socket.emitServerMessage({ type: "machine:runtimes:rescan" });
    socket.emitServerMessage({ type: "machine:runtimes:rescan" });
    await tick();
    assert.equal(rounds.started.length, 1, "one active child before any result");
    rounds.started[0]!.settle({ status: "complete", detection: ROUND_DETECTION, durationMs: 1 });
    await tick();
    assert.equal(rounds.started.length, 2, "the coalesced rescan runs once more afterwards");
  });
});

test("task #1268: a disconnect while the pending frame is still being prepared leaves no child behind and nothing lands on the next connection", async () => {
  let releaseAcks!: () => void;
  const acksGate = new Promise<void>((resolve) => { releaseAcks = resolve; });
  let ackCalls = 0;
  await withCore(async ({ sockets, rounds }) => {
    const first = sockets[0]!;
    first.emitUpgrade([SERVER_CAPABILITY_RUNTIME_DETECTION_ASYNC_V1]);
    first.emitOpen();
    first.emitContext([SERVER_CAPABILITY_RUNTIME_DETECTION_ASYNC_V1]);
    await waitFor(() => ackCalls === 1, "pending frame preparation reached the lifecycle acks");
    assert.equal(rounds.started.length, 0, "the round is reserved but its child has not started");
    first.terminate();
    await waitFor(() => sockets.length === 2, "replacement websocket", RECONNECT_WAIT_MS);
    releaseAcks();
    await tick();
    assert.equal(rounds.started.length, 0, "the abandoned reservation never starts a child");
    const second = sockets[1]!;
    second.emitUpgrade(null);
    second.emitOpen();
    second.emitContext();
    await tick();
    assert.deepEqual(second.readyFrames()[0]!.runtimes, ["sync-runtime"], "the next connection starts clean");
  }, {
    getComputerLifecycleReadyAcks: async () => { ackCalls += 1; if (ackCalls === 1) await acksGate; return []; },
  });
});

test("reviewer: superseded pending frame must not publish after synchronous completion", async () => {
  let release!: () => void;
  const gate = new Promise<void>((r) => { release = r; });
  let calls = 0;
  await withCore(async ({ sockets, rounds }) => {
    const s = sockets[0]!;
    s.emitUpgrade([SERVER_CAPABILITY_RUNTIME_DETECTION_ASYNC_V1]);
    s.emitOpen();
    await waitFor(() => calls === 1, "first pending send gated");
    s.emitContext([]);
    s.emitServerMessage({ type: "machine:runtimes:rescan" });
    await tick();
    assert.deepEqual(s.readyFrames().at(-1)!.runtimes, ["sync-runtime"]);
    release();
    await tick();
    assert.equal(rounds.started.length, 0);
    assert.deepEqual(s.readyFrames().at(-1)!.runtimes, ["sync-runtime"], "abandoned pending must not land after complete");
    assert.equal(s.readyFrames().length, 1, "the superseded pending is dropped, not sent");
  }, { getComputerLifecycleReadyAcks: async () => { calls++; if (calls === 1) await gate; return []; } });
});

test("task #1268: a round's final frame prepared while a synchronous ready overtakes it is dropped, so the newest inventory is last", async () => {
  let release!: () => void;
  const gate = new Promise<void>((r) => { release = r; });
  let calls = 0;
  await withCore(async ({ sockets, rounds }) => {
    const s = sockets[0]!;
    s.emitUpgrade([SERVER_CAPABILITY_RUNTIME_DETECTION_ASYNC_V1]);
    s.emitOpen();
    s.emitContext([SERVER_CAPABILITY_RUNTIME_DETECTION_ASYNC_V1]);
    await tick();
    assert.equal(s.readyFrames().length, 1, "pending sent");
    // The round settles; its final frame is now waiting on the (gated) lifecycle acks.
    rounds.started[0]!.settle({ status: "complete", detection: { ids: ["round-old"], versions: {} }, durationMs: 1 });
    await waitFor(() => calls === 2, "final frame gated");
    // Meanwhile the server revokes the capability and asks for a rescan: a synchronous inventory goes out now.
    s.emitContext([]);
    s.emitServerMessage({ type: "machine:runtimes:rescan" });
    await tick();
    assert.deepEqual(s.readyFrames().at(-1)!.runtimes, ["sync-runtime"]);
    release();
    await tick();
    assert.deepEqual(s.readyFrames().at(-1)!.runtimes, ["sync-runtime"], "the older round result must not land after the synchronous inventory");
    assert.equal(s.readyFrames().length, 2, "pending, then the synchronous inventory; the stale final frame is dropped");
  }, { getComputerLifecycleReadyAcks: async () => { calls++; if (calls === 2) await gate; return []; } });
});

// Same precedence as asyncDetectionAllowed above: machine:context wins over the
// handshake header, which counts only until the context arrives.
const MIGRATION_IGNORE_SOURCES = SERVER_CAPABILITY_MIGRATION_BACKUP_IGNORE_SOURCES_V1;
const acceptsIgnoreSources = (core: DaemonCore) =>
  (core as unknown as { serverAcceptsMigrationIgnoreSources(): boolean }).serverAcceptsMigrationIgnoreSources();

test("migration ignore sources: granted by machine:context → true, even without the header", async () => {
  await withCore(async ({ core, sockets }) => {
    const socket = sockets[0]!;
    socket.emitUpgrade(null);
    socket.emitOpen();
    socket.emitContext([MIGRATION_IGNORE_SOURCES]);
    await tick();
    assert.equal(acceptsIgnoreSources(core), true);
  });
});

test("migration ignore sources: header only, before any machine:context → true", async () => {
  await withCore(async ({ core, sockets }) => {
    const socket = sockets[0]!;
    socket.emitUpgrade([MIGRATION_IGNORE_SOURCES]);
    socket.emitOpen();
    await tick();
    assert.equal(acceptsIgnoreSources(core), true);
  });
});

test("migration ignore sources: neither header nor context → false", async () => {
  await withCore(async ({ core, sockets }) => {
    const socket = sockets[0]!;
    socket.emitUpgrade(null);
    socket.emitOpen();
    assert.equal(acceptsIgnoreSources(core), false);
    socket.emitContext();
    await tick();
    assert.equal(acceptsIgnoreSources(core), false);
  });
});

test("migration ignore sources: header says yes but machine:context does not → false (the context wins)", async () => {
  await withCore(async ({ core, sockets }) => {
    const socket = sockets[0]!;
    socket.emitUpgrade([MIGRATION_IGNORE_SOURCES]);
    socket.emitOpen();
    socket.emitContext([]);
    await tick();
    assert.equal(acceptsIgnoreSources(core), false);
  });
});

test("migration ignore sources: a conflicting machine:context → false, whatever it advertises", async () => {
  await withCore(async ({ core, sockets }) => {
    const socket = sockets[0]!;
    socket.emitUpgrade([MIGRATION_IGNORE_SOURCES]);
    socket.emitOpen();
    socket.emitContext([MIGRATION_IGNORE_SOURCES]);
    await tick();
    assert.equal(acceptsIgnoreSources(core), true);
    socket.emitServerMessage({ type: "machine:context", machineId: "machine-test", serverId: "server-other", capabilities: [MIGRATION_IGNORE_SOURCES] });
    await tick();
    assert.equal(acceptsIgnoreSources(core), false);
  });
});

test("per-source ignore counts need both the Server and the target Computer to accept them", () => {
  // The target parses the control manifest strictly: a Computer before 1.0.60 rejects the field,
  // so the source sends it only when its lease says the target accepts it.
  assert.equal(migrationSummaryMayReportIgnoreSources(true, { targetAcceptsIgnoreSources: true }), true);
  assert.equal(migrationSummaryMayReportIgnoreSources(true, {}), false);
  assert.equal(migrationSummaryMayReportIgnoreSources(true, { targetAcceptsIgnoreSources: false }), false);
  assert.equal(migrationSummaryMayReportIgnoreSources(false, { targetAcceptsIgnoreSources: true }), false);
});
