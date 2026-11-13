import { currentDate, type TraceAttributes } from "@botiverse/raft-shared";
import { eq } from "drizzle-orm";
import type { DatabaseExecutor } from "../db/index";
import { channelConversionJobs, channels } from "../db/schema";
import { CONVERSION_RESOURCE_DESCRIPTORS, parseConversionProgress, type ConversionProgress, type ConversionResources } from "./channelConversionContracts";
import { recordConversionPhaseCommit } from "./channelConversionFenceService";
export type ChannelConversionPhase =
  | "prepare"
  | "prepare_tasks"
  | "move_parent_messages"
  | "prepare_threads"
  | "move_thread_messages"
  | "verify"
  | "audience_cutover"
  | "residual_cleanup"
  | "finalize"
  | "done";

export type ChannelConversionJob = typeof channelConversionJobs.$inferSelect;
export class ChannelConversionError extends Error {
  constructor(message: string, public readonly code: string) {
    super(message);
  }
}

/**
 * The conversion lock was still held when a request's bounded wait ran out
 * (lockChannelConversionResourceBoundedInTransaction): a phase is running.
 * The same 409 `channel_conversion_in_progress` writers get under the fence;
 * nothing was changed, so the request can simply be sent again.
 */
export class ChannelConversionBusyError extends ChannelConversionError {
  constructor(options?: { cause?: unknown }) {
    super("A conversion step is running on this channel right now. Try again in a moment.", "channel_conversion_in_progress");
    this.name = "ChannelConversionBusyError";
    if (options && "cause" in options) (this as { cause?: unknown }).cause = options.cause;
  }
}


export type ConversionPhaseContext = {
  tx: DatabaseExecutor;
  job: ChannelConversionJob;
  progress: ConversionProgress;
  span?: { addEvent(name: string, attrs?: TraceAttributes): void };
};
type ChannelConversionTraceOutcome = "ok" | "failed" | "timeout";
export async function advance(
  tx: DatabaseExecutor,
  jobId: string,
  phase: ChannelConversionPhase,
  updates: Partial<Pick<ChannelConversionJob, "canonicalChannelId" | "jointChannelId">> & { progress?: ConversionProgress } = {},
) {
  const [job] = await tx
    .select({
      conversionEpoch: channelConversionJobs.conversionEpoch,
      currentPhase: channelConversionJobs.phase,
      progress: channelConversionJobs.progress,
      canonicalChannelId: channelConversionJobs.canonicalChannelId,
      jointChannelId: channelConversionJobs.jointChannelId,
    })
    .from(channelConversionJobs)
    .where(eq(channelConversionJobs.id, jobId))
    .limit(1);
  if (!job) throw new Error("conversion job missing while advancing phase");
  const progress = parseConversionProgress(updates.progress ?? job.progress);
  const ledgerProgress = stableProgressForLedger(job.currentPhase, progress);
  const phaseOutput = {
    ...(job.currentPhase === "prepare" ? {
      canonicalChannelId: updates.canonicalChannelId ?? job.canonicalChannelId ?? null,
      jointChannelId: updates.jointChannelId ?? job.jointChannelId ?? null,
    } : {}),
    progress: ledgerProgress,
  };
  const targetCount = (ledgerProgress.resources?.parent?.messages?.moved ?? ledgerProgress.movedParentMessages ?? 0) + (ledgerProgress.resources?.thread?.messages?.moved ?? ledgerProgress.movedThreadMessages ?? 0);
  const sourceCount = targetCount + (ledgerProgress.taskRowsAffected ?? 0) + (ledgerProgress.threadTaskRowsAffected ?? 0);
  await recordConversionPhaseCommit(tx, {
    jobId,
    conversionEpoch: job.conversionEpoch,
    phase: job.currentPhase,
    sourceCount,
    targetCount,
    checksumInput: stableStringify({ phase: job.currentPhase, output: phaseOutput }),
  });
  await tx
    .update(channelConversionJobs)
    .set({
      ...updates,
      progress,
      state: stateForLegacyPhase(phase),
      phase,
      status: phase === "done" ? "done" : "running",
      updatedAt: currentDate(),
    })
    .where(eq(channelConversionJobs.id, jobId));
}

export function stateForLegacyPhase(phase: ChannelConversionPhase): ChannelConversionJob["state"] {
  if (phase === "prepare") return "fenced";
  if (phase === "prepare_threads") return "copying";
  if (phase === "move_thread_messages") return "projections_rebuilt";
  if (phase === "verify") return "verifying";
  if (phase === "audience_cutover") return "audience_cutover";
  if (phase === "residual_cleanup") return "residual_cleanup";
  if (phase === "finalize") return "verifying";
  if (phase === "done") return "succeeded";
  return "copying";
}

