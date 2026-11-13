// The content origin (S2): what Raft and the content Worker say to each other
// (docs/development/workspace-artifacts-content-origin.md, "Internal
// contract", "Tickets" and "Tokens"). Here: the subject and viewer a frame is
// for, the frame itself (its ticket signed here, with no call to the Worker),
// and the tokens the Worker calls Raft with. The routes that use them are in
// webRoutes.ts and webViewer.ts (the frame), publicRoutes.ts (a signed-out
// visitor's frame) and contentRoutes.ts (authorize, manifest); a publish
// check's ticket is checkFrame.ts's (signCheckContentFrame), for the check's
// durable task alone (checkTask.ts).
//
// Secrets and tickets never reach a log: a frame's url carries a ticket and
// is never logged, nor is a token or the key derived from it.
import { createHash, timingSafeEqual } from "node:crypto";
import { asArtifactInstanceVersion, asServerId, type ArtifactFramedKind, type ArtifactWebFrame, type ServerId } from "@botiverse/raft-shared";
import {
  ARTIFACT_CONTENT_DOOR_PATH,
  ARTIFACT_CONTENT_OPEN_PATH,
  ARTIFACT_CONTENT_TICKET_SECONDS,
  artifactContentTicketKey,
  ARTIFACT_CONTENT_CHECK_VIEWER,
  artifactContentTicketNonce,
  signArtifactContentTicket,
  type ArtifactContentTicketKey,
} from "@botiverse/raft-shared/src/artifactContentTicket";
import { maybeSameSite } from "@botiverse/raft-shared/src/sameSite";
import { appHosts } from "../../platform/links";
import { withAppSpan } from "../../platform/tracing";

/** Every shared secret between Raft and the Worker is at least this many bytes. */
export const CONTENT_TOKEN_MIN_BYTES = 32;

/** Who a frame is for: the reader, the server they read in, and their sign-in (null for a legacy token without one). */
export interface ContentSubject {
  serverId: ServerId;
  userId: string;
  sessionFamilyId: string | null;
}

/** `v1:<server>:<user>:<session family or ->`, which the Worker hands back on every authorize. */
export const contentSubject = (subject: ContentSubject): string =>
  `v1:${subject.serverId}:${subject.userId}:${subject.sessionFamilyId ?? "-"}`;

/** The grant's viewer (Porthole `Grant.viewer`): the reader's user id. */
export const contentViewer = (userId: string): string => `user:${userId}`;

const UUID = "[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}";
const SUBJECT = new RegExp(`^v1:(${UUID}):(${UUID}):(${UUID}|-)$`);

/** A subject exactly as contentSubject writes it (lowercase uuids), or null. */
export function parseContentSubject(value: string): ContentSubject | null {
  const match = SUBJECT.exec(value);
  if (!match) return null;
  return { serverId: asServerId(match[1]!), userId: match[2]!, sessionFamilyId: match[3] === "-" ? null : match[3]! };
}

/**
 * A signed-out visitor's frame (publicRoutes.ts): no user, no server, no
 * sign-in. The subject names the Artifact and the version it was issued for,
 * `v1:anon:pt_<uuid>:v_<uuid>`, and the viewer is ANONYMOUS_CONTENT_VIEWER:
 * the Worker issues it with Porthole's anonymous grant, and authorize allows
 * it only for that Artifact's current version while the Artifact is public
 * (contentRoutes.ts decideAnonymous). Never confused with a reader's subject:
 * `anon` is not a uuid.
 */
export interface AnonymousContentSubject {
  artifact: string;
  version: string;
}

/** The viewer of every anonymous frame request (no user: Porthole's anonymous grant). */
export const ANONYMOUS_CONTENT_VIEWER = "anonymous";

/** `v1:anon:<pt_…>:<v_…>`. */
export const anonymousContentSubject = (subject: AnonymousContentSubject): string => `v1:anon:${subject.artifact}:${subject.version}`;

const ANONYMOUS_SUBJECT = new RegExp(`^v1:anon:(pt_${UUID}):(v_${UUID})$`);

/** A subject exactly as anonymousContentSubject writes it (lowercase uuids), or null. */
export function parseAnonymousContentSubject(value: string): AnonymousContentSubject | null {
  const match = ANONYMOUS_SUBJECT.exec(value);
  return match ? { artifact: match[1]!, version: match[2]! } : null;
}

