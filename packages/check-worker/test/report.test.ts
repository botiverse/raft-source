import assert from "node:assert/strict";
import test from "node:test";

import {
  ARTIFACT_CHECK_MAX_BLOCKED_RESOURCES,
  ARTIFACT_CHECK_MAX_CONSOLE_ERRORS,
  ARTIFACT_CHECK_TEXT_MAX_CHARS,
  type ArtifactCheckReport,
} from "@botiverse/raft-shared/src/artifactCheckContract";

import { cutText, reportText, reportUrl, withoutTicket } from "../src/redact";
import { createFindings, errorClass, errorClassOf, fitReport, isRaftOwn } from "../src/report";
import { CONTENT_ORIGIN, TICKET, TICKET_URL } from "./fakes";

/**
 * A check's findings (src/report.ts) cut to the contract's caps, as the server cuts them
 * (checkTask.ts parseCheckReport), with the ticket taken out (src/redact.ts).
 */

const base = { checkId: "c", lease: "2026-11-04T10:02:00.000Z", load: { outcome: "ok" } as const };

test("console errors: the first ten are kept, each message and source cut to 300 characters, control characters as spaces", () => {
  const findings = createFindings(TICKET_URL);
  for (let index = 0; index < ARTIFACT_CHECK_MAX_CONSOLE_ERRORS + 5; index += 1) findings.consoleError(`error ${index}\n${"x".repeat(400)}`, `${CONTENT_ORIGIN}/app.js`, index);
  const { consoleErrors } = findings.report(base);
  assert.equal(consoleErrors.length, ARTIFACT_CHECK_MAX_CONSOLE_ERRORS);
  assert.equal(consoleErrors[0]!.message.startsWith("error 0 x"), true);
  assert.equal([...consoleErrors[0]!.message].length, ARTIFACT_CHECK_TEXT_MAX_CHARS);
  assert.equal(consoleErrors[9]!.message.startsWith("error 9 "), true);
  assert.deepEqual({ source: consoleErrors[3]!.source, line: consoleErrors[3]!.line }, { source: `${CONTENT_ORIGIN}/app.js`, line: 3 });
});

test("console errors: no source or a bad line is null; no line without its source (an inline script counts from its own first line, not the file's)", () => {
  const findings = createFindings(TICKET_URL);
  findings.consoleError("a", null, null);
  findings.consoleError("b", "", -1);
  findings.consoleError("c", null, 1.5);
  findings.consoleError("qa", null, 1);
  findings.consoleError("d", "", 4);
  assert.deepEqual(findings.report(base).consoleErrors, [
    { message: "a", source: null, line: null },
    { message: "b", source: null, line: null },
    { message: "c", source: null, line: null },
    { message: "qa", source: null, line: null },
    { message: "d", source: null, line: null },
  ]);
});

test("blocked resources: the first twenty distinct addresses, each as its origin and path", () => {
  const findings = createFindings(TICKET_URL);
  findings.blocked("https://cdn.example/lib.js?v=1");
  findings.blocked("https://cdn.example/lib.js?v=2");
  for (let index = 0; index < ARTIFACT_CHECK_MAX_BLOCKED_RESOURCES + 5; index += 1) findings.blocked(`https://cdn.example/${index}.js#frag`);
  const { blockedResources } = findings.report(base);
  assert.equal(blockedResources.length, ARTIFACT_CHECK_MAX_BLOCKED_RESOURCES);
  assert.equal(blockedResources[0], "https://cdn.example/lib.js");
  assert.equal(blockedResources[1], "https://cdn.example/0.js");
  assert.equal(new Set(blockedResources).size, blockedResources.length);
});

