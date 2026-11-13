/**
 * Where this daemon (one Raft Computer runner = one attached server) uploads
 * its trace bundles. Shared so the Computer's forced diagnostics upload
 * (computer/src/services/diagnosticsPush.ts) picks each attachment's receiver
 * by the same rule; the daemon re-exports it from daemon/src/traceUploadUrl.ts.
 *
 * Resolution, highest first:
 *   0. RAFT_PRIVACY_MODE (this daemon's own, or its server's `machine:context`
 *      `privacyMode`) — no upload at all.
 *   1. `SLOCK_DAEMON_TRACE_UPLOAD_DISABLED=1` — no upload at all.
 *   2. `SLOCK_DAEMON_TRACE_UPLOAD_URL` — the machine owner's choice; any URL.
 *   3. `traceUploadUrl` from the server's `machine:context` — only when it
 *      passes {@link acceptServerTraceUploadUrl}.
 *   4. The default for the server this runner is attached to
 *      ({@link defaultTraceUploadUrlForServer}): the staging receiver for the
 *      AWS staging server, {@link DEFAULT_TRACE_UPLOAD_URL} (production) for
 *      Raft's production server, and **nothing** for any other server. A
 *      self-hosted server's Computer uploads only where its owner points it
 *      (`SLOCK_DAEMON_TRACE_UPLOAD_URL`) or its server names an allowlisted
 *      receiver (#proj-raft-computer:#54, tygg #proj-o11y:880945a7: its data
 *      used to reach Raft's receiver, which only rejected it). The server URL
 *      is the owner's `setup --server-url`, not something the server says, so
 *      this widens nothing a server can steer (#botiverse-raft-deployment:#211).
 *
 * The default used to be the one URL for every environment. Daemon telemetry
 * that reached it was all `env=production`; staging and dev runners only got
 * rejected (their attestations are signed with another secret) or mislabelled.
 * So the server a runner is attached to now names its receiver.
 *
 * A server-named URL is NOT trusted blindly: an upload carries this runner's
 * machine credential (the scope attestation) and its traces. The server may
 * only pick from a built-in allowlist — the production receiver over https
 * on port 443, or a loopback host (http or https, any port) for raftdev, and
 * the loopback host only when that server is itself on a loopback host.
 * Anything else is ignored and the default is used.
 */

/** Production trace-upload receiver (AWS ECS; rfcs/016 "stable public receiver origin"). */
export const DEFAULT_TRACE_UPLOAD_URL = "https://slock-trace-upload.botiverse.dev";

/** The AWS staging server (`setup --server-url`), https on 443 only. */
const STAGING_SERVER_HOST = "api-aws-staging.botiverse.dev";

/**
 * The staging receiver: the staging API host routes `/__trace` to the staging
 * trace-upload worker (`/__trace/healthz` 200, cross 8a070e48). Bundles a
 * staging runner sent to production were rejected 401: the two environments
 * sign attestations with different secrets.
 */
export const STAGING_TRACE_UPLOAD_URL = "https://api-aws-staging.botiverse.dev/__trace";

/**
 * Raft's production server hosts (`setup --server-url`), https on 443 only:
 * the current one and the legacy one Computers set up before the rename keep
 * (packages/computer serverUrl.ts LEGACY_PRODUCTION_SERVER_URL).
 */
const PRODUCTION_SERVER_HOSTS: ReadonlySet<string> = new Set(["api.raft.build", "api.slock.ai"]);

/**
 * Default receiver for a runner attached to `serverUrl`: staging for the AWS
 * staging server, production for Raft's production server, and null (no
 * upload) for every other server, a missing or an unparsable URL.
 */
export function defaultTraceUploadUrlForServer(serverUrl: string | undefined): string | null {
  if (!serverUrl) return null;
  try {
    const url = new URL(serverUrl);
    if (url.protocol !== "https:" || url.port !== "" || url.username !== "" || url.password !== "") return null;
    if (url.hostname === STAGING_SERVER_HOST) return STAGING_TRACE_UPLOAD_URL;
    if (PRODUCTION_SERVER_HOSTS.has(url.hostname)) return DEFAULT_TRACE_UPLOAD_URL;
  } catch {
    // not one of Raft's servers
  }
  return null;
}

/**
 * Hosts a server may name, https only, port 443 only. Production only: no
 * staging receiver hostname is recorded anywhere in this repo (the staging
 * smoke URL lives in a GitHub variable), so none is listed. Add it here, with
 * its evidence, once it is known.
 */
const SERVER_TRACE_UPLOAD_HOSTS: ReadonlySet<string> = new Set([
  "slock-trace-upload.botiverse.dev",
]);

/** Loopback hosts (WHATWG-normalized `hostname`): http or https, any port. */
const LOOPBACK_HOSTS: ReadonlySet<string> = new Set(["localhost", "127.0.0.1", "[::1]"]);

const MAX_SERVER_TRACE_UPLOAD_URL_LENGTH = 2048;

export type ServerTraceUploadUrlRejection =
  | "not_string"
  | "malformed"
  | "userinfo"
  | "scheme"
  | "host_not_allowed"
  | "loopback_from_remote_server"
  | "port"
  | "path";

export type ServerTraceUploadUrlCheck =
  | { ok: true; url: string }
  | { ok: false; reason: ServerTraceUploadUrlRejection };

