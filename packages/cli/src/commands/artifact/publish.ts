// `raft artifact push <dir> [--target <conversation>] [--note …] [--delete <path>…]`
// → POST /internal/agent-api/artifacts/push (+ PUT …/uploads/:sha256 for bytes the Server lacks)
//
// A pulled directory pushes a new version on its recorded base, sending only
// the files that changed. A directory without `.raft-artifact.json` creates a
// new artifact, homed in --target. Files missing locally are not deleted unless
// named with --delete. Once the Server has taken the push, the base moves to the new
// version whatever happens next: the directory is then brought in line with it
// (others' merged files fetched or removed, deleted files removed), and a file
// that can't be fetched is reported with how to refresh, never as a failed
// push.
//
// `--announcement` (channel announcements, channel_announcement_v0): a new
// artifact pushed into a channel also becomes that channel's announcement, by
// `raft channel update`'s route right after the push. Before pushing, the
// channel's entry in the server inventory says whether announcements are on
// (it carries `announcement`) and whether this agent may set one
// (editChannelMetadata), so a refused set never leaves an artifact behind for
// nothing; a set the Server still refuses after the push says so, with the
// command that sets it later.

import { existsSync, readFileSync, rmSync, statSync } from "node:fs";

import type { Command } from "commander";
import {
  AGENT_API_ARTIFACT_MAX_BINARY_FILE_BYTES,
  AGENT_API_ARTIFACT_MAX_TEXT_FILE_BYTES,
  artifactFileType,
  artifactPageManualHint,
  artifactsFile,
  artifactsPublish,
  artifactsRead,
  artifactUploadFailure,
  buildAgentApiRawRoutePath,
  formatArtifactError,
} from "@botiverse/raft-shared/src/agentCliSurface";

import { createAgentApiContractSurfaceClient, createAgentApiSurfaceClient } from "../../agentApiPath";
import { commandLineOf } from "../../core/commandLine";
import { defineCommand, registerCliCommand } from "../../core/command";
import type { CommandRuntimeOptions } from "../../core/context";
import { CliError } from "../../core/errors";
import { adoptCliReplyText, writeText } from "../../core/renderer";
import { fileTarget, readDirState, scanDir, sha256Of, writeDirState, writeFileUnder } from "./_dir";
import { formatArtifactNothingToPublish, formatArtifactPublished } from "./_format";
import { artifactCliError, splitArgs } from "./_shared";
import { parseRegularChannelTarget } from "../channel/leave";
import { CHANNEL_ANNOUNCEMENT_TARGET_INVALID } from "../channel/update";

/**
 * A push refused over the agent's rate limit, before or between its file
 * uploads (Sage): nothing is pushed, and the files already uploaded stay
 * (content-addressed: the next run skips them).
 */
const PUBLISH_RATE_LIMITED_LEFT_BEHIND = "Nothing was pushed yet; files already sent are kept and won't be sent again.";

interface PublishOpts {
  dir?: string;
  target?: string;
  title?: string;
  description?: string;
  entry?: string;
  note?: string;
  label?: string;
  delete?: string[];
  includeHidden?: boolean;
  announcement?: boolean;
}

const collect = (value: string, previous: string[] = []): string[] => [...previous, value];

