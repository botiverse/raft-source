// `raft task create --target <ch> --title <t> [--title <t2> ...] [--assignee <@handle>]`
// → POST /internal/agent-api/tasks  body: { channel, tasks: [{title}, ...], assignee? }

import type { Command } from "commander";
import { type AgentApiTaskCreateBody } from "@botiverse/raft-shared";

import { createAgentApiSurfaceClient } from "../../agentApiPath.js";
import { defineCommand, registerCliCommand } from "../../core/command.js";
import type { CommandRuntimeOptions } from "../../core/context.js";
import { cliError } from "../../core/errors.js";
import { writeText, adoptCliReplyText } from "../../core/renderer.js";
import { requireTargetAlias, type TargetAliasOpts } from "../_target.js";
import { formatTasksCreated } from "./_format.js";

interface CreateOpts extends TargetAliasOpts {
  title?: string[];
  assignee?: string;
  createsResource?: boolean;
}

export const taskCreateCommand = defineCommand(
  {
    name: "create",
    description: "Create one or more tasks in a channel",
    options: [
      { flags: "--target <target>", description: "Channel target: '#channel'" },
      { flags: "--channel <target>", description: "Legacy alias for --target (accepted during transition)" },
      {
        flags: "--title <title>",
        description: "Task title (repeatable for batch create)",
        parse: (value, prev: string[] = []) => prev.concat(value),
      },
      {
        flags: "--assignee <handle>",
        description: "Assign every created task atomically to an eligible '@handle'",
      },
      {
        flags: "--creates-resource",
        description: "Require a structured resource receipt and expiry follow-up before completion",
      },
    ],
    helpAfter: [
      "Atomic assignment:",
      "  --assignee applies to every --title. Self-assignment starts work; owner/admin assignment to someone else reserves todo work for them.",
      "  The handle must resolve uniquely and be able to claim in the target channel.",
      "  If handle resolution or channel authorization fails, no task-message is created.",
      "Resource receipt gate:",
      "  --creates-resource marks every --title. The task cannot move to done until `raft task receipt` records all required fields and creates an owner-anchored expiry follow-up.",
    ].join("\n"),
  },
  async (ctx, opts: CreateOpts) => {
    const channel = requireTargetAlias(opts);
    const titles = opts.title ?? [];
    if (titles.length === 0) throw cliError("INVALID_ARG", "--title is required (at least one)");

    const body: AgentApiTaskCreateBody = {
      channel,
      tasks: titles.map((title) => ({
        title,
        ...(opts.createsResource ? { creates_resource: true } : {}),
      })),
    };
    if (opts.assignee !== undefined) {
      const assignee = opts.assignee.trim();
      if (!assignee.startsWith("@") || assignee.slice(1).trim().length === 0) {
        throw cliError("INVALID_ARG", "--assignee must be an @handle");
      }
      body.assignee = `@${assignee.slice(1).trim()}`;
    }
    const agentContext = ctx.loadAgentContext();
    const client = ctx.createApiClient(agentContext);
    const agentApi = createAgentApiSurfaceClient(client);
    const res = await agentApi.tasks.create(body);
    if (!res.ok) {
      const code = res.status >= 500 ? "SERVER_5XX" : "CREATE_FAILED";
      throw cliError(code, res.error ?? `HTTP ${res.status}`);
    }
    if (!res.data) {
      throw cliError("INVALID_JSON_RESPONSE", "Agent API taskCreate returned an empty response body");
    }
    writeText(ctx.io, adoptCliReplyText(formatTasksCreated(channel, res.data) + "\n"));
  },
);

export function registerTaskCreateCommand(parent: Command, runtimeOptions: CommandRuntimeOptions = {}): void {
  registerCliCommand(parent, taskCreateCommand, runtimeOptions);
}
