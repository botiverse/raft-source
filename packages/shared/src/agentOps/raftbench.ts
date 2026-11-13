import { raftbenchFindingsQuerySchema, type RaftbenchFindingsQuery, type RaftbenchFindingsResponse } from "../raftbenchContract";
// RaftBench (staging pilot): the read-only service agent's loop, for the
// hosted harness that runs it. The harness reads its assigned run's context,
// gives it to the model as input (the model has no tools), and submits the
// model's result in code.
//
// Not a model-facing operation (not in RAFT_OPERATIONS): the run is assigned
// by an event the harness consumes (`isRaftbenchRunAssigned`), and the result
// is submitted by the harness, so the model never builds a call (Sage, AX;
// Tenny: hosted only, no CLI).
//
// `submit` is a natural write: the Server keeps one result per run and
// revision and answers an identical replay with the same receipt, so the
// route client resends it after a lost response.

import type { AgentApiClient } from "../agentApiClient";
import {
  raftbenchModelReportSchema,
  raftbenchReportSchema,
  raftbenchRunAssignedSchema,
  type RaftbenchContextResponse,
  type RaftbenchReport,
  type RaftbenchRunAssigned,
  type RaftbenchSubmitResponse,
} from "../raftbenchContract";
import { formatUtcTimestamp } from "../utcTimestamp";
import { failureFromClientResult, validateOpRequest, type RaftFailure, type RaftOutcome } from "./outcome";

export type { RaftbenchContextResponse, RaftbenchReport, RaftbenchRunAssigned, RaftbenchSubmitResponse };

export type RaftbenchCoverage = RaftbenchContextResponse["coverage"];

/** Why a context read stopped (the Server's `coverage.stopReason`). */
export type RaftbenchStopReason = RaftbenchCoverage["stopReason"];

/**
 * True for the run-assignment payload (`kind: "raftbench_run_assigned"`,
 * `runId`, `revision`, `text`). It matches the payload only; for the
 * delivered event (a `system.raftbench` third-party event) use
 * `raftbenchRunAssignment(event)`.
 */
export function isRaftbenchRunAssigned(value: unknown): value is RaftbenchRunAssigned {
  return raftbenchRunAssignedSchema.safeParse(value).success;
}

/**
 * The run assignment carried by a delivered event, or null. Accepts the
 * message the Server delivers (assignment in `third_party_event.payload`), a
 * third-party event (`payload`) — either only when its `client_id` is
 * `system.raftbench` — or a bare payload you already took from such an event. Raft counts the
 * event as acknowledged once it is returned, so save the assignment before
 * doing anything else with it; never hand the event to the model.
 */
export function raftbenchRunAssignment(value: unknown): RaftbenchRunAssigned | null {
  if (value === null || typeof value !== "object") return null;
  const record = value as { client_id?: unknown; payload?: unknown; third_party_event?: { client_id?: unknown; payload?: unknown } | null };
  // An event must come from RaftBench itself: a payload that only looks like an
  // assignment, sent by any other app, is not one.
  const fromRaftbench = (event: { client_id?: unknown }) => event.client_id === RAFTBENCH_SYSTEM_APP;
  const candidates: unknown[] = [];
  if (record.third_party_event) {
    if (fromRaftbench(record.third_party_event)) candidates.push(record.third_party_event.payload);
  } else if ("payload" in record) {
    if (fromRaftbench(record)) candidates.push(record.payload);
  } else {
    candidates.push(value);
  }
  for (const candidate of candidates) {
    const parsed = raftbenchRunAssignedSchema.safeParse(candidate);
    if (parsed.success) return parsed.data;
  }
  return null;
}

/** The system app that delivers RaftBench run assignments (`third_party_event.client_id`). */
export const RAFTBENCH_SYSTEM_APP = "system.raftbench";

