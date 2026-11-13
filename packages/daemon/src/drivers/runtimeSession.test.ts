import { asAxSurfaceText, type AxSurfaceText } from "@botiverse/raft-shared";
import assert from "node:assert/strict";
import type { ChildProcess } from "node:child_process";
import { EventEmitter } from "node:events";
import { guardRuntimeChild, spawnRuntimeChild } from "./runtimeChild";
import { logger } from "../logger";
import { AGENT_STOP_KILL_CONFIRM_MS, AGENT_STOP_KILL_GRACE_MS } from "./processStop";
import { ChildProcessRuntimeSession } from "./runtimeSession";
import type { ParsedEvent, RuntimeDriver, SpawnContext, SpawnResult } from "./types";

class FakeChildProcess extends EventEmitter {
  stdout = new EventEmitter();
  stderr = new EventEmitter();
  stdin = { write: (_chunk: string) => true };
  exitCode: number | null = null;
  signalCode: NodeJS.Signals | null = null;
  pid = 1234;

  kill(signal?: NodeJS.Signals) {
    this.signalCode = signal ?? "SIGTERM";
    this.emit("exit", null, this.signalCode);
    this.emit("close", null, this.signalCode);
    return true;
  }
}

class Utf8Driver implements RuntimeDriver {
  readonly id = "utf8-test";
  readonly lifecycle = { kind: "persistent", stdin: "direct", inFlightWake: "steer" } as const;
  readonly communication = { chat: "slock_cli", runtimeControl: "none" } as const;
  readonly session = { recovery: "fresh", compaction: "unreported", compactionFailure: "does_not_stick" } as const;
  readonly model = { detectedModelsVerifiedAs: "launchable" } as const;
  readonly supportsStdinNotification = true;
  readonly busyDeliveryMode = "direct" as const;
  readonly spawned = new FakeChildProcess();

  spawn(_ctx: SpawnContext): SpawnResult | Promise<SpawnResult> {
    return { process: this.spawned as unknown as ChildProcess };
  }

  parseLine(line: string): ParsedEvent[] {
    const parsed = JSON.parse(line) as { text: string };
    return [{ kind: "text", text: parsed.text }];
  }

  encodeStdinMessage(text: string): string {
    return JSON.stringify({ text });
  }

  buildSystemPrompt(): AxSurfaceText {
    return asAxSurfaceText("");
  }
}

const spawnContext: SpawnContext = {
  agentId: "agent-1",
  config: {
    name: "agent",
    displayName: "Agent",
    description: "test",
    model: "model",
    runtime: "utf8-test",
    reasoningEffort: null,
    envVars: null,
    sessionId: null,
    serverUrl: "https://api.slock.ai",
    authToken: "sk_machine_test",
  } as any,
  standingPrompt: "",
  prompt: "",
  workingDirectory: "/tmp/agent",
  slockCliPath: "/tmp/slock",
  daemonApiKey: "token",
};

test("child-process runtime session decodes split UTF-8 stdout before line parsing", async () => {
  const driver = new Utf8Driver();
  const session = new ChildProcessRuntimeSession(driver, spawnContext);
  const events: ParsedEvent[] = [];
  session.on("runtime_event", (event) => events.push(event));
  await session.start({ text: "start" });

  const line = `${JSON.stringify({ text: "hello 你好" })}\n`;
  const bytes = Buffer.from(line, "utf8");
  const splitAt = bytes.indexOf(Buffer.from("你", "utf8")[0]) + 1;
  driver.spawned.stdout.emit("data", bytes.subarray(0, splitAt));
  driver.spawned.stdout.emit("data", bytes.subarray(splitAt));

  assert.deepEqual(events, [{ kind: "text", text: "hello 你好" }]);
});

