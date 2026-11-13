// `raft proc` jobs in `raft-computer status` and `stop` (#proj-raft-computer:#59),
// read from the daemons' ledgers, with real processes (POSIX). RED proofs
// (reverse-verified): drop the start-identity check and the reused-pid entry
// is listed and signalled; drop the group target and the job's child
// survives `stop --jobs`.
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PROC_JOB_LEDGER_FILE, type ProcJobLedgerEntry } from "@botiverse/raft-shared";

// The daemon's own identity reader: the ledger's `startIdentity` is what it wrote.
import { readProcessIdentity } from "../../daemon/src/drivers/processTree";
import {
  formatProcJobsLeftRunning,
  formatProcJobsStatus,
  formatProcJobsStopped,
  listRunningProcJobs,
  readProcJobIdentity,
  stopRunningProcJobs,
  type RunningProcJob,
} from "./procJobs";
import { printProcJobsStatus } from "./status";
import { runStop } from "./startStop";

const posix = process.platform !== "win32";
const AGENT = "6a37f503-aa11-499f-ae44-c25280e9451a";
const OTHER = "0badc0de-1111-4111-8111-111111111111";

const homes: string[] = [];
const pids: number[] = [];

afterEach(() => {
  for (const pid of pids.splice(0)) {
    try { process.kill(-pid, "SIGKILL"); } catch { /* gone */ }
  }
  for (const home of homes.splice(0)) rmSync(home, { recursive: true, force: true });
});

function groupAlive(pgid: number): boolean {
  try {
    process.kill(-pgid, 0);
    return true;
  } catch (err) {
    return (err as NodeJS.ErrnoException).code === "EPERM";
  }
}

/** A detached `sh` leading its own group, with a `sleep` child: what the daemon starts. */
function startJob(): number {
  const child = spawn("sh", ["-c", "sleep 60 & wait"], { detached: true, stdio: "ignore" });
  child.unref();
  pids.push(child.pid!);
  return child.pid!;
}

async function entry(agentId: string, name: string, pid: number, startedAtMs: number, overrides: Partial<ProcJobLedgerEntry> = {}): Promise<ProcJobLedgerEntry> {
  const identity = await readProcessIdentity(pid);
  assert.ok(identity, `identity of ${pid}`);
  return {
    agentId,
    name,
    pid,
    pgid: identity.pgid,
    startIdentity: identity.startIdentity,
    command: "sh",
    startedAtMs,
    logPath: `/tmp/${name}.log`,
    scope: "none",
    state: "running",
    exitCode: null,
    exitSignal: null,
    exitedAtMs: null,
    adopted: false,
    ...overrides,
  };
}

function writeLedger(home: string, machine: string, jobs: ProcJobLedgerEntry[]): void {
  const dir = join(home, "machines", machine);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, PROC_JOB_LEDGER_FILE), JSON.stringify({ version: 1, jobs }));
}

function newHome(): string {
  const home = mkdtempSync(join(tmpdir(), "raft-computer-proc-"));
  homes.push(home);
  return home;
}

async function captureStdout(fn: () => Promise<void>): Promise<string> {
  const lines: string[] = [];
  const oldWrite = process.stdout.write.bind(process.stdout);
  process.stdout.write = ((chunk: string | Uint8Array) => {
    lines.push(String(chunk));
    return true;
  }) as typeof process.stdout.write;
  try {
    await fn();
  } finally {
    process.stdout.write = oldWrite;
  }
  return lines.join("");
}

async function withSlockHome<T>(home: string, fn: () => Promise<T>): Promise<T> {
  const old = process.env.SLOCK_HOME;
  process.env.SLOCK_HOME = home;
  try {
    return await fn();
  } finally {
    if (old === undefined) delete process.env.SLOCK_HOME;
    else process.env.SLOCK_HOME = old;
  }
}

test.skipIf(!posix)("the Computer reads a process's identity exactly as the daemon records it", async () => {
  const pid = startJob();
  const daemon = await readProcessIdentity(pid);
  const computer = await readProcJobIdentity(pid);
  assert.deepEqual(computer, { pgid: daemon!.pgid, startIdentity: daemon!.startIdentity });
});

test.skipIf(!posix)("running jobs come from every machine's ledger, only while the pid still has the recorded start identity", async () => {
  const home = newHome();
  const web = startJob();
  const bot = startJob();
  const now = Date.now();
  writeLedger(home, "machine-a", [
    await entry(AGENT, "web", web, now - 2 * 3600_000),
    // A reused pid: the recorded identity is someone else's.
    await entry(AGENT, "stale", bot, now - 60_000, { startIdentity: "ps:Thu Jan  1 00:00:00 1970" }),
    await entry(AGENT, "done", bot, now - 30_000, { state: "exited" }),
  ]);
  writeLedger(home, "machine-b", [await entry(OTHER, "bot", bot, now - 5 * 60_000)]);
  writeLedger(home, "machine-c", []);
  mkdirSync(join(home, "machines", "machine-d"), { recursive: true });
  writeFileSync(join(home, "machines", "machine-d", PROC_JOB_LEDGER_FILE), "{not json");

  const jobs = await listRunningProcJobs(home);
  assert.deepEqual(jobs.map((job) => [job.agentShort, job.name, job.pid]), [["6a37f503", "web", web], ["0badc0de", "bot", bot]]);
  assert.deepEqual(await listRunningProcJobs(newHome()), []);
});

