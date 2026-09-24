// `raft task history --target <ch> --number <N>`
// → Agent API taskHistory contract route

import type { Command } from "commander";

import { createAgentApiSurfaceClient } from "../../agentApiPath.js";
import { defineCommand, registerCliCommand } from "../../core/command.js";
import type { CommandRuntimeOptions } from "../../core/context.js";
import { CliError } from "../../core/errors.js";
import { writeText, NL } from "../../core/renderer.js";
import { requireTargetAlias, type TargetAliasOpts } from "../_target.js";
import { formatTaskHistory } from "./_format.js";

interface HistoryOpts extends TargetAliasOpts {
  number: string;
}

function parseTaskNumber(raw: string | undefined): number {
  const number = Number(raw);
  if (!Number.isInteger(number) || number <= 0) {
    throw new CliError({ code: "INVALID_ARG", message: `--number must be a positive integer; got ${raw}` });
  }
  return number;
}

export const taskHistoryCommand = defineCommand(
  {
    name: "history",
    description: "Read a task's append-only lifecycle and amendment history",
    options: [
      { flags: "--target <target>", description: "Channel target: '#channel'" },
      { flags: "--channel <target>", description: "Legacy alias for --target (accepted during transition)" },
      { flags: "--number <n>", description: "Task number to inspect" },
    ],
  },
  async (ctx, opts: Partial<HistoryOpts>) => {
    const channel = requireTargetAlias(opts);
    const taskNumber = parseTaskNumber(opts.number);
    const agentContext = ctx.loadAgentContext();
    const client = ctx.createApiClient(agentContext);
    const agentApi = createAgentApiSurfaceClient(client);
    const res = await agentApi.tasks.history({ channel, task_number: taskNumber });
    if (!res.ok) {
      throw new CliError({
        code: res.status >= 500 ? "SERVER_5XX" : "HISTORY_FAILED",
        message: res.error ?? `HTTP ${res.status}`,
      });
    }
    if (!res.data) {
      throw new CliError({ code: "INVALID_JSON_RESPONSE", message: "Agent API taskHistory returned an empty response body" });
    }
    writeText(ctx.io, formatTaskHistory(res.data), NL);
  },
);

export function registerTaskHistoryCommand(parent: Command, runtimeOptions?: CommandRuntimeOptions): void {
  registerCliCommand(parent, taskHistoryCommand, runtimeOptions);
}
