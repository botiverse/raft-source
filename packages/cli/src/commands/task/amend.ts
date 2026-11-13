// `raft task amend "#ch:#N"` (or `--target <ch> --number <N>`) [--title <title>]
//                  [--description <text> | --clear-description]`
// → Agent API taskAmend contract route

import type { Command } from "commander";
import type { AgentApiTaskAmendBody } from "@botiverse/raft-shared";

import { createAgentApiSurfaceClient } from "../../agentApiPath";
import { defineCommand, registerCliCommand } from "../../core/command";
import type { CommandRuntimeOptions } from "../../core/context";
import { rateLimitedResponseError } from "../../core/apiFailure";
import { CliError } from "../../core/errors";
import { writeText, NL } from "../../core/renderer";
import { PEER_KIND_OPTION, type TargetAliasOpts } from "../_target";
import { resolveTaskWriteAddress, TASK_REF_ARGUMENT } from "./_taskAddress";
import {
  reviewerIsolationEnabled,
  reviewerIsolationOption,
  type ReviewerIsolationOpts,
} from "../reviewerIsolation";
import { formatTaskAmended } from "./_format";
import { writeAttachedUnseen, writeHeldTaskWrite } from "../freshness/_taskHold";

interface AmendOpts extends TargetAliasOpts, ReviewerIsolationOpts {
  number: string;
  title?: string;
  description?: string;
  clearDescription?: boolean;
}

function buildAmendBody(refArg: string | undefined, opts: Partial<AmendOpts>): AgentApiTaskAmendBody {
  const { channel, taskNumber } = resolveTaskWriteAddress(refArg, opts);
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
    arguments: [TASK_REF_ARGUMENT],
    usage: '"#channel:#7" [--title <title>] [--description <text> | --clear-description]  (or --target "#channel" --number 7)',
    options: [
      { flags: "--target <target>", description: "The task's board: '#channel' or 'dm:@peer' (with --number), instead of a ref" },
      { flags: "--channel <target>", description: "Legacy alias for --target (accepted during transition)" },
      PEER_KIND_OPTION,
      { flags: "--number <n>", description: "Task number to amend (with --target)" },
      { flags: "--title <title>", description: "New current task title" },
      { flags: "--description <text>", description: "New current task details / acceptance criteria" },
      { flags: "--clear-description", description: "Clear current task details" },
      reviewerIsolationOption,
    ],
  },
  async (ctx, refArg: string | undefined, opts: Partial<AmendOpts> = {}) => {
    const body = buildAmendBody(refArg, opts);
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
      const rateLimited = rateLimitedResponseError(res);
      if (rateLimited) throw rateLimited;
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
    if (writeHeldTaskWrite(ctx, agentContext.agentId, "task_amend", body, res.data, { reviewerIsolation })) return;
    writeText(ctx.io, formatTaskAmended(res.data), NL);
    writeAttachedUnseen(ctx, agentContext.agentId, res.data);
  },
);

export function registerTaskAmendCommand(parent: Command, runtimeOptions?: CommandRuntimeOptions): void {
  registerCliCommand(parent, taskAmendCommand, runtimeOptions);
}
