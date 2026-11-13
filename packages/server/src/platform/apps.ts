// Platform entry point: the first-party app contract (first-party app
// mechanism §一). An app describes itself in one `FirstPartyApp` (its
// apps/<id>/register.ts); core collects the registrations in apps/firstPartyApps.ts,
// the one place that lists apps, and derives from them what it used to name
// each app for: the object and event kinds object_events accepts, the system
// apps whose agent events need a delivery guard (and the guard), the
// AgentMessage `app_event` and the schema it is checked by, where the app's
// routes are mounted, the jobs core runs for it, the reactions to messages it
// is told of, and the summaries of its
// objects (where each lives, so core decides who sees it, then what the app
// shows of the ones left: services/objectSummaries.ts).
//
// Types only: the registration is data plus functions core calls. What core
// hands those functions (the mount contexts below) is how an app's routes
// reach core's transport (contract checks, auth, rate limits, error answers)
// without importing it.
import type { Readable } from "node:stream";
import type { SQL } from "drizzle-orm";
import type { Request, RequestHandler, Router } from "express";
import type {
  AgentApiAssistantOwnerArtifactPublishBody,
  ArtifactReadAsUser,
  AgentApiRequestBodyByRoute,
  AgentApiRequestParamsByRoute,
  AgentApiRequestQueryByRoute,
  AgentApiResponseByRoute,
  AgentApiRouteKey,
  ObjectActivityTarget,
  ObjectActivityUnread,
  ObjectDeletedOf,
  ObjectSummary,
  PaywallHitVia,
  SearchCursor,
  ServerId,
  ServerPlan,
  SummarizedObjectKind,
  WebSearchApp,
  WebSearchItemsByApp,
} from "@botiverse/raft-shared";
import type { DatabaseExecutor } from "../db/index";
import type { ObjectEventData } from "../db/schema";
import type { AppObjectStorage } from "./storage";
import type { HomeColumns } from "./visibility";

/** A person or an agent, as events, recipients and notices name them. */
export type AppActor = { type: "user" | "agent"; id: string };

// --- Answers of an app's routes (core writes them) ---

/** A JSON answer; `status` defaults to 200. */
export type AppJson<T> = { kind: "json"; body: T; status?: number };
/** Bytes, sent as an attachment with nosniff and a sandboxing CSP, never stored by a cache. */
export type AppBytes = { kind: "bytes"; stream: Readable; size: number; contentType: string; contentDisposition: string };
/** Nothing: 204. */
export type AppEmpty = { kind: "empty" };
/**
 * A signed-out route's Markdown document (PublicWebApiMount):
 * `text/plain; charset=utf-8` (AI chats' fetch tools read it; ChatGPT's
 * refuses text/markdown) with nosniff and a sandboxing CSP, never
 * HTML; like every signed-out answer `private, no-store`.
 */
export type AppPublicMarkdown = { kind: "markdown"; body: string };
/**
 * A refusal that is a plan paywall, which core records as `paywall_hit`
 * (routes/paywallHit.ts) when it writes the answer; never part of the body.
 * Today only the server's monthly file upload quota's
 * (platform/fileUploadQuota fileUploadQuotaPaywallHit), named by the write
 * it refused (`via`), with the refusal's usage numbers.
 */
export type AppPaywallHit = {
  gate: "upload_monthly_quota";
  via: PaywallHitVia;
  /** The server whose quota refused (the one billed for the bytes). */
  serverId: ServerId;
  /** That server's plan as the quota read it. */
  plan: ServerPlan;
  requestedBytes: number;
  monthUsedBytes: number;
};

/**
 * A refusal with its code; `status` is the HTTP status; `retryAfterSeconds`
 * sends `Retry-After`; `paywallHit`, when set, is recorded by core (AppPaywallHit);
 * `rateLimiter` names the app's limit that refused it on the request's span
 * (`rate_limiter`, as core's limiters do).
 */
export type AppError = { kind: "error"; status: number; body: { error: string; code: string; details?: Record<string, unknown> }; retryAfterSeconds?: number; paywallHit?: AppPaywallHit; rateLimiter?: string };

// --- What core hands an app ---

/**
 * The app's notices to agents (§六), as `system.<id>` notifications in core's
 * agent event queue. The payload is `{ app_event: { ...event, app, kind } }`:
 * core sets `app` (the app's id) and checks `kind` is one of the app's object
 * kinds (or of its agentNotice.kinds), and refuses an event that sets either itself; agents get `app_event` on the message only when it passes the app's
 * agentNotice.schema.
 */
