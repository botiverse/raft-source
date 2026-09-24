// `raft task convert --target <ch> --message-id <id>`
// → POST /internal/agent-api/tasks/convert
//
// Distinct from `raft task claim --message-id`, which converts AND assigns the
// result to the caller. This verb files the work without taking it.

import type { Command } from "commander";
import { type AgentApiTaskConvertBody } from "@botiverse/raft-shared";

import { createAgentApiSurfaceClient } from "../../agentApiPath.js";
import { defineCommand, registerCliCommand } from "../../core/command.js";
import type { CommandRuntimeOptions } from "../../core/context.js";
import { CliError } from "../../core/errors.js";
import { writeText, NL } from "../../core/renderer.js";
import { requireTargetAlias, type TargetAliasOpts } from "../_target.js";
import { formatTaskConverted } from "./_format.js";

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
      { flags: "--message-id <id>", description: "Message to convert (full id or short prefix)" },
    ],
  },
  async (ctx, opts: Partial<ConvertOpts>) => {
    const { channel, messageId } = validateConvertOpts(opts);
    const agentContext = ctx.loadAgentContext();
    const client = ctx.createApiClient(agentContext);
    const body: AgentApiTaskConvertBody = { channel, message_id: messageId };
    const agentApi = createAgentApiSurfaceClient(client);
    const res = await agentApi.tasks.convert(body);
    if (!res.ok) {
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
