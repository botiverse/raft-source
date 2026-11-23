// `raft channel set-role --target <#channel> (--user <@handle> | --agent <@handle>) --role admin|member`
// -> POST /internal/agent-api/channels/member-role

import { formatChannelMemberRoleRefusal, formatChannelMemberRoleSet } from "@botiverse/raft-shared/src/agentCliSurface";
import type { Command } from "commander";

import { createAgentApiSurfaceClient } from "../../agentApiPath";
import { defineCommand, registerCliCommand } from "../../core/command";
import type { CommandRuntimeOptions } from "../../core/context";
import { CliError, cliError } from "../../core/errors";
import { adoptCliReplyText, writeText, NL } from "../../core/renderer";
import { parseRegularChannelTarget } from "./leave";

interface SetRoleOpts {
  target?: string;
  user?: string;
  agent?: string;
  role?: string;
}

function normalizeHandle(raw: string | undefined): string {
  return (raw ?? "").trim().replace(/^@/, "");
}

export const channelSetRoleCommand = defineCommand(
  {
    name: "set-role",
    description: "Make a channel member a channel admin, or a channel admin a plain member, as a channel admin there or with the admin role on this server; on a joint channel only its host server's owners and admins (not your own role, a server owner's or admin's, and a guest never becomes channel admin)",
    options: [
      {
        flags: "--target <target>",
        description: "Channel, e.g. '#engineering'",
      },
      {
        flags: "--user <handle>",
        description: "Human member, e.g. '@alice'",
      },
      {
        flags: "--agent <handle>",
        description: "Agent member, e.g. '@assistant'",
      },
      {
        flags: "--role <role>",
        description: "'admin' (channel admin) or 'member' (plain member)",
      },
    ],
  },
  async (ctx, opts: SetRoleOpts) => {
    const target = opts.target ?? "";
    const channelName = parseRegularChannelTarget(target);
    if (!channelName) {
      throw new CliError({
        code: "INVALID_TARGET",
        message: "Target must be a channel in the form '#channel-name'. DMs and thread targets are not supported.",
        suggestedNextAction: 'Run: raft channel set-role --target "#channel-name" --user @alice --role admin',
      });
    }
    const channelRef = `#${channelName}`;

    const user = normalizeHandle(opts.user);
    const agent = normalizeHandle(opts.agent);
    if ((user ? 1 : 0) + (agent ? 1 : 0) !== 1) {
      throw new CliError({
        code: "INVALID_ARG",
        message: "Provide exactly one of --user or --agent.",
        suggestedNextAction: `Find the member's handle with: raft channel members "${channelRef}"`,
      });
    }
    const role = (opts.role ?? "").trim().toLowerCase();
    if (role !== "admin" && role !== "member") {
      throw new CliError({
        code: "INVALID_ARG",
        message: "--role must be 'admin' or 'member'.",
        suggestedNextAction: `Run: raft channel set-role --target "${channelRef}" ${user ? `--user @${user}` : `--agent @${agent}`} --role admin`,
      });
    }

    const agentContext = ctx.loadAgentContext();
    const client = ctx.createApiClient(agentContext);
    const res = await createAgentApiSurfaceClient(client).channels.setMemberRole({
      target: channelRef,
      ...(user ? { user } : { agent }),
      role,
    });
    if (!res.ok || !res.data) {
      // The Server's code and sentence, made specific where only the CLI knows the flags.
      const refusal = formatChannelMemberRoleRefusal({
        target: channelRef,
        member: user ? { kind: "user", name: user } : { kind: "agent", name: agent },
        code: res.status >= 500 ? undefined : res.errorCode ?? undefined,
        serverMessage: res.error ?? `HTTP ${res.status}`,
        serverStep: res.suggestedNextAction ?? `Check the channel's members with: raft channel members "${channelRef}"`,
      });
      throw cliError(
        res.status >= 500 ? "SERVER_5XX" : res.errorCode ?? "SET_ROLE_FAILED",
        refusal.message,
        { suggestedNextAction: refusal.nextAction },
      );
    }

    const memberName = res.data.member?.name ?? (user || agent);
    writeText(ctx.io, adoptCliReplyText(formatChannelMemberRoleSet(channelRef, memberName, res.data.channelRole, res.data.changed)), NL);
  },
);

export function registerChannelSetRoleCommand(parent: Command, runtimeOptions?: CommandRuntimeOptions): void {
  registerCliCommand(parent, channelSetRoleCommand, runtimeOptions);
}
