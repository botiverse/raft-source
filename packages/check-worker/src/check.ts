// One publish check (task #proj-workspace:#130): open the lease's ticket URL top-level, once,
// in a fresh context of its own, let the page settle, shoot each of the lease's viewports,
// and collect what the page did. The context is closed after, whatever happened.
//
// The isolation conditions (README), here:
// - (2) a fresh context per check (`browser.newContext()`, incognito: no cookies), closed in
//   `finally`; the ticket URL is handed to the page and to nothing else: logs carry the
//   check's ids and codes (log.ts), the report has the ticket taken out (redact.ts); every
//   top-level navigation but the entry is refused (navigation.ts) and reported as blocked;
//   only the entry page is shot.
// - (3) the shell's top-level mode: on a tab Porthole's shell finds no host and draws the
//   page itself, and says so at once (Porthole P139): it asks no host there, and the document's
//   root carries `data-porthole-host="none"` before the page's own scripts run. Every content
//   server serves a P139 shell now (production's content Worker since v1.21.62, Porthole
//   0.14.18), so the shots wait for the document's `load`, the network to go idle, the shell's
//   word (there at the first read on every page that leaves it), and a short settle. Where the
//   word isn't there (the page took it off the root, or the read failed), SHELL_WORD_WAIT_MS
//   more, then the network once more: no older shell, which said nothing and gave up on a host
//   only after 40 × 250 ms, is served any more, so nothing is gained by waiting that out
//   (task #proj-workspace:#232).
//
// The ticket opens once, so the page loads once, at the first viewport (desktop), and the
// others are emulated in place, without a reload (browser.ts emulate): a page laid out by CSS
// (media queries, the viewport meta) is shot as a phone shows it; one that reads the user
// agent only while it loads keeps what it read at desktop width.
//
// The findings are the page's own: what Raft's shell and its CSP say on the tab (the content
// origin's `/_raft/` paths, Chromium's unknown-directive warning for `webrtc`) is left out
// (report.ts isRaftOwn).
import { ARTIFACT_CHECK_TIMING_MAX_MS } from "@botiverse/raft-shared/src/artifactCheckContract";
import type { ArtifactCheckLease, ArtifactCheckLoad, ArtifactCheckReport, ArtifactCheckTiming } from "@botiverse/raft-shared/src/artifactCheckContract";

import type { CheckBrowser, CheckContext, CheckPage } from "./checkPage";
import type { Logger, LogFields } from "./log";
import { createNavigationGuard } from "./navigation";
import { isBlank, phoneOverflowOf, type PageMeasure } from "./pageChecks";
import { isPng, uniformShare } from "./png";
import type { CheckShot } from "./raftClient";
import { createFindings, errorClass, errorClassOf } from "./report";

export interface CheckTiming {
  /** From the navigation's start to the document's `load` (else the load is `timeout`). */
  loadTimeoutMs: number;
  /** The network counts as idle after this long with no request. */
  idleMs: number;
  /** The most any one wait for the idle network takes. */
  idleTimeoutMs: number;
  /**
   * The most the wait for the shell's word takes, from its first read (after `load` and an idle
   * network): where the word isn't there, the shots are taken no later than this after it.
   */
  shellWordWaitMs: number;
  /** How often the shell's word is read while it hasn't said it. */
  shellPollMs: number;
  /** A last pause before the first shot. */
  settleMs: number;
  /** After a viewport change, before its shot. */
  resizeSettleMs: number;
  /** The most any other browser step (emulate, measure, screenshot) takes. */
  stepTimeoutMs: number;
}

/**
 * A P139 shell writes its word as its script runs, before the page's own scripts and so before
 * `load`: the first read, after `load` and an idle network, finds it on any page that leaves it.
 * Where it doesn't, the page took it off the root or the read failed; no shell that answers later
 * is served. So a short bound, not the 10.5 s an older shell's 40 × 250 ms `ui/initialize` took:
 * four more reads, `shellPollMs` apart, for a read that failed once, and no more. An `unsaid`
 * check still waits for the network again before its shots.
 */
export const SHELL_WORD_WAIT_MS = 1_000;

/** What a shell says once its handshake ended (Porthole P139: `data-porthole-host`). */
export const SHELL_SETTLED_WORDS: readonly string[] = ["none", "answered"];

export const CHECK_TIMING: CheckTiming = {
  loadTimeoutMs: 25_000,
  idleMs: 500,
  idleTimeoutMs: 5_000,
  shellWordWaitMs: SHELL_WORD_WAIT_MS,
  shellPollMs: 250,
  settleMs: 500,
  resizeSettleMs: 750,
  stepTimeoutMs: 10_000,
};

