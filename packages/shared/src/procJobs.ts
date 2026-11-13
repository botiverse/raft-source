// `raft proc` (#proj-raft-computer:#59): background jobs the Computer runs on
// behalf of one agent. The daemon spawns, records, adopts and stops them; the
// CLI reaches it through the agent credential proxy (`/internal/agent-api/proc*`,
// daemonApiContract.ts). Shared so both sides name the same limits and codes.

/** What a daemon that runs jobs declares (proxy responses, `runtime-version`, `X-Raft-Client-Capabilities`). */
export const PROC_CAPABILITY = "proc@1";

/** A job name: what `--name` accepts and what an automatic name is made into. */
export const PROC_NAME_PATTERN = /^[A-Za-z0-9_-]{1,40}$/;
export const PROC_NAME_MAX_LENGTH = 40;

/** Jobs one agent can run at once (v1 default; an owner setting later). */
export const PROC_MAX_JOBS_PER_AGENT = 8;

/** One job log's size before it is rotated once to `<name>.log.1` (v1 default). */
export const PROC_LOG_MAX_BYTES = 20 * 1024 * 1024;

/** `raft proc logs --follow` stops after this long, so a tool call never hangs. */
export const PROC_LOGS_FOLLOW_MAX_MS = 30_000;

/** Lines `raft proc logs` prints without `--tail`, and the most it prints with it. */
export const PROC_LOGS_DEFAULT_TAIL = 50;
export const PROC_LOGS_MAX_TAIL = 2_000;

/** The daemon's refusal codes (`code` of a 4xx/5xx proc response). */
export const PROC_ERROR_CODES = [
  "proc_unsupported",
  "proc_invalid_name",
  "proc_invalid_argv",
  "proc_invalid_cwd",
  "proc_name_taken",
  "proc_limit",
  "proc_not_found",
  "proc_spawn_failed",
  "proc_stop_unconfirmed",
  /** Linux: the agent runs in a scope of its own and the caller couldn't be confirmed to be in it. */
  "proc_scope_unconfirmed",
  /** The agent's runtime isn't known to run with full access (a job would get more than the agent has). */
  "proc_runtime_restricted",
] as const;
export type ProcErrorCode = (typeof PROC_ERROR_CODES)[number];

/** Whether a name is a valid job name. */
export function isValidProcName(name: unknown): name is string {
  return typeof name === "string" && PROC_NAME_PATTERN.test(name);
}

/**
 * The jobs ledger, `<machine dir>/proc-jobs.json`. The daemon writes it
 * (atomically); `raft-computer status` and `stop` read it to show and stop
 * the jobs without the daemon. A job is only ever signalled while its pid
 * still has the recorded `startIdentity` (the daemon's `readProcessIdentity`:
 * `linux:<starttime>` from `/proc/<pid>/stat`, `ps:<lstart>` elsewhere).
 */
export const PROC_JOB_LEDGER_FILE = "proc-jobs.json";

export interface ProcJobLedgerEntry {
  agentId: string;
  name: string;
  pid: number;
  pgid: number;
  /** Null until read (or when it could not be read): such a job is never signalled. */
  startIdentity: string | null;
  /** The command's basename, never its arguments. */
  command: string;
  startedAtMs: number;
  logPath: string;
  /** `created`: a user systemd scope of the job's own (Linux). */
  scope: "none" | "agent" | "created";
  state: "running" | "exited";
  exitCode: number | null;
  exitSignal: string | null;
  exitedAtMs: number | null;
  /** Taken over from an earlier daemon: its exit code can't be collected. */
  adopted: boolean;
}

/** The ledger's well-formed entries; anything unreadable is none. */
export function parseProcJobLedger(text: string): ProcJobLedgerEntry[] {
  try {
    const parsed = JSON.parse(text) as { version?: unknown; jobs?: unknown };
    if (parsed?.version !== 1 || !Array.isArray(parsed.jobs)) return [];
    return parsed.jobs.filter((job): job is ProcJobLedgerEntry => Boolean(job)
      && typeof job === "object"
      && typeof job.agentId === "string"
      && isValidProcName(job.name)
      && Number.isInteger(job.pid) && job.pid > 0
      && Number.isInteger(job.pgid) && job.pgid > 0
      && (job.state === "running" || job.state === "exited"));
  } catch {
    return [];
  }
}