test("child-process runtime session emits exit exactly once, including for a failed spawn that gets error and close but no exit", async () => {
  const exitsFor = async (drive: (child: FakeChildProcess) => void) => {
    const driver = new Utf8Driver();
    const session = new ChildProcessRuntimeSession(driver, spawnContext);
    const exits: Array<{ code: number | null; reason?: string }> = [];
    session.on("exit", (info) => exits.push({ code: info.code, reason: info.reason }));
    session.on("error", () => {});
    await session.start({ text: "start" });
    drive(driver.spawned);
    return exits;
  };
  // What Node does on EACCES / ENOENT.
  assert.deepEqual(await exitsFor((child) => {
    child.emit("error", Object.assign(new Error("spawn claude EACCES"), { code: "EACCES" }));
    child.emit("close", -13, null);
  }), [{ code: -13, reason: "error" }]);
  // A process that ran: exit then close.
  assert.deepEqual(await exitsFor((child) => {
    child.emit("exit", 1, null);
    child.emit("close", 1, null);
  }), [{ code: 1, reason: "runtime_exit" }]);
  // An error from a process that ran (its exit follows as usual).
  assert.deepEqual(await exitsFor((child) => {
    child.emit("error", new Error("kill EPERM"));
    child.emit("exit", 0, null);
    child.emit("close", 0, null);
  }), [{ code: 0, reason: "runtime_exit" }]);
});

// Task #366: real children, worst-case timing. The driver hands the child over
// only after it has already ended, so every event RuntimeSession must see
// happened before it listened.
class LateHandoverDriver extends Utf8Driver {
  constructor(
    private readonly command: string,
    private readonly args: string[],
    private readonly afterSpawn: (child: ChildProcess) => Promise<void>,
  ) {
    super();
  }

  override async spawn(_ctx: SpawnContext): Promise<SpawnResult> {
    const child = spawnRuntimeChild(this.command, this.args, { stdio: ["pipe", "pipe", "pipe"] });
    await this.afterSpawn(child);
    return { process: child };
  }
}

const settleTicks = () => new Promise<void>((resolve) => setTimeout(resolve, 50));

test.skipIf(process.platform === "win32")(
  "task #366: a spawn error raised before the session listens is replayed, not thrown",
  async () => {
    // spawnInMacrotask from spawnErrorListenerOrder.test.ts: the driver waits a
    // macrotask after creating the child, so the ENOENT fires with nobody else
    // listening.
    const driver = new LateHandoverDriver("raft-task-366-command-that-does-not-exist", [], settleTicks);
    const session = new ChildProcessRuntimeSession(driver, spawnContext);
    const seen: string[] = [];
    const closed = new Promise<void>((resolve) => session.on("close", () => resolve()));
    session.on("error", (err) => seen.push(`error:${(err as NodeJS.ErrnoException).code}`));
    session.on("exit", (info) => seen.push(`exit:${info.reason}`));

    const started = await session.start({ text: "hello" });
    assert.equal(started.ok, true);
    await closed;
    assert.deepEqual(seen, ["error:ENOENT", "exit:error"]);
  },
);

test.skipIf(process.platform === "win32")(
  "task #366: a child that stops reading stdin turns the prompt write into a handled EPIPE, and its exit still reaches the session",
  async () => {
    // The child closes its stdin and then exits, like a runtime that dies
    // before reading its prompt. The driver's prompt write lands on a closed
    // pipe: a real EPIPE on stdin, raised while nobody but the guard listens.
    const driver = new LateHandoverDriver("sh", ["-c", "exec 0<&-; sleep 0.2; exit 3"], async (child) => {
      await settleTicks();
      child.stdin?.write("x".repeat(1 << 20));
      await new Promise<void>((resolve) => child.once("exit", () => resolve()));
    });
    const session = new ChildProcessRuntimeSession(driver, spawnContext);
    const seen: string[] = [];
    session.on("error", (err) => seen.push(`error:${(err as NodeJS.ErrnoException).code}`));
    session.on("exit", (info) => seen.push(`exit:${info.code}:${info.reason}`));
    session.on("close", (info) => seen.push(`close:${info.code}`));

    const closed = new Promise<void>((resolve) => session.on("close", () => resolve()));
    const started = await session.start({ text: "hello" });
    assert.equal(started.ok, true);
    await closed;
    // exit (and usually close) happened before start() returned; replayed in order.
    assert.deepEqual(seen, ["exit:3:runtime_exit", "close:3"]);

    // A later stdin write to the dead child is handled the same way.
    assert.equal(session.send({ mode: "idle", text: "later" }).ok, false, "a closed session refuses sends");
  },
);

