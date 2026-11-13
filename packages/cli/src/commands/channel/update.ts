// `raft channel update --target <#channel> [--name <name>] [--description <text>] [--public|--private]
//   [--announcement <artifact> | --no-announcement]`
// -> PATCH /internal/agent-api/channels/:channelId

import type { Command } from "commander";
import {
  CHANNEL_ANNOUNCEMENT_REF_INVALID,
  channelAnnouncementArtifactId,
  formatAgentChannelUpdated,
} from "@botiverse/raft-shared/src/agentCliSurface";

import { createAgentApiSurfaceClient } from "../../agentApiPath";
import { defineCommand, registerCliCommand } from "../../core/command";
import type { CommandRuntimeOptions } from "../../core/context";
import { CliError } from "../../core/errors";
import { writeText, adoptCliReplyText } from "../../core/renderer";
import { parseRegularChannelTarget } from "./leave";

interface UpdateChannelOpts {
  target?: string;
  name?: string;
  description?: string;
  public?: boolean;
  private?: boolean;
  /** `--announcement <artifact>`: a string; `--no-announcement`: false. */
  announcement?: string | false;
}

interface UpdatedChannel {
  id: string;
  name: string;
  type?: string;
}

/** Said when --announcement names a DM or a thread, which have none. */
export const CHANNEL_ANNOUNCEMENT_TARGET_INVALID = "Only a channel ('#channel-name') has an announcement; a DM or a thread has none.";

function normalizeChannelName(raw: string | undefined): string {
  return (raw ?? "").trim().replace(/^#/, "");
}

export function formatUpdateChannelResult(channel: UpdatedChannel): string {
  const visibility = channel.type === "private" ? "private" : "public";
  return `Updated #${channel.name} (${visibility}).`;
}

export const channelUpdateCommand = defineCommand(
  {
    name: "update",
    description: "Edit a public, private, or joint channel when this agent has server admin or channel admin authority (a joint channel's name and description change for every connected server; its visibility cannot change)",
    options: [
      {
        flags: "--target <target>",
        description: "Channel to edit, e.g. '#engineering'",
      },
      {
        flags: "--name <name>",
        description: "New channel name, with or without a leading '#'",
      },
      {
        flags: "--description <description>",
        description: "New channel description",
      },
      {
        flags: "--public",
        description: "Make the channel public (you must be a member; not usable on #all)",
      },
      {
        flags: "--private",
        description: "Make the channel private (you must be a member; not usable on #all)",
      },
      {
        flags: "--announcement <artifact>",
        description: "Make an Artifact homed in this channel (its id pt_… or link) the channel's announcement, replacing any other: for standing rules and link round-ups members should read before working there (the channel's owner or a server owner/admin only)",
      },
      {
        flags: "--no-announcement",
        description: "Remove the channel's announcement (the Artifact itself stays)",
      },
    ],
  },
  async (ctx, opts: UpdateChannelOpts) => {
    const target = opts.target ?? "";
    const channelName = parseRegularChannelTarget(target);
    if (!channelName) {
      if (opts.announcement !== undefined) {
        throw new CliError({
          code: "INVALID_TARGET",
          message: CHANNEL_ANNOUNCEMENT_TARGET_INVALID,
          suggestedNextAction: "Post it as a message in that conversation instead, or pass the channel it belongs to: --target '#channel-name'.",
        });
      }
      throw new CliError({
        code: "INVALID_TARGET",
        message: "Target must be a channel in the form '#channel-name'. DMs and thread targets are not supported.",
      });
    }
    if (opts.public && opts.private) {
      throw new CliError({
        code: "INVALID_ARG",
        message: "Use either --public or --private, not both.",
      });
    }

    const body: { name?: string; description?: string; visibility?: "public" | "private"; announcement?: string | null } = {};
    if (opts.name !== undefined) body.name = normalizeChannelName(opts.name);
    if (opts.description !== undefined) body.description = opts.description;
    if (opts.public) body.visibility = "public";
    if (opts.private) body.visibility = "private";
    if (opts.announcement === false) body.announcement = null;
    else if (opts.announcement !== undefined) {
      const artifactId = channelAnnouncementArtifactId(opts.announcement);
      if (!artifactId) {
        throw new CliError({
          code: "INVALID_ARG",
          message: CHANNEL_ANNOUNCEMENT_REF_INVALID,
          suggestedNextAction: `Find its id with: raft artifact list --target "#${channelName}"`,
        });
      }
      body.announcement = artifactId;
    }
    if (body.name === undefined && body.description === undefined && body.visibility === undefined && body.announcement === undefined) {
      throw new CliError({
        code: "INVALID_ARG",
        message: "Provide at least one of --name, --description, --public, --private, --announcement, or --no-announcement.",
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

    const updateRes = await createAgentApiSurfaceClient(client).channels.update({ channelId: channel.id as never }, body);
    if (!updateRes.ok || !updateRes.data) {
      throw new CliError({
        code: updateRes.status >= 500 ? "SERVER_5XX" : "UPDATE_FAILED",
        message: updateRes.error ?? `HTTP ${updateRes.status}`,
        ...(updateRes.suggestedNextAction ? { suggestedNextAction: updateRes.suggestedNextAction } : {}),
      });
    }

    writeText(ctx.io, adoptCliReplyText(formatAgentChannelUpdated(updateRes.data, { channelAnnouncementChanged: body.announcement !== undefined }) + "\n"));
  },
);

export function registerChannelUpdateCommand(parent: Command, runtimeOptions?: CommandRuntimeOptions): void {
  registerCliCommand(parent, channelUpdateCommand, runtimeOptions);
}