export interface AppNoticeOutbox {
  /** Queue a notification for an agent, inside `executor`'s transaction. */
  queue(executor: DatabaseExecutor, input: {
    serverId: ServerId;
    agentId: string;
    summary: string;
    /** The kind the notice is about: one of the app's object kinds, or of its agentNotice.kinds. */
    kind: string;
    /** The notice's own fields (the app's agentNotice schema); never `app` or `kind`, which core sets. */
    event: Record<string, unknown>;
    ttlMs: number;
    now: Date;
    /**
     * RFC 081 §4: what the notice is about (the app's object id), the key its
     * inbox item groups by: `app:system.<id>/<objectRef>`. 1-128 chars of
     * AGENT_INBOX_OBJECT_REF_PATTERN; absent: the app's fallback item.
     */
    objectRef?: string;
    /** RFC 081 D8: the conversation the notice is about, checked against the agent's access whenever it is listed. */
    relatedChannelId?: string | null;
    /**
     * The app's own name for what this notice reports, within its agent and
     * `objectRef` (1-200 characters; a reaction notice: who reacted with
     * which emoji). `withdrawUnread` takes notices back by it, and
     * `onceWithinMs` reads it. Not unique: two notices may share one.
     */
    key?: string;
    /**
     * With `key`: when a notice with the same agent, `objectRef` and `key` was
     * queued less than this long ago, no new one is queued and that one is
     * answered (`created: false`). If it had been taken back (withdrawUnread)
     * and has not expired, it is unread again; its wake is not repeated when
     * it had already been pushed.
     */
    onceWithinMs?: number;
  }): Promise<{ eventId: string; created: boolean }>;
  /**
   * Push a queued notification to its agent; a failed push leaves it queued
   * for the agent's next pull. Nothing is pushed for one that joined an inbox
   * item already unread, or whose wake was already spent (RFC 081 D7).
   */
  push(eventId: string): Promise<void>;
  /** Take back a notification that may no longer go out (only while it is still queued). */
  withdraw(eventId: string): Promise<void>;
  /**
   * Take back the agent's unread notices about `objectRef`, all of them or
   * those queued with `key`, inside `executor`'s transaction: pushed or not,
   * they leave the agent's inbox (the item goes with its last unread notice)
   * and are never handed over later. A notice the agent already read stays
   * read. A push already on its way to the agent's Computer can't be called
   * back: reading its item then finds nothing. Idempotent. `pushEventId`:
   * the notice the caller pushes once the transaction commits, when what was
   * taken back held the item's wake and had not been pushed, and others of
   * the item are still unread (null otherwise).
   */
  withdrawUnread(executor: DatabaseExecutor, input: {
    agentId: string;
    objectRef: string;
    key?: string;
    now: Date;
  }): Promise<{ withdrawn: number; pushEventId: string | null }>;
}

/** The calling agent of an agent API route, from its credential. */
export interface AppAgentCaller {
  agentId: string;
  serverId: ServerId;
}

/**
 * The client an agent API request says it came from, by its own headers
 * (not checked identity): `kind` is `X-Raft-Client` (older CLIs and daemons
 * send `X-Slock-Client`; the CLI and a Computer's agent proxy send `cli`),
 * `version` is `X-Raft-Client-Version` (the `raft` CLI's version, since
 * 1.0.55). Null when the request sent none; the SDK sends neither.
 */
export interface AppAgentClient {
  kind: string | null;
  version: string | null;
}

/**
 * A client gate's refusal (AgentApiMount.clientGate): the HTTP status and a
 * JSON body with the agent's sentence and code, and the app's own fields.
 */
export type AppClientRefusal = { kind: "error"; status: number; body: { error: string; code: string } & Record<string, unknown> };

/** A raw-body route's body (AgentApiMount.upload, WebApiMount.upload): its headers as sent, and the bytes as a stream, not read yet. */
export interface AppUploadInput {
  contentType: string | undefined;
  contentLength: string | undefined;
  body: Readable;
}

/** One agent API request, its parts checked against the route's contract. */
export interface AgentApiCall<K extends AgentApiRouteKey> {
  agent: AppAgentCaller;
  params: AgentApiRequestParamsByRoute[K];
  query: AgentApiRequestQueryByRoute[K];
  body: AgentApiRequestBodyByRoute[K];
  /** This request's notice outbox (pushes through the router's agent orchestrator). */
  noticeOutbox: AppNoticeOutbox;
}

/**
 * What an app's agent API mount registers its routes with. Each route is a
 * contract route (packages/shared agentApiContract) under
 * `/internal/agent-api`, behind sk_agent auth and the route's capability;
 * core validates the request, runs the operation and writes its answer
 * (`private, no-store`). `failure` is the 500 answer's text. Only the app's
 * own routes: a contract route whose path is `/<id>` or under `/<id>/`;
 * any other is refused at startup. Every route whose contract method isn't
 * GET spends core's agent write budgets, per agent and per server across
 * replicas, before the body is read (429 RATE_LIMITED): its class is core's
 * (routes/internalAgentApi.ts AGENT_API_WRITE_BUDGET_ROUTES, services/
 * agentApiWriteLimits.ts), not the app's, and a write route without one is
 * refused at startup.
 */
export interface AgentApiMount {
  /**
   * The app's check of the requesting client (one per app; a later call
   * replaces it), run on every route this mount registers right after agent
   * auth, ahead of core's write budget, the app's flag, the contract checks and
   * the body (a large body's parser included): a refusal is the answer, the
   * body never read (the connection is then closed); null lets the request on.
   */
  clientGate(check: (client: AppAgentClient) => AppClientRefusal | null): void;
  /** A route answering JSON, checked against the contract's response. */
  json<K extends AgentApiRouteKey>(routeKey: K, failure: string, run: (call: AgentApiCall<K>) => Promise<AppJson<AgentApiResponseByRoute[K]> | AppError>): void;
  /** A route answering bytes (`Content-Security-Policy: sandbox`). */
  bytes<K extends AgentApiRouteKey>(routeKey: K, failure: string, run: (call: AgentApiCall<K>) => Promise<AppBytes | AppError>): void;
  /**
   * A route whose body is raw bytes, read by the operation as a stream (the
   * global JSON parser leaves application/octet-stream alone); a refusal that
   * leaves the body unread closes the connection.
   */
  upload<K extends AgentApiRouteKey>(
    routeKey: K,
    failure: string,
    run: (call: AgentApiCall<K>, input: AppUploadInput) => Promise<AppEmpty | AppError>,
  ): void;
  /**
   * A route whose raw body is one image the app keeps as a core object file
   * (platform/objectFiles putObjectFile: a comment's pasted image): read as
   * `upload`'s, answered as JSON checked against the contract's response.
   */
  objectFileUpload<K extends AgentApiRouteKey>(
    routeKey: K,
    failure: string,
    run: (call: AgentApiCall<K>, input: AppUploadInput) => Promise<AppJson<AgentApiResponseByRoute[K]> | AppError>,
  ): void;
  /**
   * A route whose JSON body may be larger than the global limit: parsed up to
   * `maxBytes` after agent auth and the app's flag, ahead of the global
   * parser. `notEnabled` answers a server with the app's flag off, before a
   * byte of the body is read (the connection is then closed). `onBodyError`
   * answers a body that is too large or not JSON (null: the global error
   * handling answers).
   */
  largeBody(
    routeKey: AgentApiRouteKey,
    maxBytes: number,
    answers: { notEnabled: AppError; onBodyError: (problem: "too_large" | "malformed") => AppError | null },
  ): void;
}

