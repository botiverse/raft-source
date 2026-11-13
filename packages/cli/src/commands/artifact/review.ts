// `raft artifact review <artifact> [--rev <n>]` (the review as JSON on stdin)
// → POST /internal/agent-api/artifacts/:artifact/reviews (the SDK's artifacts.review),
//   after POST …/:artifact/comment-images for each comment's image (artifacts.commentImageUpload)
//
// A review is several comments, and an optional summary, posted together or
// not at all; each agent told hears once for the whole of it. Agents have no
// drafts: the whole review goes in this one call. The JSON is read from
// stdin, like a comment, so quotes and newlines arrive as written; a JSON
// mistake is named by line and column, and a refused comment by its place.
//
// A comment's "images" are image files (#146). The review and every one of
// its image files are checked before any request; then the images are
// uploaded one at a time, in order, and the review is posted with their ids
// (the same artifactsReview the SDK runs). An upload that fails posts
// nothing; images already uploaded stay unused, and the Server lets them go
// within the hour: a failure after one was uploaded says so in a sentence of
// its own, when the review is known not to be posted.
//
// Each run sends the review under one idempotency key (the JSON's
// "idempotencyKey", else a new one). When the answer is lost (the connection
// drops, a 5xx, or an answer that can't be read) the review may have gone in,
// so it is sent once more under the same key: the Server answers the posted
// review rather than posting it again. If that doesn't settle it either, the
// error gives the key to run it with.

import { randomUUID } from "node:crypto";
import type { Readable } from "node:stream";

import type { Command } from "commander";
import type { RaftOpError } from "@botiverse/raft-shared";
import {
  ARTIFACT_AGENT_WRITES_PER_MINUTE,
  ARTIFACT_COMMENT_IMAGE_MAX_BYTES,
  ARTIFACT_COMMENT_IMAGE_UPLOADS_PER_MINUTE,
  ARTIFACT_COMMENT_MAX_IMAGES,
  artifactsCommentImageUpload,
  artifactsReview,
  artifactsReviewRefusal,
  formatArtifactReviewCommentImageRefusal,
  formatArtifactReviewTooManyImages,
  formatArtifactReviewTooManyWrites,
} from "@botiverse/raft-shared/src/agentCliSurface";

import { createAgentApiContractSurfaceClient } from "../../agentApiPath";
import { commandLineOf } from "../../core/commandLine";
import { defineCommand, registerCliCommand } from "../../core/command";
import type { CommandRuntimeOptions } from "../../core/context";
import { CliError } from "../../core/errors";
import { writeText } from "../../core/renderer";
import { formatArtifactReviewed } from "./_format";
import { commentImageUploader, IMAGES_LEFT_BEHIND, imageUploadCliError, readImageFile, saying, type ImageFileRefusal } from "./_images";
import { artifactArgument, artifactCliError, parseVersion, refuseExtraArguments, splitArgs } from "./_shared";

interface ReviewOpts {
  artifact?: string;
  rev?: string;
}

/** A comment as read from the JSON: `images` are file paths, relative to the current directory. */
type ReviewComment = { body: string; path?: string; replyTo?: string; images?: string[] };

const HEREDOC = "REVIEW";
const TEXT_FIELDS = ["body", "path", "replyTo"] as const;
const COMMENT_FIELDS = [...TEXT_FIELDS, "images"] as const;
const REVIEW_FIELDS = ["body", "comments", "idempotencyKey"] as const;
const MAX_IMAGE_MIB = ARTIFACT_COMMENT_IMAGE_MAX_BYTES / (1024 * 1024);
/** What a failure while uploading the images left: said by a rate limit's wait, and after a daemon proxy's error. */
const NOTHING_POSTED = "Nothing of the review was posted.";
/** What a rate limit's wait says once images were uploaded for a review known not to be posted. */
const IMAGES_RATE_LIMITED_LEFT_BEHIND = `${NOTHING_POSTED} ${IMAGES_LEFT_BEHIND}`;

