// The check Worker's two kinds of invocation (task #proj-workspace:#185):
//
// - runChecks, the cron run (every minute): the dispatcher. It leases checks from Raft and hands
//   each, at once, to an invocation of its own (`dispatch`: handler.ts posts the lease to the
//   Worker itself through its loopback, `ctx.exports.default`, `POST /run`), so checks run in
//   parallel, each with a browser session of its own while it runs: one invocation has room for
//   only six simultaneous connections, so a browser per check in one invocation would not scale. It opens no browser
//   itself. While a lease comes back it asks again at once; a 204 (nothing to run) doesn't end
//   the run: it asks again every IDLE_POLL_MS while the run is within RUN_BUDGET_MS, so a check
//   pushed mid-minute starts within seconds rather than at the next cron (the Worker has no
//   host Raft could wake it through, by design). One pushed after the run's last ask (~57 s)
//   waits for the next cron, ~3 s. Bounds: at most MAX_IN_FLIGHT checks in flight a run
//   (the ceiling Browser Rendering's launch rate sets, well under its 200 concurrent browsers an
//   account; at the cap the run waits for one to end before it leases again), and dispatches LAUNCH_SPACING_MS apart
//   (each takes a free session or launches one at once; Browser Rendering launches at most 3 new
//   browsers a second, and a dispatch launches at most one).
//   The run ends after every check it dispatched has answered. Any lease answer that isn't a
//   lease or a 204 ends the leasing; so does a check that answers `refused` (a 401 on its
//   result) or `browser_unavailable` (Browser Rendering at a limit, or down: leasing more would
//   only spend their attempts). An idle minute costs a lease call every IDLE_POLL_MS and no
//   browser.
// - runLeasedCheck, one dispatched invocation: one lease, one browser session for it (a free one
//   another check left running, else launched: pool.ts), a fresh incognito context inside
//   (check.ts), the check, the session released (left running for the next check, or closed:
//   pool.ts) before its result is posted. Its outcome is the invocation's answer to the
//   dispatcher.
//
// What is retried, and how:
// - a result met by 5xx, 429 or a network error: again within the lease (raftClient.ts);
// - a browser that can't be had, or fails before the ticket is opened, or a dispatch that
//   failed: nothing is posted and the lease runs out (2 minutes); Raft leases the check again,
//   within its run window (at most five attempts, checkTask.ts);
// - a 401 (the token is wrong, or mid-rotation): the leasing ends; the check's lease runs out the
//   same way. See the README's "Token rotation".
import type { ArtifactCheckLease } from "@botiverse/raft-shared/src/artifactCheckContract";

import { runCheck, type CheckTiming } from "./check";
import type { CheckBrowser } from "./checkPage";
import type { LogFields, Logger } from "./log";
import { postResultWithRetry, requestLease, type RaftApi } from "./raftClient";
import { errorClassOf } from "./report";

/**
 * No check is leased once a run is this old (the cron fires every minute; the run then waits for
 * its checks). Nearly the whole minute, so one run's last ask and the next run's first are
 * IDLE_POLL_MS apart like any two asks: at 45 s a check pushed in the last 18 s of a minute
 * waited for the next cron (measured on staging 2026-11-11: 4 of 21 checks, 9 to 17 s each).
 */
export const RUN_BUDGET_MS = 58_000;
/**
 * How long a run waits after a 204 before asking again: a check pushed while a run is asking
 * waits at most this; one pushed after the run's last ask waits for the next cron (~3 s).
 */
export const IDLE_POLL_MS = 3_000;
/**
 * At most this many checks in flight a run, each its own invocation and browser: the steady-state
 * ceiling the launch rate sets (Browser Rendering launches at most 3 new browsers a second and a
 * check takes ~13–15 s, so ~40 run at once; more in flight adds no throughput), far below its
 * 200 concurrent browsers an account (billed on the month's average). Two runs never lease at
 * once (a run leases in its first RUN_BUDGET_MS of the minute), but the earlier one's last
 * checks are still running through the next, so up to 80 open.
 */
export const MAX_IN_FLIGHT = 40;
/** Dispatches at least this far apart: each starts a browser at once, and Browser Rendering launches at most 3 a second. */
export const LAUNCH_SPACING_MS = 350;

