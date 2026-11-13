// `raft artifact comment <artifact> [--path <file>] [--reply-to <id>] [--rev <n>] [--image <path>]…` (comment on stdin)
// → POST /internal/agent-api/artifacts/:artifact/comments (the SDK's artifacts.comment),
//   after POST …/:artifact/comment-images for each --image (artifacts.commentImageUpload)
//
// The comment is read from stdin, like `raft message send`, so quotes,
// backticks and newlines arrive as written. The answer says who was told and
// whose @ reached no one. Images (#146) are checked here before anything is
// sent (how many, readable, the size limit, the type by the first bytes),
// uploaded one by one, and posted with the comment; a Server without the
// upload route (from before images) posts nothing, never the text alone.

import type { Readable } from "node:stream";

import type { Command } from "commander";
import {
  ARTIFACT_COMMENT_IMAGE_MAX_BYTES,
  ARTIFACT_COMMENT_MAX_IMAGES,
  artifactsComment,
  artifactsCommentImageUpload,
  formatArtifactCommentImageRefusal,
} from "@botiverse/raft-shared/src/agentCliSurface";

import { createAgentApiContractSurfaceClient } from "../../agentApiPath";
import { commandLineOf } from "../../core/commandLine";
import { defineCommand, registerCliCommand } from "../../core/command";
import type { CommandRuntimeOptions } from "../../core/context";
import { CliError } from "../../core/errors";
import { writeText } from "../../core/renderer";
import { formatArtifactCommented } from "./_format";
import { commentImageUploader, IMAGES_LEFT_BEHIND, imageUploadCliError, readImageFile, saying } from "./_images";
import { artifactArgument, artifactCliError, parseVersion, refuseExtraArguments, splitArgs } from "./_shared";

interface CommentOpts {
  artifact?: string;
  path?: string;
  replyTo?: string;
  rev?: string;
  image?: string[];
}

const HEREDOC = "COMMENT";
const MAX_IMAGE_MIB = ARTIFACT_COMMENT_IMAGE_MAX_BYTES / (1024 * 1024);
/** A write refused over the rate limit while uploading: what it left behind. */
const IMAGES_RATE_LIMITED_LEFT_BEHIND = "Nothing was posted (images already sent go unused, and are gone within the hour).";

const collect = (value: string, previous: string[] = []): string[] => [...previous, value];
const quoted = (value: string) => `'${value.replace(/'/g, "'\\''")}'`;

/** The command the agent ran, flags and all, ready for a heredoc. */
function sameCommand(artifact: string, opts: CommentOpts): string {
  const words = ["raft", "artifact", "comment", artifact];
  // Single quotes, as the printed hints quote paths: a path may hold `$` or a backtick.
  if (opts.path !== undefined) words.push("--path", quoted(opts.path));
  if (opts.replyTo !== undefined) words.push("--reply-to", opts.replyTo);
  if (opts.rev !== undefined) words.push("--rev", opts.rev);
  for (const image of opts.image ?? []) words.push("--image", quoted(image));
  return words.join(" ");
}

function imageRefusal(text: { message: string; nextAction: string }): CliError {
  return new CliError({ code: "INVALID_ARG", message: text.message, suggestedNextAction: text.nextAction });
}

/**
 * Each --image file's bytes, or the refusal of the first that can't go:
 * more than a comment takes, unreadable, over the size limit (decided before
 * reading it), or not a PNG, JPEG, WebP or GIF by its first bytes. Nothing
 * is sent before every one passes.
 */
function readImages(paths: readonly string[]): Array<{ path: string; bytes: Uint8Array }> {
  if (paths.length > ARTIFACT_COMMENT_MAX_IMAGES) throw imageRefusal(formatArtifactCommentImageRefusal({ kind: "too_many", count: paths.length }, undefined));
  return paths.map((path) => {
    const file = readImageFile(path, true);
    if (!file.ok) throw imageRefusal(formatArtifactCommentImageRefusal(file.refusal, `--image ${path}`));
    return { path, bytes: file.bytes };
  });
}

function missingBody(artifact: string, opts: CommentOpts): CliError {
  return new CliError({
    code: "INVALID_ARG",
    message: "No comment received on stdin.",
    suggestedNextAction: [
      "Pipe the comment in with a heredoc:",
      `  ${sameCommand(artifact, opts)} <<'${HEREDOC}'`,
      "  your comment",
      `  ${HEREDOC}`,
    ].join("\n"),
  });
}

/** The comment's text from stdin; with images it may be empty (or not piped at all). */
async function readBody(stream: NodeJS.ReadableStream & { isTTY?: boolean }, artifact: string, opts: CommentOpts, withImages: boolean): Promise<string> {
  if (stream.isTTY) {
    if (withImages) return "";
    throw missingBody(artifact, opts);
  }
  let body = "";
  stream.setEncoding("utf8");
  for await (const chunk of stream as Readable) body += String(chunk);
  if (body.trim().length === 0 && !withImages) throw missingBody(artifact, opts);
  return body;
}

