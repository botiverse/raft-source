import { addTraceEvent } from "../tracing/semanticTrace";
import { randomUUID } from "node:crypto";
import { asc, eq, sql } from "drizzle-orm";
import { ChannelConversionFenceConflictError } from "./channelConversionFenceService";
import { getDb } from "../db/index";
import { channelConversionCommands } from "../db/schema";
import { JointActorUnavailableError, lockJointUsersFirst } from "./jointHumanMembershipMirror";
import {
  ChannelConversionBusyError, ChannelConversionError, startChannelToJointConversion, retryChannelConversionJob,
  cancelChannelConversionJob, getChannelConversionJob,
  type ChannelConversionPrivacyRevalidator,
} from "./channelConversionService";

type CommandRow = typeof channelConversionCommands.$inferSelect;
export type ChannelConversionCommandId = string & { readonly __channelConversionCommandId: unique symbol };
export function conversionCommandId(value: unknown): ChannelConversionCommandId {
  if (value === undefined) return randomUUID() as ChannelConversionCommandId;
  if (typeof value !== "string" || !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(value)) {
    throw new ChannelConversionError("Invalid conversion command identity", "invalid_conversion_command_id");
  }
  return value as ChannelConversionCommandId;
}

/** This independent commit occurs before the source resource lock is requested. */
export async function admitConversionCommand(input: {
  id: ChannelConversionCommandId;
  serverId: string;
  sourceChannelId: string;
  requestedByUserId: string;
  kind: CommandRow["kind"];
  jobId?: string;
}): Promise<CommandRow> {
  const db = getDb();
  const inserted = await db.transaction(async (tx) => {
    // The requester's users row first (lockJointUsersFirst; only locked: the
    // start refuses a requester being deleted, executeConversionCommand), then
    // the row, whose FK checks take the server's row before the requester's:
    // taken only there, the users row closes a cycle with the requester's
    // account deletion (users row FOR UPDATE, then the servers they own).
    await lockJointUsersFirst(tx, { userIds: [input.requestedByUserId] });
    const [row] = await tx.insert(channelConversionCommands).values(input).onConflictDoNothing().returning();
    return row;
  });
  if (inserted) {
    addTraceEvent("server.channel_conversion.command.admitted", { command_id: inserted.id, channel_id: inserted.sourceChannelId, command_kind: inserted.kind, outcome: "pending" });
    return inserted;
  }
  const [sameId] = await db.select().from(channelConversionCommands).where(eq(channelConversionCommands.id, input.id));
  if (sameId) {
    if (sameId.serverId !== input.serverId || sameId.sourceChannelId !== input.sourceChannelId
      || sameId.requestedByUserId !== input.requestedByUserId || sameId.kind !== input.kind
      || (input.jobId !== undefined && sameId.jobId !== input.jobId)) {
      throw new ChannelConversionError("Conversion command identity is already in use", "conversion_command_conflict");
    }
    return sameId;
  }
  throw new ChannelConversionError("Another conversion command is pending. Check its current status.", "conversion_command_pending");
}

/** Command execution and its receipt settle in one transaction. A crashed
 * executor rolls back; another worker can resume the already-published row. */
