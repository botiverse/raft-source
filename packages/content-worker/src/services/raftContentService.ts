/**
 * Raft's workspace Artifacts on their own origins (S2, the content origin;
 * docs/development/workspace-artifacts-content-origin.md): a Worker of its
 * own (src/raftContent.ts, wrangler.jsonc) that shares nothing with Raft at
 * runtime but its R2 bucket, which it reads with a read-only token scoped to
 * that bucket (r2Read.ts), never a binding. Raft decides who may see a
 * version and signs the frame's one-time ticket for that decision; this
 * Worker checks it and opens it once, asks Raft again on every request, and
 * serves the version's bytes from R2.
 *
 * - Content domain only, through Porthole's host kit: Artifact `pt_<uuid>` is
 *   served on `w-<uuid>.<CONTENT_DOMAIN>`, its versions sharing the origin;
 *   `frame-ancestors` is APP_ORIGIN (the Raft app) and EXTRA_APP_ORIGINS
 *   (Raft Desktop's `app://raft`), the same list the shell takes messages from,
 *   then FRAMED_BY_ORIGINS (Deck, which frames the app): an ancestor only,
 *   never an origin any shell or door hears or tells (Porthole's `framedBy`).
 * - `GET <origin>/_raft/open?ticket=…` on the content domain: a frame's
 *   first load with a ticket Raft's server signed itself (shared
 *   artifactContentTicket.ts, keyed by RAFT_TOKENS: the current token and,
 *   while rotating, the previous one), checked here, opened once (D1), then
 *   handed to Porthole as a ticket of its own, in this isolate's memory
 *   (`openTicket`). Raft never calls the Worker for a frame.
 * - `GET <origin>/__porthole/door/_raft?ticket=…` on the content domain: the
 *   frame's door (Porthole P125, P126), which the web's Porthole frames first
 *   and takes how loading went from. Its ticket is Raft's too, a door's
 *   (`door: true`), checked and opened once as `/_raft/open`'s, then answered
 *   by Porthole's `doorAnswer` for that grant (`openDoor`).
 * - `POST /_raft/frames` on any other host (the workers.dev one): the issue
 *   route Raft's server called before it signed tickets itself, behind a
 *   bearer token from RAFT_TOKENS; kept for a server still calling it.
 * - Policies backed by Raft: `authorize` and `source` call
 *   `{RAFT_API_URL}/internal/artifacts-content/…` with RAFT_API_TOKEN.
 * - A signed-out visitor of a public Artifact: Raft asks for an anonymous
 *   frame (viewer `anonymous`, subject `v1:anon:<artifact>:<version>`), minted
 *   with Porthole's anonymous grant (P046) for that one version; `authorize`
 *   still asks Raft on every request.
 * - A publish check (task #130, src/checkSubject.ts): a signed ticket only, viewer
 *   `system:check`, subject `v1:check:<artifact>:<version>`, naming no ancestor
 *   (the check's headless browser opens it top-level); Porthole's anonymous
 *   grant for that one version, an open budget of its own, and `no-store` on
 *   the response the ticket opens.
 * - Public Artifacts embedded on any site (Porthole P143; embed.ts), while
 *   EMBEDS is on and EMBED_DOMAIN set (the kill switch: off, both routes below
 *   are the one 404 and Porthole takes no embed grant). On EMBED_DOMAIN (outside
 *   the content domain): `GET /pt_<uuid>`, Raft's outer page (no author code),
 *   `GET /pt_<uuid>/live` and its own script and style. On the content domain:
 *   `GET <origin>/_raft/embed`, the label's own Artifact's current version as an
 *   embed session (`openEmbed`: Porthole's anonymous grant with `embed`, subject
 *   `v1:embed:<artifact>:<version>`, every answer `frame-ancestors *`, no host,
 *   no door). Whether an Artifact embeds is Raft's answer
 *   (`/internal/artifacts-content/embeds/:artifact`: public and current, a framed
 *   kind), reused at most 30 s; authorize is asked on every request as for
 *   anyone, its embed answers reused at most 30 s across sessions. Neither
 *   `/_raft/open` nor the door ever mints an embed grant.
 * - No D1 but Porthole's ticket table (TICKETS), which also records the
 *   signed tickets opened (`raft-open:<nonce>`); no R2 binding.
 * - Porthole 0.15.2 (src/raftContentDisplays.ts says why): the kit that serves
 *   the shell and its runtime is the displays' own.
 */
import {
  contentHostFor,
  d1TicketStore,
  doorStatusResponse,
  prefixedName,
  statusPage,
  type AuthorizeAnswer,
  type AuthorizeRequest,
  type Grant,
  type InstanceRef,
  type StoredFile,
  type StoredFiles,
  type TicketRecord,
  type TicketStore,
} from "@botiverse/porthole/server";
import { appObjectKeyProblem } from "@botiverse/raft-shared/src/appObjectKey";
import {
  ARTIFACT_CONTENT_CHECK_VIEWER,
  ARTIFACT_CONTENT_DOOR_PATH,
  ARTIFACT_CONTENT_EMBED_PATH,
  ARTIFACT_CONTENT_OPEN_PATH,
  ARTIFACT_CONTENT_TICKET_MAX_SECONDS,
  artifactContentTicketKey,
  isArtifactContentTicketPage,
  verifyArtifactContentTicket,
  type ArtifactContentTicketClaims,
  type ArtifactContentTicketKey,
} from "@botiverse/raft-shared/src/artifactContentTicket";
import { artifactFileType, artifactFramedPagePath } from "@botiverse/raft-shared/src/artifactFiles";
import { frameOriginsOf } from "../appOrigins";
import { BoundedCache } from "../boundedCache";
import { checkSubjectOf } from "../checkSubject";
import { renderedPagePath } from "../files";
import { renderMarkdownToHtml } from "../markdown";
import { RAFT_LABEL_PREFIX, raftDisplays } from "../raftContentDisplays";
import {
  EMBED_ASSET_PREFIX,
  EMBED_AUTHORIZE_TTL_SECONDS,
  EMBEDDABLE_TTL_SECONDS,
  NOT_EMBEDDABLE_TTL_SECONDS,
  embedAsset,
  embedFont,
  embedderOf,
  embedDomainOf,
  embedLive,
  embedNotFound,
  embedOuterPage,
  embedRateLimited,
  embedUnavailable,
  logEmbedView,
  onEmbedDomain,
} from "./embed";
import { markdownFontFiles } from "./markdownFonts";
export { EMBEDDABLE_TTL_SECONDS, NOT_EMBEDDABLE_TTL_SECONDS } from "./embed";
import { pdfViewerFiles, pdfViewerPage, pdfViewerPath } from "./pdfViewer";
import { r2Get, R2ReadError, type R2ReadSettings } from "./r2Read";

export type RaftContentEnv = {
  /** Porthole's ticket table, and nothing else (migrations/). */
  TICKETS: D1Database;
  /**
   * The platform's app-content bucket Raft stores Artifact files in (the server's
   * APP_STORAGE_R2_BUCKET), read by key under ARTIFACTS_R2_PREFIX through R2's S3 API (r2Read.ts),
   * never through a binding: a binding could put, delete and list across the whole bucket. Its
   * account's S3 endpoint, an origin (`https://<account id>.r2.cloudflarestorage.com`); required.
   */
  R2_ENDPOINT?: string;
  /** The bucket's name; required. */
  R2_BUCKET?: string;
  /**
   * An R2 API token that can only read this one bucket's objects (Cloudflare's "Object Read
   * only", scoped to R2_BUCKET): its access key id and secret access key. Required: without them
   * every request is the generic 503.
   */
  R2_READ_ACCESS_KEY_ID?: string;
  R2_READ_SECRET_ACCESS_KEY?: string;
  /** The content domain: `w-<uuid>.<CONTENT_DOMAIN>`. */
  CONTENT_DOMAIN?: string;
  /** The Raft app's origin: it frames pages (the first of the app origins). */
  APP_ORIGIN?: string;
  /**
   * Raft's other clients that frame pages: a comma list of exact https origins or `app://raft`
   * (Raft Desktop), appended to APP_ORIGIN (src/appOrigins.ts). Optional; a bad entry fails closed.
   */
  EXTRA_APP_ORIGINS?: string;
  /**
   * Pages that frame the Raft app itself (Deck): a comma or space list of exact https origins
   * (src/appOrigins.ts, `framedByOriginsOf`), each an ancestor of every page here above the app
   * and never one that talks to a page (Porthole's `framedBy`, P141). Optional; a bad entry
   * fails closed.
   */
  FRAMED_BY_ORIGINS?: string;
  /** Porthole's secret: at least 32 random bytes (tickets, cookies, sealed paths). */
  PORTHOLE_SECRET?: string;
  /** Raft's API, for the internal routes (`https://…`; http only on loopback). */
  RAFT_API_URL?: string;
  /** The Worker's token to Raft (Raft's ARTIFACTS_CONTENT_RAFT_TOKENS lists it). */
  RAFT_API_TOKEN?: string;
  /**
   * Raft's tokens to the Worker: a comma list, each at least 32 bytes. Each one's key verifies the
   * tickets Raft's server signs (the current token and, while rotating, the previous one), and each
   * is a bearer for the issue route.
   */
  RAFT_TOKENS?: string;
  /** Frames per caller per minute in an isolate; default ISSUES_PER_MINUTE. */
  RAFT_ISSUES_PER_MINUTE?: string;
  /**
   * Embeds of public Artifacts on any site (Porthole P143): on only when exactly `1` or `true`,
   * and EMBED_DOMAIN is set. The kill switch: off, the embed host and `/_raft/embed` answer the
   * one 404 and Porthole takes no embed grant (`embeds: false`). Optional; default off.
   */
  EMBEDS?: string;
  /**
   * The embed host, `host[:port]` (`embed.raftusercontent.com`): Raft's outer page, outside the
   * content domain and off the app's site (embed.ts `embedDomainProblem`; a bad value fails
   * closed, embeds off). Optional.
   */
  EMBED_DOMAIN?: string;
};

