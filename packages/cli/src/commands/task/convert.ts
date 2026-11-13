// `raft task convert --target <ch> --message-id <id>`
// → POST /internal/agent-api/tasks/convert
//
// Distinct from `raft task claim --message-id`, which converts AND assigns the
// result to the caller. This verb files the work without taking it.
//
// Task v2: on a server with task conversations a message is never converted —
// the server refuses with `task_v2_use_create` and the `raft task create
// --message-id` command to use instead, which this prints as the error.

import type { Command } from "commander";
import type { AgentApiTaskConvertBody } from "@botiverse/raft-shared";
import { TASK_V2_USE_CREATE_ERROR_CODE } from "@botiverse/raft-shared/src/agentCliSurface";

import { createAgentApiSurfaceClient } from "../../agentApiPath";
import { defineCommand, registerCliCommand } from "../../core/command";
import type { CommandRuntimeOptions } from "../../core/context";
import { rateLimitedResponseError } from "../../core/apiFailure";
import { CliError } from "../../core/errors";
import { writeText, NL } from "../../core/renderer";
import { PEER_KIND_OPTION, requireTargetAlias, type TargetAliasOpts } from "../_target";
import { formatTaskConverted } from "./_format";

interface ConvertOpts extends TargetAliasOpts {
  messageId: string;
}

function validateConvertOpts(opts: Partial<ConvertOpts>): { channel: string; messageId: string } {
  const channel = requireTargetAlias(opts);
  const messageId = opts.messageId?.trim();
  if (!messageId) {
    throw new CliError({
      code: "INVALID_ARG",
      message: "--message-id is required",
    });
  }
  return { channel, messageId };
}

export const taskConvertCommand = defineCommand(
  {
    name: "convert",
    description: "Convert a message into a task without claiming it",
    options: [
      { flags: "--target <target>", description: "Channel target: '#channel'" },
      { flags: "--channel <target>", description: "Legacy alias for --target (accepted during transition)" },
      PEER_KIND_OPTION,
      { flags: "--message-id <id>", description: "Message to convert (full id or short prefix)" },
    ],
    guidance: [
      "Servers with task conversations:",
      "  A message is not converted there: this command does nothing and fails with code task_v2_use_create,",
      "  printing the command to use instead — create a task from the message (it stays linked to the message):",
      "    raft task create --target \"#channel\" --message-id <id> --title \"…\" [--assignee @you]",
    ].join("\n"),
  },
  async (ctx, opts: Partial<ConvertOpts>) => {
    const { channel, messageId } = validateConvertOpts(opts);
    const agentContext = ctx.loadAgentContext();
    const client = ctx.createApiClient(agentContext);
    const body: AgentApiTaskConvertBody = { channel, message_id: messageId };
    const agentApi = createAgentApiSurfaceClient(client);
    const res = await agentApi.tasks.convert(body);
    if (!res.ok) {
      const rateLimited = rateLimitedResponseError(res);
      if (rateLimited) throw rateLimited;
      if (res.errorCode === TASK_V2_USE_CREATE_ERROR_CODE) {
        // The server's text is the new way (the create command); print it as is.
        throw new CliError({ code: TASK_V2_USE_CREATE_ERROR_CODE, message: res.error ?? `HTTP ${res.status}` });
      }
      throw new CliError({
        code: res.status >= 500 ? "SERVER_5XX" : "CONVERT_FAILED",
        message: res.error ?? `HTTP ${res.status}`,
      });
    }
    if (!res.data) {
      throw new CliError({
        code: "INVALID_JSON_RESPONSE",
        message: "Agent API taskConvert returned an empty response body",
      });
    }
    writeText(ctx.io, formatTaskConverted(channel, res.data.task), NL);
  },
);

export function registerTaskConvertCommand(parent: Command, runtimeOptions?: CommandRuntimeOptions): void {
  registerCliCommand(parent, taskConvertCommand, runtimeOptions);
}
