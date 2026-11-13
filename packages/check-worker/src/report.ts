// What a check saw, collected while the page runs and cut to the contract's caps
// (shared artifactCheckContract.ts): the first ARTIFACT_CHECK_MAX_CONSOLE_ERRORS console
// errors and ARTIFACT_CHECK_MAX_BLOCKED_RESOURCES blocked addresses are kept, each string
// cut to ARTIFACT_CHECK_TEXT_MAX_CHARS, the ticket taken out of every one (redact.ts). The
// server cuts again (checkTask.ts parseCheckReport); cutting here keeps the report small and
// the ticket on this side.
//
// The findings are the agent's page's alone: what is Raft's own on the tab (Porthole's shell
// and its CSP) is left out (`isRaftOwn`), so an agent reading them fixes its page, never Raft.
import {
  ARTIFACT_CHECK_MAX_BLOCKED_RESOURCES,
  ARTIFACT_CHECK_MAX_CONSOLE_ERRORS,
  ARTIFACT_CHECK_REPORT_MAX_BYTES,
  type ArtifactCheckLoad,
  type ArtifactCheckReport,
  type ArtifactCheckTiming,
} from "@botiverse/raft-shared/src/artifactCheckContract";

import { reportText, reportUrl } from "./redact";

export type ConsoleError = ArtifactCheckReport["consoleErrors"][number];

/** A check's findings while its page runs; `report` makes the contract's report of them. */
export interface Findings {
  consoleError(message: string, source: string | null, line: number | null): void;
  blocked(url: string): void;
  report(fields: { checkId: string; lease: string; load: ArtifactCheckLoad; blank?: boolean; phoneOverflow?: ArtifactCheckReport["phoneOverflow"]; timing?: ArtifactCheckTiming }): ArtifactCheckReport;
}

/** Chromium's console warning for a CSP directive it doesn't know (Raft's `webrtc`). */
const UNRECOGNIZED_CSP_DIRECTIVE = /^Unrecognized Content-Security-Policy directive\b/;
/** Chromium's console error for a CSP refusal ("Refused to load the script '…' because it violates …"). */
const CSP_REFUSAL = /^Refused to [\s\S]*Content Security Policy/;

/**
 * Whether something seen on the tab is Raft's own, not the agent's page's, and so left out of the
 * findings: they report the page only, and an agent reading them would try to "fix" what isn't
 * its. `source` is where a console message or exception came from, or a blocked resource's own
 * address; `message` a console message's or exception's text (null for a blocked resource).
 *
 * - The content origin's `/_raft/` paths are Raft's: Porthole's shell answers the ticket at
 *   `/_raft/open` and its own inline script runs there (as does the door). The shell moves the
 *   address to the version's files (`history.replaceState`) before any of the page's scripts run,
 *   so the page's own messages and exceptions carry its files' address, never a `/_raft/` one.
 *   A CSP refusal is kept all the same: the shell inserts the page's scripts and elements, so
 *   Chromium can name the shell as the source of a refusal of the page's own resource.
 * - Chromium's "Unrecognized Content-Security-Policy directive" from any address of the content
 *   origin: Raft sends every policy there (Porthole's), and Chromium doesn't
 *   know `webrtc`, which closes WebRTC where an engine does; Porthole's runtime guard closes it in
 *   Chromium (Porthole ADOPTING.md §8). Logged for every frame, and nothing the page can fix. A
 *   page may add a policy of its own (`<meta http-equiv="Content-Security-Policy">`); a mistyped
 *   directive there is left out too: only a warning, and it changes nothing the page does.
 */
export function isRaftOwn(contentOrigin: string | null, source: string | null, message: string | null = null): boolean {
  if (contentOrigin === null || source === null || !URL.canParse(source)) return false;
  const url = new URL(source);
  if (url.origin !== contentOrigin) return false;
  if (message !== null && UNRECOGNIZED_CSP_DIRECTIVE.test(message)) return true;
  return url.pathname.startsWith("/_raft/") && !(message !== null && CSP_REFUSAL.test(message));
}

