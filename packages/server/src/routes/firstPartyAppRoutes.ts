// First-party apps' web and internal routes (apps/firstPartyApps.ts,
// FirstPartyApp.routes), as app.ts mounts them. The agent API's are
// internalAgentApi.ts's.
//
// - Web: each app's routes on a router app.ts mounts at `/api/<id>` behind
//   requireAuth, requireVerified and requireServer (the reader is req.userId
//   in req.serverId, signed in as req.sessionFamilyId; requireServer checks
//   the membership on every request; a call's `messages` posts as that
//   reader, services/firstPartyAppMessages.ts). Every answer carries the app's data or
//   nothing, so none is ever stored by a cache (`private, no-store`); bytes go
//   out as an attachment with nosniff and a sandboxing CSP, so a browser never
//   runs them on Raft's origin. Per-user rate limits are built by app.ts:
//   per replica, or across replicas where the app asks (`acrossReplicas`,
//   appWebLimitAcrossReplicas).
// - Account routes (WebApiMount.accountRoute): each app's GET routes about
//   the signed-in person across their servers, on a router app.ts mounts at
//   `/api/<id>` ahead of the server-scoped one, each route behind the auth
//   app.ts hands in (requireAuth, requireVerified) and no requireServer: the
//   reader is req.userId signed in as req.sessionFamilyId, with no server. A
//   request no account route matches passes through untouched (no auth run
//   twice). Every answer is `private, no-store` with `Vary: Authorization,
//   Cookie`, set before auth so a 401 or 429 carries them too.
// - Signed-out web: each app's routes on a router app.ts mounts at
//   `/api/public/<id>`, ahead of core's `/api/public` router, with no auth.
//   An operation gets the path's params only (never a header, cookie, query
//   or body), so no credential is read; every answer is `private, no-store`,
//   `X-Robots-Tag: noindex, nofollow` and sets no cookie; every route is
//   behind a per-client-address limit app.ts builds.
// - Internal: each app's own routers under `/internal/<path>`, mounted ahead of
//   core's machine-auth `/internal` router (the app authenticates its callers).
// - Signed-out pages: each app's router at `/<id>`, answering only requests
//   that carry the app edge marker (APP_EDGE_HEADER equal to
//   RAFT_APP_EDGE_HEADER_VALUE, which the app's CloudFront distribution adds
//   on its way here); everything else, and everything while it isn't
//   configured, is a plain 404, so the API's origin never serves an app page.
// - Large bodies: a route whose JSON body is over the global limit is parsed
//   by a route-scoped parser after auth and the app's flag, ahead of the
//   global one (which then skips it); its errors are the app's answer. With
//   the flag off for the caller's server, the body is never read.
import type { Server as SocketServer } from "socket.io";
import { Router, type ErrorRequestHandler, type NextFunction, type Request, type RequestHandler, type Response, type Router as RouterType } from "express";
import { firstPartyApps } from "../apps/firstPartyApps";
import { clientIpForRateLimit } from "../lib/clientIpForRateLimit";
import { appEnabled } from "../platform/flags";
import { refuse } from "../lib/refusal";
import { setRequestTraceErrorCode, setRequestTraceRateLimiter } from "../middleware/requestObservability";
import type { AccountWebApiCall, AppBytes, AppEmpty, AppError, AppJson, AppPublicMarkdown, AppRateLimit, AppWebRateLimitSpec, AppWebReader, FirstPartyApp, PublicPageMount, PublicWebApiCall, PublicWebApiMount, WebApiCall, WebApiMount } from "../platform/apps";
import type { AgentOrchestrator } from "../services/agentOrchestrator";
import { appNoticeOutbox } from "../services/firstPartyAppHost";
import { appMessagePoster } from "../services/firstPartyAppMessages";
import { createFixedWindowCounter } from "../services/fixedWindowRateLimit";
import { streamStorageResponse } from "../services/storageResponseStream";
import { serializeErrorForLog } from "../tracing/safeErrorLog";
import { noteAppPaywallHit } from "./paywallHit";

