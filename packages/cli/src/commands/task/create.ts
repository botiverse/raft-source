// `raft task create --target <ch> --message-id <id> --title <t> [--title <t2> ...]
//    [--assignee <@handle>] [--status <backlog|todo|in_progress>] [--description <text>]`
// (`--message-id`, the task's source, is required where task conversations are
// on; the Server enforces it: `task_source_required`.)
// → POST /internal/agent-api/tasks
//   body: { channel, tasks: [{title, description?, source_message_id?}, ...], assignee?, status? }

import type { Command } from "commander";
import type { AgentApiTaskCreateBody } from "@botiverse/raft-shared";
import { TASK_CREATE_STATUSES, isTaskCreateStatus } from "@botiverse/raft-shared/src/agentCliSurface";

import { createAgentApiSurfaceClient } from "../../agentApiPath";
import { defineCommand, registerCliCommand } from "../../core/command";
import type { CommandRuntimeOptions } from "../../core/context";
import { rateLimitedResponseError } from "../../core/apiFailure";
import { cliError } from "../../core/errors";
import { writeText, adoptCliReplyText } from "../../core/renderer";
import { PEER_KIND_OPTION, requireTargetAlias, type TargetAliasOpts } from "../_target";
import { formatTasksCreated } from "./_format";
import { writeHeldTaskWrite } from "../freshness/_taskHold";

interface CreateOpts extends TargetAliasOpts {
  title?: string[];
  description?: string;
  messageId?: string;
  assignee?: string;
  status?: string;
  createsResource?: boolean;
}

export const taskCreateCommand = defineCommand(
  {
    name: "create",
    description: "Create one or more tasks in a channel from their source message",
    options: [
      { flags: "--target <target>", description: "Channel target: '#channel'" },
      { flags: "--channel <target>", description: "Legacy alias for --target (accepted during transition)" },
      PEER_KIND_OPTION,
      {
        flags: "--title <title>",
        description: "Task title (repeatable for batch create)",
        parse: (value, prev: string[] = []) => prev.concat(value),
      },
      {
        flags: "--description <text>",
        description: "Task description (only with a single --title)",
      },
      {
        flags: "--message-id <id>",
        description: "Source (required where task conversations are on): the channel message that asked for the work (full or 8-char short id); a thread reply means its thread's root message",
      },
      {
        flags: "--assignee <handle>",
        description: "Assign every created task atomically to an eligible '@handle'",
      },
      {
        flags: "--status <status>",
        description: `Status every created task starts in: ${TASK_CREATE_STATUSES.join(", ")}. Default: in_progress when you assign yourself, otherwise todo`,
      },
      {
        flags: "--creates-resource",
        description: "Require a structured resource receipt and expiry follow-up before completion",
      },
    ],
    guidance: [
      "Assignment and status (each applies to every --title):",
      "  --assignee: self-assignment starts work; someone else gets reserved todo work. It must resolve uniquely and be able to claim here, else no task is created.",
      "  --status overrides that: `--status todo --assignee @you` reserves it for later; backlog parks it (needs task conversations). in_review/done/closed can't be chosen.",
      "  Undo a self-start: `raft task update --target <channel> --number <N> --status todo` (the task stays assigned to you).",
      "Source (required with task conversations on; refused with them off):",
      "  --message-id: the message that asked for the work, for every --title (a thread reply: its thread's root).",
      "  Own idea: first post a message in the channel saying what and why, then create from it.",
      "  If its thread shows someone took this work, add to their task instead.",
      "  --description: for the one task a single --title names.",
      "  Discuss a task where creation prints: its own conversation `#channel:#N` (`raft task reply`) where task conversations are on, else its thread.",
      "Resource receipt gate:",
      "  --creates-resource marks every --title: it cannot move to done until `raft task receipt` records its fields and an expiry follow-up.",
    ].join("\n"),
  },
  async (ctx, opts: CreateOpts) => {
    const channel = requireTargetAlias(opts);
    const titles = opts.title ?? [];
    if (titles.length === 0) throw cliError("INVALID_ARG", "--title is required (at least one)");
    const description = opts.description?.trim();
    if (opts.description !== undefined && !description) {
      throw cliError("INVALID_ARG", "--description must not be empty");
    }
    if (description && titles.length > 1) {
      throw cliError("INVALID_ARG", "--description can only be used with a single --title");
    }
    const sourceMessageId = opts.messageId?.trim();
    if (opts.messageId !== undefined && !sourceMessageId) {
      throw cliError("INVALID_ARG", "--message-id must not be empty");
    }
    const status = opts.status?.trim();
    if (opts.status !== undefined && !isTaskCreateStatus(status)) {
      throw cliError(
        "INVALID_ARG",
        `--status must be one of: ${TASK_CREATE_STATUSES.join(", ")}; got ${opts.status} (in_review, done and closed can't be chosen at creation)`,
      );
    }

    const body: AgentApiTaskCreateBody = {
      channel,
      tasks: titles.map((title) => ({
        title,
        ...(description ? { description } : {}),
        ...(sourceMessageId ? { source_message_id: sourceMessageId } : {}),
        ...(opts.createsResource ? { creates_resource: true } : {}),
      })),
      ...(isTaskCreateStatus(status) ? { status } : {}),
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
      const rateLimited = rateLimitedResponseError(res);
      if (rateLimited) throw rateLimited;
      const code = res.status >= 500 ? "SERVER_5XX" : "CREATE_FAILED";
      // A refusal's next step (e.g. `task_source_required`: the create with its source).
      throw cliError(code, res.error ?? `HTTP ${res.status}`, res.suggestedNextAction ? { suggestedNextAction: res.suggestedNextAction } : {});
    }
    if (!res.data) {
      throw cliError("INVALID_JSON_RESPONSE", "Agent API taskCreate returned an empty response body");
    }
    if (writeHeldTaskWrite(ctx, agentContext.agentId, "task_create", body, res.data)) return;
    writeText(ctx.io, adoptCliReplyText(formatTasksCreated(channel, res.data) + "\n"));
  },
);

export function registerTaskCreateCommand(parent: Command, runtimeOptions: CommandRuntimeOptions = {}): void {
  registerCliCommand(parent, taskCreateCommand, runtimeOptions);
}
