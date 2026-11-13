// `raft channel create --name <name> [--private] [--description <text>]`
// → POST /internal/agent-api/channels

import type { Command } from "commander";

import { createAgentApiSurfaceClient } from "../../agentApiPath";
import { defineCommand, registerCliCommand } from "../../core/command";
import type { CommandRuntimeOptions } from "../../core/context";
import { rateLimitedResponseError } from "../../core/apiFailure";
import { CliError } from "../../core/errors";
import { writeText, adoptCliReplyText } from "../../core/renderer";

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
    const res = await createAgentApiSurfaceClient(client).channels.create({
      name,
      ...(opts.description !== undefined ? { description: opts.description } : {}),
      visibility: opts.private ? "private" : "public",
    });
    const rateLimited = res.ok ? null : rateLimitedResponseError(res);
    if (rateLimited) throw rateLimited;
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