type WebResult = AppJson<unknown> | AppBytes | AppEmpty | AppError;

export type AppLargeBody = { path: string; maxBytes: number; onBodyError(problem: "too_large" | "malformed"): AppError | null };

/** The error handler of a route-scoped body parser: the app's answer for a body that is too large or not JSON. */
export function appBodyErrorHandler(onBodyError: AppLargeBody["onBodyError"]): ErrorRequestHandler {
  return (err, _req, res, next) => {
    const type = (err as { type?: unknown } | null)?.type;
    const problem = type === "entity.too.large" ? "too_large" : type === "entity.parse.failed" ? "malformed" : null;
    const answer = problem ? onBodyError(problem) : null;
    if (!answer) {
      next(err);
      return;
    }
    setRequestTraceErrorCode(res, answer.body.code);
    res.setHeader("Cache-Control", "private, no-store");
    res.status(answer.status).json(answer.body);
  };
}

/**
 * Ahead of a large body's parser, after auth: the app's flag for the caller's
 * server. Off, the app's answer goes out without a byte of the body read, and
 * the connection is closed rather than drained.
 */
export function appEnabledBeforeBody(flag: string, notEnabled: AppError): RequestHandler {
  return (req, res, next) => {
    const serverId = req.serverId;
    // Auth answered already when it set no server; let the route's own checks run.
    if (!serverId) {
      next();
      return;
    }
    appEnabled(serverId, flag).then((enabled) => {
      if (enabled) {
        next();
        return;
      }
      setRequestTraceErrorCode(res, notEnabled.body.code);
      res.setHeader("Cache-Control", "private, no-store");
      res.setHeader("Connection", "close");
      res.status(notEnabled.status).json(notEnabled.body);
    }, next);
  };
}

function sendError(res: Response, error: AppError): void {
  setRequestTraceErrorCode(res, error.body.code);
  if (error.rateLimiter) setRequestTraceRateLimiter(res, error.rateLimiter);
  if (error.retryAfterSeconds !== undefined) res.setHeader("Retry-After", String(Math.max(0, Math.ceil(error.retryAfterSeconds))));
  res.status(error.status).json(error.body);
}

// requireAuth and requireServer have set the user and the server.
const readerOf = (req: Pick<Request, "userId" | "serverId" | "sessionFamilyId">): AppWebReader =>
  ({ userId: req.userId!, serverId: req.serverId!, sessionFamilyId: req.sessionFamilyId ?? null });

function callOf(app: FirstPartyApp, req: Request): WebApiCall {
  const reader = readerOf(req);
  return {
    reader,
    params: req.params as Record<string, string>,
    query: req.query as Record<string, unknown>,
    body: req.body as unknown,
    noticeOutbox: appNoticeOutbox(app, req.app.get("agentOrchestrator") as AgentOrchestrator | undefined),
    messages: appMessagePoster(app.id, reader, req.app.get("io") as SocketServer | undefined, req.app.get("agentOrchestrator") as AgentOrchestrator | undefined),
  };
}

/** Bytes as an attachment that never renders or runs here: nosniff and a CSP with no source and a sandbox. */
async function sendBytes(res: Response, result: AppBytes, logName: string): Promise<void> {
  res.status(200);
  res.setHeader("Content-Type", result.contentType);
  res.setHeader("Content-Length", String(result.size));
  res.setHeader("Content-Disposition", result.contentDisposition);
  res.setHeader("X-Content-Type-Options", "nosniff");
  res.setHeader("Content-Security-Policy", "default-src 'none'; sandbox");
  result.stream.on("error", (err) => {
    console.error(`${logName} stream failed`, serializeErrorForLog(err));
    res.destroy(err);
  });
  // The abort-safe pipeline, not a bare .pipe(): a client that goes away
  // destroys the storage stream too. Its rejection is the source's failure
  // (logged above) or the client's abort: nothing left to answer either way.
  await streamStorageResponse(result.stream, res).catch(() => undefined);
}

