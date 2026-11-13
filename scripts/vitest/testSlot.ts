// A machine-wide queue for local test runs: at most RAFT_TEST_SLOTS (2) runs
// at once on a host, across every agent and worktree. Checking "is anyone else
// testing?" before starting races (two agents check at the same moment and both
// start), so a run takes a slot with flock(1) instead:
// taking the lock is atomic.
//
// - The slots live in one fixed directory for the whole machine
//   (/var/tmp/raft-tests/slots, mode 1777), never under HOME or
//   XDG_CACHE_HOME, which differ between agents' environments.
// - flock passes the lock's descriptor to the test command and every process
//   under it, so the slot is held for as long as any of them lives. The
//   command therefore runs in its own process group, and when this launcher is
//   cancelled (SIGINT, SIGTERM) or exits, the whole group is killed (SIGTERM,
//   then SIGKILL after a grace period). A watchdog shell leads the group and
//   does the same if the launcher is killed outright (SIGKILL), which leaves
//   it no chance to: no orphan keeps a slot or memory.
//
// Two ways in:
// - runInTestSlot: a runner script (web `test`, server and daemon `test`)
//   runs the command in a slot, with the process group and watchdog above.
// - holdTestSlotForThisRun: the web, server and daemon Vitest configs call it,
//   so a Vitest started directly (`pnpm exec vitest run <files>`,
//   `npm exec vitest`) also takes a slot before it starts, and holds it until
//   it exits. A run under runInTestSlot already holds one
//   (RAFT_TEST_SLOT_HELD=1) and takes no second.
//
// Skipped in CI (one run per runner), with RAFT_TEST_NO_SLOT=1, and where
// flock(1) isn't installed (a note says so; the run goes ahead unqueued).
// RAFT_TEST_SLOT_DIR moves the slots, for this module's own tests only.
import { spawn, spawnSync } from "node:child_process";
import { chmodSync, mkdirSync } from "node:fs";
import { startDevRun } from "../dev/raftdev-cache";

/** flock's exit code when the slot is taken (-E); a test run never exits with it. */
const SLOT_TAKEN = 213;
const RETRY_MS = 2000;
const KILL_GRACE_MS = 5000;
export const MACHINE_SLOT_DIR = "/var/tmp/raft-tests/slots";

function slotCount() {
  const n = Number(process.env.RAFT_TEST_SLOTS);
  return Number.isInteger(n) && n > 0 ? n : 2;
}

function slotDir() {
  const dir = process.env.RAFT_TEST_SLOT_DIR || MACHINE_SLOT_DIR;
  mkdirSync(dir, { recursive: true });
  // Every user on the host must be able to create and lock a slot file here.
  try {
    chmodSync(dir, 0o1777);
  } catch {
    // Made by someone else: it already has its mode.
  }
  return dir;
}

