// Images in Artifact comments (#146), shared by `raft artifact comment
// --image` and `raft artifact review` (a comment's "images"): reading an image
// file and checking it as the Server would (at most 10 MiB, decided before
// reading it; PNG, JPEG, WebP or GIF by its first bytes), uploading one
// through the CLI's client (the raw-body route the generated client can't
// send), and an upload's refusal as the CLI's error. The sentences are the
// shared ones (agentText/artifacts.ts).

import { closeSync, openSync, readFileSync, readSync, statSync } from "node:fs";

import type { RaftFailure } from "@botiverse/raft-shared";
import {
  ARTIFACT_COMMENT_IMAGE_MAX_BYTES,
  ARTIFACT_COMMENT_IMAGE_TYPE_BYTES,
  artifactCommentImageTypeOf,
  buildAgentApiRawRoutePath,
} from "@botiverse/raft-shared/src/agentCliSurface";

import type { ApiClient, ApiResponse } from "../../client";
import { CliError } from "../../core/errors";
import { artifactCliError } from "./_shared";

/**
 * What images uploaded for a comment or review that is known not to be
 * posted come to: said once at least one was uploaded, after the error's
 * message (a rate limit's: in its wait).
 */
export const IMAGES_LEFT_BEHIND = "The images already uploaded go unused, and are gone within the hour.";

/**
 * `error` with `sentence` after its message, its code, next step and the
 * rest kept: after the message's last sentence (closing it with a period if
 * it has none), or on a line of its own after a message of several lines (a
 * hold's list).
 */
export function saying(error: CliError, sentence: string): CliError {
  const message = error.message.trimEnd();
  error.message = message.includes("\n") ? `${message}\n${sentence}` : `${/[.!?]$/.test(message) ? message : `${message}.`} ${sentence}`;
  return error;
}

/** Why an image file was refused before anything was sent (the shared ArtifactCommentImageRefusal's kinds for one file). */
export type ImageFileRefusal =
  | { kind: "unreadable"; reason: string }
  | { kind: "too_large"; sizeBytes: number }
  | { kind: "not_image" };

/** Why a file can't be read, in a few words (the system's own message otherwise). */
function unreadableReason(error: unknown): string {
  const code = (error as { code?: unknown } | null)?.code;
  if (code === "ENOENT" || code === "ENOTDIR") return "no such file";
  if (code === "EACCES" || code === "EPERM") return "permission denied";
  if (code === "EISDIR") return "it is a directory";
  return error instanceof Error ? error.message : String(error);
}

/** A file's first `count` bytes (fewer when it is shorter). */
function readHead(path: string, count: number): Uint8Array {
  const head = new Uint8Array(count);
  const fd = openSync(path, "r");
  try {
    return head.subarray(0, readSync(fd, head, 0, count, 0));
  } finally {
    closeSync(fd);
  }
}

/**
 * An image file checked as the Server would check it: readable, at most
 * 10 MiB (by its size, before reading it), a PNG, JPEG, WebP or GIF by its
 * first bytes. `whole`: read it all (to upload it) and check the bytes read,
 * else only its first bytes (to check many files before sending anything).
 */
export function readImageFile(path: string, whole: boolean): { ok: true; bytes: Uint8Array } | { ok: false; refusal: ImageFileRefusal } {
  let size: number;
  try {
    const stat = statSync(path);
    if (stat.isDirectory()) return { ok: false, refusal: { kind: "unreadable", reason: "it is a directory" } };
    size = stat.size;
  } catch (error) {
    return { ok: false, refusal: { kind: "unreadable", reason: unreadableReason(error) } };
  }
  if (size > ARTIFACT_COMMENT_IMAGE_MAX_BYTES) return { ok: false, refusal: { kind: "too_large", sizeBytes: size } };
  let bytes: Uint8Array;
  try {
    bytes = whole ? new Uint8Array(readFileSync(path)) : readHead(path, ARTIFACT_COMMENT_IMAGE_TYPE_BYTES);
  } catch (error) {
    return { ok: false, refusal: { kind: "unreadable", reason: unreadableReason(error) } };
  }
  // It may have grown since it was looked at: the bytes read are the ones checked.
  if (bytes.byteLength > ARTIFACT_COMMENT_IMAGE_MAX_BYTES) return { ok: false, refusal: { kind: "too_large", sizeBytes: bytes.byteLength } };
  if (artifactCommentImageTypeOf(bytes) === null) return { ok: false, refusal: { kind: "not_image" } };
  return { ok: true, bytes };
}

/**
 * One image's upload through the CLI's client (`POST …/:artifact/comment-images`,
 * the raw bytes), for artifactsCommentImageUpload: null when the request
 * didn't reach the Server (the client throws then; a daemon proxy's answer is
 * already the CLI's error, and stays one: a review adds what it left).
 */
export function commentImageUploader(client: Pick<ApiClient, "requestRawBody">) {
  return async (artifact: string, bytes: Uint8Array) => {
    const path = buildAgentApiRawRoutePath("artifactCommentImageUpload", { params: { artifact } }) as string;
    let res: ApiResponse<unknown>;
    try {
      res = await client.requestRawBody<unknown>("POST", path, bytes);
    } catch (error) {
      if (error instanceof CliError) throw error;
      return null;
    }
    return { status: res.status, body: res.ok ? res.data : res.errorBody ?? { error: res.error, code: res.errorCode } };
  };
}

/** The upload route isn't there (a 404 with no Artifacts code): a Server from before images. */
export function imagesUnsupported(failure: RaftFailure): boolean {
  return failure.error.status === 404 && failure.error.serverCode === undefined;
}

/**
 * An image upload's refusal as the CLI's error: a Server without the route
 * (a 404 with no Artifacts code) under its own code; a request that didn't
 * reach the Server, which posted nothing, says to run the same command again
 * (`again`); else as any Artifacts failure. `rateLimitedLeftBehind`: what a
 * refusal over the rate limit left behind, said before its wait.
 */
export function imageUploadCliError(failure: RaftFailure, again: string, rateLimitedLeftBehind: string): CliError {
  const { error } = failure;
  if (imagesUnsupported(failure)) {
    return new CliError({ code: "UNSUPPORTED_BY_SERVER", message: error.message, suggestedNextAction: error.nextAction });
  }
  if (error.code === "TRANSPORT_ERROR") {
    return new CliError({ code: "ARTIFACT_FAILED", message: error.message, suggestedNextAction: `Check the connection to the Raft Server, then run the same command again:\n${again}`, retryable: true });
  }
  return artifactCliError(failure, again, rateLimitedLeftBehind);
}