/** The signed-in reader of a web route: user, active server, and sign-in (session family). */
export interface AppWebReader {
  userId: string;
  serverId: ServerId;
  /** Null for a legacy access token without a session family. */
  sessionFamilyId: string | null;
}

/**
 * Messages an app posts for the signed-in reader of a web request: ordinary
 * messages, as that person, through core's message pipeline (stored,
 * broadcast, delivered to agents), after the same checks as the person
 * sending it themselves (core's `POST /api/messages`). Nothing on the message
 * names the app.
 */
export interface AppMessagePoster {
  /**
   * Post `content` into `conversationId` (a top-level conversation of the
   * reader's server: channel, private channel, DM or joint), or into the
   * thread under its message `threadRootId`, created if it has none yet (only
   * once every check passed). `refused`: no such conversation or root message,
   * one the reader can't see, or can't post in (not a member, read-only,
   * archived, a departed DM peer); nothing is written.
   *
   * `idempotencyKey` (up to 100 characters, the app's own: core keeps keys
   * apart per app) makes it core's idempotent send (`randomId`): the same
   * reader posting with the same key again gets the message the first post
   * made (`posted`, its id; nothing written again), as long as it is for the
   * same conversation or thread; for another one, `keyReused` and nothing is
   * written.
   *
   * `beforeWrite`: the app's own step for this post, run once every check
   * above passed and before anything is written (a thread neither): false
   * stops the post, `stopped`, nothing written. Never run when the
   * `idempotencyKey` already made a message: a retry (`posted` with
   * `replayed`, the first post's message) or the key used for another
   * conversation or thread (`keyReused`).
   */
  postAsReader(input: {
    conversationId: string;
    threadRootId: string | null;
    content: string;
    idempotencyKey?: string;
    beforeWrite?: () => Promise<boolean>;
  }): Promise<{ kind: "posted"; messageId: string; replayed?: true } | { kind: "refused" } | { kind: "keyReused" } | { kind: "stopped" }>;
}

/** One web API request. */
export interface WebApiCall {
  reader: AppWebReader;
  params: Record<string, string>;
  query: Record<string, unknown>;
  body: unknown;
  /** This request's notice outbox (pushes through the app's agent orchestrator). */
  noticeOutbox: AppNoticeOutbox;
  /** Messages posted as `reader` (through the app's socket server and agent orchestrator). */
  messages: AppMessagePoster;
}

/** The signed-in person of an account route (WebApiMount.accountRoute): who, and their sign-in; no server. */
export interface AppAccountReader {
  userId: string;
  /** Null for a legacy access token without a session family. */
  sessionFamilyId: string | null;
}

/** One account route request: the person, the path's params and the query (no body, no server). */
export interface AccountWebApiCall {
  reader: AppAccountReader;
  params: Record<string, string>;
  query: Record<string, unknown>;
}

/** A per-user rate limit (a request handler core builds), for web routes. */
export type AppRateLimit = { readonly name: string };

/**
 * A web limit as an app declares it: `perMinute` a minute per user (429
 * RATE_LIMITED with `message`). Per replica, unless `acrossReplicas`: then
 * one count across all of them (Redis). For writes a person makes; reads
 * that only guard a replica stay per replica (no Redis round trip).
 */
export type AppWebRateLimitSpec = { perMinute: number; message: string; acrossReplicas?: true };

/**
 * What an app's web API mount registers its routes with. Core mounts them at
 * `/api/<id>` behind the signed-in person's auth, verification and server
 * scoping (the reader stands in `reader.serverId`), and writes every answer
 * `private, no-store`. Run once per Raft app instance.
 */
