import assert from "node:assert/strict";
import test from "node:test";

import type { ArtifactCheckLease } from "@botiverse/raft-shared/src/artifactCheckContract";

import type { CheckBrowser } from "../src/checkPage";
import { configOf, type CheckWorkerEnv } from "../src/config";
import { createHandler } from "../src/handler";
import {
  IDLE_POLL_MS,
  LAUNCH_SPACING_MS,
  MAX_IN_FLIGHT,
  RUN_BUDGET_MS,
  runChecks,
  runLeasedCheck,
  type DispatchAnswer,
  type LeasedCheckDeps,
  type RunDeps,
} from "../src/runner";
import {
  API_ORIGIN,
  deferred,
  fakeBrowser,
  fakeClock,
  fakeRaft,
  inProcessDispatch,
  leaseFor,
  loopbackContext,
  recordingLogger,
  settle,
  WORKER_TOKEN,
} from "./fakes";

/**
 * The cron run (src/runner.ts runChecks): it leases checks and hands each to an invocation of its
 * own (`dispatch`; deployed, the Worker's loopback, src/dispatch.ts), at most MAX_IN_FLIGHT at
 * once and LAUNCH_SPACING_MS apart, and on a 204 asks again every IDLE_POLL_MS until its budget,
 * opening no browser itself. One dispatched check (runLeasedCheck): a browser of its own, the
 * check, its result. The loopback route (`POST /run`, src/handler.ts). The Worker's settings
 * (src/config.ts).
 */

const ENV: CheckWorkerEnv = { BROWSER: { fetch: async () => new Response(null) } as unknown as Fetcher, RAFT_API_ORIGIN: API_ORIGIN, ARTIFACTS_CHECK_WORKER_TOKEN: WORKER_TOKEN };
const controller = { cron: "* * * * *", scheduledTime: 0, noRetry: () => {} } as unknown as ScheduledController;

/** A run whose dispatch runs each check in-process with a browser of its own (counted). */
function setup(raft: ReturnType<typeof fakeRaft>, options: { launchFails?: Error; browser?: () => ReturnType<typeof fakeBrowser> } = {}) {
  const clock = fakeClock();
  const logger = recordingLogger();
  const browsers: Array<ReturnType<typeof fakeBrowser>> = [];
  const check: LeasedCheckDeps = {
    api: { origin: API_ORIGIN, token: WORKER_TOKEN, fetch: raft.fetch },
    acquireBrowser: async (): Promise<CheckBrowser> => {
      if (options.launchFails) throw options.launchFails;
      const fake = options.browser?.() ?? fakeBrowser({}, { now: clock.now });
      browsers.push(fake);
      return fake.browser;
    },
    now: clock.now,
    sleep: clock.sleep,
    log: logger.log,
  };
  const deps: RunDeps = { api: check.api, dispatch: inProcessDispatch(check), now: clock.now, sleep: clock.sleep, log: logger.log };
  return { deps, check, clock, logger, browsers };
}

/** A run whose dispatches the test answers itself (`answer(index, …)`), each recorded with the time it was made. */
function heldRun(raft: ReturnType<typeof fakeRaft>, overrides: Partial<RunDeps> = {}) {
  const clock = fakeClock();
  const logger = recordingLogger();
  const dispatched: Array<{ checkId: string; at: number; answer: (value: DispatchAnswer) => void }> = [];
  const deps: RunDeps = {
    api: { origin: API_ORIGIN, token: WORKER_TOKEN, fetch: raft.fetch },
    dispatch: (lease: ArtifactCheckLease) => {
      const held = deferred<DispatchAnswer>();
      dispatched.push({ checkId: lease.checkId, at: clock.now(), answer: held.resolve });
      return held.promise;
    },
    now: clock.now,
    sleep: clock.sleep,
    log: logger.log,
    ...overrides,
  };
  return { deps, clock, logger, dispatched, leaseCalls: () => raft.calls.filter((call) => call.url.endsWith("/lease")).length };
}

const results = (raft: ReturnType<typeof fakeRaft>) => raft.calls.filter((call) => call.url.endsWith("/result"));
const events = (lines: string[]) => lines.map((line) => JSON.parse(line) as Record<string, unknown>);
const leases = (count: number) => Array.from({ length: count }, (_, index) => leaseFor({ checkId: `c${index}` }));

// ---- the run: idle --------------------------------------------------------------------

