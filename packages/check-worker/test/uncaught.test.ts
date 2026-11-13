import assert from "node:assert/strict";
import test from "node:test";

import { CHECK_TIMING } from "../src/check";
import type { CheckWorkerEnv } from "../src/config";
import { createHandler } from "../src/handler";
import { openWith } from "../src/open";
import { API_ORIGIN, fakeBrowser, fakeClock, fakeRaft, leaseFor, loopbackContext, recordingLogger, TICKET, TICKET_URL, WORKER_TOKEN, type PageScript } from "./fakes";

/**
 * Nothing escapes the Worker's handlers (src/handler.ts; Tenny's review of #12779): with Workers
 * Logs on, an uncaught exception or a rejected promise is recorded with its message, stack and
 * cause, and a browser's navigation errors name the URL they failed on. Here `goto` throws errors
 * whose message, stack and `cause` all carry the ticket URL; the handler resolves (the cron run and
 * the check it dispatched through the loopback, `POST /run`), no log line and no report field has
 * the URL, and nothing is left rejected.
 */

const leaks = (text: string) => [TICKET, TICKET_URL, encodeURIComponent(TICKET), "ticket=tkt1", "_raft/open?", WORKER_TOKEN].filter((secret) => text.includes(secret));

/** A navigation error as puppeteer might throw it: the URL in its message, its stack and its cause. */
function urlError(message: string, name = "Error"): Error {
  const error = new Error(`${message} at ${TICKET_URL}`, { cause: new Error(`while loading ${TICKET_URL}`) });
  error.name = name;
  error.stack = `${name}: ${message} at ${TICKET_URL}\n    at goto (${TICKET_URL}:1:1)`;
  return error;
}

const BROWSER = { fetch: async () => new Response(null) } as unknown as Fetcher;
const ENV: CheckWorkerEnv = { BROWSER, RAFT_API_ORIGIN: API_ORIGIN, ARTIFACTS_CHECK_WORKER_TOKEN: WORKER_TOKEN };

function fakeContext() {
  const waited: Promise<unknown>[] = [];
  const ctx = { waitUntil: (promise: Promise<unknown>) => void waited.push(promise), passThroughOnException: () => {}, props: {} } as unknown as ExecutionContext;
  return { ctx, waited };
}
const controller = { cron: "* * * * *", scheduledTime: 0, noRetry: () => {} } as unknown as ScheduledController;

/** Watches the process for rejections nobody handled while `body` runs (and a little after). */
async function withoutUnhandledRejections(body: () => Promise<void>): Promise<unknown[]> {
  const unhandled: unknown[] = [];
  const keep = (reason: unknown) => void unhandled.push(reason);
  process.on("unhandledRejection", keep);
  try {
    await body();
    await new Promise((resolve) => setTimeout(resolve, 50));
  } finally {
    process.off("unhandledRejection", keep);
  }
  return unhandled;
}

async function scheduledRun(script: PageScript | ((index: number) => PageScript), options: { now?: () => number } = {}) {
  const clock = fakeClock();
  const { log, lines } = recordingLogger();
  const { browser } = fakeBrowser(script, { now: clock.now });
  const raft = fakeRaft({ leases: [leaseFor(), 204] });
  const handler = createHandler({ acquireBrowser: async () => browser, log, fetch: raft.fetch, now: options.now ?? clock.now, sleep: clock.sleep });
  const { ctx, waited } = loopbackContext(handler, ENV);
  await handler.scheduled(controller, ENV, ctx);
  const settled = await Promise.allSettled(waited);
  const reports = raft.calls.filter((call) => call.form !== null).map((call) => call.form!.get("report") as string);
  return { lines, reports, settled };
}