/** The phone viewport's user agent (Chromium on Android: the engine the shot is taken with). */
export const PHONE_USER_AGENT = "Mozilla/5.0 (Linux; Android 14; Pixel 8) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Mobile Safari/537.36";

export interface CheckDeps {
  now: () => number;
  sleep: (ms: number) => Promise<void>;
  log: Logger;
  timing?: CheckTiming;
  /** How long getting the browser took (runner.ts), for the report's timing; 0 when not told. */
  browserMs?: number;
}

export type CheckRun =
  /** The page was opened (or its opening failed): the report to send, and the shots taken. */
  | { kind: "ran"; report: ArtifactCheckReport; shots: Partial<Record<CheckShot, Uint8Array>> }
  /** The browser failed before the ticket was opened: nothing to report, the lease runs out and Raft leases the check again. */
  | { kind: "not_started"; errorClass: string };

class StepTimeout extends Error {
  override name = "TimeoutError";
}

/**
 * `promise`, or a TimeoutError after `ms` (a real timer, cleared once it settles). A step that
 * loses the race and rejects later is caught here: an unhandled rejection would be logged by the
 * runtime with its message, which for a browser names the URL.
 */
async function withTimeout<T>(promise: Promise<T>, ms: number): Promise<T> {
  promise.catch(() => {});
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([promise, new Promise<never>((_, reject) => (timer = setTimeout(() => reject(new StepTimeout()), ms)))]);
  } finally {
    clearTimeout(timer);
  }
}

const idsOf = (lease: ArtifactCheckLease): LogFields => ({ checkId: lease.checkId, artifactId: lease.artifactId, versionId: lease.versionId });

/**
 * How the shell settled: `said` (its word was there at the first look), `said_late` (it came
 * while waited for), `unsaid` (none by `shellWordWaitMs` from `started`, the wait's start: a page
 * that took the word away, or reads that failed). Never waits past that, but for a read already
 * started, which is given until then (or one poll, once it has passed).
 */
export async function untilShellSettled(page: Pick<CheckPage, "shellHost">, started: number, timing: CheckTiming, deps: Pick<CheckDeps, "now" | "sleep">): Promise<"said" | "said_late" | "unsaid"> {
  const deadline = started + timing.shellWordWaitMs;
  for (let first = true; ; first = false) {
    let word: string | null = null;
    try {
      word = await withTimeout(page.shellHost(), Math.min(timing.stepTimeoutMs, Math.max(timing.shellPollMs, deadline - deps.now())));
    } catch {
      word = null;
    }
    if (word !== null && SHELL_SETTLED_WORDS.includes(word)) return first ? "said" : "said_late";
    const left = deadline - deps.now();
    if (left <= 0) return "unsaid";
    await deps.sleep(Math.min(timing.shellPollMs, left));
  }
}

/** A stage's time as the report carries it: whole milliseconds, none below 0 and none past the contract's most. */
const wholeMs = (ms: number): number => (Number.isFinite(ms) ? Math.min(ARTIFACT_CHECK_TIMING_MAX_MS, Math.max(0, Math.round(ms))) : 0);