test("an idle run asks again every IDLE_POLL_MS until its budget, and dispatches nothing: no browser opens", async () => {
  const raft = fakeRaft({ leases: [204] });
  const { deps, browsers, clock } = setup(raft);
  let dispatches = 0;
  const dispatch = deps.dispatch;
  const started = clock.now();
  const summary = await runChecks({ ...deps, dispatch: (lease) => ((dispatches += 1), dispatch(lease)) });
  assert.deepEqual(summary, { leased: 0, recorded: 0, ended: "idle" });
  // Asked at 0, 3, …, 57 s: the next ask would be past the budget, and the next cron is 3 s on.
  assert.equal(raft.calls.length, Math.ceil(RUN_BUDGET_MS / IDLE_POLL_MS));
  assert.ok(raft.calls.every((call) => call.url.endsWith("/internal/artifacts-check/lease")));
  assert.ok(clock.now() - started < RUN_BUDGET_MS);
  // The cron fires every minute: the next run's first ask is no further from this run's last
  // than any two asks are, so a check pushed late in the minute waits no longer than another.
  assert.ok(60_000 - (clock.now() - started) <= IDLE_POLL_MS, `last ask at ${clock.now() - started} ms`);
  assert.equal(dispatches, 0, "nothing handed off");
  assert.equal(browsers.length, 0, "no browser launched");
});

test("an idle minute through the handler: lease calls only, no request to the loopback, no browser", async () => {
  const clock = fakeClock();
  const { log } = recordingLogger();
  const raft = fakeRaft({ leases: [204] });
  let launches = 0;
  const handler = createHandler({ acquireBrowser: async () => ((launches += 1), fakeBrowser().browser), log, fetch: raft.fetch, now: clock.now, sleep: clock.sleep });
  const { ctx, runs } = loopbackContext(handler, ENV);
  await handler.scheduled(controller, ENV, ctx);
  assert.equal(runs.length, 0);
  assert.equal(launches, 0);
  assert.ok(raft.calls.length > 1 && raft.calls.every((call) => call.url.endsWith("/lease")));
});

test("a check pushed mid-run is leased at the next ask, not at the next cron", async () => {
  const raft = fakeRaft({ leases: [204, 204, leaseFor({ checkId: "a" })] });
  const { deps, logger } = setup(raft);
  const summary = await runChecks(deps);
  assert.equal(summary.leased, 1);
  assert.equal(summary.recorded, 1);
  assert.ok(events(logger.lines).some((line) => line.evt === "raft-check.check.leased" && line.checkId === "a"), "the check was leased in this run");
});

test("without a finite budget a 204 ends the run (no endless polling)", async () => {
  const raft = fakeRaft({ leases: [204] });
  const { deps } = setup(raft);
  assert.deepEqual(await runChecks({ ...deps, budgetMs: Number.POSITIVE_INFINITY }), { leased: 0, recorded: 0, ended: "idle" });
  assert.equal(raft.calls.length, 1);
});

// ---- the run: in parallel -------------------------------------------------------------

test("several checks leased: each handed to its own invocation (the loopback's POST /run), each with a browser of its own", async () => {
  const clock = fakeClock();
  const { log, lines } = recordingLogger();
  const raft = fakeRaft({ leases: [leaseFor({ checkId: "a" }), leaseFor({ checkId: "b" }), leaseFor({ checkId: "c" }), 204] });
  const browsers: Array<ReturnType<typeof fakeBrowser>> = [];
  const handler = createHandler({
    acquireBrowser: async () => {
      const fake = fakeBrowser({}, { now: clock.now });
      browsers.push(fake);
      return fake.browser;
    },
    log,
    fetch: raft.fetch,
    now: clock.now,
    sleep: clock.sleep,
    budgetMs: Number.POSITIVE_INFINITY,
  });
  const { ctx, runs } = loopbackContext(handler, ENV);
  await handler.scheduled(controller, ENV, ctx);

  // One request to the Worker itself per lease, with its own token and that lease.
  assert.equal(runs.length, 3);
  for (const run of runs) {
    assert.equal(run.method, "POST");
    assert.equal(new URL(run.url).pathname, "/run");
    assert.equal(run.headers.get("authorization"), `Bearer ${WORKER_TOKEN}`);
  }
  const sent = await Promise.all(runs.map(async (run) => ((await run.json()) as ArtifactCheckLease).checkId));
  assert.deepEqual(sent.sort(), ["a", "b", "c"]);
  // A browser per check, one context in it, both closed after.
  assert.equal(browsers.length, 3);
  for (const fake of browsers) {
    assert.equal(fake.record.contexts, 1);
    assert.equal(fake.record.closedContexts, 1);
    assert.equal(fake.record.browserClosed, true);
  }
  assert.deepEqual(results(raft).map((call) => call.url).sort(), ["a", "b", "c"].map((id) => `${API_ORIGIN}/internal/artifacts-check/${id}/result`));
  const ended = events(lines).find((line) => line.evt === "raft-check.run.ended");
  assert.deepEqual([ended?.status, ended?.count], ["idle", 3]);
});

