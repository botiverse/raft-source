// `raft proc` reply text. Every reply ends with the runnable next step.
// Job names are validated (`^[A-Za-z0-9_-]{1,40}$`) and log paths are built
// by the daemon from the agent id and the name; the command's basename is the
// one free-text field and is folded onto its line.
import type { DaemonApiResponseByRoute } from "@botiverse/raft-shared";
import { foldAgentOneLineText, PROC_LOGS_FOLLOW_MAX_MS } from "@botiverse/raft-shared/src/agentCliSurface";

import { axSurface } from "../../core/renderer";

export type ProcJob = DaemonApiResponseByRoute["procList"]["jobs"][number];

/** The runnable next step after an error or a hand-off, without a job name. */
export const PROC_START_HINT = "raft proc start --name <name> -- <command> [args...]";
export const PROC_FOLLOW_TAIL_HINT_LINES = 100;

export const PROC_UNSUPPORTED_OLDER_DAEMON =
  "This Computer's daemon doesn't run jobs yet; update the Computer, or start it with nohup inside your own process group and stop it with kill -- -<pgid>";
export const PROC_UNSUPPORTED_PLATFORM =
  "This Computer's daemon doesn't run jobs on this platform yet; start it in the background yourself and stop it by its pid";
export const PROC_UNSUPPORTED_UNMANAGED =
  "raft proc runs jobs through the Computer that runs this agent, and this agent isn't run by one; start it with nohup inside your own process group and stop it with kill -- -<pgid>";

const SAMPLE_JOB: ProcJob = {
  name: "web",
  pid: 4242,
  state: "running",
  command: "node",
  startedAt: "2026-11-10T10:00:00.000Z",
  exitedAt: null,
  exitCode: null,
  exitSignal: null,
  logPath: "/Users/q/.slock/machines/m1/proc/agent-1/web.log",
  scope: "none",
  adopted: false,
};
const SAMPLE_NOW = Date.parse("2026-11-10T12:00:00.000Z");