function hasFlock() {
  const probe = spawnSync("flock", ["--version"], { stdio: "ignore" });
  return !probe.error && probe.status === 0;
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/** The running command's process group, killed if this launcher is cancelled or exits. */
let group = null;

function killGroup(signal) {
  if (group === null) return;
  try {
    process.kill(-group, signal);
  } catch {
    // Already gone.
  }
}

function onCancel(signal) {
  killGroup("SIGTERM");
  const pid = group;
  setTimeout(() => {
    if (pid !== null) {
      try {
        process.kill(-pid, "SIGKILL");
      } catch {
        // Gone.
      }
    }
    process.exit(signal === "SIGINT" ? 130 : 143);
  }, KILL_GRACE_MS).unref();
  // Exit as soon as the group is gone; the timer is the fallback.
  const check = setInterval(() => {
    try {
      process.kill(-pid, 0);
    } catch {
      clearInterval(check);
      process.exit(signal === "SIGINT" ? 130 : 143);
    }
  }, 100);
}

let handlersInstalled = false;
function installHandlers() {
  if (handlersInstalled) return;
  handlersInstalled = true;
  process.once("SIGINT", () => onCancel("SIGINT"));
  process.once("SIGTERM", () => onCancel("SIGTERM"));
  process.on("exit", () => killGroup("SIGKILL"));
}

// The group's leader is this small shell, not the command: it runs the
// command in the background and watches the launcher. If the launcher dies
// without a chance to clean up (SIGKILL, a crash), the shell kills its whole
// group (SIGTERM, then SIGKILL after the grace period), so nothing of the run
// outlives it and keeps a slot. Otherwise it waits and passes the exit status on.
// The shell ignores SIGTERM (set after the command starts, so the command
// doesn't inherit it): its own \`kill -TERM 0\` must not end it before the
// SIGKILL that catches a child ignoring SIGTERM.
const WATCHDOG = `"$@" &
run=$!
trap '' TERM
while kill -0 "$RAFT_TEST_LAUNCHER" 2>/dev/null && kill -0 "$run" 2>/dev/null; do sleep 1; done
if kill -0 "$run" 2>/dev/null; then
  kill -TERM 0 2>/dev/null
  sleep ${KILL_GRACE_MS / 1000}
  kill -KILL 0 2>/dev/null
fi
wait "$run"`;

/** Runs the command in its own process group (stdio inherited); resolves with its exit status. */
function runGroup(command, args, options) {
  return new Promise((resolve) => {
    // RAFT_TEST_SLOT_HELD: the Vitest config inside takes no second slot.
    const env = { ...(options.env ?? process.env), RAFT_TEST_LAUNCHER: String(process.pid), RAFT_TEST_SLOT_HELD: "1" };
    const child = spawn("sh", ["-c", WATCHDOG, "raft-test-run", command, ...args], { ...options, env, detached: true });
    group = child.pid ?? null;
    child.on("error", (error) => {
      group = null;
      resolve({ status: null, error });
    });
    child.on("exit", (code, signal) => {
      // The leader is gone; anything it left in the group goes with it.
      killGroup("SIGKILL");
      group = null;
      resolve({ status: code, signal });
    });
  });
}

/**
 * Runs `command args` once it holds one of the host's test slots, waiting in
 * turn when all are taken. Resolves with `{ status, signal?, error? }`.
 */
function unqueued(env = process.env) {
  return env.CI === "true" || env.CI === "1" || env.RAFT_TEST_NO_SLOT === "1";
}

const waitingNote = (count) =>
  `raft-tests: all ${count} test slots on this host are in use; waiting for another test run to finish… (RAFT_TEST_NO_SLOT=1 skips the queue)`;

export async function runInTestSlot(command, args, options = {}) {
  // The run's TMPDIR and NODE_COMPILE_CACHE on disk, not on a tmpfs /tmp
  // (scripts/dev/raftdev-cache.ts); its temp dir goes when the run ends,
  // also when cancelled (the exit handler).
  const run = startDevRun({ env: options.env ?? process.env });
  process.once("exit", run.cleanup);
  try {
    return await runInTestSlotUnmanaged(command, args, { ...options, env: { ...(options.env ?? process.env), ...run.env } });
  } finally {
    run.cleanup();
  }
}

async function runInTestSlotUnmanaged(command, args, options) {
  installHandlers();
  if (unqueued()) return runGroup(command, args, options);
  if (!hasFlock()) {
    console.error("raft-tests: flock(1) not found; running without the host's test queue.");
    return runGroup(command, args, options);
  }
  const dir = slotDir();
  const slots = Array.from({ length: slotCount() }, (_, i) => `${dir}/${i}.lock`);
  let announced = false;
  for (;;) {
    for (const slot of slots) {
      const result = await runGroup("flock", ["-n", "-E", String(SLOT_TAKEN), slot, command, ...args], options);
      if (result.error || result.status !== SLOT_TAKEN) return result;
    }
    if (!announced) {
      console.error(waitingNote(slots.length));
      announced = true;
    }
    await sleep(RETRY_MS);
  }
}

// The slot holder for a Vitest started directly: flock keeps the slot while
// this shell lives, and the shell lives while the Vitest process does (checked
// every second), so the slot frees even if Vitest is killed outright.
const HOLDER = `echo held
while kill -0 "$1" 2>/dev/null; do sleep 1; done`;

/** Takes `slot` for the life of process `pid`; false when it is taken. */
function holdSlot(slot, pid) {
  return new Promise((resolve) => {
    const child = spawn("flock", ["-n", "-E", String(SLOT_TAKEN), slot, "sh", "-c", HOLDER, "raft-test-slot", String(pid)], {
      stdio: ["ignore", "pipe", "ignore"],
      // Its own group: Ctrl-C in the terminal ends Vitest, and the holder
      // follows within a second rather than racing it.
      detached: true,
    });
    child.on("error", () => resolve(false));
    child.on("exit", () => resolve(false));
    child.stdout.once("data", () => {
      child.stdout.destroy();
      child.unref();
      // Free the slot at once when Vitest exits normally.
      process.once("exit", () => {
        try {
          child.kill("SIGKILL");
        } catch {
          // Gone.
        }
      });
      resolve(true);
    });
  });
}

/** Whether this Vitest runs once (a test run) rather than watching. */
function runsOnce(argv, stdinIsTTY) {
  const args = argv.slice(2);
  if (args.some((arg) => arg === "watch" || arg === "dev" || arg === "--watch" || arg === "-w")) return false;
  if (args.some((arg) => arg === "run" || arg === "--run" || arg === "bench")) return true;
  // Plain `vitest` watches only in an interactive terminal; agents have none.
  return !stdinIsTTY;
}

/**
 * Called by the web, server and daemon Vitest configs: a Vitest started
 * directly waits for one of the host's test slots, as runInTestSlot does, and
 * holds it until it exits. Nothing in CI, with RAFT_TEST_NO_SLOT=1, under a
 * runner that already holds a slot (RAFT_TEST_SLOT_HELD=1), or in watch mode
 * (a watcher would keep its slot for as long as it is open).
 */
export async function holdTestSlotForThisRun({
  env = process.env,
  argv = process.argv,
  stdinIsTTY = process.stdin.isTTY === true,
  pid = process.pid,
} = {}) {
  if (unqueued(env) || env.RAFT_TEST_SLOT_HELD === "1") return false;
  if (!runsOnce(argv, stdinIsTTY)) return false;
  if (!hasFlock()) {
    console.error("raft-tests: flock(1) not found; running without the host's test queue.");
    return false;
  }
  const dir = slotDir();
  const slots = Array.from({ length: slotCount() }, (_, i) => `${dir}/${i}.lock`);
  let announced = false;
  for (;;) {
    for (const slot of slots) {
      if (await holdSlot(slot, pid)) {
        // A config loaded twice in this process takes no second slot.
        env.RAFT_TEST_SLOT_HELD = "1";
        return true;
      }
    }
    if (!announced) {
      console.error(waitingNote(slots.length));
      announced = true;
    }
    await sleep(RETRY_MS);
  }
}