test.skipIf(process.platform === "win32")(
  "task #366: a stdin write to a live child that stopped reading is handled by the session, and the exit still ends it",
  async () => {
    const driver = new LateHandoverDriver("sh", ["-c", "exec 0<&-; sleep 0.4; exit 4"], async () => {});
    const session = new ChildProcessRuntimeSession(driver, spawnContext);
    const seen: string[] = [];
    session.on("error", (err) => seen.push(`error:${(err as NodeJS.ErrnoException).code}`));
    session.on("exit", (info) => seen.push(`exit:${info.code}:${info.reason}`));
    const closed = new Promise<void>((resolve) => session.on("close", () => resolve()));

    assert.equal((await session.start({ text: "hello" })).ok, true);
    await settleTicks();
    // The child is alive but its stdin is closed: the session's own stdin
    // listener takes this EPIPE.
    assert.equal(session.send({ mode: "idle", text: "x".repeat(1 << 20) }).ok, true);
    await closed;
    assert.deepEqual(seen, ["exit:4:runtime_exit"]);
  },
);

test.skipIf(process.platform === "win32")(
  "task #366: final output written before the child ended reaches the session before exit and close",
  async () => {
    // Huaihuai's counterexample: the child prints its last line and exits, and
    // the driver hands it over only after close.
    // stdout, then stderr (the pause makes their arrival order deterministic
    // across the two pipes), then exit.
    const driver = new LateHandoverDriver("sh", ["-c", "printf '{\"text\":\"final\"}\\n'; sleep 0.05; printf 'last words\\n' >&2; exit 0"], async (child) => {
      await new Promise<void>((resolve) => child.once("close", () => resolve()));
    });
    const session = new ChildProcessRuntimeSession(driver, spawnContext);
    const seen: string[] = [];
    session.on("runtime_event", (event) => seen.push(`event:${event.kind === "text" ? event.text : event.kind}`));
    session.on("stderr", (text) => seen.push(`stderr:${text}`));
    session.on("exit", (info) => seen.push(`exit:${info.code}`));
    const closed = new Promise<void>((resolve) => session.on("close", (info) => {
      seen.push(`close:${info.code}`);
      resolve();
    }));

    assert.equal((await session.start({ text: "hello" })).ok, true);
    await closed;
    assert.deepEqual(seen, ["event:final", "stderr:last words", "exit:0", "close:0"]);
  },
);

test("task #366: a session given an abandoned child fails it instead of replaying a partial run", async () => {
  vi.useFakeTimers();
  vi.spyOn(logger, "warn").mockImplementation(() => {});
  try {
    const child = new FakeChildProcess();
    guardRuntimeChild(child as unknown as ChildProcess);
    child.stdout.emit("data", Buffer.from(`${JSON.stringify({ text: "partial" })}\n`));
    // Abandoned: nobody took it over. The fake's kill() emits exit and close.
    vi.advanceTimersByTime(10_000);

    const driver = new Utf8Driver();
    (driver as unknown as { spawned: FakeChildProcess }).spawned = child;
    const session = new ChildProcessRuntimeSession(driver, spawnContext);
    const seen: string[] = [];
    session.on("runtime_event", (event) => seen.push(`event:${event.kind === "text" ? event.text : event.kind}`));
    session.on("error", (err) => seen.push(`error:${/abandoned/.test(err.message) ? "abandoned" : err.message}`));
    session.on("exit", (info) => seen.push(`exit:${info.signal}`));
    session.on("close", (info) => seen.push(`close:${info.signal}`));
    const started = await session.start({ text: "hello" });
    assert.equal(started.ok, false, "the start itself reports the failure");
    assert.match(started.ok ? "" : started.error ?? "", /abandoned/);
    assert.deepEqual(seen, ["error:abandoned", "exit:SIGTERM", "close:SIGTERM"], "no partial output, an explicit failure, then the end");
  } finally {
    vi.useRealTimers();
    vi.restoreAllMocks();
  }
});

class SigtermIgnoringChild extends FakeChildProcess {
  readonly signals: Array<NodeJS.Signals | undefined> = [];

  override kill(signal?: NodeJS.Signals) {
    this.signals.push(signal);
    if (signal === "SIGKILL") return super.kill(signal);
    return true;
  }
}

class SigkillIgnoringChild extends FakeChildProcess {
  readonly signals: Array<NodeJS.Signals | undefined> = [];

