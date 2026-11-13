// The Worker's handlers, built from what they need (checkWorker.ts passes the real browser;
// the tests a fake). Neither handler lets anything escape: an uncaught exception or a rejected
// `waitUntil` promise is recorded by the runtime with its message and stack (Workers Logs is
// on), and a browser's messages name the URL they failed on, the ticket's included. So the
// outermost level of each catches everything and logs only the error's class (report.ts
// errorClassOf: its kind, never its words); nothing is rethrown.
//
// - `scheduled` (every minute): one cron run (runner.ts runChecks), awaited and given to
//   `waitUntil`: it leases checks and hands each to an invocation of its own through the
//   Worker's loopback (dispatch.ts). No loopback (`ctx.exports.default`): it logs
//   `misconfigured` and leases nothing.
// - `fetch`:
//   - `POST /run`: one dispatched check (runner.ts runLeasedCheck), only with the Worker's own
//     token (dispatch.ts); its answer `{ outcome }`. Without the token 401; a body that isn't a
//     lease 400; unconfigured 503.
//   - `GET /health` (whether the Worker is configured, never a value).
//   - everything else a 404; a failure a bare 500. Deployed, nothing but the loopback reaches it:
//     the Worker has no host (`workers_dev: false`, no preview URLs, no route), and the deploy has
//     no HTTP smoke. `/health` stays for `wrangler dev`, where it is the one way to ask a local
//     Worker whether it is configured.
import type { CheckTiming } from "./check";
import type { CheckBrowser } from "./checkPage";
import { configOf, type CheckWorkerEnv } from "./config";
import { bearerMatches, dispatchThrough, loopbackOf, RUN_PATH } from "./dispatch";
import { consoleLogger, type Logger } from "./log";
import type { PoolDeps } from "./pool";
import { parseLease } from "./raftClient";
import { errorClassOf } from "./report";
import { runChecks, runLeasedCheck } from "./runner";

export interface HandlerDeps {
  /** A browser session for one check (browser.ts acquireCheckBrowser: a free one of the account's, else launched). */
  acquireBrowser: (binding: Fetcher, pool: PoolDeps) => Promise<CheckBrowser>;
  log?: Logger;
  /** Raft's fetch (the global one by default). */
  fetch?: typeof fetch;
  now?: () => number;
  sleep?: (ms: number) => Promise<void>;
  timing?: CheckTiming;
  /** The run's bounds (runner.ts defaults when absent). */
  budgetMs?: number;
  maxInFlight?: number;
  launchSpacingMs?: number;
}

const json = (status: number, body: unknown) =>
  new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json", "cache-control": "no-store" } });

export function createHandler(deps: HandlerDeps) {
  const log = deps.log ?? consoleLogger();
  /** Logs `error`'s class only; never throws (a logger that fails is left at that). */
  const failed = (event: string, error: unknown) => {
    try {
      log("error", event, { errorClass: errorClassOf(error, "uncaught") });
    } catch {
      // Nothing more to say safely.
    }
  };
  const raftFetch = deps.fetch ?? ((input: RequestInfo | URL, init?: RequestInit) => fetch(input, init));
  const now = deps.now ?? (() => Date.now());
  const sleep = deps.sleep ?? ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)));

  /** `POST /run`: one dispatched check. */
  async function runOne(request: Request, env: CheckWorkerEnv): Promise<Response> {
    const config = configOf(env);
    if (!config.ok) return json(503, { error: { code: "not-configured" } });
    if (!(await bearerMatches(request.headers.get("authorization"), config.token))) return json(401, { error: { code: "unauthorized" } });
    let body: unknown = null;
    try {
      body = await request.json();
    } catch {
      body = null;
    }
    const lease = parseLease(body);
    if (lease === null) {
      log("error", "run.invalid_lease");
      return json(400, { error: { code: "invalid-lease" } });
    }
    const outcome = await runLeasedCheck(
      { api: { origin: config.origin, token: config.token, fetch: raftFetch }, acquireBrowser: (note) => deps.acquireBrowser(env.BROWSER, { enabled: config.browserPool, now, note }), now, sleep, log, timing: deps.timing },
      lease,
    );
    return json(200, { outcome });
  }

  return {
    async scheduled(_controller: ScheduledController, env: CheckWorkerEnv, ctx: ExecutionContext): Promise<void> {
      try {
        const config = configOf(env);
        if (!config.ok) {
          log("error", "misconfigured", { problem: config.problem });
          return;
        }
        const self = loopbackOf(ctx);
        if (self === null) {
          log("error", "misconfigured", { problem: "the Worker has no loopback to itself (ctx.exports.default)" });
          return;
        }
        const run = runChecks({
          api: { origin: config.origin, token: config.token, fetch: raftFetch },
          dispatch: dispatchThrough(self, config.token),
          now,
          sleep,
          log,
          budgetMs: deps.budgetMs,
          maxInFlight: deps.maxInFlight,
          launchSpacingMs: deps.launchSpacingMs,
        }).then(
          () => undefined,
          (error: unknown) => failed("run.failed", error),
        );
        ctx.waitUntil(run);
        await run;
      } catch (error) {
        failed("scheduled.failed", error);
      }
    },

    async fetch(request: Request, env: CheckWorkerEnv): Promise<Response> {
      try {
        const { pathname } = new URL(request.url);
        if (request.method === "POST" && pathname === RUN_PATH) return await runOne(request, env);
        if ((request.method === "GET" || request.method === "HEAD") && pathname === "/health") {
          return json(200, { ok: true, configured: configOf(env).ok });
        }
        return json(404, { error: { code: "not-found" } });
      } catch (error) {
        failed("fetch.failed", error);
        return json(500, { error: { code: "internal" } });
      }
    },
  } satisfies ExportedHandler<CheckWorkerEnv>;
}