/**
 * A publish check's ticket (task #130; checkFrame.ts, which only the check's
 * durable task may import): Raft's server opening one version top-level in a
 * headless browser (the check Worker's). No user, no server, no sign-in: the
 * subject names the Artifact and the version, `v1:check:pt_<uuid>:v_<uuid>`,
 * and the viewer is shared ARTIFACT_CONTENT_CHECK_VIEWER (`system:check`);
 * like every ticket it names no ancestor. Authorize allows it only for that
 * very version while its check is running (contentRoutes.ts decideCheck).
 * Never confused with another subject: `check` is neither a uuid nor `anon`.
 */
export interface CheckContentSubject {
  artifact: string;
  version: string;
}

/** `v1:check:<pt_…>:<v_…>`. */
export const checkContentSubject = (subject: CheckContentSubject): string => `v1:check:${subject.artifact}:${subject.version}`;

const CHECK_SUBJECT = new RegExp(`^v1:check:(pt_${UUID}):(v_${UUID})$`);

/** A subject exactly as checkContentSubject writes it (lowercase uuids), or null. */
export function parseCheckContentSubject(value: string): CheckContentSubject | null {
  const match = CHECK_SUBJECT.exec(value);
  return match ? { artifact: match[1]!, version: match[2]! } : null;
}

/**
 * An embed session's subject (Porthole P143; #proj-workspace:#260): the content
 * Worker mints it itself, below its embed host's outer page, for a public
 * Artifact's current version, `v1:embed:pt_<uuid>:v_<uuid>`, in a session that
 * any page may frame. Raft never signs one (signContentFrame refuses it), and
 * authorize allows it exactly as a signed-out visitor's: that version, while it
 * is current and the Artifact public (contentRoutes.ts decideEmbed). Never
 * confused with another subject: `embed` is neither a uuid, `anon` nor `check`.
 */
export interface EmbedContentSubject {
  artifact: string;
  version: string;
}

/** `v1:embed:<pt_…>:<v_…>`. */
export const embedContentSubject = (subject: EmbedContentSubject): string => `v1:embed:${subject.artifact}:${subject.version}`;

const EMBED_SUBJECT = new RegExp(`^v1:embed:(pt_${UUID}):(v_${UUID})$`);

/** A subject exactly as embedContentSubject writes it (lowercase uuids), or null. */
export function parseEmbedContentSubject(value: string): EmbedContentSubject | null {
  const match = EMBED_SUBJECT.exec(value);
  return match ? { artifact: match[1]!, version: match[2]! } : null;
}

const byteLength = (value: string) => Buffer.byteLength(value, "utf8");
const digestOf = (value: string) => createHash("sha256").update(value, "utf8").digest();

/**
 * Whether the token Raft calls the Worker with is also one the Worker may
 * call Raft with (Tenny, #proj-workspace:4fb9afce 47352ef2). Then a leak on
 * either side gives away both directions, so both configurations count as
 * unusable: framed Artifacts answer 503 and the internal content routes 404.
 */
function tokensShared(env: NodeJS.ProcessEnv): boolean {
  const worker = env.ARTIFACTS_CONTENT_WORKER_TOKEN?.trim() ?? "";
  if (!worker) return false;
  return (env.ARTIFACTS_CONTENT_RAFT_TOKENS ?? "").split(",").some((token) => token.trim() === worker);
}
const SHARED_TOKEN_PROBLEM = "ARTIFACTS_CONTENT_WORKER_TOKEN is also in ARTIFACTS_CONTENT_RAFT_TOKENS: each direction needs its own token";

// ---- Raft → Worker: the frame's ticket ------------------------------------------

interface FrameConfig {
  /** `ARTIFACTS_CONTENT_WORKER_TOKEN`: the secret tickets are signed with (one of the Worker's RAFT_TOKENS). */
  token: string;
  /** `ARTIFACTS_CONTENT_DOMAIN`, lowercase `host[:port]`: every frame origin is `<scheme>://w-<uuid>.<it>`. */
  contentDomain: string;
}

