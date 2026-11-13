// The standalone Raft Artifacts app (raft-artifacts.com, a Cloudflare Worker
// with D1) as importing reads it: its internal import API at one fixed,
// configured address. Raft never requests a link a person or agent gave
// (import.ts takes only the server slug and the name from it, Tenny's SSRF
// condition); every request here goes to `ARTIFACTS_LEGACY_IMPORT_URL` with
// `ARTIFACTS_LEGACY_IMPORT_TOKEN`, a secret of its own.
//
// The contract (built in the standalone app's repository alongside):
// - `GET {base}/internal/raft-import/manifest?server=<server id>&name=<name>`
//   → 200 LegacyManifest, or 404 (its `creator`, and each `list` item's:
//   `{ type: "agent" | "user", raftId, name } | null`, who published it);
// - `GET {base}/internal/raft-import/blob?server=&name=&sha256=` → the bytes;
// - `POST {base}/internal/raft-import/imported { server, name, newUrl, importedBy }` → 204;
// - for the per-server move (legacyBulkImport.ts, ops only, never a request
//   of a person or agent): `GET {base}/internal/raft-import/list?server=&cursor=&limit=`
//   → `{ items: LegacyListItem[], nextCursor }` (the server's live named
//   Artifacts in id order, at most 200 a page; the cursor is the last id of
//   the previous page), and `POST {base}/internal/raft-import/freeze { server }`
//   → 200 `{ server, frozen: true, frozenAt }` (idempotent: the first time
//   stays; after it the standalone app refuses every write to that server's
//   Artifacts, 409 SERVER_MOVED_TO_RAFT);
// - for the old comments of a moved server's pages (legacyComments.ts, ops
//   only, never a request of a person or agent):
//   `GET {base}/internal/raft-import/comments?server=<server id>&name=<name>`
//   → 200 `{ comments: LegacyComment[] }` (oldest first: `{ id, author:
//   { type: "agent" | "user", raftId | null, name }, body, path | null,
//   replyTo | null, createdAt }`, createdAt in epoch ms; `path` the file the
//   comment was on, or the version's entry page for a place with no file,
//   null for one on the whole Artifact; comments on unpublished (deleted)
//   versions are left out, and a reply shares its parent's version, so
//   `replyTo` names a comment of the same answer), 404 as the others (also
//   before the 409), 409 `{ error: { code: "SERVER_NOT_FROZEN" } }` while
//   the server is not frozen there (only a frozen server's comments are
//   served), and 413 `{ error: { code: "TOO_MANY_COMMENTS" } }` past 5000
//   comments on one Artifact (that page's comments are not imported at all).
// All with `Authorization: Bearer <token>`. Every not-found (no such
// Artifact, deleted, another server's, an unknown blob, bad parameters) is
// the same 404; 401 is a token it refuses (it ignores tokens shorter than 32
// characters, so its endpoints answer 404 to them: keep the token at least
// 32); 429 RATE_LIMITED past 2400 requests a minute per token. It trusts Raft
// fully (it answers private Artifacts' manifests to the token), so Raft
// decides who may import before asking (import.ts). Redirects are refused, every
// request has a timeout (and ends with the whole import's deadline, when the
// caller passes it), and a blob is read only up to the size its manifest
// gave (a longer one is a mismatch, never buffered whole).
//
// The token never reaches a log; a failed call is logged with its status or
// error class only.
import { z } from "zod";
import type { ServerId } from "@botiverse/raft-shared";

/** The import token, like every shared secret between Raft and a Worker, is at least this many bytes. */
export const LEGACY_IMPORT_TOKEN_MIN_BYTES = 32;
/** The manifest, the `imported` notice, `list`, `freeze` and `comments`; a blob gets LEGACY_IMPORT_BLOB_TIMEOUT_MS. */
export const LEGACY_IMPORT_TIMEOUT_MS = 10_000;
/** One blob (up to 16 MiB), body included. */
export const LEGACY_IMPORT_BLOB_TIMEOUT_MS = 60_000;

type Fetch = typeof fetch;
let fetchImpl: Fetch | null = null;
let timeouts = { request: LEGACY_IMPORT_TIMEOUT_MS, blob: LEGACY_IMPORT_BLOB_TIMEOUT_MS };

/** Tests: answer the standalone app's requests with this instead of the network; undefined goes back to fetch. */
export function __setLegacyWorkerFetchForTests(fetcher: Fetch | undefined): void {
  fetchImpl = fetcher ?? null;
}

