// Fakes for the check Worker's tests: a browser (checkPage.ts) whose page does what a test
// scripts, a clock that moves only when slept on, a Raft that answers the two routes, a
// logger that keeps its lines, a dispatch that runs each check in-process, and PNGs made with
// node:zlib.
import { deflateSync } from "node:zlib";

import type { ArtifactCheckLease, ArtifactCheckViewport } from "@botiverse/raft-shared/src/artifactCheckContract";
import { ARTIFACT_CHECK_VIEWPORTS } from "@botiverse/raft-shared/src/artifactCheckContract";

import type { CheckBrowser, CheckContext, CheckPage, OpenResult } from "../src/checkPage";
import type { CheckWorkerEnv } from "../src/config";
import { consoleLogger, type Logger } from "../src/log";
import type { GuardedRequest } from "../src/navigation";
import { openWith } from "../src/open";
import type { PageMeasure } from "../src/pageChecks";
import { runLeasedCheck, type DispatchAnswer, type LeasedCheckDeps } from "../src/runner";

export const TICKET = "tkt1.Q2hlY2tUaWNrZXRDbGFpbXNWYWx1ZQ.U2lnbmF0dXJlVmFsdWVGb3JUZXN0cw";
export const CONTENT_ORIGIN = "https://w-0f6f4a4e-5d1c-4f43-9a27-6a3a1b9c2d10.w.content.example";
export const TICKET_URL = `${CONTENT_ORIGIN}/_raft/open?ticket=${TICKET}`;

export function leaseFor(overrides: Partial<ArtifactCheckLease> = {}): ArtifactCheckLease {
  return {
    checkId: "11111111-1111-4111-8111-111111111111",
    artifactId: "pt_22222222-2222-4222-8222-222222222222",
    versionId: "v_33333333-3333-4333-8333-333333333333",
    url: TICKET_URL,
    viewports: ARTIFACT_CHECK_VIEWPORTS.map((viewport) => ({ ...viewport })),
    lease: "2026-11-04T10:02:00.000Z",
    leaseExpiresAt: "2026-11-04T10:02:00.000Z",
    ...overrides,
  };
}

/** A clock that moves only when slept on (or advanced). */
export function fakeClock(start = Date.parse("2026-11-04T10:00:00.000Z")) {
  let now = start;
  return {
    now: () => now,
    sleep: async (ms: number) => {
      now += ms;
    },
    advance: (ms: number) => {
      now += ms;
    },
  };
}

/** A logger keeping every line it writes, through the real consoleLogger. */
export function recordingLogger(): { log: Logger; lines: string[] } {
  const lines: string[] = [];
  const keep = (line: string) => void lines.push(line);
  return { log: consoleLogger({ info: keep, warn: keep, error: keep }), lines };
}

// ---- PNGs ----------------------------------------------------------------------------

function chunk(type: string, data: Uint8Array): Buffer {
  const length = Buffer.alloc(4);
  length.writeUInt32BE(data.length);
  // The decoder doesn't check CRCs: zeros.
  return Buffer.concat([length, Buffer.from(type, "latin1"), Buffer.from(data), Buffer.alloc(4)]);
}

/**
 * An 8-bit RGB (or RGBA) PNG of `width` × `height` whose pixel colour is
 * `colourAt(x, y)`, each row filtered with `filterOf(y)` (0 none, 1 sub, 2 up,
 * 3 average, 4 paeth), so the decoder's unfiltering is exercised.
 */
export function makePng(
  width: number,
  height: number,
  colourAt: (x: number, y: number) => readonly number[],
  options: { channels?: 3 | 4; filterOf?: (y: number) => number; colorType?: number; bitDepth?: number } = {},
): Uint8Array {
  const channels = options.channels ?? 3;
  const stride = width * channels;
  const rows: number[][] = [];
  for (let y = 0; y < height; y += 1) {
    const row: number[] = [];
    for (let x = 0; x < width; x += 1) row.push(...colourAt(x, y).slice(0, channels));
    rows.push(row);
  }
  const raw: number[] = [];
  const paeth = (a: number, b: number, c: number) => {
    const p = a + b - c;
    const [pa, pb, pc] = [Math.abs(p - a), Math.abs(p - b), Math.abs(p - c)];
    return pa <= pb && pa <= pc ? a : pb <= pc ? b : c;
  };
  for (let y = 0; y < height; y += 1) {
    const filter = options.filterOf?.(y) ?? 0;
    raw.push(filter);
    const row = rows[y]!;
    const up = y > 0 ? rows[y - 1]! : Array.from({ length: stride }, () => 0);
    for (let x = 0; x < stride; x += 1) {
      const left = x >= channels ? row[x - channels]! : 0;
      const upLeft = x >= channels ? up[x - channels]! : 0;
      const predictor = [0, left, up[x]!, (left + up[x]!) >> 1, paeth(left, up[x]!, upLeft)][filter]!;
      raw.push((row[x]! - predictor) & 0xff);
    }
  }
  const header = Buffer.alloc(13);
  header.writeUInt32BE(width, 0);
  header.writeUInt32BE(height, 4);
  header[8] = options.bitDepth ?? 8;
  header[9] = options.colorType ?? (channels === 3 ? 2 : 6);
  const signature = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
  return new Uint8Array(Buffer.concat([signature, chunk("IHDR", header), chunk("IDAT", deflateSync(Buffer.from(raw))), chunk("IEND", new Uint8Array(0))]));
}

