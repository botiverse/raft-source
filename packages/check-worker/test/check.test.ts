import assert from "node:assert/strict";
import test from "node:test";

import { CHECK_TIMING, PHONE_USER_AGENT, runCheck, untilShellSettled } from "../src/check";
import { CONTENT_ORIGIN, fakeBrowser, fakeClock, leaseFor, recordingLogger, SPLIT_PNG, TICKET_URL, WHITE_PNG, type FakePageEvents } from "./fakes";

/**
 * One check (src/check.ts) against a fake browser: a fresh context per check, closed after;
 * the ticket opened once, top-level, at the first viewport, the others emulated in place;
 * the shots taken only after the page settled and the shell said it settled (Porthole P139) or,
 * where the word isn't there, SHELL_WORD_WAIT_MS after its first read; only the entry
 * shot; the findings. The puppeteer side (src/browser.ts) is the e2e plan's (README).
 */

const depsWith = (clock = fakeClock()) => ({ ...recordingLogger(), now: clock.now, sleep: clock.sleep, clock });

test("a check opens its ticket once, at desktop, then emulates the phone in place and shoots each viewport", async () => {
  const deps = depsWith();
  const { browser, record } = fakeBrowser({}, { now: deps.now });
  const run = await runCheck(browser, leaseFor(), deps);
  assert.equal(run.kind, "ran");
  assert.deepEqual(record.opens, [TICKET_URL]);
  const order = record.calls.map(({ call }) => call).filter((call) => call !== "idle" && call !== "shell");
  assert.deepEqual(order, ["emulate:desktop", "open", "measure:desktop", "screenshot:desktop", "emulate:phone", "measure:phone", "screenshot:phone"]);
  if (run.kind !== "ran") return;
  assert.deepEqual(Object.keys(run.shots).sort(), ["desktop", "phone"]);
  assert.deepEqual(run.report.load, { outcome: "ok" });
  assert.equal(run.report.blank, false);
  assert.equal(run.report.phoneOverflow, null);
  assert.equal(run.report.checkId, leaseFor().checkId);
  assert.equal(run.report.lease, leaseFor().lease);
});

test("the report says where the check's time went, stage by stage, in whole milliseconds; a stage never reached is 0", async () => {
  // The fake page takes no time of its own: the clock moves only for the check's own pauses, so
  // each stage is exactly its pauses, and the browser's time is what the runner measured.
  const deps = { ...depsWith(), browserMs: 1234.4 };
  const { browser } = fakeBrowser({}, { now: deps.now });
  const run = await runCheck(browser, leaseFor(), deps);
  assert.equal(run.kind, "ran");
  if (run.kind !== "ran") return;
  assert.deepEqual(run.report.timing, {
    browserMs: 1234,
    prepareMs: 0,
    loadMs: 0,
    // This page's shell never says its word: the wait for it, then the pause.
    settleMs: CHECK_TIMING.shellWordWaitMs + CHECK_TIMING.settleMs,
    shotsMs: CHECK_TIMING.resizeSettleMs,
  });

  // A page that never loaded: its report has the stages up to the load, and nothing after.
  const late = { ...depsWith(), browserMs: -5 };
  const failed = await runCheck(fakeBrowser({ open: { kind: "timeout" } }, { now: late.now }).browser, leaseFor(), late);
  assert.equal(failed.kind, "ran");
  if (failed.kind !== "ran") return;
  assert.deepEqual(failed.report.timing, { browserMs: 0, prepareMs: 0, loadMs: 0, settleMs: 0, shotsMs: 0 }, "no time below 0, no stage past the load");
});

test("condition (2): every check gets a fresh context of its own, closed after, whatever happened", async () => {
  const deps = depsWith();
  const { browser, record } = fakeBrowser((index) => (index === 1 ? { open: { kind: "timeout" } } : index === 2 ? { screenshot: () => new Error("boom") } : {}), { now: deps.now });
  for (let index = 0; index < 3; index += 1) await runCheck(browser, leaseFor(), deps);
  assert.equal(record.contexts, 3, "one context per check");
  assert.equal(record.pages, 3, "one page per context");
  assert.equal(record.closedContexts, 3, "each closed");
  assert.equal(record.browserClosed, false, "the browser is the run's (runner.ts releases it)");
});

