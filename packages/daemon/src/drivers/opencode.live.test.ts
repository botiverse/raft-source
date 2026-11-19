/**
 * task #1258 — real-binary contract for the OpenCode 2.x launch path.
 *
 * (The variables start with RAFT_TEST_ because the Vitest setup clears every
 * other RAFT_* variable; under the old RAFT_OPENCODE_LIVE_* names the suite
 * could never be enabled.)
 *
 * Opt-in only: it runs a real `opencode` (2.x) against a free `opencode/*`
 * model, so it needs the network and the model service, neither of which may
 * decide an ordinary CI run. Enable with:
 *
 *   RAFT_TEST_OPENCODE_LIVE=1 \
 *   RAFT_TEST_OPENCODE_LIVE_BIN=/path/to/node_modules/.bin \   # dir holding a 2.x `opencode`; default: PATH
 *   RAFT_TEST_OPENCODE_LIVE_MODEL=opencode/mimo-v2.6-flash-free \   # default
 *   pnpm --filter @botiverse/raft-daemon exec vitest run src/drivers/opencode.live.test.ts
 *
 * The cleanup oracle's negative control at the bottom needs neither and always
 * runs. Every live run gets a fresh HOME / XDG_* / SLOCK_HOME under a temp dir and a temp
 * working directory; nothing is read from or written to the real home. No
 * fixture carries credentials. Verified by hand on OpenCode 2.0.27 (macOS,
 * arm64); Windows is not exercised here and stays unverified for 2.x.
 */
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { ChildProcessRuntimeSession } from "./runtimeSession";
import { OpenCodeDriver, isOpenCodeV2Launch, openCodeSessionRecordPath, readOpenCodeSessionRecord } from "./opencode";
import type { ParsedEvent, SpawnContext } from "./types";

const LIVE = process.env.RAFT_TEST_OPENCODE_LIVE === "1";
const LIVE_BIN_DIR = process.env.RAFT_TEST_OPENCODE_LIVE_BIN;
const LIVE_MODEL = process.env.RAFT_TEST_OPENCODE_LIVE_MODEL || "opencode/mimo-v2.6-flash-free";
const STEP_TIMEOUT_MS = 90_000;

function liveVersion(): string | null {
  const bin = LIVE_BIN_DIR ? path.join(LIVE_BIN_DIR, "opencode") : "opencode";
  try {
    return execFileSync(bin, ["--version"], { encoding: "utf8", timeout: 15_000, stdio: ["ignore", "pipe", "ignore"] }).trim().split(/\r?\n/)[0] || null;
  } catch {
    return null;
  }
}

const liveReady = LIVE && process.platform !== "win32" && isOpenCodeV2Launch(liveVersion());
const liveTest = liveReady ? test : test.skip;

interface LiveEnv {
  root: string;
  workdir: string;
  slockHome: string;
  restore: () => void;
}

function enterLiveEnv(): LiveEnv {
  const root = mkdtempSync(path.join(os.tmpdir(), "raft-opencode-live-"));
  const workdir = path.join(root, "workdir");
  const home = path.join(root, "home");
  const slockHome = path.join(root, "slock-home");
  for (const dir of [workdir, home, slockHome]) mkdirSync(dir, { recursive: true });
  const saved: Record<string, string | undefined> = {};
  const overrides: Record<string, string> = {
    HOME: home,
    XDG_CONFIG_HOME: path.join(home, "xdg-config"),
    XDG_DATA_HOME: path.join(home, "xdg-data"),
    XDG_CACHE_HOME: path.join(home, "xdg-cache"),
    XDG_STATE_HOME: path.join(home, "xdg-state"),
    OPENCODE_TEST_HOME: home,
    OPENCODE_DISABLE_AUTOUPDATE: "1",
    SLOCK_HOME: slockHome,
    RAFT_HOME: slockHome,
    ...(LIVE_BIN_DIR ? { PATH: `${LIVE_BIN_DIR}${path.delimiter}${process.env.PATH ?? ""}` } : {}),
  };
  for (const [key, value] of Object.entries(overrides)) {
    saved[key] = process.env[key];
    process.env[key] = value;
  }
  return {
    root,
    workdir,
    slockHome,
    restore: () => {
      for (const [key, value] of Object.entries(saved)) {
        if (value === undefined) delete process.env[key];
        else process.env[key] = value;
      }
      rmSync(root, { recursive: true, force: true });
    },
  };
}