test("checks run in parallel: every lease is dispatched before any check has answered", async () => {
  const raft = fakeRaft({ leases: [...leases(4), 204] });
  const { deps, dispatched } = heldRun(raft, { budgetMs: Number.POSITIVE_INFINITY });
  const run = runChecks(deps);
  await settle();
  assert.deepEqual(dispatched.map((each) => each.checkId), ["c0", "c1", "c2", "c3"], "all four in flight at once");
  for (const each of dispatched) each.answer({ kind: "ran", outcome: "recorded" });
  assert.deepEqual(await run, { leased: 4, recorded: 4, ended: "idle" });
});

test("launches are spread out: dispatches at least LAUNCH_SPACING_MS apart (Browser Rendering's 3 new browsers a second)", async () => {
  assert.ok(LAUNCH_SPACING_MS >= 1000 / 3, "at most three a second");
  const raft = fakeRaft({ leases: [...leases(5), 204] });
  const { deps, dispatched, clock } = heldRun(raft, { budgetMs: Number.POSITIVE_INFINITY });
  const started = clock.now();
  const run = runChecks(deps);
  await settle();
  assert.equal(dispatched.length, 5);
  assert.equal(dispatched[0]!.at, started, "the first at once");
  for (let at = 1; at < dispatched.length; at += 1) {
    assert.ok(dispatched[at]!.at - dispatched[at - 1]!.at >= LAUNCH_SPACING_MS, `dispatch ${at} spaced: ${dispatched[at]!.at - dispatched[at - 1]!.at} ms`);
  }
  for (const each of dispatched) each.answer({ kind: "ran", outcome: "recorded" });
  await run;
});

test("the safety cap: at most maxInFlight checks at once; at the cap the run asks for no lease until one ends", async () => {
  const raft = fakeRaft({ leases: [...leases(5), 204] });
  const { deps, dispatched, leaseCalls } = heldRun(raft, { budgetMs: Number.POSITIVE_INFINITY, maxInFlight: 2 });
  const run = runChecks(deps);
  await settle();
  assert.equal(dispatched.length, 2);
  assert.equal(leaseCalls(), 2, "no lease asked for at the cap (it would sit leased, unchecked)");

  dispatched[0]!.answer({ kind: "ran", outcome: "recorded" });
  await settle();
  assert.equal(dispatched.length, 3, "one ended, one more");
  assert.equal(leaseCalls(), 3);

  dispatched[1]!.answer({ kind: "ran", outcome: "recorded" });
  dispatched[2]!.answer({ kind: "ran", outcome: "recorded" });
  await settle();
  assert.equal(dispatched.length, 5);
  dispatched[3]!.answer({ kind: "ran", outcome: "recorded" });
  dispatched[4]!.answer({ kind: "ran", outcome: "recorded" });
  assert.deepEqual(await run, { leased: 5, recorded: 5, ended: "idle" });
});

test("the default cap is MAX_IN_FLIGHT", async () => {
  const raft = fakeRaft({ leases: leases(MAX_IN_FLIGHT + 5) });
  const { deps, dispatched, leaseCalls } = heldRun(raft, { budgetMs: Number.POSITIVE_INFINITY });
  const run = runChecks(deps);
  await settle();
  assert.equal(dispatched.length, MAX_IN_FLIGHT);
  assert.equal(leaseCalls(), MAX_IN_FLIGHT);
  // Each one answered lets one more go, until the leases run out (the fake answers 204 then).
  for (let answered = 0; answered < dispatched.length; answered += 1) {
    dispatched[answered]!.answer({ kind: "ran", outcome: "recorded" });
    await settle();
  }
  assert.deepEqual(await run, { leased: MAX_IN_FLIGHT + 5, recorded: MAX_IN_FLIGHT + 5, ended: "idle" });
});