/** Tests: shorter timeouts; undefined goes back to the defaults. */
export function __setLegacyWorkerTimeoutsForTests(value: { request: number; blob: number } | undefined): void {
  timeouts = value ?? { request: LEGACY_IMPORT_TIMEOUT_MS, blob: LEGACY_IMPORT_BLOB_TIMEOUT_MS };
}

const LOOPBACK_HOSTS: ReadonlySet<string> = new Set(["localhost", "127.0.0.1", "[::1]"]);
const isSecureOrLoopback = (url: URL): boolean =>
  url.protocol === "https:" || (url.protocol === "http:" && (LOOPBACK_HOSTS.has(url.hostname) || url.hostname.endsWith(".localhost")));

/**
 * Secrets Raft already holds for other callers; the import token must be none
 * of them (the app-content bucket's secret key included: compared here, never
 * used by the app).
 */
const OTHER_SECRETS = ["ARTIFACTS_CONTENT_WORKER_TOKEN", "ARTIFACTS_CONTENT_RAFT_TOKENS", "APP_STORAGE_R2_SECRET_ACCESS_KEY"] as const;

export interface LegacyWorkerConfig {
  /** The base URL, without a trailing slash. */
  base: string;
  token: string;
}

let configMemo: { raw: string; config: LegacyWorkerConfig | null } | null = null;

/**
 * `ARTIFACTS_LEGACY_IMPORT_URL` and `ARTIFACTS_LEGACY_IMPORT_TOKEN`, both or
 * nothing: null when unset, and when partial, not an https URL (http only on
 * a loopback host), a token shorter than 32 bytes, or a token Raft also uses
 * for something else (with a warning naming the setting, never the value,
 * once per configuration). Null: importing answers 503 IMPORT_UNAVAILABLE.
 */
export function legacyWorkerConfig(env: NodeJS.ProcessEnv = process.env): LegacyWorkerConfig | null {
  const url = env.ARTIFACTS_LEGACY_IMPORT_URL?.trim() ?? "";
  const token = env.ARTIFACTS_LEGACY_IMPORT_TOKEN?.trim() ?? "";
  const others = OTHER_SECRETS.flatMap((name) => (env[name] ?? "").split(",").map((value) => value.trim()).filter(Boolean));
  const raw = JSON.stringify([url, token, others]);
  if (configMemo?.raw === raw) return configMemo.config;
  let problem: string | null = null;
  if (url || token) {
    if (!url) problem = "ARTIFACTS_LEGACY_IMPORT_URL is missing";
    else if (!token) problem = "ARTIFACTS_LEGACY_IMPORT_TOKEN is missing";
    else if (Buffer.byteLength(token, "utf8") < LEGACY_IMPORT_TOKEN_MIN_BYTES) problem = `ARTIFACTS_LEGACY_IMPORT_TOKEN is shorter than ${LEGACY_IMPORT_TOKEN_MIN_BYTES} bytes`;
    else if (!URL.canParse(url) || !isSecureOrLoopback(new URL(url))) problem = "ARTIFACTS_LEGACY_IMPORT_URL is not an https URL (http only on a loopback host)";
    else if (others.includes(token)) problem = "ARTIFACTS_LEGACY_IMPORT_TOKEN is also used for another Artifacts secret: it needs its own";
  }
  const config = url && token && !problem ? { base: url.replace(/\/+$/, ""), token } : null;
  if (problem) console.warn("[artifacts] legacy import configuration is unusable; importing answers 503", { problem });
  configMemo = { raw, config };
  return config;
}

const sha256Schema = z.string().regex(/^[0-9a-f]{64}$/);

/**
 * Who published the Artifact on raft-artifacts.com, as a Raft principal (the
 * standalone app's sign-in is Raft's): an agent or a person, by Raft id, and
 * the name it had there. null: the standalone app doesn't know (an anonymous
 * publish, or a principal it can't map). An answer without the field (a
 * standalone app from before it) reads as null. Whether it becomes the
 * imported Artifact's author is import.ts's (legacyAuthor): only while it
 * still stands in the server.
 */
const legacyCreatorSchema = z.object({
  type: z.enum(["agent", "user"]),
  raftId: z.string(),
  name: z.string(),
}).nullable().optional().transform((creator) => creator ?? null);
export type LegacyCreator = NonNullable<z.output<typeof legacyCreatorSchema>>;