test("condition (3): a page without the shell's word waits SHELL_WORD_WAIT_MS after the first read (no older shell's 10.5 s), then the network again", async () => {
  const deps = depsWith();
  const { browser, record } = fakeBrowser({}, { now: deps.now });
  await runCheck(browser, leaseFor(), deps);
  const at = (call: string) => record.calls.find((each) => each.call === call)!.at;
  assert.equal(at("screenshot:desktop") - at("open"), CHECK_TIMING.shellWordWaitMs + CHECK_TIMING.settleMs, "the short bound and the settle, nothing more");
  assert.ok(CHECK_TIMING.shellWordWaitMs <= 1_000, "a short safety bound, not an older shell's give-up");
  const idles = record.calls.filter((each) => each.call === "idle").map((each) => each.at);
  assert.ok(idles.some((when) => when < at("open") + CHECK_TIMING.shellWordWaitMs), "idle waited after load");
  assert.ok(idles.some((when) => when >= at("open") + CHECK_TIMING.shellWordWaitMs), "and again after the wait");
  assert.ok(at("screenshot:phone") - at("emulate:phone") >= CHECK_TIMING.resizeSettleMs, "the phone layout settles before its shot");
});

test("condition (3): the bound counts from the first read, not the navigation: a slow load gets every read, and no fixed time is added", async () => {
  const deps = depsWith();
  const { browser, record } = fakeBrowser({ duringOpen: () => deps.sleep(8_000) }, { now: deps.now });
  await runCheck(browser, leaseFor(), deps);
  const opened = record.calls.find((each) => each.call === "open")!.at;
  const reads = record.calls.filter((each) => each.call === "shell").map((each) => each.at - opened);
  assert.deepEqual(reads, Array.from({ length: CHECK_TIMING.shellWordWaitMs / CHECK_TIMING.shellPollMs + 1 }, (_, at) => 8_000 + at * CHECK_TIMING.shellPollMs));
  assert.equal(calledAt(record, "screenshot:desktop") - opened, 8_000 + CHECK_TIMING.shellWordWaitMs + CHECK_TIMING.settleMs);
});

const calledAt = (record: ReturnType<typeof fakeBrowser>["record"], call: string) => record.calls.find((each) => each.call === call)!.at;
const settledLine = (lines: string[]) => lines.map((line) => JSON.parse(line) as Record<string, unknown>).find((line) => line.evt === "raft-check.check.settled");

test("condition (3): a shell that says no host answers (Porthole P139) is shot once the network settles, with no fixed wait", async () => {
  const deps = depsWith();
  const { browser, record } = fakeBrowser({ shellHost: "none" }, { now: deps.now });
  const run = await runCheck(browser, leaseFor(), deps);
  assert.equal(run.kind, "ran");
  const shotAt = calledAt(record, "screenshot:desktop") - calledAt(record, "open");
  assert.ok(shotAt < CHECK_TIMING.shellWordWaitMs, "no wait for a word already said");
  assert.equal(shotAt, CHECK_TIMING.settleMs, "the settle alone (the fake network is idle at once)");
  // Read once, after the network went idle; that idle not waited for again. By order, not by the
  // fake clock: the phone's emulation comes at the desktop shot's very time.
  const calls = record.calls.map((each) => each.call);
  assert.deepEqual(calls.slice(0, calls.indexOf("screenshot:desktop") + 1), ["emulate:desktop", "open", "idle", "shell", "measure:desktop", "screenshot:desktop"]);
  assert.deepEqual(calls.slice(calls.indexOf("screenshot:desktop") + 1), ["emulate:phone", "idle", "measure:phone", "screenshot:phone"]);
  assert.deepEqual([settledLine(deps.lines)?.status, settledLine(deps.lines)?.elapsedMs], ["said", 0]);
  assert.ok(calledAt(record, "screenshot:phone") - calledAt(record, "emulate:phone") >= CHECK_TIMING.resizeSettleMs, "the phone still settles");
});

