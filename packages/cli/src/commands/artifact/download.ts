// `raft artifact download <artifact> <path> --output <file> [--rev <n>]`
// → GET /internal/agent-api/artifacts/:artifact/files/:path (binary)
// `raft artifact download <artifact> --image <id> --output <file>`
// → GET /internal/agent-api/artifacts/:artifact/comment-images/:fileId (binary)
//
// Saves one file's exact bytes, or one image of a comment (#146; its id is on
// the comment's Images line), for the agent to look at with its own image
// reader. The SDK's model-facing equivalent of a file is artifacts.fileContent
// (text inline, or a short-lived URL); an image is the typed
// artifacts.commentImage.

import { writeFileSync } from "node:fs";

import type { Command } from "commander";
import { artifactsCommentImage, artifactsFile } from "@botiverse/raft-shared/src/agentCliSurface";

import { createAgentApiContractSurfaceClient } from "../../agentApiPath";
import { defineCommand, registerCliCommand } from "../../core/command";
import type { CommandContext, CommandRuntimeOptions } from "../../core/context";
import { CliError } from "../../core/errors";
import { writeText } from "../../core/renderer";
import { formatArtifactCommentImageSaved, formatArtifactDownloaded } from "./_format";
import { artifactArgument, artifactCliError, parseVersion, splitArgs } from "./_shared";

interface DownloadOpts {
  artifact?: string;
  path?: string;
  output?: string;
  rev?: string;
  image?: string;
}

const OUTPUT_REQUIRED = "--output is required: the local path to save the file to";

/** `--image <id>`: one image of the artifact's comments, saved as it is. */
async function downloadImage(ctx: CommandContext, artifact: string, image: string, opts: Partial<DownloadOpts>): Promise<void> {
  if (!image.trim()) {
    throw new CliError({ code: "INVALID_ARG", message: "which image? Pass its id, from the comment's Images line", suggestedNextAction: `See the comments and their images: raft artifact comments ${artifact} --all` });
  }
  if (opts.rev !== undefined) throw new CliError({ code: "INVALID_ARG", message: "--rev picks a file's version; a comment's image has none. Leave it out." });
  if (!opts.output) throw new CliError({ code: "INVALID_ARG", message: OUTPUT_REQUIRED });
  const agentContext = ctx.loadAgentContext();
  const api = createAgentApiContractSurfaceClient(ctx.createApiClient(agentContext));
  const outcome = await artifactsCommentImage(api, { artifact, fileId: image });
  if (!outcome.ok) throw artifactCliError(outcome);
  writeFileSync(opts.output, outcome.data.bytes);
  writeText(ctx.io, formatArtifactCommentImageSaved({ fileId: outcome.data.fileId, contentType: outcome.data.contentType, sizeBytes: outcome.data.bytes.byteLength, output: opts.output }));
}

export const artifactDownloadCommand = defineCommand(
  {
    name: "download",
    description: "Save one file of an artifact to a local path, bytes intact (images, PDFs included); or, with --image, one image of a comment",
    arguments: ["[artifact]", "[path]"],
    helpAfter: [
      "",
      "A comment's image, by the id on its Images line in `raft artifact comments` (look at the saved file to see it):",
      "  raft artifact download ScAiFjjtiUvoyEYA6Ry12u --image <id> --output comment-c_812-1.png",
    ].join("\n"),
    options: [
      { flags: "--artifact <artifact>", description: "The artifact, if not given as the first argument: its id, link or exact title" },
      { flags: "--path <file>", description: "The file's path in the artifact, if not given as the second argument (as `raft artifact read` lists it)" },
      { flags: "--image <id>", description: "Save this image of a comment instead of a file (its id, from the comment's Images line); not with a path or --rev" },
      { flags: "--output <file>", description: "Local path to write the file to" },
      { flags: "--rev <n>", description: "A file of an older version, e.g. 9 or v9 (default: the current one)" },
    ],
  },
  async (ctx, ...args: unknown[]) => {
    const { positionals, opts } = splitArgs<DownloadOpts>(args, 2);
    const artifact = artifactArgument(positionals[0], opts.artifact);
    if (opts.image !== undefined) {
      if (positionals[1] !== undefined || opts.path !== undefined) throw new CliError({ code: "INVALID_ARG", message: "Give a file path or --image <id>, not both." });
      await downloadImage(ctx, artifact, opts.image, opts);
      return;
    }
    if (positionals[1] !== undefined && opts.path !== undefined && positionals[1] !== opts.path) {
      throw new CliError({ code: "INVALID_ARG", message: "pass the file's path either as the second argument or with --path, not both" });
    }
    const path = positionals[1] ?? opts.path;
    if (!path?.trim()) {
      throw new CliError({ code: "INVALID_ARG", message: "which file? Pass its path after the artifact", suggestedNextAction: `See its files: raft artifact read ${artifact} --files` });
    }
    if (!opts.output) {
      throw new CliError({ code: "INVALID_ARG", message: OUTPUT_REQUIRED });
    }
    const version = parseVersion(opts.rev);
    const agentContext = ctx.loadAgentContext();
    const api = createAgentApiContractSurfaceClient(ctx.createApiClient(agentContext));
    const outcome = await artifactsFile(api, { artifact, path, ...(version === undefined ? {} : { version }) });
    if (!outcome.ok) throw artifactCliError(outcome);
    writeFileSync(opts.output, outcome.data.bytes);
    const shown = outcome.data.version;
    writeText(ctx.io, formatArtifactDownloaded({ path, ...(shown === undefined ? {} : { version: shown }), output: opts.output, sizeBytes: outcome.data.bytes.byteLength }));
  },
);

export function registerArtifactDownloadCommand(parent: Command, runtimeOptions?: CommandRuntimeOptions): void {
  registerCliCommand(parent, artifactDownloadCommand, runtimeOptions);
}