/** A route that runs one operation and writes its answer. */
function handle(app: FirstPartyApp, name: string, run: (call: WebApiCall) => Promise<WebResult>): RequestHandler {
  return async (req, res) => {
    try {
      const result = await run(callOf(app, req));
      res.setHeader("Cache-Control", "private, no-store");
      switch (result.kind) {
        case "error":
          // A refusal that is a plan paywall is the reader's (requireAuth set the user).
          noteAppPaywallHit(req, result.paywallHit, req.userId!);
          sendError(res, result);
          return;
        case "json":
          res.status(result.status ?? 200).json(result.body);
          return;
        case "empty":
          res.status(204).end();
          return;
        case "bytes":
          await sendBytes(res, result, `api.${app.id}.${name}`);
          return;
      }
    } catch (err) {
      if (res.headersSent) return;
      console.error(`api.${app.id}.${name} failed`, serializeErrorForLog(err));
      res.status(500).json({ error: `Failed to answer for ${app.id}` });
    }
  };
}

export interface FirstPartyAppWebMounts {
  /** Each app's router, at `/api/<id>`. */
  routers: Array<{ path: string; router: RouterType }>;
  /** Each app's account routes (WebApiMount.accountRoute), at `/api/<id>` ahead of its router; only apps that declare one. */
  accountRouters: Array<{ path: string; router: RouterType }>;
}

/** Every answer of an account route: never stored by a cache, and the answer is the credential's. */
function accountAnswerHeaders(res: Response): void {
  res.setHeader("Cache-Control", "private, no-store");
  res.vary("Authorization");
  res.vary("Cookie");
}

/** An account route: one operation's JSON or error answer. */
function handleAccount(app: FirstPartyApp, name: string, run: (call: AccountWebApiCall) => Promise<AppJson<unknown> | AppError>): RequestHandler {
  return async (req, res) => {
    try {
      // requireAuth has set the user; no server.
      const result = await run({
        reader: { userId: req.userId!, sessionFamilyId: req.sessionFamilyId ?? null },
        params: req.params as Record<string, string>,
        query: req.query as Record<string, unknown>,
      });
      accountAnswerHeaders(res);
      if (result.kind === "error") {
        sendError(res, result);
        return;
      }
      res.status(result.status ?? 200).json(result.body);
    } catch (err) {
      if (res.headersSent) return;
      console.error(`api.${app.id}.${name} failed`, serializeErrorForLog(err));
      res.status(500).json({ error: `Failed to answer for ${app.id}` });
    }
  };
}

const APP_WEB_LIMIT_WINDOW_SECONDS = 60;

/**
 * A per-user web limit counted across replicas (fixedWindowRateLimit.ts:
 * Redis, this process's memory without it), `limit` requests a minute per
 * `keyOf` (the person). Past it 429 RATE_LIMITED with `message` and
 * Retry-After.
 */
export function appWebLimitAcrossReplicas(key: string, limit: number, message: string, keyOf: (req: Request) => string, skip: () => boolean): RequestHandler {
  const counter = createFixedWindowCounter();
  return async (req, res, next) => {
    if (skip()) {
      next();
      return;
    }
    try {
      const admission = await counter.admit(`slock:app-web:${key}:${keyOf(req)}`, limit, APP_WEB_LIMIT_WINDOW_SECONDS, Date.now());
      if (admission.admitted) {
        next();
        return;
      }
      const { retryAfterSeconds } = admission;
      setRequestTraceRateLimiter(res, key);
      res.setHeader("Cache-Control", "private, no-store");
      if (!req.readableEnded) res.setHeader("Connection", "close");
      refuse(res, 429, {
        code: "RATE_LIMITED",
        error: message,
        retryAfterSeconds,
        details: { operation: key, limit, windowSeconds: APP_WEB_LIMIT_WINDOW_SECONDS, retryAfterSeconds },
      });
    } catch (err) {
      next(err);
    }
  };
}

