/**
 * Where the measuring browser runs: on this machine (Playwright's Chromium, launched here) or on Cloudflare Browser Run
 * (a Chromium in Cloudflare's network, driven from here over the DevTools protocol; docs/frontend/perf-measure.md,
 * "Where the browser runs"). The page and the script are the same; what differs is the machine and the network the
 * page is loaded on, so two reports are only comparable when their `browser.where` is the same.
 */

import { type Browser, chromium } from "playwright";

export type BrowserWhere = "local" | "browser-run";
export const BROWSER_WHERES: readonly BrowserWhere[] = ["local", "browser-run"];

/**
 * How long a Browser Run session lives without a command (measured 2026-11-14: an idle timeout, not a lifetime: a session
 * asked for 10 s was alive after 27 s of a command every 3 s). The session is ended when the run ends; this is what a
 * killed run leaves behind, so it is kept short, but over the longest quiet stretch of a run: a navigation may take its
 * whole 120 s timeout, and whether the service counts a navigation in flight as a command was not measured.
 */
export const BROWSER_RUN_IDLE_MS = 300_000;
/** How long one HTTP call to the service may take: a stalled one must not hang a finished run before it prints its report. */
export const BROWSER_RUN_HTTP_TIMEOUT_MS = 30_000;
/** The range the service accepts for it. */
export const BROWSER_RUN_IDLE_RANGE_MS = [10_000, 1_200_000] as const;

export class BrowserError extends Error {}

export interface BrowserRunAccess {
  accountId: string;
  token: string;
}

/** What `openBrowser` needs, checked before anything is signed in to or opened. */
export type BrowserPlan = { where: "local"; chromiumArgs: string[] } | { where: "browser-run"; access: BrowserRunAccess };

/** `--browser`'s value, or an error naming the choices. */
export function parseBrowserWhere(value: string | undefined): BrowserWhere {
  const where = value ?? "local";
  if (!(BROWSER_WHERES as readonly string[]).includes(where)) throw new BrowserError(`--browser must be ${BROWSER_WHERES.join(" or ")}, not ${where}`);
  return where as BrowserWhere;
}

/** The account and token for Browser Run, from the environment only (a token on a command line ends up in shell history and in the report's command). */
export function browserRunAccess(env: Record<string, string | undefined>): BrowserRunAccess {
  const accountId = env.RAFT_PERF_CF_ACCOUNT_ID?.trim();
  const token = env.RAFT_PERF_CF_API_TOKEN?.trim();
  if (!accountId || !token) throw new BrowserError("--browser browser-run needs RAFT_PERF_CF_ACCOUNT_ID and RAFT_PERF_CF_API_TOKEN (a Cloudflare API token allowed to edit Browser Run)");
  if (!/^[0-9a-f]{32}$/i.test(accountId)) throw new BrowserError("RAFT_PERF_CF_ACCOUNT_ID is not a Cloudflare account id (32 hex characters)");
  return { accountId, token };
}

/**
 * Everything that can be refused without touching the network: the place, its access, and Chromium switches given for a
 * browser that is not launched here (refused rather than dropped: a host's run marker that silently did nothing would be a lie).
 * A command calls this with its other option checks, before it signs in.
 */
export function planBrowser(value: string | undefined, chromiumArgs: readonly string[], env: Record<string, string | undefined>): BrowserPlan {
  const where = parseBrowserWhere(value);
  if (where === "local") return { where, chromiumArgs: [...chromiumArgs] };
  if (chromiumArgs.length) throw new BrowserError("--chromium-arg has no effect with --browser browser-run (the browser is not launched here)");
  return { where, access: browserRunAccess(env) };
}

/** Browser Run's DevTools HTTP endpoints for an account: where a session is created (POST) and, with its id, ended (DELETE). */
export function browserRunSessionsUrl(accountId: string, idleMs?: number): string {
  if (idleMs !== undefined && (!Number.isInteger(idleMs) || idleMs < BROWSER_RUN_IDLE_RANGE_MS[0] || idleMs > BROWSER_RUN_IDLE_RANGE_MS[1])) throw new BrowserError(`a Browser Run session is kept alive for ${BROWSER_RUN_IDLE_RANGE_MS[0]} to ${BROWSER_RUN_IDLE_RANGE_MS[1]} ms, not ${idleMs}`);
  return `https://api.cloudflare.com/client/v4/accounts/${accountId}/browser-run/devtools/browser${idleMs === undefined ? "" : `?keep_alive=${idleMs}`}`;
}