/** The command the agent ran, flags and all, ready for a heredoc. */
function sameCommand(artifact: string, opts: ReviewOpts): string {
  const words = ["raft", "artifact", "review", artifact];
  if (opts.rev !== undefined) words.push("--rev", opts.rev);
  return words.join(" ");
}

/** The shape to send, as the help and every JSON error show it. */
function example(command: string): string {
  return [
    `  ${command} <<'${HEREDOC}'`,
    "  {",
    "    \"body\": \"Optional summary of the whole review\",",
    "    \"comments\": [",
    "      { \"path\": \"components.html\", \"body\": \"A comment on that file\" },",
    "      { \"path\": \"components.html\", \"body\": \"Before and after\", \"images\": [\"./before.png\", \"./after.png\"] },",
    "      { \"replyTo\": \"c_812\", \"body\": \"An answer to that comment\" },",
    "      { \"body\": \"A comment on the whole artifact\" }",
    "    ]",
    "  }",
    `  ${HEREDOC}`,
  ].join("\n");
}

function badReview(message: string, artifact: string, opts: ReviewOpts): CliError {
  return new CliError({
    code: "INVALID_ARG",
    message: `${message} Nothing was posted.`,
    suggestedNextAction: `Send it as JSON on stdin, then run the command again:\n${example(sameCommand(artifact, opts))}`,
  });
}

/**
 * Where JSON that JSON.parse refused first goes wrong, as an offset: a plain
 * scan of the grammar, because Node's errors give no position for the usual
 * mistakes (a trailing comma, single quotes, a bare word). Null when the
 * scan finds nothing (a bad escape, say): the error then names no place.
 */
function jsonErrorOffset(text: string): number | null {
  let i = 0;
  const ws = () => { while (i < text.length && " \t\n\r".includes(text[i]!)) i++; };
  const fail = (): never => { throw i; };
  const string = () => {
    i++;
    while (i < text.length) {
      const c = text[i]!;
      if (c === "\"") { i++; return; }
      if (c === "\\") { i += 2; continue; }
      if (c < " ") fail();
      i++;
    }
    fail();
  };
  const value = (): void => {
    ws();
    const c = text[i];
    if (c === "{" || c === "[") {
      const close = c === "{" ? "}" : "]";
      i++;
      ws();
      if (text[i] === close) { i++; return; }
      for (;;) {
        if (c === "{") {
          ws();
          if (text[i] !== "\"") fail();
          string();
          ws();
          if (text[i] !== ":") fail();
          i++;
        }
        value();
        ws();
        if (text[i] === ",") { i++; continue; }
        if (text[i] === close) { i++; return; }
        fail();
      }
    }
    if (c === "\"") { string(); return; }
    const literal = /^(?:true|false|null|-?(?:0|[1-9]\d*)(?:\.\d+)?(?:[eE][+-]?\d+)?)/.exec(text.slice(i));
    if (!literal) fail();
    i += literal![0].length;
  };
  try {
    value();
    ws();
    return i < text.length ? i : null;
  } catch (at) {
    if (typeof at === "number") return at;
    throw at;
  }
}