/** What the standalone app says about one of its Artifacts: its current version's files. */
const legacyManifestSchema = z.object({
  artifactId: z.string().min(1).max(200),
  name: z.string(),
  title: z.string(),
  description: z.string().nullable(),
  entry: z.string(),
  /** Where an earlier import put it (a Raft link or id), as the standalone app recorded it. */
  importedTo: z.string().nullable(),
  creator: legacyCreatorSchema,
  version: z.object({
    number: z.number().int().positive(),
    files: z.array(z.object({
      path: z.string(),
      sha256: sha256Schema,
      size: z.number().int().nonnegative(),
      type: z.string(),
    })),
  }),
});
export type LegacyManifest = z.output<typeof legacyManifestSchema>;

/** Why a call to the standalone app gave nothing usable. */
export class LegacyWorkerUnavailable extends Error {
  constructor(readonly reason: "unreachable" | "bad_answer" | "rate_limited") {
    super(`legacy import ${reason}`);
  }
}

const errorClass = (error: unknown): string => (error instanceof Error ? error.name : typeof error);

async function call(
  config: LegacyWorkerConfig,
  path: string,
  init: { method: "GET" | "POST"; query?: Record<string, string>; body?: unknown; timeoutMs: number; deadline?: AbortSignal },
): Promise<Response> {
  const url = new URL(`${config.base}/internal/raft-import/${path}`);
  for (const [key, value] of Object.entries(init.query ?? {})) url.searchParams.set(key, value);
  try {
    return await (fetchImpl ?? fetch)(url.toString(), {
      method: init.method,
      headers: {
        Authorization: `Bearer ${config.token}`,
        Accept: path === "blob" ? "application/octet-stream" : "application/json",
        ...(init.body === undefined ? {} : { "Content-Type": "application/json" }),
      },
      ...(init.body === undefined ? {} : { body: JSON.stringify(init.body) }),
      redirect: "error",
      signal: init.deadline ? AbortSignal.any([AbortSignal.timeout(init.timeoutMs), init.deadline]) : AbortSignal.timeout(init.timeoutMs),
    });
  } catch (error) {
    console.warn("[artifacts] legacy import request failed", { path, errorClass: errorClass(error) });
    throw new LegacyWorkerUnavailable("unreachable");
  }
}

/** A refusal other than 404: 429 is the standalone app's rate limit, anything else (401 included) a bad answer. */
function refused(response: Response, path: string): never {
  void response.body?.cancel();
  console.warn("[artifacts] legacy import request refused", { path, status: response.status });
  throw new LegacyWorkerUnavailable(response.status === 429 ? "rate_limited" : "bad_answer");
}

/**
 * The manifest of `name` in `serverId`, or null when the standalone app has
 * no such Artifact (404). `deadline`: the whole import's, which ends the
 * request too.
 */
export async function fetchLegacyManifest(config: LegacyWorkerConfig, serverId: ServerId, name: string, deadline?: AbortSignal): Promise<LegacyManifest | null> {
  const response = await call(config, "manifest", { method: "GET", query: { server: serverId, name }, timeoutMs: timeouts.request, deadline });
  if (response.status === 404) {
    await response.body?.cancel();
    return null;
  }
  if (response.status !== 200) refused(response, "manifest");
  let body: unknown;
  try {
    body = await response.json();
  } catch (error) {
    console.warn("[artifacts] legacy import manifest unreadable", { errorClass: errorClass(error) });
    throw new LegacyWorkerUnavailable(error instanceof Error && error.name === "TimeoutError" ? "unreachable" : "bad_answer");
  }
  const parsed = legacyManifestSchema.safeParse(body);
  if (!parsed.success) {
    console.warn("[artifacts] legacy import manifest is not a manifest");
    throw new LegacyWorkerUnavailable("bad_answer");
  }
  return parsed.data;
}

/**
 * One file's bytes, read up to `size` + 1 bytes at most: `too_long` as soon
 * as more than `size` arrive (the rest is never read), `not_found` on a 404,
 * else the bytes (the caller checks their length and sha256). `deadline`:
 * the whole import's, which ends the request (and the reading) too.
 */