test("condition (3): a shell's word that comes late is waited for, read every shellPollMs, then the network again", async () => {
  const deps = depsWith();
  const { browser, record } = fakeBrowser({ shellHost: (since) => (since >= 500 ? "none" : null) }, { now: deps.now });
  await runCheck(browser, leaseFor(), deps);
  const opened = calledAt(record, "open");
  const reads = record.calls.filter((each) => each.call === "shell").map((each) => each.at - opened);
  assert.deepEqual(reads, Array.from({ length: 500 / CHECK_TIMING.shellPollMs + 1 }, (_, at) => at * CHECK_TIMING.shellPollMs));
  assert.equal(settledLine(deps.lines)?.status, "said_late");
  // The calls before the desktop shot, by order (not by the fake clock's time).
  const beforeShot = record.calls.slice(0, record.calls.findIndex((each) => each.call === "screenshot:desktop"));
  const idles = beforeShot.filter((each) => each.call === "idle").map((each) => each.at - opened);
  assert.deepEqual(idles, [0, 500], "idle after load, and again after the word");
  assert.equal(calledAt(record, "screenshot:desktop") - opened, 500 + CHECK_TIMING.settleMs);
});

test("condition (3): no word (taken off the root), a word that isn't the shell's, or a read that fails: SHELL_WORD_WAIT_MS, never longer", async () => {
  for (const shellHost of [null, "yes", "", () => { throw new Error(`evaluate failed at ${TICKET_URL}`); }] as const) {
    const deps = depsWith();
    const { browser, record } = fakeBrowser({ shellHost }, { now: deps.now });
    await runCheck(browser, leaseFor(), deps);
    const opened = calledAt(record, "open");
    const reads = record.calls.filter((each) => each.call === "shell");
    assert.equal(reads.at(-1)!.at - opened, CHECK_TIMING.shellWordWaitMs, String(shellHost));
    assert.equal(reads.length, Math.ceil(CHECK_TIMING.shellWordWaitMs / CHECK_TIMING.shellPollMs) + 1);
    assert.equal(calledAt(record, "screenshot:desktop") - opened, CHECK_TIMING.shellWordWaitMs + CHECK_TIMING.settleMs);
    assert.equal(settledLine(deps.lines)?.status, "unsaid");
    assert.ok(!deps.lines.join("\n").includes(TICKET_URL), "a read's error is never logged");
  }
});

test("untilShellSettled: a wait whose bound has passed reads once; a read that hangs is given until the wait's end", async () => {
  const clock = fakeClock();
  const reads: number[] = [];
  const said = await untilShellSettled({ shellHost: async () => (reads.push(clock.now()), null) }, clock.now() - CHECK_TIMING.shellWordWaitMs - 1, CHECK_TIMING, clock);
  assert.deepEqual([said, reads.length], ["unsaid", 1]);
  // A read that never answers: it loses to a real timer of max(shellPollMs, what is left), here a few ms.
  const timing = { ...CHECK_TIMING, shellWordWaitMs: 30, shellPollMs: 5 };
  const started = Date.now();
  const hung = await untilShellSettled({ shellHost: () => new Promise<string | null>(() => {}) }, clock.now(), timing, clock);
  assert.equal(hung, "unsaid");
  assert.ok(Date.now() - started < 1_000, "no read waits past the fixed wait");
});

test("condition (2): a top-level navigation off the entry is refused and reported as blocked; only the entry page is shot", async () => {
  const deps = depsWith();
  const { browser, record } = fakeBrowser(
    {
      duringOpen: (page) => {
        page.request({ url: "https://evil.example/steal?x=1", isNavigation: true, isMainFrame: true, redirectedFrom: null });
        page.request({ url: `${CONTENT_ORIGIN}/other.html`, isNavigation: true, isMainFrame: true, redirectedFrom: null });
        page.request({ url: "https://cdn.example/lib.js", isNavigation: false, isMainFrame: true, redirectedFrom: null });
      },
    },
    { now: deps.now },
  );
  const run = await runCheck(browser, leaseFor(), deps);
  assert.deepEqual(record.decisions, [
    { url: TICKET_URL, allowed: true },
    { url: "https://evil.example/steal?x=1", allowed: false },
    { url: `${CONTENT_ORIGIN}/other.html`, allowed: false },
    { url: "https://cdn.example/lib.js", allowed: true },
  ]);
  assert.equal(run.kind, "ran");
  if (run.kind !== "ran") return;
  assert.deepEqual(run.report.blockedResources, ["https://evil.example/steal", `${CONTENT_ORIGIN}/other.html`]);
  assert.deepEqual(record.opens, [TICKET_URL], "one navigation, the entry");
});