function liveContext(env: LiveEnv, prompt: string, sessionId: string | null, model = LIVE_MODEL): SpawnContext {
  return {
    agentId: "live-agent",
    standingPrompt: "You are a test agent. Follow the user's instruction literally.",
    prompt,
    workingDirectory: env.workdir,
    slockCliPath: path.join(env.root, "missing-raft-cli.js"),
    daemonApiKey: "live-daemon-key",
    launchId: `launch-${Date.now()}`,
    slockHome: env.slockHome,
    config: {
      name: "Live OpenCode",
      displayName: null,
      description: null,
      runtime: "opencode",
      serverUrl: "https://raft.invalid",
      authToken: "live-agent-token",
      sessionId,
      model,
      reasoningEffort: null,
      envVars: {},
      runtimeContext: {
        agentId: "live-agent",
        serverId: "server-live",
        machineId: "machine-live",
        machineName: "Live Machine",
        machineHostname: "live.local",
        machineOs: `${process.platform} ${process.arch}`,
        daemonVersion: "0.0.0-live",
        workspacePath: env.workdir,
      },
    },
  };
}

interface Collected {
  events: ParsedEvent[];
  exit: { code: number | null; signal: NodeJS.Signals | null };
  /** pids of the CLI and every descendant seen while it ran (the private `serve --stdio` server among them). */
  tree: number[];
}

/** pid → ppid for every process on the box, from `ps`. Throws when `ps` cannot answer: an inspection failure is never "no processes". */
function processParents(): Map<number, number> {
  const parents = new Map<number, number>();
  const out = execFileSync("ps", ["-axo", "pid=,ppid="], { encoding: "utf8" });
  for (const line of out.split("\n")) {
    const match = line.trim().match(/^(\d+)\s+(\d+)$/);
    if (match) parents.set(Number(match[1]), Number(match[2]));
  }
  if (parents.size === 0) throw new Error("ps returned no processes; cannot inspect the process tree");
  return parents;
}

function descendantsOf(root: number, parents: Map<number, number>): number[] {
  const found: number[] = [];
  const queue = [root];
  while (queue.length > 0) {
    const current = queue.shift()!;
    for (const [pid, ppid] of parents) {
      if (ppid === current && !found.includes(pid)) {
        found.push(pid);
        queue.push(pid);
      }
    }
  }
  return found;
}

/**
 * True while `pid` exists and is still an opencode process (guards against
 * pid reuse). A pid that exists but cannot be inspected is reported as an
 * error, not as gone.
 */
export function isLiveOpenCodeProcess(pid: number): boolean {
  try {
    process.kill(pid, 0);
  } catch (error) {
    if ((error as { code?: unknown }).code === "ESRCH") return false;
    throw new Error(`cannot inspect pid ${pid}: ${error instanceof Error ? error.message : String(error)}`);
  }
  const command = execFileSync("ps", ["-o", "command=", "-p", String(pid)], { encoding: "utf8" });
  return /opencode/i.test(command);
}

/** Run a turn to completion, parsing every stdout line through the driver. */
async function runTurn(driver: OpenCodeDriver, ctx: SpawnContext, opts: { killAfterFirstEvent?: NodeJS.Signals } = {}): Promise<Collected & { childPid: number | undefined }> {
  const { process: child } = await driver.spawn(ctx);
  const events: ParsedEvent[] = [];
  let buffered = "";
  let killed = false;
  // Watch the process tree while the CLI runs: the standalone server is a
  // child whose command line names neither HOME nor the workdir, so it can
  // only be found through its parent.
  const tree = new Set<number>(child.pid ? [child.pid] : []);
  let treeError: Error | null = null;
  const treeWatcher = setInterval(() => {
    if (!child.pid || treeError) return;
    try {
      for (const pid of descendantsOf(child.pid, processParents())) tree.add(pid);
    } catch (error) {
      treeError = error instanceof Error ? error : new Error(String(error));
    }
  }, 100);
  treeWatcher.unref?.();
  child.stdout?.setEncoding("utf8");
  child.stdout?.on("data", (chunk: string) => {
    buffered += chunk;
    const lines = buffered.split("\n");
    buffered = lines.pop() ?? "";
    for (const line of lines) {
      events.push(...driver.parseLine(line));
      if (opts.killAfterFirstEvent && !killed && events.length > 0) {
        killed = true;
        child.kill(opts.killAfterFirstEvent);
      }
    }
  });
  const exit = await new Promise<Collected["exit"]>((resolve, reject) => {
    const timer = setTimeout(() => {
      child.kill("SIGKILL");
      reject(new Error(`opencode did not exit within ${STEP_TIMEOUT_MS} ms; events so far: ${JSON.stringify(events)}`));
    }, STEP_TIMEOUT_MS);
    child.once("exit", (code, signal) => {
      clearTimeout(timer);
      resolve({ code, signal });
    });
  });
  clearInterval(treeWatcher);
  if (treeError) throw treeError;
  if (buffered.trim()) events.push(...driver.parseLine(buffered));
  // As RuntimeSession does at the end of stdout.
  events.push(...(driver.parseStdoutEnd?.() ?? []));
  return { events, exit, tree: [...tree], childPid: child.pid };
}

