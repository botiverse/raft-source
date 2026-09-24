// `raft channel info <#channel>` — narrow channel fact lookup from visible server inventory.

import type { Command } from "commander";

import { createAgentApiSurfaceClient } from "../../agentApiPath.js";
import { defineCommand, registerCliCommand } from "../../core/command.js";
import type { CommandRuntimeOptions } from "../../core/context.js";
import { CliError } from "../../core/errors.js";
import { writeText } from "../../core/renderer.js";
import { formatChannelInfo } from "../server/_format.js";
import { parseRegularChannelTarget } from "./leave.js";

function normalizeChannelInfoTarget(target: string | undefined): { input: string; name: string } {
  const input = target?.trim() ?? "";
  const normalized = input.startsWith("#") ? input : `#${input}`;
  const name = parseRegularChannelTarget(normalized);
  if (!name) {
    throw new CliError({
      code: "INVALID_TARGET",
      message: "Target must be a regular channel name, e.g. '#engineering' or 'engineering'. DMs and thread targets are not supported.",
    });
  }
  return { input: normalized, name };
}

export const channelInfoCommand = defineCommand(
  {
    name: "info",
    description: "Show narrow channel facts: existence, joined state, description, and member count when visible",
    arguments: ["<target>"],
  },
  async (ctx, target: string | undefined) => {
    const { input, name } = normalizeChannelInfoTarget(target);
    const agentContext = ctx.loadAgentContext();
    const client = ctx.createApiClient(agentContext);
    const agentApi = createAgentApiSurfaceClient(client);
    const infoRes = await agentApi.server.info();
    if (!infoRes.ok) {
      throw new CliError({
        code: infoRes.status >= 500 ? "SERVER_5XX" : "INFO_FAILED",
        message: infoRes.error ?? `HTTP ${infoRes.status}`,
      });
    }

    const channel = (infoRes.data?.channels ?? []).find((candidate) => candidate.name === name);
    if (!channel) {
      throw new CliError({
        code: "NOT_FOUND",
        message: `Channel not found or not visible: ${input}`,
        suggestedNextAction: "Run `raft server info --channels --query <name>` to inspect visible channels, or ask a channel member to add you if this is private.",
      });
    }

    let memberCounts: { agents?: number; humans?: number } | null = null;
    const membersRes = await agentApi.channels.members({ channel: `#${name}` });
    if (membersRes.ok) {
      memberCounts = {
        agents: membersRes.data?.agents?.length ?? 0,
        humans: membersRes.data?.humans?.length ?? 0,
      };
    }

    writeText(ctx.io, formatChannelInfo(channel, memberCounts));
  },
);

export function registerChannelInfoCommand(parent: Command, runtimeOptions?: CommandRuntimeOptions): void {
  registerCliCommand(parent, channelInfoCommand, runtimeOptions);
}