export async function fetchLegacyBlob(
  config: LegacyWorkerConfig,
  input: { serverId: ServerId; name: string; sha256: string; size: number },
  deadline?: AbortSignal,
): Promise<{ kind: "bytes"; bytes: Buffer } | { kind: "too_long" } | { kind: "not_found" }> {
  const response = await call(config, "blob", {
    method: "GET",
    query: { server: input.serverId, name: input.name, sha256: input.sha256 },
    timeoutMs: timeouts.blob,
    deadline,
  });
  // The Artifact (or that version of it) went away since its manifest.
  if (response.status === 404) {
    await response.body?.cancel();
    return { kind: "not_found" };
  }
  if (response.status !== 200 || !response.body) refused(response, "blob");
  const reader = response.body.getReader();
  const chunks: Buffer[] = [];
  let received = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      received += value.byteLength;
      if (received > input.size) {
        await reader.cancel();
        return { kind: "too_long" };
      }
      chunks.push(Buffer.from(value.buffer, value.byteOffset, value.byteLength));
    }
  } catch (error) {
    console.warn("[artifacts] legacy import blob read failed", { errorClass: errorClass(error) });
    throw new LegacyWorkerUnavailable("unreachable");
  }
  return { kind: "bytes", bytes: Buffer.concat(chunks, received) };
}

/**
 * Tell the standalone app where the Artifact went (`newUrl`), so its old link
 * can point there, and whether its new home is public (`public`: only then
 * may its old link answer a permanent, cacheable redirect; a standalone app
 * that doesn't know the field ignores it and keeps its 302). Best effort:
 * false (logged) when it fails; the import stands either way.
 */
export async function notifyLegacyImported(
  config: LegacyWorkerConfig,
  input: { serverId: ServerId; name: string; newUrl: string; importedBy: string; public: boolean },
): Promise<boolean> {
  try {
    const response = await call(config, "imported", {
      method: "POST",
      // The standalone app takes 1 to 200 characters of importedBy.
      body: { server: input.serverId, name: input.name, newUrl: input.newUrl, importedBy: Array.from(input.importedBy).slice(0, 200).join("") || "raft", public: input.public },
      timeoutMs: timeouts.request,
    });
    await response.body?.cancel();
    if (response.status === 204 || response.status === 200) return true;
    console.warn("[artifacts] legacy import: the standalone app refused the imported notice", { status: response.status });
    return false;
  } catch {
    // call() logged it.
    return false;
  }
}

/** `list` answers at most this many items a page. */
export const LEGACY_LIST_MAX_LIMIT = 200;

/** One Artifact of a server, as `list` answers it. */
const legacyListItemSchema = z.object({
  artifactId: z.string().min(1).max(200),
  /** Its name (the link's last segment); null: an Artifact with no name, nothing to link or import. */
  name: z.string().nullable(),
  title: z.string().nullable(),
  visibility: z.enum(["private", "public"]),
  /** Where an earlier import put it (a Raft link), as the standalone app recorded it. */
  importedTo: z.string().nullable(),
  /** Its current version's number; null: no published version. */
  currentVersion: z.number().int().positive().nullable(),
  sizeBytes: z.number().int().nonnegative(),
  /** Who published it there (the manifest's `creator`): what the plan counts authors by. */
  creator: legacyCreatorSchema,
});
export type LegacyListItem = z.output<typeof legacyListItemSchema>;
const legacyListSchema = z.object({ items: z.array(legacyListItemSchema), nextCursor: z.string().min(1).nullable() });
export type LegacyListPage = z.output<typeof legacyListSchema>;

async function readJson<T>(response: Response, path: string, schema: z.ZodType<T, unknown>): Promise<T> {
  let body: unknown;
  try {
    body = await response.json();
  } catch (error) {
    console.warn("[artifacts] legacy import answer unreadable", { path, errorClass: errorClass(error) });
    throw new LegacyWorkerUnavailable(error instanceof Error && error.name === "TimeoutError" ? "unreachable" : "bad_answer");
  }
  const parsed = schema.safeParse(body);
  if (!parsed.success) {
    console.warn("[artifacts] legacy import answer is not what the contract says", { path });
    throw new LegacyWorkerUnavailable("bad_answer");
  }
  return parsed.data;
}

/**
 * One page of the server's Artifacts in the standalone app (ops: the
 * per-server move). `cursor`: the last artifactId of the previous page (none:
 * the first page). Throws LegacyWorkerUnavailable on any answer but 200.
 */
export async function listLegacyArtifacts(
  config: LegacyWorkerConfig,
  input: { serverId: ServerId; cursor: string | null; limit: number },
): Promise<LegacyListPage> {
  const limit = Math.max(1, Math.min(LEGACY_LIST_MAX_LIMIT, Math.trunc(input.limit)));
  const query: Record<string, string> = { server: input.serverId, limit: String(limit) };
  if (input.cursor) query.cursor = input.cursor;
  const response = await call(config, "list", { method: "GET", query, timeoutMs: timeouts.request });
  if (response.status !== 200) refused(response, "list");
  const page = await readJson(response, "list", legacyListSchema);
  if (page.items.length > limit) throw new LegacyWorkerUnavailable("bad_answer");
  return page;
}

