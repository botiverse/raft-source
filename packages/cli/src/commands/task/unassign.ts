// `raft task unassign --target <ch> --number <N> [--expected-revision <n>]`
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
import { type AgentApiTaskAssignBody } from "@botiverse/raft-shared";

import { createAgentApiSurfaceClient } from "../../agentApiPath.js";
import { defineCommand, registerCliCommand } from "../../core/command.js";
import type { CommandRuntimeOptions } from "../../core/context.js";
import { CliError } from "../../core/errors.js";
import { writeText, NL } from "../../core/renderer.js";
import { requireTargetAlias, type TargetAliasOpts } from "../_target.js";
import { formatTaskAssigned } from "./_format.js";

interface UnassignOpts extends TargetAliasOpts {
  number: string;
  expectedRevision?: string;
}

function parseTaskNumber(raw: string | undefined): number {
  const n = Number(raw);
  if (!Number.isFinite(n) || !Number.isInteger(n) || n <= 0) {
    throw new CliError({
      code: "INVALID_ARG",
      message: `--number must be a positive integer; got ${raw}`,
    });
  }
  return n;
}

function validateUnassignOpts(opts: Partial<UnassignOpts>): {
  channel: string;
  taskNumber: number;
  expectedRevision?: number;
} {
  const channel = requireTargetAlias(opts);
  const taskNumber = parseTaskNumber(opts.number);

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
    options: [
      { flags: "--target <target>", description: "Channel target: '#channel'" },
      { flags: "--channel <target>", description: "Legacy alias for --target (accepted during transition)" },
      { flags: "--number <n>", description: "Task number to clear" },
      {
        flags: "--expected-revision <n>",
        description: "Only apply if the task is still at this revision (lose instead of clobbering)",
      },
    ],
  },
  async (ctx, opts: Partial<UnassignOpts>) => {
    const { channel, taskNumber, expectedRevision } = validateUnassignOpts(opts);
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
      throw new CliError({
        code: res.status >= 500 ? "SERVER_5XX" : "ASSIGN_FAILED",
        message: res.error ?? `HTTP ${res.status}`,
      });
    }
    if (!res.data) {
      throw new CliError({
        code: "INVALID_JSON_RESPONSE",
        message: "Agent API taskAssign returned an empty response body",
      });
    }
    writeText(ctx.io, formatTaskAssigned(taskNumber, null), NL);
  },
);

export function registerTaskUnassignCommand(parent: Command, runtimeOptions?: CommandRuntimeOptions): void {
  registerCliCommand(parent, taskUnassignCommand, runtimeOptions);
}
