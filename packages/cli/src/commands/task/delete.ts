// `raft task delete --target <ch> --number <N>`
// → POST /internal/agent-api/tasks/delete

import type { Command } from "commander";
import { type AgentApiTaskDeleteBody } from "@botiverse/raft-shared";

import { createAgentApiSurfaceClient } from "../../agentApiPath.js";
import { defineCommand, registerCliCommand } from "../../core/command.js";
import type { CommandRuntimeOptions } from "../../core/context.js";
import { CliError } from "../../core/errors.js";
import { writeText, NL } from "../../core/renderer.js";
import { requireTargetAlias, type TargetAliasOpts } from "../_target.js";
import { formatTaskDeleted } from "./_format.js";

interface DeleteOpts extends TargetAliasOpts {
  number: string;
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

function validateDeleteOpts(opts: Partial<DeleteOpts>): { channel: string; taskNumber: number } {
  const channel = requireTargetAlias(opts);
  return { channel, taskNumber: parseTaskNumber(opts.number) };
}

export const taskDeleteCommand = defineCommand(
  {
    name: "delete",
    description: "Delete a task (creator or server admin only)",
    options: [
      { flags: "--target <target>", description: "Channel target: '#channel'" },
      { flags: "--channel <target>", description: "Legacy alias for --target (accepted during transition)" },
      { flags: "--number <n>", description: "Task number to delete" },
    ],
  },
  async (ctx, opts: Partial<DeleteOpts>) => {
    const { channel, taskNumber } = validateDeleteOpts(opts);
    const agentContext = ctx.loadAgentContext();
    const client = ctx.createApiClient(agentContext);
    const body: AgentApiTaskDeleteBody = { channel, task_number: taskNumber };
    const agentApi = createAgentApiSurfaceClient(client);
    const res = await agentApi.tasks.delete(body);
    if (!res.ok) {
      throw new CliError({
        code: res.status >= 500 ? "SERVER_5XX" : "DELETE_FAILED",
        message: res.error ?? `HTTP ${res.status}`,
        // Deletion is irreversible and a 403 here is an authority fact, not a
        // retryable race — name who may do it instead of inviting a retry.
        suggestedNextAction: res.status === 403
          ? "Only the task creator or a server admin can delete a task; ask one of them, or close it instead."
          : undefined,
      });
    }
    if (!res.data) {
      throw new CliError({
        code: "INVALID_JSON_RESPONSE",
        message: "Agent API taskDelete returned an empty response body",
      });
    }
    writeText(ctx.io, formatTaskDeleted(taskNumber), NL);
  },
);

export function registerTaskDeleteCommand(parent: Command, runtimeOptions?: CommandRuntimeOptions): void {
  registerCliCommand(parent, taskDeleteCommand, runtimeOptions);
}