test("status lists each running job (agent short id, name, pid, running time) and the command that stops them all", () => {
  const now = Date.parse("2026-11-11T12:00:00.000Z");
  const job = (name: string, pid: number, agoMs: number, agentShort = "6a37f503"): RunningProcJob => ({
    agentId: `${agentShort}-x`, agentShort, name, pid, pgid: pid, startIdentity: "ps:x", startedAtMs: now - agoMs,
  });
  assert.deepEqual(formatProcJobsStatus([], now), ["Agent jobs (raft proc): none running"]);
  assert.deepEqual(formatProcJobsStatus([job("web", 4242, 2 * 3600_000 + 5_000), job("dev-server", 4300, 90_000, "0badc0de")], now), [
    "Agent jobs (raft proc): 2 running",
    "  AGENT     NAME        PID      RUNNING",
    "  6a37f503  web         4242     2h",
    "  0badc0de  dev-server  4300     1m",
    "  Stop them all: raft-computer stop --jobs",
  ]);
  assert.deepEqual(formatProcJobsLeftRunning([]), []);
  assert.deepEqual(formatProcJobsLeftRunning([job("web", 1, 0)]), [
    "1 agent job (raft proc) still running; it keeps running without Raft Computer. Stop it: raft-computer stop --jobs",
  ]);
  assert.deepEqual(formatProcJobsLeftRunning([job("web", 1, 0), job("bot", 2, 0)]), [
    "2 agent jobs (raft proc) still running; they keep running without Raft Computer. Stop them: raft-computer stop --jobs",
  ]);
  assert.deepEqual(formatProcJobsStopped({ stopped: [], killed: [], unconfirmed: [] }), ["No agent jobs (raft proc) running."]);
  assert.deepEqual(formatProcJobsStopped({ stopped: [job("web", 1, 0)], killed: [job("bot", 2, 0)], unconfirmed: [job("x", 3, 0)] }), [
    "Stopped 2 agent jobs (raft proc) (1 killed after the 10 s grace).",
    "Could not stop 6a37f503/x (pid 3); stop it yourself: kill -9 -- -3",
  ]);
});

test.skipIf(!posix)("status prints the running jobs after the report", async () => {
  const home = newHome();
  const web = startJob();
  writeLedger(home, "machine-a", [await entry(AGENT, "web", web, Date.now() - 3 * 60_000)]);
  const out = await captureStdout(() => printProcJobsStatus(home));
  assert.match(out, /^Agent jobs \(raft proc\): 1 running\n {2}AGENT {5}NAME {2}PID {6}RUNNING\n {2}6a37f503 {2}web {3}\d+\s+3m\n {2}Stop them all: raft-computer stop --jobs\n\n$/);
  assert.ok(out.includes(` ${web} `));
});

test.skipIf(!posix)("stop says how many jobs keep running and the command; stop --jobs stops each job's whole group and never a reused pid", async () => {
  const home = newHome();
  const web = startJob();
  const bot = startJob();
  const stranger = startJob();
  const now = Date.now();
  writeLedger(home, "machine-a", [
    await entry(AGENT, "web", web, now - 60_000),
    await entry(OTHER, "bot", bot, now - 60_000),
    await entry(AGENT, "reused", stranger, now - 60_000, { startIdentity: "ps:Thu Jan  1 00:00:00 1970" }),
  ]);
  const stopDeps = { hostLifecycleOwner: "none" as const, recordLifecycleIntent: false, readPidfile: async () => null };

  const plain = await withSlockHome(home, () => captureStdout(() => runStop({ ...stopDeps, jobs: "report" })));
  assert.match(plain, /Service not running\.\n2 agent jobs \(raft proc\) still running; they keep running without Raft Computer\. Stop them: raft-computer stop --jobs\n$/);
  assert.equal(groupAlive(web), true);

  // restart and setup reuse runStop without `jobs`: nothing about them.
  const quiet = await withSlockHome(home, () => captureStdout(() => runStop(stopDeps)));
  assert.equal(quiet.includes("raft proc"), false);

  const withJobs = await withSlockHome(home, () => captureStdout(() => runStop({ ...stopDeps, jobs: "stop", procJobs: { graceMs: 2_000 } })));
  assert.match(withJobs, /Stopped 2 agent jobs \(raft proc\)\.\n$/);
  assert.equal(groupAlive(web), false, "the job and its sleep child");
  assert.equal(groupAlive(bot), false);
  assert.equal(groupAlive(stranger), true, "a pid whose identity changed is never signalled");

  const again = await stopRunningProcJobs(home);
  assert.deepEqual(again, { stopped: [], killed: [], unconfirmed: [] });
});

test.skipIf(!posix)("stop --jobs kills a job that ignores SIGTERM after the grace", async () => {
  const home = newHome();
  const child = spawn("sh", ["-c", "trap '' TERM; while :; do sleep 1; done"], { detached: true, stdio: "ignore" });
  child.unref();
  pids.push(child.pid!);
  await new Promise((resolve) => setTimeout(resolve, 200));
  writeLedger(home, "machine-a", [await entry(AGENT, "stubborn", child.pid!, Date.now())]);
  const result = await stopRunningProcJobs(home, { graceMs: 300 });
  assert.deepEqual(result.killed.map((job) => job.name), ["stubborn"]);
  assert.equal(groupAlive(child.pid!), false);
});