/** How a dispatched check ended (its invocation's answer, `POST /run`). */
export const CHECK_OUTCOMES = ["recorded", "conflict", "refused", "unavailable", "rejected", "browser_unavailable", "not_started", "failed"] as const;
export type CheckOutcome = (typeof CHECK_OUTCOMES)[number];

/** What a dispatch answers: the check's outcome, or that the invocation couldn't be had or answered something else (status 0: no answer). */
export type DispatchAnswer = { kind: "ran"; outcome: CheckOutcome } | { kind: "failed"; status: number };

export interface LeasedCheckDeps {
  api: RaftApi;
  /** A session for the check (pool.ts), `note` for the pool's own lines. Throws when none can be had. */
  acquireBrowser: (note: (event: string, fields: LogFields) => void) => Promise<CheckBrowser>;
  now: () => number;
  sleep: (ms: number) => Promise<void>;
  log: Logger;
  timing?: CheckTiming;
}

export interface RunDeps {
  api: RaftApi;
  /** Hands a lease to an invocation of its own and answers how its check ended. Never throws (a throw counts as `failed`, status 0). */
  dispatch: (lease: ArtifactCheckLease) => Promise<DispatchAnswer>;
  now: () => number;
  sleep: (ms: number) => Promise<void>;
  log: Logger;
  budgetMs?: number;
  idlePollMs?: number;
  maxInFlight?: number;
  launchSpacingMs?: number;
}

export interface RunSummary {
  /** Checks leased (and dispatched) this run. */
  leased: number;
  /** Results Raft recorded (done or failed). */
  recorded: number;
  /** Why the leasing ended. */
  ended: "idle" | "budget" | "refused" | "unavailable" | "invalid_lease" | "browser";
}

const idsOf = ({ checkId, artifactId, versionId }: ArtifactCheckLease) => ({ checkId, artifactId, versionId });

export async function runChecks(deps: RunDeps): Promise<RunSummary> {
  const budgetMs = deps.budgetMs ?? RUN_BUDGET_MS;
  const idlePollMs = deps.idlePollMs ?? IDLE_POLL_MS;
  const maxInFlight = Math.max(1, deps.maxInFlight ?? MAX_IN_FLIGHT);
  const spacingMs = deps.launchSpacingMs ?? LAUNCH_SPACING_MS;
  const started = deps.now();
  const summary: RunSummary = { leased: 0, recorded: 0, ended: "idle" };
  const inFlight = new Set<Promise<void>>();
  // Set by a check's answer that ends the leasing.
  let stop: RunSummary["ended"] | null = null;
  let lastDispatch: number | null = null;
  let lastWasNone = false;

  /** Dispatches `lease` and reads its answer; never rejects. */
  const handOff = async (lease: ArtifactCheckLease): Promise<void> => {
    let answer: DispatchAnswer;
    try {
      answer = await deps.dispatch(lease);
    } catch {
      answer = { kind: "failed", status: 0 };
    }
    if (answer.kind === "failed") {
      // The invocation never answered an outcome: nothing was posted that we know of; the lease runs out.
      deps.log("error", "dispatch.failed", { ...idsOf(lease), status: answer.status });
      return;
    }
    if (answer.outcome === "recorded") summary.recorded += 1;
    if (answer.outcome === "refused") stop ??= "refused";
    if (answer.outcome === "browser_unavailable") stop ??= "browser";
  };

  try {
    for (;;) {
      if (stop !== null) {
        summary.ended = stop;
        break;
      }
      if (inFlight.size >= maxInFlight) {
        // At the cap: wait for a check to end (each promise removes itself), then look again.
        await Promise.race(inFlight);
        continue;
      }
      // Launches spread out: each dispatch starts a browser at once.
      if (lastDispatch !== null) {
        const wait = lastDispatch + spacingMs - deps.now();
        if (wait > 0) await deps.sleep(wait);
      }
      if (deps.now() - started >= budgetMs) {
        // Out of time; "idle" when the last answer was a 204 (an idle run ends this way too).
        summary.ended = lastWasNone ? "idle" : "budget";
        break;
      }
      const answer = await requestLease(deps.api);
      if (answer.kind === "none") {
        lastWasNone = true;
        // Nothing yet: wait and ask again while the run has time (never without a finite budget).
        if (!Number.isFinite(budgetMs) || deps.now() - started + idlePollMs >= budgetMs) {
          summary.ended = "idle";
          break;
        }
        await deps.sleep(idlePollMs);
        continue;
      }
      lastWasNone = false;
      if (answer.kind !== "leased") {
        const level = answer.kind === "unavailable" ? "warn" : "error";
        deps.log(level, `lease.${answer.kind}`, { status: answer.status });
        summary.ended = answer.kind === "invalid" ? "invalid_lease" : answer.kind;
        break;
      }
      const { lease } = answer;
      summary.leased += 1;
      deps.log("info", "check.leased", idsOf(lease));
      lastDispatch = deps.now();
      const running: Promise<void> = handOff(lease).finally(() => inFlight.delete(running));
      inFlight.add(running);
    }
    // Every check dispatched answers before the run ends: the dispatches are this invocation's subrequests.
    await Promise.all(inFlight);
    if (stop !== null) summary.ended = stop;
    return summary;
  } finally {
    deps.log("info", "run.ended", { status: summary.ended, count: summary.leased, elapsedMs: deps.now() - started });
  }
}