const STOP_REASON_TEXT: Record<"more_pages" | "message_limit" | "char_limit", string> = {
  more_pages: "more pages were not read",
  message_limit: "reading stopped at the message limit",
  char_limit: "reading stopped at the character limit",
};

/**
 * The Coverage block to put above the material, for one page or all the
 * pages read for a run. `fetchedMessages` is already a running total, so the
 * last page's value is the total; the window and whether it was read in full
 * are the last page's too. When the window was not read in full the block
 * says the result must be `incomplete` (the Server refuses `complete`), so
 * the model does not spend its one fix on it. What was not included is
 * listed one item per line, and the block says it does not count as free of
 * problems.
 */
export function formatRaftbenchCoverage(pages: RaftbenchCoverage | readonly RaftbenchCoverage[]): string {
  const list = Array.isArray(pages) ? pages : [pages as RaftbenchCoverage];
  const last = list[list.length - 1];
  if (!last) return "Coverage: nothing was read.";
  const window = `${formatUtcTimestamp(last.from)} to ${formatUtcTimestamp(last.to)}`;
  const count = `${last.fetchedMessages} ${last.fetchedMessages === 1 ? "message" : "messages"} read`;
  const reason: RaftbenchStopReason = last.stopReason;
  // `window_end` without `exhausted`: a later run of the window (earlier messages were covered
  // by a previous run); the Server's Not included line says why and that the result must be incomplete.
  // The "must be incomplete" instruction is said once, here, for every way of
  // not reading the whole window (Sage); the Server's notes only give reasons.
  const extent = last.exhausted
    ? "the whole window was read."
    : reason === "window_end"
      ? "NOT the whole window; see Not included below. Your result must have status incomplete."
      : `NOT the whole window: ${STOP_REASON_TEXT[reason]}. Your result must have status incomplete, with this as its reason.`;
  const lines = [`Coverage: ${window}; ${count}; ${extent}`];
  const notIncluded = [...new Set(list.flatMap((page) => page.notRead))];
  if (notIncluded.length > 0) lines.push("Not included:", ...notIncluded.map((item) => `- ${item}`));
  if (!last.exhausted || notIncluded.length > 0) lines.push("Anything not included is unknown, not free of problems.");
  return lines.join("\n");
}

/**
 * The `gaps` of a result, from the run's coverage (the harness sets them; the
 * model does not fill them in): always `missing_tool_outcomes` (tool outcomes
 * are never in the material); `budget` when reading stopped at the message or
 * character limit; `partial_scan` when the window was otherwise not read in
 * full or a chunk of it was skipped (`skippedChunks`, 0 when absent). Never `history_limit` or `inaccessible_source`: the Server gives no
 * fact for them (a refused source is a failure, see `raftbenchFailedReport`).
 */
export function raftbenchGapsFromCoverage(coverage: RaftbenchCoverage): RaftbenchReport["gaps"] {
  const gaps: RaftbenchReport["gaps"] = ["missing_tool_outcomes"];
  const atLimit = coverage.stopReason === "message_limit" || coverage.stopReason === "char_limit";
  if (atLimit) gaps.push("budget");
  // A skipped chunk is a partial scan on its own, whether or not this run also hit a limit.
  if ((coverage.skippedChunks ?? 0) > 0 || (!coverage.exhausted && !atLimit)) gaps.push("partial_scan");
  return gaps;
}

export interface ReadRaftbenchContextRequest {
  /** The assigned run (from the `raftbench_run_assigned` event); the Server's current run when omitted. */
  runId?: string;
  /** `nextCursor` from the previous page. */
  cursor?: string;
}

/** One page of the run's material. `last_page`: `nextCursor` is null. */
export async function readRaftbenchContext(
  client: Pick<AgentApiClient, "raftbench">,
  request: ReadRaftbenchContextRequest = {},
): Promise<RaftOutcome<RaftbenchContextResponse, "page" | "last_page">> {
  const result = await client.raftbench.context({
    ...(request.runId ? { runId: request.runId } : {}),
    ...(request.cursor ? { cursor: request.cursor } : {}),
  });
  if (!result.ok) return failureFromClientResult(result);
  return {
    ok: true,
    state: result.data.nextCursor ? "page" : "last_page",
    data: result.data,
    next: null,
    text: result.data.sourceText,
  };
}

