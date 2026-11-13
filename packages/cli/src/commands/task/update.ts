// `raft task update "#ch:#N" --status <s> [--reason <text>]`
// (or `--target <ch> --number <N>`)
// → POST /internal/agent-api/tasks/update-status

import type { Command } from "commander";
import type { AgentApiTaskUpdateStatusBody } from "@botiverse/raft-shared";
import { checkTaskStatusReason } from "@botiverse/raft-shared/src/agentCliSurface";

import { createAgentApiSurfaceClient } from "../../agentApiPath";
import { defineCommand, registerCliCommand } from "../../core/command";
import type { CommandRuntimeOptions } from "../../core/context";
import { rateLimitedResponseError } from "../../core/apiFailure";
import { CliError } from "../../core/errors";
import { writeText, NL } from "../../core/renderer";
import { PEER_KIND_OPTION, requireTargetAlias, type TargetAliasOpts } from "../_target";
import {
  reviewerIsolationEnabled,
  reviewerIsolationOption,
  type ReviewerIsolationOpts,
} from "../reviewerIsolation";
import { formatTaskStatusUpdated } from "./_format";
import { NO_TASK_NAMED_MESSAGE, resolveTaskAddress, TASK_REF_ARGUMENT } from "./_taskAddress";
import { writeAttachedUnseen, writeHeldTaskWrite } from "../freshness/_taskHold";

const STATUSES = ["backlog", "todo", "in_progress", "in_review", "done", "closed"] as const;
type Status = (typeof STATUSES)[number];

interface UpdateOpts extends TargetAliasOpts, ReviewerIsolationOpts {
  number?: string[];
  status: string;
  reason?: string;
}

function parseTaskNumber(raw: string): number {
  const n = Number(raw);
  if (!Number.isFinite(n) || !Number.isInteger(n) || n <= 0) {
    throw new CliError({
      code: "INVALID_ARG",
      message: `--number must be a positive integer; got ${raw}`,
    });
  }
  return n;
}

function parseStatus(raw: string | undefined): Status {
  if (!raw || !(STATUSES as readonly string[]).includes(raw)) {
    throw new CliError({
      code: "INVALID_ARG",
      message: `--status must be one of: ${STATUSES.join(", ")}; got ${raw}`,
    });
  }
  return raw as Status;
}

function validateUpdateOpts(refArg: string | undefined, opts: Partial<UpdateOpts>): { channel: string; taskNumber: number; status: Status; reason?: string } {
  const numbers = Array.isArray(opts.number)
    ? opts.number
    : opts.number
      ? [opts.number]
      : [];
  if (refArg?.trim()) {
    if (numbers.length > 1) {
      throw new CliError({
        code: "INVALID_ARG",
        message: `task update accepts exactly one task; received a ref and ${numbers.length} --number. Run task update once per task.`,
      });
    }
    const address = resolveTaskAddress(refArg, { ...opts, number: numbers[0] });
    const status = parseStatus(opts.status);
    return { channel: address.channel, taskNumber: address.taskNumber, status, ...checkedReason(status, opts.reason) };
  }
  if (!opts.target?.trim() && !opts.channel?.trim() && numbers.length === 0) {
    throw new CliError({ code: "INVALID_ARG", message: NO_TASK_NAMED_MESSAGE });
  }
  const channel = requireTargetAlias(opts);
  if (numbers.length !== 1) {
    throw new CliError({
      code: "INVALID_ARG",
      message: numbers.length === 0
        ? "Provide exactly one --number"
        : `task update accepts exactly one --number; received ${numbers.length}. Run task update once per task.`,
    });
  }
  const status = parseStatus(opts.status);
  const reason = checkedReason(status, opts.reason);
  return {
    channel,
    taskNumber: parseTaskNumber(numbers[0]),
    status,
    ...reason,
  };
}

function checkedReason(status: Status, raw: string | undefined): { reason?: string } {
  const { reason, refusal } = checkTaskStatusReason(status, raw);
  if (refusal) {
    throw new CliError({
      code: "INVALID_ARG",
      message: `--reason: ${refusal.message}`,
    });
  }
  return reason ? { reason } : {};
}

export const taskUpdateCommand = defineCommand(
  {
    name: "update",
    description: "Update task status",
    arguments: [TASK_REF_ARGUMENT],
    usage: '"#channel:#7" --status <status> [--reason <text>]  (or --target "#channel" --number 7)',
    options: [
      { flags: "--target <target>", description: "The task's board: '#channel' or 'dm:@peer' (with --number), instead of a ref" },
      { flags: "--channel <target>", description: "Legacy alias for --target (accepted during transition)" },
      PEER_KIND_OPTION,
      {
        flags: "--number <n>",
        description: "Task number to update",
        parse: (value, prev: string[] = []) => prev.concat(value),
      },
      { flags: "--status <status>", description: `New status. One of: ${STATUSES.join(", ")}` },
      { flags: "--reason <text>", description: "With --status backlog (not now; needs task conversations): what would bring the task back. Optional; it goes on the task's history and the line in its conversation. Any other status refuses it" },
      reviewerIsolationOption,
    ],
  },
  async (ctx, refArg: string | undefined, opts: Partial<UpdateOpts> = {}) => {
    const { channel, taskNumber, status, reason } = validateUpdateOpts(refArg, opts);
    const agentContext = ctx.loadAgentContext();
    const client = ctx.createApiClient(agentContext);
    const body: AgentApiTaskUpdateStatusBody = { channel, task_number: taskNumber, status, ...(reason ? { reason } : {}) };
    const reviewerIsolation = reviewerIsolationEnabled(opts, ctx.env);
    if (reviewerIsolation) body.freshnessContextMode = "withheld";
    const agentApi = createAgentApiSurfaceClient(client);
    let res;
    try {
      res = await agentApi.tasks.updateStatus(body);
    } catch (err) {
      if (reviewerIsolation) {
        throw new CliError({
          code: "UPDATE_FAILED",
          message: "Reviewer-isolation task update failed; upstream response detail was withheld.",
          cause: err,
        });
      }
      throw err;
    }
    if (!res.ok) {
      const rateLimited = rateLimitedResponseError(res);
      if (rateLimited) throw rateLimited;
      throw new CliError({
        code: res.status >= 500 ? "SERVER_5XX" : "UPDATE_FAILED",
        message: reviewerIsolation
          ? `Reviewer-isolation task update failed (HTTP ${res.status}); upstream error detail was withheld.`
          : res.error ?? `HTTP ${res.status}`,
      });
    }
    if (!res.data) {
      throw new CliError({
        code: "INVALID_JSON_RESPONSE",
        message: "Agent API taskUpdateStatus returned an empty response body",
      });
    }
    if (writeHeldTaskWrite(ctx, agentContext.agentId, "task_update", body, res.data, { reviewerIsolation })) return;
    // What the server stored (older servers omit it: the request). A task v2
    // task asked for in_review stores in_progress.
    writeText(ctx.io, formatTaskStatusUpdated(taskNumber, res.data.status ?? status, res.data.taskRef, status), NL);
    writeAttachedUnseen(ctx, agentContext.agentId, res.data);
  },
);

export function registerTaskUpdateCommand(parent: Command, runtimeOptions?: CommandRuntimeOptions): void {
  registerCliCommand(parent, taskUpdateCommand, runtimeOptions);
}