  // A process in uninterruptible sleep: no signal ends it, no exit arrives.
  override kill(signal?: NodeJS.Signals) {
    this.signals.push(signal);
    return true;
  }
}

function recordingProcessTree(log: string[]) {
  const descendants = [{ pid: 4321, pgid: 1234 }, { pid: 4322, pgid: 4322 }];
  return {
    snapshotDescendants: async (rootPid: number) => {
      log.push(`snapshotDescendants:${rootPid}`);
      return descendants;
    },
    snapshotTree: async (rootPid: number) => {
      log.push(`snapshot:${rootPid}`);
      return { descendants, rootLeadsGroup: true };
    },
    forceKill: (rootPid: number | undefined, snapshot: unknown) => {
      const tree = snapshot as { descendants: readonly { pid: number }[]; rootLeadsGroup: boolean };
      log.push(`forceKill:${rootPid}:group=${tree.rootLeadsGroup}:${tree.descendants.map((entry) => entry.pid).join(",")}`);
      return 1 + tree.descendants.length;
    },
    killEntries: (entries: readonly { pid: number }[]) => {
      log.push(`killEntries:${entries.map((entry) => entry.pid).join(",")}`);
      return entries.length;
    },
  };
}

function withFakeTimers() {
  vi.useFakeTimers();
  onTestFinished(() => {
    vi.useRealTimers();
  });
}

async function startSession(child: FakeChildProcess, log: string[]) {
  const driver = new Utf8Driver();
  (driver as { spawned: FakeChildProcess }).spawned = child;
  const session = new ChildProcessRuntimeSession(driver, spawnContext, recordingProcessTree(log));
  await session.start({ text: "start" });
  return session;
}

test("reconciler step 5: every stop snapshots the tree before SIGTERM, SIGKILLs the whole tree after the 10 s grace, and settles only on the exit", async () => {
  withFakeTimers();
  const child = new SigtermIgnoringChild();
  const log: string[] = [];
  const session = await startSession(child, log);
  const escalations: unknown[] = [];
  let settled = false;

  const stopped = session.stop({ signal: "SIGTERM", onEscalated: (escalation) => escalations.push(escalation) }).then(() => { settled = true; });
  await vi.advanceTimersByTimeAsync(0);
  assert.deepEqual(log, ["snapshot:1234"], "the tree is read while the runtime is alive, before any signal");
  assert.deepEqual(child.signals, ["SIGTERM"]);

  await vi.advanceTimersByTimeAsync(AGENT_STOP_KILL_GRACE_MS - 1);
  assert.deepEqual(child.signals, ["SIGTERM"], "nothing before the grace ends");
  assert.equal(settled, false, "a stop does not end before the exit");

  await vi.advanceTimersByTimeAsync(1);
  assert.deepEqual(log, ["snapshot:1234", "forceKill:1234:group=true:4321,4322"], "the whole tree: its group and what left it");
  assert.deepEqual(child.signals, ["SIGTERM", "SIGKILL"]);
  assert.deepEqual(escalations, [{ pid: 1234, graceMs: AGENT_STOP_KILL_GRACE_MS, treeKilledCount: 3 }]);
  await stopped;
  assert.equal(settled, true);
});

test("reconciler step 5: a runtime that exits cleanly on SIGTERM keeps what it left running (no tree kill)", async () => {
  withFakeTimers();
  const log: string[] = [];
  const session = await startSession(new FakeChildProcess(), log);

  await session.stop({ signal: "SIGTERM" });
  assert.equal(session.closed, true, "precondition: the fake runtime exits on SIGTERM");

  await vi.advanceTimersByTimeAsync(AGENT_STOP_KILL_GRACE_MS + AGENT_STOP_KILL_CONFIRM_MS);
  assert.deepEqual(log, ["snapshot:1234"], "a background service the agent started on purpose must survive a routine stop");
});

test("reconciler step 5: a second stop joins the first; a SIGKILL one skips what is left of the grace", async () => {
  withFakeTimers();
  const child = new SigtermIgnoringChild();
  const log: string[] = [];
  const session = await startSession(child, log);

  const first = session.stop({ signal: "SIGTERM" });
  await vi.advanceTimersByTimeAsync(1_000);
  const second = session.stop({ signal: "SIGTERM" });
  assert.deepEqual(child.signals, ["SIGTERM"], "one SIGTERM, one grace per process");
  const third = session.stop({ signal: "SIGKILL" });
  await vi.advanceTimersByTimeAsync(0);
  assert.deepEqual(child.signals, ["SIGTERM", "SIGKILL"]);
  assert.deepEqual(log, ["snapshot:1234", "forceKill:1234:group=true:4321,4322"]);
  await Promise.all([first, second, third]);
});

