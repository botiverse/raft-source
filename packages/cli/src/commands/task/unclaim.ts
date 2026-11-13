// `raft task unclaim "#ch:#N"` (or `--target <ch> --number <N>`)
// → POST /internal/agent-api/tasks/unclaim

import type { Command } from "commander";
import type { AgentApiTaskUnclaimBody } from "@botiverse/raft-shared";

import { createAgentApiSurfaceClient } from "../../agentApiPath";
import { defineCommand, registerCliCommand } from "../../core/command";
import type { CommandRuntimeOptions } from "../../core/context";
import { rateLimitedResponseError } from "../../core/apiFailure";
import { CliError } from "../../core/errors";
import { writeText, NL } from "../../core/renderer";
import { PEER_KIND_OPTION, type TargetAliasOpts } from "../_target";
import { resolveTaskWriteAddress, TASK_REF_ARGUMENT } from "./_taskAddress";
import { formatTaskUnclaimed } from "./_format";
import { writeAttachedUnseen, writeHeldTaskWrite } from "../freshness/_taskHold";

interface UnclaimOpts extends TargetAliasOpts {
  number: string;
}

export const taskUnclaimCommand = defineCommand(
  {
    name: "unclaim",
    description: "Release a previously-claimed task",
    arguments: [TASK_REF_ARGUMENT],
    usage: '"#channel:#7"  (or --target "#channel" --number 7)',
    options: [
      { flags: "--target <target>", description: "The task's board: '#channel' or 'dm:@peer' (with --number), instead of a ref" },
      { flags: "--channel <target>", description: "Legacy alias for --target (accepted during transition)" },
      PEER_KIND_OPTION,
      { flags: "--number <n>", description: "Task number to unclaim (with --target)" },
    ],
  },
  async (ctx, refArg: string | undefined, opts: Partial<UnclaimOpts> = {}) => {
    const { channel, taskNumber } = resolveTaskWriteAddress(refArg, opts);
    const agentContext = ctx.loadAgentContext();
    const client = ctx.createApiClient(agentContext);
    const body: AgentApiTaskUnclaimBody = { channel, task_number: taskNumber };
    const agentApi = createAgentApiSurfaceClient(client);
    const res = await agentApi.tasks.unclaim(body);
    if (!res.ok) {
      const rateLimited = rateLimitedResponseError(res);
      if (rateLimited) throw rateLimited;
      throw new CliError({
        code: res.status >= 500 ? "SERVER_5XX" : "UNCLAIM_FAILED",
        message: res.error ?? `HTTP ${res.status}`,
      });
    }
    if (!res.data) {
      throw new CliError({
        code: "INVALID_JSON_RESPONSE",
        message: "Agent API taskUnclaim returned an empty response body",
      });
    }
    if (writeHeldTaskWrite(ctx, agentContext.agentId, "task_unclaim", body, res.data)) return;
    writeText(ctx.io, formatTaskUnclaimed(taskNumber, res.data.taskRef), NL);
    writeAttachedUnseen(ctx, agentContext.agentId, res.data);
  },
);

export function registerTaskUnclaimCommand(parent: Command, runtimeOptions?: CommandRuntimeOptions): void {
  registerCliCommand(parent, taskUnclaimCommand, runtimeOptions);
}
