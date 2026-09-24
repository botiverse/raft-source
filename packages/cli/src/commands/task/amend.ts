// `raft task amend --target <ch> --number <N> [--title <title>]
//                  [--description <text> | --clear-description]`
// → Agent API taskAmend contract route

import type { Command } from "commander";
import type { AgentApiTaskAmendBody } from "@botiverse/raft-shared";

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
import { formatTaskAmended } from "./_format.js";

interface AmendOpts extends TargetAliasOpts, ReviewerIsolationOpts {
  number: string;
  title?: string;
  description?: string;
  clearDescription?: boolean;
}

function parseTaskNumber(raw: string | undefined): number {
  const number = Number(raw);
  if (!Number.isInteger(number) || number <= 0) {
    throw new CliError({ code: "INVALID_ARG", message: `--number must be a positive integer; got ${raw}` });
  }
  return number;
}

function buildAmendBody(opts: Partial<AmendOpts>): AgentApiTaskAmendBody {
  const channel = requireTargetAlias(opts);
  const taskNumber = parseTaskNumber(opts.number);
  if (opts.description !== undefined && opts.clearDescription) {
    throw new CliError({ code: "INVALID_ARG", message: "Use either --description or --clear-description, not both" });
  }
  if (opts.title === undefined && opts.description === undefined && !opts.clearDescription) {
    throw new CliError({
      code: "INVALID_ARG",
      message: "At least one amendment is required: --title, --description, or --clear-description",
    });
  }
  return {
    channel,
    task_number: taskNumber,
    ...(opts.title !== undefined ? { title: opts.title } : {}),
    ...(opts.clearDescription ? { description: null } : opts.description !== undefined ? { description: opts.description } : {}),
  };
}

export const taskAmendCommand = defineCommand(
  {
    name: "amend",
    description: "Amend task card fields with append-only audit history",
    options: [
      { flags: "--target <target>", description: "Channel target: '#channel'" },
      { flags: "--channel <target>", description: "Legacy alias for --target (accepted during transition)" },
      { flags: "--number <n>", description: "Task number to amend" },
      { flags: "--title <title>", description: "New current task title" },
      { flags: "--description <text>", description: "New current task details / acceptance criteria" },
      { flags: "--clear-description", description: "Clear current task details" },
      reviewerIsolationOption,
    ],
  },
  async (ctx, opts: Partial<AmendOpts>) => {
    const body = buildAmendBody(opts);
    const reviewerIsolation = reviewerIsolationEnabled(opts, ctx.env);
    if (reviewerIsolation) body.freshnessContextMode = "withheld";
    const agentContext = ctx.loadAgentContext();
    const client = ctx.createApiClient(agentContext);
    const agentApi = createAgentApiSurfaceClient(client);
    let res;
    try {
      res = await agentApi.tasks.amend(body);
    } catch (err) {
      if (reviewerIsolation) {
        throw new CliError({
          code: "AMEND_FAILED",
          message: "Reviewer-isolation task amendment failed; upstream response detail was withheld.",
          cause: err,
        });
      }
      throw err;
    }
    if (!res.ok) {
      throw new CliError({
        code: res.status >= 500 ? "SERVER_5XX" : "AMEND_FAILED",
        message: reviewerIsolation
          ? `Reviewer-isolation task amendment failed (HTTP ${res.status}); upstream error detail was withheld.`
          : res.error ?? `HTTP ${res.status}`,
      });
    }
    if (!res.data) {
      throw new CliError({ code: "INVALID_JSON_RESPONSE", message: "Agent API taskAmend returned an empty response body" });
    }
    if (isFreshnessHeldResponse(res.data)) {
      writeText(ctx.io, formatFreshnessHoldOutput(body.channel, res.data, {
        heldAction: "Your task amendment was not applied.",
        withholdContext: reviewerIsolation || res.data.freshnessContextMode === "withheld",
        draftInstructions: reviewerIsolation || res.data.freshnessContextMode === "withheld"
          ? "Retry remains held while reviewer isolation is active. Use a clean review target, or leave the seat and read only with explicit review authority.\n"
          : "After reviewing the newer context, rerun the task amend command if it is still correct.\n",
      }));
      return;
    }
    writeText(ctx.io, formatTaskAmended(res.data), NL);
  },
);

export function registerTaskAmendCommand(parent: Command, runtimeOptions?: CommandRuntimeOptions): void {
  registerCliCommand(parent, taskAmendCommand, runtimeOptions);
}
