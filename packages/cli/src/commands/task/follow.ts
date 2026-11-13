// `raft task follow <ref>` / `raft task unfollow <ref>` (task v2) — whether a
// task's conversation wakes you. Creating a task, being assigned it,
// replying in it and being @mentioned in it follow it already.
// → POST /internal/agent-api/tasks/follow | /tasks/unfollow

import type { Command } from "commander";
import { formatAgentTaskFollowResult } from "@botiverse/raft-shared/src/agentCliSurface";

import { createAgentApiSurfaceClient } from "../../agentApiPath";
import { defineCommand, registerCliCommand } from "../../core/command";
import type { CommandRuntimeOptions } from "../../core/context";
import { CliError } from "../../core/errors";
import { adoptCliReplyText, writeText } from "../../core/renderer";
import { apiFailureError } from "../_apiFailure";
import { resolveTaskAddress, TASK_ADDRESS_OPTIONS, TASK_REF_ARGUMENT, type TaskAddressOpts } from "./_taskAddress";

type TaskFollowOpts = TaskAddressOpts & { reason?: string };

function defineTaskFollowCommand(follow: boolean) {
  return defineCommand(
    {
      name: follow ? "follow" : "unfollow",
      description: follow
        ? "Follow a task's conversation: its replies wake you"
        : "Stop following a task's conversation: its ordinary replies no longer wake you",
      arguments: [TASK_REF_ARGUMENT],
      usage: '"#channel:#7"  (or --target "#channel" --number 7)',
      options: follow
        ? [...TASK_ADDRESS_OPTIONS]
        : [
          ...TASK_ADDRESS_OPTIONS,
          {
            flags: "--reason <reason>",
            description: "Short reason shown in the task conversation's unfollow notice",
          },
        ],
    },
    async (ctx, refArg: string | undefined, opts: TaskFollowOpts = {}) => {
      const address = resolveTaskAddress(refArg, opts);
      const agentContext = ctx.loadAgentContext();
      const agentApi = createAgentApiSurfaceClient(ctx.createApiClient(agentContext));
      const body = { channel: address.channel, task_number: address.taskNumber };
      const res = follow
        ? await agentApi.tasks.follow(body)
        : await agentApi.tasks.unfollow(opts.reason?.trim() ? { ...body, reason: opts.reason.trim() } : body);
      if (!res.ok) throw apiFailureError(res, res.status === 404 ? "NOT_FOUND" : "FOLLOW_FAILED");
      if (!res.data) {
        throw new CliError({ code: "INVALID_JSON_RESPONSE", message: `Agent API ${follow ? "taskFollow" : "taskUnfollow"} returned an empty response body` });
      }
      writeText(ctx.io, adoptCliReplyText(`${formatAgentTaskFollowResult({
        taskRef: res.data.taskRef || address.ref,
        following: res.data.following,
        changed: res.data.changed,
      })}\n`));
    },
  );
}

export const taskFollowCommand = defineTaskFollowCommand(true);
export const taskUnfollowCommand = defineTaskFollowCommand(false);

export function registerTaskFollowCommands(parent: Command, runtimeOptions?: CommandRuntimeOptions): void {
  registerCliCommand(parent, taskFollowCommand, runtimeOptions);
  registerCliCommand(parent, taskUnfollowCommand, runtimeOptions);
}