/** Who asked for a frame, as the verified internal call says: Raft's decision. */
export type RaftViewer = {
  /** Which of RAFT_TOKENS the call carried (a fingerprint, never the token): the rate key. */
  readonly caller: string;
  /**
   * `user:<uuid>`, or `anonymous` (ANONYMOUS_VIEWER) for a signed-out visitor of a public Artifact.
   * (A publish check's `system:check` never comes through here: its grant is `checkOpenOf`'s.)
   */
  readonly viewer: string;
  readonly subject: string;
};

export const ISSUE_PATH = "/_raft/frames";
/** A ticket is good for a minute; the session is Porthole's default hour. */
export const TICKET_SECONDS = 60;
/**
 * A legacy Raft login's session (a subject without a session family, `…:-`):
 * Raft can't tell when it signs out, so its access lasts only as long as the
 * session, ten minutes. A tracked login keeps Porthole's default hour: its
 * sign-out is refused at the next request by `authorize`, and a shorter
 * session would only make long-open frames reload and lose their state.
 */
export const UNTRACKED_SESSION_SECONDS = 600;
export const sessionSecondsOf = (subject: string): number | undefined =>
  subject.endsWith(":-") ? UNTRACKED_SESSION_SECONDS : undefined;
/**
 * A signed-out visitor's session (an anonymous grant): ten minutes. Whether
 * the Artifact is still public is Raft's answer to `authorize`, asked on
 * every request as for anyone (the same 30 s reuse); the session only bounds
 * how long one ticket's sealed files address lasts.
 */
export const ANONYMOUS_SESSION_SECONDS = 600;

/** How long an answer of Raft's authorize is reused for the same session and version. */
export const AUTHORIZE_TTL_SECONDS = 30;
/** How long Raft has to answer an internal call before it counts as a deny (or a 503). */
export const RAFT_TIMEOUT_MS = 5_000;
/** Frames per caller per minute, per isolate (RAFT_ISSUES_PER_MINUTE): Raft asks one for every mount, for every reader. */
export const ISSUES_PER_MINUTE = 6_000;
/**
 * Signed tickets opened per viewer per minute, per isolate (`/_raft/open`, counted as issues are, by
 * `withinIssueRate`): a signed-in reader by their `user:<id>`, a signed-out visitor by client
 * address. Raft's server signs at most 120 a minute per person (its frame route and viewer
 * together); this bounds what any of them, or one ticket replayed, costs D1 and Raft's authorize.
 */
export const OPENS_PER_VIEWER_PER_MINUTE = 120;
/**
 * A publish check's tickets opened per version per minute, per isolate (`open:check:<artifact>:<version>`,
 * never a reader's budget nor a client address's). The server signs one ticket per load of a check,
 * which loads its version once or twice; this bounds what a check retried in a loop costs.
 */
export const CHECK_OPENS_PER_VERSION_PER_MINUTE = 10;
/**
 * A publish check's session: one minute. A check takes at most 15 s; whether it still runs is
 * Raft's answer to `authorize` (`not-checking` once it ended), asked as for anyone.
 */
export const CHECK_SESSION_SECONDS = 60;
const ISSUE_BODY_BYTES = 4_096;
const MINUTE_MS = 60_000;

const issuesPerMinute = (env: RaftContentEnv): number =>
  /^[1-9]\d{0,6}$/.test(env.RAFT_ISSUES_PER_MINUTE ?? "") ? Number(env.RAFT_ISSUES_PER_MINUTE) : ISSUES_PER_MINUTE;

/**
 * Issues per caller in the last minute, in this isolate (as Porthole's own limiter counts); also the
 * signed tickets opened, per viewer (`open:<viewer>`).
 */
const issued = new Map<string, number[]>();
function withinIssueRate(caller: string, perMinute: number): boolean {
  const now = Date.now();
  const recent = (issued.get(caller) ?? []).filter((at) => now - at < MINUTE_MS);
  const within = recent.length < perMinute;
  if (within) recent.push(now);
  if (issued.size > 10_000) issued.clear();
  issued.set(caller, recent);
  return within;
}

/** When each client address last had a refused token logged: at most one line a minute each. */
const refusedLogged = new Map<string, number>();
function logRefusedToken(source: string): void {
  const now = Date.now();
  const last = refusedLogged.get(source);
  if (last !== undefined && now - last < MINUTE_MS) return;
  if (refusedLogged.size > 10_000) refusedLogged.clear();
  refusedLogged.set(source, now);
  // Route and source only: never the token, never the header.
  console.warn(JSON.stringify({ evt: "raft-content.refused-token", route: ISSUE_PATH, source }));
}
const TOKEN_MIN_BYTES = 32;

const UUID = "[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}";
const ARTIFACT_ID = new RegExp(`^pt_(${UUID})$`);
const VERSION_ID = new RegExp(`^v_${UUID}$`);
const VIEWER = new RegExp(`^user:(${UUID})$`);
const SUBJECT = new RegExp(`^v1:${UUID}:(${UUID}):(?:${UUID}|-)$`);
/** The viewer Raft names a signed-out visitor of a public Artifact by: nobody in particular. */
export const ANONYMOUS_VIEWER = "anonymous";
/**
 * The subject of an anonymous frame: the one Artifact and version it opens,
 * no user (Raft's `anonymousContentSubject`). Never a signed-in subject: `anon`
 * is no server uuid.
 */
export const anonymousSubjectOf = (artifact: string, version: string): string => `v1:anon:${artifact}:${version}`;
const ANONYMOUS_SUBJECT = new RegExp(`^v1:anon:pt_${UUID}:v_${UUID}$`);
/**
 * The subject of an embed session (Porthole P143, `openEmbed`): the one Artifact and version it
 * opens, no user. Only this Worker mints it, never Raft's server (which signs no embed ticket),
 * and only for an embed session: `subjectFits` refuses it anywhere else, and any other subject in
 * an embed session.
 */
export const embedSubjectOf = (artifact: string, version: string): string => `v1:embed:${artifact}:${version}`;
const SHA256 = /^[0-9a-f]{64}$/;
/**
 * The R2 keys Raft gives (`r2KeyOf`, packages/server/src/apps/artifacts/blobStore.ts):
 * `servers/<server uuid>/blobs/<sha256>/<blob id>`, relative to Artifacts' prefix in Raft's
 * platform bucket (ARTIFACTS_R2_PREFIX). Raft is trusted; this is defence in depth (Tenny): a
 * wrong key from Raft can never make the Worker read anything outside Artifacts' prefix (a full
 * `apps/…` path is not a key), nor a file under another file's hash. A key is first one the
 * platform takes for any app's object (`appObjectKeyProblem`, the same rule as the server's
 * app object storage), then of this shape (`artifactsKeyOk`).
 */
const R2_KEY = /^servers\/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\/blobs\/([0-9a-f]{64})\/[A-Za-z0-9_-]+$/;
/**
 * Artifacts' prefix in Raft's platform bucket, where each app owns `apps/<app id>/`. The Worker
 * reads every object at this prefix plus the manifest's relative key (`blobOf`), and never takes
 * a full path from Raft.
 */
export const ARTIFACTS_R2_PREFIX = "apps/artifacts/";
/**
 * A file's bytes in R2: its manifest key (checked by `artifactsKeyOk`) under Artifacts' prefix,
 * read with the bucket's read-only token. Null for NoSuchKey (a 404); any other answer of R2's is
 * logged (its status and S3 error code only) and thrown, which Porthole answers with its generic
 * error page: nothing of R2's answer reaches the visitor.
 */
async function blobOf(env: RaftContentEnv, key: string): Promise<Response | null> {
  try {
    return await r2Get(r2Settings(env), `${ARTIFACTS_R2_PREFIX}${key}`);
  } catch (error) {
    console.error(
      JSON.stringify({
        evt: "raft-content.r2-read-failed",
        ...(error instanceof R2ReadError ? { status: error.status, code: error.code } : { error: error instanceof Error ? error.name : "unknown" }),
      }),
    );
    throw error;
  }
}
/** Whether `key` is an app object key under Artifacts' prefix and Raft's blob key for a file of hash `sha256`. */
const artifactsKeyOk = (key: string, sha256: string): boolean =>
  appObjectKeyProblem(ARTIFACTS_R2_PREFIX, key) === null && R2_KEY.exec(key)?.[1] === sha256;
/** A deny code Porthole carries to the host's UI (lowercase letters, digits and dashes). */
const CODE = /^[a-z0-9][a-z0-9-]{0,39}$/;

const FRAMED_KINDS = ["html", "markdown", "pdf"] as const;
type FramedKind = (typeof FRAMED_KINDS)[number];

const utf8 = (text: string) => new TextEncoder().encode(text);

/** The instance for an Artifact's version: scope the Artifact's uuid (its origin), document the version. */
export function raftInstance(artifact: string, version: string): InstanceRef | null {
  const scope = ARTIFACT_ID.exec(artifact)?.[1];
  return scope !== undefined && VERSION_ID.test(version)
    ? { scope, document: { kind: "artifact", id: artifact, version } }
    : null;
}

/** A proposal exactly as `raftInstance` makes it, or null: nothing of it is taken on trust. */
function instanceOf(proposal: InstanceRef): InstanceRef | null {
  const document = proposal.document as Record<string, unknown>;
  if (document.kind !== "artifact" || typeof document.id !== "string" || typeof document.version !== "string")
    return null;
  if (Object.keys(document).some((key) => !["kind", "id", "version"].includes(key))) return null;
  const instance = raftInstance(document.id, document.version);
  return instance && instance.scope === proposal.scope ? instance : null;
}

// --- Raft's internal routes -------------------------------------------------