test("reconciler step 5: nothing is written to a session once its stop has begun", async () => {
  withFakeTimers();
  const writes: string[] = [];
  const child = new SigtermIgnoringChild();
  child.stdin = { write: (chunk: string) => (writes.push(chunk), true) };
  const session = await startSession(child, []);

  assert.equal(session.send({ mode: "idle", text: "before" }).ok, true);
  void session.stop({ signal: "SIGTERM" });
  assert.deepEqual(session.send({ mode: "idle", text: "during the grace" }), { ok: false, reason: "closed" });
  assert.equal(writes.length, 1);
  await vi.advanceTimersByTimeAsync(AGENT_STOP_KILL_GRACE_MS);
});

test("reconciler step 5: no exit 5 s after the SIGKILL: the kill is reported unconfirmed and the session reports the exit itself, once", async () => {
  withFakeTimers();
  const child = new SigkillIgnoringChild();
  const session = await startSession(child, []);
  const seen: string[] = [];
  session.on("exit", (info) => seen.push(`exit:${info.signal}`));
  session.on("close", (info) => seen.push(`close:${info.signal}`));
  const unconfirmed: unknown[] = [];

  const stopped = session.stop({ signal: "SIGTERM", onKillUnconfirmed: (info) => unconfirmed.push(info) });
  await vi.advanceTimersByTimeAsync(AGENT_STOP_KILL_GRACE_MS);
  assert.deepEqual(child.signals, ["SIGTERM", "SIGKILL"]);
  await vi.advanceTimersByTimeAsync(AGENT_STOP_KILL_CONFIRM_MS - 1);
  assert.deepEqual(seen, [], "the exit is still awaited");

  await vi.advanceTimersByTimeAsync(1);
  await stopped;
  assert.deepEqual(unconfirmed, [{ pid: 1234, graceMs: AGENT_STOP_KILL_GRACE_MS, confirmMs: AGENT_STOP_KILL_CONFIRM_MS }]);
  assert.deepEqual(seen, ["exit:SIGKILL", "close:SIGKILL"]);
  // The real exit, should it ever come, is not a second one.
  child.emit("exit", null, "SIGKILL");
  child.emit("close", null, "SIGKILL");
  assert.deepEqual(seen, ["exit:SIGKILL", "close:SIGKILL"]);
});

async function realRuntimeWithBackgroundChild(onSigterm: "exit" | "ignore") {
  const { spawn } = await import("node:child_process");
  const { mkdtemp, readFile } = await import("node:fs/promises");
  const { tmpdir } = await import("node:os");
  const { join } = await import("node:path");
  const dir = await mkdtemp(join(tmpdir(), "runtime-stop-"));
  const pidFile = join(dir, "child.pid");
  // A runtime that starts a detached long-running child (an agent's dev server
  // or a hung command), then either exits on SIGTERM or ignores it.
  const script = [
    `const c = require("child_process").spawn("sleep", ["60"], { detached: true, stdio: "ignore" });`,
    `require("fs").writeFileSync(${JSON.stringify(pidFile)}, String(c.pid));`,
    onSigterm === "exit" ? `process.on("SIGTERM", () => process.exit(0));` : `process.on("SIGTERM", () => {});`,
    `setInterval(() => {}, 1000);`,
  ].join("\n");
  const root = spawn(process.execPath, ["-e", script], { stdio: ["pipe", "pipe", "pipe"] });
  let childPid = 0;
  for (let i = 0; i < 100 && !childPid; i += 1) {
    await new Promise((resolve) => setTimeout(resolve, 20));
    childPid = Number((await readFile(pidFile, "utf8").catch(() => "")).trim()) || 0;
  }
  assert.ok(childPid > 0, "precondition: the background child started");
  const driver = new Utf8Driver();
  (driver as { spawned: unknown }).spawned = root;
  const session = new ChildProcessRuntimeSession(driver, spawnContext);
  await session.start({ text: "start" });
  return { session, childPid };
}

function pidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

test(
  "task #25 (real processes): a runtime that exits on SIGTERM keeps the background process it started",
  { skip: process.platform === "win32" },
  async () => {
    const { session, childPid } = await realRuntimeWithBackgroundChild("exit");
    onTestFinished(() => {
      try {
        process.kill(childPid, "SIGKILL");
      } catch {
        // Already gone.
      }
    });

    await session.stop({ signal: "SIGTERM", forceAfterMs: 300 });
    await new Promise((resolve) => setTimeout(resolve, 800));

    assert.equal(session.closed, true);
    assert.equal(pidAlive(childPid), true, "a routine stop must not kill what the agent left running");
  },
);

test(
  "task #25 (real processes): a runtime still alive at the deadline is SIGKILLed with its hung child",
  { skip: process.platform === "win32" },
  async () => {
    const { session, childPid } = await realRuntimeWithBackgroundChild("ignore");

    await session.stop({ signal: "SIGTERM", forceAfterMs: 300 });
    for (let i = 0; i < 100 && (pidAlive(childPid) || !session.closed); i += 1) {
      await new Promise((resolve) => setTimeout(resolve, 20));
    }

    assert.equal(session.closed, true, "the runtime is SIGKILLed");
    assert.equal(pidAlive(childPid), false, "its detached child is killed with it");
  },
);

test(
  "reconciler step 5 (real processes): the SIGKILL reaches a grandchild started after the snapshot, through the runtime's own process group",
  { skip: process.platform === "win32" },
  async () => {
    const { mkdtemp, readFile } = await import("node:fs/promises");
    const { tmpdir } = await import("node:os");
    const { join } = await import("node:path");
    const dir = await mkdtemp(join(tmpdir(), "runtime-stop-group-"));
    const pidFile = join(dir, "grandchild.pid");
    // Claude's background bash: a child that stays in the runtime's group and
    // does not exit with it. Started only on SIGTERM, so the tree snapshot
    // taken before the signal never saw it; only the group kill reaches it.
    const script = [
      `process.on("SIGTERM", () => { const c = require("child_process").spawn("sleep", ["60"], { stdio: "ignore" }); require("fs").writeFileSync(${JSON.stringify(pidFile)}, String(c.pid)); });`,
      `setInterval(() => {}, 1000);`,
    ].join("\n");
    const root = spawnRuntimeChild(process.execPath, ["-e", script], { stdio: ["pipe", "pipe", "pipe"] });
    const driver = new Utf8Driver();
    (driver as { spawned: unknown }).spawned = root;
    const session = new ChildProcessRuntimeSession(driver, spawnContext);
    await session.start({ text: "start" });
    await new Promise((resolve) => setTimeout(resolve, 200));
    let grandchildPid = 0;
    onTestFinished(() => {
      if (grandchildPid > 0 && pidAlive(grandchildPid)) process.kill(grandchildPid, "SIGKILL");
    });
    const escalations: Array<{ treeKilledCount: number }> = [];

    const stopped = session.stop({ signal: "SIGTERM", forceAfterMs: 600, onEscalated: (escalation) => escalations.push(escalation) });
    for (let i = 0; i < 100 && !grandchildPid; i += 1) {
      await new Promise((resolve) => setTimeout(resolve, 20));
      grandchildPid = Number((await readFile(pidFile, "utf8").catch(() => "")).trim()) || 0;
    }
    assert.ok(grandchildPid > 0, "precondition: the grandchild started during the grace");
    await stopped;
    for (let i = 0; i < 50 && pidAlive(grandchildPid); i += 1) await new Promise((resolve) => setTimeout(resolve, 20));

    assert.equal(session.closed, true, "the runtime is SIGKILLed");
    assert.equal(escalations.length, 1);
    assert.equal(pidAlive(grandchildPid), false, "the grandchild in its group is killed with it");
  },
);