/**
 * Runs every app's web mount (once per Raft app instance). `rateLimit` builds
 * a per-user limit named `<id>.<name>` (app.ts: its keys, test overrides;
 * across replicas when the app asks);
 * `messageLimiter` is core's message limit (app.ts, `POST /api/messages`'s),
 * for routes that post messages (`messageLimit`); `accountAuth` is the
 * person's auth ahead of each account route (app.ts: requireAuth,
 * requireVerified).
 */
export function mountFirstPartyAppWebApis(
  rateLimit: (key: string, limit: AppWebRateLimitSpec) => RequestHandler,
  messageLimiter: RequestHandler,
  accountAuth: readonly RequestHandler[],
): FirstPartyAppWebMounts {
  const mounts: FirstPartyAppWebMounts = { routers: [], accountRouters: [] };
  for (const app of firstPartyApps()) {
    const mountWeb = app.routes?.webApi;
    if (!mountWeb) continue;
    const router = Router();
    const accountRouter = Router();
    let accountRoutes = 0;
    let accountUndecodable: (() => AppError) | null = null;
    const base = `/api/${app.id}`;
    const limiters = new Map<string, { handler: RequestHandler; acrossReplicas: boolean }>();
    let undecodable: ((call: WebApiCall, path: string) => Promise<AppError>) | null = null;
    const mount: WebApiMount = {
      rateLimit(name, limit) {
        if (limiters.has(name)) throw new Error(`${app.id} declares the rate limit ${name} twice`);
        limiters.set(name, { handler: rateLimit(`${app.id}.${name}`, limit), acrossReplicas: limit.acrossReplicas === true });
        return { name };
      },
      route(method, path, name, run, options) {
        const limiter = options?.rateLimit ? limiterOf(options.rateLimit) : null;
        router[method](path, ...(limiter ? [limiter] : []), ...(options?.messageLimit ? [messageLimiter] : []), handle(app, name, run));
      },
      // The body is raw bytes the operation reads as a stream (the global JSON parser leaves them alone);
      // a refusal that leaves it unread closes the connection rather than drain it.
      upload(path, name, run, options) {
        router.post(path, limiterOf(options.rateLimit), async (req, res) => {
          try {
            const result = await run(callOf(app, req), { contentType: req.headers["content-type"], contentLength: req.headers["content-length"], body: req });
            res.setHeader("Cache-Control", "private, no-store");
            if (!req.readableEnded) res.setHeader("Connection", "close");
            if (result.kind === "error") {
              noteAppPaywallHit(req, result.paywallHit, req.userId!);
              sendError(res, result);
              return;
            }
            res.status(result.status ?? 200).json(result.body);
          } catch (err) {
            if (res.headersSent) return;
            console.error(`api.${app.id}.${name} failed`, serializeErrorForLog(err));
            if (!req.readableEnded) res.setHeader("Connection", "close");
            res.status(500).json({ error: `Failed to answer for ${app.id}` });
          }
        });
      },
      undecodable(run) {
        undecodable = run;
      },
      accountRoute(path, name, run, options) {
        if (accountUndecodable && accountUndecodable !== options.undecodable) throw new Error(`${app.id}'s account routes answer an undecodable segment one way`);
        accountUndecodable = options.undecodable;
        accountRoutes += 1;
        accountRouter.get(path, (_req, res, next) => {
          accountAnswerHeaders(res);
          next();
        }, ...accountAuth, limiterOf(options.rateLimit), handleAccount(app, name, run));
      },
    };
    const limiterOf = (token: AppRateLimit): RequestHandler => {
      const limiter = limiters.get(token.name);
      if (!limiter) throw new Error(`${app.id} uses the undeclared rate limit ${token.name}`);
      return limiter.handler;
    };
    mountWeb(mount);
    // A segment that isn't valid percent-encoding fails to decode before any
    // route runs: the app answers it (its own checks first).
    router.use(async (err: unknown, req: Request, res: Response, next: NextFunction) => {
      if (!(err instanceof URIError) || !undecodable) {
        next(err);
        return;
      }
      try {
        const result = await undecodable(callOf(app, req), req.path);
        res.setHeader("Cache-Control", "private, no-store");
        sendError(res, result);
      } catch (error) {
        next(error);
      }
    });
    mounts.routers.push({ path: base, router });
    if (accountRoutes > 0) {
      // An account route's segment that doesn't decode: the app's answer, after the same auth.
      const refuseUndecodable = Router();
      refuseUndecodable.use((_req, res, next) => {
        accountAnswerHeaders(res);
        next();
      }, ...accountAuth, (_req, res) => sendError(res, accountUndecodable!()));
      accountRouter.use((err: unknown, req: Request, res: Response, next: NextFunction) => {
        if (!(err instanceof URIError)) {
          next(err);
          return;
        }
        refuseUndecodable(req, res, next);
      });
      mounts.accountRouters.push({ path: base, router: accountRouter });
    }
  }
  return mounts;
}

