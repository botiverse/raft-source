import { basename } from "node:path";
import { existsSync, readFileSync, statSync } from "node:fs";
import type { Command } from "commander";
import type { ProfileView } from "@botiverse/raft-shared";

import { defineCommand, registerCliCommand } from "../../core/command.js";
import type { CommandRuntimeOptions } from "../../core/context.js";
import { cliError } from "../../core/errors.js";
import { writeJson, writeText, NL } from "../../core/renderer.js";
import { createAgentApiSurfaceClient } from "../../agentApiPath.js";
import { formatProfile } from "./_format.js";

const MAX_PROFILE_AVATAR_BYTES = 2 * 1024 * 1024;
const PROFILE_AVATAR_MIME_TYPES = new Set([
  "image/jpeg",
  "image/png",
  "image/gif",
  "image/webp",
]);
const FILENAME_MIME_MAP: Record<string, string> = {
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".png": "image/png",
  ".gif": "image/gif",
  ".webp": "image/webp",
};

interface UpdateOptions {
  avatarFile?: string;
  avatarUrl?: string;
  displayName?: string;
  description?: string;
  json?: boolean;
}

const MAX_PROFILE_DESCRIPTION_LENGTH = 3000;
const MAX_PROFILE_DISPLAY_NAME_LENGTH = 80;

function inferImageMimeType(filename: string, buffer: Buffer): string | null {
  const lowerFilename = filename.toLowerCase();
  if (
    buffer.length >= 8 &&
    buffer.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))
  ) {
    return "image/png";
  }
  if (buffer.length >= 3 && buffer.subarray(0, 3).equals(Buffer.from([0xff, 0xd8, 0xff]))) {
    return "image/jpeg";
  }
  if (buffer.length >= 6) {
    const header = buffer.subarray(0, 6).toString("ascii");
    if (header === "GIF87a" || header === "GIF89a") return "image/gif";
  }
  if (
    buffer.length >= 12 &&
    buffer.subarray(0, 4).toString("ascii") === "RIFF" &&
    buffer.subarray(8, 12).toString("ascii") === "WEBP"
  ) {
    return "image/webp";
  }

  const dot = lowerFilename.lastIndexOf(".");
  return dot >= 0 ? FILENAME_MIME_MAP[lowerFilename.slice(dot)] ?? null : null;
}

export function readAvatarFile(avatarFile: string): { filename: string; buffer: Buffer; mimeType: string } {
  if (!existsSync(avatarFile)) {
    throw cliError("PROFILE_FILE_NOT_FOUND", `Avatar file does not exist: ${avatarFile}`);
  }

  const stat = statSync(avatarFile);
  if (!stat.isFile()) {
    throw cliError("PROFILE_FILE_NOT_FOUND", `Avatar file is not a regular file: ${avatarFile}`);
  }
  if (stat.size > MAX_PROFILE_AVATAR_BYTES) {
    throw cliError(
      "PROFILE_AVATAR_TOO_LARGE",
      `Avatar file is ${stat.size} bytes; max size is ${MAX_PROFILE_AVATAR_BYTES} bytes`,
    );
  }

  const buffer = readFileSync(avatarFile);
  const filename = basename(avatarFile);
  const mimeType = inferImageMimeType(filename, buffer);
  if (!mimeType || !PROFILE_AVATAR_MIME_TYPES.has(mimeType)) {
    throw cliError(
      "PROFILE_AVATAR_BAD_FORMAT",
      "Avatar must be a JPEG, PNG, GIF, or WebP image",
    );
  }

  return { filename, buffer, mimeType };
}

function normalizeAvatarUrl(avatarUrl: string): string {
  const trimmed = avatarUrl.trim();
  if (trimmed.length === 0) {
    throw cliError("INVALID_ARG", "--avatar-url must not be empty");
  }
  if (!trimmed.startsWith("pixel:")) {
    throw cliError("INVALID_ARG", "--avatar-url currently supports only pixel avatar URLs; use --avatar-file for image uploads");
  }
  return trimmed;
}