test("goto throws with the ticket URL in its message, stack and cause: the handler resolves, no log line or report has it", async () => {
  const cases: Array<[Error | string, Record<string, string>]> = [
    [urlError("Navigation failed because browser has disconnected!"), { outcome: "error", errorClass: "navigation_failed" }],
    [urlError("net::ERR_CONNECTION_RESET"), { outcome: "error", errorClass: "net.connection_reset" }],
    [urlError("Navigation timeout of 25000 ms exceeded", "TimeoutError"), { outcome: "timeout" }],
    [`Protocol error (Page.navigate): Target closed ${TICKET_URL}`, { outcome: "error", errorClass: "navigation_failed" }],
  ];
  for (const [thrown, load] of cases) {
    let run: Awaited<ReturnType<typeof scheduledRun>> | undefined;
    const unhandled = await withoutUnhandledRejections(async () => {
      run = await scheduledRun({
        goto: async () => {
          throw thrown;
        },
      });
    });
    assert.deepEqual(unhandled, [], "nothing left rejected");
    assert.ok(run);
    assert.ok(run.settled.every((each) => each.status === "fulfilled"), "the waitUntil promise resolves");
    assert.ok(run.lines.length > 0);
    for (const line of run.lines) {
      assert.deepEqual(leaks(line), [], line);
      assert.equal(/[a-z]+:\/\//i.test(line), false, `no URL in a log line: ${line}`);
    }
    assert.equal(run.reports.length, 1);
    const report = JSON.parse(run.reports[0]!) as { load: Record<string, string> };
    assert.deepEqual(report.load, load);
    assert.deepEqual(leaks(run.reports[0]!), [], run.reports[0]);
  }
});

test("openWith: an outcome from the error's kind alone, never a thrown value", async () => {
  const isTimeout = (error: unknown) => error instanceof Error && error.name === "TimeoutError";
  const outcomes = [
    await openWith(async () => {
      throw urlError("net::ERR_NAME_NOT_RESOLVED");
    }, isTimeout),
    await openWith(async () => {
      throw urlError("x", "TimeoutError");
    }, isTimeout),
    await openWith(async () => {
      throw { toString: () => TICKET_URL };
    }, isTimeout),
    await openWith(async () => {
      throw urlError("anything");
    }, () => {
      throw urlError("the predicate itself");
    }),
    await openWith(async () => ({ status: () => 200 }), isTimeout),
    await openWith(async () => null, isTimeout),
  ];
  assert.deepEqual(outcomes, [
    { kind: "error", errorClass: "net.name_not_resolved" },
    { kind: "timeout" },
    { kind: "error", errorClass: "navigation_failed" },
    { kind: "error", errorClass: "navigation_failed" },
    { kind: "loaded", status: 200 },
    { kind: "loaded", status: null },
  ]);
  assert.deepEqual(leaks(JSON.stringify(outcomes)), []);
});

test("a step that loses its time limit and rejects later with the URL is not left unhandled", async () => {
  const timing = { ...CHECK_TIMING, stepTimeoutMs: 5 };
  const clock = fakeClock();
  const { log, lines } = recordingLogger();
  const { browser } = fakeBrowser(
    { screenshot: () => new Promise<Uint8Array>((_, reject) => setTimeout(() => reject(urlError("Protocol error (Page.captureScreenshot): Target closed")), 20)) },
    { now: clock.now },
  );
  const raft = fakeRaft({ leases: [leaseFor(), 204] });
  const handler = createHandler({ acquireBrowser: async () => browser, log, fetch: raft.fetch, now: clock.now, sleep: clock.sleep, timing });
  const unhandled = await withoutUnhandledRejections(async () => {
    const { ctx } = loopbackContext(handler, ENV);
    await handler.scheduled(controller, ENV, ctx);
  });
  assert.deepEqual(unhandled, []);
  assert.ok(lines.some((line) => JSON.parse(line).evt === "raft-check.shot.failed" && JSON.parse(line).errorClass === "timeout"));
  for (const line of lines) assert.deepEqual(leaks(line), [], line);
});

test("a throw at the run's outermost level is logged as its class only; the handler resolves", async () => {
  // The run's own clock throws (on its first read): nothing inside the run catches that.
  const unhandled = await withoutUnhandledRejections(async () => {
    const run = await scheduledRun({}, {
      now: () => {
        throw urlError("clock broke");
      },
    });
    assert.ok(run.settled.every((each) => each.status === "fulfilled"));
    const failed = run.lines.map((line) => JSON.parse(line) as Record<string, unknown>).filter((line) => line.evt === "raft-check.run.failed");
    assert.deepEqual(failed, [{ evt: "raft-check.run.failed", errorClass: "uncaught" }]);
    for (const line of run.lines) assert.deepEqual(leaks(line), [], line);
  });
  assert.deepEqual(unhandled, []);

  // Before the run: the settings themselves throw.
  const { log, lines } = recordingLogger();
  const handler = createHandler({ acquireBrowser: async () => fakeBrowser().browser, log });
  const env = {
    get RAFT_API_ORIGIN(): string {
      throw urlError("settings broke");
    },
  } as unknown as CheckWorkerEnv;
  await handler.scheduled(controller, env, fakeContext().ctx);
  assert.deepEqual(lines.map((line) => JSON.parse(line)), [{ evt: "raft-check.scheduled.failed", errorClass: "uncaught" }]);
});

test("fetch: /health answers; a throw is a bare 500 and its class in the log", async () => {
  const { log, lines } = recordingLogger();
  const handler = createHandler({ acquireBrowser: async () => fakeBrowser().browser, log });
  const health = await handler.fetch(new Request("https://check.example/health"), ENV);
  assert.equal(health.status, 200);
  assert.deepEqual(await health.json(), { ok: true, configured: true });
  assert.equal((await handler.fetch(new Request("https://check.example/lease", { method: "POST" }), ENV)).status, 404);
  assert.equal((await handler.fetch(new Request("https://check.example/run", { method: "POST", body: JSON.stringify(leaseFor()) }), ENV)).status, 401, "the loopback route needs the Worker's own token");

  const env = {
    get RAFT_API_ORIGIN(): string {
      throw urlError("settings broke");
    },
  } as unknown as CheckWorkerEnv;
  const failed = await handler.fetch(new Request("https://check.example/health"), env);
  assert.equal(failed.status, 500);
  const body = await failed.text();
  assert.deepEqual(leaks(body), [], body);
  assert.deepEqual(lines.map((line) => JSON.parse(line)), [{ evt: "raft-check.fetch.failed", errorClass: "uncaught" }]);
});