export interface WebApiMount {
  /** A per-user limit (AppWebRateLimitSpec); `name` is the app's. */
  rateLimit(name: string, limit: AppWebRateLimitSpec): AppRateLimit;
  /**
   * A route at `path` under `/api/<id>`; `name` names it in logs.
   * `messageLimit`: a route that posts messages (WebApiCall.messages) is
   * also behind core's message limit, the one `POST /api/messages` counts
   * against (per user, shared with sending messages; its own 429 answer).
   */
  route(
    method: "get" | "post" | "put" | "patch" | "delete",
    path: string,
    name: string,
    run: (call: WebApiCall) => Promise<AppJson<unknown> | AppBytes | AppEmpty | AppError>,
    options?: { rateLimit?: AppRateLimit; messageLimit?: true },
  ): void;
  /**
   * A POST route at `path` whose body is raw bytes (not JSON: the global
   * parser leaves them alone), read by the operation as a stream. `rateLimit`
   * is required. A refusal that leaves the body unread closes the connection.
   */
  upload(
    path: string,
    name: string,
    run: (call: WebApiCall, input: AppUploadInput) => Promise<AppJson<unknown> | AppError>,
    options: { rateLimit: AppRateLimit },
  ): void;
  /**
   * The answer for a request whose path segment isn't valid percent-encoding
   * (no route could decode it); `path` is the raw path under `/api/<id>`.
   */
  undecodable(run: (call: WebApiCall, path: string) => Promise<AppError>): void;
  /**
   * A GET route at `path` under `/api/<id>` about the signed-in person
   * across their servers: behind their auth and verification only, no
   * server scoping (no X-Server-Id; `reader` names no server, and the
   * operation decides which of the person's servers, if any, it answers
   * from). Matched ahead of the server-scoped routes. Every answer,
   * refusals, 401 and 429 included, is `private, no-store` and varies by
   * the credential (`Vary: Authorization, Cookie`). `rateLimit` is required:
   * one of this mount's per-user limits (shared with the server-scoped
   * routes that use it). A path segment that doesn't decode is answered
   * with `undecodable` after auth.
   */
  accountRoute(
    path: string,
    name: string,
    run: (call: AccountWebApiCall) => Promise<AppJson<unknown> | AppError>,
    options: { rateLimit: AppRateLimit; undecodable: () => AppError },
  ): void;
}

/** One signed-out web API request: no reader, and nothing of the request's credentials. */
export interface PublicWebApiCall {
  /** The path's params, decoded; a wildcard's (`*name`) its segments joined by "/". */
  params: Record<string, string>;
}

/**
 * What an app's signed-out web API mount registers its routes with. Core
 * mounts them at `/api/public/<id>`, ahead of its own `/api/public` router,
 * with no auth: an operation gets only the path's params (PublicWebApiCall),
 * never a header, a cookie, the query or the body, so it can neither read a
 * credential nor tell a signed-in caller from anyone else. Every answer,
 * refusals and 429s included, is `private, no-store` and `X-Robots-Tag:
 * noindex, nofollow`, and none sets a cookie. AppPublicMarkdown answers are
 * text/markdown with nosniff and a sandboxing CSP; AppBytes answers are attachments with nosniff and a sandboxing CSP, as on
 * the signed-in mounts.
 * Every route is limited per client address. Run once per Raft app instance.
 */
export interface PublicWebApiMount {
  /** A per-client-address limit, `perMinute` a minute per replica (429 RATE_LIMITED with `message`); `name` is the app's. */
  rateLimit(name: string, limit: { perMinute: number; message: string }): AppRateLimit;
  /** A route at `path` under `/api/public/<id>`; `name` names it in logs. `rateLimit` is required. */
  route(
    method: "get" | "post",
    path: string,
    name: string,
    run: (call: PublicWebApiCall) => Promise<AppJson<unknown> | AppPublicMarkdown | AppBytes | AppError>,
    options: { rateLimit: AppRateLimit },
  ): void;
  /** The answer for a request whose path segment isn't valid percent-encoding (no route could decode it). */
  undecodable(answer: () => AppError): void;
}

/**
 * What an app's signed-out page mount registers its router with: core mounts
 * it at `/<id>` on the API host, for the pages the app's web edge sends there
 * (app.raft.build/<id>/* through CloudFront: the public Artifact page). Core
 * answers a plain 404 to every request that doesn't carry the app edge marker
 * (`X-Raft-App-Edge` equal to RAFT_APP_EDGE_HEADER_VALUE), and to all of them
 * while that isn't configured, so the router only ever answers what came
 * through the app's own edge: never a page on the API's origin. No auth; the
 * router answers HTML of its own, so it sets every header it needs (core's
 * helmet CSP is the API's, not a page's). Run once per Raft app instance.
 */
export interface PublicPageMount {
  /** The app's router at `/<id>` (behind the edge marker check). */
  use(router: Router): void;
  /** A per-client-address limit, `perMinute` a minute per replica (429 RATE_LIMITED with `message`); `name` is the app's. */
  rateLimit(name: string, limit: { perMinute: number; message: string }): RequestHandler;
}

/**
 * What an app's internal mount gets: a router of its own under
 * `/internal/<path>`, ahead of core's machine-auth `/internal` router, for
 * callers that are neither people nor agents (the app authenticates them).
 * `path` must start with the app's id.
 */
export interface InternalMount {
  use(path: string, router: Router): void;
  /** The client address as core's rate limits key it. */
  clientIp(req: Request): string;
  /** An error, as core logs errors (secrets redacted). */
  serializeError(error: unknown): unknown;
}

/**
 * A reaction a person or an agent asked to add to or take off a message
 * (FirstPartyApp.messageReactions.prepare), as core read it before the
 * reaction's transaction opened. Whether it changes anything (adding one that
 * is there, removing one that isn't) is decided in that transaction.
 */
export interface AppMessageReactionRequest {
  operation: "add" | "remove";
  message: {
    id: string;
    /**
     * The conversation it is in (a thread's own id for a reply in a thread).
     * For a Joint Channel's message this is the joint's storage channel or
     * the reactor's server's copy, never necessarily the copy of the server
     * the app cares about: resolve it (platform/conversations
     * localConversationIds, platform/messages messageSource).
     */
    channelId: string;
    /** Who sent it: a person (an assistant sending as its owner included: the owner) or an agent; null for a system message or one mirrored from outside Raft. */
    author: AppActor | null;
    /** Its text as stored. */
    content: string;
  };
  /** Who reacts: a person or an agent of Raft (mirrored reactions from other services reach no app). */
  reactor: AppActor;
  emoji: string;
}