/** The run must have shown its private server (so the check below is not vacuous) and nothing of the tree may survive. */
export function assertTreeGone(run: Pick<Collected, "tree">, label: string): void {
  assert.ok(run.tree.length >= 2, `${label}: expected the CLI and its standalone server in the tree, saw ${JSON.stringify(run.tree)}`);
  const alive = run.tree.filter(isLiveOpenCodeProcess);
  assert.deepEqual(alive, [], `${label}: OpenCode processes still alive: ${JSON.stringify(alive)}`);
}

// Negative control for the oracle above, no network and no OpenCode needed, so
// it runs in ordinary CI: a process that is deliberately still alive (argv0
// "opencode-negative-control", so it looks like an OpenCode process to the
// oracle) must make assertTreeGone fail, and must pass once it is gone.
test("cleanup oracle: a surviving process fails assertTreeGone and a finished one passes", async () => {
  if (process.platform === "win32") return;
  const { spawn } = await import("node:child_process");
  const start = () => spawn("/bin/sleep", ["30"], { argv0: "opencode-negative-control", stdio: "ignore" });
  const exited = (child: ReturnType<typeof start>) => new Promise<void>((resolve) => (child.exitCode !== null ? resolve() : child.once("exit", () => resolve())));
  const a = start();
  const b = start();
  try {
    await settle(200);
    assert.ok(a.pid && b.pid, "spawned");
    const tree = { tree: [a.pid!, b.pid!] };
    assert.equal(isLiveOpenCodeProcess(a.pid!), true, "a survivor is seen as a live opencode process");
    assert.throws(() => assertTreeGone(tree, "both alive"), /still alive/);
    b.kill("SIGKILL");
    await exited(b);
    await settle(100);
    assert.throws(() => assertTreeGone(tree, "one alive"), new RegExp(`still alive: \\[${a.pid}\\]`));
    assert.throws(() => assertTreeGone({ tree: [a.pid!] }, "one pid"), /expected the CLI and its standalone server/);
    a.kill("SIGKILL");
    await exited(a);
    await settle(100);
    assert.equal(isLiveOpenCodeProcess(a.pid!), false, "gone after exit");
    assertTreeGone(tree, "both finished");
  } finally {
    a.kill("SIGKILL");
    b.kill("SIGKILL");
  }
});

async function settle(ms: number): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, ms));
}

liveTest("live 2.x: a turn streams session_init, text and turn_end, exits 0, and records the session", async () => {
  const env = enterLiveEnv();
  try {
    const driver = new OpenCodeDriver();
    const run = await runTurn(driver, liveContext(env, "Reply with exactly: RAFT-LIVE-OK", null));
    assert.equal(run.exit.code, 0, `${JSON.stringify(run.exit)} events=${JSON.stringify(run.events)}`);
    const kinds = run.events.map((event) => event.kind);
    assert.equal(kinds[0], "session_init");
    assert.ok(kinds.includes("text"), `no text event: ${JSON.stringify(run.events)}`);
    // 2.x: the turn_end comes from parseStdoutEnd after a finished reply.
    // 2.0.27 prints no final `step_finish` for a plain reply (only after tool
    // calls), so there it may be missing; the daemon closes a per_turn
    // runtime's turn on process exit (runtimeSession.ts: turnBoundary
    // "process_exit"). A turn_end, when present, must still be last.
    if (kinds.includes("turn_end")) assert.equal(kinds[kinds.length - 1], "turn_end");
    const text = run.events.filter((event): event is Extract<ParsedEvent, { kind: "text" }> => event.kind === "text").map((event) => event.text).join("");
    assert.match(text, /RAFT-LIVE-OK/);

    const read = readOpenCodeSessionRecord(openCodeSessionRecordPath(env.slockHome, "live-agent"));
    assert.equal(read.kind, "record", JSON.stringify(read));
    const record = read.kind === "record" ? read.record : null;
    assert.equal(record?.opencodeMajor, 2);
    const sessionId = (run.events[0] as Extract<ParsedEvent, { kind: "session_init" }>).sessionId;
    assert.equal(record?.sessionId, sessionId);

    // Resume: same session id is accepted on the same major and the turn completes.
    const resumed = await runTurn(new OpenCodeDriver(), liveContext(env, "Reply with exactly: RAFT-LIVE-AGAIN", sessionId));
    assert.equal(resumed.exit.code, 0);
    assert.equal((resumed.events[0] as Extract<ParsedEvent, { kind: "session_init" }>).sessionId, sessionId);

    await settle(1_000);
    assertTreeGone(run, "completed turn");
    assertTreeGone(resumed, "resumed turn");
  } finally {
    env.restore();
  }
}, STEP_TIMEOUT_MS * 3);