test("the ticket never reaches the report: not in a message, a source or a blocked address", () => {
  const findings = createFindings(TICKET_URL);
  // A CSP refusal the shell is named the source of (it inserted the page's script): kept, so its source is the ticket URL.
  findings.consoleError(`Refused to load the script '${TICKET_URL}' because it violates the following Content Security Policy directive: "script-src 'self'" (ticket=${encodeURIComponent(TICKET)}, ${TICKET})`, TICKET_URL, 1);
  findings.consoleError("x", `${CONTENT_ORIGIN}/__porthole/f/c2VhbGVkLXBhdGgtdmFsdWU/app.js`, 2);
  findings.consoleError(`Failed to load ${TICKET_URL}: the ticket ${TICKET} is used`, `${CONTENT_ORIGIN}/app.js?ticket=${TICKET}`, 3);
  findings.blocked(`${CONTENT_ORIGIN}/data.json?ticket=${TICKET}`);
  findings.blocked(`https://evil.example/collect?ticket=${TICKET}`);
  const report = findings.report(base);
  const text = JSON.stringify(report);
  assert.equal(text.includes(TICKET), false, text);
  assert.equal(text.includes(encodeURIComponent(TICKET)), false, text);
  assert.equal(text.includes("ticket=tkt1"), false, text);
  assert.equal(text.includes("c2VhbGVkLXBhdGgtdmFsdWU"), false, "a sealed files segment is collapsed");
  assert.equal(report.consoleErrors[0]!.source, `${CONTENT_ORIGIN}/_raft/open`);
  assert.equal(report.consoleErrors[2]!.source, `${CONTENT_ORIGIN}/app.js`);
  assert.deepEqual(report.blockedResources, [`${CONTENT_ORIGIN}/data.json`, "https://evil.example/collect"]);
});

test("Raft's own is left out: the shell's messages and exceptions, Raft's CSP warnings, Raft's addresses; the page's all kept", () => {
  const findings = createFindings(TICKET_URL);
  // Porthole's shell, answering the ticket at /_raft/open: Chromium's warning for Raft's CSP, and the shell's own error.
  findings.consoleError("Unrecognized Content-Security-Policy directive 'webrtc'.", TICKET_URL, null);
  findings.consoleError("TypeError: shell failed", `${CONTENT_ORIGIN}/_raft/open`, 40);
  // The same CSP on a frame of the page's own files: still Raft's policy.
  findings.consoleError("Unrecognized Content-Security-Policy directive 'webrtc'.", `${CONTENT_ORIGIN}/__porthole/f/c2VhbGVk/chart.html`, null);
  findings.blocked(`${CONTENT_ORIGIN}/_raft/open?ticket=${TICKET}`);
  // The page's own.
  findings.consoleError("Uncaught ReferenceError: chart is not defined", `${CONTENT_ORIGIN}/__porthole/f/c2VhbGVk/index.html`, 12);
  findings.consoleError("from a CDN", "https://cdn.example/lib.js", 3);
  findings.consoleError("Refused to load the script 'https://cdn.example/lib.js' because it violates the following Content Security Policy directive: \"script-src 'self'\".", `${CONTENT_ORIGIN}/_raft/open`, 1);
  findings.blocked("https://cdn.example/lib.js");
  findings.blocked(`${CONTENT_ORIGIN}/other.html`);
  const report = findings.report(base);
  assert.deepEqual(
    report.consoleErrors.map((each) => each.message),
    [
      "Uncaught ReferenceError: chart is not defined",
      "from a CDN",
      "Refused to load the script 'https://cdn.example/lib.js' because it violates the following Content Security Policy directive: \"script-src 'self'\".",
    ],
  );
  assert.deepEqual(report.blockedResources, ["https://cdn.example/lib.js", `${CONTENT_ORIGIN}/other.html`]);
});

test("isRaftOwn: the content origin's /_raft/ paths, and Raft's unknown CSP directive anywhere on that origin; nothing else", () => {
  assert.equal(isRaftOwn(CONTENT_ORIGIN, `${CONTENT_ORIGIN}/_raft/open?ticket=x`, "anything"), true);
  assert.equal(isRaftOwn(CONTENT_ORIGIN, `${CONTENT_ORIGIN}/_raft/open`), true, "a blocked Raft address");
  assert.equal(isRaftOwn(CONTENT_ORIGIN, `${CONTENT_ORIGIN}/_raft/open`, "Refused to connect to 'https://x.example/' because it violates the following Content Security Policy directive: \"connect-src 'none'\"."), false, "a CSP refusal is the page's");
  assert.equal(isRaftOwn(CONTENT_ORIGIN, `${CONTENT_ORIGIN}/__porthole/f/s/index.html`, "Unrecognized Content-Security-Policy directive 'webrtc'."), true);
  assert.equal(isRaftOwn(CONTENT_ORIGIN, `${CONTENT_ORIGIN}/__porthole/f/s/index.html`, "boom"), false);
  assert.equal(isRaftOwn(CONTENT_ORIGIN, `${CONTENT_ORIGIN}/_raftish/x.js`, "boom"), false);
  assert.equal(isRaftOwn(CONTENT_ORIGIN, `${CONTENT_ORIGIN}/app/_raft/x.js`, "boom"), false);
  assert.equal(isRaftOwn(CONTENT_ORIGIN, "https://other.example/_raft/open", "boom"), false, "another origin's /_raft/ is not Raft's");
  assert.equal(isRaftOwn(CONTENT_ORIGIN, "https://other.example/", "Unrecognized Content-Security-Policy directive 'x'."), false, "another origin's CSP is not Raft's");
  assert.equal(isRaftOwn(CONTENT_ORIGIN, null, "Unrecognized Content-Security-Policy directive 'webrtc'."), false, "no source: kept");
  assert.equal(isRaftOwn(null, `${CONTENT_ORIGIN}/_raft/open`, "boom"), false);
});

