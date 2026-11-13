// Workspace Artifact operations (feat/workspace-artifacts S1a, the read side):
// list, read, comments and a file as JSON, plus the binary file download the
// CLI saves to disk; then pushing, commenting, following, moving to the
// whole server, deleting, saving an attachment, reading a version's
// publish check (and its screenshots), and images in comments (uploading one,
// downloading one). The CLI's `raft artifact …` and the
// SDK's `artifacts.*` both run these, so a Computer agent and a cloud agent
// get the same text (agentText/artifacts.ts). The Server answers data and
// error codes; the sentences, including every error's next step, are written
// here.
//
// An `artifact` argument is an id, a link or a title (or the old name of an
// Artifact from before titles): links are parsed here (parseArtifactRef) and
// their id is sent; anything else is sent as written, trimmed, for the
// Server to read as an id, a title or an old name.

import { z } from "zod";

import type { AgentApiClient, AgentApiClientResult } from "../agentApiClient";
import {
  AGENT_API_ARTIFACT_ERROR_CODES,
  AGENT_API_ARTIFACT_LIST_MAX_LIMIT,
  AGENT_API_ARTIFACT_SEARCH_QUERY_MAX_CHARS,
  AGENT_API_ARTIFACT_MAX_COMMENT_CHARS,
  AGENT_API_ARTIFACT_MAX_COMMENT_IMAGES,
  AGENT_API_ARTIFACT_MAX_REVIEW_COMMENTS,
  AGENT_API_ARTIFACT_MAX_TITLE_CHARS,
  agentApiArtifactCommentImageSchema,
  type AgentApiArtifactCommentCreated,
  type AgentApiArtifactCommentImage,
  type AgentApiArtifactCommentsResponse,
  type AgentApiArtifactDeleted,
  type AgentApiArtifactFileContentResponse,
  type AgentApiArtifactListResponse,
  type AgentApiArtifactMoved,
  type AgentApiArtifactPublishBody,
  type AgentApiArtifactPublished,
  type AgentApiArtifactReadResponse,
  type AgentApiArtifactReviewCreated,
  type AgentApiArtifactSaved,
  type AgentApiArtifactSubscriptionResponse,
  type AgentApiArtifactThreadResolution,
} from "../agentApiArtifactsContract";
import type { AgentApiArtifactCheckResponse, AgentApiArtifactCheckStatus } from "../agentApiArtifactChecksContract";
import { agentApiContract, type AgentApiRouteKey } from "../agentApiContract";
import { buildAgentApiRawRoutePath } from "../agentApiRawClient";
import { foldAgentOneLineText } from "../agentMessageText";
import { ARTIFACT_COMMENT_IMAGE_MAX_BYTES, artifactCommentImageTypeOf, type ArtifactCommentImageType } from "../artifactCommentLimits";
import type { AttachmentTransport } from "./attachments";
import {
  ARTIFACT_CHECK_POLL_MS,
  ARTIFACT_CHECK_WAIT_MS,
  formatArtifactCheck,
  formatArtifactCheckWaiting,
  formatArtifactCommented,
  formatArtifactCommentImageRefusal,
  formatArtifactCommentImagesUnsupported,
  formatArtifactCommentImageUploaded,
  formatArtifactComments,
  formatArtifactDeleted,
  formatArtifactError,
  formatArtifactFileContent,
  formatArtifactList,
  formatArtifactMoved,
  formatArtifactPublished,
  formatArtifactRead,
  formatArtifactReviewCommentImageRefusal,
  formatArtifactReviewCommentImageUploadRefusal,
  formatArtifactReviewCommentRefusal,
  formatArtifactReviewed,
  formatArtifactSaved,
  formatArtifactSubscription,
  formatArtifactThreadResolution,
  type ArtifactErrorCode,
  type ArtifactErrorInput,
  type ArtifactReviewCommentPlace,
} from "../agentText/artifacts";
import { artifactFileType, artifactTitleFromHtml } from "../artifactFiles";
import { isWellFormedArtifactFilePath } from "../artifactFilePath";
import { isArtifactName, parseArtifactRef } from "../artifactRef";
import { lazySchema } from "../lazySchema";
import { ARTIFACT_CHECK_SHOTS, type ArtifactCheckShot } from "../webArtifactsContract";
import type { RaftHintOptions, RaftHintStyle } from "./hint";
import { failureFromClientResult, failureOutcome, keyedWriteFailure, opError, opErrorFromClientError, validateOpRequest, type RaftFailure, type RaftOpError, type RaftOutcome } from "./outcome";
import { requestSchema } from "./requestSchema";

const artifactArg = () => z.string().min(1).describe("The artifact: its id, a link to it, or its exact title.");
const versionArg = () => z.number().int().positive().optional().describe("A version number (default: the current version).");

export const artifactsListRequestSchema = lazySchema("artifactsListRequestSchema", () => requestSchema<{ query?: string; target?: string; cursor?: string; limit?: number }>()(z.object({
  query: z.string().trim().min(1, { message: "query has no words: leave it out to list every artifact" })
    .refine((value) => Array.from(value).length <= AGENT_API_ARTIFACT_SEARCH_QUERY_MAX_CHARS, { message: `query is longer than ${AGENT_API_ARTIFACT_SEARCH_QUERY_MAX_CHARS} characters: use fewer words` })
    .optional()
    .describe("Search titles: only artifacts whose title has every word of it, most relevant first."),
  target: z.string().min(1).optional().describe("Only artifacts whose home is this conversation (#channel, dm:@peer; a thread means its conversation)."),
  cursor: z.string().min(1).optional().describe("The cursor from the previous page's More line."),
  limit: z.number().int().positive().max(AGENT_API_ARTIFACT_LIST_MAX_LIMIT).optional().describe("Artifacts per page."),
})));

export const artifactsReadRequestSchema = lazySchema("artifactsReadRequestSchema", () => requestSchema<{ artifact: string; version?: number; files?: boolean }>()(z.object({
  artifact: artifactArg(),
  version: versionArg(),
  files: z.boolean().optional().describe("List every file instead of the first few."),
})));

export const artifactsCommentsRequestSchema = lazySchema("artifactsCommentsRequestSchema", () => requestSchema<{ artifact: string; path?: string; all?: boolean; cursor?: string; review?: string }>()(z.object({
  artifact: artifactArg(),
  review: z.string().min(1).optional().describe("Only this review's comments (its id: review=… on its comments), all of them, in order."),
  path: z.string().min(1).optional().describe("Only comments on this file."),
  all: z.boolean().optional().describe("Every comment, not only those since you last looked."),
  cursor: z.string().min(1).optional().describe("The cursor from a More line."),
})));

export const artifactsFileRequestSchema = lazySchema("artifactsFileRequestSchema", () => requestSchema<{ artifact: string; path: string; version?: number }>()(z.object({
  artifact: artifactArg(),
  path: z.string().min(1).describe("The file's path in the version, as read lists it (assets/logo.png)."),
  version: versionArg(),
})));

type ArtifactRef = { ok: true; value: string; version?: number } | { ok: false; failure: RaftFailure };

const ARTIFACT_CODES = new Set<string>(AGENT_API_ARTIFACT_ERROR_CODES);

/** A refusal made here, before any request (a bad link, path or length, no title, a move to anyone-with-link): INVALID_REQUEST, nothing was sent. */
function clientRefusal(code: "INVALID_ARTIFACT_REF" | "INVALID_PATH" | "FIELD_TOO_LONG" | "FORBIDDEN" | "TOO_MANY_COMMENTS" | "TITLE_REQUIRED", input: ArtifactErrorInput, style: RaftHintStyle): RaftFailure {
  const text = formatArtifactError(code, input, style);
  return failureOutcome(opError("INVALID_REQUEST", { message: text.message, nextAction: text.nextAction, serverCode: code }));
}

/**
 * What to send for an `artifact` argument, and a version a link pinned
 * (`/v/<n>`). A link sends its id (an old raft-artifacts.com link, its name);
 * a link that names no Artifact fails here. Anything else goes as written,
 * trimmed: the Server reads it as an id, else an exact title, else an old name.
 */
function resolveArtifactRef(input: string, style: RaftHintStyle): ArtifactRef {
  const bare = input.trim();
  const parsed = parseArtifactRef(bare);
  if (parsed.kind === "invalid") {
    if (parsed.reason === "legacy_version_link" || /^https?:\/\//i.test(bare)) {
      return { ok: false, failure: clientRefusal("INVALID_ARTIFACT_REF", { artifact: bare, legacyVersionLink: parsed.reason === "legacy_version_link" }, style) };
    }
    return { ok: true, value: bare };
  }
  // A bare short id that is also a name goes as written: the Server reads it as the id when an Artifact has
  // that id, else as a title or a name. Any other id (a link's, `pt_…`, a short id with capitals) goes as `pt_…`.
  const value = parsed.kind === "id" ? (bare !== parsed.id && isArtifactName(bare) ? bare : parsed.id as string) : parsed.name;
  return parsed.version === undefined ? { ok: true, value } : { ok: true, value, version: parsed.version };
}

