// `raft task view <ref>` (task v2) — one task: status, assignee, source
// message, whether you follow it, the latest messages of its own
// conversation, and the commands to reply / read / (un)follow.
// → GET /internal/agent-api/tasks/view

import type { Command } from "commander";
import { formatAgentTaskView } from "@botiverse/raft-shared/src/agentCliSurface";

import { createAgentApiSurfaceClient } from "../../agentApiPath";
import { defineCommand, registerCliCommand } from "../../core/command";
import type { CommandRuntimeOptions } from "../../core/context";
import { CliError } from "../../core/errors";
import { adoptCliReplyText, writeText } from "../../core/renderer";
import { apiFailureError } from "../_apiFailure";
import { resolveTaskAddress, TASK_ADDRESS_OPTIONS, TASK_REF_ARGUMENT, type TaskAddressOpts } from "./_taskAddress";

interface ViewOpts extends TaskAddressOpts {
  limit?: string;
}

export const taskViewCommand = defineCommand(
  {
    name: "view",
    description: "View one task: status, assignee, source message, follow state, and its latest discussion",
    arguments: [TASK_REF_ARGUMENT],
    usage: '"#channel:#7" [--limit <n>]  (or --target "#channel" --number 7)',
    options: [
      ...TASK_ADDRESS_OPTIONS,
      { flags: "--limit <n>", description: "How many of the latest discussion messages to show (default 5, max 20)" },
    ],
    helpAfter:
      '\nA task is named by its ref: "#channel:#7", or "dm:@peer:#7" for a task in a DM. Quote it: an unquoted # starts a shell comment.\n',
  },
  async (ctx, refArg: string | undefined, opts: ViewOpts = {}) => {
    const address = resolveTaskAddress(refArg, opts);
    const limit = opts.limit?.trim();
    if (limit !== undefined && (!/^\d+$/.test(limit) || Number(limit) <= 0)) {
      throw new CliError({ code: "INVALID_ARG", message: `--limit must be a positive integer; got ${opts.limit}` });
    }
    const agentContext = ctx.loadAgentContext();
    const agentApi = createAgentApiSurfaceClient(ctx.createApiClient(agentContext));
    const res = await agentApi.tasks.view({
      channel: address.channel,
      task_number: address.taskNumber,
      ...(limit ? { limit } : {}),
    });
    if (!res.ok) throw apiFailureError(res, res.status === 404 ? "NOT_FOUND" : "VIEW_FAILED");
    if (!res.data) {
      throw new CliError({ code: "INVALID_JSON_RESPONSE", message: "Agent API taskView returned an empty response body" });
    }
    writeText(ctx.io, adoptCliReplyText(`${formatAgentTaskView(res.data)}\n`));
  },
);

export function registerTaskViewCommand(parent: Command, runtimeOptions?: CommandRuntimeOptions): void {
  registerCliCommand(parent, taskViewCommand, runtimeOptions);
}
