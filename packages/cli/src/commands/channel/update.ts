// `raft channel update --target <#channel> [--name <name>] [--description <text>] [--public|--private]`
// -> PATCH /internal/agent/:id/channels/:channelId

import type { Command } from "commander";

import { createAgentApiSurfaceClient } from "../../agentApiPath.js";
import { defineCommand, registerCliCommand } from "../../core/command.js";
import type { CommandRuntimeOptions } from "../../core/context.js";
import { CliError } from "../../core/errors.js";
import { writeText, adoptCliReplyText } from "../../core/renderer.js";
import { parseRegularChannelTarget } from "./leave.js";

interface UpdateChannelOpts {
  target?: string;
  name?: string;
  description?: string;
  public?: boolean;
  private?: boolean;
}

interface UpdatedChannel {
  id: string;
  name: string;
  type?: string;
}

function normalizeChannelName(raw: string | undefined): string {
  return (raw ?? "").trim().replace(/^#/, "");
}

export function formatUpdateChannelResult(channel: UpdatedChannel): string {
  const visibility = channel.type === "private" ? "private" : "public";
  return `Updated #${channel.name} (${visibility}).`;
}

export const channelUpdateCommand = defineCommand(
  {
    name: "update",
    description: "Edit a regular channel when this agent has server admin authority",
    options: [
      {
        flags: "--target <target>",
        description: "Regular channel to edit, e.g. '#engineering'",
      },
      {
        flags: "--name <name>",
        description: "New channel name, with or without a leading '#'",
      },
      {
        flags: "--description <description>",
        description: "New channel description",
      },
      {
        flags: "--public",
        description: "Make the channel public (you must be a member; not usable on #all)",
      },
      {
        flags: "--private",
        description: "Make the channel private (you must be a member; not usable on #all)",
      },
    ],
  },
  async (ctx, opts: UpdateChannelOpts) => {
    const target = opts.target ?? "";
    const channelName = parseRegularChannelTarget(target);
    if (!channelName) {
      throw new CliError({
        code: "INVALID_TARGET",
        message: "Target must be a regular channel in the form '#channel-name'. DMs and thread targets are not supported.",
      });
    }
    if (opts.public && opts.private) {
      throw new CliError({
        code: "INVALID_ARG",
        message: "Use either --public or --private, not both.",
      });
    }

    const body: { name?: string; description?: string; visibility?: "public" | "private" } = {};
    if (opts.name !== undefined) body.name = normalizeChannelName(opts.name);
    if (opts.description !== undefined) body.description = opts.description;
    if (opts.public) body.visibility = "public";
    if (opts.private) body.visibility = "private";
    if (body.name === undefined && body.description === undefined && body.visibility === undefined) {
      throw new CliError({
        code: "INVALID_ARG",
        message: "Provide at least one of --name, --description, --public, or --private.",
      });
    }

    const agentContext = ctx.loadAgentContext();
    const client = ctx.createApiClient(agentContext);
    const infoRes = await createAgentApiSurfaceClient(client).server.info();
    if (!infoRes.ok) {
      throw new CliError({
        code: infoRes.status >= 500 ? "SERVER_5XX" : "INFO_FAILED",
        message: infoRes.error ?? `HTTP ${infoRes.status}`,
      });
    }

    const channel = (infoRes.data?.channels ?? []).find((candidate) => candidate.name === channelName);
    if (!channel) {
      throw new CliError({
        code: "NOT_FOUND",
        message: `Channel not found: ${target}`,
      });
    }

    const updateRes = await client.request<UpdatedChannel>(
      "PATCH",
      `/internal/agent/${encodeURIComponent(agentContext.agentId)}/channels/${encodeURIComponent(channel.id)}`,
      body,
    );
    if (!updateRes.ok || !updateRes.data) {
      throw new CliError({
        code: updateRes.status >= 500 ? "SERVER_5XX" : "UPDATE_FAILED",
        message: updateRes.error ?? `HTTP ${updateRes.status}`,
      });
    }

    writeText(ctx.io, adoptCliReplyText(formatUpdateChannelResult(updateRes.data) + "\n"));
  },
);

export function registerChannelUpdateCommand(parent: Command, runtimeOptions?: CommandRuntimeOptions): void {
  registerCliCommand(parent, channelUpdateCommand, runtimeOptions);
}
