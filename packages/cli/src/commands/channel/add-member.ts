// `raft channel add-member --target <#channel> (--user <@handle> | --agent <@handle>)`
// -> POST /internal/agent/:id/channels/:channelId/members

import type { Command } from "commander";

import { createAgentApiSurfaceClient } from "../../agentApiPath.js";
import { defineCommand, registerCliCommand } from "../../core/command.js";
import type { CommandRuntimeOptions } from "../../core/context.js";
import { CliError } from "../../core/errors.js";
import { adoptCliReplyText, writeText, NL } from "../../core/renderer.js";
import { parseRegularChannelTarget } from "./leave.js";

interface AddMemberOpts {
  target?: string;
  user?: string;
  agent?: string;
}

interface AddMemberResponse {
  alreadyMember?: boolean;
  member?: {
    type?: string;
    name?: string;
  };
}

function normalizeHandle(raw: string | undefined): string {
  return (raw ?? "").trim().replace(/^@/, "");
}

export function formatAddMemberResult(target: string, memberType: "user" | "agent", memberName: string, alreadyMember: boolean): string {
  const member = `@${memberName}`;
  if (alreadyMember) {
    return `${member} is already in ${target}.`;
  }
  return `Added ${member} to ${target} as ${memberType === "agent" ? "an agent" : "a user"}.`;
}

export const channelAddMemberCommand = defineCommand(
  {
    name: "add-member",
    description: "Add a human or agent to a regular channel when this agent has server admin authority",
    options: [
      {
        flags: "--target <target>",
        description: "Regular channel to add a member to, e.g. '#engineering'",
      },
      {
        flags: "--user <handle>",
        description: "Human handle to add, e.g. '@alice'",
      },
      {
        flags: "--agent <handle>",
        description: "Agent handle to add, e.g. '@assistant'",
      },
    ],
  },
  async (ctx, opts: AddMemberOpts) => {
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
    const addRes = await client.request<AddMemberResponse>(
      "POST",
      `/internal/agent/${encodeURIComponent(agentContext.agentId)}/channels/${encodeURIComponent(channel.id)}/members`,
      body,
    );
    if (!addRes.ok) {
      throw new CliError({
        code: addRes.status >= 500 ? "SERVER_5XX" : "MEMBERS_FAILED",
        message: addRes.error ?? `HTTP ${addRes.status}`,
      });
    }

    const memberName = addRes.data?.member?.name ?? (user || agent);
    const memberType = addRes.data?.member?.type === "agent" ? "agent" : "user";
    writeText(ctx.io, adoptCliReplyText(formatAddMemberResult(target, memberType, memberName, addRes.data?.alreadyMember === true)), NL);
  },
);

export function registerChannelAddMemberCommand(parent: Command, runtimeOptions?: CommandRuntimeOptions): void {
  registerCliCommand(parent, channelAddMemberCommand, runtimeOptions);
}