/** Raft's API base, checked: https, or http on a loopback host (tests, local dev). */
function raftApi(env: RaftContentEnv): string {
  const raw = env.RAFT_API_URL?.trim() ?? "";
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new Error("RAFT_API_URL is not configured");
  }
  const loopback = ["127.0.0.1", "localhost", "[::1]"].includes(url.hostname);
  if (url.protocol !== "https:" && !(url.protocol === "http:" && loopback))
    throw new Error("RAFT_API_URL must be https");
  return url.href.replace(/\/+$/, "");
}

/** An R2 bucket name: 3 to 63 lowercase letters, digits and dashes. */
const R2_BUCKET_NAME = /^[a-z0-9][a-z0-9-]{1,61}[a-z0-9]$/;

/**
 * Where Artifact bytes are read and with what, checked: the endpoint an https origin (http on a
 * loopback host only: tests, local dev), a bucket name, and both halves of the read-only token.
 * Errors name the setting, never its value.
 */
function r2Settings(env: RaftContentEnv): R2ReadSettings {
  let url: URL;
  try {
    url = new URL(env.R2_ENDPOINT?.trim() ?? "");
  } catch {
    throw new Error("R2_ENDPOINT is not configured");
  }
  const loopback = ["127.0.0.1", "localhost", "[::1]"].includes(url.hostname);
  if (url.protocol !== "https:" && !(url.protocol === "http:" && loopback)) throw new Error("R2_ENDPOINT must be https");
  if (url.username !== "" || url.password !== "" || url.pathname !== "/" || url.search !== "" || url.hash !== "")
    throw new Error("R2_ENDPOINT must be an origin alone");
  const bucket = env.R2_BUCKET?.trim() ?? "";
  if (!R2_BUCKET_NAME.test(bucket)) throw new Error("R2_BUCKET is not an R2 bucket name");
  const accessKeyId = env.R2_READ_ACCESS_KEY_ID?.trim() ?? "";
  if (!/^[A-Za-z0-9]{1,128}$/.test(accessKeyId)) throw new Error("R2_READ_ACCESS_KEY_ID is missing or not an access key id");
  const secretAccessKey = env.R2_READ_SECRET_ACCESS_KEY?.trim() ?? "";
  if (secretAccessKey === "") throw new Error("R2_READ_SECRET_ACCESS_KEY is missing");
  return { endpoint: url.origin, bucket, accessKeyId, secretAccessKey };
}

function raftToken(env: RaftContentEnv): string {
  const token = env.RAFT_API_TOKEN?.trim() ?? "";
  if (utf8(token).byteLength < TOKEN_MIN_BYTES) throw new Error("RAFT_API_TOKEN is missing or shorter than 32 bytes");
  return token;
}

/**
 * What the Worker calls itself on its calls to Raft. The API sits behind
 * Cloudflare (staging's edge proxy, production's zone), whose Browser
 * Integrity Check may refuse a request with no User-Agent (error 1010).
 */
export const RAFT_CONTENT_USER_AGENT = "RaftContentWorker/1 (+https://raft.build)";

/** A call to Raft's internal routes: its token, its own User-Agent, a timeout, no redirects followed. */
function callRaft(env: RaftContentEnv, path: string, init: RequestInit = {}): Promise<Response> {
  return fetch(`${raftApi(env)}${path}`, {
    ...init,
    redirect: "manual",
    signal: AbortSignal.timeout(RAFT_TIMEOUT_MS),
    headers: {
      authorization: `Bearer ${raftToken(env)}`,
      accept: "application/json",
      "user-agent": RAFT_CONTENT_USER_AGENT,
      ...(init.body === undefined ? {} : { "content-type": "application/json" }),
    },
  });
}

const allow: AuthorizeAnswer = { allow: true };
const deny = (code: string): AuthorizeAnswer => ({ allow: false, code });

/**
 * Whether a session's subject is one this Worker mints for its instance: a
 * signed-in one (`v1:<server>:<user>:<family|->`, a named viewer), or, for an
 * anonymous session only, the anonymous subject or a publish check's subject
 * of this very Artifact and version; for an embed session only (Porthole's
 * `embed: true`, signed into the session), the embed subject of this very
 * Artifact and version, and nothing else. Nothing mixed: an anonymous session
 * with a user's subject, a named one with an anonymous, a check or an embed
 * subject, an embed subject outside an embed session or any other subject in
 * one, or any of another version.
 */
function subjectFits(
  document: InstanceRef["document"],
  access: { readonly anonymous: boolean; readonly viewer: string; readonly subject?: string | undefined; readonly embed?: true | undefined },
): boolean {
  const { subject } = access;
  if (document.kind !== "artifact" || subject === undefined) return false;
  const ofThis = typeof document.id === "string" && typeof document.version === "string";
  if (access.embed === true)
    return access.anonymous && access.viewer === "" && ofThis && subject === embedSubjectOf(String(document.id), String(document.version));
  if (access.anonymous)
    return (
      access.viewer === "" &&
      ofThis &&
      (subject === anonymousSubjectOf(String(document.id), String(document.version)) || subject === checkSubjectOf(String(document.id), String(document.version)))
    );
  return SUBJECT.test(subject);
}

/**
 * Raft's answers for embed subjects, by subject, reused across sessions for
 * EMBED_AUTHORIZE_TTL_SECONDS (Porthole reuses an answer per session only): an embed subject names
 * no one, so every viewer of one Artifact's version gets the same answer, and without this every
 * view of a popular embed would ask Raft. Only answers Raft gave (an allow or its deny code), never
 * `unavailable`.
 *
 * The caches never stack (Tenny): Porthole keeps each session's copy for AUTHORIZE_TTL_SECONDS
 * from when it got it, which may be late in a memo's life. So the moment a memo expires, every
 * session's copy of that subject is dropped too (`forgetEmbedSubject`): by the sweep that runs
 * before every content request (`sweepEmbedAuthorized`), and by `raftAuthorize` itself when it finds
 * the memo expired first. A copy is thus never older than its memo, and a takedown reaches every
 * request of an open embed session within EMBED_TAKEDOWN_BOUND_SECONDS.
 */
const EMBED_AUTHORIZED = new Map<string, { answer: AuthorizeAnswer; until: number }>();
const EMBED_AUTHORIZED_MAX = 10_000;
/** The soonest a memo expires (Infinity: none held): the sweep does nothing before it. */
let embedAuthorizedNext = Number.POSITIVE_INFINITY;

/** Drops a memo and Porthole's per-session copies of its subject. */
function forgetEmbedSubject(env: RaftContentEnv, subject: string): void {
  EMBED_AUTHORIZED.delete(subject);
  raftContent.host(env).forget({ subject });
}

/** Before every content request: every expired memo dropped, with Porthole's copies of its subject. */
export function sweepEmbedAuthorized(env: RaftContentEnv, now = Date.now()): void {
  if (now < embedAuthorizedNext) return;
  let next = Number.POSITIVE_INFINITY;
  for (const [subject, memo] of [...EMBED_AUTHORIZED]) {
    if (memo.until <= now) forgetEmbedSubject(env, subject);
    else next = Math.min(next, memo.until);
  }
  embedAuthorizedNext = next;
}

/**
 * On every request after the ticket (cached `AUTHORIZE_TTL_SECONDS` by
 * Porthole, per session and version): Raft's answer. Only a 200 that says
 * `{ allow: true }` lets it in; an error, a timeout or anything else is a deny.
 * A subject that doesn't fit the session (`subjectFits`) is denied before Raft
 * is asked.
 */
export async function raftAuthorize(env: RaftContentEnv, request: AuthorizeRequest): Promise<AuthorizeAnswer> {
  const { instance, subject } = request;
  const { document } = instance;
  if (document.kind !== "artifact" || subject === undefined || !subjectFits(document, request)) {
    logAuthorizeUnanswered("not-asked");
    return deny("bad-subject");
  }
  if (request.embed !== true) return askAuthorize(env, String(document.id), String(document.version), subject);
  const now = Date.now();
  const memo = EMBED_AUTHORIZED.get(subject);
  if (memo !== undefined && memo.until > now) return memo.answer;
  // Expired before the sweep saw it: the sessions holding its answer ask again too.
  if (memo !== undefined) forgetEmbedSubject(env, subject);
  const answer = await askAuthorize(env, String(document.id), String(document.version), subject);
  if (answer.allow || answer.code !== "unavailable") {
    if (EMBED_AUTHORIZED.size >= EMBED_AUTHORIZED_MAX) for (const each of [...EMBED_AUTHORIZED.keys()]) forgetEmbedSubject(env, each);
    // From before Raft was asked: the answer is never kept past the bound from what Raft said.
    const until = now + EMBED_AUTHORIZE_TTL_SECONDS * 1_000;
    EMBED_AUTHORIZED.set(subject, { answer, until });
    embedAuthorizedNext = Math.min(embedAuthorizedNext, until);
  }
  return answer;
}

/** When each way of not being answered was last logged in this isolate: at most one line a minute each. */
const authorizeUnansweredLogged = new Map<string, number>();
/**
 * A deny that is this Worker's own, not Raft's answer (#proj-workspace:#280): Raft's authorize
 * wasn't answered (`unavailable`), or wasn't asked at all (`bad-subject`). Said in the log, since
 * the reader's 403 looks like any refusal and Raft's logs may never have seen a call. `why`: the
 * status that came back (`status:502`), `timeout`, the error's class (`error:TypeError`), or
 * `not-asked`. Never the Artifact, the version, the subject, a token or an address. At most one
 * line a minute for each `why`, per isolate.
 */
function logAuthorizeUnanswered(why: string): void {
  const now = Date.now();
  const last = authorizeUnansweredLogged.get(why);
  if (last !== undefined && now - last < MINUTE_MS) return;
  if (authorizeUnansweredLogged.size > 100) authorizeUnansweredLogged.clear();
  authorizeUnansweredLogged.set(why, now);
  console.warn(JSON.stringify({ evt: "raft-content.authorize-unanswered", why }));
}