export async function executeConversionCommand(id: string, wait = true,
  tracePreJobPhase?: Parameters<typeof startChannelToJointConversion>[0]["tracePreJobPhase"],
  revalidateExternalPrivacy?: ChannelConversionPrivacyRevalidator,
): Promise<CommandRow | null> {
  const db = getDb();
  return db.transaction(async (tx) => {
    // A start writes the conversion job naming its requester (created_by_user_id):
    // the requester's users row first (lockJointUsersFirst), before the command
    // lock, the conversion lock and the source's server and channel rows (an
    // FK check taking it only at the job insert closes a cycle with the
    // requester's account deletion, which holds that row FOR UPDATE and then
    // the servers they own). The command is read unlocked for its requester (a
    // command's requester and kind never change) and read again under the
    // command lock below. A requester retired or being deleted: the start is
    // refused below, settling the command as failed.
    const [admitted] = await tx.select({ kind: channelConversionCommands.kind, status: channelConversionCommands.status,
      requestedByUserId: channelConversionCommands.requestedByUserId })
      .from(channelConversionCommands).where(eq(channelConversionCommands.id, id)).limit(1);
    const requesterUnavailable = admitted?.kind === "start" && admitted.status === "pending"
      && await lockJointUsersFirst(tx, { actorUserId: admitted.requestedByUserId }).then(() => false, (error: unknown) => {
        if (error instanceof JointActorUnavailableError) return true;
        throw error;
      });
    if (wait) await tx.execute(sql`SELECT pg_advisory_xact_lock(hashtext(${id}), 137)`);
    else {
      const lock = await tx.execute(sql`SELECT pg_try_advisory_xact_lock(hashtext(${id}), 137) AS acquired`);
      if ((lock.rows[0] as { acquired: boolean } | undefined)?.acquired !== true) return null;
    }
    const [command] = await tx.select().from(channelConversionCommands).where(eq(channelConversionCommands.id, id)).limit(1);
    if (!command || command.status !== "pending") return command ?? null;
    try {
      const job = await tx.transaction(async (operation) => {
        if (command.kind === "start") {
          if (requesterUnavailable) throw new ChannelConversionError("This account is being deleted", "requester_unavailable");
          const started = await startChannelToJointConversion({ serverId: command.serverId, sourceChannelId: command.sourceChannelId,
            createdByUserId: command.requestedByUserId, transaction: operation, tracePreJobPhase,
            revalidateExternalPrivacy });
          return started.status === "failed" ? await retryChannelConversionJob(started.id, operation) : started;
        }
        if (!command.jobId) throw new ChannelConversionError("Conversion job not found", "job_not_found");
        return command.kind === "retry" ? await retryChannelConversionJob(command.jobId, operation) : await cancelChannelConversionJob(command.jobId, operation);
      });
      const [completed] = await tx.update(channelConversionCommands).set({ status: "completed", jobId: job.id, updatedAt: new Date() })
        .where(eq(channelConversionCommands.id, id)).returning();
      addTraceEvent("server.channel_conversion.command.completed", { command_id: id, job_id: job.id, command_kind: command.kind, outcome: job.status });
      return completed;
    } catch (error) {
      // The worker's resume of a pending command found a phase holding the
      // conversion lock (its bounded wait ran out; the savepoint rolled back):
      // leave the command pending for the next pass. A request (wait) settles
      // it as failed with the 409 "in progress", which its caller answers.
      if (!wait && error instanceof ChannelConversionBusyError) {
        addTraceEvent("server.channel_conversion.command.busy", { command_id: id, command_kind: command.kind, outcome: "pending" });
        return command;
      }
      addTraceEvent("server.channel_conversion.command.failed", { command_id: id, command_kind: command.kind, outcome: "failed", error_class: error instanceof Error ? error.name : "UnknownError" });
      console.error("[ChannelConversionCommand] execution failed", { id, kind: command.kind, error });
      const [failed] = await tx.update(channelConversionCommands).set({ status: "failed", updatedAt: new Date(),
        error: error instanceof ChannelConversionError || error instanceof ChannelConversionFenceConflictError ? error.message : "Could not complete the conversion command. Check its current status before trying again.",
        errorCode: error instanceof ChannelConversionError || error instanceof ChannelConversionFenceConflictError ? error.code : "conversion_command_failed",
      }).where(eq(channelConversionCommands.id, id)).returning();
      return failed;
    }
  });
}

export async function runConversionCommand(input: Parameters<typeof admitConversionCommand>[0],
  tracePreJobPhase?: Parameters<typeof startChannelToJointConversion>[0]["tracePreJobPhase"],
) {
  const admission = await admitConversionCommand(input);
  const result = await executeConversionCommand(admission.id, true, tracePreJobPhase);
  if (!result || result.status !== "completed" || !result.jobId) {
    throw new ChannelConversionError(result?.error ?? "Conversion command is still pending", result?.errorCode ?? "conversion_command_pending");
  }
  const job = await getChannelConversionJob(result.jobId);
  if (!job) throw new ChannelConversionError("Conversion job not found", "job_not_found");
  return job;
}

export async function runConversionCommandWorkerPass(
  onSettled?: (sourceChannelId: string) => Promise<void>,
  revalidateExternalPrivacy?: ChannelConversionPrivacyRevalidator,
) {
  const rows = await getDb().select({ id: channelConversionCommands.id }).from(channelConversionCommands)
    .where(eq(channelConversionCommands.status, "pending")).orderBy(asc(channelConversionCommands.createdAt)).limit(8);
  for (const row of rows) {
    const command = await executeConversionCommand(row.id, false, undefined, revalidateExternalPrivacy);
    if (command && command.status !== "pending") await onSettled?.(command.sourceChannelId);
  }
  return rows.length;
}