liveTest("live 2.x (2.3+): through a RuntimeSession, a turn that starts a background sub-agent ends once, after the sub-agent's result and the final reply", async () => {
  const env = enterLiveEnv();
  try {
    // A RuntimeSession, not runTurn: it takes the child over (runTurn's raw
    // child is abandoned after 10 s) and emits the end-of-stdout turn_end.
    const ctx = liveContext(
      env,
      "Use the subagent tool to start ONE general sub-agent with this instruction: run the bash command 'sleep 5; echo SUB-OK > sub.txt'. "
        + "After the sub-agent has reported back, reply with exactly: RAFT-LIVE-FINAL",
      null,
    );
    const session = new ChildProcessRuntimeSession(new OpenCodeDriver(), ctx);
    const order: string[] = [];
    const events: ParsedEvent[] = [];
    session.on("runtime_event", (event) => { events.push(event); order.push(event.kind); });
    const closed = new Promise<{ code: number | null }>((resolve) => session.on("close", (info) => { order.push("close"); resolve(info); }));
    await session.start({ text: ctx.prompt });
    const close = await Promise.race([closed, settle(STEP_TIMEOUT_MS).then(() => null)]);
    assert.ok(close, `no close within ${STEP_TIMEOUT_MS} ms: ${JSON.stringify(events)}`);
    assert.equal(close.code, 0, JSON.stringify(events));
    assert.equal(order.filter((kind) => kind === "turn_end").length, 1, `one turn_end: ${JSON.stringify(order)}`);
    assert.deepEqual(order.slice(-2), ["turn_end", "close"]);
    const text = events.filter((event): event is Extract<ParsedEvent, { kind: "text" }> => event.kind === "text").map((event) => event.text).join("");
    assert.match(text, /RAFT-LIVE-FINAL/);
    // The sub-agent really ran in the background: its call precedes the final reply.
    const subagentCall = events.findIndex((event) => event.kind === "tool_call" && event.name === "subagent");
    const finalReply = events.findIndex((event) => event.kind === "text" && /RAFT-LIVE-FINAL/.test(event.text));
    assert.ok(subagentCall >= 0 && subagentCall < finalReply, JSON.stringify(events));
    // ...in the agent's workspace: 2.x takes its directory from $PWD (the test runner's otherwise).
    assert.match(readFileSync(path.join(env.workdir, "sub.txt"), "utf8"), /SUB-OK/);
  } finally {
    env.restore();
  }
}, STEP_TIMEOUT_MS * 2);

liveTest("live 2.x: a cancelled turn (SIGTERM) leaves no OpenCode process behind", async () => {
  const env = enterLiveEnv();
  try {
    const run = await runTurn(new OpenCodeDriver(), liveContext(env, "Count slowly from 1 to 200, one number per line.", null), { killAfterFirstEvent: "SIGTERM" });
    assert.ok(run.exit.code !== 0 || run.exit.signal !== null, `expected a non-clean exit, got ${JSON.stringify(run.exit)}`);
    await settle(3_000);
    assertTreeGone(run, "SIGTERM cancel");
  } finally {
    env.restore();
  }
}, STEP_TIMEOUT_MS * 2);

liveTest("live 2.x: a timed-out turn (SIGKILL, as the daemon's startup timeout does) leaves no OpenCode process behind", async () => {
  const env = enterLiveEnv();
  try {
    const run = await runTurn(new OpenCodeDriver(), liveContext(env, "Count slowly from 1 to 200, one number per line.", null), { killAfterFirstEvent: "SIGKILL" });
    assert.equal(run.exit.signal, "SIGKILL");
    await settle(3_000);
    assertTreeGone(run, "SIGKILL timeout");
  } finally {
    env.restore();
  }
}, STEP_TIMEOUT_MS * 2);

liveTest("live 2.x: an unknown model maps to an error event and a non-zero exit", async () => {
  const env = enterLiveEnv();
  try {
    const run = await runTurn(new OpenCodeDriver(), liveContext(env, "hello", null, "opencode/this-model-does-not-exist"));
    assert.notEqual(run.exit.code, 0, JSON.stringify(run.exit));
    const kinds = run.events.map((event) => event.kind);
    assert.ok(kinds.includes("error"), `no error event: ${JSON.stringify(run.events)}`);
    assert.equal(kinds[kinds.length - 1], "turn_end", "the driver ends the turn on an error event");
  } finally {
    env.restore();
  }
}, STEP_TIMEOUT_MS * 2);