/** The content origin the ticket opens on (an https origin), else null. */
function contentOriginOf(ticketUrl: string): string | null {
  if (!URL.canParse(ticketUrl)) return null;
  const url = new URL(ticketUrl);
  return url.protocol === "https:" ? url.origin : null;
}

export function createFindings(ticketUrl: string): Findings {
  const contentOrigin = contentOriginOf(ticketUrl);
  const consoleErrors: ConsoleError[] = [];
  const blocked = new Set<string>();
  return {
    consoleError(message, source, line) {
      if (isRaftOwn(contentOrigin, source, message)) return;
      if (consoleErrors.length >= ARTIFACT_CHECK_MAX_CONSOLE_ERRORS) return;
      consoleErrors.push({
        message: reportText(message, ticketUrl),
        source: source === null || source === "" ? null : reportUrl(source, ticketUrl),
        // A line only with the file it is in: an inline script's (the shell inserts the page's
        // scripts) counts from that script's own first line, not the file's, so it would point
        // the agent at the wrong place.
        line: source !== null && source !== "" && line !== null && Number.isSafeInteger(line) && line >= 0 ? line : null,
      });
    },
    blocked(url) {
      if (isRaftOwn(contentOrigin, url)) return;
      if (blocked.size >= ARTIFACT_CHECK_MAX_BLOCKED_RESOURCES) return;
      blocked.add(reportUrl(url, ticketUrl));
    },
    report({ checkId, lease, load, blank, phoneOverflow, timing }) {
      const report: ArtifactCheckReport = { checkId, lease, load, consoleErrors: [...consoleErrors], blockedResources: [...blocked] };
      if (blank !== undefined) report.blank = blank;
      if (phoneOverflow !== undefined) report.phoneOverflow = phoneOverflow;
      if (timing !== undefined) report.timing = timing;
      return fitReport(report);
    },
  };
}

const encoder = new TextEncoder();
const reportBytes = (report: ArtifactCheckReport) => encoder.encode(JSON.stringify(report)).length;

/** `report` within ARTIFACT_CHECK_REPORT_MAX_BYTES: blocked addresses, then console errors, dropped from the end until it fits (the caps make this rare). */
export function fitReport(report: ArtifactCheckReport, maxBytes = ARTIFACT_CHECK_REPORT_MAX_BYTES): ArtifactCheckReport {
  const fitted: ArtifactCheckReport = { ...report, consoleErrors: [...report.consoleErrors], blockedResources: [...report.blockedResources] };
  while (reportBytes(fitted) > maxBytes && (fitted.blockedResources.length > 0 || fitted.consoleErrors.length > 0)) {
    if (fitted.blockedResources.length > 0) fitted.blockedResources.pop();
    else fitted.consoleErrors.pop();
  }
  return fitted;
}

/** The contract's error class, as the server keeps it (checkTask.ts ERROR_CLASS). */
const ERROR_CLASS = /^[a-z][a-z0-9_.-]{0,47}$/;

/**
 * A code-shaped class for something that went wrong, from its kind alone,
 * never its message's words (a browser's message names the URL it failed
 * on): a Chromium `net::ERR_*` code as `net.<code>`, a puppeteer
 * TimeoutError as `timeout`, else `fallback`.
 */
export function errorClassOf(error: unknown, fallback: string): string {
  const name = error instanceof Error ? error.name : "";
  if (name === "TimeoutError") return "timeout";
  const message = error instanceof Error ? error.message : typeof error === "string" ? error : "";
  const net = /\bnet::ERR_([A-Z0-9_]{1,40})\b/.exec(message)?.[1];
  if (net) return `net.${net.toLowerCase()}`;
  return ERROR_CLASS.test(fallback) ? fallback : "other";
}

/** `value` if it is a class the server keeps, else `other`. */
export function errorClass(value: string): string {
  return ERROR_CLASS.test(value) ? value : "other";
}