export function stableStringify(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(",")}]`;
  if (value && typeof value === "object") {
    return `{${Object.entries(value as Record<string, unknown>).filter(([, child]) => child !== undefined)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, child]) => `${JSON.stringify(key)}:${stableStringify(child)}`)
      .join(",")}}`;
  }
  return JSON.stringify(value);
}


type LedgerResourceKey = `moved${"Parent" | "Thread"}${typeof CONVERSION_RESOURCE_DESCRIPTORS[number]["label"]}`;
type LedgerProgress = Partial<Pick<ConversionProgress, "sourceArchiveSnapshot" | "taskInventory" | "persistedPrepareOutput" | "taskRowsAffected" | "threadTaskRowsAffected" | "preparedThreads" | "threadProjectionMap" | "audienceCutover" | "audienceCutoverLedger" | "residualCleanupLedger">> & Partial<Record<LedgerResourceKey, number>> & { resources?: ConversionResources };

/** Legacy phase-ledger encoding is kept here for same-epoch retries. Internal
 * batches use only typed resources; one registry projects their old receipt. */
export function stableProgressForLedger(phase: ChannelConversionPhase, progress: ConversionProgress): LedgerProgress {
  const output: LedgerProgress = { sourceArchiveSnapshot: progress.sourceArchiveSnapshot, taskInventory: progress.taskInventory };
  if (phase === "prepare") output.persistedPrepareOutput = progress.persistedPrepareOutput;
  const taskPhases: ChannelConversionPhase[] = ["prepare_tasks", "move_parent_messages", "prepare_threads", "move_thread_messages", "verify", "audience_cutover"];
  if (taskPhases.includes(phase)) {
    output.taskRowsAffected = progress.taskRowsAffected;
    output.threadTaskRowsAffected = progress.threadTaskRowsAffected;
  }
  const parentPhases: ChannelConversionPhase[] = ["move_parent_messages", "prepare_threads", "move_thread_messages", "verify", "audience_cutover"];
  const threadPhases: ChannelConversionPhase[] = ["move_thread_messages", "verify", "audience_cutover"];
  if (progress.ledgerVersion === 2) output.resources = {};
  for (const scope of ["parent", "thread"] as const) {
    if (!(scope === "parent" ? parentPhases : threadPhases).includes(phase)) continue;
    for (const descriptor of CONVERSION_RESOURCE_DESCRIPTORS) {
      const resource = progress.resources[scope]?.[descriptor.family];
      // Old ledgers did not include Tasks counters; preserve that wire checksum.
      if (resource && output.resources) (output.resources[scope] ??= {})[descriptor.family] = resource;
      if (resource && !output.resources && descriptor.legacyLedger) output[`moved${scope === "parent" ? "Parent" : "Thread"}${descriptor.label}`] = resource.moved;
    }
  }
  if (["prepare_threads", ...threadPhases].includes(phase)) {
    output.preparedThreads = progress.preparedThreads;
    output.threadProjectionMap = progress.threadProjectionMap;
  }
  if (["audience_cutover", "residual_cleanup"].includes(phase)) {
    output.audienceCutover = progress.audienceCutover;
    output.audienceCutoverLedger = progress.audienceCutoverLedger;
  }
  if (phase === "residual_cleanup") output.residualCleanupLedger = progress.residualCleanupLedger;
  return output;
}
export async function requireCanonicalChannelId(tx: DatabaseExecutor, job: ChannelConversionJob): Promise<string> {
  if (job.canonicalChannelId) return job.canonicalChannelId;
  const [fresh] = await tx
    .select({ canonicalChannelId: channelConversionJobs.canonicalChannelId })
    .from(channelConversionJobs)
    .where(eq(channelConversionJobs.id, job.id))
    .limit(1);
  if (!fresh?.canonicalChannelId) throw new Error("conversion canonical channel missing");
  return fresh.canonicalChannelId;
}

export async function requireStorageNamespaceId(tx: DatabaseExecutor, canonicalChannelId: string): Promise<string> {
  const [canonical] = await tx
    .select({ serverId: channels.serverId })
    .from(channels)
    .where(eq(channels.id, canonicalChannelId))
    .limit(1);
  if (!canonical) throw new Error("canonical channel missing");
  return canonical.serverId;
}

export async function persistResourceBatchProgress(tx: DatabaseExecutor, job: ChannelConversionJob, progress: ConversionProgress) {
  await tx.update(channelConversionJobs).set({
    progress, updatedAt: currentDate(),
  }).where(eq(channelConversionJobs.id, job.id));
}

export function conversionTraceAttrs(
  job: Pick<ChannelConversionJob, "id" | "sourceChannelId" | "phase">,
  opts: {
    outcome: ChannelConversionTraceOutcome;
    errorClass?: string;
    rowsCopied?: number;
    batchIndex?: number;

    taskRowsAffected?: number;
    threadTaskRowsAffected?: number;

  },
): TraceAttributes {
  return {
    event_kind: "channel_conversion",
    job_id: job.id,
    channel_id: job.sourceChannelId,
    phase: job.phase,
    outcome: opts.outcome,
    ...(opts.errorClass ? { error_class: opts.errorClass } : {}),
    ...(typeof opts.rowsCopied === "number" ? { rows_copied: opts.rowsCopied } : {}),
    ...(typeof opts.batchIndex === "number" ? { batch_index: opts.batchIndex } : {}),

    ...(typeof opts.taskRowsAffected === "number" ? { task_rows_affected: opts.taskRowsAffected } : {}),
    ...(typeof opts.threadTaskRowsAffected === "number" ? { thread_task_rows_affected: opts.threadTaskRowsAffected } : {}),

  };
}