/**
 * One dispatched check (its own invocation): a browser session for it (pool.ts), the check, the
 * session released (kept for the next check or closed) once the check is done with it, its result
 * posted. Never throws: an unexpected failure is `failed`, logged as its class only.
 */
export async function runLeasedCheck(deps: LeasedCheckDeps, lease: ArtifactCheckLease): Promise<CheckOutcome> {
  const ids = idsOf(lease);
  const asked = deps.now();
  let browser: CheckBrowser;
  try {
    browser = await deps.acquireBrowser((event, fields) => deps.log("info", event, { ...ids, ...fields }));
  } catch (error) {
    deps.log("error", "browser.unavailable", { ...ids, errorClass: errorClassOf(error, "browser_launch") });
    return "browser_unavailable";
  }
  const browserMs = deps.now() - asked;
  deps.log("info", "browser.acquired", { ...ids, status: browser.origin, elapsedMs: browserMs });
  let released = false;
  /** The session back to the pool or closed, once; never throws. */
  const release = async (healthy: boolean) => {
    if (released) return;
    released = true;
    try {
      deps.log("info", "browser.released", { ...ids, status: await browser.release(healthy) });
    } catch (error) {
      deps.log("warn", "browser.close_failed", { ...ids, errorClass: errorClassOf(error, "browser_close") });
    }
  };
  try {
    let run: Awaited<ReturnType<typeof runCheck>>;
    try {
      run = await runCheck(browser, lease, { now: deps.now, sleep: deps.sleep, log: deps.log, timing: deps.timing, browserMs });
    } catch (error) {
      // Not expected (runCheck answers outcomes); kept to its class, nothing posted.
      deps.log("error", "check.failed", { ...ids, errorClass: errorClassOf(error, "check_failed") });
      return "failed";
    }
    // The browser is done with before the result goes (its tries may take seconds): a session
    // kept is free for the next check at once, and one closed stops billing.
    await release(run.kind === "ran");
    if (run.kind === "not_started") {
      deps.log("error", "check.not_started", { ...ids, errorClass: run.errorClass });
      return "not_started";
    }
    const result = await postResultWithRetry(deps.api, lease, run.report, run.shots, deps);
    const fields = { ...ids, load: run.report.load.outcome, count: Object.keys(run.shots).length };
    switch (result.kind) {
      case "recorded":
        deps.log("info", "check.recorded", { ...fields, status: result.status });
        return "recorded";
      case "conflict":
        deps.log("warn", "result.conflict", fields);
        return "conflict";
      case "refused":
      case "unavailable":
      case "rejected":
        deps.log("error", `result.${result.kind}`, { ...fields, status: result.status });
        return result.kind;
    }
  } catch (error) {
    deps.log("error", "check.failed", { ...ids, errorClass: errorClassOf(error, "check_failed") });
    return "failed";
  } finally {
    // An unexpected failure: closed, never kept.
    await release(false);
  }
}
