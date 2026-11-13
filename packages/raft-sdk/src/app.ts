// `@botiverse/raft-sdk/app` (RFC 079 1c): the client a Raft App uses with a
// person's Login with Raft access token. Login proves who the person is;
// every Server-related request names its Server and Raft checks it live
// (RFC 079 §5.4, §5.5). So the top-level client reads only identity and the
// list of Servers, and every Server request goes through `forServer(id)`,
// which adds `server_id` itself: a request without a Server cannot be
// written (§8.2 item 3). Nothing is cached here: roles and membership come
// from Raft on every call (§8.2 item 2). Nothing here is exported from the
// package root or from `./agent`.
//
// Experimental: RFC 079 is still settling, so the shape may change in a minor
// release until account mode ships.
import { asServerId, type ServerId } from "@botiverse/raft-shared/src/brandedIds";

export type { ServerId };

/** The public Raft API origin the Raft Apps guide gives. */
const DEFAULT_BASE_URL = "https://api.raft.build";

// A Server id exactly as Raft returns it. The server refuses anything else
// (a slug, upper case) with its one 403; the SDK refuses it before asking.
const SERVER_ID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

export type RaftAppErrorCode =
  /** 403: this token cannot be used for that Server. Raft never says why or names a Server. */
  | "server_access_denied"
  /** 401: the access token is missing, invalid or expired, or the login lost its Server. Log in again. */
  | "unauthorized"
  /** 400: Raft found the request malformed. */
  | "invalid_request"
  /**
   * 429: too many requests with this token. Wait `retryAfterSeconds` (from
   * Retry-After, at least 1), then make the same call again; the refused one
   * changed nothing. The SDK never retries on its own.
   */
  | "rate_limited"
  /** Any other HTTP answer that is not a success. */
  | "http_error"
  /** A success whose body is not the documented shape. */
  | "invalid_response"
  /** fetch itself failed; `cause` holds its error. */
  | "network_error"
  /** `forServer` was given something that is not a Server id. No request was made. */
  | "invalid_server_id"
  /** `createRaftAppClient` options are unusable. No request was made. */
  | "invalid_options";

/**
 * Every failure of this client. `message` is the SDK's own text: it never
 * carries the access token, a response body or a Server's id, slug or name.
 */
export class RaftAppError extends Error {
  readonly name = "RaftAppError";

  constructor(
    readonly code: RaftAppErrorCode,
    message: string,
    /** The HTTP status of a refusal (the HTTP codes above); null for the others. */
    readonly status: number | null = null,
    options?: { cause?: unknown; retryAfterSeconds?: number },
  ) {
    super(message, options?.cause === undefined ? undefined : { cause: options.cause });
    if (options?.retryAfterSeconds !== undefined) (this as { retryAfterSeconds?: number }).retryAfterSeconds = options.retryAfterSeconds;
  }

  /** `rate_limited` only: whole seconds to wait before the same call (at least 1). */
  declare readonly retryAfterSeconds?: number;
}

/** The longest wait the client reports: Raft's windows are a minute; a larger value is a proxy's or junk. */
const MAX_RETRY_AFTER_SECONDS = 3600;

/**
 * Retry-After as whole seconds, 1 to MAX_RETRY_AFTER_SECONDS: delta-seconds
 * or an HTTP date; 1 when it is missing or unreadable, so a caller always has
 * a wait it can hand to setTimeout.
 */
function retryAfterSecondsOf(header: string | null): number {
  const value = header?.trim() ?? "";
  let seconds = Number.NaN;
  if (/^\d+$/.test(value)) seconds = Number(value);
  else if (value !== "") seconds = Math.ceil((Date.parse(value) - Date.now()) / 1000);
  if (!Number.isFinite(seconds)) return 1;
  return Math.min(MAX_RETRY_AFTER_SECONDS, Math.max(1, seconds));
}

export interface CreateRaftAppClientOptions {
  /** The person's (or agent's) Login with Raft access token. Never logged or put in an error. */
  accessToken: string;
  /** Raft API origin. Defaults to `https://api.raft.build`; a trailing slash is fine. */
  baseUrl?: string;
  /** fetch implementation (tests, proxies, timeouts). Defaults to the global fetch. */
  fetch?: typeof fetch;
}

