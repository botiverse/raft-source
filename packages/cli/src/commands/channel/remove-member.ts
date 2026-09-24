// `raft channel remove-member --target <#channel> (--user <@handle> | --agent <@handle>)`
// -> DELETE /internal/agent/:id/channels/:channelId/members

import type { Command } from "commander";

import { createAgentApiSurfaceClient } from "../../agentApiPath.js";
import { defineCommand, registerCliCommand } from "../../core/command.js";
import type { CommandRuntimeOptions } from "../../core/context.js";
import { CliError } from "../../core/errors.js";
import { adoptCliReplyText, writeText, NL } from "../../core/renderer.js";
import { parseRegularChannelTarget } from "./leave.js";

interface RemoveMemberOpts {
  target?: string;
  user?: string;
  agent?: string;
}

interface RemoveMemberResponse {
  wasMember?: boolean;
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
    description: "Remove a human or agent from a regular channel when this agent has server admin authority",
    options: [
      {
        flags: "--target <target>",
        description: "Regular channel to remove a member from, e.g. '#engineering'",
      },
      {
        flags: "--user <handle>",
        description: "Human handle to remove, e.g. '@alice'",
      },
      {
        flags: "--agent <handle>",
        description: "Agent handle to remove, e.g. '@assistant'",
      },
    ],
  },
  async (ctx, opts: RemoveMemberOpts) => {
    const target = opts.target ?? "";
    const channelName = parseRegularChannelTarget(target);
    if (!channelName) {
      throw new CliError({
        code: "INVALID_TARGET",
        message: "Target must be a regular channel in the form '#channel-name'. DMs and thread targets are not supported.",
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
    const removeRes = await client.request<RemoveMemberResponse>(
      "DELETE",
      `/internal/agent/${encodeURIComponent(agentContext.agentId)}/channels/${encodeURIComponent(channel.id)}/members`,
      body,
    );
    if (!removeRes.ok) {
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
