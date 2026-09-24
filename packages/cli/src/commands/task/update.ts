// `raft task update --target <ch> --number <N> --status <s>`
// → POST /internal/agent-api/tasks/update-status

import type { Command } from "commander";
import { type AgentApiTaskUpdateStatusBody } from "@botiverse/raft-shared";

import { createAgentApiSurfaceClient } from "../../agentApiPath.js";
import { defineCommand, registerCliCommand } from "../../core/command.js";
import type { CommandRuntimeOptions } from "../../core/context.js";
import { CliError } from "../../core/errors.js";
import { writeText, NL } from "../../core/renderer.js";
import { requireTargetAlias, type TargetAliasOpts } from "../_target.js";
import { formatFreshnessHoldOutput, isFreshnessHeldResponse } from "../freshness/_format.js";
import {
  reviewerIsolationEnabled,
  reviewerIsolationOption,
  type ReviewerIsolationOpts,
} from "../reviewerIsolation.js";
import { formatTaskStatusUpdated } from "./_format.js";

const STATUSES = ["todo", "in_progress", "in_review", "done", "closed"] as const;
type Status = (typeof STATUSES)[number];

interface UpdateOpts extends TargetAliasOpts, ReviewerIsolationOpts {
  number?: string[];
  status: string;
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

function validateUpdateOpts(opts: Partial<UpdateOpts>): { channel: string; taskNumber: number; status: Status } {
  const channel = requireTargetAlias(opts);
  const numbers = Array.isArray(opts.number)
    ? opts.number
    : opts.number
      ? [opts.number]
      : [];
  if (numbers.length !== 1) {
    throw new CliError({
      code: "INVALID_ARG",
      message: numbers.length === 0
        ? "Provide exactly one --number"
        : `task update accepts exactly one --number; received ${numbers.length}. Run task update once per task.`,
    });
  }
  return {
    channel,
    taskNumber: parseTaskNumber(numbers[0]),
    status: parseStatus(opts.status),
  };
}

export const taskUpdateCommand = defineCommand(
  {
    name: "update",
    description: "Update task status",
    options: [
      { flags: "--target <target>", description: "Channel target: '#channel'" },
      { flags: "--channel <target>", description: "Legacy alias for --target (accepted during transition)" },
      {
        flags: "--number <n>",
        description: "Task number to update",
        parse: (value, prev: string[] = []) => prev.concat(value),
      },
      { flags: "--status <status>", description: `New status. One of: ${STATUSES.join(", ")}` },
      reviewerIsolationOption,
    ],
  },
  async (ctx, opts: Partial<UpdateOpts>) => {
    const { channel, taskNumber, status } = validateUpdateOpts(opts);
    const agentContext = ctx.loadAgentContext();
    const client = ctx.createApiClient(agentContext);
    const body: AgentApiTaskUpdateStatusBody = { channel, task_number: taskNumber, status };
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
    if (isFreshnessHeldResponse(res.data)) {
      writeText(ctx.io, formatFreshnessHoldOutput(channel, res.data, {
        heldAction: "Your task status update was not applied.",
        withholdContext: reviewerIsolation || res.data.freshnessContextMode === "withheld",
        draftInstructions: reviewerIsolation || res.data.freshnessContextMode === "withheld"
          ? "Retry remains held while reviewer isolation is active. Use a clean review target, or leave the seat and read only with explicit review authority.\n"
          : "After reviewing the newer context, rerun the task update command if it is still correct.\n",
      }));
      return;
    }
    writeText(ctx.io, formatTaskStatusUpdated(taskNumber, status), NL);
  },
);

export function registerTaskUpdateCommand(parent: Command, runtimeOptions?: CommandRuntimeOptions): void {
  registerCliCommand(parent, taskUpdateCommand, runtimeOptions);
}
