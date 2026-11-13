// `raft proc` jobs as the machine owner sees them (#proj-raft-computer:#59):
// `raft-computer status` lists the running ones and `raft-computer stop`
// says how many keep running and how to stop them (`stop --jobs`).
//
// Read from each daemon's ledger, `<Raft home>/machines/<machine>/proc-jobs.json`
// (shared `parseProcJobLedger`), never through the daemon: the per-server
// daemons run in runner processes the service IPC does not reach, `status`
// and `stop` run in the Computer's lite bundle without daemon code, and
// `stop --jobs` runs once the service is gone. A job counts as running, and
// is ever signalled, only while its pid still has the recorded start identity
// (the daemon's `readProcessIdentity` format: `linux:<starttime>` from
// /proc/<pid>/stat, `ps:<lstart>` elsewhere), so a reused pid is never shown
// or touched. Stop is the daemon's group stop: SIGTERM to the job's group,
// the grace, SIGKILL. The ledger is not rewritten here: the next daemon finds
// the stopped jobs gone and records them exited.

import { execFile } from "node:child_process";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { parseProcJobLedger, PROC_JOB_LEDGER_FILE, type ProcJobLedgerEntry } from "@botiverse/raft-shared";

/** The daemon's stop grace (`AGENT_STOP_KILL_GRACE_MS`) and how long a SIGKILL is waited for. */
export const PROC_JOB_STOP_GRACE_MS = 10_000;
const PROC_JOB_KILL_CONFIRM_MS = 5_000;
const POLL_MS = 100;

export interface RunningProcJob {
  agentId: string;
  /** The agent id's first 8 characters. */
  agentShort: string;
  name: string;
  pid: number;
  pgid: number;
  startIdentity: string;
  startedAtMs: number;
}

export interface ProcJobIdentity {
  pgid: number;
  startIdentity: string;
}

export interface ProcJobsDeps {
  platform?: NodeJS.Platform;
  /** Who `pid` is now (tests replace it); null when gone or unreadable. */
  readIdentity?: (pid: number) => Promise<ProcJobIdentity | null>;
  kill?: (target: number, signal: NodeJS.Signals | 0) => void;
  sleep?: (ms: number) => Promise<void>;
  graceMs?: number;
  confirmMs?: number;
}

function runText(command: string, args: string[]): Promise<string> {
  return new Promise((resolve) => {
    execFile(command, args, { timeout: 5_000, windowsHide: true }, (err, stdout) => resolve(err ? "" : String(stdout)));
  });
}

/** The daemon's `readProcessIdentity`, for POSIX (Windows runs no jobs). */
export async function readProcJobIdentity(pid: number, platform: NodeJS.Platform = process.platform): Promise<ProcJobIdentity | null> {
  if (!Number.isInteger(pid) || pid <= 0 || platform === "win32") return null;
  try {
    if (platform === "linux") {
      const text = readFileSync(`/proc/${pid}/stat`, "utf8");
      const close = text.lastIndexOf(")");
      if (close < 0) return null;
      // After ")": state(3) ppid(4) pgrp(5) ... starttime(22).
      const fields = text.slice(close + 2).split(" ");
      const pgid = Number(fields[2]);
      const startTime = fields[19];
      return Number.isInteger(pgid) && startTime ? { pgid, startIdentity: `linux:${startTime}` } : null;
    }
    const line = (await runText("ps", ["-o", "pgid=,lstart=", "-p", String(pid)])).trim();
    const match = /^(\d+)\s+(.+)$/.exec(line);
    return match ? { pgid: Number(match[1]), startIdentity: `ps:${match[2]!.replace(/\s+/g, " ")}` } : null;
  } catch {
    return null;
  }
}

function ledgerEntries(raftHome: string): ProcJobLedgerEntry[] {
  const machinesDir = join(raftHome, "machines");
  let machines: string[];
  try {
    machines = readdirSync(machinesDir);
  } catch {
    return [];
  }
  return machines.flatMap((machine) => {
    try {
      return parseProcJobLedger(readFileSync(join(machinesDir, machine, PROC_JOB_LEDGER_FILE), "utf8"));
    } catch {
      return [];
    }
  });
}

/** The jobs still running on this Computer, oldest first. */
export async function listRunningProcJobs(raftHome: string, deps: ProcJobsDeps = {}): Promise<RunningProcJob[]> {
  const platform = deps.platform ?? process.platform;
  if (platform === "win32") return [];
  const readIdentity = deps.readIdentity ?? ((pid: number) => readProcJobIdentity(pid, platform));
  const candidates = ledgerEntries(raftHome).filter((job) => job.state === "running" && job.startIdentity);
  const live = await Promise.all(candidates.map(async (job) => {
    const identity = await readIdentity(job.pid);
    if (!identity || identity.startIdentity !== job.startIdentity) return null;
    return {
      agentId: job.agentId,
      agentShort: job.agentId.slice(0, 8),
      name: job.name,
      pid: job.pid,
      pgid: job.pgid,
      startIdentity: job.startIdentity!,
      startedAtMs: job.startedAtMs,
    } satisfies RunningProcJob;
  }));
  return live.filter((job): job is RunningProcJob => job !== null).sort((a, b) => a.startedAtMs - b.startedAtMs);
}