/** A path the Server refuses (400 INVALID_PATH), refused here first: the Server's own rule, shared. */
function invalidPath(path: string): boolean {
  return !isWellFormedArtifactFilePath(path);
}

function errorDetails(response: unknown): Record<string, unknown> | null {
  if (!response || typeof response !== "object") return null;
  const details = (response as { details?: unknown }).details;
  return details && typeof details === "object" && !Array.isArray(details) ? details as Record<string, unknown> : null;
}

/**
 * A Server refusal: the SDK's standard classification (status, retryable,
 * NOT_FOUND / UNAVAILABLE / …), in the Artifacts' own words when the Server
 * sent one of their codes.
 */
function failureFrom<K extends AgentApiRouteKey>(
  result: Extract<AgentApiClientResult<K>, { ok: false }>,
  input: ArtifactErrorInput,
  style: RaftHintStyle,
): RaftFailure {
  const error = result.error;
  if (error.kind === "http" && typeof error.errorCode === "string" && ARTIFACT_CODES.has(error.errorCode)) {
    // The refusal body's details win; when a refusal has none (an older client's binary
    // transport dropped the body), the details the caller already knows stand in.
    const text = formatArtifactError(error.errorCode as ArtifactErrorCode, { ...input, details: errorDetails(error.response) ?? input.details ?? null }, style);
    return failureOutcome({ ...opErrorFromClientError(error, result.status), message: text.message, nextAction: text.nextAction, serverCode: error.errorCode });
  }
  return failureFromClientResult(result);
}

export async function artifactsList(
  client: Pick<AgentApiClient, "artifacts">,
  request: { query?: string; target?: string; cursor?: string; limit?: number },
  options: RaftHintOptions = {},
): Promise<RaftOutcome<AgentApiArtifactListResponse, "artifacts" | "empty">> {
  const style = options.hints ?? "cli";
  const invalid = validateOpRequest(artifactsListRequestSchema, request); if (invalid) return invalid;
  const query = request.query?.trim();
  const result = await client.artifacts.list({
    ...(query === undefined ? {} : { query }),
    ...(request.target === undefined ? {} : { target: request.target }),
    ...(request.cursor === undefined ? {} : { cursor: request.cursor }),
    ...(request.limit === undefined ? {} : { limit: String(request.limit) }),
  });
  if (!result.ok) return failureFrom(result, { target: request.target }, style);
  return { ok: true, state: result.data.artifacts.length > 0 ? "artifacts" : "empty", data: result.data, next: null, text: formatArtifactList(result.data, style, { limit: request.limit, query }) };
}

/**
 * Whether any Artifact the agent can see matches a message search's query
 * (one row asked for), for the line message search adds. Any refusal (the
 * Server's Artifacts off, a query it can't take) is "no": the line is a
 * pointer, never a reason for the search itself to fail. An answer without
 * `matches` came from a Server that ignored the query (no search yet): "no".
 */
export async function artifactsMatchQuery(
  client: Pick<AgentApiClient, "artifacts">,
  request: { query: string; target?: string },
): Promise<boolean> {
  const query = request.query.trim();
  if (!query || Array.from(query).length > AGENT_API_ARTIFACT_SEARCH_QUERY_MAX_CHARS) return false;
  try {
    const result = await client.artifacts.list({ query, ...(request.target === undefined ? {} : { target: request.target }), limit: "1" });
    return result.ok && result.data.artifacts[0]?.matches !== undefined;
  } catch {
    return false;
  }
}

/** How long a message search, once answered, still waits for the Artifacts probe before printing without its line. */
export const ARTIFACTS_PROBE_GRACE_MS = 300;

/** The probe's answer if it comes within `ms`, else "no". */
export async function probeWithin(probe: Promise<boolean>, ms: number = ARTIFACTS_PROBE_GRACE_MS): Promise<boolean> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const late = new Promise<boolean>((resolve) => {
    timer = setTimeout(() => resolve(false), ms);
  });
  try {
    return await Promise.race([probe, late]);
  } finally {
    clearTimeout(timer);
  }
}

export async function artifactsRead(
  client: Pick<AgentApiClient, "artifacts">,
  request: { artifact: string; version?: number; files?: boolean },
  options: RaftHintOptions = {},
): Promise<RaftOutcome<AgentApiArtifactReadResponse, "read">> {
  const style = options.hints ?? "cli";
  const invalid = validateOpRequest(artifactsReadRequestSchema, request); if (invalid) return invalid;
  const ref = resolveArtifactRef(request.artifact, style); if (!ref.ok) return ref.failure;
  const version = request.version ?? ref.version;
  const result = await client.artifacts.read({ artifact: ref.value }, version === undefined ? {} : { version: String(version) });
  if (!result.ok) return failureFrom(result, { artifact: ref.value, version }, style);
  return { ok: true, state: "read", data: result.data, next: null, text: formatArtifactRead(result.data, style, { allFiles: request.files === true }) };
}

export async function artifactsComments(
  client: Pick<AgentApiClient, "artifacts">,
  request: { artifact: string; path?: string; all?: boolean; cursor?: string; review?: string },
  options: RaftHintOptions = {},
): Promise<RaftOutcome<AgentApiArtifactCommentsResponse, "comments" | "empty">> {
  const style = options.hints ?? "cli";
  const invalid = validateOpRequest(artifactsCommentsRequestSchema, request); if (invalid) return invalid;
  const ref = resolveArtifactRef(request.artifact, style); if (!ref.ok) return ref.failure;
  if (request.path !== undefined && invalidPath(request.path)) return clientRefusal("INVALID_PATH", { artifact: ref.value, path: request.path }, style);
  const result = await client.artifacts.comments({ artifact: ref.value }, {
    ...(request.path === undefined ? {} : { path: request.path }),
    // `review` lists all of a review's comments; `all` with it keeps a Server from before S8
    // (which ignores `review`) from listing only the unseen ones and marking them seen.
    ...(request.all || request.review !== undefined ? { all: "1" as const } : {}),
    ...(request.cursor === undefined ? {} : { cursor: request.cursor }),
    ...(request.review === undefined ? {} : { review: request.review }),
  });
  if (!result.ok) return failureFrom(result, { artifact: ref.value, path: request.path }, style);
  return { ok: true, state: result.data.comments.length > 0 ? "comments" : "empty", data: result.data, next: null, text: formatArtifactComments(result.data, style, { review: request.review }) };
}

/** One file as JSON: a text file's content (cut at 256 KiB), or a binary file's short-lived download URL. */
export async function artifactsFileContent(
  client: Pick<AgentApiClient, "artifacts">,
  request: { artifact: string; path: string; version?: number },
  options: RaftHintOptions = {},
): Promise<RaftOutcome<AgentApiArtifactFileContentResponse, "text" | "binary">> {
  const style = options.hints ?? "cli";
  const invalid = validateOpRequest(artifactsFileRequestSchema, request); if (invalid) return invalid;
  const ref = resolveArtifactRef(request.artifact, style); if (!ref.ok) return ref.failure;
  if (invalidPath(request.path)) return clientRefusal("INVALID_PATH", { artifact: ref.value, path: request.path }, style);
  const version = request.version ?? ref.version;
  const result = await client.artifacts.fileContent({ artifact: ref.value, path: request.path }, version === undefined ? {} : { version: String(version) });
  if (!result.ok) return failureFrom(result, { artifact: ref.value, path: request.path, version }, style);
  return { ok: true, state: result.data.kind, data: result.data, next: null, text: formatArtifactFileContent(result.data) };
}

/** One file's exact bytes (a typed method: binary results are not model tool results). The CLI saves them with `--output`. */
export async function artifactsFile(
  client: Pick<AgentApiClient, "artifacts">,
  request: { artifact: string; path: string; version?: number },
  options: RaftHintOptions = {},
): Promise<RaftOutcome<{ bytes: Uint8Array; artifact: string; path: string; version?: number }, "downloaded">> {
  const style = options.hints ?? "cli";
  const invalid = validateOpRequest(artifactsFileRequestSchema, request); if (invalid) return invalid;
  const ref = resolveArtifactRef(request.artifact, style); if (!ref.ok) return ref.failure;
  if (invalidPath(request.path)) return clientRefusal("INVALID_PATH", { artifact: ref.value, path: request.path }, style);
  const version = request.version ?? ref.version;
  const result = await client.artifacts.file({ artifact: ref.value, path: request.path }, version === undefined ? {} : { version: String(version) });
  if (!result.ok) return failureFrom(result, { artifact: ref.value, path: request.path, version }, style);
  const data = { bytes: result.data, artifact: ref.value, path: request.path, ...(version === undefined ? {} : { version }) };
  return { ok: true, state: "downloaded", data, next: null, text: `${request.path}: ${result.data.byteLength} bytes\n` };
}

// ---- publish check (#130) ---------------------------------------------------------

export { ARTIFACT_CHECK_POLL_MS, ARTIFACT_CHECK_WAIT_MS };

