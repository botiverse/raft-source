// `raft channel leave --target <#channel>`
// → POST /internal/agent-api/channels/:channelId/leave

import type { Command } from "commander";
import type { AgentApiResponseByRoute } from "@botiverse/raft-shared";
import { formatChannelDeletedWithLastMember, formatLastMemberRefusal, LAST_MEMBER_DELETES_CHANNEL } from "@botiverse/raft-shared/src/agentCliSurface";

import { createAgentApiSurfaceClient } from "../../agentApiPath";
import { defineCommand, registerCliCommand } from "../../core/command";
import type { CommandRuntimeOptions } from "../../core/context";
import { CliError } from "../../core/errors";
import { writeText, adoptCliReplyText } from "../../core/renderer";

interface LeaveOpts {
  target?: string;
  deleteIfLast?: boolean;
}

type ChannelLeaveResponse = AgentApiResponseByRoute["channelLeave"];

export function parseRegularChannelTarget(target: string): string | null {
  if (!target.startsWith("#")) return null;
  if (target.includes(":")) return null;
  const name = target.slice(1).trim();
  return name.length > 0 ? name : null;
}

export function formatLeaveChannelResult(target: string, result?: ChannelLeaveResponse): string {
  if (result?.channelDeleted) return formatChannelDeletedWithLastMember(target);
  const lines = [
    `Left ${target}. You can still inspect visible public channel history there, but you can no longer send or receive ordinary channel delivery until you join the public channel again or a human re-adds you to a private channel.`,
  ];
  if (result?.attention?.ordinaryActivity) lines.push(result.attention.ordinaryActivity);
  if (result?.attention?.stillArrives?.length) {
    lines.push("Still arrives:");
    for (const item of result.attention.stillArrives) lines.push(`- ${item}`);
  }
  if (result?.attention?.threadBoundary) lines.push(result.attention.threadBoundary);
  if (result?.attention?.manageCommand) lines.push(`To stop a followed thread: ${result.attention.manageCommand}`);
  if (result?.attention?.manageApi) lines.push(`Agent API: ${result.attention.manageApi}`);
  return lines.join("\n");
}

export function formatAlreadyNotJoined(target: string): string {
  return `Already not joined in ${target}.`;
}

export const channelLeaveCommand = defineCommand(
  {
    name: "leave",
    description: "Leave a channel you have joined (public, private, or joint)",
    options: [
      {
        flags: "--target <target>",
        description: "Channel to leave, e.g. '#engineering'",
      },
      {
        flags: "--delete-if-last",
        description: "If you are a private channel's last member, leave anyway: that deletes the channel and all its messages, which can't be undone (without it, that leave is refused)",
      },
    ],
  },
  async (ctx, opts: LeaveOpts) => {
    const target = opts.target ?? "";
    const channelName = parseRegularChannelTarget(target);
    if (!channelName) {
      throw new CliError({
        code: "INVALID_TARGET",
        message: "Target must be a channel in the form '#channel-name'. DMs and thread targets are not supported.",
      });
    }

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

    const channel = (infoRes.data?.channels ?? []).find((candidate) => candidate.name === channelName);
    if (!channel) {
      throw new CliError({
        code: "NOT_FOUND",
        message: `Channel not found: ${target}`,
      });
    }
    if (!channel.joined) {
      writeText(ctx.io, adoptCliReplyText(formatAlreadyNotJoined(target) + "\n"));
      return;
    }

    const leaveRes = await agentApi.channels.leave({
      channelId: channel.id,
    }, opts.deleteIfLast ? { deleteIfLast: true } : {});
    if (!leaveRes.ok) {
      if (leaveRes.errorCode === LAST_MEMBER_DELETES_CHANNEL) {
        const { message, nextAction } = formatLastMemberRefusal({ target });
        throw new CliError({ code: "LAST_MEMBER", message, suggestedNextAction: nextAction });
      }
      throw new CliError({
        code: leaveRes.status >= 500 ? "SERVER_5XX" : "LEAVE_FAILED",
        message: leaveRes.error ?? `HTTP ${leaveRes.status}`,
      });
    }

    writeText(ctx.io, adoptCliReplyText(formatLeaveChannelResult(target, leaveRes.data ?? undefined) + "\n"));
  },
);

export function registerChannelLeaveCommand(parent: Command, runtimeOptions?: CommandRuntimeOptions): void {
  registerCliCommand(parent, channelLeaveCommand, runtimeOptions);
}