test("no check is leased once the run is past its budget; the run still waits for those in flight", async () => {
  const raft = fakeRaft({ leases: leases(10) });
  const { deps, dispatched, clock, leaseCalls } = heldRun(raft, { budgetMs: 1_000 });
  const run = runChecks(deps);
  await settle();
  // Leased at 0, 350 and 700 ms; the fourth ask would be at 1050 ms, past the budget.
  assert.equal(dispatched.length, 3);
  assert.equal(leaseCalls(), 3);
  let ended = false;
  void run.then(() => (ended = true));
  await settle();
  assert.equal(ended, false, "not before its checks answered");
  for (const each of dispatched) each.answer({ kind: "ran", outcome: "recorded" });
  assert.deepEqual(await run, { leased: 3, recorded: 3, ended: "budget" });
  assert.ok(clock.now() >= 1_000);
});

// ---- the run: what ends the leasing -----------------------------------------------------

test("a 401 on the lease ends the run with nothing dispatched (a token mid-rotation)", async () => {
  const raft = fakeRaft({ leases: [401, leaseFor()] });
  const { deps, browsers, logger } = setup(raft);
  assert.deepEqual(await runChecks(deps), { leased: 0, recorded: 0, ended: "refused" });
  assert.equal(browsers.length, 0);
  assert.ok(events(logger.lines).some((line) => line.evt === "raft-check.lease.refused" && line.status === 401));
});

test("Raft unavailable on the lease ends the run", async () => {
  const raft = fakeRaft({ leases: [503, leaseFor()] });
  const { deps } = setup(raft);
  assert.deepEqual(await runChecks(deps), { leased: 0, recorded: 0, ended: "unavailable" });
});

test("a check answering refused (401 on its result) or browser_unavailable ends the leasing; a conflict doesn't", async () => {
  for (const [outcome, ended] of [["refused", "refused"], ["browser_unavailable", "browser"]] as const) {
    const raft = fakeRaft({ leases: [...leases(4), 204] });
    const { deps, dispatched, leaseCalls } = heldRun(raft, { budgetMs: Number.POSITIVE_INFINITY, maxInFlight: 1 });
    const run = runChecks(deps);
    await settle();
    dispatched[0]!.answer({ kind: "ran", outcome: "conflict" });
    await settle();
    assert.equal(dispatched.length, 2, "a conflict: the run goes on");
    dispatched[1]!.answer({ kind: "ran", outcome });
    await settle();
    assert.equal(dispatched.length, 2, `${outcome}: nothing more leased`);
    assert.equal(leaseCalls(), 2);
    assert.deepEqual(await run, { leased: 2, recorded: 0, ended });
  }
});

test("a dispatch that fails (no answer, a 500, a throw) is logged with the check's ids and the run goes on", async () => {
  const raft = fakeRaft({ leases: [...leases(3), 204] });
  const { deps, logger } = heldRun(raft, { budgetMs: Number.POSITIVE_INFINITY });
  const answers: Array<() => Promise<DispatchAnswer>> = [
    async () => ({ kind: "failed", status: 0 }),
    async () => ({ kind: "failed", status: 500 }),
    async () => {
      throw new Error("loopback gone");
    },
  ];
  let at = 0;
  const summary = await runChecks({ ...deps, dispatch: () => answers[at++]!() });
  assert.deepEqual(summary, { leased: 3, recorded: 0, ended: "idle" });
  const failed = events(logger.lines).filter((line) => line.evt === "raft-check.dispatch.failed");
  assert.deepEqual(failed.map((line) => [line.checkId, line.status]), [["c0", 0], ["c1", 500], ["c2", 0]]);
});

// ---- one dispatched check -----------------------------------------------------------------

test("a dispatched check: a browser of its own, a fresh context, the result posted, both closed after (the pool keeping nothing)", async () => {
  const raft = fakeRaft({ leases: [] });
  const { check, browsers } = setup(raft);
  assert.equal(await runLeasedCheck(check, leaseFor({ checkId: "a" })), "recorded");
  assert.equal(browsers.length, 1);
  assert.deepEqual([browsers[0]!.record.contexts, browsers[0]!.record.closedContexts, browsers[0]!.record.browserClosed], [1, 1, true]);
  assert.deepEqual(results(raft).map((call) => call.url), [`${API_ORIGIN}/internal/artifacts-check/a/result`]);
  const report = JSON.parse(results(raft)[0]!.form!.get("report") as string) as { checkId: string; lease: string };
  assert.deepEqual({ checkId: report.checkId, lease: report.lease }, { checkId: "a", lease: leaseFor().lease });
});