/** A session id as the service gives it. It goes into the paths of the socket and of the DELETE that ends the session, so one that is not a plain token is refused where it is read. */
export function browserRunSessionId(value: unknown): string {
  if (typeof value !== "string" || !/^[\w-]{8,128}$/.test(value)) throw new BrowserError("the service named no session this tool recognises");
  return value;
}

/** The DevTools socket of one session. */
export function browserRunSocketUrl(accountId: string, sessionId: string): string {
  return `wss://api.cloudflare.com/client/v4/accounts/${accountId}/browser-run/devtools/browser/${sessionId}`;
}

/** An error's text with the account id and the token taken out: connection errors quote the endpoint. */
export function withoutAccess(text: string, access: BrowserRunAccess): string {
  return text.replaceAll(access.token, "<token>").replaceAll(access.accountId, "<account>");
}

/** The pairs (or runs) to leave out as taken on a busy host: none when they are kept on request, and none when the browser was on another machine, whose load this host cannot see. */
export function leftOutAsBusy(busy: readonly number[], options: { keepBusy: boolean; where: BrowserWhere }): number[] {
  return options.keepBusy || options.where !== "local" ? [] : [...busy];
}

export interface OpenedBrowser {
  browser: Browser;
  /** For the report: where the browser ran and which Chromium it was. */
  describe: { where: BrowserWhere; version: string };
  /**
   * Ends the browser. Over DevTools, Playwright's `browser.close()` only disconnects and the session lives on until its
   * idle timeout (measured: still listed 18 s after the disconnect of a 10 s session), holding one of the account's
   * browsers; so a Browser Run session is also ended by its id. Returns a sentence when that failed: for stderr, not for
   * the report's warnings, which say something about the measurement.
   */
  close: () => Promise<string | null>;
}

/** What `openBrowser` does over the network, replaceable in tests. */
export interface BrowserRunTransport {
  fetch: (url: string, init: { method: string; headers: Record<string, string> }) => Promise<{ ok: boolean; status: number; json: () => Promise<unknown> }>;
  connect: (url: string, options: { headers: Record<string, string>; timeout: number }) => Promise<Browser>;
}

const realTransport: BrowserRunTransport = { fetch: (url, init) => fetch(url, { ...init, signal: AbortSignal.timeout(BROWSER_RUN_HTTP_TIMEOUT_MS) }), connect: (url, options) => chromium.connectOverCDP(url, options) };

/** The measuring browser of a plan. */
export async function openBrowser(plan: BrowserPlan, transport: BrowserRunTransport = realTransport): Promise<OpenedBrowser> {
  if (plan.where === "local") {
    const browser = await chromium.launch({ args: plan.chromiumArgs });
    return { browser, describe: { where: "local", version: browser.version() }, close: async () => (await browser.close(), null) };
  }
  const { access } = plan;
  const headers = { Authorization: `Bearer ${access.token}` };
  const said = (error: unknown) => withoutAccess((error as Error)?.message ?? String(error), access).split("\n")[0];
  // The session is created over HTTP so that its id is known: that is what ends it afterwards.
  let sessionId: string;
  try {
    const response = await transport.fetch(browserRunSessionsUrl(access.accountId, BROWSER_RUN_IDLE_MS), { method: "POST", headers });
    if (!response.ok) throw new Error(`the service answered ${response.status}`);
    const body = (await response.json()) as { sessionId?: unknown; result?: { sessionId?: unknown } };
    sessionId = browserRunSessionId(body?.result?.sessionId ?? body?.sessionId);
  } catch (error) {
    throw new BrowserError(`could not start a Browser Run session: ${said(error)}`);
  }
  const end = async (): Promise<string | null> => {
    try {
      const response = await transport.fetch(`${browserRunSessionsUrl(access.accountId)}/${sessionId}`, { method: "DELETE", headers });
      // 404: already gone (it ended by itself, or a release of the service closed it)
      return response.ok || response.status === 404 ? null : `the Browser Run session was not ended (the service answered ${response.status}); it ends by itself after ${BROWSER_RUN_IDLE_MS / 1000} s without a command`;
    } catch (error) {
      return `the Browser Run session was not ended (${said(error)}); it ends by itself after ${BROWSER_RUN_IDLE_MS / 1000} s without a command`;
    }
  };
  let browser: Browser;
  try {
    browser = await transport.connect(browserRunSocketUrl(access.accountId, sessionId), { headers, timeout: 60_000 });
  } catch (error) {
    const notEnded = await end();
    throw new BrowserError(`could not connect to the Browser Run session: ${said(error)}${notEnded ? `; ${notEnded}` : ""}`);
  }
  return {
    browser,
    describe: { where: "browser-run", version: browser.version() },
    close: async () => {
      await browser.close().catch(() => {});
      return end();
    },
  };
}