/** Where the JSON goes wrong (line and column, 1-based) and, for the usual mistakes, what it is. */
function jsonPlace(text: string): string {
  const offset = jsonErrorOffset(text);
  if (offset === null) return "it isn't valid JSON";
  const before = text.slice(0, offset);
  const line = before.split("\n").length;
  const column = before.length - before.lastIndexOf("\n");
  const found = text[offset];
  const previous = before.trimEnd().slice(-1);
  const what = found === undefined
    ? "it ends too early"
    : (found === "]" || found === "}") && previous === ","
      ? `a comma before ${found}`
      : found === "'"
        ? "a single quote: JSON strings take double quotes"
        : `found ${JSON.stringify(found)}`;
  return `it isn't valid JSON at line ${line}, column ${column} (${what})`;
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * The review from stdin: `{ body?, comments: [...] }`, or just the array of
 * comments. Unknown fields are refused by name rather than dropped (a
 * misspelt `replyTo` would post the reply as a new comment). A comment with
 * images may have no text.
 */
function parseReview(text: string, artifact: string, opts: ReviewOpts): { body?: string; comments: ReviewComment[]; idempotencyKey?: string } {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    throw badReview(`The review on stdin: ${jsonPlace(text)}.`, artifact, opts);
  }
  const review = Array.isArray(parsed) ? { comments: parsed } : parsed;
  if (!isObject(review)) throw badReview("The review on stdin must be a JSON object with \"comments\" (an array).", artifact, opts);
  const extra = Object.keys(review).filter((key) => !(REVIEW_FIELDS as readonly string[]).includes(key));
  if (extra.length > 0) throw badReview(`The review has ${extra.map((k) => `"${k}"`).join(", ")}, which it doesn't take (it takes "body", the summary, "comments", and "idempotencyKey" to retry a review whose answer was lost).`, artifact, opts);
  if (review.body !== undefined && review.body !== null && typeof review.body !== "string") throw badReview("The review's \"body\" (the summary) must be a string.", artifact, opts);
  const key = review.idempotencyKey;
  if (key !== undefined && key !== null && (typeof key !== "string" || key.trim() === "")) throw badReview("The review's \"idempotencyKey\" must be the key an earlier run gave (a string), or left out.", artifact, opts);
  if (!Array.isArray(review.comments) || review.comments.length === 0) throw badReview("The review needs \"comments\": an array of at least one comment.", artifact, opts);
  const total = review.comments.length;
  const comments = review.comments.map((comment: unknown, index: number) => {
    const where = `Comment ${index + 1} of ${total}`;
    if (!isObject(comment)) throw badReview(`${where} must be an object like { "body": "…" }.`, artifact, opts);
    const unknown = Object.keys(comment).filter((key) => !(COMMENT_FIELDS as readonly string[]).includes(key));
    if (unknown.length > 0) throw badReview(`${where} has ${unknown.map((k) => `"${k}"`).join(", ")}, which a comment doesn't take (it takes "body", "path", "replyTo" and "images").`, artifact, opts);
    // null is the same as leaving a field out.
    for (const field of TEXT_FIELDS) {
      if (comment[field] !== undefined && comment[field] !== null && typeof comment[field] !== "string") throw badReview(`${where}: "${field}" must be a string.`, artifact, opts);
    }
    const images = comment.images ?? [];
    if (!Array.isArray(images) || images.some((image) => typeof image !== "string" || image.trim() === "")) {
      throw badReview(`${where}: "images" must be an array of image files' paths, like ["./before.png"].`, artifact, opts);
    }
    if (typeof comment.body !== "string" && images.length === 0) throw badReview(`${where} has no "body".`, artifact, opts);
    return {
      body: typeof comment.body === "string" ? comment.body : "",
      ...(typeof comment.path === "string" ? { path: comment.path } : {}),
      ...(typeof comment.replyTo === "string" ? { replyTo: comment.replyTo } : {}),
      ...(images.length === 0 ? {} : { images: images as string[] }),
    };
  });
  return { ...(typeof review.body === "string" ? { body: review.body } : {}), comments, ...(typeof key === "string" ? { idempotencyKey: key.trim() } : {}) };
}

/**
 * No answer to act on, so the review may have gone in: the connection
 * dropped, the Server failed (5xx), or an answer came that can't be read (a
 * 2xx whose body was cut off).
 */
function answerLost(error: RaftOpError): boolean {
  const status = error.status ?? 0;
  return error.code === "TRANSPORT_ERROR" || error.code === "INVALID_RESPONSE" || status >= 500 || (status >= 200 && status < 300);
}

function lastTry(error: RaftOpError): string {
  if (error.code === "TRANSPORT_ERROR") return "the connection failed";
  if ((error.status ?? 0) >= 500) return `the Raft Server failed with HTTP ${error.status}`;
  if (error.retryAfterSeconds !== undefined) return "rate limited";
  return "its answer couldn't be read";
}