/**
 * Accept a server-named trace upload URL only when it is an allowlisted
 * receiver origin. Returns the canonical origin (no path, no trailing slash).
 *
 * Rejected outright: anything not printable ASCII (so no IDN lookalike
 * reaches the parser), any `@` (userinfo, even empty), backslashes, and a
 * non-empty path, query or fragment after WHATWG parsing.
 *
 * Normalized by WHATWG URL first, then matched exactly on the hostname — these
 * are accepted when the result is allowlisted, and only the canonical
 * `url.origin` is ever returned (so nothing of the raw string is fetched):
 * case (`HTTPS://SLOCK-…` → lowercase), the default port (`:443`, `:0443`),
 * percent-encoded host bytes (`%2e`, `%6c`), dot segments and empty `?`/`#`
 * (`/..` → `/`), and IPv4 shorthands (`127.1`, `0x7f.0.0.1`, `2130706433` →
 * `127.0.0.1`, which IS loopback). A trailing dot (`…dev.`, `localhost.`),
 * subdomains (`a.localhost`), other loopback addresses (`127.0.0.2`) and
 * IPv4-mapped IPv6 (`[::ffff:127.0.0.1]`) do not normalize to an allowlisted
 * hostname and are rejected.
 */
export function acceptServerTraceUploadUrl(
  raw: unknown,
  /** The URL of the server that sent `raw`. A loopback receiver is accepted only from a loopback server. */
  context: { serverUrl: string },
): ServerTraceUploadUrlCheck {
  if (typeof raw !== "string") return { ok: false, reason: "not_string" };
  if (raw.length === 0 || raw.length > MAX_SERVER_TRACE_UPLOAD_URL_LENGTH) return { ok: false, reason: "malformed" };
  // Printable ASCII only, no spaces: rejects IDN / homoglyph hosts, and any
  // whitespace or control character the URL parser would silently strip.
  if (!/^[\x21-\x7e]+$/.test(raw)) return { ok: false, reason: "malformed" };
  if (raw.includes("@")) return { ok: false, reason: "userinfo" };
  if (raw.includes("\\")) return { ok: false, reason: "malformed" };
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return { ok: false, reason: "malformed" };
  }
  if (url.username !== "" || url.password !== "") return { ok: false, reason: "userinfo" };
  if (url.protocol !== "https:" && url.protocol !== "http:") return { ok: false, reason: "scheme" };
  if ((url.pathname !== "/" && url.pathname !== "") || url.search !== "" || url.hash !== "") {
    return { ok: false, reason: "path" };
  }
  const host = url.hostname;
  if (LOOPBACK_HOSTS.has(host)) {
    // A remote server must not steer this machine's uploads (and their
    // attestation) to whatever listens on a local port; only a local dev
    // server (raftdev) may name a local receiver.
    if (!isLoopbackServerUrl(context.serverUrl)) return { ok: false, reason: "loopback_from_remote_server" };
    return { ok: true, url: url.origin };
  }
  if (!SERVER_TRACE_UPLOAD_HOSTS.has(host)) return { ok: false, reason: "host_not_allowed" };
  if (url.protocol !== "https:") return { ok: false, reason: "scheme" };
  // WHATWG drops the scheme's default port, so `:443` reads back as "".
  if (url.port !== "") return { ok: false, reason: "port" };
  return { ok: true, url: url.origin };
}

/** True when the daemon's own server URL is on a loopback host (WHATWG-normalized). */
export function isLoopbackServerUrl(serverUrl: string): boolean {
  try {
    return LOOPBACK_HOSTS.has(new URL(serverUrl).hostname);
  } catch {
    return false;
  }
}

export type TraceUploadUrlSource = "env" | "server" | "default";

export type ResolvedTraceUploadUrl =
  | { url: string; source: TraceUploadUrlSource }
  /** `none`: attached to a server that is not Raft's, with no URL configured or named. */
  | { url: null; source: "disabled" | "none" };

/**
 * Resolve the upload URL for one runner's bundles. `serverTraceUploadUrl` is
 * the value the attached server sent, already checked with
 * {@link acceptServerTraceUploadUrl} (pass null when absent or rejected).
 */
export function resolveTraceUploadUrl(input: {
  env: NodeJS.ProcessEnv;
  serverTraceUploadUrl?: string | null;
  /** The URL of the server this runner is attached to; picks the default receiver. */
  serverUrl?: string;
  /** RAFT_PRIVACY_MODE (local or the server's): nothing is uploaded. */
  privacyMode?: boolean;
}): ResolvedTraceUploadUrl {
  if (input.privacyMode || input.env.SLOCK_DAEMON_TRACE_UPLOAD_DISABLED === "1") return { url: null, source: "disabled" };
  const envUrl = input.env.SLOCK_DAEMON_TRACE_UPLOAD_URL?.trim();
  if (envUrl) return { url: envUrl, source: "env" };
  if (input.serverTraceUploadUrl) return { url: input.serverTraceUploadUrl, source: "server" };
  const fallback = defaultTraceUploadUrlForServer(input.serverUrl);
  return fallback === null ? { url: null, source: "none" } : { url: fallback, source: "default" };
}

/**
 * The URL for machine-level bundles (the Computer's diagnostics markers, which
 * gather every runner's log tail, and feedback evidence): env or the default
 * for this runner's server only, never a server's choice, so one server
 * cannot receive another server's data. A runner attached to a server that is
 * not Raft's has no default: null.
 */
export function resolveMachineTraceUploadUrl(env: NodeJS.ProcessEnv, serverUrl?: string, privacyMode = false): string | null {
  return resolveTraceUploadUrl({ env, serverTraceUploadUrl: null, serverUrl, privacyMode }).url;
}