/** What core hands an app when it asks what the app would write for a reaction. */
export interface AppMessageReactionContext {
  /** The app's notice outbox (pushes through the request's agent orchestrator), for the write and the push it returns. */
  noticeOutbox: AppNoticeOutbox;
}

/** What core hands an app's write inside the reaction's transaction. */
export interface AppMessageReactionWriteContext {
  /**
   * A savepoint of the transaction that changed the reaction: the only way
   * to the database inside the write. What it writes commits with the
   * reaction, or is rolled back alone when the write throws.
   */
  executor: DatabaseExecutor;
  /** When core made the change. */
  at: Date;
}

/**
 * An app's write for a reaction that did change, prepared before the
 * transaction (FirstPartyApp.messageReactions.prepare) and run by core
 * inside it. It returns what core runs once the transaction has committed
 * (a push), if anything.
 *
 * It reads and writes only through `executor`. Core enforces it: while the
 * write runs, any use of getDb() (which inside a transaction is that
 * transaction), of a second connection or of the search database throws
 * (db/ambientTransaction.ts runExecutorOnly), so a platform entry that reads
 * on its own fails here. Resolve what the write needs in `prepare`, and keep
 * the write to the statements that must commit with the reaction: it runs
 * under the conversation's writer fence.
 */
export type AppMessageReactionWrite = (context: AppMessageReactionWriteContext) => Promise<(() => Promise<void>) | void>;

/** A schema an app's agent event body is checked by (a zod object schema). */
export interface AppEventSchema {
  safeParse(value: unknown): { success: true; data: Record<string, unknown> } | { success: false };
}

/** The events of an app's object kind core hands its delivery guard. */
export interface AppNoticeEvent {
  id: string;
  agentId: string;
  serverId: string;
  payload: Record<string, unknown>;
}

/** Context of an app's interval jobs. */
export interface AppJobContext {
  /** Notices go out through the server's agent orchestrator. */
  noticeOutbox: AppNoticeOutbox;
}

// --- Search (§五) ---

/** Who searches: a signed-in person, in the server they are in; only that server is searched. */
export interface AppSearchViewer {
  userId: string;
  serverId: ServerId;
}

/** One app's part of a search (core's `GET /api/search`). */
export interface AppSearchInput {
  viewer: AppSearchViewer;
  /** The query, trimmed, 1 to WEB_SEARCH_QUERY_MAX_CHARS code points (core checked it). */
  q: string;
  /** A cursor of this app's from its page before (the app checks it), or null for the first page. */
  cursor: SearchCursor | null;
  /** How many results, 1 to WEB_SEARCH_MAX_LIMIT. */
  limit: number;
  /**
   * The viewer's visible homes as a condition on the app's object table's
   * standard home columns (platform/visibility visibleHomes, read once by
   * core for every app). It names viewer.serverId: of another server, only
   * objects homed in a joint the viewer sees pass, and only while their own
   * server has this app's flag on. It never lets an orphan through. The app puts it in
   * the same statement as its order and LIMIT, with its own conditions
   * (deleted objects).
   */
  visibleHomesSql(columns: HomeColumns): SQL;
  /**
   * The read-only transaction core runs this search in, under its statement
   * timeout, a limit on each statement (getDb() inside the search reaches it
   * too, as the ambient transaction; a search writes nothing). A statement cut
   * off by the timeout fails the search, and core answers the app's group
   * `{ error: "timeout" }`.
   */
  executor: DatabaseExecutor;
}

/** A result of some app's search: the app's own type, declared in shared (WebSearchItemsByApp). */
export type AppSearchItem = WebSearchItemsByApp[WebSearchApp];

/** An app's page of results, or its refusal of the cursor (400 INVALID_CURSOR). */
export type AppSearchPage<Item extends AppSearchItem = AppSearchItem> =
  | { kind: "page"; items: Item[]; nextCursor: SearchCursor | null }
  | { kind: "invalid_cursor" };

/** One batch of FirstPartyApp.purgeServer. */
export interface AppPurgeServerOptions {
  executor: DatabaseExecutor;
  /** At most this many of the app's objects deleted in this batch (`delete`). */
  limit: number;
  mode: "count" | "delete";
  /**
   * The server's channels the purge keeps (joint channels and projections,
   * migration receipt channels, and what is under them): other servers still
   * see what is in them, so the app keeps every object homed in one, in both
   * modes, and `remaining` doesn't count them. Absent: none kept.
   */
  keepChannelIds?: readonly string[];
}

/** What purgeServer did: whether anything is left, and counts by what the app names (rows, bytes). */
export interface AppPurgeServerResult {
  remaining: boolean;
  counts: Readonly<Record<string, number>>;
}

/**
 * One kind of object an app owns: an object, not one of its parts
 * (docs/development/first-party-apps.md, "Objects, parts and files").
 */
