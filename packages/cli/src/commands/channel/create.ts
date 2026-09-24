// `raft channel create --name <name> [--private] [--description <text>]`
// → POST /internal/agent/:id/channels

import type { Command } from "commander";

import { defineCommand, registerCliCommand } from "../../core/command.js";
import type { CommandRuntimeOptions } from "../../core/context.js";
import { CliError } from "../../core/errors.js";
import { writeText, adoptCliReplyText } from "../../core/renderer.js";

interface CreateOpts {
  name?: string;
  description?: string;
  private?: boolean;
}

interface CreatedChannel {
  id: string;
  name: string;
  type?: string;
}

function normalizeChannelName(raw: string | undefined): string {
  return (raw ?? "").trim().replace(/^#/, "");
}

export function formatCreateChannelResult(channel: CreatedChannel): string {
  const target = `#${channel.name}`;
  const visibility = channel.type === "private" ? "private" : "public";
  return `Created ${target} (${visibility}). You are joined and can send messages there.`;
}

export const channelCreateCommand = defineCommand(
  {
    name: "create",
    description: "Create a public or private channel when this agent has server admin authority",
    options: [
      {
        flags: "--name <name>",
        description: "Channel name, with or without a leading '#'",
      },
      {
        flags: "--description <description>",
        description: "Optional channel description",
      },
      {
        flags: "--private",
        description: "Create a private channel instead of a public channel",
      },
    ],
  },
  async (ctx, opts: CreateOpts) => {
    const name = normalizeChannelName(opts.name);
    if (!name) {
      throw new CliError({
        code: "INVALID_ARG",
        message: "--name is required",
      });
    }

    const agentContext = ctx.loadAgentContext();
    const client = ctx.createApiClient(agentContext);
    const res = await client.request<CreatedChannel>(
      "POST",
      `/internal/agent/${encodeURIComponent(agentContext.agentId)}/channels`,
      {
        name,
        description: opts.description,
        visibility: opts.private ? "private" : "public",
      },
    );
    if (!res.ok || !res.data) {
      throw new CliError({
        code: res.status >= 500 ? "SERVER_5XX" : "CREATE_FAILED",
        message: res.error ?? `HTTP ${res.status}`,
      });
    }

    writeText(ctx.io, adoptCliReplyText(formatCreateChannelResult(res.data) + "\n"));
  },
);

export function registerChannelCreateCommand(parent: Command, runtimeOptions?: CommandRuntimeOptions): void {
  registerCliCommand(parent, channelCreateCommand, runtimeOptions);
}
