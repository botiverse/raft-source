// `raft channel remove-member --target <#channel> (--user <@handle> | --agent <@handle>)`
// -> DELETE /internal/agent-api/channels/:channelId/members

import type { Command } from "commander";

import { formatChannelDeletedWithLastMember, formatLastMemberRefusal, LAST_MEMBER_DELETES_CHANNEL } from "@botiverse/raft-shared/src/agentCliSurface";

import { createAgentApiSurfaceClient } from "../../agentApiPath";
import { defineCommand, registerCliCommand } from "../../core/command";
import type { CommandRuntimeOptions } from "../../core/context";
import { CliError } from "../../core/errors";
import { adoptCliReplyText, writeText, NL } from "../../core/renderer";
import { parseRegularChannelTarget } from "./leave";

interface RemoveMemberOpts {
  target?: string;
  user?: string;
  agent?: string;
  deleteIfLast?: boolean;
}

interface RemoveMemberResponse {
  wasMember?: boolean;
  channelDeleted?: boolean;
  member?: {
    type?: string;
    name?: string;
  };
  attention?: {
    ordinaryActivity?: string;
    stillArrives?: string[];
    threadBoundary?: string;
    manageCommand?: string;
    manageApi?: string;
  };
}

function normalizeHandle(raw: string | undefined): string {
  return (raw ?? "").trim().replace(/^@/, "");
}

export function formatRemoveMemberResult(target: string, memberName: string, wasMember: boolean, result?: RemoveMemberResponse): string {
  const member = `@${memberName}`;
  if (!wasMember) return `${member} was not in ${target}.`;
  if (result?.channelDeleted) return formatChannelDeletedWithLastMember(target, member);

  const lines = [`Removed ${member} from ${target}.`];
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

export const channelRemoveMemberCommand = defineCommand(
  {
    name: "remove-member",
    description: "Remove a human or agent of this server from a public, private, or joint channel when this agent has server admin authority",
    options: [
      {
        flags: "--target <target>",
        description: "Channel to remove a member from, e.g. '#engineering'",
      },
      {
        flags: "--user <handle>",
        description: "Human handle to remove, e.g. '@alice'",
      },
      {
        flags: "--agent <handle>",
        description: "Agent handle to remove, e.g. '@assistant'",
      },
      {
        flags: "--delete-if-last",
        description: "If they are a private channel's last member, remove them anyway: that deletes the channel and all its messages, which can't be undone (without it, that removal is refused)",
      },
    ],
  },
  async (ctx, opts: RemoveMemberOpts) => {
    const target = opts.target ?? "";
    const channelName = parseRegularChannelTarget(target);
    if (!channelName) {
      throw new CliError({
        code: "INVALID_TARGET",
        message: "Target must be a channel in the form '#channel-name'. DMs and thread targets are not supported.",
      });
    }

    const user = normalizeHandle(opts.user);
    const agent = normalizeHandle(opts.agent);
    if ((user ? 1 : 0) + (agent ? 1 : 0) !== 1) {
      throw new CliError({
        code: "INVALID_ARG",
        message: "Provide exactly one of --user or --agent.",
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

    const body = user ? { user } : { agent };
    const removeRes = await createAgentApiSurfaceClient(client).channels.removeMember({ channelId: channel.id as never }, opts.deleteIfLast ? { ...body, deleteIfLast: true } : body);
    if (!removeRes.ok) {
      if (removeRes.errorCode === LAST_MEMBER_DELETES_CHANNEL) {
        const { message, nextAction } = formatLastMemberRefusal({ target, member: user ? { user: `@${user}` } : { agent: `@${agent}` } });
        throw new CliError({ code: "LAST_MEMBER", message, suggestedNextAction: nextAction });
      }
      throw new CliError({
        code: removeRes.status >= 500 ? "SERVER_5XX" : "MEMBERS_FAILED",
        message: removeRes.error ?? `HTTP ${removeRes.status}`,
      });
    }

    const memberName = removeRes.data?.member?.name ?? (user || agent);
    writeText(ctx.io, adoptCliReplyText(formatRemoveMemberResult(target, memberName, removeRes.data?.wasMember === true, removeRes.data ?? undefined)), NL);
  },
);

export function registerChannelRemoveMemberCommand(parent: Command, runtimeOptions?: CommandRuntimeOptions): void {
  registerCliCommand(parent, channelRemoveMemberCommand, runtimeOptions);
}
