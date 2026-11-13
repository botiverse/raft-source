// #35 step 1: after Hands files a product feedback ticket, one first-party app
// notice (`system.feedback`) goes into the inbox of the configured triage
// agent (PRODUCT_FEEDBACK_TRIAGE_AGENT_ID, an agent id on this deployment).
// No task, no channel post, no agent credential: the event rides the system
// app path every Raft system app uses (systemAppAgentEvents.ts, RFC 081), and
// its inbox row is `app:system.feedback/feedback/<reporter hash>`, so one
// person's submissions merge into one unread row until the agent reads it
// (coalesceWakeIntoUnreadItem).
//
// The notice carries NO user text: never the feedback message, the contact or
// attachments. Only the client, the reporter's server name, the Hands ticket
// id, a Lens link, the submission time and, for an agent Report Issue, its
// feedback_report_id.
//
// Best effort: started after the Hands receipt and never awaited by the
// submission; every failure ends in the trace event
// `server.product_feedback.triage_notice` (outcome sent | disabled | failed,
// a fixed error_code), never in the user's answer.

import { and, eq, isNull, sql } from "drizzle-orm";
import { currentDate } from "@botiverse/raft-shared";
import { getDb } from "../db/index";
import { agents, servers, thirdPartyAgentEvents } from "../db/schema";
import { UUID_RE } from "../lib/messageId";
import { traceIdentityHash } from "../tracing/traceIdentity";
import { recordTraceEvent } from "../tracing/semanticTrace";
import type { ProductFeedbackReceipt, ProductFeedbackSubmission } from "./productFeedbackService";
import {
  createSystemAppAgentEvent,
  deliverSystemAppAgentEvent,
  type SystemAppAgentEventDeliverer,
} from "./systemAppAgentEvents";

export const PRODUCT_FEEDBACK_TRIAGE_AGENT_ID_ENV = "PRODUCT_FEEDBACK_TRIAGE_AGENT_ID";
export const PRODUCT_FEEDBACK_TRIAGE_SYSTEM_APP = "system.feedback" as const;
export const PRODUCT_FEEDBACK_TRIAGE_NOTICE_EVENT = "server.product_feedback.triage_notice";
export const DEFAULT_LENS_BASE_URL = "https://lens.botiverse.workers.dev";
// Lens UI (botiverse/lens ui/src/App.tsx): a report page is `/f/<reportId>`,
// the list is `/feedback`. Lens has no UI page per Hands ticket, so a
// submission without a report id links the list (the ticket id is in the
// notice; agents resolve it with Lens' get_feedback_by_ticket).
export const LENS_FEEDBACK_REPORT_PATH = "/f/";
export const LENS_FEEDBACK_LIST_PATH = "/feedback";
// Inbox app events live 7 days (inboxItemsLaunch.ts).
const TRIAGE_NOTICE_TTL_MS = 7 * 24 * 60 * 60_000;
const SERVER_NAME_MAX_CHARS = 80;
// A Hands ticket id as it may appear in the notice and its dedupe key.
const TICKET_ID_RE = /^[A-Za-z0-9][A-Za-z0-9_.:-]{0,127}$/;

export type ProductFeedbackTriageOutcome = "sent" | "disabled" | "failed";
export type ProductFeedbackTriageErrorCode =
  | "not_configured"
  | "agent_id_invalid"
  | "agent_not_found"
  | "invalid_ticket"
  | "duplicate_ticket"
  | "lookup_failed"
  | "insert_failed"
  | "deliver_failed";

class TriageNoticeStepError extends Error {
  constructor(readonly code: ProductFeedbackTriageErrorCode, cause: unknown) {
    super(code, { cause });
  }
}

let deliverer: SystemAppAgentEventDeliverer | null = null;
const inFlight = new Set<Promise<void>>();

/**
 * The orchestrator that pushes the notice (server.ts). Without one the event
 * is still written, queued, and the inbox push sweep / `/events` pull hands it over.
 */
export function setProductFeedbackTriageNoticeDeliverer(next: SystemAppAgentEventDeliverer | null): void {
  deliverer = next;
}

/** The configured triage agent id: null when unset, "invalid" when it is not a uuid. */
function configuredTriageAgentId(env: NodeJS.ProcessEnv): string | "invalid" | null {
  const raw = env[PRODUCT_FEEDBACK_TRIAGE_AGENT_ID_ENV]?.trim();
  if (!raw) return null;
  return UUID_RE.test(raw) ? raw : "invalid";
}