export const artifactCommentCommand = defineCommand(
  {
    name: "comment",
    description: "Comment on an artifact (one file with --path, or the whole artifact), or answer a comment with --reply-to; the comment is read from stdin, and @name tells that agent",
    arguments: ["[artifact]"],
    usage: "<artifact> [--path <file>] [--reply-to <comment>] [--rev <n>] [--image <path>]... < comment on stdin",
    helpAfter: [
      "",
      "The comment is read from stdin, so quotes, backticks and newlines arrive as written:",
      `  raft artifact comment ScAiFjjtiUvoyEYA6Ry12u --path "components.html" <<'${HEREDOC}'`,
      "  Can you put the three card states side by side, @Kirby?",
      `  ${HEREDOC}`,
      "",
      `Images go with the comment (--image, up to ${ARTIFACT_COMMENT_MAX_IMAGES}); with one, stdin may be empty:`,
      `  raft artifact comment ScAiFjjtiUvoyEYA6Ry12u --image ./before.png --image ./after.png <<'${HEREDOC}'`,
      "  The card overflows on a phone: before and after.",
      `  ${HEREDOC}`,
      "  raft artifact comment ScAiFjjtiUvoyEYA6Ry12u --path \"components.html\" --image ./phone.png < /dev/null",
      "Every file is checked before anything is sent; a Server that can't take images yet refuses",
      "without posting anything. `raft artifact comments` lists a comment's images under it, each with",
      "its id: save one with `raft artifact download <artifact> --image <id> --output <file>`.",
    ].join("\n"),
    options: [
      { flags: "--artifact <artifact>", description: "The artifact, if not given as the first argument: its id, link or exact title" },
      { flags: "--path <file>", description: "The file it is about (as `raft artifact read` lists it); leave it out for the whole artifact" },
      { flags: "--reply-to <comment>", description: "Answer this comment (its comment=… id); on its file unless --path says otherwise" },
      { flags: "--rev <n>", description: "Comment on an older version, e.g. 9 or v9 (default: the current one)" },
      {
        flags: "--image <path>",
        description: `An image to post with the comment: a PNG, JPEG, WebP or GIF file of at most ${MAX_IMAGE_MIB} MiB (repeat for up to ${ARTIFACT_COMMENT_MAX_IMAGES}, in order); with one, the comment's text may be empty`,
        parse: collect,
      },
    ],
  },
  async (ctx, ...args: unknown[]) => {
    const { positionals, opts } = splitArgs<CommentOpts>(args, 1);
    refuseExtraArguments(args[2], 1, "The comment goes on stdin, not after the artifact.");
    const artifact = artifactArgument(positionals[0], opts.artifact);
    const version = parseVersion(opts.rev);
    const images = readImages(opts.image ?? []);
    const body = await readBody((ctx.io.stdin ?? process.stdin) as NodeJS.ReadableStream & { isTTY?: boolean }, artifact, opts, images.length > 0);
    // Run again (after a rate limit's wait) with the same comment on stdin.
    const again = `${commandLineOf(args) ?? sameCommand(artifact, opts)} <<'${HEREDOC}'\n<the same comment>\n${HEREDOC}`;
    const agentContext = ctx.loadAgentContext();
    const client = ctx.createApiClient(agentContext);
    const api = createAgentApiContractSurfaceClient(client);
    // One upload at a time, in order; the first refusal stops before the comment is posted.
    const upload = commentImageUploader(client);
    const fileIds: string[] = [];
    for (const image of images) {
      const uploaded = await artifactsCommentImageUpload(upload, { artifact, bytes: image.bytes }, { named: `--image ${image.path}` });
      if (!uploaded.ok) {
        const error = imageUploadCliError(uploaded, again, IMAGES_RATE_LIMITED_LEFT_BEHIND);
        // The connection failed (a refusal says what it left in its own words): nothing posted, any image uploaded unused.
        if (uploaded.error.code === "TRANSPORT_ERROR") throw saying(error, fileIds.length > 0 ? `Nothing was posted. ${IMAGES_LEFT_BEHIND}` : "Nothing was posted.");
        throw error;
      }
      fileIds.push(uploaded.data.fileId);
    }
    const outcome = await artifactsComment(api, {
      artifact,
      body,
      ...(opts.path === undefined ? {} : { path: opts.path }),
      ...(opts.replyTo === undefined ? {} : { replyTo: opts.replyTo }),
      ...(version === undefined ? {} : { version }),
      ...(fileIds.length === 0 ? {} : { images: fileIds }),
    });
    if (!outcome.ok) throw artifactCliError(outcome, again);
    writeText(ctx.io, formatArtifactCommented(outcome.data));
  },
);

export function registerArtifactCommentCommand(parent: Command, runtimeOptions?: CommandRuntimeOptions): void {
  registerCliCommand(parent, artifactCommentCommand, runtimeOptions);
}