/** Raft's authorize for one subject (`raftAuthorize`'s call). */
async function askAuthorize(env: RaftContentEnv, artifact: string, version: string, subject: string): Promise<AuthorizeAnswer> {
  try {
    const response = await callRaft(env, "/internal/artifacts-content/authorize", {
      method: "POST",
      body: JSON.stringify({ artifact, version, subject }),
    });
    if (response.status !== 200) {
      // Before the body is dropped: a cancel that fails must not cost the status.
      logAuthorizeUnanswered(`status:${response.status}`);
      await response.body?.cancel();
      return deny("unavailable");
    }
    const said = (await response.json()) as { allow?: unknown; code?: unknown } | null;
    if (said?.allow === true) return allow;
    return deny(typeof said?.code === "string" && CODE.test(said.code) ? said.code : "denied");
  } catch (error) {
    // AbortSignal.timeout's: Raft took longer than RAFT_TIMEOUT_MS. Anything else by its class alone (a fetch that failed, a body that isn't JSON).
    const name = String(error instanceof Error ? error.name : typeof error);
    logAuthorizeUnanswered(name === "TimeoutError" ? "timeout" : `error:${name.replace(/[^A-Za-z0-9_]/g, "").slice(0, 40)}`);
    return deny("unavailable");
  }
}

/** A version's manifest, as Raft gives it: only servable files, each with its R2 key. */
export type RaftManifest = {
  readonly artifact: string;
  readonly version: string;
  readonly number: number;
  readonly kind: FramedKind;
  readonly entry: string;
  readonly spa: boolean;
  readonly title: string;
  readonly files: ReadonlyMap<string, { readonly size: number; readonly sha256: string; readonly key: string }>;
};

/** Raft's answer, checked to be exactly a manifest of this version; null where it isn't one. */
function manifestFrom(body: unknown, artifact: string, version: string): RaftManifest | null {
  if (body === null || typeof body !== "object") return null;
  const said = body as Record<string, unknown>;
  if (said.artifact !== artifact || said.version !== version) return null;
  if (!FRAMED_KINDS.includes(said.kind as FramedKind)) return null;
  if (typeof said.entry !== "string" || typeof said.title !== "string") return null;
  if (!Number.isSafeInteger(said.number) || (said.spa !== undefined && typeof said.spa !== "boolean")) return null;
  if (!Array.isArray(said.files)) return null;
  const files = new Map<string, { size: number; sha256: string; key: string }>();
  for (const file of said.files as unknown[]) {
    const each = file as Record<string, unknown> | null;
    if (
      !each ||
      typeof each.path !== "string" ||
      each.path === "" ||
      files.has(each.path) ||
      !Number.isSafeInteger(each.size) ||
      (each.size as number) < 0 ||
      typeof each.sha256 !== "string" ||
      !SHA256.test(each.sha256) ||
      typeof each.key !== "string" ||
      !artifactsKeyOk(each.key, each.sha256)
    )
      return null;
    files.set(each.path, { size: each.size as number, sha256: each.sha256, key: each.key });
  }
  return {
    artifact,
    version,
    number: said.number as number,
    kind: said.kind as FramedKind,
    entry: said.entry,
    spa: said.spa === true,
    title: said.title,
    files,
  };
}

/** Versions are immutable: their manifests (weighed in files) and rendered pages (in bytes), per isolate. */
const MANIFESTS = new BoundedCache<RaftManifest>(20_000, 500);
const RENDERED = new BoundedCache<Uint8Array>(8 * 1024 * 1024, 1024 * 1024);

/**
 * A version's manifest from Raft (cached once found): null where Raft says
 * 404; throws where Raft can't be asked or answers anything else.
 */
export async function manifestOf(env: RaftContentEnv, artifact: string, version: string): Promise<RaftManifest | null> {
  const key = `${artifact}/${version}`;
  const cached = MANIFESTS.get(key);
  if (cached) return cached;
  const response = await callRaft(
    env,
    `/internal/artifacts-content/versions/${encodeURIComponent(version)}?artifact=${encodeURIComponent(artifact)}`,
  );
  if (response.status === 404) {
    await response.body?.cancel();
    return null;
  }
  if (response.status !== 200) {
    await response.body?.cancel();
    throw new Error(`Raft answered ${response.status} for a manifest`);
  }
  const body = (await response.json()) as Record<string, unknown> | null;
  // A version of another kind (text, CSV, an image) is one Raft draws itself: nothing to frame.
  if (body?.artifact === artifact && body.version === version && typeof body.kind === "string" && !FRAMED_KINDS.includes(body.kind as FramedKind))
    return null;
  const manifest = manifestFrom(body, artifact, version);
  if (!manifest) throw new Error("Raft's manifest isn't one");
  return MANIFESTS.set(key, manifest, manifest.files.size);
}

/** What Raft says of an Artifact that embeds: its current version, kind and title. */
export type RaftEmbeddable = {
  readonly artifact: string;
  readonly version: string;
  readonly kind: FramedKind;
  readonly title: string;
};

const EMBEDDABLE = new Map<string, { answer: RaftEmbeddable | null; until: number }>();
const EMBEDDABLE_MAX = 10_000;

/** Raft's answer, checked to be exactly an embeddable of this Artifact; null where it isn't one. */
function embeddableFrom(body: unknown, artifact: string): RaftEmbeddable | null {
  if (body === null || typeof body !== "object" || Array.isArray(body)) return null;
  const said = body as Record<string, unknown>;
  if (said.artifact !== artifact || typeof said.version !== "string" || !VERSION_ID.test(said.version)) return null;
  if (!FRAMED_KINDS.includes(said.kind as FramedKind) || typeof said.title !== "string") return null;
  return { artifact, version: said.version, kind: said.kind as FramedKind, title: said.title };
}

/**
 * Whether an Artifact embeds now, Raft's answer (`GET /internal/artifacts-content/embeds/:artifact`):
 * public, live, a current version of a framed kind. Its current version and title, or null where
 * Raft says 404 (every other case alike). Reused per isolate: a yes for EMBEDDABLE_TTL_SECONDS
 * (so a takedown blanks new loads within 30 s), a no for NOT_EMBEDDABLE_TTL_SECONDS. Throws where
 * Raft can't be asked or answers anything else (never cached).
 */
export async function embeddableOf(env: RaftContentEnv, artifact: string): Promise<RaftEmbeddable | null> {
  const now = Date.now();
  const cached = EMBEDDABLE.get(artifact);
  if (cached !== undefined && cached.until > now) return cached.answer;
  const response = await callRaft(env, `/internal/artifacts-content/embeds/${encodeURIComponent(artifact)}`);
  let answer: RaftEmbeddable | null;
  if (response.status === 404) {
    await response.body?.cancel();
    answer = null;
  } else if (response.status === 200) {
    answer = embeddableFrom(await response.json(), artifact);
    if (answer === null) throw new Error("Raft's embed answer isn't one");
  } else {
    await response.body?.cancel();
    throw new Error(`Raft answered ${response.status} for an embed`);
  }
  if (EMBEDDABLE.size >= EMBEDDABLE_MAX) EMBEDDABLE.clear();
  EMBEDDABLE.set(artifact, { answer, until: now + (answer ? EMBEDDABLE_TTL_SECONDS : NOT_EMBEDDABLE_TTL_SECONDS) * 1_000 });
  return answer;
}

/**
 * What a version is on its origin: its files, each read from R2 by its key
 * (P081), under Artifacts' prefix. A Markdown entry is rendered to a page beside it (`notes.md` opens
 * as `notes.md.html`, so its relative images are its own version's), only
 * when that page is read, with Raft's fonts beside it (`_raft-fonts/…`,
 * markdownFonts.ts). A PDF opens in a viewer page beside it
 * (`report.pdf` as `report.pdf.html`), which draws it with the viewer's own
 * files (pdfViewer.ts). Those made pages, the fonts and the viewer's files win
 * over a version's own at their paths. A file Raft doesn't list (an `s3` one) is a 404.
 *
 * Every other Markdown file and PDF of the version gets its page the same way (#proj-workspace:#272:
 * a file the reader opens from the app's Files, in a frame that opens at that page; shared
 * `artifactFramedPagePath` names it, for the server that signs the frame and for this), made only
 * when it is read. Those fill empty paths only: where the version has a file of its own (at the
 * page's path, at a font's or a viewer file's), that file stays, so nothing a version served before
 * changes; a version with no such file gets nothing new.
 */