export const artifactPublishCommand = defineCommand(
  {
    name: "push",
    description: "Push a directory as a new version of the artifact pulled into it (only changed files are sent), or as a new artifact homed in --target",
    arguments: ["[dir]"],
    options: [
      { flags: "--dir <dir>", description: "The directory, if not given as the first argument" },
      { flags: "--target <target>", description: "A new artifact's home: the conversation whose members can see it ('#channel', 'dm:@peer')" },
      { flags: "--title <title>", description: "Title (required for a new artifact unless its entry page has a <title>; for a pulled one with no file changed, renames it without a new version)" },
      { flags: "--description <text>", description: "What the artifact is (up to 1000 characters)" },
      { flags: "--entry <file>", description: "The file it opens at (default: the base's; index.html or the only file for a new one)" },
      { flags: "--note <text>", description: "What changed in this version (up to 500 characters)" },
      { flags: "--label <text>", description: "A short name for this version (up to 60 characters)" },
      { flags: "--delete <path>", description: "Remove this file from the artifact and the directory (repeat for each file); files missing locally are kept otherwise", parse: collect },
      { flags: "--include-hidden", description: "Also push new hidden files (.name); they are left out by default" },
      { flags: "--announcement", description: "Also make the new artifact the announcement of the --target channel, replacing any other (the channel's owner or a server owner/admin only)" },
    ],
    helpAfter: "\nAn HTML page can ask Raft to open its comment box with an answer filled in (decision buttons), copy text and open links; what it can call and what the sandbox blocks:\n"
      + `  ${artifactPageManualHint()}\n`,
  },
  async (ctx, ...args: unknown[]) => {
    const { positionals, opts } = splitArgs<PublishOpts>(args, 1);
    const command = args[2] as { args?: unknown[] } | undefined;
    if (Array.isArray(command?.args) && command.args.length > 1) {
      throw new CliError({ code: "INVALID_ARG", message: `push takes one directory; got ${command.args.length} arguments`, suggestedNextAction: "To delete several files, repeat --delete: --delete a.html --delete b.html" });
    }
    if (positionals[0] !== undefined && opts.dir !== undefined && positionals[0] !== opts.dir) {
      throw new CliError({ code: "INVALID_ARG", message: "pass the directory either as the first argument or with --dir, not both" });
    }
    const dir = positionals[0] ?? opts.dir;
    if (!dir) {
      throw new CliError({ code: "INVALID_ARG", message: "which directory? Pass the directory to push", suggestedNextAction: "To work on an existing artifact, pull it first: raft artifact pull <artifact>" });
    }
    if (!existsSync(dir) || !statSync(dir).isDirectory()) {
      throw new CliError({ code: "INVALID_ARG", message: `${dir} is not a directory` });
    }
    const state = readDirState(dir);
    if (state && opts.target !== undefined) {
      throw new CliError({
        code: "ARTIFACT_DIR_CONFLICT",
        message: `${dir} holds ${state.artifact} (pulled at v${state.version}); --target is only for a new artifact.`,
        suggestedNextAction: `To push a new version of ${state.artifact}, drop it. To make a new artifact from these files, copy them (without .raft-artifact.json) into a new directory and push that with --target.`,
      });
    }
    if (!state && !opts.target) {
      const e = formatArtifactError("TARGET_REQUIRED", { dir, publishing: true }, "cli");
      throw new CliError({ code: "TARGET_REQUIRED", message: e.message, suggestedNextAction: e.nextAction });
    }
    if (opts.announcement && state) {
      throw new CliError({
        code: "INVALID_ARG",
        message: `--announcement is only for a new artifact pushed into a channel with --target; ${dir} holds ${state.artifact}.`,
        suggestedNextAction: `Push without it, then make it the announcement: raft channel update --target "#<channel>" --announcement ${state.artifact}`,
      });
    }
    const channelAnnouncementChannelName = opts.announcement ? parseRegularChannelTarget(opts.target ?? "") : null;
    if (opts.announcement && !channelAnnouncementChannelName) {
      throw new CliError({ code: "INVALID_TARGET", message: CHANNEL_ANNOUNCEMENT_TARGET_INVALID, suggestedNextAction: "Push it without --announcement, or push it into a channel: --target '#channel-name'." });
    }

    const scan = scanDir(dir, state ? Object.keys(state.files) : [], opts.includeHidden === true);
    const local = scan.files;
    if (!state && local.size === 0) {
      throw new CliError({ code: "INVALID_ARG", message: `No files in ${dir} to push${scan.skipped.length > 0 ? ` (left out: ${scan.skipped.join(", ")})` : ""}.` });
    }
    const deletes = opts.delete ?? [];
    const changed = state ? [...local].filter(([path, f]) => state.files[path] !== f.sha256).map(([path]) => path) : [...local.keys()];
    const notDeleted = state ? Object.keys(state.files).filter((path) => !local.has(path) && !deletes.includes(path)).sort() : [];
    const settings = [opts.title, opts.description, opts.entry, opts.note, opts.label].some((v) => v !== undefined);
    if (state && changed.length === 0 && deletes.length === 0 && !settings) {
      writeText(ctx.io, formatArtifactNothingToPublish({ dir, version: state.version, notDeleted }));
      return;
    }
    for (const path of changed) {
      const size = local.get(path)!.size;
      const limit = artifactFileType(path).text ? AGENT_API_ARTIFACT_MAX_TEXT_FILE_BYTES : AGENT_API_ARTIFACT_MAX_BINARY_FILE_BYTES;
      if (size > limit) {
        const e = formatArtifactError("FILE_TOO_LARGE", { dir, publishing: true, details: { path, size, limit } }, "cli");
        throw new CliError({ code: "FILE_TOO_LARGE", message: e.message, suggestedNextAction: e.nextAction });
      }
    }
    // The bytes sent are the bytes recorded: hash what is read now, not the earlier scan.
    const sent = changed.map((path) => ({ path, bytes: new Uint8Array(readFileSync(fileTarget(dir, path))) }));

    const agentContext = ctx.loadAgentContext();
    const client = ctx.createApiClient(agentContext);
    const api = createAgentApiContractSurfaceClient(client);
    const channelAnnouncementTarget = channelAnnouncementChannelName ? await channelAnnouncementChannelFor(client, channelAnnouncementChannelName) : null;
    const upload = async (sha256: string, bytes: Uint8Array) => {
      const path = buildAgentApiRawRoutePath("artifactUpload", { params: { sha256 } }) as string;
      const res = await client.requestRawBody("PUT", path, bytes);
      return res.ok ? { ok: true as const } : { ok: false as const, failure: artifactUploadFailure(res.status, res.errorBody ?? { error: res.error, code: res.errorCode }, "cli", dir) };
    };

    const outcome = await artifactsPublish(api, {
      ...(state ? { artifact: state.artifact, base: state.version } : { target: opts.target }),
      ...(opts.title === undefined ? {} : { title: opts.title }),
      ...(opts.description === undefined ? {} : { description: opts.description }),
      ...(opts.entry === undefined ? {} : { entry: opts.entry }),
      ...(opts.note === undefined ? {} : { note: opts.note }),
      ...(opts.label === undefined ? {} : { label: opts.label }),
      files: sent,
      ...(deletes.length === 0 ? {} : { delete: deletes }),
    }, { upload, dir });
    if (!outcome.ok) throw artifactCliError(outcome, commandLineOf(args), PUBLISH_RATE_LIMITED_LEFT_BEHIND);

    // Pushed. From here on nothing throws: the base moves to the new version and the directory follows it.
    const published = outcome.data;
    const id = published.artifact.id;
    const number = published.version.number;
    const files: Record<string, string> = { ...(state?.files ?? {}) };
    for (const { path, bytes } of sent) files[path] = sha256Of(bytes);
    for (const path of deletes) {
      delete files[path];
      rmSync(fileTarget(dir, path), { force: true });
    }
    const updated: string[] = [];
    const removed: string[] = [];
    const notUpdated: string[] = [];
    const merged = published.version.merged.flatMap((m) => (m.path === null ? [] : [m.path]));
    if (merged.length > 0) {
      const now = await artifactsRead(api, { artifact: id, version: number });
      const inVersion = now.ok && now.data.version ? new Set(now.data.version.files.map((f) => f.path)) : null;
      for (const path of merged) {
        if (inVersion && !inVersion.has(path)) {
          rmSync(fileTarget(dir, path), { force: true });
          delete files[path];
          removed.push(path);
          continue;
        }
        const got = inVersion ? await artifactsFile(api, { artifact: id, path, version: number }) : null;
        if (got?.ok) {
          writeFileUnder(dir, path, got.data.bytes);
          files[path] = sha256Of(got.data.bytes);
          updated.push(path);
        } else {
          notUpdated.push(path);
        }
      }
    }
    writeDirState(dir, { artifact: id, title: published.artifact.title, version: number, files });
    writeText(ctx.io, formatArtifactPublished(published, {
      dir,
      ...(state || opts.target === undefined ? {} : { target: opts.target }),
      updated,
      removed,
      notUpdated,
      notDeleted: notDeleted.filter((path) => !merged.includes(path)),
      skipped: scan.skipped,
      links: scan.links,
    }));
    if (channelAnnouncementTarget) {
      const target = `#${channelAnnouncementTarget.name}`;
      const set = await createAgentApiSurfaceClient(client).channels.update({ channelId: channelAnnouncementTarget.id as never }, { announcement: id });
      if (!set.ok) {
        throw new CliError({
          code: set.status >= 500 ? "SERVER_5XX" : "CHANNEL_ANNOUNCEMENT_NOT_SET",
          message: `Pushed ${id}, but it is not the announcement of ${target}: ${set.error ?? `HTTP ${set.status}`}`,
          suggestedNextAction: set.suggestedNextAction ?? `Set it once that is fixed: raft channel update --target "${target}" --announcement ${id}`,
        });
      }
      writeText(ctx.io, adoptCliReplyText(`It is now the announcement of ${target}.\n`));
    }
  },
);