export interface AppObjectKind {
  /** object_events.object_kind; unique across apps. */
  kind: string;
  /** The event kinds recordObjectEvent accepts for it. */
  events: readonly string[];
  /**
   * The app's tables whose writes change what others see of these objects
   * (§十 check 3: each write goes with a recordObjectEvent in its
   * transaction). Not checked yet (layer 4).
   */
  objectTables: readonly string[];
  /**
   * Where each of these objects lives, for core's visibility (§四): its
   * server, its standard home columns and its author, for each live object
   * (one that doesn't exist, or that the app's own rules hide from everyone,
   * such as a deleted one, is left out). Ids are as the caller sent them
   * (any string). Constant queries however many ids.
   */
  homes(ids: readonly string[]): Promise<ReadonlyMap<string, AppObjectHome>>;
  /**
   * A request's reference to one of these objects as the kind declares it
   * (shared ObjectSummaryKinds `ref`): `value` is a JSON object whose `id`
   * core has checked is a string; the result is the reference with `id`
   * unchanged and anything else the kind reads (an Artifact's `version`), or
   * null when the kind doesn't accept it (the request is refused, 400).
   */
  parseRef(value: { id: string } & Record<string, unknown>): AppObjectRef | null;
  /**
   * The summaries of references to objects core found the viewer can see
   * (§四): each `refs[i].id` is one `homes` reported and core's filter kept;
   * the references are as parseRef returned them, in request order (the same
   * one may repeat). The answer has exactly one entry per reference, in order
   * (core refuses any other length, as a bug: 500), undefined for one that has nothing to show (the caller answers it as
   * unavailable, as one it can't see: a version that isn't readable, say).
   * The summary is the kind's declared one (shared ObjectSummaryKinds); it
   * only reads (no read position moves). Constant queries however many refs.
   */
  summarize(viewer: AppWebReader, refs: readonly AppObjectRef[]): Promise<ReadonlyArray<ObjectSummary | undefined>>;
  /**
   * Deleted objects (§四; the kind's shared ObjectSummaryKinds `deleted`,
   * answered `{ ok: false, reason: "deleted", deleted }`),
   * for a kind that shows something of one to a reader who could see it were
   * it not deleted. Without it, a deleted object is `unavailable` as any.
   * - `homes`: where each deleted object of these ids lived, as `homes`
   *   reports a live one (the home it had when deleted). Only objects their
   *   owner deleted: never one the app's rules hide from everyone otherwise
   *   (taken down, an Artifact's revoked), nor a live one. Core asks it only
   *   for the ids `homes` left out, and decides who sees which by its own
   *   rule, exactly as for a live object (both servers' flags, then the home).
   * - `summarize`: the deleted summary of each of these ids, which core found
   *   the viewer could see (each one `deleted.homes` reported); an id left out
   *   is answered as a plain `unavailable`. Only reads.
   * Constant queries however many ids, each.
   */
  deleted?: {
    homes(ids: readonly string[]): Promise<ReadonlyMap<string, AppObjectHome>>;
    summarize(viewer: AppWebReader, ids: readonly string[]): Promise<ReadonlyMap<string, AppObjectDeleted>>;
  };
  /**
   * Activity (§四 layer 2; core's services/objectActivity.ts): the reader's
   * unread counts of the objects of one Activity page, by the app's own read
   * positions, for the row's number. Whether a row is unread at all, the
   * badge and the unread filters are core's own (object_inbox_states, from
   * the read progress the app reports with platform/activity
   * markObjectRead), so this is never asked on the badge's path. Core asks
   * only for rows it found the reader can see; an id the answer leaves out
   * counts as nothing to number. One batch, constant queries however many
   * ids. A kind without it has no Activity rows.
   */
  unreadFor?(reader: AppWebReader, ids: readonly string[]): Promise<ReadonlyMap<string, AppObjectUnread>>;
  /**
   * What an Activity row shows beyond the summary, for the rows of one page
   * only: a one-line preview of what the reader would read first, and where
   * opening the row lands (the kind's shared ObjectSummaryKinds
   * `activityTarget`). `latest` is the newest event that reached the reader.
   * Only reads. Constant queries however many rows.
   */
  activityDetails?(reader: AppWebReader, rows: readonly AppObjectActivityRow[]): Promise<ReadonlyMap<string, AppObjectActivityDetail>>;
  /**
   * Mark these objects read for the reader (Activity's Done, mark read and
   * mark all read): up to the event `through` (its data, as the app recorded
   * it), or everything now when null. A read position only moves forward, and
   * the app reports the move to core as any other (markObjectRead). Every
   * statement runs on `executor`: core's transaction, which also holds
   * core's own write (Done), so both commit or neither does. Core has
   * checked the reader can see each. Constant queries.
   */
  markRead?(reader: AppWebReader, targets: ReadonlyArray<{ id: string; through: ObjectEventData | null }>, executor: DatabaseExecutor): Promise<void>;
  /**
   * Object files (services/objectFiles.ts readObjectFile): whether the file of
   * object `objectId` hung on the app's part `parent` may be read now, beyond
   * core's own rules, for a part whose files go with a feature of the app's
   * own (Artifacts: a publish check's screenshots, on `version:<id>`, only
   * while the deployment has a check Worker). Core
   * asks it last, for a file it would serve (the object seen fully, a draft
   * by its uploader); false answers the file as one there isn't. Only reads.
   * Without it, core's rules alone decide.
   */
  fileReadable?(objectId: string, parent: string): Promise<boolean>;
  /**
   * Channel announcements (channel_announcement_v0; core's
   * services/channelAnnouncements.ts): this kind's objects may be a channel's
   * announcement, one object homed in that channel. At most one registered
   * kind declares it. `headlines`: each live object's title, current version
   * (its number, who made it and its note) and last change, for objects core
   * found the reader can see and homed in the channel, and with `reader`
   * whether that reader has seen the current version by the app's own read
   * state; an id left out (no current version, gone) reads as no
   * announcement. Only reads; constant queries however many ids.
   */
  channelAnnouncement?: {
    headlines(ids: readonly string[], reader?: AppActor): Promise<ReadonlyMap<string, AppObjectHeadline>>;
  };
}