export function storedFilesOf(env: RaftContentEnv, manifest: RaftManifest): StoredFiles | null {
  const source = manifest.files.get(manifest.entry);
  if (!source) return null;
  const files: Record<string, StoredFile> = {};
  for (const [path, file] of manifest.files) files[path] = { size: file.size, sha256: file.sha256 };
  const made = new Map<string, () => Promise<Uint8Array | null>>();
  let entry = manifest.entry;
  const rendered = (path: string, render: () => Promise<Uint8Array | null>) => {
    made.set(path, async () => {
      const key = `${manifest.version}/${path}`;
      const cached = RENDERED.get(key);
      if (cached) return cached;
      const bytes = await render();
      return bytes && RENDERED.set(key, bytes, bytes.byteLength);
    });
  };
  /** A Markdown file's page at `page`, rendered when read. A page's ETag is Porthole's own (the shell it is served in); the source's stands in here. */
  const markdownPage = (page: string, path: string, file: { size: number; sha256: string; key: string }, title: string) => {
    files[page] = { size: file.size, sha256: file.sha256 };
    rendered(page, async () => {
      const object = await blobOf(env, file.key);
      return object ? utf8(renderMarkdownToHtml(await object.text(), title, path)) : null;
    });
  };
  /** Raft's own files beside the made pages (the fonts, pdf.js): over a version's own at their paths (`win`), or only where it has none. */
  const support = (assets: ReadonlyMap<string, { readonly bytes: Uint8Array; readonly sha256: string }>, win: boolean) => {
    for (const [path, file] of assets) {
      if (made.has(path) || (!win && manifest.files.has(path))) continue;
      files[path] = { size: file.bytes.byteLength, sha256: file.sha256 };
      made.set(path, async () => file.bytes);
    }
  };
  if (manifest.kind === "markdown") {
    // Always rendered, at `<entry>.html`: a version's own file there never shadows the page (it
    // would leave the raw .md as the entry, inert, and the frame blocked).
    entry = renderedPagePath(manifest.entry);
    markdownPage(entry, manifest.entry, source, manifest.title);
    // Its fonts win over a version's own files at their paths, as the PDF viewer's do.
    support(markdownFontFiles(), true);
  }
  if (manifest.kind === "pdf") {
    // The viewer and its files win over a version's own at their paths: a PDF always opens in it.
    entry = pdfViewerPath(manifest.entry);
    const page = utf8(pdfViewerPage(manifest.entry, manifest.title));
    files[entry] = { size: page.byteLength, sha256: source.sha256 };
    made.set(entry, async () => page);
    support(pdfViewerFiles(), true);
  }
  // The version's other Markdown files and PDFs: a page beside each, at an empty path only.
  for (const [path, file] of manifest.files) {
    if (path === manifest.entry) continue;
    const { kind } = artifactFileType(path);
    if (kind !== "markdown" && kind !== "pdf") continue;
    const page = artifactFramedPagePath(path)!;
    if (manifest.files.has(page) || made.has(page)) continue;
    const name = path.slice(path.lastIndexOf("/") + 1);
    if (kind === "markdown") {
      markdownPage(page, path, file, name);
      support(markdownFontFiles(), false);
    } else {
      files[page] = { size: file.size, sha256: file.sha256 };
      made.set(page, async () => utf8(pdfViewerPage(path, name)));
      support(pdfViewerFiles(), false);
    }
  }
  return {
    files,
    entry,
    spa: manifest.spa,
    read: async (path) => {
      const make = made.get(path);
      if (make) return make();
      const file = manifest.files.get(path);
      const object = file ? await blobOf(env, file.key) : null;
      return object ? object.body : null;
    },
  };
}

// --- The content host -------------------------------------------------------

/**
 * The content host for each isolate's settings: the content domain, framed by
 * the Raft app and its other clients only (appOriginsOf), with Deck above the
 * app (FRAMED_BY_ORIGINS, an ancestor only), tickets in D1.
 * Settings that can't be served (no domain, a bad EXTRA_APP_ORIGINS or
 * FRAMED_BY_ORIGINS, a short
 * secret, no Raft API, no R2 endpoint, bucket or read token) make every
 * request a 503; what is missing is named in the log only.
 */
export const raftContent = contentHostFor<RaftContentEnv, RaftViewer>(
  (env) => {
    if (!env.CONTENT_DOMAIN?.trim()) throw new Error("CONTENT_DOMAIN is not configured");
    if (!env.APP_ORIGIN?.trim()) throw new Error("APP_ORIGIN is not configured");
    if (utf8(env.PORTHOLE_SECRET?.trim() ?? "").byteLength < 32)
      throw new Error("PORTHOLE_SECRET is missing or shorter than 32 bytes");
    raftApi(env);
    raftToken(env);
    r2Settings(env);
    const origins = frameOriginsOf(env);
    return {
      domain: env.CONTENT_DOMAIN.trim(),
      // Who frames a page (`frame-ancestors`) and whom the shell takes messages from (its plan's
      // `origins`): the Raft app first, then its other clients (Raft Desktop).
      appOrigins: origins.hostOrigins,
      // Above the app, in `frame-ancestors` alone (P141): Deck, which frames the Raft app. Never
      // an origin a shell or door hears or tells.
      framedBy: origins.framedBy,
      // Embed grants (P143) only while embeds are on (EMBEDS and EMBED_DOMAIN): off, Porthole's
      // issue refuses one and an embed session's cookie or sealed address opens nothing.
      embeds: embedDomainOf(env) !== null,
      secret: env.PORTHOLE_SECRET!,
      tickets: raftTicketStore(env.TICKETS),
      displays: raftDisplays,
      name: prefixedName(RAFT_LABEL_PREFIX),
      // The ids name the instance; the issue route checked them, and checks again here.
      instance: (proposal) => instanceOf(proposal),
      // Raft decided at its frame route: the grant is its viewer and subject, the session as long
      // as `sessionSecondsOf` says, at level `view` (P087), the least there is: what the runtime's
      // `comments` needs (P090), carried in the issue's answer to the frame's bridge, which refuses
      // the runtime's host functions without one. Raft's composer still decides. A signed-out
      // visitor's is Porthole's anonymous grant (P046), with no level: `grantOf`.
      access: (instance, viewer): Grant | null => grantOf(instance, viewer),
      authorize: (request) => raftAuthorize(env, request),
      authorizeTtlSeconds: AUTHORIZE_TTL_SECONDS,
      source: async (artifact, version) => {
        const manifest = await manifestOf(env, artifact, version);
        return manifest && storedFilesOf(env, manifest);
      },
      // Per caller (each of RAFT_TOKENS), in this isolate. The issue route counts first, with the
      // same budget, before it asks Raft anything (`withinIssueRate`); this one is the kit's backstop.
      rateLimit: { perMinute: issuesPerMinute(env), key: (_request, viewer) => `raft:${viewer?.caller ?? "-"}` },
    };
  },
  { log: (problem) => console.error("[raft-content] misconfigured:", problem) },
);

/**
 * The grant for Raft's verified call: its viewer and subject, at level `view`;
 * or, for viewer `anonymous`, Porthole's anonymous grant with the subject of
 * this very instance (anything else: no grant). The anonymous grant has no
 * level, so its FrameLocation carries no `viewer` and the frame's bridge
 * refuses the runtime's host functions (`comments` among them: a signed-out
 * page has no comments); `copyText` and `openLink` work as for anyone.
 */
function grantOf(instance: InstanceRef, viewer: RaftViewer | null): Grant | null {
  if (!viewer) return null;
  if (viewer.viewer === ANONYMOUS_VIEWER) {
    const { document } = instance;
    if (document.kind !== "artifact" || viewer.subject !== anonymousSubjectOf(String(document.id), String(document.version))) return null;
    return { anonymous: true, subject: viewer.subject, ttlSeconds: TICKET_SECONDS, sessionSeconds: ANONYMOUS_SESSION_SECONDS };
  }
  return {
    viewer: viewer.viewer,
    subject: viewer.subject,
    level: "view",
    ttlSeconds: TICKET_SECONDS,
    ...(sessionSecondsOf(viewer.subject) === undefined ? {} : { sessionSeconds: sessionSecondsOf(viewer.subject) }),
  };
}

// --- The issue route --------------------------------------------------------

const refusal = (status: number, code: string, message: string) =>
  new Response(JSON.stringify({ error: { code, message } }), {
    status,
    headers: { "content-type": "application/json; charset=utf-8", "cache-control": "no-store", "x-content-type-options": "nosniff" },
  });

async function digest(text: string): Promise<Uint8Array> {
  return new Uint8Array(await crypto.subtle.digest("SHA-256", utf8(text)));
}

/**
 * Which of RAFT_TOKENS a bearer is (a fingerprint), or null. Compared in
 * constant time: each configured token's digest against the bearer's, every
 * one, with no early exit. Entries shorter than 32 bytes never match.
 */
async function callerOf(env: RaftContentEnv, request: Request): Promise<string | null> {
  const header = request.headers.get("authorization") ?? "";
  const bearer = /^Bearer ([^\s,]+)$/.exec(header)?.[1] ?? null;
  const tokens = (env.RAFT_TOKENS ?? "")
    .split(",")
    .map((each) => each.trim())
    .filter((each) => utf8(each).byteLength >= TOKEN_MIN_BYTES);
  if (bearer === null || tokens.length === 0) return null;
  const given = await digest(bearer);
  let found: Uint8Array | null = null;
  for (const token of tokens) {
    const want = await digest(token);
    let difference = 0;
    for (let at = 0; at < want.length; at += 1) difference |= want[at]! ^ given[at]!;
    if (difference === 0) found = want;
  }
  return found && [...found.slice(0, 6)].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

/** A body of at most `limit` bytes as text, or null past it (counted as read, whatever it declares). */
async function boundedText(request: Request, limit: number): Promise<string | null> {
  if (request.body === null) return "";
  const reader = request.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    size += value.byteLength;
    if (size > limit) {
      await reader.cancel().catch(() => {});
      return null;
    }
    chunks.push(value);
  }
  const bytes = new Uint8Array(size);
  let at = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, at);
    at += chunk.byteLength;
  }
  return new TextDecoder("utf-8", { fatal: true }).decode(bytes);
}

/**
 * The issue body, exactly: `{ artifact, version, viewer, subject }`, the
 * subject's user the viewer; or, for a signed-out visitor of a public
 * Artifact, viewer `anonymous` and the subject `v1:anon:<artifact>:<version>`
 * of this very body's Artifact and version. Nothing mixed.
 */
export function issueBodyOf(body: unknown): { artifact: string; version: string; viewer: string; subject: string } | null {
  if (body === null || typeof body !== "object" || Array.isArray(body)) return null;
  const said = body as Record<string, unknown>;
  const keys = Object.keys(said).sort();
  if (keys.join(",") !== "artifact,subject,version,viewer") return null;
  const { artifact, version, viewer, subject } = said;
  if (typeof artifact !== "string" || typeof version !== "string" || typeof viewer !== "string" || typeof subject !== "string")
    return null;
  if (!ARTIFACT_ID.test(artifact) || !VERSION_ID.test(version)) return null;
  if (viewer === ANONYMOUS_VIEWER)
    return ANONYMOUS_SUBJECT.test(subject) && subject === anonymousSubjectOf(artifact, version) ? { artifact, version, viewer, subject } : null;
  const user = VIEWER.exec(viewer)?.[1];
  const subjectUser = SUBJECT.exec(subject)?.[1];
  if (user === undefined || subjectUser !== user) return null;
  return { artifact, version, viewer, subject };
}