/**
 * Open: Raft may add roles. Treat a role you don't know as least-privileged
 * (below `guest`), never as one you do.
 */
export type RaftAppServerRole = "owner" | "admin" | "member" | "guest" | (string & {});

/** Open: Raft may add principal kinds. Treat one you don't know as neither a person nor an agent. */
export type RaftAppPrincipalType = "human" | "agent" | (string & {});

/** A Server as `servers()` and `membership()` return it: exactly these four fields, read live. */
export interface RaftAppServer {
  /** The id to pass to `forServer`. */
  id: ServerId;
  /** For display and links only; never accepted where a Server is named. */
  slug: string;
  name: string;
  /** This person's (or agent's) role on the Server right now. */
  role: RaftAppServerRole;
}

export interface RaftAppServerList {
  /** The Servers where this person can use this app. A server-mode login lists at most its own. */
  servers: RaftAppServer[];
}

/** Who logged in. Server claims are left out: read them per Server through `forServer`. */
export interface RaftAppUserInfo {
  /** The account id: the only identity to key data on (RFC 079 §5.2). */
  sub: string;
  type: RaftAppPrincipalType;
  /** The handle. */
  preferred_username: string;
  name: string;
  avatar_url: string | null;
  picture: string | null;
  description: string | null;
  /** Present only when the login holds the `email` scope. Never authorizes anything. */
  email?: string;
  email_verified?: boolean;
  /** The scopes this token holds, space-separated. */
  scope: string;
  client_id: string;
  client_name: string;
}

export interface RaftAppServerInfo {
  id: ServerId;
  slug: string;
  name: string;
  avatar_url: string | null;
  picture: string | null;
  /** Absent means unknown: never grant a paid entitlement on it, never show a paid wall on it. */
  is_paid?: boolean;
  /** Absent means unknown, as for `is_paid`. */
  plan_tier?: "free" | "paid";
}

export interface RaftAppAgent {
  id: string;
  handle: string;
  display_name: string | null;
  avatar_url: string | null;
  picture: string | null;
}

export interface RaftAppAgentList {
  agents: RaftAppAgent[];
}

/** Reads that name no Server. There is no Server method and no way to pass a Server here. */
export interface RaftAppClient {
  /** `GET /api/oauth/userinfo`: who logged in. */
  userinfo(): Promise<RaftAppUserInfo>;
  /** `GET /api/oauth/servers`: the Servers where this person can use this app. */
  servers(): Promise<RaftAppServerList>;
  /**
   * A client for one Server. `serverId` is a Server id as `servers()`
   * returns it, never a slug; anything else throws `invalid_server_id`
   * before any request.
   */
  forServer(serverId: string): RaftAppServerClient;
}

/** Reads on one Server. Each request names it as `server_id`, and Raft checks it live. */
export interface RaftAppServerClient {
  readonly serverId: ServerId;
  /** `GET /api/oauth/serverinfo?server_id=`: the Server's public profile. */
  serverinfo(): Promise<RaftAppServerInfo>;
  /** `GET /api/oauth/membership?server_id=`: this person's live role there. */
  membership(): Promise<RaftAppServer>;
  /** `GET /api/oauth/agents?server_id=`: the Server's agents. Needs the `agent:read` scope. */
  agents(): Promise<RaftAppAgentList>;
}