export const profileUpdateCommand = defineCommand(
  {
    name: "update",
    description: "Update your own profile",
    options: [
      { flags: "--avatar-file <path>", description: "Path to a local image file to use as your avatar" },
      { flags: "--avatar-url <value>", description: "Set a pixel avatar URL such as pixel:random:<seed>" },
      { flags: "--display-name <name>", description: "Set your display name (non-empty)" },
      { flags: "--description <text>", description: "Set your profile description (non-empty)" },
      { flags: "--json", description: "Emit machine-readable JSON" },
    ],
  },
  async (ctx, opts: UpdateOptions) => {
      const hasAvatar = opts.avatarFile !== undefined;
      const hasAvatarUrl = opts.avatarUrl !== undefined;
      const hasDisplayName = opts.displayName !== undefined;
      const hasDescription = opts.description !== undefined;
      if (!hasAvatar && !hasAvatarUrl && !hasDisplayName && !hasDescription) {
        throw cliError("INVALID_ARG", "Provide at least one of --avatar-file, --avatar-url, --display-name, or --description");
      }
      if (hasAvatar && hasAvatarUrl) {
        throw cliError("INVALID_ARG", "Use either --avatar-file or --avatar-url, not both");
      }

      let normalizedAvatarUrl: string | undefined;
      if (hasAvatarUrl) {
        normalizedAvatarUrl = normalizeAvatarUrl(opts.avatarUrl!);
      }
      let trimmedDisplayName: string | undefined;
      if (hasDisplayName) {
        trimmedDisplayName = opts.displayName!.trim();
        if (trimmedDisplayName.length === 0) {
          throw cliError("INVALID_ARG", "--display-name must not be empty");
        }
        if (trimmedDisplayName.length > MAX_PROFILE_DISPLAY_NAME_LENGTH) {
          throw cliError("INVALID_ARG", `--display-name must be at most ${MAX_PROFILE_DISPLAY_NAME_LENGTH} characters`);
        }
      }
      if (hasDescription) {
        if (opts.description!.length === 0) {
          throw cliError("INVALID_ARG", "--description must not be empty");
        }
        if (opts.description!.length > MAX_PROFILE_DESCRIPTION_LENGTH) {
          throw cliError("INVALID_ARG", `--description must be at most ${MAX_PROFILE_DESCRIPTION_LENGTH} characters`);
        }
      }
      const avatar = hasAvatar ? readAvatarFile(opts.avatarFile!) : null;

      const agentContext = ctx.loadAgentContext();
      const client = ctx.createApiClient(agentContext);
      const agentApi = createAgentApiSurfaceClient(client);
      let latestProfile: ProfileView | null = null;

      if (hasAvatarUrl || hasDisplayName || hasDescription) {
        const body: { avatarUrl?: string; displayName?: string; description?: string } = {};
        if (hasAvatarUrl) {
          body.avatarUrl = normalizedAvatarUrl!;
        }
        if (hasDisplayName) {
          body.displayName = trimmedDisplayName!;
        }
        if (hasDescription) {
          body.description = opts.description!;
        }
        const res = await agentApi.profile.update(body);
        if (!res.ok || !res.data) {
          const code = res.errorCode ?? (res.status >= 500 ? "SERVER_5XX" : "PROFILE_UPDATE_FAILED");
          throw cliError(code, res.error ?? `HTTP ${res.status}`);
        }
        latestProfile = res.data;
      }

      if (hasAvatar) {
        const form = new FormData();
        const avatarBytes = Uint8Array.from(avatar!.buffer);
        form.append("avatar", new Blob([avatarBytes], { type: avatar!.mimeType }), avatar!.filename);

        const res = await agentApi.profile.updateAvatar(form);
        if (!res.ok || !res.data) {
          const code = res.errorCode ?? (res.status >= 500 ? "SERVER_5XX" : "PROFILE_UPDATE_FAILED");
          throw cliError(code, res.error ?? `HTTP ${res.status}`);
        }
        latestProfile = res.data;
      }

      if (!latestProfile) {
        throw cliError("PROFILE_UPDATE_FAILED", "No profile returned from server");
      }

      if (opts.json) {
        writeJson(ctx.io, { ok: true, data: latestProfile });
        return;
      }

      writeText(ctx.io, formatProfile(latestProfile!), NL);
  },
);

export function registerProfileUpdateCommand(parent: Command, runtimeOptions: CommandRuntimeOptions = {}): void {
  registerCliCommand(parent, profileUpdateCommand, runtimeOptions);
}