/**
 * `POST /_raft/frames` (Raft → Worker): Raft has decided the viewer may see
 * the version; the Worker checks the caller's token, the body, and that the
 * version is one it frames (Raft's manifest), then has Porthole's issue
 * handler mint the ticket for that grant (`access` gives Raft's viewer and
 * subject back). 201 `FrameLocation` (without Porthole's `door`); 401 bad token (logged at most once a
 * minute per client address); 429 past the caller's budget (counted before
 * the body is read or Raft asked); 400 bad body; 404 not a framed version; 503.
 */
export async function issueFrame(request: Request, env: RaftContentEnv): Promise<Response> {
  if (request.method.toUpperCase() !== "POST") return refusal(405, "method", "POST here");
  const caller = await callerOf(env, request);
  if (caller === null) {
    logRefusedToken(request.headers.get("cf-connecting-ip") ?? "unknown");
    return refusal(401, "unauthenticated", "A Raft token is required");
  }
  // Before anything else is read or asked: a caller past its budget costs Raft nothing.
  if (!withinIssueRate(caller, issuesPerMinute(env)))
    return refusal(429, "rate-limited", "Too many frames asked for: try again in a minute");
  let body: ReturnType<typeof issueBodyOf> = null;
  try {
    const text = await boundedText(request, ISSUE_BODY_BYTES);
    body = text === null ? null : issueBodyOf(JSON.parse(text));
  } catch {
    body = null;
  }
  if (body === null)
    return refusal(
      400,
      "bad-request",
      'The body is { "artifact": "pt_…", "version": "v_…", "viewer": "user:…", "subject": "v1:…" }, or viewer "anonymous" with subject "v1:anon:<artifact>:<version>"',
    );
  let host: ReturnType<typeof raftContent.host>;
  try {
    host = raftContent.host(env);
  } catch {
    return refusal(503, "unavailable", "Content frames aren't served now");
  }
  let manifest: RaftManifest | null;
  try {
    manifest = await manifestOf(env, body.artifact, body.version);
  } catch {
    return refusal(503, "unavailable", "Raft couldn't say what this version is");
  }
  if (manifest === null || !manifest.files.has(manifest.entry))
    return refusal(404, "not-framed", "This version isn't one the content origin frames");
  const instance = raftInstance(body.artifact, body.version)!;
  const viewer: RaftViewer = { caller, viewer: body.viewer, subject: body.subject };
  // Porthole's own issue handler, for the instance and the viewer the verified call names.
  const issued = await host.issue(() => viewer)(
    new Request(request.url, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ instance }),
    }),
  );
  if (issued.status !== 201) return issued;
  // Without Porthole's `door` (P125): its ticket is never stored (`raftTicketStore`), and a frame's
  // door is Raft's own, signed by Raft's server alone (`openDoor`). This route's callers predate the
  // door (a host before 0.14.6 ignores one), so the answer stays url, origin, reports and viewer.
  const { door: _door, ...location } = (await issued.json()) as Record<string, unknown>;
  return new Response(JSON.stringify(location), { status: issued.status, headers: issued.headers });
}

// --- A ticket Raft's server signed -------------------------------------------

/**
 * Porthole's tickets: in D1 (P045), but for one `openTicket` mints while `handingOff` is set, which
 * stays in this isolate's memory and is taken by the same request a moment later. Porthole's
 * `issue` reaches `put` without awaiting anything first, so the flag, set and cleared around that
 * synchronous stretch, can't leak to another request; were that ever to change, the ticket would
 * simply go to D1 as any other. A ticket handed off and never taken is dropped once expired.
 *
 * Since 0.14.6 (P125) every `issue` also mints a door ticket, the same record with `door: true`
 * (Porthole's `mint`, its only door record; `doorAnswer` stores nothing). Nobody opens one: the
 * frame's door is Raft's own (`openDoor`), its ticket signed by Raft's server and never in this
 * store, and neither `openTicket`'s location nor the legacy issue route's answer (`issueFrame`
 * strips it) hands Porthole's door out. So every door record is dropped, never written to D1 nor
 * held: Porthole's own door route (`/__porthole/door/<key>`) finds no ticket of its own here.
 */
let handingOff = false;
const handedOff = new Map<string, TicketRecord>();
function raftTicketStore(db: D1Database): TicketStore {
  const d1 = d1TicketStore(db);
  return {
    put(id, record) {
      if (record.door === true) return Promise.resolve();
      if (!handingOff) return d1.put(id, record);
      const now = Date.now();
      for (const [each, held] of handedOff) if (held.expiresAt <= now) handedOff.delete(each);
      handedOff.set(id, record);
      return Promise.resolve();
    },
    take(id) {
      const record = handedOff.get(id);
      if (record === undefined) return d1.take(id);
      handedOff.delete(id);
      return Promise.resolve(record.expiresAt > Date.now() ? record : null);
    },
  };
}

/** The keys of RAFT_TOKENS (entries of at least 32 bytes), derived once per list. */
let ticketKeysMemo: { raw: string; keys: Promise<ArtifactContentTicketKey[]> } | null = null;
function ticketKeysOf(env: RaftContentEnv): Promise<ArtifactContentTicketKey[]> {
  const raw = env.RAFT_TOKENS ?? "";
  if (ticketKeysMemo?.raw !== raw) {
    const tokens = raw.split(",").map((each) => each.trim()).filter((each) => utf8(each).byteLength >= TOKEN_MIN_BYTES);
    ticketKeysMemo = { raw, keys: Promise.all(tokens.map((token) => artifactContentTicketKey(token))) };
  }
  return ticketKeysMemo.keys;
}

/** The row in Porthole's ticket table that says a signed ticket was opened: never a Porthole ticket's id (a hash). */
const openedId = (nonce: string) => `raft-open:${nonce}`;

/**
 * How long past its expiry a ticket's row is kept: ARTIFACT_CONTENT_TICKET_MAX_SECONDS, the bound on
 * a ticket's lifetime that clock skew is already counted in. Another of Cloudflare's machines whose
 * clock is behind still takes the ticket as unexpired for a moment after this one's clock passed
 * its expiry; were the row swept at the expiry (every open sweeps), that machine would open it again.
 */
export const OPENED_KEPT_PAST_EXPIRY_SECONDS = ARTIFACT_CONTENT_TICKET_MAX_SECONDS;

/**
 * Whether this is the first time a ticket (by its nonce) is opened, in one D1 round trip: expired
 * rows swept, then a row for it that lives until OPENED_KEPT_PAST_EXPIRY_SECONDS past the ticket's
 * expiry, inserted only if none is there. Two opens at once: D1's single primary lets one insert.
 */
async function firstOpen(db: D1Database, nonce: string, expiresSeconds: number): Promise<boolean> {
  const [, inserted] = await db.batch([
    db.prepare("DELETE FROM porthole_tickets WHERE expires_at <= ?").bind(Date.now()),
    db
      .prepare("INSERT INTO porthole_tickets (id, record, expires_at) VALUES (?, ?, ?) ON CONFLICT (id) DO NOTHING")
      .bind(openedId(nonce), '"opened"', (expiresSeconds + OPENED_KEPT_PAST_EXPIRY_SECONDS) * 1_000),
  ]);
  return inserted?.meta.changes === 1;
}

/** When each refusal reason was last logged in this isolate (a door's apart): at most one line a minute each. */
const ticketRefusalLogged = new Map<string, number>();
function logTicketRefused(reason: string, door = false): void {
  const now = Date.now();
  const key = door ? `door:${reason}` : reason;
  const last = ticketRefusalLogged.get(key);
  if (last !== undefined && now - last < MINUTE_MS) return;
  ticketRefusalLogged.set(key, now);
  // The reason only: never the ticket, its claims or a key.
  console.warn(JSON.stringify({ evt: "raft-content.ticket-refused", reason, ...(door ? { door: true } : {}) }));
}

/**
 * What a refused ticket gets: Porthole's own page for a used ticket (401, reason `session`), the
 * same whatever is wrong, so the frame falls back as for any expired ticket (the web asks Raft for
 * a new one once) and nothing tells a forged ticket from a used one.
 */
function ticketRefused(request: Request, env: RaftContentEnv, reason: string): Response {
  logTicketRefused(reason);
  return statusPage({
    status: 401,
    title: "This link has been used",
    detail: "Content here opens once per link. Open it again from the app that showed it.",
    reason: "session",
    ...frameOriginsOf(env),
    method: request.method,
  });
}

/**
 * A signed ticket's viewer past its budget (OPENS_PER_VIEWER_PER_MINUTE): Porthole's own page for
 * too many requests (429, reason `error`), so the frame shows its fallback rather than asking again.
 */
function openRateLimited(request: Request, env: RaftContentEnv): Response {
  logTicketRefused("rate-limited");
  return statusPage({
    status: 429,
    title: "Too many requests",
    detail: "Try again in a minute.",
    reason: "error",
    ...frameOriginsOf(env),
    method: request.method,
  });
}

/** Whose budget a signed ticket's open counts against: its viewer, or a signed-out visitor's client address. */
const openRateKey = (request: Request, viewer: string): string =>
  viewer === ANONYMOUS_VIEWER ? `open:${viewer}:${request.headers.get("cf-connecting-ip") ?? "-"}` : `open:${viewer}`;

/** What a verified ticket opens: its instance, its grant, whose budget it counts against, and whether it is a check's. */
type TicketOpen = {
  readonly instance: InstanceRef;
  readonly grant: Grant;
  readonly rateKey: string;
  readonly perMinute: number;
  /** A publish check's: the response it opens is `no-store` (`forCheck`). */
  readonly check: boolean;
  /**
   * Where in the version the frame opens (Porthole's `issue` and `doorAnswer`, P125): the page a
   * page ticket names (`claims.page`, a reader's or a visitor's only), else nothing, the entry.
   */
  readonly at?: { readonly page: string };
};