export interface RaftbenchMaterial {
  runId: string;
  revision: number;
  /** The material for the model: the Coverage line, then every page's messages. */
  text: string;
  /** Message references the model may cite as evidence (target + messageId), across pages. */
  sources: RaftbenchContextResponse["sources"];
  coverage: RaftbenchCoverage;
  pages: number;
}

/**
 * Read every page of the run (up to `maxPages`) and put the Coverage line on
 * top. A failure on a later page returns that failure; the pages already read
 * are not lost from the Server's side (its coverage is recorded there), and
 * the harness submits `incomplete` with the reason.
 */
export async function readAllRaftbenchContext(
  client: Pick<AgentApiClient, "raftbench">,
  request: { runId?: string; maxPages?: number } = {},
): Promise<RaftOutcome<RaftbenchMaterial, "complete" | "partial" | "empty">> {
  const maxPages = Math.max(1, Math.min(request.maxPages ?? 50, 200));
  const pages: RaftbenchContextResponse[] = [];
  let cursor: string | undefined;
  do {
    const page = await readRaftbenchContext(client, { runId: request.runId ?? pages[0]?.runId, cursor });
    if (!page.ok) return page;
    pages.push(page.data);
    cursor = page.data.nextCursor ?? undefined;
  } while (cursor && pages.length < maxPages);
  const last = pages[pages.length - 1]!;
  const coverages = pages.map((page) => page.coverage);
  // Messages within a page are separated by a blank line; keep that across pages.
  const body = pages.map((page) => page.sourceText).filter((text) => text.length > 0).join("\n\n");
  return {
    ok: true,
    // Nothing read: there is nothing to analyse, so the harness does not call the model
    // (`raftbenchEmptyWindowReport`); "complete, 0 findings" would read as "all is well".
    state: last.coverage.fetchedMessages === 0 ? "empty" : last.coverage.exhausted && !cursor ? "complete" : "partial",
    data: {
      runId: last.runId,
      revision: last.revision,
      text: `${formatRaftbenchCoverage(coverages)}\n\n${body}`,
      sources: pages.flatMap((page) => page.sources),
      coverage: last.coverage,
      pages: pages.length,
    },
    next: null,
    text: `${formatRaftbenchCoverage(coverages)}\n\n${body}`,
  };
}

/** One problem with a result: which field, what is wrong, how to fix it. */
export interface RaftbenchValidationIssue {
  path: string;
  message: string;
  suggestedFix?: string;
}

export type RaftbenchSubmitted =
  | { kind: "accepted"; receipt: RaftbenchSubmitResponse }
  | { kind: "invalid"; issues: RaftbenchValidationIssue[] };

/** The Server ends each fix with "Nothing has been saved."; the list already says so once. */
function withoutSavedNotice(text: string): string {
  return text.replace(/\s*Nothing (?:has been|was) saved\.?\s*$/i, "").trim();
}

function issuesText(issues: readonly RaftbenchValidationIssue[]): string {
  return [
    "The result was not saved. Fix every item below in one go:",
    ...issues.map((issue) => {
      const fix = issue.suggestedFix ? withoutSavedNotice(issue.suggestedFix) : "";
      return `- ${issue.path || "result"}: ${withoutSavedNotice(issue.message)}${fix ? ` ${fix}` : ""}`;
    }),
    "Reply with the complete corrected result, not only the changes.",
  ].join("\n");
}

