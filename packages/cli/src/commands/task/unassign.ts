// `raft task unassign "#ch:#N"` (or `--target <ch> --number <N>`) [--expected-revision <n>]
// → POST /internal/agent-api/tasks/assign with a null assignee
//
// The inverse of `assign` is a verb, not a flag on `assign`. Every other
// inverse in this CLI is its own command — join/leave, mute/unmute,
// archive/unarchive, claim/unclaim — and `assign --unassign` was the odd one
// out (@stdrc, #proj-task msg=6e27b5af).
//
// One wire route serves both directions: the contract already models "who owns
// this" as a nullable assignee, and splitting it would add a route, a policy
// entry and a schema pair to express a null. The CLI is the agent-facing
// surface; the route is not.

import type { Command } from "commander";
import type { AgentApiTaskAssignBody } from "@botiverse/raft-shared";

import { createAgentApiSurfaceClient } from "../../agentApiPath";
import { defineCommand, registerCliCommand } from "../../core/command";
import type { CommandRuntimeOptions } from "../../core/context";
import { rateLimitedResponseError } from "../../core/apiFailure";
import { CliError } from "../../core/errors";
import { writeText, NL } from "../../core/renderer";
import { PEER_KIND_OPTION, type TargetAliasOpts } from "../_target";
import { formatTaskAssigned } from "./_format";
import { resolveTaskWriteAddress, TASK_REF_ARGUMENT } from "./_taskAddress";
import { writeHeldTaskWrite } from "../freshness/_taskHold";

interface UnassignOpts extends TargetAliasOpts {
  number: string;
  expectedRevision?: string;
}

function validateUnassignOpts(refArg: string | undefined, opts: Partial<UnassignOpts>): {
  channel: string;
  taskNumber: number;
  expectedRevision?: number;
} {
  const { channel, taskNumber } = resolveTaskWriteAddress(refArg, opts);

  let expectedRevision: number | undefined;
  if (opts.expectedRevision !== undefined) {
    const n = Number(opts.expectedRevision);
    if (!Number.isFinite(n) || !Number.isInteger(n) || n < 0) {
      throw new CliError({
        code: "INVALID_ARG",
        message: `--expected-revision must be a non-negative integer; got ${opts.expectedRevision}`,
      });
    }
    expectedRevision = n;
  }

  return { channel, taskNumber, expectedRevision };
}

export const taskUnassignCommand = defineCommand(
  {
    name: "unassign",
    description: "Clear a task's assignee, leaving it open for anyone",
    arguments: [TASK_REF_ARGUMENT],
    usage: '"#channel:#7" [--expected-revision <n>]  (or --target "#channel" --number 7)',
    options: [
      { flags: "--target <target>", description: "The task's board: '#channel' or 'dm:@peer' (with --number), instead of a ref" },
      { flags: "--channel <target>", description: "Legacy alias for --target (accepted during transition)" },
      PEER_KIND_OPTION,
      { flags: "--number <n>", description: "Task number to clear (with --target)" },
      {
        flags: "--expected-revision <n>",
        description: "Only apply if the task is still at this revision (lose instead of clobbering)",
      },
    ],
  },
  async (ctx, refArg: string | undefined, opts: Partial<UnassignOpts> = {}) => {
    const { channel, taskNumber, expectedRevision } = validateUnassignOpts(refArg, opts);
    const agentContext = ctx.loadAgentContext();
    const client = ctx.createApiClient(agentContext);
    const body: AgentApiTaskAssignBody = {
      channel,
      task_number: taskNumber,
      assignee: null,
      ...(expectedRevision !== undefined ? { expected_revision: expectedRevision } : {}),
    };
    const agentApi = createAgentApiSurfaceClient(client);
    const res = await agentApi.tasks.assign(body);
    if (!res.ok) {
      const rateLimited = rateLimitedResponseError(res);
      if (rateLimited) throw rateLimited;
      throw new CliError({
        code: res.status >= 500 ? "SERVER_5XX" : "ASSIGN_FAILED",
        message: res.error ?? `HTTP ${res.status}`,
        // The refusal's step (its `next`, in the CLI form): the error names no command.
        suggestedNextAction: res.suggestedNextAction ?? undefined,
      });
    }
    if (!res.data) {
      throw new CliError({
        code: "INVALID_JSON_RESPONSE",
        message: "Agent API taskAssign returned an empty response body",
      });
    }
    if (writeHeldTaskWrite(ctx, agentContext.agentId, "task_assign", body, res.data)) return;
    writeText(ctx.io, formatTaskAssigned(taskNumber, null, res.data.taskRef), NL);
  },
);

export function registerTaskUnassignCommand(parent: Command, runtimeOptions?: CommandRuntimeOptions): void {
  registerCliCommand(parent, taskUnassignCommand, runtimeOptions);
}