/**
 * The content domain, `host[:port]` with no scheme or path (the web's
 * `VITE_ARTIFACTS_CONTENT_DOMAIN` for the same deployment), lowercase; null
 * when it isn't one.
 */
function contentDomainOf(value: string): string | null {
  const domain = value.trim().toLowerCase();
  if (!/^[a-z0-9]([a-z0-9-]*[a-z0-9])?(\.[a-z0-9]([a-z0-9-]*[a-z0-9])?)+(:[0-9]{1,5})?$/.test(domain)) return null;
  return domain;
}

let frameConfigMemo: { raw: string; config: FrameConfig | null } | null = null;

/**
 * What frames are signed with: `ARTIFACTS_CONTENT_WORKER_TOKEN` and
 * `ARTIFACTS_CONTENT_DOMAIN`, both or nothing: null when unset, and when
 * partial, a token shorter than 32 bytes, a domain that isn't a
 * `host[:port]`, or the token also one Raft accepts from the Worker (with a
 * warning naming what is wrong, once per configuration).
 * `ARTIFACTS_CONTENT_WORKER_URL` is no longer read: Raft never calls the
 * Worker for a frame.
 */
function contentFrameConfig(env: NodeJS.ProcessEnv = process.env): FrameConfig | null {
  const token = env.ARTIFACTS_CONTENT_WORKER_TOKEN?.trim() ?? "";
  const domain = env.ARTIFACTS_CONTENT_DOMAIN?.trim() ?? "";
  const raw = `${token}\n${domain}\n${env.ARTIFACTS_CONTENT_RAFT_TOKENS ?? ""}`;
  if (frameConfigMemo?.raw === raw) return frameConfigMemo.config;
  const problem = !token && !domain
    ? null
    : !token
      ? "ARTIFACTS_CONTENT_WORKER_TOKEN is missing"
      : byteLength(token) < CONTENT_TOKEN_MIN_BYTES
        ? `ARTIFACTS_CONTENT_WORKER_TOKEN is shorter than ${CONTENT_TOKEN_MIN_BYTES} bytes`
        : !contentDomainOf(domain)
          ? "ARTIFACTS_CONTENT_DOMAIN is missing or not a host[:port]"
          : tokensShared(env) ? SHARED_TOKEN_PROBLEM : null;
  const config = token && !problem ? { token, contentDomain: contentDomainOf(domain)! } : null;
  if (problem) console.warn("[artifacts] content frame configuration is unusable; framed Artifacts answer 503", { problem });
  frameConfigMemo = { raw, config };
  return config;
}

/** Whether the content origin is configured (contentFrameConfig): without it no framed Artifact can be shown. */
export function contentFrameConfigured(env: NodeJS.ProcessEnv = process.env): boolean {
  return contentFrameConfig(env) !== null;
}

let ticketKeyMemo: { token: string; key: Promise<ArtifactContentTicketKey> } | null = null;

/** The signing key (and kid) of the configured token, derived once per token. */
function ticketKeyOf(token: string): Promise<ArtifactContentTicketKey> {
  if (ticketKeyMemo?.token !== token) ticketKeyMemo = { token, key: artifactContentTicketKey(token) };
  return ticketKeyMemo.key;
}

/**
 * An Artifact's own content origin, `w-<uuid>.<content domain>`: https, or
 * http on a `localhost` / `*.localhost` content domain (local development,
 * which the web's dev build alone frames).
 */
export function contentOriginOf(artifact: string, contentDomain: string): string | null {
  const uuid = /^pt_([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})$/.exec(artifact)?.[1];
  if (!uuid) return null;
  const hostname = contentDomain.replace(/:[0-9]+$/, "");
  const scheme = hostname === "localhost" || hostname.endsWith(".localhost") ? "http" : "https";
  return `${scheme}://w-${uuid}.${contentDomain}`;
}

/**
 * What a frame is signed for: a reader's (`viewer` `user:<uuid>`, `subject`
 * contentSubject) or a signed-out visitor's (`viewer`
 * ANONYMOUS_CONTENT_VIEWER, `subject` anonymousContentSubject of the same
 * artifact and version).
 */