/**
 * The first answer was lost and the resend didn't settle it either (lost
 * again, or refused for now, as a rate limit): the review may have been
 * posted, so the next run must carry this key.
 */
function stillUnknown(error: RaftOpError, idempotencyKey: string, command: string): CliError {
  const wait = error.retryAfterSeconds === undefined ? "" : `Wait ${error.retryAfterSeconds} second${error.retryAfterSeconds === 1 ? "" : "s"}, then run`;
  return new CliError({
    code: (error.status ?? 0) >= 500 ? "SERVER_5XX" : "ARTIFACT_FAILED",
    message: `No answer to the review, sent twice under one key (the last try: ${lastTry(error)}), so it may or may not have been posted.`,
    suggestedNextAction: `${wait || "Run"} the same command with your same JSON, unchanged but for this line added, which posts the review only if it wasn't: "idempotencyKey": "${idempotencyKey}"\n  ${command} <<'${HEREDOC}'\n  { "idempotencyKey": "${idempotencyKey}", <the rest of your JSON, unchanged> }\n  ${HEREDOC}`,
    retryable: true,
  });
}

/** Where a comment is, as a refusal of one of its images names it ("Comment 2 of 3 (a.html)"). */
function placeOf(comment: ReviewComment, index: number, total: number) {
  return { index, total, commentPath: comment.path?.trim() ? comment.path : null, ...(comment.replyTo?.trim() ? { replyTo: comment.replyTo } : {}) };
}

function imageRefusal(refusal: ImageFileRefusal, comment: ReviewComment, index: number, total: number, path: string): CliError {
  const text = formatArtifactReviewCommentImageRefusal(refusal, { ...placeOf(comment, index, total), named: `image ${path}` });
  return new CliError({ code: "INVALID_ARG", message: text.message, suggestedNextAction: text.nextAction });
}

/**
 * `error` once `sent` images were uploaded for a review known not to be
 * posted: IMAGES_LEFT_BEHIND after its message, a sentence of its own. A rate
 * limit's message is the Server's: its wait says it (IMAGES_RATE_LIMITED_LEFT_BEHIND).
 */
function leavingImages(error: CliError, sent: number): CliError {
  return sent > 0 && error.code !== "RATE_LIMITED" ? saying(error, IMAGES_LEFT_BEHIND) : error;
}

/**
 * Every image of every comment checked before anything is sent: how many in
 * all (they are uploaded in one go, and an agent may upload only so many a
 * minute: more would be refused part-way on every run), and with the
 * comments (each comment and each image is one of the agent's writes a
 * minute: more would be refused on every run, the images uploaded and the
 * review refused), then each file by its size and first bytes (it is read
 * whole only to upload it). The first that can't go refuses the review,
 * naming its comment.
 */
function checkImages(comments: readonly ReviewComment[]): void {
  const count = comments.reduce((n, comment) => n + (comment.images?.length ?? 0), 0);
  if (count > ARTIFACT_COMMENT_IMAGE_UPLOADS_PER_MINUTE) {
    const text = formatArtifactReviewTooManyImages(count);
    throw new CliError({ code: "INVALID_ARG", message: text.message, suggestedNextAction: text.nextAction });
  }
  if (count > 0 && comments.length + count > ARTIFACT_AGENT_WRITES_PER_MINUTE) {
    const text = formatArtifactReviewTooManyWrites(comments.length, count);
    throw new CliError({ code: "INVALID_ARG", message: text.message, suggestedNextAction: text.nextAction });
  }
  for (const [index, comment] of comments.entries()) {
    for (const path of comment.images ?? []) {
      const file = readImageFile(path, false);
      if (!file.ok) throw imageRefusal(file.refusal, comment, index, comments.length, path);
    }
  }
}

/**
 * Each comment's image files uploaded, one at a time and in order, read
 * whole only now: the comments with their images' ids. The first failure
 * stops before the review is posted, so nothing of it is; the images already
 * uploaded stay unused, and the Server lets them go within the hour (the
 * error says so once there is one).
 */