/** What a channel's announcement shows of its object (AppObjectKind.channelAnnouncement). */
export interface AppObjectHeadline {
  title: string;
  /** The current version's number. */
  version: number;
  updatedAt: Date;
  /** Who made the current version. */
  updatedBy: AppActor;
  /** The current version's note, null without one. */
  note: string | null;
  /** Whether `reader` has seen the current version (made it, or read past it); null when no reader was given. */
  seen: boolean | null;
  /** The first line of the current version's text (the app's own excerpt, the one its card shows); null without one. */
  excerpt: string | null;
}

/** Any kind's deleted summary (shared ObjectSummaryKinds `deleted`; AppObjectKind.deleted). */
export type AppObjectDeleted = ObjectDeletedOf<SummarizedObjectKind>;

/** A reader's unread state of one object (AppObjectKind.unreadFor). */
export interface AppObjectUnread {
  /** How much is new to the reader since it last read the object, of what it hears about (the app's rule); 0 when nothing. */
  unread: number;
  /** Whether the reader follows the object now. */
  following: boolean;
  /**
   * `unread` by part, as the kind's shared `activityUnread` declares it
   * (Artifacts: versions and comments), summing to `unread`; Activity rows
   * carry it as `unreadParts` (zeros once read). Absent: not split.
   */
  parts?: ObjectActivityUnread;
}

/** An Activity row of a page, for AppObjectKind.activityDetails. */
export interface AppObjectActivityRow {
  id: string;
  /** The newest event that reached the reader: its kind and data, as the app recorded them. */
  latest: { eventKind: string; data: ObjectEventData };
}

/** What an Activity row shows beyond the summary (AppObjectKind.activityDetails). */
export interface AppObjectActivityDetail {
  /** One line of what the reader would read first, or null; `images`: how many it carries, when any (its text may then be empty). */
  preview: { text: string; truncated: boolean; author: AppActor; at: Date; images?: number } | null;
  /** Where opening the row lands (the kind's shared `activityTarget`), or null for the object itself. */
  target: ObjectActivityTarget | null;
}

/**
 * A reference to an object (AppObjectKind.parseRef): its id, which is all core
 * reads, and the kind's own fields, which core hands back to the kind as
 * parseRef made them.
 */
export interface AppObjectRef {
  readonly id: string;
}

/** Where an object lives, as its app reports it to core (AppObjectKind.homes). */
export interface AppObjectHome {
  serverId: ServerId;
  /** The object table's standard home columns (a conversation home without a channel is an orphan). */
  homeKind: "conversation" | "server" | "public";
  homeChannelId: string | null;
  /** Who made it (an orphan's author still sees it). */
  author: AppActor;
}

/** One Artifact read as a person, for a caller acting for them (FirstPartyApp.actingFor). */
export interface AppReadAsUserInput {
  /** The server the person reads from; the caller checks they are a member of it (core's requireServer is not on this path). */
  serverId: ServerId;
  userId: string;
  /** An id or a link; a link's `/v/<n>` is the version unless `version` is given. */
  ref: string;
  version?: number;
  path?: string;
  /** Also the newest page of comments the person can read. */
  comments?: boolean;
  /** With `comments`: the page before this cursor (a previous answer's `olderCursor`) instead of the newest. */
  commentsBefore?: string;
  /**
   * Whether the caller may read an Artifact living there, asked right after the person's own visibility check and
   * before any version, path or content work: false answers the one not-visible, so nothing past it tells the
   * Artifact exists (Warden, #14494). `channelId` is the conversation home's, null for a server or public home.
   */
  homeAllowed?: (home: { kind: "conversation" | "server" | "public"; channelId: string | null }) => Promise<boolean>;
}

/** The read's answer: the person's view, or the web's refusal (its `code`, `error` shown as sent). */
export type AppReadAsUserAnswer =
  | { kind: "json"; status: number; body: ArtifactReadAsUser }
  | { kind: "error"; status: number; body: { code: string; error: string } };

/** A publish by a personal assistant, as itself, for its owner (FirstPartyApp.actingFor.publishAs). */
export interface AppPublishAsInput {
  serverId: ServerId;
  /** Who the Artifact and its version are by: the assistant itself (step 2 of #proj-assistant:#31). */
  author: { type: "agent"; id: string };
  /** The assistant publishing: a new Artifact's mark, and the mark a new version's Artifact must carry. */
  publishedByAssistantAgentId: string;
  /**
   * The one conversation the assistant may publish into (checked by the caller): a new Artifact's home, and the
   * home an existing one must still have for a new version (else the one not-visible).
   */
  home: string;
  request: AgentApiAssistantOwnerArtifactPublishBody;
  outbox: AppNoticeOutbox;
}

/** The publish's answer: what it made, or the refusal (its `code`, `error` shown as sent, `details` when it has them). */
export type AppPublishAsAnswer =
  | { kind: "json"; status: number; body: { itemId: string; version: number; url: string; homeConversationId: string | null; unchanged: boolean } }
  | { kind: "error"; status: number; body: { code: string; error: string; details?: Record<string, unknown> }; retryAfterSeconds?: number; paywallHit?: AppPaywallHit };