test("redaction helpers: text and addresses", () => {
  assert.equal(withoutTicket(`see ${TICKET_URL} now`, TICKET_URL), `see ${CONTENT_ORIGIN}/_raft/open now`);
  assert.equal(reportText("a\u0000b\u001fc", TICKET_URL), "a b c");
  assert.equal(cutText("\ud800lone"), "�lone");
  assert.equal(cutText("😀".repeat(400)).length, 2 * ARTIFACT_CHECK_TEXT_MAX_CHARS, "cut by code points, as the server cuts");
  assert.equal(reportUrl("data:text/html,<script>x</script>", TICKET_URL), "data:");
  assert.equal(reportUrl("blob:https://w.example/uuid", TICKET_URL), "blob:");
  assert.equal(reportUrl("not a url?ticket=abc", TICKET_URL), "not a url");
});

test("a report past 64 KiB loses blocked addresses, then console errors, from the end until it fits", () => {
  const big: ArtifactCheckReport = {
    ...base,
    consoleErrors: Array.from({ length: 10 }, (_, index) => ({ message: `${index}`.repeat(200), source: null, line: null })),
    blockedResources: Array.from({ length: 20 }, (_, index) => `https://cdn.example/${index}`.padEnd(200, "x")),
  };
  assert.deepEqual(fitReport(big), big, "within the cap: as it is");
  const fitted = fitReport(big, 2_000);
  assert.ok(new TextEncoder().encode(JSON.stringify(fitted)).length <= 2_000);
  assert.equal(fitted.blockedResources.length, 0);
  assert.ok(fitted.consoleErrors.length > 0 && fitted.consoleErrors.length < 10);
  assert.deepEqual(fitted.consoleErrors, big.consoleErrors.slice(0, fitted.consoleErrors.length), "the first ones kept");
});

test("blank and phoneOverflow are in the report only when given", () => {
  const findings = createFindings(TICKET_URL);
  assert.deepEqual(Object.keys(findings.report(base)).sort(), ["blockedResources", "checkId", "consoleErrors", "lease", "load"]);
  const report = findings.report({ ...base, blank: true, phoneOverflow: null });
  assert.equal(report.blank, true);
  assert.equal(report.phoneOverflow, null);
});

test("error classes come from an error's kind, never its words", () => {
  const timeout = Object.assign(new Error(`Navigation timeout of 25000 ms exceeded at ${TICKET_URL}`), { name: "TimeoutError" });
  assert.equal(errorClassOf(timeout, "x"), "timeout");
  assert.equal(errorClassOf(new Error(`net::ERR_NAME_NOT_RESOLVED at ${TICKET_URL}`), "navigation_failed"), "net.name_not_resolved");
  assert.equal(errorClassOf(new Error(`Protocol error: Target closed (${TICKET_URL})`), "navigation_failed"), "navigation_failed");
  assert.equal(errorClassOf("net::ERR_ABORTED", "x"), "net.aborted");
  assert.equal(errorClassOf(new Error("boom"), "Not A Class"), "other");
  assert.equal(errorClass("http_401"), "http_401");
  assert.equal(errorClass(`load:${TICKET_URL}`), "other");
  for (const value of ["timeout", "net.name_not_resolved", "navigation_failed", "http_401", "browser_context"]) assert.match(value, /^[a-z][a-z0-9_.-]{0,47}$/);
});