export async function runCheck(browser: CheckBrowser, lease: ArtifactCheckLease, deps: CheckDeps): Promise<CheckRun> {
  const timing = deps.timing ?? CHECK_TIMING;
  const ids = idsOf(lease);
  // Where the check's time goes, for its report (ArtifactCheckTiming): each stage's end is marked
  // as it is reached, and a stage never reached stays 0.
  const began = deps.now();
  const spent: ArtifactCheckTiming = { browserMs: wholeMs(deps.browserMs ?? 0), prepareMs: 0, loadMs: 0, settleMs: 0, shotsMs: 0 };
  const [first, ...others] = lease.viewports;
  if (first === undefined) return { kind: "not_started", errorClass: "no_viewport" };
  const findings = createFindings(lease.url);
  const guard = createNavigationGuard(lease.url);

  let context: CheckContext;
  try {
    context = await withTimeout(browser.newContext(), timing.stepTimeoutMs);
  } catch (error) {
    return { kind: "not_started", errorClass: errorClassOf(error, "browser_context") };
  }
  try {
    let page: CheckPage;
    try {
      page = await withTimeout(context.newPage(), timing.stepTimeoutMs);
      page.onConsoleError((message, source, line) => findings.consoleError(message, source, line));
      page.onPageError((message, source, line) => findings.consoleError(message, source, line));
      page.onBlocked((url) => findings.blocked(url));
      await withTimeout(
        page.guardRequests((request) => {
          const decision = guard(request);
          if (!decision.allow) {
            findings.blocked(request.url);
            deps.log("info", "navigation.refused", { ...ids, errorClass: decision.reason });
          }
          return decision.allow;
        }),
        timing.stepTimeoutMs,
      );
      await withTimeout(page.emulate(first, first.mobile ? PHONE_USER_AGENT : null), timing.stepTimeoutMs);
    } catch (error) {
      return { kind: "not_started", errorClass: errorClassOf(error, "browser_page") };
    }

    const report = (load: ArtifactCheckLoad, extra: Pick<ArtifactCheckReport, "blank" | "phoneOverflow"> = {}) =>
      findings.report({ checkId: lease.checkId, lease: lease.lease, load, ...extra, timing: { ...spent } });

    const started = deps.now();
    spent.prepareMs = wholeMs(started - began);
    const opened = await page.open(lease.url, timing.loadTimeoutMs);
    spent.loadMs = wholeMs(deps.now() - started);
    if (opened.kind === "timeout") return { kind: "ran", report: report({ outcome: "timeout" }), shots: {} };
    if (opened.kind === "error") return { kind: "ran", report: report({ outcome: "error", errorClass: errorClass(opened.errorClass) }), shots: {} };
    // Porthole's denial page (a used or expired ticket, a check no longer running) is no render of the version.
    if (opened.status !== null && opened.status >= 400) return { kind: "ran", report: report({ outcome: "error", errorClass: `http_${opened.status}` }), shots: {} };
    deps.log("info", "check.loaded", { ...ids, elapsedMs: deps.now() - started });

    // Settle (condition 3): idle; the shell's word, or SHELL_WORD_WAIT_MS without it; idle again
    // unless the shell had said it before the first idle ended; a pause.
    await page.networkIdle(timing.idleMs, timing.idleTimeoutMs);
    const shell = await untilShellSettled(page, deps.now(), timing, deps);
    deps.log("info", "check.settled", { ...ids, status: shell, elapsedMs: deps.now() - started });
    if (shell !== "said") await page.networkIdle(timing.idleMs, timing.idleTimeoutMs);
    await deps.sleep(timing.settleMs);
    const settled = deps.now();
    spent.settleMs = wholeMs(settled - started - spent.loadMs);

    const shots: Partial<Record<CheckShot, Uint8Array>> = {};
    let blank: boolean | undefined;
    let phoneOverflow: ArtifactCheckReport["phoneOverflow"] | undefined;
    for (const viewport of [first, ...others]) {
      if (viewport !== first) {
        try {
          await withTimeout(page.emulate(viewport, viewport.mobile ? PHONE_USER_AGENT : null), timing.stepTimeoutMs);
        } catch (error) {
          deps.log("warn", "viewport.failed", { ...ids, errorClass: errorClassOf(error, "emulate") });
          continue;
        }
        await deps.sleep(timing.resizeSettleMs);
        await page.networkIdle(timing.idleMs, timing.idleTimeoutMs);
      }
      let measure: PageMeasure | null = null;
      try {
        measure = await withTimeout(page.measure(), timing.stepTimeoutMs);
      } catch (error) {
        deps.log("warn", "measure.failed", { ...ids, errorClass: errorClassOf(error, "measure") });
      }
      let shot: Uint8Array | null = null;
      try {
        shot = await withTimeout(page.screenshot(), timing.stepTimeoutMs);
      } catch (error) {
        deps.log("warn", "shot.failed", { ...ids, errorClass: errorClassOf(error, "screenshot") });
      }
      if (shot !== null && isPng(shot)) shots[viewport.shot] = shot;
      if (viewport === first && measure !== null) {
        blank = isBlank(measure.textLength, measure.textLength === 0 && shot !== null ? await uniformShare(shot) : null);
      }
      if (viewport.mobile && measure !== null) phoneOverflow = phoneOverflowOf(measure);
    }
    spent.shotsMs = wholeMs(deps.now() - settled);
    return { kind: "ran", report: report({ outcome: "ok" }, { blank, phoneOverflow }), shots };
  } finally {
    await withTimeout(context.close(), timing.stepTimeoutMs).catch((error: unknown) => {
      deps.log("warn", "context.close_failed", { ...ids, errorClass: errorClassOf(error, "context_close") });
    });
  }
}