/** The one startup line: said only when the setting is present but not an agent id. */
export function logProductFeedbackTriageNoticeConfig(env: NodeJS.ProcessEnv = process.env): void {
  if (configuredTriageAgentId(env) === "invalid") {
    console.warn(`[product-feedback] ${PRODUCT_FEEDBACK_TRIAGE_AGENT_ID_ENV} is not an agent id; triage notices are off`);
  }
}

function lensBaseUrl(env: NodeJS.ProcessEnv): string {
  return (env.LENS_BASE_URL?.trim() || DEFAULT_LENS_BASE_URL).replace(/\/+$/, "");
}

export function productFeedbackLensUrl(feedbackReportId: string | null, env: NodeJS.ProcessEnv = process.env): string {
  return feedbackReportId
    ? `${lensBaseUrl(env)}${LENS_FEEDBACK_REPORT_PATH}${encodeURIComponent(feedbackReportId)}`
    : `${lensBaseUrl(env)}${LENS_FEEDBACK_LIST_PATH}`;
}

/** The client it came from: web, desktop (the web client in Raft Desktop), ios, android or harmony. */
function clientLabel(submission: ProductFeedbackSubmission): string {
  const { clientKind, clientVersion } = submission.metadata;
  if (clientKind === "ohos") return "harmony";
  if (clientKind === "web" && clientVersion?.startsWith("Raft Desktop")) return "desktop";
  return clientKind;
}

/** Where in the client: the agent Report Issue dialog, an agent's feedback card, or the feedback form. */
function surfaceLabel(submission: ProductFeedbackSubmission): string | null {
  if (submission.fromAgentFeedbackCard) return "agent feedback card";
  if (submission.feedbackReportId) return "agent report";
  return null;
}

/** The inbox object ref: one row per reporter (keyed hash, never the user id). Null without a key: the app's fallback row. */
export function productFeedbackTriageObjectRef(userId: string): string | null {
  const hash = traceIdentityHash("feedback_reporter_hash", userId);
  return hash ? `feedback/${hash}` : null;
}

// C0/C1 controls, bidi overrides and isolates, zero-width characters and the BOM.
const UNSAFE_TEXT_RE = /[\u0000-\u001f\u007f-\u009f\u200b-\u200f\u202a-\u202e\u2066-\u2069\ufeff]+/g;

/**
 * The reporter's server name, which its owner chose: one line, no controls or
 * invisible direction marks, at most 80 characters, then quoted, so it reads
 * as a value inside the agent's prompt and never as a line of its own.
 */
export function quotedServerName(name: string): string {
  const flat = name.replace(UNSAFE_TEXT_RE, " ").replace(/\s+/g, " ").trim();
  const chars = [...flat];
  const bounded = chars.length > SERVER_NAME_MAX_CHARS ? `${chars.slice(0, SERVER_NAME_MAX_CHARS - 1).join("")}…` : flat;
  return JSON.stringify(bounded);
}

export function buildProductFeedbackTriageNoticeText(input: {
  source: string;
  serverName: string | null;
  ticketId: string;
  lensUrl: string;
  submittedAt: Date;
  feedbackReportId: string | null;
}): string {
  return [
    "反馈提交自动通知 / Auto notice from a feedback submission",
    `source: ${input.source}`,
    `server: ${input.serverName ?? "(unknown)"}`,
    `ticket: ${input.ticketId}`,
    `lens: ${input.lensUrl}`,
    `submitted_at: ${input.submittedAt.toISOString()}`,
    ...(input.feedbackReportId ? [`feedback_report_id: ${input.feedbackReportId}`] : []),
  ].join("\n");
}

async function step<T>(code: ProductFeedbackTriageErrorCode, work: () => Promise<T>): Promise<T> {
  try {
    return await work();
  } catch (error) {
    throw new TriageNoticeStepError(code, error);
  }
}