export const artifactsCheckRequestSchema = lazySchema("artifactsCheckRequestSchema", () => requestSchema<{ artifact: string; version?: number; wait?: boolean }>()(z.object({
  artifact: artifactArg(),
  version: versionArg(),
  wait: z.boolean().optional().describe(`While the check is pending or running, wait for it to finish: up to ${ARTIFACT_CHECK_WAIT_MS / 1000} s, asking every ${ARTIFACT_CHECK_POLL_MS / 1000} s.`),
})));

export const artifactsCheckShotRequestSchema = lazySchema("artifactsCheckShotRequestSchema", () => requestSchema<{ artifact: string; version?: number; shot: ArtifactCheckShot }>()(z.object({
  artifact: artifactArg(),
  version: versionArg(),
  shot: z.enum(ARTIFACT_CHECK_SHOTS).describe("Which screenshot: desktop (1280x800) or phone (390x844 at 2x)."),
})));

/** A version's publish check, and whether a wait for it ran out (`wait` with the check still pending or running). */
export type RaftArtifactCheck = AgentApiArtifactCheckResponse & { timedOut: boolean };

/** `artifactsCheck`'s options: the hint style, and (tests) the clock it waits on; `onWait` is told once when a wait starts. */
export interface ArtifactsCheckOptions extends RaftHintOptions {
  sleep?: (ms: number) => Promise<void>;
  now?: () => number;
  /** Called once when the wait starts, with its line (`Waiting up to 90 s for the publish check of v13…`) and the version waited on. */
  onWait?: (text: string, version: number) => void;
}

function unfinished(check: AgentApiArtifactCheckResponse["check"]): boolean {
  return check !== null && (check.status === "pending" || check.status === "running");
}

const sleepFor = (ms: number) => new Promise<void>((resolve) => {
  setTimeout(resolve, ms);
});

/**
 * Read a version's publish check (default the current version's; a `/v/<n>` link pins one).
 * With `wait`, a pending or running check is asked again every ARTIFACT_CHECK_POLL_MS until it
 * is neither or ARTIFACT_CHECK_WAIT_MS have passed since the call started (`timedOut`): the
 * check runs within a minute or so of the push. The wait stays on the version the first answer
 * read, so a push meanwhile doesn't change the check waited on. State: the check's status, or
 * `none` when the version has no check.
 */
export async function artifactsCheck(
  client: Pick<AgentApiClient, "artifacts">,
  request: { artifact: string; version?: number; wait?: boolean },
  options: ArtifactsCheckOptions = {},
): Promise<RaftOutcome<RaftArtifactCheck, AgentApiArtifactCheckStatus | "none">> {
  const style = options.hints ?? "cli";
  const invalid = validateOpRequest(artifactsCheckRequestSchema, request); if (invalid) return invalid;
  const ref = resolveArtifactRef(request.artifact, style); if (!ref.ok) return ref.failure;
  const version = request.version ?? ref.version;
  const now = options.now ?? Date.now;
  const sleep = options.sleep ?? sleepFor;
  const started = now();
  let result = await client.artifacts.check({ artifact: ref.value }, version === undefined ? {} : { version: String(version) });
  if (!result.ok) return failureFrom(result, { artifact: ref.value, version }, style);
  let timedOut = false;
  if (request.wait === true && unfinished(result.data.check)) {
    const pinned = result.data.version;
    options.onWait?.(formatArtifactCheckWaiting(pinned), pinned);
    while (unfinished(result.data.check)) {
      const left = started + ARTIFACT_CHECK_WAIT_MS - now();
      if (left <= 0) {
        timedOut = true;
        break;
      }
      await sleep(Math.min(ARTIFACT_CHECK_POLL_MS, left));
      result = await client.artifacts.check({ artifact: ref.value }, { version: String(pinned) });
      if (!result.ok) return failureFrom(result, { artifact: ref.value, version: pinned }, style);
    }
  }
  const data: RaftArtifactCheck = { ...result.data, timedOut };
  return {
    ok: true,
    state: data.check?.status ?? "none",
    data,
    next: null,
    text: formatArtifactCheck(result.data, style, { timedOut }),
  };
}

/** One screenshot of a version's publish check, as PNG bytes (a typed method: binary results are not model tool results). */
export async function artifactsCheckShot(
  client: Pick<AgentApiClient, "artifacts">,
  request: { artifact: string; version?: number; shot: ArtifactCheckShot },
  options: RaftHintOptions = {},
): Promise<RaftOutcome<{ bytes: Uint8Array; artifact: string; shot: ArtifactCheckShot; version?: number }, "downloaded">> {
  const style = options.hints ?? "cli";
  const invalid = validateOpRequest(artifactsCheckShotRequestSchema, request); if (invalid) return invalid;
  const ref = resolveArtifactRef(request.artifact, style); if (!ref.ok) return ref.failure;
  const version = request.version ?? ref.version;
  const result = await client.artifacts.checkShot({ artifact: ref.value, shot: request.shot }, version === undefined ? {} : { version: String(version) });
  if (!result.ok) {
    return failureFrom(result, { artifact: ref.value, version, details: { shot: request.shot, ...(version === undefined ? {} : { version }) } }, style);
  }
  const data = { bytes: result.data, artifact: ref.value, shot: request.shot, ...(version === undefined ? {} : { version }) };
  return { ok: true, state: "downloaded", data, next: null, text: `${request.shot} screenshot: ${result.data.byteLength} bytes\n` };
}

// ---- push (S1b) ---------------------------------------------------------------

/** One file to push, flat for model tools: `path` and exactly one of `content`, `content_base64`, or `sha256` with `size`. */
const publishFileArg = () => z.object({
  path: z.string().min(1).describe("The file's path in the artifact (assets/app.js)."),
  content: z.string().optional().describe("A text file's UTF-8 content."),
  content_base64: z.string().optional().describe("A binary file's bytes, base64."),
  sha256: z.string().optional().describe("With size: a file whose bytes the Server already has (the same bytes pushed before). Otherwise send content or content_base64."),
  size: z.number().int().nonnegative().optional().describe("With sha256: the file's size in bytes."),
}).strict();

export const artifactsPublishRequestSchema = lazySchema("artifactsPublishRequestSchema", () => requestSchema<ArtifactsPublishJsonRequest>()(z.object({
  artifact: z.string().min(1).optional().describe("The artifact to push a new version of (id, link or exact title). Leave it out to create one."),
  target: z.string().min(1).optional().describe("A new artifact's home: the conversation whose members can see it (#channel, dm:@peer)."),
  title: z.string().optional().describe("The title (up to 300 characters). Required for a new artifact unless its entry page has a <title>. For an existing one, a new title with no other change renames it without a new version."),
  description: z.string().optional().describe("What the artifact is (up to 1000 characters)."),
  entry: z.string().optional().describe("The file it opens at. Default: the base's; index.html or the only file for a new one."),
  note: z.string().optional().describe("What changed in this version (up to 500 characters)."),
  label: z.string().optional().describe("A short name for this version (up to 60 characters)."),
  base: z.number().int().positive().optional().describe("The version number your files were made from (required for a new version: the number read returned)."),
  files: z.array(publishFileArg()).describe("Files to add or replace; files not listed carry over from base."),
  delete: z.array(z.string().min(1)).optional().describe("Paths to remove."),
})));

/** One file as a model sends it: `path` and exactly one of `content`, `content_base64`, or `sha256` + `size`. */
export interface ArtifactsPublishFileInput {
  path: string;
  content?: string;
  content_base64?: string;
  sha256?: string;
  size?: number;
}

/** A push as the operation (and a model) sends it: files inline or by sha256. */
export interface ArtifactsPublishJsonRequest {
  artifact?: string;
  target?: string;
  title?: string;
  description?: string;
  entry?: string;
  note?: string;
  label?: string;
  base?: number;
  files: ArtifactsPublishFileInput[];
  delete?: string[];
}

/** From code: files may also be raw bytes, hashed here and uploaded when the Server lacks them. */
export interface ArtifactsPublishRequest extends Omit<ArtifactsPublishJsonRequest, "files"> {
  files: Array<ArtifactsPublishJsonRequest["files"][number] | { path: string; bytes: Uint8Array }>;
  /** Override the Server-kept read position (SDK only). */
  seen?: number;
}

/** Puts one file's bytes on the Server (`PUT …/uploads/:sha256`): the CLI with its client, the SDK with fetch. */
export type ArtifactUploader = (sha256: string, bytes: Uint8Array) => Promise<{ ok: true } | { ok: false; failure: RaftFailure }>;

/** A listed file's bytes when the request carries them (not one listed by sha256 alone). */
function bytesOf(file: ArtifactsPublishRequest["files"][number]): Uint8Array | null {
  if ("bytes" in file) return file.bytes;
  if (file.content !== undefined) return new TextEncoder().encode(file.content);
  if (file.content_base64 === undefined) return null;
  try {
    return Uint8Array.from(atob(file.content_base64), (c) => c.charCodeAt(0));
  } catch {
    return null;
  }
}