test("task #25 step 2: a turn interrupt's stop kills only what the turn started, even after a clean exit, and reports the count", async () => {
  vi.useFakeTimers();
  onTestFinished(() => {
    vi.useRealTimers();
  });
  const driver = new Utf8Driver();
  const log: string[] = [];
  const entries = [
    { pid: 41, pgid: 41, startedAtMs: 500 },
    { pid: 42, pgid: 42, startedAtMs: 2_000 },
    { pid: 43, pgid: 43 },
  ];
  const tree = {
    snapshotDescendants: async () => entries,
    snapshotTree: async () => ({ descendants: entries, rootLeadsGroup: true }),
    forceKill: () => log.push("forceKill"),
    killEntries: (entries: readonly { pid: number }[]) => {
      log.push(`killEntries:${entries.map((entry) => entry.pid).join(",")}`);
      return entries.length;
    },
  };
  const session = new ChildProcessRuntimeSession(driver, spawnContext, tree);
  await session.start({ text: "start" });
  const results: Array<{ killed: number; leftAlone: number }> = [];

  await session.stop({
    signal: "SIGTERM",
    reason: "turn_interrupt",
    turnTreeKill: { startedAtOrAfterMs: 1_000, onResult: (result) => results.push(result) },
  });
  assert.equal(session.closed, true, "precondition: the fake runtime exits on SIGTERM");
  vi.advanceTimersByTime(AGENT_STOP_KILL_GRACE_MS);

  assert.deepEqual(log, ["killEntries:42"], "the turn's process only; never the whole tree");
  assert.deepEqual(results, [{ killed: 1, leftAlone: 2 }]);
});

test("task #25 step 2 stays separate: a turn stop's runtime that ignores SIGTERM is SIGKILLed alone after the grace, never its whole tree", async () => {
  withFakeTimers();
  const driver = new Utf8Driver();
  const child = new SigtermIgnoringChild();
  (driver as { spawned: FakeChildProcess }).spawned = child;
  const log: string[] = [];
  const entries = [{ pid: 41, pgid: 41, startedAtMs: 500 }, { pid: 42, pgid: 42, startedAtMs: 2_000 }];
  const session = new ChildProcessRuntimeSession(driver, spawnContext, {
    snapshotDescendants: async () => entries,
    snapshotTree: async () => ({ descendants: entries, rootLeadsGroup: true }),
    forceKill: () => (log.push("forceKill"), 0),
    killEntries: (selected) => (log.push(`killEntries:${selected.map((entry) => entry.pid).join(",")}`), selected.length),
  });
  await session.start({ text: "start" });

  const stopped = session.stop({ signal: "SIGTERM", reason: "turn_interrupt", turnTreeKill: { startedAtOrAfterMs: 1_000 } });
  await vi.advanceTimersByTimeAsync(AGENT_STOP_KILL_GRACE_MS);
  await stopped;

  assert.deepEqual(child.signals, ["SIGTERM", "SIGKILL"]);
  assert.deepEqual(log, ["killEntries:42"], "what older turns left (MCP servers, a dev server) stays");
});

test("after a native interrupt, killTurnProcesses kills what the turn started and leaves the runtime running", async () => {
  const driver = new Utf8Driver();
  const log: string[] = [];
  const nativeEntries = [
    { pid: 41, pgid: 41, startedAtMs: 500 },
    { pid: 42, pgid: 42, startedAtMs: 2_000 },
    { pid: 44, pgid: 44, startedAtMs: 2_500 },
    { pid: 43, pgid: 43 },
  ];
  const tree = {
    snapshotDescendants: async () => nativeEntries,
    snapshotTree: async () => ({ descendants: nativeEntries, rootLeadsGroup: true }),
    forceKill: () => log.push("forceKill"),
    killEntries: (entries: readonly { pid: number }[]) => {
      log.push(`killEntries:${entries.map((entry) => entry.pid).join(",")}`);
      return entries.length;
    },
  };
  const session = new ChildProcessRuntimeSession(driver, spawnContext, tree);
  await session.start({ text: "start" });

  // Codex leaves the interrupted command, including a setsid child, under the app-server.
  assert.deepEqual(await session.killTurnProcesses(1_000, 3_000), { killed: 2, leftAlone: 2 });
  assert.deepEqual(log, ["killEntries:42,44"], "only what the turn started; a server from before it and unknown ages stay");
  assert.equal(session.closed, false, "the runtime keeps running");

  // The turn ended at 2_200 and a queued message started the next one: what that one started stays.
  log.length = 0;
  assert.deepEqual(await session.killTurnProcesses(1_000, 2_200), { killed: 1, leftAlone: 3 });
  assert.deepEqual(log, ["killEntries:42"]);
});