export interface ContentFrameRequest {
  /** `pt_…` */
  artifact: string;
  /** `v_…` */
  version: string;
  viewer: string;
  subject: string;
  /**
   * The page of the version the frame opens at instead of its entry (the
   * ticket's `page`: shared `artifactContentTicketPage` of a file's path),
   * a reader's or a visitor's only. Absent: the entry.
   */
  page?: string;
}

/** A hostname as compared below: trimmed, lowercase, without a trailing dot. */
const comparableHostname = (host: string): string => host.trim().toLowerCase().replace(/\.+$/, "");

/**
 * The content domain's hostname: `host[:port]` without the port (a value
 * written as a URL, which the configuration refuses anyway, by its
 * hostname), lowercase, without a trailing dot; null when unset or blank.
 */
function contentDomainHostname(value: string | undefined): string | null {
  const raw = value?.trim() ?? "";
  if (!raw) return null;
  let host: string;
  if (raw.includes("://")) {
    if (!URL.canParse(raw)) return null;
    host = new URL(raw).hostname;
  } else {
    host = raw.replace(/\/.*$/, "").replace(/:[0-9]*$/, "");
  }
  return comparableHostname(host) || null;
}


/**
 * The first of Raft's own app hosts (platform/links appHosts: the canonical
 * host, APP_URL's, Raft's earlier hosts, APP_PERMALINK_HOSTS; what the web
 * gets as `appHosts`) that the content domain may be the same site as
 * (maybeSameSite: a frame there would be refused at run time anyway). Null
 * when none is or the content domain is unset.
 */
export function contentDomainAppHostOverlap(contentDomain: string | undefined, hosts: readonly string[]): { contentDomain: string; appHost: string } | null {
  const domain = contentDomainHostname(contentDomain);
  if (!domain) return null;
  for (const host of hosts) {
    const appHost = comparableHostname(host);
    if (appHost && maybeSameSite(domain, appHost)) return { contentDomain: domain, appHost };
  }
  return null;
}

/**
 * Refuses (throws) a content domain on the same site as one of Raft's app
 * hosts. Artifact pages run on `w-<uuid>.<content domain>` with their own
 * script: on Raft's site they would share its cookies and links, which the
 * separate content domain exists to prevent; the web's frame check refuses
 * every such frame, so the server stops at startup instead.
 */
export function assertContentDomainApartFromAppHosts(env: NodeJS.ProcessEnv = process.env, hosts: readonly string[] = appHosts()): void {
  const overlap = contentDomainAppHostOverlap(env.ARTIFACTS_CONTENT_DOMAIN, hosts);
  if (!overlap) return;
  throw new Error(
    `ARTIFACTS_CONTENT_DOMAIN ${overlap.contentDomain} is on the same site as Raft's app host ${overlap.appHost} `
      + "(the canonical host, APP_URL, Raft's earlier hosts or APP_PERMALINK_HOSTS): "
      + "the content domain must not be on the same site as an app host (the same host, or sharing the last two labels)",
  );
}

/**
 * Reads (and warns about) the frame configuration now: called at startup so
 * a bad one is logged before the first request. A content domain that
 * overlaps one of Raft's app hosts throws: the server refuses to start.
 */
export function checkContentWorkerConfig(env: NodeJS.ProcessEnv = process.env): void {
  assertContentDomainApartFromAppHosts(env);
  contentFrameConfig(env);
}

/** How a frame went, for its span (`server.artifacts.frame.issue`, trace.ts). */
export interface IssuedFrame {
  frame: ArtifactWebFrame | null;
  outcome: "issued" | "not_configured" | "failed";
  errorClass?: string;
}

/**
 * The frame for a version Raft has decided the reader may see: url
 * `<origin>/_raft/open?ticket=<ticket>` on that Artifact's own origin, the
 * ticket signed here (shared artifactContentTicket: artifact, version,
 * viewer, subject, origin, ARTIFACT_CONTENT_TICKET_SECONDS, a nonce the
 * Worker opens once) with the configured token's key; and its door (Porthole
 * P125, P126), `door.url` `<origin>/__porthole/door/_raft?ticket=<door
 * ticket>`, the same claims with `door: true` and a nonce of its own, which
 * the web's Porthole frames first and takes how loading went from (a frame
 * that opens at another page than the entry, `request.page`, says that page
 * in both); and
 * `instanceVersion`, the version id the tickets name, which the web mounts its
 * frame's Porthole instance with (ArtifactInstanceVersion). No call to
 * the Worker. Null when the content origin isn't configured. `kind`: for the
 * span only. Never a publish check's: a check viewer or subject is refused
 * here (null, a `failed` span), whatever the caller (signCheckContentFrame
 * signs those, without a door). Never an embed session's either: an embed
 * subject is refused here too (the content Worker alone mints those).
 */