export interface FirstPartyApp {
  /** The app's id: its schema `app_<id>`, its routes `/api/<id>`, its system app `system.<id>`. */
  id: string;
  /**
   * The server-scoped feature flag that switches the app on. Core reads it to
   * tell agents which apps are on (`enabledApps`, services/firstPartyAppFlags.ts),
   * for its object routes (summaries: the reader's server's flag and each
   * object's own) and for search (an app switched off for the reader's server
   * is not searched; another server's object in a joint is found only while
   * its own server has the app on); the app's own operations still check it
   * themselves. An app whose rollout is over keeps its key (clients still ask
   * it) and answers it by what the deployment can run, the same for every
   * server (platform/flags.ts answerAppFlagFromDeployment; Artifacts does).
   */
  flag: string;
  objectKinds: readonly AppObjectKind[];
  /** The app's system app in the agent event queue: `system.<id>`. */
  systemApp: `system.${string}`;
  /**
   * The app's notices to agents: the schema `app_event` is checked by, and
   * the delivery guard core runs before every hand-over or re-read of one of
   * its events (an id it leaves out counts as false). Having one makes the
   * app's system app require it (fail closed).
   */
  agentNotice?: {
    schema: AppEventSchema;
    deliverable(events: readonly AppNoticeEvent[]): Promise<ReadonlyMap<string, boolean>>;
    /**
     * Kinds its notices may be about besides its own object kinds: an object
     * of core's it owns nothing of (a message). A notice's `kind` is one of
     * `objectKinds` or one of these; naming a kind here registers no object.
     */
    kinds?: readonly string[];
  };
  /**
   * Reactions to messages (core's services/messageReactionService.ts
   * mutateMessageReaction), in three steps, none of which can fail the
   * reaction: a throw in any of them is logged and the reaction commits (a
   * notice may be lost; a reaction that won't stick may not).
   *
   * 1. `prepare`: before the reaction's transaction opens, for every
   *    reaction a person or an agent asks to add or remove. No transaction is
   *    open and nothing is locked: the app reads what it needs through the
   *    platform entries, and answers nothing when the reaction is nothing to
   *    it (its flag is off), or the write to make if the reaction changes.
   * 2. The write it answered (AppMessageReactionWrite): inside the
   *    transaction, only when the reaction changed, in a savepoint of its
   *    own, through the executor it is handed and nothing else. If it throws
   *    its savepoint is rolled back: nothing it wrote remains.
   * 3. What the write returns: once the transaction has committed, outside
   *    it (a push).
   */
  messageReactions?: {
    prepare(request: AppMessageReactionRequest, context: AppMessageReactionContext): Promise<AppMessageReactionWrite | void>;
  };
  /**
   * Reads for a caller acting for a person and not their browser: a personal
   * assistant for its owner (#proj-assistant:#31, services/assistantOwnerArtifacts.ts).
   * The web's own checks with that person as reader; reads only (no read
   * position, no follow). Artifacts only, for now.
   */
  actingFor?: {
    readAsUser(input: AppReadAsUserInput): Promise<AppReadAsUserAnswer>;
    /** A personal assistant publishing as itself; its own Artifacts only for a new version. */
    publishAs?(input: AppPublishAsInput): Promise<AppPublishAsAnswer>;
  };
  /** Where core mounts the app's routes. */
  routes?: {
    /** Registers the app's agent API routes; run once per process. */
    agentApi?(mount: AgentApiMount): void;
    /** Registers the app's web API routes; run per Raft app instance. */
    webApi?(mount: WebApiMount): void;
    /** Registers the app's signed-out web API routes (`/api/public/<id>`); run per Raft app instance. */
    publicWebApi?(mount: PublicWebApiMount): void;
    /** Mounts the app's internal routers; run per Raft app instance. */
    internal?(mount: InternalMount): void;
    /** Mounts the app's signed-out page router (`/<id>`, edge-marked requests only); run per Raft app instance. */
    publicPage?(mount: PublicPageMount): void;
  };
  /**
   * The app's search (§五), one group of core's `GET /api/search`: its own
   * index, the fields it chooses, its own cursor. Core calls it only while
   * the app's flag is on for viewer.serverId, with the visible-homes
   * condition, inside a transaction of its own under a statement timeout.
   */
  search?(input: AppSearchInput): Promise<AppSearchPage>;
  /**
   * Takes the app's object storage (platform/storage): its own keys, under
   * `apps/<id>/` of the platform's one app-content bucket, the prefix added
   * by core. Core builds it from `id` and calls this once per process, when
   * the registry is first read (before it mounts the app's routes or runs its
   * jobs). The bucket is read on first use: `configured` says whether there
   * is one.
   */
  receiveObjectStorage?(storage: AppObjectStorage): void;
  /**
   * Clearing a closed server's data (core's closed-server purge, 30 days
   * after `servers.deleted_at`): core calls it before it clears the server's
   * conversations, one call per batch, each in its own transaction
   * (`executor`), until `remaining` is false. `count` deletes nothing and
   * answers what would go (the purge's count report); `delete` deletes at
   * most `limit` of the app's objects of that server (their parts with them)
   * and leaves bytes to the app's own jobs and core's object-file sweep. A
   * server that isn't closed is refused, whatever the caller says.
   */
  purgeServer?(serverId: ServerId, options: AppPurgeServerOptions): Promise<AppPurgeServerResult>;
  /** Work core runs for the app on every replica. */
  jobs?: {
    /** Run by the hourly maintenance (bounded work per run); `site` names it in traces. */
    maintenance?: ReadonlyArray<{ site: string; run(): Promise<unknown> }>;
    /** Run every `everyMs`, one run at a time per replica; shutdown waits for the one in flight. */
    every?: ReadonlyArray<{ name: string; everyMs: number; run(context: AppJobContext): Promise<unknown> }>;
  };
  // Layer 2, not declared yet: refs { parse, hosts } (message links) and
  // prompt { section, manualTopic } (§七).
}