/** A small uniform PNG: what a blank page's shot is. */
export const WHITE_PNG = makePng(64, 40, () => [255, 255, 255]);
/** A small PNG of two halves: not uniform. */
export const SPLIT_PNG = makePng(64, 40, (x) => (x < 32 ? [255, 255, 255] : [20, 30, 40]));

// ---- the browser ---------------------------------------------------------------------

/** What a fake page does, as a test scripts it. Every hook gets the page's recorder. */
export interface PageScript {
  /** What `open` answers (default: loaded, 200), after `duringOpen`. */
  open?: OpenResult;
  /** Instead of `open`: a puppeteer-like `goto`, run through the real src/open.ts (as browser.ts runs `page.goto`). */
  goto?: () => Promise<{ status(): number } | null>;
  /** Called during `open`, with the guard's `decide`, the handlers, and the URL: a test makes the page "do" things here. */
  duringOpen?: (page: FakePageEvents) => void | Promise<void>;
  /** What `measure` answers per viewport shot (default: text, no overflow). */
  measure?: (viewport: ArtifactCheckViewport) => PageMeasure;
  /** What `screenshot` answers (default: SPLIT_PNG); a promise is returned as it is. */
  screenshot?: (viewport: ArtifactCheckViewport) => Uint8Array | Error | Promise<Uint8Array>;
  /** Throws from `emulate` once the page has loaded (a viewport change failing). */
  emulateFails?: boolean;
  /**
   * What the shell's script says (`data-porthole-host`, Porthole P139), read at the clock's time
   * since `open`: null, the default, is a page that took the word off the root.
   */
  shellHost?: string | null | ((sinceOpen: number) => string | null);
}

export interface FakePageEvents {
  url: string;
  request(request: GuardedRequest): boolean;
  consoleError(message: string, source: string | null, line: number | null): void;
  pageError(message: string, source?: string | null, line?: number | null): void;
  blocked(url: string): void;
}

export interface FakeRecord {
  contexts: number;
  closedContexts: number;
  pages: number;
  opens: string[];
  /** Each call, in order: `emulate:<shot>`, `open`, `measure:<shot>`, `screenshot:<shot>`, `idle`, with the clock's time. */
  calls: Array<{ call: string; at: number }>;
  decisions: Array<{ url: string; allowed: boolean }>;
  /** The user agent each `emulate` set (null: the browser's own). */
  userAgents: Array<string | null>;
  browserClosed: boolean;
  /** When each close happened (the fake clock). */
  browserCloses: number[];
  /** Each `release`'s `healthy`, in order. */
  releases: boolean[];
}

export function fakeBrowser(
  script: PageScript | ((index: number) => PageScript) = {},
  options: { now?: () => number; newContextFails?: Error; newPageFails?: Error; origin?: CheckBrowser["origin"]; keep?: boolean } = {},
): { browser: CheckBrowser; record: FakeRecord } {
  const now = options.now ?? (() => 0);
  const record: FakeRecord = { contexts: 0, closedContexts: 0, pages: 0, opens: [], calls: [], decisions: [], userAgents: [], browserClosed: false, browserCloses: [], releases: [] };
  const browser: CheckBrowser = {
    origin: options.origin ?? "launched",
    async newContext(): Promise<CheckContext> {
      if (options.newContextFails) throw options.newContextFails;
      const index = record.contexts;
      record.contexts += 1;
      const pageScript = typeof script === "function" ? script(index) : script;
      return {
        async newPage() {
          if (options.newPageFails) throw options.newPageFails;
          record.pages += 1;
          return fakePage(pageScript, record, now);
        },
        async close() {
          record.closedContexts += 1;
        },
      };
    },
    async release(healthy) {
      record.releases.push(healthy);
      // Kept only where the test says the pool would keep it, and the check went well.
      if (options.keep && healthy) return "kept";
      record.browserClosed = true;
      record.browserCloses.push(now());
      return "closed";
    },
  };
  return { browser, record };
}

