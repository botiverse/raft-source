// `raft user info <@name>` — narrow visible profile and channel-membership facts.

import type { Command } from "commander";

import { createAgentApiSurfaceClient } from "../../agentApiPath.js";
import { defineCommand, registerCliCommand } from "../../core/command.js";
import type { CommandRuntimeOptions } from "../../core/context.js";
import { CliError } from "../../core/errors.js";
import { writeText } from "../../core/renderer.js";
import { formatUserInfo } from "../server/_format.js";

interface UserInfoOpts {
  limit?: string;
  offset?: string;
}

function parseNonNegativeInt(raw: string | undefined, name: string, fallback: number): number {
  if (raw === undefined) return fallback;
  if (!/^\d+$/.test(raw)) {
    throw new CliError({
      code: "INVALID_ARG",
      message: `${name} must be a non-negative integer`,
    });
  }
  return Number(raw);
}

function parsePositiveInt(raw: string | undefined, name: string, fallback: number): number {
  const value = parseNonNegativeInt(raw, name, fallback);
  if (value <= 0) {
    throw new CliError({
      code: "INVALID_ARG",
      message: `${name} must be greater than 0`,
    });
  }
  return value;
}

function normalizeUserName(target: string | undefined): string {
  const trimmed = target?.trim() ?? "";
  const name = trimmed.startsWith("@") ? trimmed.slice(1) : trimmed;
  if (!name) {
    throw new CliError({
      code: "INVALID_ARG",
      message: "user name is required",
    });
  }
  return name;
}

export const userInfoCommand = defineCommand(
  {
    name: "info",
    description: "Show narrow visible facts for a human or agent and its visible channel memberships",
    arguments: ["<name>"],
    options: [
      { flags: "--limit <n>", description: "Maximum visible channels to inspect (default: 50)" },
      { flags: "--offset <n>", description: "Visible channels to skip before inspection (default: 0)" },
    ],
  },
  async (ctx, target: string | undefined, opts: UserInfoOpts = {}) => {
    const name = normalizeUserName(target);
    const limit = parsePositiveInt(opts.limit, "--limit", 50);
    const offset = parseNonNegativeInt(opts.offset, "--offset", 0);

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

    const agent = (infoRes.data?.agents ?? []).find((candidate) => candidate.name === name);
    const human = (infoRes.data?.humans ?? []).find((candidate) => candidate.name === name);
    const user = agent
      ? { kind: "agent" as const, value: agent }
      : human
        ? { kind: "human" as const, value: human }
        : null;
    if (!user) {
      throw new CliError({
        code: "NOT_FOUND",
        message: `User not found or not visible: @${name}`,
        suggestedNextAction: "Run `raft server info --agents --query <name>` or `raft server info --humans --query <name>` to inspect visible users.",
      });
    }

    const visibleChannels = infoRes.data?.channels ?? [];
    const inspectedChannels = visibleChannels.slice(offset, offset + limit);
    const memberships = [];
    let skippedChannels = 0;
    for (const channel of inspectedChannels) {
      const membersRes = await agentApi.channels.members({ channel: `#${channel.name}` });
      if (!membersRes.ok) {
        skippedChannels += 1;
        continue;
      }
      const agents = membersRes.data?.agents ?? [];
      const humans = membersRes.data?.humans ?? [];
      const found = user.kind === "agent"
        ? agents.some((candidate) => candidate.name === name)
        : humans.some((candidate) => candidate.name === name);
      if (found) {
        // server.info channel attention flags belong to the caller; only the
        // roster result above is authoritative for the inspected subject.
        memberships.push({
          ...channel,
          joined: true,
          muted: undefined,
          activityMuted: undefined,
        });
      }
    }

    writeText(ctx.io, formatUserInfo(user, memberships, {
      total: visibleChannels.length,
      offset,
      limit,
      nextCommand: offset + limit < visibleChannels.length
        ? `raft user info @${name} --offset ${offset + limit} --limit ${limit}`
        : undefined,
    }, skippedChannels));
  },
);

export function registerUserInfoCommand(parent: Command, runtimeOptions?: CommandRuntimeOptions): void {
  registerCliCommand(parent, userInfoCommand, runtimeOptions);
}