export async function signContentFrame(request: ContentFrameRequest, trace: { kind: ArtifactFramedKind }): Promise<ArtifactWebFrame | null> {
  const issued = await withAppSpan("server.artifacts.frame.issue", { kind: trace.kind }, () => signFrame(request, "reader"), {
    onSuccess: (result) => ({
      outcome: result.outcome,
      ...(result.errorClass === undefined ? {} : { error_class: result.errorClass }),
    }),
    statusOf: (result) => frameIssueStatus(result, isDeployedEnvironment()),
  });
  return issued.frame;
}

/**
 * The deployments Terraform names in `DEPLOYMENT_ENV` (infra/aws-server/envs:
 * production, staging, release-qa). Anything else is local development
 * (raftdev's `slockdev`, unset in tests and a bare `pnpm dev`).
 */
const DEPLOYED_ENVIRONMENTS: ReadonlySet<string> = new Set(["production", "staging", "release-qa"]);

/** This server runs in one of Raft's deployments (`DEPLOYMENT_ENV`), not local development. */
export function isDeployedEnvironment(env: NodeJS.ProcessEnv = process.env): boolean {
  return DEPLOYED_ENVIRONMENTS.has(env.DEPLOYMENT_ENV?.trim() ?? "");
}

/**
 * The `server.artifacts.frame.issue` span's status: ok for a frame signed,
 * and for no content origin configured in local development. A deployment
 * without a usable configuration is misconfigured, and a signature that
 * failed is our bug.
 */
export function frameIssueStatus(result: Pick<IssuedFrame, "outcome">, deployed: boolean): "ok" | "error" {
  switch (result.outcome) {
    case "issued":
      return "ok";
    case "not_configured":
      return deployed ? "error" : "ok";
    case "failed":
      return "error";
  }
}

/**
 * A publish check's ticket for one version (viewer ARTIFACT_CONTENT_CHECK_VIEWER,
 * subject checkContentSubject of that very Artifact and version), naming no
 * ancestor: the check's headless browser opens it top-level. Signed as any
 * frame is. Its one caller is checkFrame.ts signCheckFrame;
 * checkFrame.structure.test.ts refuses any other module naming this, and any
 * importer of checkFrame.ts but the check's durable task (Tenny: only the
 * server's durable task signs a check ticket). The frame routes'
 * signContentFrame refuses a check viewer or subject.
 */
export function signCheckContentFrame(subject: CheckContentSubject): Promise<IssuedFrame> {
  return signFrame({ ...subject, viewer: ARTIFACT_CONTENT_CHECK_VIEWER, subject: checkContentSubject(subject) }, "check");
}

/**
 * Whether `request` is what its signer may sign: a reader's or a visitor's
 * (`reader`: never the check viewer, never a check subject, never an embed
 * subject) or exactly a check's (`check`: the check viewer and the check
 * subject of its own ids). No signer signs an embed subject.
 */
function signable(request: ContentFrameRequest, as: "reader" | "check"): boolean {
  if (parseEmbedContentSubject(request.subject) !== null) return false;
  const checkSubject = parseCheckContentSubject(request.subject);
  if (as === "reader") return request.viewer !== ARTIFACT_CONTENT_CHECK_VIEWER && checkSubject === null;
  return request.viewer === ARTIFACT_CONTENT_CHECK_VIEWER
    && checkSubject !== null && checkSubject.artifact === request.artifact && checkSubject.version === request.version;
}

/**
 * A frame's tickets: its content's and, for a reader or a visitor (`reader`),
 * its door's (the same claims, `door: true`, a nonce of its own). A publish
 * check's (`check`) has no door: its headless browser opens the ticket
 * top-level, no host frames a door, and the shared signer refuses one.
 */