export function createRaftAppClient(options: CreateRaftAppClientOptions): RaftAppClient {
  const accessToken = options?.accessToken;
  if (typeof accessToken !== "string" || accessToken.length === 0 || /\s/.test(accessToken)) {
    throw new RaftAppError("invalid_options", "accessToken must be the Login with Raft access token");
  }
  const base = requireBaseUrl(options.baseUrl ?? DEFAULT_BASE_URL);
  if (options.fetch === undefined && typeof globalThis.fetch !== "function") {
    throw new RaftAppError("invalid_options", "No global fetch in this runtime; pass options.fetch");
  }
  const doFetch: typeof fetch = options.fetch ?? ((input, init) => globalThis.fetch(input, init));

  async function get(endpoint: Endpoint, serverId?: ServerId): Promise<unknown> {
    const url = new URL(`${base}/api/oauth/${endpoint}`);
    if (serverId !== undefined) url.searchParams.set("server_id", serverId);
    const where = `/api/oauth/${endpoint}`;
    let response: Response;
    try {
      response = await doFetch(url.toString(), {
        method: "GET",
        headers: { authorization: `Bearer ${accessToken}`, accept: "application/json" },
        // These endpoints never redirect; following one would carry the token elsewhere.
        redirect: "error",
      });
    } catch (cause) {
      throw new RaftAppError("network_error", `Could not reach Raft for ${where}`, null, { cause });
    }
    if (!response.ok) throw await refusal(response, where);
    try {
      return await response.json();
    } catch {
      throw invalidResponse(where);
    }
  }

  const client: RaftAppClient = {
    async userinfo() {
      return parseUserInfo(await get("userinfo"));
    },
    async servers() {
      const body = await get("servers");
      const list = isRecord(body) ? body.servers : undefined;
      if (!Array.isArray(list)) throw invalidResponse("/api/oauth/servers");
      return { servers: list.map((entry) => parseServer(entry, "/api/oauth/servers")) };
    },
    forServer(serverId) {
      if (typeof serverId !== "string" || !SERVER_ID_RE.test(serverId)) {
        throw new RaftAppError(
          "invalid_server_id",
          "forServer needs a Server id as servers() returns it (a lowercase UUID); a slug or name is never accepted",
        );
      }
      const id = asServerId(serverId);
      return Object.freeze({
        serverId: id,
        async serverinfo() {
          return parseServerInfo(await get("serverinfo", id), id);
        },
        async membership() {
          const server = parseServer(await get("membership", id), "/api/oauth/membership");
          if (server.id !== id) throw invalidResponse("/api/oauth/membership");
          return server;
        },
        async agents() {
          const body = await get("agents", id);
          const list = isRecord(body) ? body.agents : undefined;
          if (!Array.isArray(list)) throw invalidResponse("/api/oauth/agents");
          return { agents: list.map(parseAgent) };
        },
      });
    },
  };
  return Object.freeze(client);
}

type Endpoint = "userinfo" | "servers" | "serverinfo" | "membership" | "agents";

/** Hosts a baseUrl may reach over plain HTTP (URL.hostname keeps IPv6 brackets). */
const LOOPBACK_HOSTS = new Set(["localhost", "127.0.0.1", "[::1]"]);

function requireBaseUrl(value: string): string {
  let parsed: URL;
  try {
    parsed = new URL(value);
  } catch {
    throw new RaftAppError("invalid_options", "baseUrl must be an absolute HTTP(S) URL");
  }
  if (parsed.protocol !== "https:" && parsed.protocol !== "http:") {
    throw new RaftAppError("invalid_options", "baseUrl must use HTTPS");
  }
  // The access token goes on every request: plain HTTP only to this machine
  // (a local dev server), never across a network.
  if (parsed.protocol === "http:" && !LOOPBACK_HOSTS.has(parsed.hostname)) {
    throw new RaftAppError("invalid_options", "baseUrl must use HTTPS (plain HTTP only for localhost, 127.0.0.1 or [::1])");
  }
  if (parsed.username || parsed.password || parsed.search || parsed.hash) {
    throw new RaftAppError("invalid_options", "baseUrl must not carry credentials, a query or a fragment");
  }
  return `${parsed.origin}${parsed.pathname}`.replace(/\/+$/, "");
}