test("console errors, uncaught exceptions and failed resources go in the report", async () => {
  const deps = depsWith();
  const { browser } = fakeBrowser(
    {
      duringOpen: (page) => {
        page.consoleError("Uncaught TypeError: x is not a function", `${CONTENT_ORIGIN}/app.js`, 12);
        page.pageError("TypeError: y is undefined");
        page.blocked("https://fonts.example/font.woff2");
      },
    },
    { now: deps.now },
  );
  const run = await runCheck(browser, leaseFor(), deps);
  assert.equal(run.kind, "ran");
  if (run.kind !== "ran") return;
  assert.deepEqual(run.report.consoleErrors, [
    { message: "Uncaught TypeError: x is not a function", source: `${CONTENT_ORIGIN}/app.js`, line: 12 },
    { message: "TypeError: y is undefined", source: null, line: null },
  ]);
  assert.deepEqual(run.report.blockedResources, ["https://fonts.example/font.woff2"]);
});

/** What Porthole's shell says on every check's tab, answering the ticket at /_raft/open: Chromium's warning for Raft's CSP (Porthole ADOPTING.md §8). */
const shellSays = (page: FakePageEvents) => page.consoleError("Unrecognized Content-Security-Policy directive 'webrtc'.", TICKET_URL, null);
/** The page's own files, where the shell moved the address before the page's scripts ran. */
const PAGE_URL = `${CONTENT_ORIGIN}/__porthole/f/c2VhbGVkLXBhdGgtdmFsdWU/index.html`;

test("findings are the page's: a page with no errors has none, though the shell logged Raft's webrtc CSP warning", async () => {
  const deps = depsWith();
  const { browser } = fakeBrowser({ duringOpen: shellSays }, { now: deps.now });
  const run = await runCheck(browser, leaseFor(), deps);
  assert.equal(run.kind, "ran");
  if (run.kind !== "ran") return;
  assert.deepEqual(run.report.consoleErrors, []);
  assert.deepEqual(run.report.blockedResources, []);
});

test("findings are the page's: an error and an exception of the page itself are reported; the shell's own exception isn't", async () => {
  const deps = depsWith();
  const { browser } = fakeBrowser(
    {
      duringOpen: (page) => {
        shellSays(page);
        page.pageError("TypeError: the shell's own", `${CONTENT_ORIGIN}/_raft/open`, 30);
        page.consoleError("could not draw the chart", PAGE_URL, 7);
        page.pageError("ReferenceError: chart is not defined", PAGE_URL, 9);
      },
    },
    { now: deps.now },
  );
  const run = await runCheck(browser, leaseFor(), deps);
  assert.equal(run.kind, "ran");
  if (run.kind !== "ran") return;
  assert.deepEqual(run.report.consoleErrors, [
    { message: "could not draw the chart", source: `${CONTENT_ORIGIN}/__porthole/f/…/index.html`, line: 7 },
    { message: "ReferenceError: chart is not defined", source: `${CONTENT_ORIGIN}/__porthole/f/…/index.html`, line: 9 },
  ]);
});

test("findings are the page's: a resource the page asked for and the CSP refused is still reported, though the shell inserted it", async () => {
  const deps = depsWith();
  const { browser } = fakeBrowser(
    {
      duringOpen: (page) => {
        shellSays(page);
        // The shell re-creates the page's <script src>, so Chromium names the shell's address as the refusal's source.
        page.consoleError(
          "Refused to load the script 'https://cdn.example/chart.js' because it violates the following Content Security Policy directive: \"script-src 'self' 'unsafe-inline' 'unsafe-eval'\".",
          TICKET_URL,
          1,
        );
        page.blocked("https://cdn.example/chart.js");
      },
    },
    { now: deps.now },
  );
  const run = await runCheck(browser, leaseFor(), deps);
  assert.equal(run.kind, "ran");
  if (run.kind !== "ran") return;
  assert.deepEqual(run.report.blockedResources, ["https://cdn.example/chart.js"]);
  assert.equal(run.report.consoleErrors.length, 1);
  assert.match(run.report.consoleErrors[0]!.message, /^Refused to load the script 'https:\/\/cdn\.example\/chart\.js'/);
});