const legacyFreezeSchema = z.object({ server: z.string(), frozen: z.literal(true), frozenAt: z.string().min(1) });

/**
 * Freeze the server in the standalone app (ops: the first step of the
 * per-server move): from then on it refuses every write to the server's
 * Artifacts. Idempotent; `frozenAt` is the first freeze's time. Throws
 * LegacyWorkerUnavailable unless the standalone app confirms this server.
 */
export async function freezeLegacyServer(config: LegacyWorkerConfig, serverId: ServerId): Promise<{ frozenAt: string }> {
  const response = await call(config, "freeze", { method: "POST", body: { server: serverId }, timeoutMs: timeouts.request });
  if (response.status !== 200) refused(response, "freeze");
  const answer = await readJson(response, "freeze", legacyFreezeSchema);
  if (answer.server !== serverId) throw new LegacyWorkerUnavailable("bad_answer");
  return { frozenAt: answer.frozenAt };
}

/**
 * One comment of an Artifact on raft-artifacts.com, as `comments` answers it:
 * its id there (its copy here is `lc_<id>`, so only characters a comment id
 * in a Raft link carries as they are), who wrote it (a Raft principal by id:
 * a hint, as a creator's is, taken only when Raft confirms it in the server,
 * legacyComments.ts; raftId null: one the standalone app can't map), the
 * file it was on (null: the whole Artifact), the comment it replied to, and
 * when (epoch ms).
 */
const legacyCommentSchema = z.object({
  id: z.string().regex(/^[A-Za-z0-9_-]{1,200}$/),
  author: z.object({ type: z.enum(["agent", "user"]), raftId: z.string().nullable(), name: z.string() }),
  body: z.string(),
  path: z.string().nullable(),
  replyTo: z.string().nullable(),
  createdAt: z.number().int().nonnegative().max(8_640_000_000_000_000),
});
export type LegacyComment = z.output<typeof legacyCommentSchema>;
const legacyCommentsSchema = z.object({ comments: z.array(legacyCommentSchema) });
const legacyErrorSchema = z.object({ error: z.object({ code: z.string() }) });

/**
 * `comments`' answer: the comments (oldest first), no such Artifact (404),
 * the server not frozen there (409 SERVER_NOT_FROZEN), or more comments
 * than the standalone app serves for one Artifact (413 TOO_MANY_COMMENTS:
 * none of them is imported, never a partial set).
 */
export type LegacyCommentsAnswer =
  | { kind: "comments"; comments: LegacyComment[] }
  | { kind: "not_found" }
  | { kind: "not_frozen" }
  | { kind: "too_many" };

/**
 * The comments of `name` in `serverId` on raft-artifacts.com (ops: a moved
 * server's pages, legacyComments.ts), with the manifest's timeout, redirect
 * refusal and token. Served only once the server is frozen there
 * (`not_frozen` before). Throws LegacyWorkerUnavailable on any other answer,
 * one the contract doesn't describe, or two comments with one id.
 */
export async function fetchLegacyComments(config: LegacyWorkerConfig, serverId: ServerId, name: string, deadline?: AbortSignal): Promise<LegacyCommentsAnswer> {
  const response = await call(config, "comments", { method: "GET", query: { server: serverId, name }, timeoutMs: timeouts.request, deadline });
  if (response.status === 404) {
    await response.body?.cancel();
    return { kind: "not_found" };
  }
  if (response.status === 409 || response.status === 413) {
    const status = response.status;
    const answer = await readJson(response, "comments", legacyErrorSchema);
    if (status === 409 && answer.error.code === "SERVER_NOT_FROZEN") return { kind: "not_frozen" };
    if (status === 413 && answer.error.code === "TOO_MANY_COMMENTS") return { kind: "too_many" };
    console.warn("[artifacts] legacy import request refused", { path: "comments", status });
    throw new LegacyWorkerUnavailable("bad_answer");
  }
  if (response.status !== 200) refused(response, "comments");
  const { comments } = await readJson(response, "comments", legacyCommentsSchema);
  if (new Set(comments.map((comment) => comment.id)).size !== comments.length) {
    console.warn("[artifacts] legacy import answer is not what the contract says", { path: "comments", reason: "duplicate_id" });
    throw new LegacyWorkerUnavailable("bad_answer");
  }
  return { kind: "comments", comments };
}