function serverIssues(failure: RaftFailure, response: unknown): RaftbenchValidationIssue[] | null {
  if (failure.error.serverCode !== "raftbench_validation_failed" || !response || typeof response !== "object") return null;
  const raw = (response as { issues?: unknown }).issues;
  if (!Array.isArray(raw)) return null;
  const issues: RaftbenchValidationIssue[] = [];
  for (const item of raw) {
    if (!item || typeof item !== "object") continue;
    const { path, message, suggestedFix } = item as Record<string, unknown>;
    if (typeof message !== "string") continue;
    issues.push({
      path: Array.isArray(path) ? path.join(".") : typeof path === "string" ? path : "",
      message,
      ...(typeof suggestedFix === "string" ? { suggestedFix } : {}),
    });
  }
  return issues.length > 0 ? issues : null;
}

/**
 * Submit the run's result. `accepted`: saved (an identical replay returns the
 * same receipt). `invalid`: nothing was saved; `data.issues` lists every
 * problem and `text` is the list to hand the model for its one fix (checked
 * locally first, then by the Server). What to do after a second `invalid` is
 * the harness's rule (submit `incomplete` with the issues as the reason), so
 * it is not in the text. Failures: see `raftbenchFailureKind`.
 */
const FAILED_REPORT = Symbol("raftbench.failedReport");

/**
 * The result for a run the harness could not finish (the read, the model or
 * the fix failed, or it was cancelled or timed out): `incomplete` with
 * `failure: true`, so the Server retries the same material (and skips it
 * after 3 failures) instead of treating it as analysed. Only an object made
 * here may carry `failure` — `submit` refuses it on anything else, so a model
 * cannot set it — so pass it to `submit` as is (not copied or via JSON).
 */
export function raftbenchFailedReport(run: { runId: string; revision: number }, reason: string, gaps: RaftbenchReport["gaps"] = []): RaftbenchReport {
  const report: RaftbenchReport = {
    runId: run.runId,
    revision: run.revision,
    status: "incomplete",
    failure: true,
    reason: reason.trim().slice(0, 1000) || "The run could not be completed.",
    patterns: [],
    gaps,
  };
  Object.defineProperty(report, FAILED_REPORT, { value: true, enumerable: false });
  return report;
}

function isFailedReport(report: unknown): boolean {
  return report !== null && typeof report === "object" && (report as { [FAILED_REPORT]?: true })[FAILED_REPORT] === true;
}

const FAILURE_FIELD_ISSUE: RaftbenchValidationIssue = { path: "failure", message: "Remove the field `failure`: it is not part of the result." };
const NOT_AN_OBJECT_ISSUE: RaftbenchValidationIssue = { path: "", message: "Your reply was not a JSON object. Reply with the complete result as one JSON object." };

/** Check a result locally: the harness's failure report against the API schema, anything else (the model's result) against the model schema, which has no `failure`. */
function localIssues(report: RaftbenchReport): { issues: RaftbenchValidationIssue[] } | { data: RaftbenchReport } {
  if (isFailedReport(report)) {
    const parsed = raftbenchReportSchema.safeParse(report);
    return parsed.success ? { data: parsed.data } : { issues: parsed.error.issues.map((issue) => ({ path: issue.path.join("."), message: issue.message })) };
  }
  if (report === null || typeof report !== "object" || Array.isArray(report)) return { issues: [NOT_AN_OBJECT_ISSUE] };
  const hasFailure = "failure" in report;
  const parsed = raftbenchModelReportSchema.safeParse(report);
  if (parsed.success && !hasFailure) return { data: parsed.data };
  const issues: RaftbenchValidationIssue[] = hasFailure ? [FAILURE_FIELD_ISSUE] : [];
  for (const issue of parsed.success ? [] : parsed.error.issues) {
    if (issue.code === "unrecognized_keys") {
      const others = issue.keys.filter((key) => key !== "failure");
      if (others.length === 0) continue;
      for (const key of others) issues.push({ path: [...issue.path, key].join("."), message: `Remove the field \`${key}\`: it is not part of the result.` });
      continue;
    }
    issues.push({ path: issue.path.join("."), message: actionableMessage(issue) });
  }
  return { issues };
}

