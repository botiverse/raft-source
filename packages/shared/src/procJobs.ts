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

/**
 * The memory one job may use (its whole process group or scope) before the
 * Computer stops it, unless the machine's owner sets another in
 * `PROC_CONFIG_FILE` (#proj-raft-computer:#114).
 */
export const PROC_MEMORY_MAX_DEFAULT_BYTES = 4 * 1024 * 1024 * 1024;

/**
 * The owner's job settings, `<Raft home>/computer/proc.json`, read at every
 * `raft proc start`: `{ "memoryMaxMb": 4096 }`; 0 turns the cap off.
 */
export const PROC_CONFIG_FILE = "proc.json";
export const PROC_CONFIG_MEMORY_MAX_KEY = "memoryMaxMb";

/**
 * Why a job ended other than the agent's own stop or the job's own exit:
 * `memory_limit`, the Computer stopped it at its cap; `owner_stop`, a person
 * stopped it from the Computer page (`stoppedBy` names them).
 */
export const PROC_EXIT_REASONS = ["memory_limit", "owner_stop"] as const;
export type ProcExitReason = (typeof PROC_EXIT_REASONS)[number];

/**
 * The Raft handle of the person who stopped a job from the Computer page, as
 * the server filled it in from the signed-in person (never the web's word):
 * letters, digits, `_`, `-` and `.`, at most 64 characters. Anything else is
 * read as absent ("stopped by a person").
 */
export const PROC_STOPPED_BY_PATTERN = /^[\p{L}\p{N}_.-]{1,64}$/u;

/** Whether a value is a stopper's handle as `PROC_STOPPED_BY_PATTERN` reads it. */
export function isValidProcStoppedBy(value: unknown): value is string {
  return typeof value === "string" && PROC_STOPPED_BY_PATTERN.test(value);
}

/** `exited: stopped by @tygg`: the same words in `raft proc list`, the Inbox notice and the Manual. */
export function formatProcOwnerStopExit(stoppedBy: string | null | undefined): string {
  return isValidProcStoppedBy(stoppedBy) ? `exited: stopped by @${stoppedBy}` : "exited: stopped by a person";
}

/** `4 GB`, `1.5 GB`, `512 MB`: a cap as the agent and the owner read it. */
export function formatProcMemoryCap(bytes: number): string {
  const gb = bytes / (1024 * 1024 * 1024);
  if (Number.isInteger(gb)) return `${gb} GB`;
  return `${Math.max(1, Math.round(bytes / (1024 * 1024)))} MB`;
}

/** `exited: memory_limit (4 GB)`: the same words in `raft proc list`, the Inbox notice and the Manual. */
export function formatProcMemoryLimitExit(memoryMaxBytes: number | null | undefined): string {
  return memoryMaxBytes ? `exited: memory_limit (${formatProcMemoryCap(memoryMaxBytes)})` : "exited: memory_limit";
}

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
  /** The cap the job ran under (bytes); absent or null: none (an older daemon wrote the entry). */
  memoryMaxBytes?: number | null;
  /** Set when the Computer ended the job itself; absent or null otherwise. */
  exitReason?: ProcExitReason | null;
  /** Who holds the job to its cap: the kernel (its own systemd scope) or the daemon's sampling; null: no cap. */
  memoryEnforcedBy?: "kernel" | "sampler" | null;
  /** The systemd scope unit of a capped `created` job (without `.scope`). */
  scopeUnit?: string;
  /** With `exitReason: "owner_stop"`: the handle of the person who stopped it (`PROC_STOPPED_BY_PATTERN`); null: not known. */
  stoppedBy?: string | null;
}

/** The optional fields (memory, exit reason, stopper) as written, or none: a value that isn't one of them is read as absent. */
function normalizeMemoryFields(job: ProcJobLedgerEntry): ProcJobLedgerEntry {
  const { memoryMaxBytes, exitReason, memoryEnforcedBy, scopeUnit, stoppedBy, ...rest } = job;
  return {
    ...rest,
    ...(Number.isSafeInteger(memoryMaxBytes) && memoryMaxBytes! > 0 ? { memoryMaxBytes } : {}),
    ...((PROC_EXIT_REASONS as readonly unknown[]).includes(exitReason) ? { exitReason } : {}),
    ...(memoryEnforcedBy === "kernel" || memoryEnforcedBy === "sampler" ? { memoryEnforcedBy } : {}),
    ...(typeof scopeUnit === "string" && /^raft-proc-[A-Za-z0-9_-]{1,80}$/.test(scopeUnit) ? { scopeUnit } : {}),
    ...(exitReason === "owner_stop" && isValidProcStoppedBy(stoppedBy) ? { stoppedBy } : {}),
  };
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
      && (job.state === "running" || job.state === "exited"))
      .map((job) => normalizeMemoryFields(job));
  } catch {
    return [];
  }
}