/** Every answer of a signed-out route: never stored by a cache, never indexed. */
function publicAnswerHeaders(res: Response): void {
  res.setHeader("Cache-Control", "private, no-store");
  res.setHeader("X-Robots-Tag", "noindex, nofollow");
}

/**
 * A public Markdown document (AppPublicMarkdown): untrusted text that must
 * never render as a page, so never HTML (nosniff, a CSP with no source and a
 * sandbox); `private, no-store` as every signed-out answer (publicAnswerHeaders).
 * Sent as text/plain, not text/markdown: these are read by AI chats' fetch
 * tools, and ChatGPT's refuses text/markdown (xxchan, #proj-workspace:ea136a38).
 */
function sendPublicMarkdown(res: Response, result: AppPublicMarkdown): void {
  res.setHeader("Content-Type", "text/plain; charset=utf-8");
  res.setHeader("X-Content-Type-Options", "nosniff");
  res.setHeader("Content-Security-Policy", "default-src 'none'; sandbox");
  res.status(200).send(Buffer.from(result.body, "utf8"));
}

/**
 * Runs every app's signed-out web mount (once per Raft app instance): each
 * app's router, at `/api/public/<id>`. `rateLimit` builds a per-client-address
 * limit named `<id>.public.<name>` (app.ts: its keys, test overrides).
 */
export function mountFirstPartyAppPublicApis(
  rateLimit: (key: string, limit: { perMinute: number; message: string }) => RequestHandler,
): Array<{ path: string; router: RouterType }> {
  const routers: Array<{ path: string; router: RouterType }> = [];
  for (const app of firstPartyApps()) {
    const mountPublic = app.routes?.publicWebApi;
    if (!mountPublic) continue;
    const router = Router();
    // Before any limiter or route, so a 429 or a refusal carries them too.
    router.use((_req, res, next) => {
      publicAnswerHeaders(res);
      next();
    });
    const limiters = new Map<string, RequestHandler>();
    let undecodable: (() => AppError) | null = null;
    const mount: PublicWebApiMount = {
      rateLimit(name, limit) {
        if (limiters.has(name)) throw new Error(`${app.id} declares the public rate limit ${name} twice`);
        limiters.set(name, rateLimit(`${app.id}.public.${name}`, limit));
        return { name };
      },
      route(method, path, name, run, options) {
        const limiter = limiters.get(options.rateLimit.name);
        if (!limiter) throw new Error(`${app.id} uses the undeclared public rate limit ${options.rateLimit.name}`);
        router[method](path, limiter, async (req: Request, res: Response) => {
          try {
            // Only the path's params: the operation never sees a header, a cookie, the query or the body.
            // A wildcard (`*path`) is its decoded segments joined by "/".
            const params = Object.fromEntries(Object.entries(req.params as Record<string, string | string[]>)
              .map(([key, value]) => [key, Array.isArray(value) ? value.join("/") : value]));
            const call: PublicWebApiCall = { params };
            const result = await run(call);
            publicAnswerHeaders(res);
            if (result.kind === "error") {
              sendError(res, result);
              return;
            }
            if (result.kind === "markdown") {
              sendPublicMarkdown(res, result);
              return;
            }
            if (result.kind === "bytes") {
              await sendBytes(res, result, `api.public.${app.id}.${name}`);
              return;
            }
            res.status(result.status ?? 200).json(result.body);
          } catch (err) {
            if (res.headersSent) return;
            console.error(`api.public.${app.id}.${name} failed`, serializeErrorForLog(err));
            res.status(500).json({ error: `Failed to answer for ${app.id}` });
          }
        });
      },
      undecodable(answer) {
        undecodable = answer;
      },
    };
    mountPublic(mount);
    router.use((err: unknown, _req: Request, res: Response, next: NextFunction) => {
      if (!(err instanceof URIError) || !undecodable) {
        next(err);
        return;
      }
      publicAnswerHeaders(res);
      sendError(res, undecodable());
    });
    routers.push({ path: `/api/public/${app.id}`, router });
  }
  return routers;
}