/**
 * A publish check's ticket (viewer ARTIFACT_CONTENT_CHECK_VIEWER), exactly as the server signs it
 * (checkFrame.ts): ids of an Artifact and a version and the subject `v1:check:` of those very ids.
 * It names no ancestor: the shared verifier already refused every ticket with one (`malformed`), a
 * check's first of all, since the check's headless browser opens it top-level. Anything else is
 * null: a reader's or an anonymous subject on a check ticket, a check subject of another version
 * or Artifact. Porthole's anonymous grant (P046), as a signed-out visitor's: no viewer and no
 * level, so the page's bridge refuses every runtime host function (no user, no comments), for
 * CHECK_SESSION_SECONDS; its budget is its own, by its Artifact and version.
 */
function checkOpenOf(claims: ArtifactContentTicketClaims): TicketOpen | null {
  const { artifact, version, viewer, subject } = claims;
  if (viewer !== ARTIFACT_CONTENT_CHECK_VIEWER) return null;
  const instance = raftInstance(artifact, version);
  if (instance === null || subject !== checkSubjectOf(artifact, version)) return null;
  return {
    instance,
    grant: { anonymous: true, subject, ttlSeconds: TICKET_SECONDS, sessionSeconds: CHECK_SESSION_SECONDS },
    rateKey: `open:check:${artifact}:${version}`,
    perMinute: CHECK_OPENS_PER_VERSION_PER_MINUTE,
    check: true,
  };
}

/**
 * What a verified ticket opens: a publish check's (`checkOpenOf`), or a reader's, whose claims are
 * a body the issue route would take (`issueBodyOf`: never a check viewer or subject). Where it is
 * opened decides which ticket it must be (`door`): a door ticket (`door: true`) opens only the door
 * (`openDoor`), any other only `/_raft/open`; a check ticket never has a door (the shared verifier
 * already refused one as `malformed`; held again here). A page ticket (`page`, a file of the version
 * the reader opened from the app's Files, #proj-workspace:#272) opens at that page instead of the
 * entry, its door ticket answering for the same page; the shared verifier took `page` only as a
 * path Porthole's `issue` takes (`isArtifactContentTicketPage`), and never on a check ticket (held
 * again here). Whether it is a page of the version is Porthole's to say (`not-found`), as for an entry.
 */
function ticketOpenOf(request: Request, claims: ArtifactContentTicketClaims, door: boolean): TicketOpen | null {
  if ((claims.door === true) !== door) return null;
  if (claims.viewer === ARTIFACT_CONTENT_CHECK_VIEWER) return door || claims.page !== undefined ? null : checkOpenOf(claims);
  if (claims.page !== undefined && !isArtifactContentTicketPage(claims.page)) return null;
  const body = issueBodyOf({ artifact: claims.artifact, version: claims.version, viewer: claims.viewer, subject: claims.subject });
  const instance = body && raftInstance(body.artifact, body.version);
  const grant = body && instance && grantOf(instance, { caller: "ticket", viewer: body.viewer, subject: body.subject });
  if (!body || !instance || !grant) return null;
  return {
    instance,
    grant,
    rateKey: openRateKey(request, body.viewer),
    perMinute: OPENS_PER_VIEWER_PER_MINUTE,
    check: false,
    ...(claims.page === undefined ? {} : { at: { page: claims.page } }),
  };
}

/**
 * The response a publish check's ticket opened, `cache-control: no-store` (Porthole's own for a
 * ticket's answer, held here), so no cache keeps what a check was shown and none is ever served to
 * a reader. Its headers are otherwise Porthole's, the reader's `frame-ancestors` included: the
 * check opens it top-level, where `frame-ancestors` doesn't apply.
 */
function forCheck(response: Response): Response {
  const headers = new Headers(response.headers);
  headers.set("cache-control", "no-store");
  return new Response(response.body, { status: response.status, statusText: response.statusText, headers });
}

/**
 * `GET <origin>/_raft/open?ticket=<ticket>` on the content domain: a frame's first load with a
 * ticket Raft's server signed (shared artifactContentTicket.ts). Checked here, before anything is
 * asked: the signature under a key of RAFT_TOKENS (by its kid), not expired, signed for exactly
 * this origin and that Artifact's own label, no field but the claims and a door's `door: true` (never an ancestor), and its
 * claims a reader's the issue route would take (`issueBodyOf`) or a check's (`checkOpenOf`). Then counted against its budget (`withinIssueRate`: a reader's
 * OPENS_PER_VIEWER_PER_MINUTE, a check's CHECK_OPENS_PER_VERSION_PER_MINUTE; 429 past it, before
 * D1 is touched, so neither opens nor replays of one ticket are unbounded), opened once
 * (`firstOpen`, D1), and handed to Porthole: a ticket of its own for that grant, minted in this
 * isolate's memory, and the request answered as Porthole answers that ticket's address (a check's
 * answer `no-store`: `forCheck`; a check opens it top-level, a reader in the app's frame). Raft's authorize is asked as on every
 * load (`raftAuthorize`), and the manifest as for any version. A page ticket's frame opens at its
 * page of the version (`issue`'s `{ page }`); one that is no page of it gets Porthole's own
 * not-found page, as a version without its entry does. Anything refused is the one
 * used-ticket page (`ticketRefused`), its reason logged. A door ticket is refused here
 * (`bad-claims`): it opens the door alone (`openDoor`).
 */
export async function openTicket(request: Request, env: RaftContentEnv): Promise<Response> {
  if (request.method.toUpperCase() !== "GET") return ticketRefused(request, env, "method");
  const url = new URL(request.url);
  const verified = await verifyArtifactContentTicket(url.searchParams.get("ticket") ?? "", await ticketKeysOf(env), { origin: url.origin });
  if (!verified.ok) return ticketRefused(request, env, verified.reason);
  const { claims } = verified;
  const opened = ticketOpenOf(request, claims, false);
  if (opened === null) return ticketRefused(request, env, "bad-claims");
  const { instance, grant } = opened;
  if (!withinIssueRate(opened.rateKey, opened.perMinute)) return openRateLimited(request, env);
  const server = raftContent.host(env).server;
  if (server === null) return contentUnavailable();
  if (!(await firstOpen(env.TICKETS, claims.nonce, claims.expires))) return ticketRefused(request, env, "opened");
  let issuing: ReturnType<typeof server.issue>;
  handingOff = true;
  try {
    issuing = server.issue(instance, grant, opened.at);
  } finally {
    handingOff = false;
  }
  const location = await issuing;
  // The document as Porthole answers its own ticket's address; the shell moves the frame to the
  // version's sealed address before anything loads, so the signed ticket leaves the address too.
  const answered = (await raftContent.fetch(new Request(location.url, { method: "GET", headers: request.headers }), env)) ?? contentUnavailable();
  return opened.check ? forCheck(answered) : answered;
}

/**
 * What a refused door ticket gets: Porthole's door saying `blocked: session` (401), the same
 * whatever is wrong (as `ticketRefused`), so nothing tells a forged door ticket from a used one;
 * the reason logged, as a door's.
 */
function doorRefused(request: Request, env: RaftContentEnv, reason: string): Response {
  logTicketRefused(reason, true);
  return doorStatusResponse({ status: 401, reason: "session", ...frameOriginsOf(env), method: request.method });
}

/**
 * `GET <origin>/__porthole/door/_raft?ticket=<door ticket>` on the content domain (Porthole P125,
 * P126): the frame's door, which the web's Porthole frames first (hidden, opaque) and takes how
 * loading went from, never from the content's own frame. Its ticket is checked as `openTicket`
 * checks one (shared verifier, `ticketOpenOf`), and must be a door's (`door: true`; a content or
 * a check ticket is refused); counted against a budget of its own beside its viewer's opens
 * (`door:<the open's key>`, the same size: every frame is a door and a content load), opened once
 * (`firstOpen`, its own nonce), then answered by Porthole's `doorAnswer` for that grant: the
 * content route's own checks (Raft's authorize, the manifest, the entry a page, and a page
 * ticket's page one of the version's), `open` or
 * `blocked` and why, with the door's CSP and no cookie. The door only reports: `/_raft/open` still
 * takes its own ticket and asks again (P050). Refused: the door's `blocked: session` (401,
 * `doorRefused`); past the budget `blocked: error` (429).
 */
export async function openDoor(request: Request, env: RaftContentEnv): Promise<Response> {
  if (request.method.toUpperCase() !== "GET") return doorRefused(request, env, "method");
  const url = new URL(request.url);
  const verified = await verifyArtifactContentTicket(url.searchParams.get("ticket") ?? "", await ticketKeysOf(env), { origin: url.origin });
  if (!verified.ok) return doorRefused(request, env, verified.reason);
  const { claims } = verified;
  const opened = ticketOpenOf(request, claims, true);
  if (opened === null || opened.check) return doorRefused(request, env, "bad-claims");
  const origins = frameOriginsOf(env);
  if (!withinIssueRate(`door:${opened.rateKey}`, opened.perMinute)) {
    logTicketRefused("rate-limited", true);
    return doorStatusResponse({ status: 429, reason: "error", ...origins, method: request.method });
  }
  const server = raftContent.host(env).server;
  if (server === null) return contentUnavailable();
  if (!(await firstOpen(env.TICKETS, claims.nonce, claims.expires))) return doorRefused(request, env, "opened");
  try {
    return await server.doorAnswer(opened.instance, opened.grant, request, opened.at);
  } catch {
    // An instance or grant Porthole's issue would refuse: never one `ticketOpenOf` makes.
    logTicketRefused("door-answer-failed", true);
    return doorStatusResponse({ status: 500, reason: "error", ...origins, method: request.method });
  }
}

// --- Embeds (Porthole P143) ---------------------------------------------------

/**
 * Embed loads per Artifact per minute, per isolate: the outer page's (`embed:page:<artifact>`) and
 * the embed sessions opened (`embed:open:<artifact>`), each. Past it the embed shows Porthole's
 * embed status page (429), never a 5xx. Per isolate, so a cost bound and not a boundary; the edge's
 * rate rule on the embed host sits above it.
 */
