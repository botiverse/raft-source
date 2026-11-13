// `raft task list --target <ch> [--status <s>]` → GET /internal/agent-api/tasks
// `raft task list --following` (task v2) → GET /internal/agent-api/tasks/following

import type { Command } from "commander";
import type { AgentApiTaskListQuery } from "@botiverse/raft-shared";

import { createAgentApiSurfaceClient } from "../../agentApiPath";
import { defineCommand, registerCliCommand } from "../../core/command";
import type { CommandRuntimeOptions } from "../../core/context";
import { CliError } from "../../core/errors";
import { writeText, adoptCliReplyText, NL } from "../../core/renderer";
import { PEER_KIND_OPTION, requireTargetAlias, resolveTargetAlias, type TargetAliasOpts } from "../_target";
import { formatFollowedTasks, formatMyTaskList, formatTaskList } from "./_format";

interface ListOpts extends TargetAliasOpts {
  mine?: boolean;
  following?: boolean;
  status?: TaskListStatus;
}

type TaskListStatus = NonNullable<AgentApiTaskListQuery["status"]>;
const VALID_STATUSES = ["all", "backlog", "todo", "in_progress", "in_review", "done", "closed"] as const satisfies readonly TaskListStatus[];

type ValidatedListOpts =
  | { scope: "channel"; channel: string; status?: TaskListStatus }
  | { scope: "mine"; status?: TaskListStatus }
  | { scope: "following" };

function validateListOpts(opts: TargetAliasOpts & { mine?: boolean; following?: boolean; status?: string }): ValidatedListOpts {
  if (opts.following) {
    if (opts.mine || resolveTargetAlias(opts) || opts.status) {
      throw new CliError({
        code: "INVALID_ARG",
        message: "--following lists the task conversations you follow; it cannot be combined with --mine, --target, --channel or --status",
      });
    }
    return { scope: "following" };
  }
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
      PEER_KIND_OPTION,
      { flags: "--mine", description: "List tasks assigned to this agent across its visible task scope" },
      { flags: "--following", description: "List the task conversations you follow (their replies wake you), with unread counts" },
      { flags: "--status <s>", description: "Filter: all|backlog|todo|in_progress|in_review|done|closed (--mine defaults to unfinished, which leaves backlog out)" },
    ],
  },
  async (ctx, opts: Partial<ListOpts>) => {
    const listOpts = validateListOpts(opts);
    const agentContext = ctx.loadAgentContext();
    const client = ctx.createApiClient(agentContext);
    const agentApi = createAgentApiSurfaceClient(client);
    if (listOpts.scope === "following") {
      const following = await agentApi.tasks.following();
      if (!following.ok) {
        throw new CliError({
          code: following.status >= 500 ? "SERVER_5XX" : "LIST_FAILED",
          message: following.error ?? `HTTP ${following.status}`,
        });
      }
      if (!following.data) {
        throw new CliError({
          code: "INVALID_JSON_RESPONSE",
          message: "Agent API taskFollowing returned an empty response body",
        });
      }
      writeText(ctx.io, formatFollowedTasks(following.data.tasks), NL);
      return;
    }
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
