// `raft server update [--name <name>] [--avatar-file <path>] [--json]`
// -> PATCH /internal/agent/:id/server and/or POST /internal/agent/:id/server/avatar

import type { Command } from "commander";

import { createAgentApiSurfaceClient } from "../../agentApiPath.js";
import { defineCommand, registerCliCommand } from "../../core/command.js";
import type { CommandRuntimeOptions } from "../../core/context.js";
import { CliError } from "../../core/errors.js";
import { writeJson, writeText, adoptCliReplyText } from "../../core/renderer.js";
import { readAvatarFile } from "../profile/update.js";

interface ServerUpdateOpts {
  name?: string;
  avatarFile?: string;
  json?: boolean;
}

interface ServerProfile {
  id?: string;
  name?: string;
}

export function formatServerUpdateResult(server: ServerProfile): string {
  return `Updated server ${server.name ?? server.id ?? "profile"}.`;
}

export const serverUpdateCommand = defineCommand(
  {
    name: "update",
    description: "Update the current server profile when this agent has server admin authority",
    options: [
      {
        flags: "--name <name>",
        description: "Set the server name",
      },
      {
        flags: "--avatar-file <path>",
        description: "Path to a local image file to use as the server avatar",
      },
      {
        flags: "--json",
        description: "Emit machine-readable JSON",
      },
    ],
  },
  async (ctx, opts: ServerUpdateOpts) => {
    const hasName = opts.name !== undefined;
    const hasAvatar = opts.avatarFile !== undefined;
    if (!hasName && !hasAvatar) {
      throw new CliError({
        code: "INVALID_ARG",
        message: "Provide at least one of --name or --avatar-file.",
      });
    }

    let trimmedName: string | undefined;
    if (hasName) {
      trimmedName = opts.name!.trim();
      if (!trimmedName) {
        throw new CliError({
          code: "INVALID_ARG",
          message: "--name must not be empty",
        });
      }
      if (trimmedName.length > 100) {
        throw new CliError({
          code: "INVALID_ARG",
          message: "--name must be 100 characters or fewer",
        });
      }
    }
    const avatar = hasAvatar ? readAvatarFile(opts.avatarFile!) : null;

    const agentContext = ctx.loadAgentContext();
    const client = ctx.createApiClient(agentContext);
    let latestServer: ServerProfile | null = null;

    if (hasName) {
      const res = await createAgentApiSurfaceClient(client).server.update({ name: trimmedName });
      if (!res.ok || !res.data) {
        throw new CliError({
          code: res.status >= 500 ? "SERVER_5XX" : "UPDATE_FAILED",
          message: res.error ?? `HTTP ${res.status}`,
        });
      }
      latestServer = res.data;
    }

    if (hasAvatar) {
      const form = new FormData();
      const avatarBytes = Uint8Array.from(avatar!.buffer);
      form.append("avatar", new Blob([avatarBytes], { type: avatar!.mimeType }), avatar!.filename);
      const res = await client.requestMultipart<ServerProfile>(
        "POST",
        `/internal/agent/${encodeURIComponent(agentContext.agentId)}/server/avatar`,
        form,
      );
      if (!res.ok || !res.data) {
        throw new CliError({
          code: res.status >= 500 ? "SERVER_5XX" : "UPDATE_FAILED",
          message: res.error ?? `HTTP ${res.status}`,
        });
      }
      latestServer = res.data;
    }

    if (!latestServer) {
      throw new CliError({
        code: "UPDATE_FAILED",
        message: "No server profile returned from server",
      });
    }

    if (opts.json) {
      writeJson(ctx.io, { ok: true, data: latestServer });
      return;
    }
    writeText(ctx.io, adoptCliReplyText(formatServerUpdateResult(latestServer) + "\n"));
  },
);

export function registerServerUpdateCommand(parent: Command, runtimeOptions?: CommandRuntimeOptions): void {
  registerCliCommand(parent, serverUpdateCommand, runtimeOptions);
}