async function sendTriageNotice(
  submission: ProductFeedbackSubmission,
  receipt: ProductFeedbackReceipt,
  env: NodeJS.ProcessEnv,
  submittedAt: Date,
): Promise<{ outcome: ProductFeedbackTriageOutcome; errorCode: ProductFeedbackTriageErrorCode | null }> {
  const agentId = configuredTriageAgentId(env);
  if (agentId === null) return { outcome: "disabled", errorCode: "not_configured" };
  if (agentId === "invalid") return { outcome: "disabled", errorCode: "agent_id_invalid" };
  if (!TICKET_ID_RE.test(receipt.id)) return { outcome: "failed", errorCode: "invalid_ticket" };

  const reporterServerId = submission.metadata.reporterAttribution?.server_id ?? null;
  const [agent, reporterServer] = await step("lookup_failed", () => Promise.all([
    getDb().select({ serverId: agents.serverId }).from(agents)
      .where(and(eq(agents.id, agentId), isNull(agents.deletedAt))).then(([row]) => row),
    reporterServerId
      ? getDb().select({ name: servers.name }).from(servers).where(eq(servers.id, reporterServerId)).then(([row]) => row)
      : Promise.resolve(undefined),
  ]));
  if (!agent) return { outcome: "disabled", errorCode: "agent_not_found" };

  const surface = surfaceLabel(submission);
  const source = surface ? `${clientLabel(submission)} (${surface})` : clientLabel(submission);
  const feedbackReportId = submission.feedbackReportId ?? null;
  const lensUrl = productFeedbackLensUrl(feedbackReportId, env);
  const text = buildProductFeedbackTriageNoticeText({
    source,
    serverName: reporterServer ? quotedServerName(reporterServer.name) : null,
    ticketId: receipt.id,
    lensUrl,
    submittedAt,
    feedbackReportId,
  });
  // Hands answers a replayed submission_id (a resent card, a retried form)
  // with the same ticket, so one notice per ticket: the key is kept on the
  // event, and an advisory lock makes two replays at once see each other.
  const eventKey = `feedback-ticket:${receipt.id}`;
  const event = await step("insert_failed", () => getDb().transaction(async (tx) => {
    await tx.execute(sql`SELECT pg_advisory_xact_lock(hashtext(${`${PRODUCT_FEEDBACK_TRIAGE_SYSTEM_APP}:${agentId}:${eventKey}`}))`);
    const [earlier] = await tx.select({ id: thirdPartyAgentEvents.id }).from(thirdPartyAgentEvents).where(and(
      eq(thirdPartyAgentEvents.agentId, agentId),
      isNull(thirdPartyAgentEvents.clientId),
      eq(thirdPartyAgentEvents.systemApp, PRODUCT_FEEDBACK_TRIAGE_SYSTEM_APP),
      eq(thirdPartyAgentEvents.externalEventId, eventKey),
    )).limit(1);
    if (earlier) return null;
    return createSystemAppAgentEvent({
      executor: tx,
      eventKey,
      // The triage agent's own server: the event is the agent's, not the reporter's.
      serverId: agent.serverId,
      agentId,
      systemApp: PRODUCT_FEEDBACK_TRIAGE_SYSTEM_APP,
      kind: "notification",
      summary: text,
      payload: {
        kind: "product_feedback_submitted",
        text,
        source,
        ticket_id: receipt.id,
        lens_url: lensUrl,
        submitted_at: submittedAt.toISOString(),
        ...(feedbackReportId ? { feedback_report_id: feedbackReportId } : {}),
      },
      ttlMs: TRIAGE_NOTICE_TTL_MS,
      now: submittedAt,
      objectRef: productFeedbackTriageObjectRef(submission.userId),
    });
  }));
  if (!event) return { outcome: "disabled", errorCode: "duplicate_ticket" };
  // A failed push leaves the event queued (deliverSystemAppAgentEvent), so the
  // sweep still hands it over; it is counted as failed all the same.
  const pusher = deliverer;
  if (pusher) await step("deliver_failed", () => deliverSystemAppAgentEvent({ event, deliverer: pusher }));
  return { outcome: "sent", errorCode: null };
}

/**
 * Starts the triage notice for a filed ticket and returns at once: never
 * awaited by the submission, never throws, never rejects.
 */
export function notifyProductFeedbackTriage(
  submission: ProductFeedbackSubmission,
  receipt: ProductFeedbackReceipt,
  env: NodeJS.ProcessEnv = process.env,
): void {
  const submittedAt = currentDate();
  const run = (async () => {
    let result: { outcome: ProductFeedbackTriageOutcome; errorCode: ProductFeedbackTriageErrorCode | null };
    try {
      result = await sendTriageNotice(submission, receipt, env, submittedAt);
    } catch (error) {
      result = { outcome: "failed", errorCode: error instanceof TriageNoticeStepError ? error.code : "insert_failed" };
    }
    try {
      recordTraceEvent(PRODUCT_FEEDBACK_TRIAGE_NOTICE_EVENT, {
        outcome: result.outcome,
        ...(result.errorCode ? { error_code: result.errorCode } : {}),
      });
    } catch {
      // Tracing never fails the notice.
    }
  })();
  inFlight.add(run);
  void run.finally(() => inFlight.delete(run));
}

/** Test hook: waits for every notice started so far. */
export async function settleProductFeedbackTriageNoticesForTest(): Promise<void> {
  while (inFlight.size > 0) await Promise.all([...inFlight]);
}
