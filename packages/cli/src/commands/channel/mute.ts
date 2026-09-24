// `raft channel mute --target <#channel>` / `raft channel unmute --target <#channel>`
// → POST /internal/agent-api/channels/:channelId/mute|unmute

import type { Command } from "commander";
import type { AgentApiResponseByRoute } from "@botiverse/raft-shared";

import { createAgentApiSurfaceClient } from "../../agentApiPath.js";
import { defineCommand, registerCliCommand } from "../../core/command.js";
import type { CommandRuntimeOptions } from "../../core/context.js";
import { CliError } from "../../core/errors.js";
import { writeText, adoptCliReplyText } from "../../core/renderer.js";
import { parseRegularChannelTarget } from "./leave.js";

type ChannelMuteAction = "mute" | "unmute";
type AgentChannelMuteResponse = AgentApiResponseByRoute["channelMute"];

interface ChannelMuteOpts {
  target?: string;
}

function formatSeq(value: number | null | undefined): string {
  return value == null ? "none" : String(value);
}

export function formatChannelMuteResult(target: string, result: AgentChannelMuteResponse): string {
  const lines = [
    `${result.activityMuted ? "Muted" : "Unmuted"} ${target}.`,
    `Activity muted: ${result.activityMuted ? "yes" : "no"}`,
    `Mute from seq: ${formatSeq(result.muteFromSeq)}`,
  ];

  if (result.attention?.ordinaryActivity) lines.push(result.attention.ordinaryActivity);
  if (result.attention?.stillArrives?.length) {
    lines.push("Still arrives:");
    for (const item of result.attention.stillArrives) lines.push(`- ${item}`);
  }
  if (result.attention?.threadBoundary) lines.push(result.attention.threadBoundary);
  if (result.attention?.catchUp) lines.push(result.attention.catchUp);
  if (result.attention?.unmuteCommand) lines.push(`To unmute: ${result.attention.unmuteCommand}`);
  if (result.attention?.unmuteApi) lines.push(`Agent API: ${result.attention.unmuteApi}`);
  if (result.attention?.muteCommand) lines.push(`To mute: ${result.attention.muteCommand}`);
  if (result.attention?.muteApi) lines.push(`Agent API: ${result.attention.muteApi}`);

  return lines.join("\n");
}

function makeChannelMuteCommand(action: ChannelMuteAction) {
  return defineCommand(
    {
      name: action,
      description: action === "mute"
        ? "Mute ordinary Activity delivery for a regular channel"
        : "Unmute ordinary Activity delivery for a regular channel",
      arguments: ["[target]"],
      options: [
        {
          flags: "--target <target>",
          description: `Regular channel to ${action}, e.g. '#engineering'`,
        },
      ],
    },
    async (ctx, targetArg: string | undefined, opts: ChannelMuteOpts = {}) => {
      const positionalTarget = targetArg?.trim();
      const flagTarget = opts.target?.trim();
      if (positionalTarget && flagTarget && positionalTarget !== flagTarget) {
        throw new CliError({
          code: "INVALID_ARG",
          message: "Positional target and --target must refer to the same channel when both are provided",
        });
      }
      const target = flagTarget || positionalTarget || "";
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

      const res = action === "mute"
        ? await agentApi.channels.mute({ channelId: channel.id })
        : await agentApi.channels.unmute({ channelId: channel.id });
      if (!res.ok) {
        throw new CliError({
          code: res.status >= 500 ? "SERVER_5XX" : action === "mute" ? "MUTE_FAILED" : "UNMUTE_FAILED",
          message: res.error ?? `HTTP ${res.status}`,
          suggestedNextAction: res.suggestedNextAction ?? undefined,
        });
      }

      writeText(ctx.io, adoptCliReplyText(formatChannelMuteResult(target, res.data ?? {}) + "\n"));
    },
  );
}

export const channelMuteCommand = makeChannelMuteCommand("mute");
export const channelUnmuteCommand = makeChannelMuteCommand("unmute");

export function registerChannelMuteCommand(parent: Command, runtimeOptions?: CommandRuntimeOptions): void {
  registerCliCommand(parent, channelMuteCommand, runtimeOptions);
}

export function registerChannelUnmuteCommand(parent: Command, runtimeOptions?: CommandRuntimeOptions): void {
  registerCliCommand(parent, channelUnmuteCommand, runtimeOptions);
}
