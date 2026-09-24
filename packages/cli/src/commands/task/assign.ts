// `raft task assign --target <ch> --number <N> --assignee @who`
// → POST /internal/agent-api/tasks/assign
//
// Clearing is `raft task unassign`, a verb of its own — see unassign.ts.

import type { Command } from "commander";
import { type AgentApiTaskAssignBody } from "@botiverse/raft-shared";

import { createAgentApiSurfaceClient } from "../../agentApiPath.js";
import { defineCommand, registerCliCommand } from "../../core/command.js";
import type { CommandRuntimeOptions } from "../../core/context.js";
import { CliError } from "../../core/errors.js";
import { writeText, NL } from "../../core/renderer.js";
import { requireTargetAlias, type TargetAliasOpts } from "../_target.js";
import { formatTaskAssigned } from "./_format.js";

interface AssignOpts extends TargetAliasOpts {
  number: string;
  assignee?: string;
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

/**
 * `--assignee` is required and never defaulted: "assign with no assignee" is
 * ambiguous between "to me" and "to nobody", and guessing either would be a
 * silent, wrong write. "To nobody" is `raft task unassign`.
 */
function validateAssignOpts(opts: Partial<AssignOpts>): {
  channel: string;
  taskNumber: number;
  assignee: string;
  expectedRevision?: number;
} {
  const channel = requireTargetAlias(opts);
  const taskNumber = parseTaskNumber(opts.number);

  const raw = (opts.assignee ?? "").trim();
  if (!raw) {
    throw new CliError({
      code: "INVALID_ARG",
      message: "--assignee <@who> is required; to clear the assignee use `raft task unassign`",
    });
  }
  const assignee = raw.startsWith("@") ? raw : `@${raw}`;

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

  return { channel, taskNumber, assignee, expectedRevision };
}

export const taskAssignCommand = defineCommand(
  {
    name: "assign",
    description: "Assign a task to a human or agent",
    options: [
      { flags: "--target <target>", description: "Channel target: '#channel'" },
      { flags: "--channel <target>", description: "Legacy alias for --target (accepted during transition)" },
      { flags: "--number <n>", description: "Task number to assign" },
      { flags: "--assignee <@who>", description: "Human or agent to assign to, e.g. @alice" },
      {
        flags: "--expected-revision <n>",
        description: "Only apply if the task is still at this revision (lose instead of clobbering)",
      },
    ],
  },
  async (ctx, opts: Partial<AssignOpts>) => {
    const { channel, taskNumber, assignee, expectedRevision } = validateAssignOpts(opts);
    const agentContext = ctx.loadAgentContext();
    const client = ctx.createApiClient(agentContext);
    const body: AgentApiTaskAssignBody = {
      channel,
      task_number: taskNumber,
      assignee,
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
    writeText(ctx.io, formatTaskAssigned(taskNumber, assignee), NL);
  },
);

export function registerTaskAssignCommand(parent: Command, runtimeOptions?: CommandRuntimeOptions): void {
  registerCliCommand(parent, taskAssignCommand, runtimeOptions);
}