test("task #25 step 2: interruptTurn writes the driver's interrupt line, or says unsupported", async () => {
  const writes: string[] = [];
  const driver = new Utf8Driver();
  driver.spawned.stdin = { write: (chunk: string) => (writes.push(chunk), true) };
  const session = new ChildProcessRuntimeSession(driver, spawnContext);
  await session.start({ text: "start" });

  assert.equal(session.interruptTurn(), "unsupported", "a driver without an interrupt line");
  (driver as unknown as { encodeInterruptRequest: () => string }).encodeInterruptRequest = () => "{\"type\":\"interrupt\"}";
  assert.equal(session.interruptTurn(), "sent");
  assert.deepEqual(writes, ["{\"type\":\"interrupt\"}\n"]);
});

test(
  "task #25 step 2 (real processes): a turn interrupt kills the command the turn started and keeps a server from before it",
  { skip: process.platform !== "linux" },
  async () => {
    const { spawn } = await import("node:child_process");
    const { mkdtemp, readFile } = await import("node:fs/promises");
    const { tmpdir } = await import("node:os");
    const { join } = await import("node:path");
    const dir = await mkdtemp(join(tmpdir(), "turn-interrupt-"));
    const oldPidFile = join(dir, "old.pid");
    const newPidFile = join(dir, "new.pid");
    // A runtime with a long-running server from an earlier turn, that starts a
    // hung command (its own group, plus a setsid child) when told to on stdin,
    // and exits on SIGTERM without cleaning up.
    const script = [
      `const cp = require("child_process"); const fs = require("fs");`,
      `const old = cp.spawn("sleep", ["61"], { detached: true, stdio: "ignore" }); fs.writeFileSync(${JSON.stringify(oldPidFile)}, String(old.pid));`,
      `process.stdin.on("data", () => { const c = cp.spawn("sh", ["-c", "setsid sleep 62 & echo $! > ${newPidFile}; sleep 63"], { detached: true, stdio: "ignore" }); });`,
      `process.on("SIGTERM", () => process.exit(0));`,
      `setInterval(() => {}, 1000);`,
    ].join("\n");
    const root = spawn(process.execPath, ["-e", script], { stdio: ["pipe", "pipe", "pipe"] });
    const readPidFile = async (file: string) => {
      for (let i = 0; i < 100; i += 1) {
        const pid = Number((await readFile(file, "utf8").catch(() => "")).trim());
        if (pid > 0) return pid;
        await new Promise((resolve) => setTimeout(resolve, 20));
      }
      throw new Error(`no pid in ${file}`);
    };
    const oldPid = await readPidFile(oldPidFile);
    onTestFinished(() => {
      try {
        process.kill(oldPid, "SIGKILL");
      } catch {
        // Already gone.
      }
    });
    // The boot time is whole seconds, so keep the turn well clear of the old server.
    await new Promise((resolve) => setTimeout(resolve, 2_500));
    const turnStartedAtMs = Date.now();
    // Start times are 10 ms ticks; a turn's command comes well after its start (the model replies first).
    await new Promise((resolve) => setTimeout(resolve, 300));
    root.stdin.write("go\n");
    const newPid = await readPidFile(newPidFile);
    const driver = new Utf8Driver();
    (driver as { spawned: unknown }).spawned = root;
    const session = new ChildProcessRuntimeSession(driver, spawnContext);
    await session.start({ text: "start" });
    const results: Array<{ killed: number; leftAlone: number }> = [];

    await session.stop({
      signal: "SIGTERM",
      forceAfterMs: 300,
      reason: "turn_interrupt",
      turnTreeKill: { startedAtOrAfterMs: turnStartedAtMs, onResult: (result) => results.push(result) },
    });
    for (let i = 0; i < 100 && (results.length === 0 || pidAlive(newPid)); i += 1) {
      await new Promise((resolve) => setTimeout(resolve, 20));
    }

    assert.equal(pidAlive(newPid), false, "the turn's command (setsid child included) is killed");
    assert.equal(pidAlive(oldPid), true, "a server from before the turn stays");
    assert.ok(results[0]!.killed >= 2 && results[0]!.leftAlone >= 1, JSON.stringify(results));
  },
);