// A 403 body is read only for its error code, and no other body is read;
// none of it reaches the error.
async function refusal(response: Response, where: string): Promise<RaftAppError> {
  const { status } = response;
  // Best effort: a fetch other than the platform's (node-fetch, cross-fetch)
  // may give a body without cancel(), or one that throws; the answer is the
  // RaftAppError either way.
  if (status !== 403) {
    try {
      await response.body?.cancel?.();
    } catch {
      // nothing to release
    }
  }
  if (status === 401) {
    return new RaftAppError("unauthorized", `Raft refused the access token (401) for ${where}: log in again`, status);
  }
  if (status === 400) {
    return new RaftAppError("invalid_request", `Raft found the request to ${where} malformed (400)`, status);
  }
  if (status === 429) {
    const retryAfterSeconds = retryAfterSecondsOf(response.headers.get("retry-after"));
    return new RaftAppError(
      "rate_limited",
      `Raft is rate-limiting requests to ${where} (429). Retry in ${retryAfterSeconds} second${retryAfterSeconds === 1 ? "" : "s"}`,
      status,
      { retryAfterSeconds },
    );
  }
  if (status === 403) {
    let code: unknown;
    try {
      const body: unknown = await response.json();
      code = isRecord(body) ? body.error : undefined;
    } catch {
      code = undefined;
    }
    if (code === "server_access_denied") {
      return new RaftAppError(
        "server_access_denied",
        `This access token cannot be used for ${where} on that Server (403 server_access_denied)`,
        status,
      );
    }
  }
  return new RaftAppError("http_error", `Raft answered HTTP ${status} for ${where}`, status);
}

function invalidResponse(where: string): RaftAppError {
  return new RaftAppError("invalid_response", `Raft's answer to ${where} is not the documented shape`, null);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

// Roles and principal types are open vocabularies: any non-empty string passes
// through, so a value Raft adds later does not fail the whole call.
function isOpenValue(value: unknown): value is string {
  return typeof value === "string" && value.length > 0;
}

function str(value: unknown): string | null {
  return typeof value === "string" ? value : null;
}

// The producing adapter for ServerId: a value is branded only after it has
// the shape of a Server id.
function serverIdFrom(value: unknown, where: string): ServerId {
  if (typeof value !== "string" || !SERVER_ID_RE.test(value)) throw invalidResponse(where);
  return asServerId(value);
}

function parseServer(value: unknown, where: string): RaftAppServer {
  if (!isRecord(value) || typeof value.slug !== "string" || typeof value.name !== "string" || !isOpenValue(value.role)) {
    throw invalidResponse(where);
  }
  return { id: serverIdFrom(value.id, where), slug: value.slug, name: value.name, role: value.role };
}

function parseServerInfo(value: unknown, expected: ServerId): RaftAppServerInfo {
  const where = "/api/oauth/serverinfo";
  if (!isRecord(value) || typeof value.slug !== "string" || typeof value.name !== "string") throw invalidResponse(where);
  const id = serverIdFrom(value.id, where);
  if (id !== expected) throw invalidResponse(where);
  return {
    id,
    slug: value.slug,
    name: value.name,
    avatar_url: str(value.avatar_url),
    picture: str(value.picture),
    ...(typeof value.is_paid === "boolean" ? { is_paid: value.is_paid } : {}),
    ...(value.plan_tier === "free" || value.plan_tier === "paid" ? { plan_tier: value.plan_tier } : {}),
  };
}

// Projects identity only: server_id, server_slug and server_role are dropped.
function parseUserInfo(value: unknown): RaftAppUserInfo {
  if (
    !isRecord(value)
    || typeof value.sub !== "string"
    || value.sub.length === 0
    || !isOpenValue(value.type)
    || typeof value.preferred_username !== "string"
    || typeof value.name !== "string"
    || typeof value.scope !== "string"
    || typeof value.client_id !== "string"
    || typeof value.client_name !== "string"
  ) {
    throw invalidResponse("/api/oauth/userinfo");
  }
  return {
    sub: value.sub,
    type: value.type,
    preferred_username: value.preferred_username,
    name: value.name,
    avatar_url: str(value.avatar_url),
    picture: str(value.picture),
    description: str(value.description),
    ...(typeof value.email === "string" ? { email: value.email } : {}),
    ...(typeof value.email_verified === "boolean" ? { email_verified: value.email_verified } : {}),
    scope: value.scope,
    client_id: value.client_id,
    client_name: value.client_name,
  };
}

function parseAgent(value: unknown): RaftAppAgent {
  if (!isRecord(value) || typeof value.id !== "string" || typeof value.handle !== "string") {
    throw invalidResponse("/api/oauth/agents");
  }
  return {
    id: value.id,
    handle: value.handle,
    display_name: str(value.display_name),
    avatar_url: str(value.avatar_url),
    picture: str(value.picture),
  };
}