/** `2h`, `5m`, `30s`, `3d`: the largest whole unit. */
export function formatProcAge(ms: number): string {
  const seconds = Math.max(0, Math.floor(ms / 1000));
  if (seconds < 60) return `${seconds}s`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m`;
  const hours = Math.floor(minutes / 60);
  if (hours < 48) return `${hours}h`;
  return `${Math.floor(hours / 24)}d`;
}

function exitedText(job: ProcJob): string {
  if (job.exitCode !== null) return `exited (code ${job.exitCode})`;
  if (job.exitSignal) return `exited (${job.exitSignal})`;
  return "exited";
}

/** `web · running 2h · pid 4242 · node`, or `bot · exited (code 1) 5m ago`. */
export function formatProcJobRow(job: ProcJob, nowMs: number): string {
  if (job.state === "running") {
    return `${job.name} · running ${formatProcAge(nowMs - Date.parse(job.startedAt))} · pid ${job.pid} · ${foldAgentOneLineText(job.command)}`;
  }
  const exitedAt = job.exitedAt ? Date.parse(job.exitedAt) : nowMs;
  return `${job.name} · ${exitedText(job)} ${formatProcAge(nowMs - exitedAt)} ago`;
}

export const formatProcStarted = axSurface(
  "`raft proc start` success: the job's actual name, its pid, its log and the commands to read and stop it.",
  (job: ProcJob, autoNamed: boolean, stopsWithService = false): string => {
    const named = autoNamed ? ", named after the command (choose one with --name)" : "";
    const started = `Started ${job.name} (pid ${job.pid})${named}, log ${job.logPath}. Logs: raft proc logs ${job.name} · Stop: raft proc stop ${job.name}`;
    return stopsWithService ? `${started}\n${PROC_STOPS_WITH_SERVICE_NOTE}` : started;
  },
  {
    examples: [
      { args: [SAMPLE_JOB, false] },
      { args: [{ ...SAMPLE_JOB, name: "node-2" }, true] },
      { args: [SAMPLE_JOB, false, true] },
    ],
  },
);

/** After `start`, where a restart of the Computer service ends the job (Linux without user systemd). */
export const PROC_STOPS_WITH_SERVICE_NOTE = "On this Computer, jobs stop when the Computer service restarts (an upgrade restarts it): raft proc list shows whether this one is still running.";

export const formatProcList = axSurface(
  "`raft proc list`: one row per background job of this agent (running, or how it exited), then the commands to read and stop one.",
  (jobs: readonly ProcJob[], nowMs: number): string => {
    if (jobs.length === 0) return `No jobs. Start one: ${PROC_START_HINT}`;
    const rows = jobs.map((job) => formatProcJobRow(job, nowMs));
    const last = jobs[jobs.length - 1]!.name;
    // Stop names a job that is still running; with none running there is nothing to stop.
    const running = [...jobs].reverse().find((job) => job.state === "running");
    const next = running ? `Logs: raft proc logs ${last} · Stop: raft proc stop ${running.name}` : `Logs: raft proc logs ${last}`;
    return [...rows, next].join("\n");
  },
  {
    examples: [
      { args: [[SAMPLE_JOB, { ...SAMPLE_JOB, name: "bot", pid: 4300, state: "exited", exitCode: 1, exitedAt: "2026-11-10T11:55:00.000Z" }], SAMPLE_NOW] },
      { args: [[], SAMPLE_NOW] },
    ],
  },
);

/** The proc_limit refusal: the running jobs and how to stop one, not only the limit. */
export function formatProcLimitMessage(jobs: readonly ProcJob[], maxJobs: number, nowMs: number): string {
  const running = jobs.filter((job) => job.state === "running");
  const rows = running.map((job) => `  ${formatProcJobRow(job, nowMs)}`);
  const example = running[0]?.name ?? "<name>";
  return [`This agent already runs ${running.length} jobs, the most it can run at once (${maxJobs}):`, ...rows, `Stop one first: raft proc stop ${example}`].join("\n");
}

export const formatProcStopped = axSurface(
  "`raft proc stop` success: how the job ended (exited on SIGTERM, killed after the grace or at once with --force, or had already exited) and the next command.",
  (job: ProcJob, outcome: "exited" | "killed" | "already_exited", graceMs: number): string => {
    if (outcome === "already_exited") {
      return `${job.name} had already ${exitedText(job)}. Logs: raft proc logs ${job.name}`;
    }
    const how = outcome === "exited"
      ? ""
      : graceMs === 0 ? ": killed at once (--force)" : `: killed after the ${Math.round(graceMs / 1000)} s grace`;
    return `Stopped ${job.name} (pid ${job.pid})${how}. List: raft proc list`;
  },
  {
    examples: [
      { args: [SAMPLE_JOB, "exited", 10_000] },
      { args: [SAMPLE_JOB, "killed", 10_000] },
      { args: [{ ...SAMPLE_JOB, state: "exited", exitCode: 1 }, "already_exited", 10_000] },
    ],
  },
);

/** The line before a log's text. */
export const formatProcLogsHeader = axSurface(
  "`raft proc logs` header: which job's log follows, its state and where the file is.",
  (job: ProcJob, lines: number): string => `${job.name} (${job.state === "running" ? `running, pid ${job.pid}` : exitedText(job)}): last ${lines} line${lines === 1 ? "" : "s"} of ${job.logPath}`,
  { examples: [{ args: [SAMPLE_JOB, 50] }] },
);

/** The line after a log's text (`--follow` ended, or a plain tail). */
export const formatProcLogsFooter = axSurface(
  "`raft proc logs` footer: the next command (follow, a longer tail after --follow's time limit, or stop).",
  (job: ProcJob, mode: "tail" | "follow_timeout" | "follow_exited"): string => {
    if (mode === "follow_timeout") {
      return `Stopped following after ${PROC_LOGS_FOLLOW_MAX_MS / 1000} s. More: raft proc logs ${job.name} --tail ${PROC_FOLLOW_TAIL_HINT_LINES}`;
    }
    if (mode === "follow_exited") {
      return `${job.name} ${exitedText(job)}. More: raft proc logs ${job.name} --tail ${PROC_FOLLOW_TAIL_HINT_LINES}`;
    }
    return job.state === "running"
      ? `Follow: raft proc logs ${job.name} --follow · Stop: raft proc stop ${job.name}`
      : `${job.name} ${exitedText(job)}. Start it again: raft proc start --name ${job.name} -- <command> [args...]`;
  },
  {
    examples: [
      { args: [SAMPLE_JOB, "tail"] },
      { args: [SAMPLE_JOB, "follow_timeout"] },
      { args: [{ ...SAMPLE_JOB, state: "exited", exitCode: 0 }, "follow_exited"] },
    ],
  },
);

/** The log's own text, as the job wrote it (the agent's own job; never parsed). */
export const formatProcLogText = axSurface(
  "`raft proc logs` body: the job's own stdout and stderr lines, unchanged.",
  (text: string): string => text,
  { examples: [{ args: ["listening on :3000\n"] }] },
);
