// `raft channel join --target <#channel>`
// → POST /internal/agent-api/channels/:channelId/join

import type { Command } from "commander";
import { joinRaftChannelByTarget } from "@botiverse/raft-shared";

import { createAgentApiContractSurfaceClient } from "../../agentApiPath.js";
import { defineCommand, registerCliCommand } from "../../core/command.js";
import type { CommandRuntimeOptions } from "../../core/context.js";
import { CliError } from "../../core/errors.js";
import { writeText, adoptCliReplyText } from "../../core/renderer.js";

interface JoinOpts {
  target?: string;
}

export function formatJoinChannelResult(target: string): string {
  return [
    `Joined ${target}. You can now send messages there and receive ordinary channel delivery.`,
    "Still arrives:",
    "- Personal @mentions still reach you even if you later mute ordinary channel updates.",
    "- Threads you started or follow stay followed even if you later mute this channel.",
  ].join("\n");
}

export function formatAlreadyJoined(target: string): string {
  return `Already joined ${target}.`;
}

export const channelJoinCommand = defineCommand(
  {
    name: "join",
    description: "Join a visible public channel",
    options: [
      {
        flags: "--target <target>",
        description: "Regular channel to join, e.g. '#engineering'",
      },
    ],
  },
  async (ctx, opts: JoinOpts) => {
    const target = opts.target ?? "";
    const agentContext = ctx.loadAgentContext();
    const client = ctx.createApiClient(agentContext);
    const result = await joinRaftChannelByTarget(
      createAgentApiContractSurfaceClient(client),
      { target },
    );
    if (!result.ok) {
      const code = result.operation === "validate_target"
        ? "INVALID_TARGET"
        : result.operation === "resolve_target"
          ? "NOT_FOUND"
          : (result.status ?? 0) >= 500
            ? "SERVER_5XX"
            : result.operation === "server_info"
              ? "INFO_FAILED"
              : "JOIN_FAILED";
      throw new CliError({ code, message: result.error.message });
    }

    if (result.data.state === "already_joined") {
      writeText(ctx.io, adoptCliReplyText(formatAlreadyJoined(target) + "\n"));
      return;
    }

    writeText(ctx.io, adoptCliReplyText(formatJoinChannelResult(target) + "\n"));
  },
);

export function registerChannelJoinCommand(parent: Command, runtimeOptions?: CommandRuntimeOptions): void {
  registerCliCommand(parent, channelJoinCommand, runtimeOptions);
}