test("a dispatched check releases its browser before its result goes: healthy after a check that ran, not after one that didn't start", async () => {
  const clock = fakeClock();
  const logger = recordingLogger();
  const raft = fakeRaft({ leases: [] });
  const fake = fakeBrowser({}, { now: clock.now, origin: "reused", keep: true });
  const releasedWhenPosted: number[] = [];
  const check: LeasedCheckDeps = {
    api: {
      origin: API_ORIGIN,
      token: WORKER_TOKEN,
      fetch: async (input, init) => {
        releasedWhenPosted.push(fake.record.releases.length);
        return raft.fetch(input, init);
      },
    },
    acquireBrowser: async (note) => {
      note("pool.connect_failed", {});
      return fake.browser;
    },
    now: clock.now,
    sleep: clock.sleep,
    log: logger.log,
  };
  assert.equal(await runLeasedCheck(check, leaseFor({ checkId: "a" })), "recorded");
  assert.deepEqual(fake.record.releases, [true], "released once, healthy");
  assert.deepEqual(releasedWhenPosted, [1], "before the result was posted");
  assert.equal(fake.record.browserClosed, false, "kept for the next check, as the pool said");
  const lines = events(logger.lines);
  assert.deepEqual(
    lines.filter((line) => String(line.evt).startsWith("raft-check.browser.") || String(line.evt).startsWith("raft-check.pool.")).map((line) => [line.evt, line.status, line.checkId]),
    [
      ["raft-check.pool.connect_failed", undefined, "a"],
      ["raft-check.browser.acquired", "reused", "a"],
      ["raft-check.browser.released", "kept", "a"],
    ],
  );

  const broken = fakeBrowser({}, { now: clock.now, newContextFails: new Error("session gone"), keep: true });
  assert.equal(await runLeasedCheck({ ...check, acquireBrowser: async () => broken.browser }, leaseFor()), "not_started");
  assert.deepEqual([broken.record.releases, broken.record.browserClosed], [[false], true], "a browser that failed is closed, never kept");
});

test("a dispatched check with no browser to be had: nothing posted, browser_unavailable (the lease runs out and Raft leases it again)", async () => {
  const raft = fakeRaft({ leases: [] });
  const { check, logger } = setup(raft, { launchFails: new Error("Unable to create new browser: code: 429") });
  assert.equal(await runLeasedCheck(check, leaseFor()), "browser_unavailable");
  assert.equal(results(raft).length, 0);
  assert.ok(events(logger.lines).some((line) => line.evt === "raft-check.browser.unavailable"));
});

test("a dispatched check whose browser fails before the ticket is opened: nothing posted, not_started, the browser closed", async () => {
  const clock = fakeClock();
  const broken = fakeBrowser({}, { now: clock.now, newContextFails: new Error("session gone") });
  const raft = fakeRaft({ leases: [] });
  const { check } = setup(raft, { browser: () => broken });
  assert.equal(await runLeasedCheck(check, leaseFor()), "not_started");
  assert.equal(results(raft).length, 0);
  assert.equal(broken.record.browserClosed, true);
});

test("a dispatched check's result refused as no longer current (409) is a conflict; a 401 refused", async () => {
  const raft = fakeRaft({ leases: [], results: [{ status: 409 }, { status: 401 }] });
  const { check, logger } = setup(raft);
  assert.equal(await runLeasedCheck(check, leaseFor({ checkId: "a" })), "conflict");
  assert.equal(await runLeasedCheck(check, leaseFor({ checkId: "b" })), "refused");
  assert.ok(events(logger.lines).some((line) => line.evt === "raft-check.result.conflict"));
});

// ---- the loopback route ---------------------------------------------------------------------