test("a load that timed out, failed, or answered an error page has no screenshot and says so", async () => {
  const cases = [
    [{ kind: "timeout" }, { outcome: "timeout" }],
    [{ kind: "error", errorClass: "net.name_not_resolved" }, { outcome: "error", errorClass: "net.name_not_resolved" }],
    [{ kind: "error", errorClass: "Not:A Class" }, { outcome: "error", errorClass: "other" }],
    [{ kind: "loaded", status: 401 }, { outcome: "error", errorClass: "http_401" }],
  ] as const;
  for (const [open, load] of cases) {
    const deps = depsWith();
    const { browser, record } = fakeBrowser({ open }, { now: deps.now });
    const run = await runCheck(browser, leaseFor(), deps);
    assert.equal(run.kind, "ran");
    if (run.kind !== "ran") continue;
    assert.deepEqual(run.report.load, load);
    assert.deepEqual(run.shots, {});
    assert.equal(record.calls.some((each) => each.call.startsWith("screenshot")), false);
    assert.equal(record.closedContexts, 1);
  }
});

test("blank: no text and a uniform desktop shot; text means not blank", async () => {
  const blankDeps = depsWith();
  const blank = fakeBrowser({ measure: (viewport) => ({ textLength: 0, scrollWidth: viewport.width, innerWidth: viewport.width }), screenshot: () => WHITE_PNG }, { now: blankDeps.now });
  const blankRun = await runCheck(blank.browser, leaseFor(), blankDeps);
  assert.equal(blankRun.kind === "ran" && blankRun.report.blank, true);

  const pictureDeps = depsWith();
  const picture = fakeBrowser({ measure: (viewport) => ({ textLength: 0, scrollWidth: viewport.width, innerWidth: viewport.width }), screenshot: () => SPLIT_PNG }, { now: pictureDeps.now });
  const pictureRun = await runCheck(picture.browser, leaseFor(), pictureDeps);
  assert.equal(pictureRun.kind === "ran" && pictureRun.report.blank, false);
});

test("phone overflow: measured at the mobile viewport only", async () => {
  const deps = depsWith();
  const { browser } = fakeBrowser({ measure: (viewport) => ({ textLength: 5, scrollWidth: viewport.mobile ? 1024 : 2000, innerWidth: viewport.width }) }, { now: deps.now });
  const run = await runCheck(browser, leaseFor(), deps);
  assert.equal(run.kind, "ran");
  if (run.kind !== "ran") return;
  assert.deepEqual(run.report.phoneOverflow, { contentWidth: 1024, viewportWidth: 390 });
});

test("a screenshot that fails, or isn't a PNG, is left out; the check still reports", async () => {
  const deps = depsWith();
  const { browser } = fakeBrowser({ screenshot: (viewport) => (viewport.mobile ? new Error(`shot failed at ${TICKET_URL}`) : new TextEncoder().encode("jpeg?")) }, { now: deps.now });
  const run = await runCheck(browser, leaseFor(), deps);
  assert.equal(run.kind, "ran");
  if (run.kind !== "ran") return;
  assert.deepEqual(run.shots, {});
  assert.deepEqual(run.report.load, { outcome: "ok" });
  assert.ok(deps.lines.some((line) => line.includes("raft-check.shot.failed")));
});

test("a phone viewport that can't be emulated is skipped; the desktop shot stays", async () => {
  const deps = depsWith();
  const { browser } = fakeBrowser({ emulateFails: true }, { now: deps.now });
  const run = await runCheck(browser, leaseFor(), deps);
  assert.equal(run.kind, "ran");
  if (run.kind !== "ran") return;
  assert.deepEqual(Object.keys(run.shots), ["desktop"]);
  assert.equal(run.report.phoneOverflow, undefined);
});

test("a browser that fails before the ticket is opened: not started (the lease runs out, Raft leases it again)", async () => {
  const contextFails = fakeBrowser({}, { newContextFails: new Error("session closed") });
  assert.deepEqual(await runCheck(contextFails.browser, leaseFor(), depsWith()), { kind: "not_started", errorClass: "browser_context" });
  const pageFails = fakeBrowser({}, { newPageFails: new Error("target closed") });
  assert.deepEqual(await runCheck(pageFails.browser, leaseFor(), depsWith()), { kind: "not_started", errorClass: "browser_page" });
  assert.equal(pageFails.record.closedContexts, 1, "the context is closed all the same");
  assert.deepEqual(pageFails.record.opens, []);
});

test("the phone is emulated with a mobile user agent; the desktop keeps the browser's", async () => {
  const deps = depsWith();
  const { browser, record } = fakeBrowser({}, { now: deps.now });
  await runCheck(browser, leaseFor(), deps);
  assert.deepEqual(record.userAgents, [null, PHONE_USER_AGENT]);
  assert.match(PHONE_USER_AGENT, /Mobile/);
});