type ZodIssueLike = { code: string; path: PropertyKey[]; message: string; expected?: string; values?: readonly unknown[]; minimum?: number | bigint; maximum?: number | bigint; inclusive?: boolean; origin?: string; format?: string; input?: unknown };

const KIND_OF: Record<string, string> = { string: "a text string", number: "a number", boolean: "true or false", array: "a list", object: "an object" };

/**
 * zod's default messages ("Invalid input", "Too small: expected …") are not
 * something a model can act on; say what to put there instead. Messages the
 * contract wrote itself (evidence, reason) are kept.
 */
function actionableMessage(issue: ZodIssueLike): string {
  const field = String(issue.path[issue.path.length - 1] ?? "");
  if (field === "runId" || field === "revision") return `Copy the ${field} given with the material exactly.`;
  switch (issue.code) {
    case "invalid_value":
      return issue.values?.length ? `Use one of: ${issue.values.map((value) => String(value)).join(", ")}.` : "Use one of the allowed values.";
    case "invalid_type": {
      const kind = KIND_OF[issue.expected ?? ""] ?? `a ${issue.expected ?? "valid value"}`;
      return /received undefined/.test(issue.message) ? `Add this field: ${kind}.` : `Use ${kind} here.`;
    }
    case "too_small": {
      // `inclusive` (the default for min) means "at least N"; exclusive (`positive()`) means "greater than N".
      const n = Number(issue.minimum) + (issue.inclusive === false ? 1 : 0);
      if (issue.origin === "array") return `Give at least ${n} ${n === 1 ? "item" : "items"}.`;
      if (issue.origin === "string") return n <= 1 ? "Do not leave this empty." : `Write at least ${n} characters.`;
      return issue.inclusive === false ? `Use a number greater than ${issue.minimum}.` : `Use a number of at least ${issue.minimum}.`;
    }
    case "too_big": {
      const n = Number(issue.maximum) - (issue.inclusive === false ? 1 : 0);
      if (issue.origin === "array") return `Give at most ${n} items.`;
      if (issue.origin === "string") return `Shorten this to at most ${n} characters.`;
      return issue.inclusive === false ? `Use a number less than ${issue.maximum}.` : `Use a number of at most ${issue.maximum}.`;
    }
    default:
      return /^(Invalid|Too (small|big)|Expected)\b/.test(issue.message) ? "This value is not valid here; check it against the result format." : issue.message;
  }
}

export async function submitRaftbenchReport(
  client: Pick<AgentApiClient, "raftbench">,
  report: RaftbenchReport,
): Promise<RaftOutcome<RaftbenchSubmitted, "accepted" | "invalid">> {
  const local = localIssues(report);
  if ("issues" in local) {
    return { ok: true, state: "invalid", data: { kind: "invalid", issues: local.issues }, next: null, text: issuesText(local.issues) };
  }
  const result = await client.raftbench.submit(local.data);
  if (!result.ok) {
    const failure = failureFromClientResult(result);
    const issues = serverIssues(failure, result.error.kind === "http" ? result.error.response : undefined);
    if (issues) return { ok: true, state: "invalid", data: { kind: "invalid", issues }, next: null, text: issuesText(issues) };
    return failure;
  }
  return {
    ok: true,
    state: "accepted",
    data: { kind: "accepted", receipt: result.data },
    next: null,
    text: `Result saved (${result.data.status}; receipt ${result.data.receiptId}).`,
  };
}

const REREAD_CODES = new Set([
  "raftbench_revision_conflict",
  "raftbench_cursor_stale",
  "raftbench_cursor_invalid",
  "raftbench_findings_changed", // findings reader: start again from the first page
]);
const STOP_CODES = new Set([
  // Findings reader: tell the person who asked; an administrator has to act.
  "raftbench_reader_not_authorized",
  "raftbench_findings_unavailable",
  "raftbench_source_unavailable",
  "raftbench_disabled",
  "raftbench_read_permission_revoked",
  "raftbench_access_revoked",
  "raftbench_server_not_allowed",
  "raftbench_hosted_required", // servers before the dedicated RaftBench service agent
  "raftbench_service_credential_required",
  "raftbench_run_not_owned",
  "raftbench_run_finished",
  "raftbench_submission_conflict",
  "raftbench_read_only",
]);