/** How much of an entry page is read for its `<title>` (it belongs in `<head>`). */
const ENTRY_TITLE_SCAN_BYTES = 1024 * 1024;

/**
 * A new artifact's title when its push gives none: its entry page's
 * `<title>`, cut to the title limit. The entry as the Server picks it for a
 * new one: `entry`, else the only file, else index.html. Null when the entry
 * isn't a page whose bytes the request carries, or the page has no title.
 */
function entryPageTitle(request: ArtifactsPublishRequest): { entry: string; title: string | null } {
  const files = request.files ?? [];
  const entry = request.entry ?? (files.length === 1 ? files[0]!.path : "index.html");
  const file = files.find((f) => f.path === entry);
  const bytes = file && artifactFileType(entry).kind === "html" ? bytesOf(file) : null;
  const title = bytes ? artifactTitleFromHtml(new TextDecoder().decode(bytes.subarray(0, ENTRY_TITLE_SCAN_BYTES))) : null;
  return { entry, title: title === null ? null : [...title].slice(0, AGENT_API_ARTIFACT_MAX_TITLE_CHARS).join("").trim() };
}

async function sha256Hex(bytes: Uint8Array): Promise<string> {
  const copy = new Uint8Array(bytes.byteLength);
  copy.set(bytes);
  const digest = await crypto.subtle.digest("SHA-256", copy.buffer);
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

/**
 * Push a new Artifact (`target`) or a new version (`artifact` + `base`).
 * Files given as bytes are listed by sha256; when the Server answers
 * `missing`, they are uploaded with `upload` and the same request is sent
 * once more. Refusals (BASE_MOVED, UNSEEN_CHANGES, limits, …) come back in the
 * Artifacts' own words with a next step.
 */
export async function artifactsPublish(
  client: Pick<AgentApiClient, "artifacts">,
  request: ArtifactsPublishRequest,
  options: RaftHintOptions & { upload?: ArtifactUploader; dir?: string } = {},
): Promise<RaftOutcome<AgentApiArtifactPublished, "pushed" | "replayed">> {
  const style = options.hints ?? "cli";
  const bytesBySha = new Map<string, Uint8Array>();
  const files: ArtifactsPublishJsonRequest["files"] = [];
  for (const file of request.files ?? []) {
    if ("bytes" in file) {
      const sha256 = await sha256Hex(file.bytes);
      bytesBySha.set(sha256, file.bytes);
      files.push({ path: file.path, sha256, size: file.bytes.byteLength });
    } else {
      files.push(file);
    }
  }
  const { seen, ...rest } = request;
  const json: ArtifactsPublishJsonRequest = { ...rest, files };
  const invalid = validateOpRequest(artifactsPublishRequestSchema, json); if (invalid) return invalid;
  // A new artifact needs a title: the one given, else its entry page's <title>. A blank one is never a title.
  let title = json.title;
  if (title !== undefined && title.trim() === "") {
    return clientRefusal("TITLE_REQUIRED", { artifact: json.artifact?.trim(), dir: options.dir, target: json.target, publishing: true, details: { blank: true } }, style);
  }
  if (json.artifact === undefined && title === undefined) {
    const page = entryPageTitle(request);
    if (page.title === null) return clientRefusal("TITLE_REQUIRED", { dir: options.dir, target: json.target, publishing: true, details: { entry: page.entry } }, style);
    title = page.title;
  }
  const wire: AgentApiArtifactPublishBody["files"] = [];
  for (const [i, f] of files.entries()) {
    const given = [f.content !== undefined, f.content_base64 !== undefined, f.sha256 !== undefined || f.size !== undefined].filter(Boolean).length;
    if (given !== 1 || (f.sha256 !== undefined) !== (f.size !== undefined)) {
      return failureOutcome(opError("INVALID_REQUEST", {
        message: `files[${i}] (${f.path}): give exactly one of content (text), content_base64 (binary), or sha256 with size. Nothing was sent.`,
        nextAction: "Send text files as content and binary files as content_base64.",
      }));
    }
    wire.push(f.content !== undefined ? { path: f.path, content: f.content }
      : f.content_base64 !== undefined ? { path: f.path, content_base64: f.content_base64 }
      : { path: f.path, sha256: f.sha256!, size: f.size! });
  }
  let artifact: string | undefined;
  if (json.artifact !== undefined) {
    const ref = resolveArtifactRef(json.artifact, style); if (!ref.ok) return ref.failure;
    artifact = ref.value;
  }
  for (const path of [...files.map((f) => f.path), ...(json.delete ?? [])]) {
    if (invalidPath(path)) return clientRefusal("INVALID_PATH", { artifact, path, dir: options.dir, publishing: true }, style);
  }
  const body: AgentApiArtifactPublishBody = {
    ...json,
    ...(title === undefined ? {} : { title }),
    files: wire,
    ...(artifact === undefined ? {} : { artifact }),
    ...(seen === undefined ? {} : { seen }),
  };
  const input: ArtifactErrorInput = { artifact: artifact ?? title, dir: options.dir, target: json.target, publishing: true };

  for (let attempt = 0; attempt < 2; attempt += 1) {
    const result = await client.artifacts.push(body);
    if (!result.ok) return failureFrom(result, input, style);
    const data = result.data;
    if ("missing" in data && !("artifact" in data)) {
      if (attempt > 0) {
        return failureOutcome(opError("UNAVAILABLE", { message: "The Server still lacks some files' bytes after they were uploaded.", nextAction: "Push again in a moment." }));
      }
      for (const sha256 of data.missing) {
        const bytes = bytesBySha.get(sha256);
        if (!bytes || !options.upload) {
          const path = files.find((f) => f.sha256 === sha256)?.path ?? sha256;
          return failureOutcome(opError("INVALID_REQUEST", {
            message: `The Server doesn't have the bytes of ${path}.`,
            nextAction: "Send that file inline instead (content for text, content_base64 for binary), or upload its bytes first.",
          }));
        }
        const uploaded = await options.upload(sha256, bytes);
        if (!uploaded.ok) return uploaded.failure;
      }
      continue;
    }
    const published = data as AgentApiArtifactPublished;
    return { ok: true, state: published.replayed ? "replayed" : "pushed", data: published, next: null, text: formatArtifactPublished(published, style, { dir: options.dir, ...(json.target === undefined ? {} : { target: json.target }) }) };
  }
  return failureOutcome(opError("UNAVAILABLE"));
}

/** An upload's HTTP answer as an outcome: 204 is done; a refusal in the Artifacts' words. */
export function artifactUploadFailure(status: number, errorBody: unknown, style: RaftHintStyle, dir?: string): RaftFailure {
  const b = (errorBody && typeof errorBody === "object" ? errorBody : {}) as { error?: unknown; code?: unknown; errorCode?: unknown; details?: unknown };
  const code = typeof b.code === "string" ? b.code : typeof b.errorCode === "string" ? b.errorCode : null;
  const error = {
    kind: "http" as const,
    reason: "http_error" as const,
    message: typeof b.error === "string" ? b.error : `HTTP ${status}`,
    status,
    errorCode: code,
    response: errorBody,
  };
  if (code && ARTIFACT_CODES.has(code)) {
    // An upload is only ever part of a push.
    const text = formatArtifactError(code as ArtifactErrorCode, { dir, publishing: true, details: errorDetails(errorBody) }, style);
    return failureOutcome({ ...opErrorFromClientError(error, status), message: text.message, nextAction: text.nextAction, serverCode: code });
  }
  return failureOutcome(opErrorFromClientError(error, status));
}

/**
 * The SDK's uploader: `PUT …/uploads/:sha256` with the raw bytes over fetch
 * (the JSON transport can't carry a raw body). 204 is done.
 */
export function artifactUploaderForFetch(transport: AttachmentTransport, style: RaftHintStyle = "cli"): ArtifactUploader {
  return async (sha256, bytes) => {
    const headers = new Headers(transport.headers);
    headers.set("content-type", "application/octet-stream");
    headers.set("accept", "application/json");
    headers.set("authorization", transport.authorization);
    const body = new Uint8Array(bytes.byteLength);
    body.set(bytes);
    let response: Response;
    try {
      response = await transport.fetch(`${transport.serverUrl}${agentApiContract.artifactUpload.fullPath.replace(":sha256", sha256)}`, { method: "PUT", headers, body: body.buffer });
    } catch {
      return { ok: false, failure: failureOutcome(opError("TRANSPORT_ERROR")) };
    }
    if (response.ok) return { ok: true };
    let errorBody: unknown = null;
    try {
      errorBody = await response.json();
    } catch {
      errorBody = null;
    }
    return { ok: false, failure: artifactUploadFailure(response.status, errorBody, style) };
  };
}

/** One file's bytes onto the Server (typed method: binary input has no tool form). Usually `artifacts.push` does this itself. */
export async function artifactsUpload(
  transport: AttachmentTransport,
  request: { bytes: Uint8Array },
  options: RaftHintOptions = {},
): Promise<RaftOutcome<{ sha256: string; size: number }, "uploaded">> {
  if (!(request.bytes instanceof Uint8Array)) return failureOutcome(opError("INVALID_REQUEST", { message: "bytes must be a Uint8Array." }));
  const sha256 = await sha256Hex(request.bytes);
  const uploaded = await artifactUploaderForFetch(transport, options.hints ?? "cli")(sha256, request.bytes);
  if (!uploaded.ok) return uploaded.failure;
  return { ok: true, state: "uploaded", data: { sha256, size: request.bytes.byteLength }, next: null, text: `Uploaded ${request.bytes.byteLength} bytes (sha256 ${sha256}). List the file in artifacts.push as { path, sha256, size }.\n` };
}

// ---- comments and following (S1c) ----------------------------------------------

export const artifactsCommentRequestSchema = lazySchema("artifactsCommentRequestSchema", () => requestSchema<{ artifact: string; body: string; path?: string; version?: number; replyTo?: string; images?: string[] }>()(z.object({
  artifact: artifactArg(),
  body: z.string().describe("The comment. @name tells that agent at once (if it can see the artifact). May be empty when images has one."),
  path: z.string().min(1).optional().describe("The file it is about (as read lists it). Leave it out for the whole artifact; a reply is on its parent's file."),
  version: versionArg(),
  replyTo: z.string().min(1).optional().describe("The id of the comment it answers (comment=… in comments)."),
  images: z.array(z.string().trim().min(1).max(200))
    .max(AGENT_API_ARTIFACT_MAX_COMMENT_IMAGES, `a comment takes at most ${AGENT_API_ARTIFACT_MAX_COMMENT_IMAGES} images`)
    .optional()
    .describe(`Images it carries, in order (at most ${AGENT_API_ARTIFACT_MAX_COMMENT_IMAGES}): the fileId of each image uploaded for it to this artifact within the hour (the typed method artifacts.commentImageUpload).`),
}).refine((request) => /\S/.test(request.body) || (request.images?.length ?? 0) > 0, { message: "the comment is empty", path: ["body"] })));

export const artifactsFollowRequestSchema = lazySchema("artifactsFollowRequestSchema", () => requestSchema<{ artifact: string }>()(z.object({
  artifact: artifactArg(),
})));

/** Comment on an Artifact (a file of it, or the whole), or answer a comment; with `images`, images uploaded for it (artifactsCommentImageUpload). */
export async function artifactsComment(
  client: Pick<AgentApiClient, "artifacts">,
  request: { artifact: string; body: string; path?: string; version?: number; replyTo?: string; images?: string[]; seen?: number },
  options: RaftHintOptions = {},
): Promise<RaftOutcome<AgentApiArtifactCommentCreated, "commented">> {
  const style = options.hints ?? "cli";
  const { seen, ...json } = request;
  const invalid = validateOpRequest(artifactsCommentRequestSchema, json); if (invalid) return invalid;
  const ref = resolveArtifactRef(request.artifact, style); if (!ref.ok) return ref.failure;
  if (request.path !== undefined && invalidPath(request.path)) return clientRefusal("INVALID_PATH", { artifact: ref.value, path: request.path }, style);
  if ([...request.body.trim()].length > AGENT_API_ARTIFACT_MAX_COMMENT_CHARS) {
    return clientRefusal("FIELD_TOO_LONG", { artifact: ref.value, commenting: true, details: { field: "body", limit: AGENT_API_ARTIFACT_MAX_COMMENT_CHARS } }, style);
  }
  const version = request.version ?? ref.version;
  const result = await client.artifacts.comment({ artifact: ref.value }, {
    body: request.body,
    ...(request.path === undefined ? {} : { path: request.path }),
    ...(version === undefined ? {} : { version }),
    ...(request.replyTo === undefined ? {} : { replyTo: request.replyTo }),
    ...(request.images === undefined || request.images.length === 0 ? {} : { images: request.images }),
    ...(seen === undefined ? {} : { seen }),
  });
  if (!result.ok) return failureFrom(result, { artifact: ref.value, path: request.path, version, commenting: true }, style);
  return { ok: true, state: "commented", data: result.data, next: null, text: formatArtifactCommented(result.data, style) };
}

// ---- images in comments (#146) ---------------------------------------------------

/**
 * One comment image's upload (`POST …/artifacts/:artifact/comment-images`,
 * the raw bytes): its HTTP status and parsed JSON body, or null when the
 * request didn't reach the Server. The CLI sends it through its own client,
 * the SDK over fetch (artifactCommentImageUploaderForFetch).
 */
export type ArtifactCommentImageUploader = (artifact: string, bytes: Uint8Array) => Promise<{ status: number; body: unknown } | null>;

/** `artifactsCommentImageUpload`'s options: the hint style, how the caller names the image in a refusal, and the review comment it is for. */
export interface ArtifactsCommentImageUploadOptions extends RaftHintOptions {
  /**
   * The image as the caller named it (the CLI: `--image ./a.png`): a refusal
   * of the image then starts with it and says the comment wasn't posted.
   */
  named?: string;
  /**
   * The review comment the image is for (the CLI's `raft artifact review`,
   * which uploads every image before posting the review): a refusal of the
   * image itself, or its bytes cut short on the way, is that comment's
   * ("Comment 2 of 3 (a.html): image ./a.png: …"); any other refusal (the
   * server's quota or storage, an upload request without a Content-Length,
   * the Artifact, the connection) is no comment's, and gives a next step for
   * the whole review. Every one says nothing of the review was posted.
   */
  reviewComment?: ArtifactReviewCommentPlace;
}

/** The upload's refusals of the image or of storing it (not of the Artifact or the agent): said after the image's name when the caller gives one. */
const IMAGE_UPLOAD_REFUSALS: ReadonlySet<string> = new Set<ArtifactErrorCode>([
  "IMAGE_REFUSED",
  "FILE_TOO_LARGE",
  "CONTENT_LENGTH_REQUIRED",
  "SIZE_MISMATCH",
  "FILE_UPLOAD_QUOTA_EXCEEDED",
  "ARTIFACTS_STORAGE_UNAVAILABLE",
]);

/**
 * A refusal of the image itself, by its bytes (too large, too many pixels,
 * not an image): what a review's comment can fix. The server's images being
 * full, its quota and its storage are the server's, the uploader's own limit
 * there the uploader's (their drafts free it); an upload request
 * without a Content-Length is the client's (one cut short names the image
 * too, but leaves nothing to fix: artifactCommentImageUploadFailure).
 */
function refusesTheImage(code: string, details: Record<string, unknown> | null): boolean {
  return code === "FILE_TOO_LARGE" || (code === "IMAGE_REFUSED" && details?.reason !== "server_quota_exceeded" && details?.reason !== "uploader_quota_exceeded");
}

/**
 * An upload for a review's comment failed for a reason not the image's own
 * (the Artifact, the agent, the connection, the Server): say that nothing of
 * the review was posted. A rate limit is left as it is: its wait is where the
 * CLI says what was left behind.
 */
function reviewUploadFailure(error: RaftOpError, reviewComment: ArtifactReviewCommentPlace | undefined): RaftFailure {
  if (reviewComment === undefined || error.retryAfterSeconds !== undefined) return failureOutcome(error);
  return failureOutcome({ ...error, message: `${error.message} Nothing of the review was posted.` });
}

/**
 * A comment image upload's refusal as an outcome: in the Artifacts' words
 * when the Server sent one of their codes; a 404 without one is a Server from
 * before images (the route isn't there), said so, nothing posted. For a
 * review's comment (`reviewComment`), a refusal of the image itself (or its
 * bytes cut short) names that comment; the rest keep their own words, say
 * nothing of the review was posted, and give the whole review's next step
 * (never "Fix comment N").
 */
export function artifactCommentImageUploadFailure(
  status: number,
  errorBody: unknown,
  input: { artifact: string; named?: string; reviewComment?: ArtifactReviewCommentPlace },
  style: RaftHintStyle,
): RaftFailure {
  const b = (errorBody && typeof errorBody === "object" ? errorBody : {}) as { error?: unknown; code?: unknown; errorCode?: unknown };
  const code = typeof b.code === "string" ? b.code : typeof b.errorCode === "string" ? b.errorCode : null;
  const base = opErrorFromClientError({
    kind: "http",
    reason: "http_error",
    message: typeof b.error === "string" ? b.error : `HTTP ${status}`,
    status,
    errorCode: code,
    response: errorBody,
  }, status);
  if (code && ARTIFACT_CODES.has(code)) {
    const details = errorDetails(errorBody);
    const reviewing = input.reviewComment !== undefined;
    const errorInput = { artifact: input.artifact, commenting: true, uploadingImage: true, details, ...(reviewing ? { reviewing: true } : {}) };
    // Cut short on the way (SIZE_MISMATCH) names the comment and image too, its next step the same command again.
    if (input.reviewComment !== undefined && (refusesTheImage(code, details) || code === "SIZE_MISMATCH")) {
      const text = formatArtifactReviewCommentImageUploadRefusal(code as ArtifactErrorCode, { ...errorInput, ...input.reviewComment, ...(input.named === undefined ? {} : { named: input.named }) }, style);
      return failureOutcome({ ...base, message: text.message, nextAction: text.nextAction, serverCode: code });
    }
    const text = formatArtifactError(code as ArtifactErrorCode, errorInput, style);
    const message = input.named !== undefined && !reviewing && IMAGE_UPLOAD_REFUSALS.has(code)
      ? `${foldAgentOneLineText(input.named)}: ${text.message} Nothing was posted.`
      : text.message;
    return reviewUploadFailure({ ...base, message, nextAction: text.nextAction, serverCode: code }, input.reviewComment);
  }
  if (status === 404) {
    const text = formatArtifactCommentImagesUnsupported(style, { reviewing: input.reviewComment !== undefined });
    return failureOutcome({ ...base, message: text.message, nextAction: text.nextAction });
  }
  return reviewUploadFailure(base, input.reviewComment);
}

/** The SDK's comment image upload: `POST …/comment-images` with the raw bytes over fetch (the JSON transport can't carry a raw body). */
export function artifactCommentImageUploaderForFetch(transport: AttachmentTransport): ArtifactCommentImageUploader {
  return async (artifact, bytes) => {
    const path = buildAgentApiRawRoutePath("artifactCommentImageUpload", { params: { artifact } });
    if (typeof path !== "string") return null;
    const headers = new Headers(transport.headers);
    headers.set("content-type", "application/octet-stream");
    headers.set("accept", "application/json");
    headers.set("authorization", transport.authorization);
    const body = new Uint8Array(bytes.byteLength);
    body.set(bytes);
    let response: Response;
    try {
      response = await transport.fetch(`${transport.serverUrl}${path}`, { method: "POST", headers, body: body.buffer });
    } catch {
      return null;
    }
    let parsed: unknown = null;
    try {
      parsed = await response.json();
    } catch {
      parsed = null;
    }
    return { status: response.status, body: parsed };
  };
}

/**
 * Upload one image for a comment on an Artifact (a typed method: binary input
 * has no tool form): what the Server kept (`fileId`, type, size, pixel size),
 * the `fileId` going in a comment's `images` within the hour. Bytes the
 * Server would refuse (over the size limit, not a PNG, JPEG, WebP or GIF by
 * their first bytes) are refused here, nothing sent.
 */
export async function artifactsCommentImageUpload(
  upload: ArtifactCommentImageUploader,
  request: { artifact: string; bytes: Uint8Array },
  options: ArtifactsCommentImageUploadOptions = {},
): Promise<RaftOutcome<AgentApiArtifactCommentImage, "uploaded">> {
  const style = options.hints ?? "cli";
  if (typeof request.artifact !== "string" || request.artifact.trim() === "") {
    return failureOutcome(opError("INVALID_REQUEST", { message: "artifact is required: its id, link or exact title. Nothing was sent." }));
  }
  if (!(request.bytes instanceof Uint8Array)) return failureOutcome(opError("INVALID_REQUEST", { message: "bytes must be a Uint8Array. Nothing was sent." }));
  const ref = resolveArtifactRef(request.artifact, style); if (!ref.ok) return ref.failure;
  const local = request.bytes.byteLength > ARTIFACT_COMMENT_IMAGE_MAX_BYTES
    ? { kind: "too_large" as const, sizeBytes: request.bytes.byteLength }
    : artifactCommentImageTypeOf(request.bytes) === null ? { kind: "not_image" as const } : null;
  if (local) {
    const text = options.reviewComment === undefined
      ? formatArtifactCommentImageRefusal(local, options.named, style)
      : formatArtifactReviewCommentImageRefusal(local, { ...options.reviewComment, ...(options.named === undefined ? {} : { named: options.named }) }, style);
    return failureOutcome(opError("INVALID_REQUEST", { message: text.message, nextAction: text.nextAction }));
  }
  const answer = await upload(ref.value, request.bytes);
  if (answer === null) return reviewUploadFailure(opError("TRANSPORT_ERROR"), options.reviewComment);
  if (answer.status < 200 || answer.status >= 300) {
    return artifactCommentImageUploadFailure(answer.status, answer.body, { artifact: ref.value, named: options.named, reviewComment: options.reviewComment }, style);
  }
  const image = agentApiArtifactCommentImageSchema.safeParse(answer.body);
  if (!image.success) return reviewUploadFailure(opError("INVALID_RESPONSE"), options.reviewComment);
  return { ok: true, state: "uploaded", data: image.data, next: null, text: formatArtifactCommentImageUploaded(image.data, ref.value, style) };
}

export const artifactsCommentImageRequestSchema = lazySchema("artifactsCommentImageRequestSchema", () => requestSchema<{ artifact: string; fileId: string }>()(z.object({
  artifact: artifactArg(),
  fileId: z.string().trim().min(1).max(200).describe("The image's id: a comment's images list it (fileId)."),
})));

/**
 * One image of an Artifact's comments as its bytes (a typed method: binary
 * results are not model tool results), and its type read from them. The
 * CLI saves them with `raft artifact download --image`.
 */
export async function artifactsCommentImage(
  client: Pick<AgentApiClient, "artifacts">,
  request: { artifact: string; fileId: string },
  options: RaftHintOptions = {},
): Promise<RaftOutcome<{ bytes: Uint8Array; artifact: string; fileId: string; contentType: ArtifactCommentImageType | null }, "downloaded">> {
  const style = options.hints ?? "cli";
  const invalid = validateOpRequest(artifactsCommentImageRequestSchema, request); if (invalid) return invalid;
  const ref = resolveArtifactRef(request.artifact, style); if (!ref.ok) return ref.failure;
  const fileId = request.fileId.trim();
  const result = await client.artifacts.commentImage({ artifact: ref.value, fileId });
  // The id stands in for the details when the refusal body carries none.
  if (!result.ok) return failureFrom(result, { artifact: ref.value, downloadingImage: fileId, details: { fileId } }, style);
  const data = { bytes: result.data, artifact: ref.value, fileId, contentType: artifactCommentImageTypeOf(result.data) };
  return { ok: true, state: "downloaded", data, next: null, text: `image ${foldAgentOneLineText(fileId)}: ${result.data.byteLength} bytes\n` };
}

// ---- reviews (S8) ---------------------------------------------------------------

type ReviewCommentRequest = { body: string; path?: string; replyTo?: string; images?: string[] };
type ReviewRequest = { artifact: string; body?: string; version?: number; comments: ReviewCommentRequest[]; idempotencyKey?: string };

/** A review as posted, and the key it was sent with (the caller's, or the generated one). */
export type RaftArtifactReviewed = AgentApiArtifactReviewCreated & { idempotencyKey: string };

export const artifactsReviewRequestSchema = lazySchema("artifactsReviewRequestSchema", () => requestSchema<ReviewRequest>()(z.object({
  artifact: artifactArg(),
  body: z.string().optional().describe("The summary: what the review says as a whole (optional). @name tells that agent."),
  version: versionArg().describe("The version the review is on (default: the current one)."),
  comments: z.array(z.object({
    body: z.string().describe("The comment. @name tells that agent (one notice for the whole review). May be empty when images has one."),
    // No min(1) on path and replyTo: an empty one is refused below, naming the comment.
    path: z.string().optional().describe("The file it is about (as read lists it). Leave it out for the whole artifact; a reply is on its parent's file."),
    replyTo: z.string().optional().describe("The id of a comment it answers (comment=… in comments)."),
    images: z.array(z.string().trim().min(1).max(200))
      .max(AGENT_API_ARTIFACT_MAX_COMMENT_IMAGES, `a comment takes at most ${AGENT_API_ARTIFACT_MAX_COMMENT_IMAGES} images`)
      .optional()
      .describe(`Images it carries, in order (at most ${AGENT_API_ARTIFACT_MAX_COMMENT_IMAGES}): the fileId of each image uploaded for it to this artifact within the hour (the typed method artifacts.commentImageUpload), each in one comment only.`),
  }))
    .min(1, "a review needs at least one comment")
    .max(AGENT_API_ARTIFACT_MAX_REVIEW_COMMENTS, `a review holds at most ${AGENT_API_ARTIFACT_MAX_REVIEW_COMMENTS} comments: send the rest as a second review`)
    .describe(`The comments, posted together or not at all, in this order (1 to ${AGENT_API_ARTIFACT_MAX_REVIEW_COMMENTS}).`),
  idempotencyKey: z.string().optional().describe("One key per review; generated when omitted and returned. Repeat the same request with the same key to retry without posting the review twice."),
})));

function tooLong(text: string): boolean {
  return [...text.trim()].length > AGENT_API_ARTIFACT_MAX_COMMENT_CHARS;
}

/** A review refused here, before any request, for one of its comments. */
function reviewCommentRefusal(code: "EMPTY_COMMENT" | "EMPTY_PATH" | "EMPTY_REPLY_TO" | "INVALID_PATH" | "FIELD_TOO_LONG", input: ArtifactErrorInput & ArtifactReviewCommentPlace, style: RaftHintStyle): RaftFailure {
  const text = formatArtifactReviewCommentRefusal(code, input, style);
  const local = code === "EMPTY_COMMENT" || code === "EMPTY_PATH" || code === "EMPTY_REPLY_TO";
  return failureOutcome(opError("INVALID_REQUEST", { message: text.message, nextAction: text.nextAction, ...(local ? {} : { serverCode: code }) }));
}

/** A Server refusal of a review: for one comment (`details.index`) in that comment's words, else the review's. */
function reviewFailureFrom(
  result: Extract<AgentApiClientResult<"artifactReview">, { ok: false }>,
  input: ArtifactErrorInput,
  comments: readonly ReviewCommentRequest[],
  style: RaftHintStyle,
): RaftFailure {
  const error = result.error;
  // A Server without the route (from before S8): say so, not "check the target".
  if (error.kind === "http" && error.status === 404 && !(typeof error.errorCode === "string" && ARTIFACT_CODES.has(error.errorCode))) {
    const text = formatArtifactError("REVIEWS_NOT_AVAILABLE", input, style);
    return failureOutcome({ ...opErrorFromClientError(error, result.status), message: text.message, nextAction: text.nextAction, serverCode: "REVIEWS_NOT_AVAILABLE" });
  }
  const details = error.kind === "http" ? errorDetails(error.response) : null;
  const index = details?.index;
  // An index past the review's comments can't name one: the refusal is read as the review's.
  if (error.kind === "http" && typeof error.errorCode === "string" && ARTIFACT_CODES.has(error.errorCode) && typeof index === "number" && Number.isInteger(index) && index >= 0 && index < comments.length) {
    const path = typeof details?.path === "string" ? details.path : comments[index]?.path ?? null;
    const replyTo = comments[index]?.replyTo;
    const text = formatArtifactReviewCommentRefusal(error.errorCode as ArtifactErrorCode, { ...input, details, index, total: comments.length, commentPath: path, ...(replyTo === undefined ? {} : { replyTo }) }, style);
    return failureOutcome({ ...opErrorFromClientError(error, result.status), message: text.message, nextAction: text.nextAction, serverCode: error.errorCode });
  }
  return failureFrom(result, input, style);
}

/** A review's checks before any request passed: the Artifact as sent, the version and the summary to send. */
type CheckedReview = { ok: true; artifact: string; version?: number; summary?: string } | { ok: false; failure: RaftFailure };

/** Where a review's comment is, as a refusal names it. */
function reviewCommentPlace(c: { path?: unknown; replyTo?: unknown }, index: number, total: number): ArtifactReviewCommentPlace {
  const path = typeof c.path === "string" && c.path.trim() ? c.path : null;
  return { index, total, commentPath: path, ...(typeof c.replyTo === "string" && c.replyTo.trim() ? { replyTo: c.replyTo } : {}) };
}

/**
 * Every check a review gets before any request: how many comments, each
 * comment as a comment is checked (empty without images, a bad path, too
 * long, too many images), the summary; the first refusal names the comment.
 */
function checkReview(request: ReviewRequest, style: RaftHintStyle): CheckedReview {
  const refused = (failure: RaftFailure): CheckedReview => ({ ok: false, failure });
  // Counted before the schema's check, so too many reads as the Server says it (with the count).
  if (Array.isArray(request.comments) && typeof request.artifact === "string") {
    if (request.comments.length > AGENT_API_ARTIFACT_MAX_REVIEW_COMMENTS) {
      return refused(clientRefusal("TOO_MANY_COMMENTS", { artifact: request.artifact.trim(), reviewing: true, details: { count: request.comments.length, limit: AGENT_API_ARTIFACT_MAX_REVIEW_COMMENTS } }, style));
    }
    // A comment's images too, so too many names the comment.
    for (const [index, c] of request.comments.entries()) {
      const images = (c as { images?: unknown } | null)?.images;
      if (Array.isArray(images) && images.length > AGENT_API_ARTIFACT_MAX_COMMENT_IMAGES) {
        const text = formatArtifactReviewCommentImageRefusal({ kind: "too_many", count: images.length }, reviewCommentPlace(c, index, request.comments.length), style);
        return refused(failureOutcome(opError("INVALID_REQUEST", { message: text.message, nextAction: text.nextAction })));
      }
    }
  }
  const invalid = validateOpRequest(artifactsReviewRequestSchema, request); if (invalid) return refused(invalid);
  const ref = resolveArtifactRef(request.artifact, style); if (!ref.ok) return refused(ref.failure);
  const total = request.comments.length;
  for (const [index, c] of request.comments.entries()) {
    const at = { artifact: ref.value, ...reviewCommentPlace(c, index, total) };
    if (!/\S/.test(c.body) && (c.images?.length ?? 0) === 0) return refused(reviewCommentRefusal("EMPTY_COMMENT", at, style));
    if (c.path !== undefined && c.path.trim() === "") return refused(reviewCommentRefusal("EMPTY_PATH", at, style));
    if (c.replyTo !== undefined && c.replyTo.trim() === "") return refused(reviewCommentRefusal("EMPTY_REPLY_TO", at, style));
    if (c.path !== undefined && invalidPath(c.path)) return refused(reviewCommentRefusal("INVALID_PATH", at, style));
    if (tooLong(c.body)) return refused(reviewCommentRefusal("FIELD_TOO_LONG", { ...at, details: { field: "body", limit: AGENT_API_ARTIFACT_MAX_COMMENT_CHARS } }, style));
  }
  const summary = request.body !== undefined && /\S/.test(request.body) ? request.body : undefined;
  if (summary !== undefined && tooLong(summary)) {
    return refused(clientRefusal("FIELD_TOO_LONG", { artifact: ref.value, reviewing: true, details: { field: "body", limit: AGENT_API_ARTIFACT_MAX_COMMENT_CHARS } }, style));
  }
  const version = request.version ?? ref.version;
  return { ok: true, artifact: ref.value, ...(version === undefined ? {} : { version }), ...(summary === undefined ? {} : { summary }) };
}

/**
 * What artifactsReview would refuse before sending anything, without sending
 * it: the first refusal, else null. A comment's `images` are only counted
 * here, so a caller that uploads them first (the CLI, from files) checks the
 * review before spending an upload on it.
 */
export function artifactsReviewRefusal(
  request: Omit<ReviewRequest, "comments"> & { comments: Array<Omit<ReviewCommentRequest, "images"> & { images?: readonly string[] }> },
  options: RaftHintOptions = {},
): RaftFailure | null {
  // Not ids yet (the CLI's are file paths): only how many there are counts.
  const comments = Array.isArray(request.comments)
    ? request.comments.map(({ images, ...c }) => (images === undefined ? c : { ...c, images: images.map((_, i) => `image-${i + 1}`) }))
    : request.comments;
  const checked = checkReview({ ...request, comments }, options.hints ?? "cli");
  return checked.ok ? null : checked.failure;
}

/**
 * Review an Artifact: several comments (and a summary) posted together or not
 * at all, each agent told once. Each comment is checked here as a comment is
 * (an empty one, a bad path, too long, too many images), so a refusal names
 * the comment. A comment's `images` are the ids of images uploaded for it
 * (artifactsCommentImageUpload); with one its body may be empty.
 * Sent under an idempotency key (generated when not given): a retryable
 * failure says to repeat with that key, and a repeat that finds the review
 * already posted answers it (`replayed`, nothing posted or told twice).
 */
export async function artifactsReview(
  client: Pick<AgentApiClient, "artifacts">,
  request: ReviewRequest & { seen?: number },
  options: RaftHintOptions = {},
): Promise<RaftOutcome<RaftArtifactReviewed, "reviewed" | "replayed">> {
  const style = options.hints ?? "cli";
  const { seen, ...json } = request;
  const checked = checkReview(json, style); if (!checked.ok) return checked.failure;
  const { artifact, version, summary } = checked;
  const idempotencyKey = request.idempotencyKey?.trim() || globalThis.crypto.randomUUID();
  const result = await client.artifacts.review({ artifact }, {
    ...(summary === undefined ? {} : { body: summary }),
    ...(version === undefined ? {} : { version }),
    comments: request.comments.map((c) => ({
      body: c.body,
      ...(c.path === undefined ? {} : { path: c.path }),
      ...(c.replyTo === undefined ? {} : { replyTo: c.replyTo }),
      ...(c.images === undefined || c.images.length === 0 ? {} : { images: c.images }),
    })),
    ...(seen === undefined ? {} : { seen }),
    idempotencyKey,
  });
  if (!result.ok) return keyedWriteFailure(reviewFailureFrom(result, { artifact, version, reviewing: true }, request.comments, style), idempotencyKey);
  // 201 posted now; 200 the review this key had already posted.
  const replayed = result.status === 200;
  return {
    ok: true,
    state: replayed ? "replayed" : "reviewed",
    data: { ...result.data, idempotencyKey },
    next: null,
    text: formatArtifactReviewed(result.data, style, { replayed }),
  };
}

async function setFollowing(
  client: Pick<AgentApiClient, "artifacts">,
  request: { artifact: string },
  follow: boolean,
  options: RaftHintOptions,
): Promise<RaftOutcome<AgentApiArtifactSubscriptionResponse, "following" | "not_following">> {
  const style = options.hints ?? "cli";
  const invalid = validateOpRequest(artifactsFollowRequestSchema, request); if (invalid) return invalid;
  const ref = resolveArtifactRef(request.artifact, style); if (!ref.ok) return ref.failure;
  const result = follow ? await client.artifacts.subscribe({ artifact: ref.value }) : await client.artifacts.unsubscribe({ artifact: ref.value });
  if (!result.ok) return failureFrom(result, { artifact: ref.value, following: true }, style);
  return { ok: true, state: result.data.following ? "following" : "not_following", data: result.data, next: null, text: formatArtifactSubscription(result.data, style) };
}

/** Follow an Artifact: others' comments, and versions that change a file you last pushed, reach you. */
export function artifactsFollow(client: Pick<AgentApiClient, "artifacts">, request: { artifact: string }, options: RaftHintOptions = {}) {
  return setFollowing(client, request, true, options);
}

/** Stop following an Artifact (mentions still reach you; pushing or commenting won't follow it again). */
export function artifactsUnfollow(client: Pick<AgentApiClient, "artifacts">, request: { artifact: string }, options: RaftHintOptions = {}) {
  return setFollowing(client, request, false, options);
}

// ---- resolving a comment thread (#249) -------------------------------------------

export const artifactsResolveRequestSchema = lazySchema("artifactsResolveRequestSchema", () => requestSchema<{ artifact: string; comment: string; note?: string }>()(z.object({
  artifact: artifactArg(),
  comment: z.string().trim().min(1).describe("The thread's root comment: its comment=… id in comments (a reply's thread is its reply_to chain's first comment)."),
  note: z.string().trim().min(1).optional().describe("A short note posted as your reply in the thread before it is resolved: what answered it, such as the version. @name in it tells that agent."),
})));

export const artifactsReopenRequestSchema = lazySchema("artifactsReopenRequestSchema", () => requestSchema<{ artifact: string; comment: string }>()(z.object({
  artifact: artifactArg(),
  comment: z.string().trim().min(1).describe("The thread's root comment: its comment=… id in comments."),
})));

/**
 * Resolve a comment thread (by its root comment), with an optional note
 * posted first as a reply. Only the thread's author, the Artifact's author
 * (or whoever manages it, when it's an agent) and the server's owners and
 * admins may; resolving one already resolved
 * changes nothing (and posts no note), so a retry is safe.
 */
export async function artifactsResolve(
  client: Pick<AgentApiClient, "artifacts">,
  request: { artifact: string; comment: string; note?: string },
  options: RaftHintOptions = {},
): Promise<RaftOutcome<AgentApiArtifactThreadResolution, "resolved" | "already_resolved">> {
  const style = options.hints ?? "cli";
  const invalid = validateOpRequest(artifactsResolveRequestSchema, request); if (invalid) return invalid;
  const ref = resolveArtifactRef(request.artifact, style); if (!ref.ok) return ref.failure;
  const note = request.note?.trim();
  if (note !== undefined && [...note].length > AGENT_API_ARTIFACT_MAX_COMMENT_CHARS) {
    return clientRefusal("FIELD_TOO_LONG", { artifact: ref.value, commenting: true, details: { field: "body", limit: AGENT_API_ARTIFACT_MAX_COMMENT_CHARS } }, style);
  }
  const comment = request.comment.trim();
  const result = await client.artifacts.resolveComment({ artifact: ref.value, comment }, note === undefined ? {} : { note });
  if (!result.ok) return failureFrom(result, { artifact: ref.value, resolving: { comment, reopen: false }, commenting: note !== undefined }, style);
  return { ok: true, state: result.data.changed ? "resolved" : "already_resolved", data: result.data, next: null, text: formatArtifactThreadResolution(result.data, style) };
}

/** Reopen a resolved comment thread (by its root comment); one already open changes nothing. Tells no one. */
export async function artifactsReopen(
  client: Pick<AgentApiClient, "artifacts">,
  request: { artifact: string; comment: string },
  options: RaftHintOptions = {},
): Promise<RaftOutcome<AgentApiArtifactThreadResolution, "reopened" | "already_open">> {
  const style = options.hints ?? "cli";
  const invalid = validateOpRequest(artifactsReopenRequestSchema, request); if (invalid) return invalid;
  const ref = resolveArtifactRef(request.artifact, style); if (!ref.ok) return ref.failure;
  const comment = request.comment.trim();
  const result = await client.artifacts.reopenComment({ artifact: ref.value, comment });
  if (!result.ok) return failureFrom(result, { artifact: ref.value, resolving: { comment, reopen: true } }, style);
  return { ok: true, state: result.data.changed ? "reopened" : "already_open", data: result.data, next: null, text: formatArtifactThreadResolution(result.data, style) };
}

// ---- moving to the whole server and deleting ------------------------------------

export const artifactsMoveRequestSchema = lazySchema("artifactsMoveRequestSchema", () => requestSchema<{ artifact: string; to: "server" | "anyone-with-link" }>()(z.object({
  artifact: artifactArg(),
  // `anyone-with-link` is accepted so a model asking for it is told who can, rather than a bare "expected server".
  to: z.enum(["server", "anyone-with-link"]).describe("Where it moves: server, the whole server (its members and agents). anyone-with-link is refused: only a person can turn on link sharing."),
})));

export const artifactsDeleteRequestSchema = lazySchema("artifactsDeleteRequestSchema", () => requestSchema<{ artifact: string }>()(z.object({
  artifact: artifactArg(),
})));

/**
 * Move an Artifact to the whole server, with its comments and versions; an
 * agent can't move it back (only a person can). `anyone-with-link` is refused before
 * any request (only a person lets anyone with the link open it; the Server refuses an
 * agent the same, 403 FORBIDDEN), its next step the move an agent can make.
 */
export async function artifactsMove(
  client: Pick<AgentApiClient, "artifacts">,
  request: { artifact: string; to: "server" | "anyone-with-link" },
  options: RaftHintOptions = {},
): Promise<RaftOutcome<AgentApiArtifactMoved, "moved">> {
  const style = options.hints ?? "cli";
  const invalid = validateOpRequest(artifactsMoveRequestSchema, request); if (invalid) return invalid;
  const ref = resolveArtifactRef(request.artifact, style); if (!ref.ok) return ref.failure;
  if (request.to === "anyone-with-link") return clientRefusal("FORBIDDEN", { artifact: ref.value, moveTo: "public" }, style);
  const result = await client.artifacts.move({ artifact: ref.value }, { to: request.to });
  if (!result.ok) return failureFrom(result, { artifact: ref.value, moveTo: request.to }, style);
  return { ok: true, state: "moved", data: result.data, next: null, text: formatArtifactMoved(result.data) };
}

/** Delete an Artifact: no one opens it or any of its versions any more. It can't be undone. */
export async function artifactsDelete(
  client: Pick<AgentApiClient, "artifacts">,
  request: { artifact: string },
  options: RaftHintOptions = {},
): Promise<RaftOutcome<AgentApiArtifactDeleted, "deleted">> {
  const style = options.hints ?? "cli";
  const invalid = validateOpRequest(artifactsDeleteRequestSchema, request); if (invalid) return invalid;
  const ref = resolveArtifactRef(request.artifact, style); if (!ref.ok) return ref.failure;
  const result = await client.artifacts.delete({ artifact: ref.value });
  if (!result.ok) return failureFrom(result, { artifact: ref.value, deleting: true }, style);
  return { ok: true, state: "deleted", data: result.data, next: null, text: formatArtifactDeleted(result.data) };
}

// ---- saving an attachment ---------------------------------------------------------

export const artifactsSaveAttachmentRequestSchema = lazySchema("artifactsSaveAttachmentRequestSchema", () => requestSchema<{ attachmentId: string }>()(z.object({
  attachmentId: z.string().trim().min(1).describe("The attachment's id, as a message shows it after the file name: (id:<id>)."),
})));

/**
 * Save an attachment as a new artifact homed in the conversation it was sent
 * in, as the web's "Save as Artifact" does (the attachment then links to it
 * there), or answer the artifact an earlier save made.
 */
export async function artifactsSaveAttachment(
  client: Pick<AgentApiClient, "artifacts">,
  request: { attachmentId: string },
  options: RaftHintOptions = {},
): Promise<RaftOutcome<AgentApiArtifactSaved, "saved" | "already_saved">> {
  const style = options.hints ?? "cli";
  const invalid = validateOpRequest(artifactsSaveAttachmentRequestSchema, request); if (invalid) return invalid;
  const attachmentId = request.attachmentId.trim();
  const result = await client.artifacts.saveAttachment({ attachmentId });
  if (!result.ok) return failureFrom(result, { savingAttachment: attachmentId }, style);
  return { ok: true, state: result.data.created ? "saved" : "already_saved", data: result.data, next: null, text: formatArtifactSaved(result.data, style) };
}