function fakePage(script: PageScript, record: FakeRecord, now: () => number): CheckPage {
  let decide: ((request: GuardedRequest) => boolean) | null = null;
  let onConsole: (message: string, source: string | null, line: number | null) => void = () => {};
  let onError: (message: string, source: string | null, line: number | null) => void = () => {};
  let onBlocked: (url: string) => void = () => {};
  let viewport: ArtifactCheckViewport | null = null;
  let loaded = false;
  let openedAt = 0;
  const call = (name: string) => record.calls.push({ call: name, at: now() });
  return {
    async guardRequests(given) {
      decide = given;
    },
    onConsoleError: (handler) => void (onConsole = handler),
    onPageError: (handler) => void (onError = handler),
    onBlocked: (handler) => void (onBlocked = handler),
    async emulate(given, userAgent) {
      if (loaded && script.emulateFails) throw new Error(`emulation failed at ${TICKET_URL}`);
      viewport = given;
      record.userAgents.push(userAgent);
      call(`emulate:${given.shot}`);
    },
    async open(url) {
      call("open");
      openedAt = now();
      record.opens.push(url);
      const ask = (request: GuardedRequest) => {
        const allowed = decide === null ? true : decide(request);
        record.decisions.push({ url: request.url, allowed });
        if (!allowed) onBlocked(request.url);
        return allowed;
      };
      ask({ url, isNavigation: true, isMainFrame: true, redirectedFrom: null });
      const pageError = (message: string, source: string | null = null, line: number | null = null) => onError(message, source, line);
      await script.duringOpen?.({ url, request: ask, consoleError: onConsole, pageError, blocked: onBlocked });
      loaded = true;
      if (script.goto) return openWith(script.goto, (error) => error instanceof Error && error.name === "TimeoutError");
      return script.open ?? { kind: "loaded", status: 200 };
    },
    async networkIdle() {
      call("idle");
    },
    async shellHost() {
      call("shell");
      const said = script.shellHost;
      return typeof said === "function" ? said(now() - openedAt) : (said ?? null);
    },
    async measure() {
      call(`measure:${viewport?.shot}`);
      return script.measure?.(viewport!) ?? { textLength: 42, scrollWidth: viewport!.width, innerWidth: viewport!.width };
    },
    async screenshot() {
      call(`screenshot:${viewport?.shot}`);
      const shot = script.screenshot?.(viewport!) ?? SPLIT_PNG;
      if (shot instanceof Error) throw shot;
      return await shot;
    },
  };
}

// ---- Raft ----------------------------------------------------------------------------

export interface RaftCall {
  url: string;
  method: string;
  authorization: string | null;
  form: FormData | null;
}

/** A fetch answering Raft's two routes from queues: `leases` (a lease object, 204, or another status) and `results` (status, body). */
export function fakeRaft(options: { leases: Array<ArtifactCheckLease | number | Error>; results?: Array<{ status: number; body?: unknown } | Error> }) {
  const calls: RaftCall[] = [];
  const leases = [...options.leases];
  const results = [...(options.results ?? [])];
  const fetchImpl: typeof fetch = async (input, init) => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
    const headers = new Headers(init?.headers);
    calls.push({ url, method: init?.method ?? "GET", authorization: headers.get("authorization"), form: init?.body instanceof FormData ? init.body : null });
    if (url.endsWith("/internal/artifacts-check/lease")) {
      const next = leases.shift() ?? 204;
      if (next instanceof Error) throw next;
      if (typeof next === "number") return new Response(next === 204 ? null : JSON.stringify({ error: "x" }), { status: next });
      return Response.json(next);
    }
    const next = results.shift() ?? { status: 200, body: { status: "done" } };
    if (next instanceof Error) throw next;
    return new Response(next.body === undefined ? null : JSON.stringify(next.body), { status: next.status, headers: { "content-type": "application/json" } });
  };
  return { fetch: fetchImpl, calls };
}

export const API_ORIGIN = "https://api.example.com";
export const WORKER_TOKEN = "check-worker-token-0123456789abcdef-test";

// ---- dispatch ------------------------------------------------------------------------

/** runner.ts `dispatch`, without the loopback: each lease's check run in-process (runLeasedCheck), its outcome answered. */
export function inProcessDispatch(deps: LeasedCheckDeps): (lease: ArtifactCheckLease) => Promise<DispatchAnswer> {
  return async (lease) => ({ kind: "ran", outcome: await runLeasedCheck(deps, lease) });
}

/** A promise and its resolver: a dispatch a test ends when it wants. */
export function deferred<T>(): { promise: Promise<T>; resolve: (value: T) => void } {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((given) => (resolve = given));
  return { promise, resolve };
}

/** Lets every pending promise callback and fetch body read run (a few turns of the event loop). */
export async function settle(): Promise<void> {
  for (let turn = 0; turn < 20; turn += 1) await new Promise<void>((resolve) => setImmediate(resolve));
}

/**
 * An ExecutionContext whose loopback (`ctx.exports.default`) is `handler`'s own fetch, as the
 * runtime's is: each request it takes is a dispatched invocation (`runs` keeps a copy of each).
 */
export function loopbackContext(handler: { fetch(request: Request, env: CheckWorkerEnv): Promise<Response> }, env: CheckWorkerEnv) {
  const waited: Promise<unknown>[] = [];
  const runs: Request[] = [];
  const self = {
    fetch: async (input: RequestInfo | URL, init?: RequestInit) => {
      const request = new Request(input, init);
      runs.push(new Request(request.url, { method: request.method, headers: request.headers, body: await request.clone().text() }));
      return handler.fetch(request, env);
    },
  };
  const ctx = { waitUntil: (promise: Promise<unknown>) => void waited.push(promise), passThroughOnException: () => {}, props: {}, exports: { default: self } } as unknown as ExecutionContext;
  return { ctx, waited, runs };
}