async function signFrame(request: ContentFrameRequest, as: "reader" | "check"): Promise<IssuedFrame> {
  const config = contentFrameConfig();
  const origin = config && contentOriginOf(request.artifact, config.contentDomain);
  if (!config || !origin) return { frame: null, outcome: "not_configured" };
  try {
    if (!signable(request, as)) throw new TypeError(as === "reader" ? "a frame route never signs a publish check's or an embed's ticket" : "not a publish check's ticket");
    const key = await ticketKeyOf(config.token);
    const expires = Math.floor(Date.now() / 1000) + ARTIFACT_CONTENT_TICKET_SECONDS;
    const sign = (door: boolean) => signArtifactContentTicket(key, {
      artifact: request.artifact,
      version: request.version,
      viewer: request.viewer,
      subject: request.subject,
      origin,
      expires,
      nonce: artifactContentTicketNonce(),
      ...(door ? { door: true as const } : {}),
      // The door answers for the page the frame opens at, so both tickets name it.
      ...(request.page === undefined ? {} : { page: request.page }),
    });
    const ticket = await sign(false);
    const door = as === "reader" ? { door: { url: `${origin}${ARTIFACT_CONTENT_DOOR_PATH}?ticket=${await sign(true)}` } } : {};
    // The version as the Worker's instance names it, for the web's frame instance (#proj-workspace:#251):
    // Porthole takes an in-set page's notice only when its set is the mounted instance's, exactly.
    const instanceVersion = as === "reader" ? asArtifactInstanceVersion(request.version) : null;
    return {
      frame: { url: `${origin}${ARTIFACT_CONTENT_OPEN_PATH}?ticket=${ticket}`, origin, reports: true, ...door, ...(instanceVersion ? { instanceVersion } : {}) },
      outcome: "issued",
    };
  } catch (error) {
    const errorClass = error instanceof Error ? error.name : typeof error;
    console.warn("[artifacts] content frame signing failed", { errorClass });
    return { frame: null, outcome: "failed", errorClass };
  }
}

// ---- Worker → Raft -------------------------------------------------------------

let callerTokensMemo: { raw: string; digests: Buffer[] } | null = null;

/**
 * The tokens the Worker may call Raft with, from the comma list
 * `ARTIFACTS_CONTENT_RAFT_TOKENS` (more than one while rotating), as sha256
 * digests. A token shorter than 32 bytes is ignored, with a warning naming
 * its position. Empty: the internal content routes answer 404.
 */
export function contentCallerTokens(env: NodeJS.ProcessEnv = process.env): readonly Buffer[] {
  const list = env.ARTIFACTS_CONTENT_RAFT_TOKENS ?? "";
  const raw = `${list}\n${env.ARTIFACTS_CONTENT_WORKER_TOKEN ?? ""}`;
  if (callerTokensMemo?.raw === raw) return callerTokensMemo.digests;
  if (tokensShared(env)) {
    console.warn("[artifacts] content caller tokens are unusable; the internal content routes answer 404", { problem: SHARED_TOKEN_PROBLEM });
    callerTokensMemo = { raw, digests: [] };
    return callerTokensMemo.digests;
  }
  const listed = list.split(",").map((token) => token.trim()).filter((token) => token.length > 0);
  const short = listed.flatMap((token, index) => (byteLength(token) < CONTENT_TOKEN_MIN_BYTES ? [index] : []));
  if (short.length > 0) {
    console.warn(`[artifacts] ARTIFACTS_CONTENT_RAFT_TOKENS entries shorter than ${CONTENT_TOKEN_MIN_BYTES} bytes are ignored`, { positions: short });
  }
  const digests = listed.filter((token) => byteLength(token) >= CONTENT_TOKEN_MIN_BYTES).map(digestOf);
  callerTokensMemo = { raw, digests };
  return digests;
}

/**
 * Which configured token an `Authorization: Bearer <token>` header carries
 * (its position in the list), or null. Compared in constant time against
 * every configured token, matched or not.
 */
export function matchContentCaller(authorization: string | undefined, tokens: readonly Buffer[]): number | null {
  if (!authorization?.startsWith("Bearer ")) return null;
  const given = digestOf(authorization.slice("Bearer ".length));
  let matched: number | null = null;
  tokens.forEach((token, index) => {
    if (timingSafeEqual(given, token) && matched === null) matched = index;
  });
  return matched;
}