/**
 * The channel --announcement names, from the server inventory, once it is
 * known the agent may set its announcement there: announcements on (the
 * entry carries `announcement`) and editChannelMetadata. Refused before
 * anything is pushed otherwise.
 */
async function channelAnnouncementChannelFor(client: Parameters<typeof createAgentApiSurfaceClient>[0], name: string): Promise<{ id: string; name: string }> {
  const info = await createAgentApiSurfaceClient(client).server.info();
  if (!info.ok) {
    throw new CliError({ code: info.status >= 500 ? "SERVER_5XX" : "INFO_FAILED", message: info.error ?? `HTTP ${info.status}` });
  }
  const channel = (info.data?.channels ?? []).find((candidate) => candidate.name === name);
  if (!channel) {
    throw new CliError({ code: "NOT_FOUND", message: `Channel not found or not visible: #${name}. Nothing was pushed.`, suggestedNextAction: "See the channels you can use: raft server info --channels --query <name>" });
  }
  if (!("announcement" in channel)) {
    throw new CliError({
      code: "CHANNEL_ANNOUNCEMENT_DISABLED",
      message: "Channel announcements are not turned on for this server. Nothing was pushed.",
      suggestedNextAction: `Push it without --announcement and post a message in #${name} pointing to it.`,
    });
  }
  const capabilities = (channel as { channelCapabilities?: Record<string, boolean> | null }).channelCapabilities;
  if (capabilities?.editChannelMetadata !== true) {
    throw new CliError({
      code: "CHANNEL_ANNOUNCEMENT_FORBIDDEN",
      message: `Only the owner of #${name} (one of its channel admins) or a server owner or admin can set its announcement. Nothing was pushed.`,
      suggestedNextAction: `Push it without --announcement and ask one of them to set it: raft channel update --target "#${name}" --announcement <artifact>`,
    });
  }
  return { id: channel.id, name: channel.name };
}

export function registerArtifactPublishCommand(parent: Command, runtimeOptions?: CommandRuntimeOptions): void {
  registerCliCommand(parent, artifactPublishCommand, runtimeOptions);
}