/**
 * What a failed read or submit means for the harness: `reread` (read the
 * context again from the first page, then redo the result), `stop` (end this
 * run; an administrator has to act, retrying will not help), `retry_identical`
 * (Raft could not confirm the request; repeat the same read or the identical
 * submission later — a submission may already have been accepted, and the
 * replay returns its receipt), or null (a bug in the request). For a
 * findings read (`raftbench.findings`): `reread` is the first page again,
 * `stop` is telling the person who asked.
 */
export function raftbenchFailureKind(failure: RaftFailure): "reread" | "stop" | "retry_identical" | null {
  const { code, status, serverCode } = failure.error;
  if (serverCode && REREAD_CODES.has(serverCode)) return "reread";
  if (serverCode && STOP_CODES.has(serverCode)) return "stop";
  if (serverCode === "raftbench_unavailable" || code === "TRANSPORT_ERROR" || (status !== undefined && status >= 500 && serverCode === undefined)) {
    return "retry_identical";
  }
  if (code === "CAPABILITY_NOT_AUTHORIZED" || code === "SCOPE_DENIED") return "stop";
  return null;
}

/** The reason an empty window's result gives. */
export const RAFTBENCH_EMPTY_WINDOW_REASON = "No messages were read in this window; nothing was analyzed.";

/**
 * The result for a run whose material has no messages (`readAll` state
 * `empty`): an ordinary `incomplete` (not a failure, so it does not count
 * towards the Server's 3-failure limit), no findings, gaps from coverage.
 * Submit it without calling the model.
 */
export function raftbenchEmptyWindowReport(material: { runId: string; revision: number; coverage: RaftbenchCoverage }): RaftbenchReport {
  return {
    runId: material.runId,
    revision: material.revision,
    status: "incomplete",
    reason: RAFTBENCH_EMPTY_WINDOW_REASON,
    patterns: [],
    gaps: raftbenchGapsFromCoverage(material.coverage),
  };
}

/** An `incomplete` result for a partial analysis within budget (no `failure`; see `raftbenchFailedReport` for a run that failed). */
export function raftbenchIncompleteReport(run: { runId: string; revision: number }, reason: string, gaps: RaftbenchReport["gaps"] = []): RaftbenchReport {
  return { runId: run.runId, revision: run.revision, status: "incomplete", reason: reason.trim().slice(0, 1000) || "The run could not be completed.", patterns: [], gaps };
}

export async function readRaftbenchFindings(client: Pick<AgentApiClient, "raftbench">, request: Partial<RaftbenchFindingsQuery> = {}): Promise<RaftOutcome<RaftbenchFindingsResponse, "page" | "last_page">> {
  const malformed = validateOpRequest(raftbenchFindingsQuerySchema, request); if (malformed) return malformed;
  const query = { ...request, limit: request.limit ?? 5 };
  const result = await client.raftbench.findings(query);
  if (!result.ok) return failureFromClientResult(result);
  const { nextCursor } = result.data;
  // The cursor is bound to these filters, so the next page repeats them.
  const nextArgs = nextCursor ? { ...query, cursor: nextCursor } : null;
  return {
    ok: true,
    state: nextArgs ? "page" : "last_page",
    data: result.data,
    next: nextArgs
      ? {
        kind: "next_findings_page",
        args: nextArgs,
        operation: { name: "raftbench.findings", args: nextArgs },
        why: "More findings match these filters; read the next page only if more examples would change the answer.",
      }
      : null,
    text: JSON.stringify(result.data),
  };
}
