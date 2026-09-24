// `raft channel archive|unarchive --target <#channel>`
// -> POST /internal/agent-api/channels/archive|unarchive

import type { Command } from "commander";

import { createAgentApiSurfaceClient } from "../../agentApiPath.js";
import { defineCommand, registerCliCommand } from "../../core/command.js";
import type { CommandContext, CommandRuntimeOptions } from "../../core/context.js";
import { CliError } from "../../core/errors.js";
import { writeText, adoptCliReplyText } from "../../core/renderer.js";
import { parseRegularChannelTarget } from "./leave.js";

interface ChannelLifecycleOpts {
  target?: string;
}

interface LifecycleChannel {
  id: string;
  name: string;
  archivedAt?: string | null;
}

export function formatArchiveChannelResult(channel: LifecycleChannel): string {
  return `Archived #${channel.name}. The channel is read-only until unarchived.`;
}

export function formatUnarchiveChannelResult(channel: LifecycleChannel): string {
  return `Unarchived #${channel.name}. Messages and other writes are enabled again.`;
}

async function runChannelLifecycle(
  ctx: CommandContext,
  opts: ChannelLifecycleOpts,
  archived: boolean,
): Promise<void> {
  const target = opts.target ?? "";
  const channelName = parseRegularChannelTarget(target);
  if (!channelName) {
    throw new CliError({
      code: "INVALID_TARGET",
      message: "Target must be a regular channel in the form '#channel-name'. DMs and thread targets are not supported.",
    });
  }

  const agentContext = ctx.loadAgentContext();
  const client = ctx.createApiClient(agentContext);
  const agentApi = createAgentApiSurfaceClient(client);
  const lifecycleRes = archived
    ? await agentApi.channels.archive({ target: `#${channelName}` })
    : await agentApi.channels.unarchive({ target: `#${channelName}` });
  if (!lifecycleRes.ok || !lifecycleRes.data) {
    throw new CliError({
      code: lifecycleRes.status >= 500 ? "SERVER_5XX" : archived ? "ARCHIVE_FAILED" : "UNARCHIVE_FAILED",
      message: lifecycleRes.error ?? `HTTP ${lifecycleRes.status}`,
    });
  }

  const output = archived
    ? formatArchiveChannelResult(lifecycleRes.data)
    : formatUnarchiveChannelResult(lifecycleRes.data);
  writeText(ctx.io, adoptCliReplyText(output + "\n"));
}

export const channelArchiveCommand = defineCommand(
  {
    name: "archive",
    description: "Archive a regular channel when this agent has server admin authority",
    options: [{
      flags: "--target <target>",
      description: "Regular channel to archive, e.g. '#engineering'",
    }],
  },
  async (ctx, opts: ChannelLifecycleOpts) => runChannelLifecycle(ctx, opts, true),
);

export const channelUnarchiveCommand = defineCommand(
  {
    name: "unarchive",
    description: "Unarchive a regular channel when this agent has server admin authority",
    options: [{
      flags: "--target <target>",
      description: "Archived regular channel to restore, e.g. '#engineering'",
    }],
  },
  async (ctx, opts: ChannelLifecycleOpts) => runChannelLifecycle(ctx, opts, false),
);

export function registerChannelArchiveCommand(parent: Command, runtimeOptions?: CommandRuntimeOptions): void {
  registerCliCommand(parent, channelArchiveCommand, runtimeOptions);
}

export function registerChannelUnarchiveCommand(parent: Command, runtimeOptions?: CommandRuntimeOptions): void {
  registerCliCommand(parent, channelUnarchiveCommand, runtimeOptions);
}