export const EMBEDS_PER_ARTIFACT_PER_MINUTE = 600;
/** Outer pages per embedding site (its registrable domain, `embedderOf`) per minute, per isolate. */
export const EMBEDS_PER_SITE_PER_MINUTE = 1_200;
/** The embed host's answers per client address per minute, per isolate (outer pages, liveness, sessions opened: each). */
export const EMBEDS_PER_VIEWER_PER_MINUTE = OPENS_PER_VIEWER_PER_MINUTE;

const clientOf = (request: Request): string => request.headers.get("cf-connecting-ip") ?? "-";

/** An Artifact's own content origin (`w-<uuid>.<CONTENT_DOMAIN>`): https, http on a localhost domain (tests, local dev). */
function contentOriginOf(env: RaftContentEnv, artifact: string): string | null {
  const uuid = ARTIFACT_ID.exec(artifact)?.[1];
  const domain = env.CONTENT_DOMAIN?.trim().toLowerCase() ?? "";
  if (uuid === undefined || domain === "") return null;
  const host = domain.replace(/:\d+$/, "");
  const scheme = host === "localhost" || host.endsWith(".localhost") ? "http" : "https";
  return `${scheme}://${RAFT_LABEL_PREFIX}${uuid}.${domain}`;
}

/** The Artifact whose label a content-domain request is on (`w-<uuid>.<CONTENT_DOMAIN>` → `pt_<uuid>`), or null. */
function labelArtifactOf(request: Request, env: RaftContentEnv): string | null {
  const domain = (env.CONTENT_DOMAIN ?? "").trim().toLowerCase().replace(/:\d+$/, "");
  const host = new URL(request.url).hostname.toLowerCase();
  const match = new RegExp(`^${RAFT_LABEL_PREFIX}(${UUID})\\.(.+)$`).exec(host);
  return match && match[2] === domain ? `pt_${match[1]}` : null;
}

/**
 * The embed host (EMBED_DOMAIN, outside the content domain): Raft's outer page for a public,
 * current Artifact (`GET /pt_<uuid>`), whether it still embeds (`GET /pt_<uuid>/live`, 204), and
 * the page's own script and style (`/_embed/…`). Everything else, and every Artifact that doesn't
 * embed (malformed ids before Raft is asked), is the one 404 (`embedNotFound`), as is every path
 * while embeds are off (EMBEDS, the kill switch). Budgets before Raft is asked: per client address,
 * then for the page per Artifact and per embedding site (past one: `embedRateLimited`, 429). The
 * view is logged with the embedder's registrable domain alone (`logEmbedView`).
 */
export async function embedHost(request: Request, env: RaftContentEnv): Promise<Response> {
  const method = request.method.toUpperCase();
  if (embedDomainOf(env) === null || (method !== "GET" && method !== "HEAD")) return embedNotFound(method);
  const { pathname } = new URL(request.url);
  if (pathname.startsWith(EMBED_ASSET_PREFIX))
    return embedAsset(pathname, method) ?? embedFont(pathname, method, markdownFontFiles()) ?? embedNotFound(method);
  const [, artifact, live] = /^\/(pt_[^/]+?)(\/live)?$/.exec(pathname) ?? [];
  if (artifact === undefined || !ARTIFACT_ID.test(artifact)) return embedNotFound(method);
  const client = clientOf(request);
  if (live !== undefined) {
    if (!withinIssueRate(`embed:live:${client}`, EMBEDS_PER_VIEWER_PER_MINUTE)) return embedRateLimited(method);
  } else {
    const embedder = embedderOf(request);
    if (
      !withinIssueRate(`embed:viewer:${client}`, EMBEDS_PER_VIEWER_PER_MINUTE) ||
      !withinIssueRate(`embed:page:${artifact}`, EMBEDS_PER_ARTIFACT_PER_MINUTE) ||
      !withinIssueRate(`embed:site:${embedder}`, EMBEDS_PER_SITE_PER_MINUTE)
    )
      return embedRateLimited(method);
  }
  let embeddable: RaftEmbeddable | null;
  try {
    raftContent.host(env);
    embeddable = await embeddableOf(env, artifact);
  } catch {
    return embedUnavailable(method);
  }
  const contentOrigin = contentOriginOf(env, artifact);
  if (embeddable === null || contentOrigin === null) return embedNotFound(method);
  if (live !== undefined) return embedLive();
  logEmbedView(artifact, embeddable.kind, embedderOf(request));
  return embedOuterPage({ artifact, title: embeddable.title, contentOrigin, appOrigin: env.APP_ORIGIN!, method });
}

/**
 * `GET <origin>/_raft/embed` on the content domain: an embed session of the label's own
 * Artifact (never another: no id, version or query is read), below the embed host's outer page.
 * The one 404 (`embedNotFound`) while embeds are off, for a request a foreign page made
 * (`Sec-Fetch-Site` present and not `same-site`: the outer page is the content domain's site,
 * a third party isn't), and for an Artifact that doesn't embed (Raft's answer, `embeddableOf`).
 * Counted per client address (`open:embed:<address>`) and per Artifact before Raft is asked
 * (past either: `embedRateLimited`, 429). Then Porthole's anonymous grant with `embed` for its
 * current version (subject `embedSubjectOf`, no level, no user, a ten-minute session), minted in
 * this isolate's memory as `openTicket`'s (no D1 write, no nonce, no door), and the request
 * answered as Porthole answers that ticket's address. Every later request asks Raft's authorize
 * with the embed subject (`raftAuthorize`, reused 30 s).
 */
export async function openEmbed(request: Request, env: RaftContentEnv): Promise<Response> {
  const method = request.method.toUpperCase();
  if (embedDomainOf(env) === null || method !== "GET") return embedNotFound(method);
  const site = request.headers.get("sec-fetch-site");
  if (site !== null && site !== "same-site") return embedNotFound(method);
  const artifact = labelArtifactOf(request, env);
  if (artifact === null) return embedNotFound(method);
  if (
    !withinIssueRate(`open:embed:${clientOf(request)}`, EMBEDS_PER_VIEWER_PER_MINUTE) ||
    !withinIssueRate(`embed:open:${artifact}`, EMBEDS_PER_ARTIFACT_PER_MINUTE)
  )
    return embedRateLimited(method);
  let embeddable: RaftEmbeddable | null;
  try {
    embeddable = await embeddableOf(env, artifact);
  } catch {
    return embedUnavailable(method);
  }
  const instance = embeddable && raftInstance(artifact, embeddable.version);
  if (!embeddable || !instance) return embedNotFound(method);
  const server = raftContent.host(env).server;
  if (server === null) return contentUnavailable();
  const grant: Grant = {
    anonymous: true,
    embed: true,
    subject: embedSubjectOf(artifact, embeddable.version),
    ttlSeconds: TICKET_SECONDS,
    sessionSeconds: ANONYMOUS_SESSION_SECONDS,
  };
  let issuing: ReturnType<typeof server.issue>;
  handingOff = true;
  try {
    issuing = server.issue(instance, grant);
  } finally {
    handingOff = false;
  }
  const location = await issuing;
  return (await raftContent.fetch(new Request(location.url, { method: "GET", headers: request.headers }), env)) ?? contentUnavailable();
}

/** Whether a request's host is under the content domain (Porthole's alone). */
export function onContentDomain(request: Request, env: RaftContentEnv): boolean {
  const domain = (env.CONTENT_DOMAIN ?? "").trim().toLowerCase().replace(/:\d+$/, "");
  if (domain === "") return false;
  const hosts = [new URL(request.url).hostname, (request.headers.get("host") ?? "").replace(/:\d+$/, "")];
  return hosts.some((host) => {
    const name = host.toLowerCase();
    return name === domain || name.endsWith(`.${domain}`);
  });
}

/**
 * The Worker: the content domain is Porthole's (every request there is the
 * kit's, but a signed ticket's `/_raft/open`, which hands it to the kit, a
 * signed door ticket's door, which Porthole's `doorAnswer` answers, and an
 * embed's `/_raft/embed`, which mints the session for the kit); the embed host
 * (EMBED_DOMAIN) is Raft's outer page (`embedHost`); on any other host only the
 * issue route answers.
 */
export async function handleRaftContent(request: Request, env: RaftContentEnv): Promise<Response> {
  const embedDomain = env.EMBED_DOMAIN?.trim().toLowerCase() ?? "";
  if (embedDomain !== "" && !onContentDomain(request, env) && onEmbedDomain(request, embedDomain)) return embedHost(request, env);
  if (!onContentDomain(request, env) && new URL(request.url).pathname === ISSUE_PATH) return issueFrame(request, env);
  if (onContentDomain(request, env)) {
    // Settings that can't be served: the reason goes to the log (`raftContent`'s `log`, once per
    // isolate's settings), never to the visitor. Porthole's own answer would name it.
    try {
      raftContent.host(env);
    } catch {
      return contentUnavailable();
    }
    // Expired embed authorize memos go, with Porthole's copies of them, before Porthole answers anything.
    sweepEmbedAuthorized(env);
    const { pathname } = new URL(request.url);
    if (pathname === ARTIFACT_CONTENT_OPEN_PATH) return openTicket(request, env);
    if (pathname === ARTIFACT_CONTENT_DOOR_PATH) return openDoor(request, env);
    if (pathname === ARTIFACT_CONTENT_EMBED_PATH) return openEmbed(request, env);
    return (await raftContent.fetch(request, env)) ?? refusal(404, "not-found", "Not found");
  }
  return refusal(404, "not-found", "Not found");
}

/** The content domain's answer while its settings can't be served: the same for every visitor, no reason. */
export const CONTENT_UNAVAILABLE = "Content is unavailable.";
const contentUnavailable = () =>
  new Response(CONTENT_UNAVAILABLE, {
    status: 503,
    headers: {
      "content-type": "text/plain; charset=utf-8",
      "cache-control": "no-store",
      "x-content-type-options": "nosniff",
      "x-robots-tag": "noindex, nofollow",
    },
  });