export interface StopProcJobsResult {
  /** Exited on SIGTERM. */
  stopped: RunningProcJob[];
  /** Killed after the grace. */
  killed: RunningProcJob[];
  /** Still there after SIGKILL, or could not be signalled. */
  unconfirmed: RunningProcJob[];
}

/** Stop every running job: SIGTERM to its group, the grace, SIGKILL. */
export async function stopRunningProcJobs(raftHome: string, deps: ProcJobsDeps = {}): Promise<StopProcJobsResult> {
  const platform = deps.platform ?? process.platform;
  const readIdentity = deps.readIdentity ?? ((pid: number) => readProcJobIdentity(pid, platform));
  const kill = deps.kill ?? ((target: number, signal: NodeJS.Signals | 0) => { process.kill(target, signal); });
  const sleep = deps.sleep ?? ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)));
  const graceMs = deps.graceMs ?? PROC_JOB_STOP_GRACE_MS;
  const confirmMs = deps.confirmMs ?? PROC_JOB_KILL_CONFIRM_MS;
  const result: StopProcJobsResult = { stopped: [], killed: [], unconfirmed: [] };
  const jobs = await listRunningProcJobs(raftHome, { ...deps, platform, readIdentity });
  await Promise.all(jobs.map(async (job) => {
    // The daemon starts each job as its own group's leader; otherwise only the pid.
    const identity = await readIdentity(job.pid);
    if (!identity || identity.startIdentity !== job.startIdentity) return;
    const target = identity.pgid === job.pid && job.pgid === job.pid ? -job.pid : job.pid;
    const alive = () => {
      try {
        kill(target, 0);
        return true;
      } catch (err) {
        return (err as NodeJS.ErrnoException).code === "EPERM";
      }
    };
    const waitGone = async (ms: number) => {
      for (let waited = 0; waited < ms; waited += POLL_MS) {
        if (!alive()) return true;
        await sleep(POLL_MS);
      }
      return !alive();
    };
    try {
      kill(target, "SIGTERM");
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== "ESRCH") result.unconfirmed.push(job);
      return;
    }
    if (await waitGone(graceMs)) {
      result.stopped.push(job);
      return;
    }
    try {
      kill(target, "SIGKILL");
    } catch {
      // Gone between the check and the signal.
    }
    if (await waitGone(confirmMs)) result.killed.push(job);
    else result.unconfirmed.push(job);
  }));
  return result;
}

/** `2h`, `5m`, `30s`, `3d`: the largest whole unit (as `raft proc list`). */
export function formatProcJobAge(ms: number): string {
  const seconds = Math.max(0, Math.floor(ms / 1000));
  if (seconds < 60) return `${seconds}s`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m`;
  const hours = Math.floor(minutes / 60);
  if (hours < 48) return `${hours}h`;
  return `${Math.floor(hours / 24)}d`;
}

export const STOP_JOBS_COMMAND = "raft-computer stop --jobs";

const plural = (count: number) => (count === 1 ? "job" : "jobs");

/** `raft-computer status`: the running jobs, one row each, and how to stop them. */
export function formatProcJobsStatus(jobs: readonly RunningProcJob[], nowMs: number): string[] {
  if (jobs.length === 0) return ["Agent jobs (raft proc): none running"];
  const pad = (text: string, width: number) => text.padEnd(width);
  const nameWidth = Math.max(4, ...jobs.map((job) => job.name.length)) + 2;
  return [
    `Agent jobs (raft proc): ${jobs.length} running`,
    `  ${pad("AGENT", 10)}${pad("NAME", nameWidth)}${pad("PID", 9)}RUNNING`,
    ...jobs.map((job) => `  ${pad(job.agentShort, 10)}${pad(job.name, nameWidth)}${pad(String(job.pid), 9)}${formatProcJobAge(nowMs - job.startedAtMs)}`),
    `  Stop them all: ${STOP_JOBS_COMMAND}`,
  ];
}

/** `raft-computer stop` without `--jobs`: what keeps running and the command that stops it. */
export function formatProcJobsLeftRunning(jobs: readonly RunningProcJob[]): string[] {
  if (jobs.length === 0) return [];
  return [
    `${jobs.length} agent ${plural(jobs.length)} (raft proc) still running; ${jobs.length === 1 ? "it keeps" : "they keep"} running without Raft Computer. Stop ${jobs.length === 1 ? "it" : "them"}: ${STOP_JOBS_COMMAND}`,
  ];
}

/** `raft-computer stop --jobs`: how the jobs ended. */
export function formatProcJobsStopped(result: StopProcJobsResult): string[] {
  const ended = result.stopped.length + result.killed.length;
  const lines: string[] = [];
  if (ended === 0 && result.unconfirmed.length === 0) return ["No agent jobs (raft proc) running."];
  if (ended > 0) {
    const killed = result.killed.length > 0 ? ` (${result.killed.length} killed after the ${PROC_JOB_STOP_GRACE_MS / 1000} s grace)` : "";
    lines.push(`Stopped ${ended} agent ${plural(ended)} (raft proc)${killed}.`);
  }
  for (const job of result.unconfirmed) {
    lines.push(`Could not stop ${job.agentShort}/${job.name} (pid ${job.pid}); stop it yourself: kill -9 -- -${job.pgid}`);
  }
  return lines;
}
