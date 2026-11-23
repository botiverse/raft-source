// `raft proc` jobs as the Computer's owner sees them on the Computer page
// (docs/contracts/proc-jobs.md). The daemon sends `machine:proc_jobs:snapshot`
// (every job it knows, of every agent it runs); the server re-validates it,
// caps it and keeps it for 15 minutes; the web reads it per Computer. A job's
// command line, arguments, working directory, environment and log path never
// cross this boundary: the snapshot has no field for them, and the schema is
// strict, so a payload that carries one is dropped whole.

import { z } from "zod";

import { lazySchema } from "./lazySchema";
import { PROC_NAME_PATTERN, PROC_STOPPED_BY_PATTERN } from "./procJobs";

export const PROC_JOBS_SNAPSHOT_PROTOCOL_VERSION = 1 as const;

/** Jobs of one agent the server keeps from a snapshot (the rest dropped, `capProcJobsSnapshotJobs`). */
export const PROC_JOBS_SNAPSHOT_MAX_JOBS_PER_AGENT = 20;
/** Jobs of one Computer the server keeps from a snapshot. */
export const PROC_JOBS_SNAPSHOT_MAX_JOBS_PER_MACHINE = 200;
/** A snapshot with more entries than this is not read at all (a well-behaved daemon sends far fewer). */
export const PROC_JOBS_SNAPSHOT_MAX_WIRE_JOBS = 2_000;

/**
 * The daemon offers a person's Stop of one job (`machine:proc_job:stop`,
 * answered by `machine:proc_job:stop:result`). Without it the server answers
 * the web `computer_upgrade_required` instead of sending the request.
 */
export const DAEMON_CAPABILITY_PROC_STOP = "machine:proc-job-stop";

/** How a person's Stop of one job ended on the Computer. */
export const PROC_JOB_STOP_OUTCOMES = ["stopped", "not_found", "already_exited", "failed"] as const;
export type ProcJobStopOutcome = (typeof PROC_JOB_STOP_OUTCOMES)[number];

/** An agent id as the daemon names it (a uuid today); bounded, never free text. */
const procJobsAgentIdSchema = lazySchema("procJobsAgentIdSchema", () => z.string().regex(/^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/));
const isoInstantSchema = lazySchema("procJobsIsoInstantSchema", () => z.string().datetime({ offset: true }));

export const procJobsSnapshotJobSchema = lazySchema("procJobsSnapshotJobSchema", () => z.strictObject({
  agentId: procJobsAgentIdSchema,
  name: z.string().regex(PROC_NAME_PATTERN),
  state: z.enum(["running", "exited"]),
  startedAt: isoInstantSchema,
  exitedAt: isoInstantSchema.nullable().optional(),
  /** Null when the exit could not be collected (an adopted job, a signal). */
  exitCode: z.number().int().min(-1_000_000).max(1_000_000).nullable().optional(),
  exitSignal: z.string().regex(/^SIG[A-Z0-9]{1,16}$/).nullable().optional(),
  /**
   * `memory_limit`, `owner_stop` (PROC_EXIT_REASONS); a bounded token, so a
   * reason a newer daemon adds never drops the snapshot (the web shows only
   * the ones it knows).
   */
  exitReason: z.string().regex(/^[a-z_]{1,32}$/).nullable().optional(),
  /** With `owner_stop`: the handle of the person who stopped it. */
  stoppedBy: z.string().regex(PROC_STOPPED_BY_PATTERN).nullable().optional(),
  /** The job's memory cap in bytes; null: none. */
  memoryMaxBytes: z.number().int().positive().nullable().optional(),
  /** The job's process group's resident memory at the daemon's last sample; absent when not sampled. */
  rssBytes: z.number().int().nonnegative().nullable().optional(),
}));
export type ProcJobsSnapshotJob = z.infer<typeof procJobsSnapshotJobSchema>;

export const procJobsSnapshotSchema = lazySchema("procJobsSnapshotSchema", () => z.strictObject({
  protocolVersion: z.literal(PROC_JOBS_SNAPSHOT_PROTOCOL_VERSION),
  /** When the daemon took it. */
  reportedAt: isoInstantSchema,
  jobs: z.array(procJobsSnapshotJobSchema).max(PROC_JOBS_SNAPSHOT_MAX_WIRE_JOBS),
}));
export type ProcJobsSnapshot = z.infer<typeof procJobsSnapshotSchema>;

export function safeParseProcJobsSnapshot(value: unknown) {
  return procJobsSnapshotSchema.safeParse(value);
}

/** Running first, then the newest start, then the name: which jobs a cap keeps. */
function compareJobsForCap(a: ProcJobsSnapshotJob, b: ProcJobsSnapshotJob): number {
  if (a.state !== b.state) return a.state === "running" ? -1 : 1;
  if (a.startedAt !== b.startedAt) return Date.parse(b.startedAt) - Date.parse(a.startedAt);
  return a.name < b.name ? -1 : a.name > b.name ? 1 : 0;
}

/**
 * The jobs a server keeps from a snapshot: only those of `allowedAgentIds`
 * (agents assigned to this Computer now), one entry per agent and name, at
 * most PROC_JOBS_SNAPSHOT_MAX_JOBS_PER_AGENT per agent and
 * PROC_JOBS_SNAPSHOT_MAX_JOBS_PER_MACHINE in all. Deterministic: agents in id
 * order, each agent's jobs running first, then newest.
 */
export function capProcJobsSnapshotJobs(
  jobs: readonly ProcJobsSnapshotJob[],
  allowedAgentIds: ReadonlySet<string>,
): ProcJobsSnapshotJob[] {
  const byAgent = new Map<string, ProcJobsSnapshotJob[]>();
  for (const job of jobs) {
    if (!allowedAgentIds.has(job.agentId)) continue;
    const list = byAgent.get(job.agentId) ?? [];
    if (list.some((other) => other.name === job.name)) continue;
    list.push(job);
    byAgent.set(job.agentId, list);
  }
  const kept: ProcJobsSnapshotJob[] = [];
  for (const agentId of [...byAgent.keys()].sort()) {
    const list = byAgent.get(agentId)!.sort(compareJobsForCap).slice(0, PROC_JOBS_SNAPSHOT_MAX_JOBS_PER_AGENT);
    for (const job of list) {
      if (kept.length >= PROC_JOBS_SNAPSHOT_MAX_JOBS_PER_MACHINE) return kept;
      kept.push(job);
    }
  }
  return kept;
}

/** `GET /api/servers/:id/machines/:machineId/proc-jobs`. `unknown`: no snapshot within 15 minutes (not "no jobs"). */
export type ProcJobsReadResponse =
  | { status: "known"; reportedAt: string; jobs: ProcJobsSnapshotJob[] }
  | { status: "unknown" };

/** `POST /api/servers/:id/machines/:machineId/proc-jobs/stop` body. */
export interface ProcJobStopRequestBody {
  agentId: string;
  name: string;
}

/** Its answer (200). */
export interface ProcJobStopResponse {
  outcome: ProcJobStopOutcome;
}