/** The header the app's edge (its CloudFront distribution) adds to every request it sends to a page route. */
export const APP_EDGE_HEADER = "x-raft-app-edge";

/**
 * Whether `req` came through the app's edge: it carries APP_EDGE_HEADER equal
 * to RAFT_APP_EDGE_HEADER_VALUE. Never while that isn't configured. The value
 * isn't a secret (a browser's own navigation never sends the header, so
 * knowing it doesn't put a person's page on the API's origin); it only keeps
 * the page routes off the API host.
 */
export function cameThroughAppEdge(req: Request, env: NodeJS.ProcessEnv = process.env): boolean {
  const expected = env.RAFT_APP_EDGE_HEADER_VALUE?.trim();
  return Boolean(expected) && req.get(APP_EDGE_HEADER) === expected;
}

/**
 * Runs every app's signed-out page mount (once per Raft app instance): a
 * router at `/<id>` behind the edge check (cameThroughAppEdge; else a plain
 * 404, `no-store`).
 */
export function mountFirstPartyAppPublicPages(
  rateLimit: (key: string, limit: { perMinute: number; message: string }) => RequestHandler,
): Array<{ path: string; router: RouterType }> {
  const routers: Array<{ path: string; router: RouterType }> = [];
  for (const app of firstPartyApps()) {
    const mountPage = app.routes?.publicPage;
    if (!mountPage) continue;
    const router = Router();
    router.use((req, res, next) => {
      if (cameThroughAppEdge(req)) {
        next();
        return;
      }
      res.status(404).set({ "Content-Type": "text/plain; charset=utf-8", "Cache-Control": "no-store" }).end("Not Found\n");
    });
    const names = new Set<string>();
    const mount: PublicPageMount = {
      use(pageRouter) {
        router.use(pageRouter);
      },
      rateLimit(name, limit) {
        if (names.has(name)) throw new Error(`${app.id} declares the page rate limit ${name} twice`);
        names.add(name);
        return rateLimit(`${app.id}.page.${name}`, limit);
      },
    };
    mountPage(mount);
    routers.push({ path: `/${app.id}`, router });
  }
  return routers;
}

/** Runs every app's internal mount (once per Raft app instance): routers under `/internal/<path>`. */
export function mountFirstPartyAppInternals(): Array<{ path: string; router: RouterType }> {
  const routers: Array<{ path: string; router: RouterType }> = [];
  for (const app of firstPartyApps()) {
    app.routes?.internal?.({
      use(path, router) {
        if (path !== app.id && !path.startsWith(`${app.id}-`) && !path.startsWith(`${app.id}/`)) {
          throw new Error(`${app.id}'s internal routes are under /internal/${app.id}…, not /internal/${path}`);
        }
        routers.push({ path: `/internal/${path}`, router });
      },
      clientIp: clientIpForRateLimit,
      serializeError: serializeErrorForLog,
    });
  }
  return routers;
}