test("POST /run: only with the Worker's own token and a lease; then the check runs and answers its outcome", async () => {
  const clock = fakeClock();
  const { log } = recordingLogger();
  const raft = fakeRaft({ leases: [] });
  let launches = 0;
  const handler = createHandler({ acquireBrowser: async () => ((launches += 1), fakeBrowser({}, { now: clock.now }).browser), log, fetch: raft.fetch, now: clock.now, sleep: clock.sleep });
  const run = (authorization: string | null, body: string) =>
    handler.fetch(new Request("https://check.example/run", { method: "POST", headers: authorization === null ? {} : { authorization }, body }), ENV);
  const lease = JSON.stringify(leaseFor({ checkId: "a" }));

  assert.equal((await run(null, lease)).status, 401);
  assert.equal((await run("Bearer x".padEnd(48, "x"), lease)).status, 401);
  assert.equal((await run(WORKER_TOKEN, lease)).status, 401, "the bare token is no bearer");
  assert.equal((await run(`Bearer ${WORKER_TOKEN}`, "{")).status, 400);
  assert.equal((await run(`Bearer ${WORKER_TOKEN}`, JSON.stringify({ ...leaseFor(), url: "http://plain.example/" }))).status, 400, "not an https ticket");
  assert.equal(launches, 0, "no browser for any of those");
  assert.equal((await handler.fetch(new Request("https://check.example/run", { method: "POST", body: lease }), { ...ENV, ARTIFACTS_CHECK_WORKER_TOKEN: "" })).status, 503);

  const answered = await run(`Bearer ${WORKER_TOKEN}`, lease);
  assert.equal(answered.status, 200);
  assert.deepEqual(await answered.json(), { outcome: "recorded" });
  assert.equal(launches, 1);
  assert.deepEqual(results(raft).map((call) => call.url), [`${API_ORIGIN}/internal/artifacts-check/a/result`]);
});

test("a cron run with no loopback (ctx.exports.default) leases nothing and says it is misconfigured", async () => {
  const { log, lines } = recordingLogger();
  const raft = fakeRaft({ leases: [leaseFor()] });
  const handler = createHandler({ acquireBrowser: async () => fakeBrowser().browser, log, fetch: raft.fetch });
  const ctx = { waitUntil: () => {}, passThroughOnException: () => {}, props: {} } as unknown as ExecutionContext;
  await handler.scheduled(controller, ENV, ctx);
  assert.equal(raft.calls.length, 0);
  assert.deepEqual(events(lines).map((line) => line.evt), ["raft-check.misconfigured"]);
});

// ---- settings ---------------------------------------------------------------------------------

test("settings: an https origin, a token of at least 32 bytes, the browser binding", () => {
  const BROWSER = { fetch: async () => new Response(null) } as unknown as Fetcher;
  const good = { BROWSER, RAFT_API_ORIGIN: "https://api.example.com", ARTIFACTS_CHECK_WORKER_TOKEN: WORKER_TOKEN };
  assert.deepEqual(configOf(good), { ok: true, origin: "https://api.example.com", token: WORKER_TOKEN, browserPool: false });
  // The pool only on an exact "on": absent, "off", a typo or another case is off (no session shared).
  assert.equal((configOf({ ...good, CHECK_BROWSER_POOL: "on" }) as { browserPool: boolean }).browserPool, true);
  for (const value of [undefined, "off", "", "On", "yes", "true"]) {
    assert.equal((configOf({ ...good, CHECK_BROWSER_POOL: value }) as { browserPool: boolean }).browserPool, false, String(value));
  }
  const problems: Array<[Partial<CheckWorkerEnv>, RegExp]> = [
    [{ ...good, RAFT_API_ORIGIN: "" }, /RAFT_API_ORIGIN is not set/],
    [{ ...good, RAFT_API_ORIGIN: "http://api.example.com" }, /not an https origin/],
    [{ ...good, RAFT_API_ORIGIN: "https://api.example.com/" }, /not an https origin/],
    [{ ...good, RAFT_API_ORIGIN: "https://api.example.com/api" }, /not an https origin/],
    [{ ...good, ARTIFACTS_CHECK_WORKER_TOKEN: undefined }, /ARTIFACTS_CHECK_WORKER_TOKEN is not set/],
    [{ ...good, ARTIFACTS_CHECK_WORKER_TOKEN: "short" }, /shorter than 32 bytes/],
    [{ ...good, BROWSER: undefined }, /BROWSER binding is missing/],
  ];
  for (const [env, problem] of problems) {
    const config = configOf(env);
    assert.equal(config.ok, false);
    if (!config.ok) {
      assert.match(config.problem, problem);
      assert.equal(config.problem.includes(WORKER_TOKEN), false, "a problem never names a value");
    }
  }
});