async function uploadImages(
  upload: ReturnType<typeof commentImageUploader>,
  artifact: string,
  comments: readonly ReviewComment[],
  again: string,
): Promise<ReviewComment[]> {
  const uploaded: ReviewComment[] = [];
  let sent = 0;
  for (const [index, comment] of comments.entries()) {
    const { images: paths = [], ...rest } = comment;
    const fileIds: string[] = [];
    for (const path of paths) {
      // Checked above by its first bytes; it may have changed since, so the bytes read are checked again.
      const file = readImageFile(path, true);
      if (!file.ok) throw leavingImages(imageRefusal(file.refusal, comment, index, comments.length, path), sent);
      let image: Awaited<ReturnType<typeof artifactsCommentImageUpload>>;
      try {
        image = await artifactsCommentImageUpload(upload, { artifact, bytes: file.bytes }, { named: `image ${path}`, reviewComment: placeOf(comment, index, comments.length) });
      } catch (error) {
        // A daemon proxy's failure is already the CLI's error (commentImageUploader rethrows it): its code and next step kept, what it left said.
        if (error instanceof CliError) throw leavingImages(saying(error, NOTHING_POSTED), sent);
        throw error;
      }
      if (!image.ok) throw leavingImages(imageUploadCliError(image, again, sent > 0 ? IMAGES_RATE_LIMITED_LEFT_BEHIND : NOTHING_POSTED), sent);
      fileIds.push(image.data.fileId);
      sent += 1;
    }
    uploaded.push({ ...rest, ...(fileIds.length === 0 ? {} : { images: fileIds }) });
  }
  return uploaded;
}

function missingReview(artifact: string, opts: ReviewOpts): CliError {
  return new CliError({
    code: "INVALID_ARG",
    message: "No review received on stdin.",
    suggestedNextAction: `Pipe the review in as JSON with a heredoc:\n${example(sameCommand(artifact, opts))}`,
  });
}

async function readStdin(stream: NodeJS.ReadableStream & { isTTY?: boolean }, artifact: string, opts: ReviewOpts): Promise<string> {
  if (stream.isTTY) throw missingReview(artifact, opts);
  let text = "";
  stream.setEncoding("utf8");
  for await (const chunk of stream as Readable) text += String(chunk);
  if (text.trim().length === 0) throw missingReview(artifact, opts);
  return text;
}

