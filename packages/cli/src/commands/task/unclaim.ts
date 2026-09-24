// `raft task unclaim --target <ch> --number <N>`
// → POST /internal/agent-api/tasks/unclaim

import type { Command } from "commander";
import { type AgentApiTaskUnclaimBody } from "@botiverse/raft-shared";

import { createAgentApiSurfaceClient } from "../../agentApiPath.js";
import { defineCommand, registerCliCommand } from "../../core/command.js";
import type { CommandRuntimeOptions } from "../../core/context.js";
import { CliError } from "../../core/errors.js";
import { writeText, NL } from "../../core/renderer.js";
import { requireTargetAlias, type TargetAliasOpts } from "../_target.js";
import { formatTaskUnclaimed } from "./_format.js";

interface UnclaimOpts extends TargetAliasOpts {
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

function validateUnclaimOpts(opts: Partial<UnclaimOpts>): { channel: string; taskNumber: number } {
  const channel = requireTargetAlias(opts);
  return { channel, taskNumber: parseTaskNumber(opts.number) };
}

export const taskUnclaimCommand = defineCommand(
  {
    name: "unclaim",
    description: "Release a previously-claimed task",
    options: [
      { flags: "--target <target>", description: "Channel target: '#channel'" },
      { flags: "--channel <target>", description: "Legacy alias for --target (accepted during transition)" },
      { flags: "--number <n>", description: "Task number to unclaim" },
    ],
  },
  async (ctx, opts: Partial<UnclaimOpts>) => {
    const { channel, taskNumber } = validateUnclaimOpts(opts);
    const agentContext = ctx.loadAgentContext();
    const client = ctx.createApiClient(agentContext);
    const body: AgentApiTaskUnclaimBody = { channel, task_number: taskNumber };
    const agentApi = createAgentApiSurfaceClient(client);
    const res = await agentApi.tasks.unclaim(body);
    if (!res.ok) {
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
    writeText(ctx.io, formatTaskUnclaimed(taskNumber), NL);
  },
);

export function registerTaskUnclaimCommand(parent: Command, runtimeOptions?: CommandRuntimeOptions): void {
  registerCliCommand(parent, taskUnclaimCommand, runtimeOptions);
}
