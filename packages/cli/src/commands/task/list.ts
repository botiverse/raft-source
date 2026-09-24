// `raft task list --target <ch> [--status <s>]` → GET /internal/agent-api/tasks

import type { Command } from "commander";
import { type AgentApiTaskListQuery } from "@botiverse/raft-shared";

import { createAgentApiSurfaceClient } from "../../agentApiPath.js";
import { defineCommand, registerCliCommand } from "../../core/command.js";
import type { CommandRuntimeOptions } from "../../core/context.js";
import { CliError } from "../../core/errors.js";
import { writeText, adoptCliReplyText } from "../../core/renderer.js";
import { requireTargetAlias, resolveTargetAlias, type TargetAliasOpts } from "../_target.js";
import { formatMyTaskList, formatTaskList } from "./_format.js";

interface ListOpts extends TargetAliasOpts {
  mine?: boolean;
  status?: TaskListStatus;
}

type TaskListStatus = NonNullable<AgentApiTaskListQuery["status"]>;
const VALID_STATUSES = ["all", "todo", "in_progress", "in_review", "done", "closed"] as const satisfies readonly TaskListStatus[];

type ValidatedListOpts =
  | { scope: "channel"; channel: string; status?: TaskListStatus }
  | { scope: "mine"; status?: TaskListStatus };

function validateListOpts(opts: TargetAliasOpts & { mine?: boolean; status?: string }): ValidatedListOpts {
  if (opts.status && !(VALID_STATUSES as readonly string[]).includes(opts.status)) {
    throw new CliError({
      code: "INVALID_ARG",
      message: `--status must be one of ${VALID_STATUSES.join("|")}; got ${opts.status}`,
    });
  }
  const target = resolveTargetAlias(opts);
  if (opts.mine && target) {
    throw new CliError({
      code: "INVALID_ARG",
      message: "--mine cannot be combined with --target or legacy --channel",
    });
  }
  if (opts.mine) {
    return {
      scope: "mine",
      ...(opts.status ? { status: opts.status as TaskListStatus } : {}),
    };
  }
  const channel = requireTargetAlias(opts);
  return {
    scope: "channel",
    channel,
    ...(opts.status ? { status: opts.status as TaskListStatus } : {}),
  };
}

export const taskListCommand = defineCommand(
  {
    name: "list",
    description: "List tasks in a channel",
    options: [
      { flags: "--target <target>", description: "Channel target: '#channel'" },
      { flags: "--channel <target>", description: "Legacy alias for --target (accepted during transition)" },
      { flags: "--mine", description: "List tasks assigned to this agent across its visible task scope" },
      { flags: "--status <s>", description: "Filter: all|todo|in_progress|in_review|done|closed (--mine defaults to unfinished)" },
    ],
  },
  async (ctx, opts: Partial<ListOpts>) => {
    const listOpts = validateListOpts(opts);
    const agentContext = ctx.loadAgentContext();
    const client = ctx.createApiClient(agentContext);
    const agentApi = createAgentApiSurfaceClient(client);
    const query: AgentApiTaskListQuery = {
      ...(listOpts.scope === "mine" ? { mine: "true" as const } : { channel: listOpts.channel }),
      ...(listOpts.status ? { status: listOpts.status } : {}),
    };
    const res = await agentApi.tasks.list(query);
    if (!res.ok) {
      throw new CliError({
        code: res.status >= 500 ? "SERVER_5XX" : "LIST_FAILED",
        message: res.error ?? `HTTP ${res.status}`,
      });
    }
    if (!res.data) {
      throw new CliError({
        code: "INVALID_JSON_RESPONSE",
        message: "Agent API taskList returned an empty response body",
      });
    }
    writeText(
      ctx.io, adoptCliReplyText(
      `${listOpts.scope === "mine"
        ? formatMyTaskList(res.data, listOpts.status)
        : formatTaskList(listOpts.channel, res.data, listOpts.status)}\n`,
    ));
  },
);

export function registerTaskListCommand(parent: Command, runtimeOptions?: CommandRuntimeOptions): void {
  registerCliCommand(parent, taskListCommand, runtimeOptions);
}
