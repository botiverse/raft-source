// `raft task delete "#ch:#N"` (or `--target <ch> --number <N>`)
// → POST /internal/agent-api/tasks/delete

import type { Command } from "commander";
import type { AgentApiTaskDeleteBody } from "@botiverse/raft-shared";

import { createAgentApiSurfaceClient } from "../../agentApiPath";
import { defineCommand, registerCliCommand } from "../../core/command";
import type { CommandRuntimeOptions } from "../../core/context";
import { rateLimitedResponseError } from "../../core/apiFailure";
import { CliError } from "../../core/errors";
import { writeText, NL } from "../../core/renderer";
import { PEER_KIND_OPTION, type TargetAliasOpts } from "../_target";
import { resolveTaskWriteAddress, TASK_REF_ARGUMENT } from "./_taskAddress";
import { formatTaskDeleted } from "./_format";

interface DeleteOpts extends TargetAliasOpts {
  number: string;
}

export const taskDeleteCommand = defineCommand(
  {
    name: "delete",
    description: "Delete a task (creator or server admin only)",
    arguments: [TASK_REF_ARGUMENT],
    usage: '"#channel:#7"  (or --target "#channel" --number 7)',
    options: [
      { flags: "--target <target>", description: "The task's board: '#channel' or 'dm:@peer' (with --number), instead of a ref" },
      { flags: "--channel <target>", description: "Legacy alias for --target (accepted during transition)" },
      PEER_KIND_OPTION,
      { flags: "--number <n>", description: "Task number to delete (with --target)" },
    ],
  },
  async (ctx, refArg: string | undefined, opts: Partial<DeleteOpts> = {}) => {
    const { channel, taskNumber } = resolveTaskWriteAddress(refArg, opts);
    const agentContext = ctx.loadAgentContext();
    const client = ctx.createApiClient(agentContext);
    const body: AgentApiTaskDeleteBody = { channel, task_number: taskNumber };
    const agentApi = createAgentApiSurfaceClient(client);
    const res = await agentApi.tasks.delete(body);
    if (!res.ok) {
      const rateLimited = rateLimitedResponseError(res);
      if (rateLimited) throw rateLimited;
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
    writeText(ctx.io, formatTaskDeleted(taskNumber, res.data.taskRef), NL);
  },
);

export function registerTaskDeleteCommand(parent: Command, runtimeOptions?: CommandRuntimeOptions): void {
  registerCliCommand(parent, taskDeleteCommand, runtimeOptions);
}