export const artifactReviewCommand = defineCommand(
  {
    name: "review",
    description: "Review an artifact: several comments and an optional summary, posted together or not at all, each agent told once; the review is read from stdin as JSON",
    arguments: ["[artifact]"],
    usage: "<artifact> [--rev <n>] < review JSON on stdin",
    helpAfter: [
      "",
      "The review is read from stdin as JSON: \"comments\" (1 to 50, posted in this order), each",
      "with \"body\" and optionally \"path\" (the file, as `raft artifact read` lists it; leave it",
      "out for the whole artifact), \"replyTo\" (a comment's id, to answer it) and \"images\"; and",
      "\"body\", an optional summary. Just the array of comments works too (no summary). @name in",
      "any of it tells that agent, once for the whole review. If one comment is refused, nothing",
      "is posted and the error names that comment. If the answer is lost, the command sends",
      "the review once more under the same key, which doesn't post it again; if that fails",
      "too, the error gives an \"idempotencyKey\" to add to the JSON for the next run.",
      "",
      `A comment's "images" are image files to post with it, in order: paths relative to the`,
      "directory you run the command in (~ isn't expanded: write ./x.png or an absolute path),",
      `each a PNG, JPEG, WebP or GIF file of at most ${MAX_IMAGE_MIB} MiB, up to ${ARTIFACT_COMMENT_MAX_IMAGES} a comment and ${ARTIFACT_COMMENT_IMAGE_UPLOADS_PER_MINUTE} in all,`,
      `and at most ${ARTIFACT_AGENT_WRITES_PER_MINUTE} comments and images together (each is one of your writes a minute).`,
      `With one, its "body" may be empty or left out. Every file is checked before anything is`,
      "sent; then each is uploaded and the review posted with them. If one can't go, nothing is",
      "posted; a Server that can't take images yet refuses without posting anything.",
      "",
      example("raft artifact review ScAiFjjtiUvoyEYA6Ry12u"),
    ].join("\n"),
    options: [
      { flags: "--artifact <artifact>", description: "The artifact, if not given as the first argument: its id, link or exact title" },
      { flags: "--rev <n>", description: "Review an older version, e.g. 9 or v9 (default: the current one)" },
    ],
  },
  async (ctx, ...args: unknown[]) => {
    const { positionals, opts } = splitArgs<ReviewOpts>(args, 1);
    refuseExtraArguments(args[2], 1, "The review goes on stdin as JSON, not after the artifact.");
    const artifact = artifactArgument(positionals[0], opts.artifact);
    const version = parseVersion(opts.rev);
    const text = await readStdin((ctx.io.stdin ?? process.stdin) as NodeJS.ReadableStream & { isTTY?: boolean }, artifact, opts);
    const review = parseReview(text, artifact, opts);
    const command = commandLineOf(args) ?? sameCommand(artifact, opts);
    // Run again (after a rate limit's wait, or a fix) with the same review on stdin.
    const again = `${command} <<'${HEREDOC}'\n<the same review>\n${HEREDOC}`;
    const withImages = review.comments.some((comment) => (comment.images?.length ?? 0) > 0);
    const base = { artifact, ...(review.body === undefined ? {} : { body: review.body }), idempotencyKey: review.idempotencyKey ?? randomUUID(), ...(version === undefined ? {} : { version }) };
    if (withImages) {
      // Before any upload: the review as artifactsReview checks it (its images counted), then every image file.
      const refused = artifactsReviewRefusal({ ...base, comments: review.comments });
      if (refused) throw artifactCliError(refused, again);
      checkImages(review.comments);
    }
    const agentContext = ctx.loadAgentContext();
    const client = ctx.createApiClient(agentContext);
    const api = createAgentApiContractSurfaceClient(client);
    // Each run uploads the images again, under new ids: a run with the "idempotencyKey" of a review that
    // did go in then differs from it, so the Server refuses it (IDEMPOTENCY_KEY_REUSED) rather than post it twice.
    const comments = withImages ? await uploadImages(commentImageUploader(client), artifact, review.comments, again) : review.comments;
    const sent = comments.reduce((n, comment) => n + (comment.images?.length ?? 0), 0);
    const request = { ...base, comments };
    let outcome = await artifactsReview(api, request);
    // The answer was lost: once more under the same key (the same image ids), which answers the review if it went in.
    const firstLost = !outcome.ok && answerLost(outcome.error);
    if (firstLost) outcome = await artifactsReview(api, request);
    // Still unsettled: lost again, or refused for now (a rate limit). Any other refusal of the resend is final (the same request is refused again).
    if (firstLost && !outcome.ok && (answerLost(outcome.error) || outcome.error.retryable)) throw stillUnknown(outcome.error, request.idempotencyKey, command);
    if (!outcome.ok) {
      // Refused: the images uploaded for it go unused, said only when the review is known not to be posted. Not after a
      // lost first answer: a resend refused before the Server looks its key up (NOT_VISIBLE, FORBIDDEN, an upgrade) may
      // follow a review that went in. Nor when the key's review was posted (IDEMPOTENCY_KEY_REUSED): it has its own images.
      const unused = firstLost || outcome.error.serverCode === "IDEMPOTENCY_KEY_REUSED" ? 0 : sent;
      throw leavingImages(artifactCliError(outcome, again, unused > 0 ? IMAGES_RATE_LIMITED_LEFT_BEHIND : undefined), unused);
    }
    writeText(ctx.io, formatArtifactReviewed(outcome.data, { replayed: outcome.state === "replayed" }));
  },
);

export function registerArtifactReviewCommand(parent: Command, runtimeOptions?: CommandRuntimeOptions): void {
  registerCliCommand(parent, artifactReviewCommand, runtimeOptions);
}
