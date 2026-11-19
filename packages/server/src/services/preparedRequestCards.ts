/**
 * RFC 085 §4.2-§4.4: a `request:prepare` card after it is posted (prepare:
 * preparedRequestPrepare.ts; confirm: preparedRequestCommit.ts). Only the
 * person named decides.
 *
 *   Confirm (preparedRequestCommit.ts): claim, re-check, run through the one
 *     runner (dispatchOwnerRoute) as the person, record under the claim alone.
 *   Decline (its form's `decline`, routes/actions.ts hands it here): ends
 *     `declined`; nothing runs.
 *   Confirm again (POST /api/actions/:messageId/reconfirm on a card whose
 *     summary changed, `changePending`): the prepare-time checks under the
 *     preparing agent's visibility (Warden), then the card is open again. A card
 *     a channel conversion asks to be confirmed again goes down that path
 *     (routes/actions.ts), never this one.
 *   Withdraw (the agent, POST /internal/agent-api/actions/:messageId/withdraw).
 *   Expiry: 30 days after it was prepared (ACTION_CARD_EXPIRY_MS), by the sweep.
 *
 * The agent hears every end as one result kind (PreparedRequestOutcome), as a
 * reply in the card's thread that @mentions it: the outcome, the route's own
 * code when it refused, and the summary with only the names the card itself
 * shows everyone there. Never the route's response body.
 *
 * Asking is bounded per agent and person (assertPreparedRequestBudget): at most
 * 5 open cards, 20 prepared in any 24 hours, and none for 24 hours after the
 * person declined the same request.
 */
import { createHash, randomUUID } from "node:crypto";
import { and, asc, count, desc, eq, inArray, isNull, sql, type SQL } from "drizzle-orm";
import type { Server as SocketServer } from "socket.io";
import { z, type ZodObject } from "zod";
import {
  ACTION_CARD_EXPIRY_MS,
  ACTION_CARD_MESSAGES,
  PREPARED_REQUEST_ACTION_TYPE,
  PREPARED_REQUEST_DECISION_FIELD,
  PREPARED_REQUEST_OPEN_PER_PERSON,
  actionCardFormIssue,
  buildPreparedRequestForms,
  preparedRequestFormId,
  type ActionCardFormSubmission,
  type ActionCardMessageKey,
  type ActionCardMetadata,
  type ActionCardResult,
  type ActionCardSpecNames,
  type PreparedRequestAction,
  type PreparedRequestModel,
  type PreparedRequestModelValue,
  type PreparedRequestOutcome,
  type ServerId,
  asServerId,
} from "@botiverse/raft-shared";
import { getDb, type DatabaseExecutor, type DatabaseTransaction } from "../db/index";
import { actionCards, messages } from "../db/schema";
import { canonicalJson } from "../lib/canonicalJson";
import { RefusalError } from "../lib/refusal";
import { addTraceEvent } from "../tracing/semanticTrace";
import type { ActionCardFormHandler } from "./actionCardForms";
import type { AgentOrchestrator } from "./agentOrchestrator";
import type { OwnerRouteRequest } from "./assistantOwnerActionCards";
import type { IntegrationAuditEventInput } from "./integrationAuditService";
import { assertActionCardNotExpired } from "./actionCardExpiry";
import { delegableCardEntryForRoute, delegableSummaryTemplateFor, type DelegableCardEntry } from "./delegableCardRegistry";
import type { DelegableViewer } from "./delegableSummaryTemplates";

// Every other card module is imported where it is used: actionCardForms
// imports this file to register its handler, and those modules import it.

/** An error the card routes answer with its own status and code (routes/actions.ts handleError), and `details` beside them. */
export class PreparedRequestCardError extends Error {
  constructor(readonly status: number, readonly code: string, message: string, readonly details?: Record<string, unknown>) {
    super(message);
    this.name = "PreparedRequestCardError";
  }
}

/** The one answer for a card whose request can't run from a card any more (flag off, entry gone, a backstop route). */
export function requestNotAvailable(): PreparedRequestCardError {
  return new PreparedRequestCardError(409, "request_not_available", "This request can't be confirmed from a card here any more. Nothing ran.");
}

// ── The request and its summary ─────────────────────────────────────────────

/** sha256 hex of what the person confirms: the route, its params and body, and the summary model. */
export function preparedRequestDigest(input: Pick<PreparedRequestAction, "route" | "params" | "body" | "summaryModel">): string {
  return createHash("sha256").update(canonicalJson({ route: input.route, params: input.params, body: input.body, summaryModel: input.summaryModel })).digest("hex");
}

/** Models compare by their ids and values (canonical JSON), never by how they read. */
export function sameSummaryModel(a: PreparedRequestModel, b: PreparedRequestModel): boolean {
  return canonicalJson(a) === canonicalJson(b);
}

const UUID_PARAM = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
/** A word an enum param may list: lower case, never `.`, `..`, `/` or anything to encode. */
export const PREPARED_REQUEST_PARAM_WORD = /^[a-z][a-z0-9_-]{0,39}$/;

/** The words an enum param schema lists (z.enum), or null when it is not an enum. */
export function preparedRequestParamWords(schema: unknown): readonly string[] | null {
  if (!(schema instanceof z.ZodEnum)) return null;
  const options = (schema as z.ZodEnum).options as unknown[];
  return options.every((option) => typeof option === "string" && PREPARED_REQUEST_PARAM_WORD.test(option)) ? options as string[] : null;
}

/**
 * Whether a card may put `value` in a route's path for the param `schema` declares: a uuid, or one of the
 * words an enum param lists (`:action` names its actions). Never any other word: `me` or `a` in an id's
 * place could reach a different route (DELETE /api/servers/a/members/me), so "an id-shaped string" is not
 * enough (Tenny 296b02bc).
 */
export function preparedRequestParamAllowed(schema: unknown, value: unknown): value is string {
  if (typeof value !== "string") return false;
  const words = preparedRequestParamWords(schema);
  return words ? words.includes(value) : UUID_PARAM.test(value);
}

/** A stored request that can't be made into a path (a param that isn't an id, or one missing). */
export class PreparedRequestBuildError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "PreparedRequestBuildError";
  }
}

/**
 * The stored request as the runner sends it: the route's path with its params
 * filled in, and the parsed body. Never a query string. A param that isn't a
 * uuid or one of its enum's words is refused here, whatever the list's schema took (the structure test
 * holds the list to ids too).
 */
export function preparedRequestRouteRequest(
  action: Pick<PreparedRequestAction, "route" | "params" | "body">,
  paramsSchema: ZodObject,
): OwnerRouteRequest {
  const space = action.route.indexOf(" ");
  const method = action.route.slice(0, space) as OwnerRouteRequest["method"];
  const shape = paramsSchema.shape as Record<string, unknown>;
  const path = action.route.slice(space + 1).replace(/:([A-Za-z]\w*)/g, (_match, name: string) => {
    const value = Object.hasOwn(action.params, name) ? action.params[name] : undefined;
    if (value === undefined) throw new PreparedRequestBuildError(`request card for ${action.route} has no ${name}`);
    if (!Object.hasOwn(shape, name) || !preparedRequestParamAllowed(shape[name], value)) {
      throw new PreparedRequestBuildError(`request card for ${action.route}: ${name} is not a uuid or one of its listed words`);
    }
    return value;
  });
  return { method, path, body: action.body };
}

const NEUTRAL_NAMES = { user: "a person", agent: "an agent", channel: "a channel", computer: "a computer" } as const;
const SIGILS = { user: "@", agent: "@", channel: "#", computer: "" } as const;

/** A message key's English copy with `params` filled in (the key itself when the table has none). */
export function englishOf(key: string, params: Readonly<Record<string, string>>): string {
  const entry = Object.hasOwn(ACTION_CARD_MESSAGES, key) ? ACTION_CARD_MESSAGES[key as ActionCardMessageKey] : undefined;
  if (!entry) return key;
  return entry.text.en.replace(/\{\{|\}\}|\{([A-Za-z][A-Za-z0-9_]*)\}/g, (token, name?: string) =>
    token === "{{" ? "{" : token === "}}" ? "}" : name !== undefined && Object.hasOwn(params, name) ? params[name]! : token);
}

/**
 * The summary in English with the names in `names`, else a neutral word.
 * "Stop @Builder (Computer: hetzner-1)".
 */
export function preparedRequestSummaryText(action: Pick<PreparedRequestAction, "display" | "summaryModel">, names: ActionCardSpecNames): string {
  const shown = shownWith(names);
  const fields = action.display.fields.map((field) => `${englishOf(field.label, {})}: ${shown(action.summaryModel[field.value]!)}`);
  const title = preparedRequestTitleText(action, names);
  return fields.length > 0 ? `${title} (${fields.join("; ")})` : title;
}

/** The card's title alone in English, with the names in `names`, else a neutral word: "Stop @Builder". */
export function preparedRequestTitleText(action: Pick<PreparedRequestAction, "display" | "summaryModel">, names: ActionCardSpecNames): string {
  const shown = shownWith(names);
  return englishOf(action.display.title, Object.fromEntries(Object.entries(action.summaryModel).map(([name, entry]) => [name, shown(entry)])));
}

/** A model value as text: its name in `names` with its sigil, a neutral word, or the text itself. */
function shownWith(names: ActionCardSpecNames): (entry: PreparedRequestModelValue) => string {
  return (entry) => {
    if (entry.kind === "text") return entry.text;
    const bucket = entry.kind === "user" ? names.users : entry.kind === "agent" ? names.agents : entry.kind === "channel" ? names.channels : undefined;
    const name = bucket && Object.hasOwn(bucket, entry.id) ? bucket[entry.id] : undefined;
    return name ? `${SIGILS[entry.kind]}${name}` : NEUTRAL_NAMES[entry.kind];
  };
}

/** The summary as the preparing agent may read it now (prepare's echo, a withdraw's receipt: answers only it reads). */
export async function preparedRequestAgentSummary(action: PreparedRequestAction, serverId: string, agentId: string): Promise<string> {
  const template = delegableSummaryTemplateFor(action.template);
  let names: ActionCardSpecNames = {};
  if (template) {
    try {
      names = await template.names(action.summaryModel, { serverId: asServerId(serverId), viewer: { kind: "agent", agentId } });
    } catch (err) {
      console.warn("[request-cards] could not name a summary for its agent", err instanceof Error ? err.message : err);
    }
  }
  return preparedRequestSummaryText(action, names);
}

/** The model of a stored request as things are now, under `viewer`. */
export async function rebuildModel(entry: DelegableCardEntry, action: PreparedRequestAction, serverId: string, viewer: DelegableViewer) {
  return entry.template.model({ params: action.params, body: action.body }, { serverId: asServerId(serverId), viewer });
}

// ── The agent's one result kind ─────────────────────────────────────────────

function outcomeSentence(outcome: PreparedRequestOutcome, person: string, code?: string): string {
  switch (outcome) {
    case "success": return `${person} confirmed it, and it ran.`;
    case "refused": return `${person} confirmed it, but the request was refused (${code ?? "refused"}). The card is still open: ${person} can try again or decline it.`;
    case "unknown": return `${person} confirmed it, but Raft didn't hear back in time, so it may have run. It won't run again; check with ${person} before you prepare it again.`;
    case "changed_since_prepared": return "It changed since you prepared it (what it covers, or what its operation allows now), so it can't be confirmed as prepared. Nothing ran; prepare it again if it's still needed.";
    case "declined": return `${person} declined it. Nothing ran.`;
    case "expired": return `Nobody confirmed it within 30 days, so it expired. Nothing ran.`;
    case "withdrawn": return "You withdrew it. Nothing ran.";
  }
}

/**
 * Tells the agent that prepared the card how it ended (one result kind), as a
 * reply in the card's thread that @mentions it (postActionCardResultReply).
 * The reply is read by everyone in that thread, so its summary names only what
 * the card itself shows everyone there (its fallback names), else neutral words.
 */
export async function replyToPreparer(input: {
  io: SocketServer | null | undefined;
  orchestrator: AgentOrchestrator | null | undefined;
  messageId: string;
  action: PreparedRequestAction;
  outcome: PreparedRequestOutcome;
  /** Who acted, when someone did. */
  confirmerUserId: string | null;
  code?: string;
}): Promise<void> {
  try {
    const { storedActionCardSpecNames } = await import("./actionCardPresentation");
    const stored = await storedMetadata(getDb(), input.messageId);
    const summary = preparedRequestSummaryText(input.action, storedActionCardSpecNames(stored?.presentation));
    const person = `@${input.action.addressee.handle}`;
    const text = `your request card \`${input.messageId.slice(0, 8)}\` for ${person} (${input.action.operation}: ${summary}) ended ${input.outcome}${input.code ? ` (${input.code})` : ""}. ${outcomeSentence(input.outcome, person, input.code)}`;
    const { postActionCardResultReply } = await import("./actionCardsService");
    await postActionCardResultReply({
      io: input.io,
      orchestrator: input.orchestrator,
      messageId: input.messageId,
      confirmerUserId: input.confirmerUserId,
      outcome: { kind: "prepared_request", text, causalUserId: input.action.addressee.userId },
    });
  } catch (err) {
    console.error("[request-cards] could not tell the agent", err instanceof Error ? err.message : err);
  }
}

// ── Test hooks ───────────────────────────────────────────────────────────────

export interface PreparedRequestTestHooks {
  /** Writes the audit event instead of the audit service, on the executor it is given (inside the savepoint). */
  auditWriter?: (event: IntegrationAuditEventInput, executor: DatabaseExecutor) => Promise<void>;
  /** Runs instead of the funnel event (product_events) after a confirm. */
  funnel?: () => Promise<void>;
  /** Runs after a confirm read the card and before it claims it. */
  beforeClaim?: () => Promise<void>;
  /** Runs after a Confirm again passed its checks and before its write (a freeze landing in between). */
  beforeReconfirmWrite?: () => Promise<void>;
}

let hooks: PreparedRequestTestHooks = {};

/** Replace the hooks (null restores none). Test only. */
export function setPreparedRequestHooksForTest(next: PreparedRequestTestHooks | null): void {
  if (process.env.NODE_ENV !== "test") throw new Error("the request card hooks are test-only");
  hooks = next ?? {};
}

export function preparedRequestHooks(): PreparedRequestTestHooks {
  return hooks;
}

// ── The audit ────────────────────────────────────────────────────────────────

/**
 * One integration audit event per commit attempt that reached the route
 * (`action_card.request_run`) and per decline (`action_card.request_declined`):
 * the card, its operation and route, the attempt, the preparing agent (the
 * requester) and the person (the actor), the outcome, and the dispatched
 * request's own id (`request_id`), which the route's own audit rows carry too
 * (ownerDispatchContext.ts), so an investigator joins one to the other.
 *
 * Inside a card's transaction (`executor`) it is written in a savepoint: a
 * failed insert rolls back only the savepoint, never the card's own write (in
 * Postgres a failed statement aborts its transaction, and its COMMIT would
 * then roll the card back while the caller went on as if it were recorded).
 * Without one it is written on its own. A failure is logged, never thrown.
 */
export interface PreparedRequestAuditInput {
  executor?: DatabaseExecutor;
  kind: "run" | "declined";
  card: { id: string; messageId: string; serverId: string; requesterAgentId: string };
  action: PreparedRequestAction;
  attempt: number;
  userId: string;
  outcome: "success" | "refused" | "unknown" | "declined";
  routeStatus?: number | null;
  routeCode?: string | null;
  dispatchRequestId?: string | null;
}

/**
 * Writes the card's audit event (in `executor`'s transaction when given, as a savepoint). True when it was
 * written; a failure is logged and answers false, never a failed card: the caller retries it once after its
 * transaction commits (retryPreparedRequestAudit).
 */
export async function recordPreparedRequestAudit(input: PreparedRequestAuditInput): Promise<boolean> {
  const { recordIntegrationAuditEvent } = await import("./integrationAuditService");
  const event: IntegrationAuditEventInput = {
      serverId: input.card.serverId,
      eventType: input.kind === "run" ? "action_card.request_run" : "action_card.request_declined",
      outcome: input.outcome === "success" || input.outcome === "declined" ? "success" : "failure",
      source: "action_card",
      actor: { type: "human", id: input.userId },
      requester: { type: "agent", id: input.card.requesterAgentId },
      target: { type: "action_card", id: input.card.id },
      correlationId: input.card.messageId,
      requestId: input.dispatchRequestId ?? null,
      metadata: {
        cardMessageId: input.card.messageId,
        operation: input.action.operation,
        route: input.action.route,
        attempt: input.attempt,
        preparerAgentId: input.card.requesterAgentId,
        outcome: input.outcome,
        ...(input.routeStatus !== undefined ? { routeStatus: input.routeStatus } : {}),
        ...(input.routeCode ? { routeCode: input.routeCode } : {}),
        ...(input.dispatchRequestId ? { dispatchRequestId: input.dispatchRequestId } : {}),
      },
  };
  const write = async (executor: DatabaseExecutor) => {
    if (hooks.auditWriter) await hooks.auditWriter(event, executor);
    else await recordIntegrationAuditEvent(event, executor);
  };
  try {
    if (input.executor) await (input.executor as DatabaseTransaction).transaction((savepoint) => write(savepoint));
    else await write(getDb());
    return true;
  } catch (err) {
    // The record of the card itself stands; a lost audit row is logged, never a failed confirm.
    console.error("[request-cards] audit write failed", err instanceof Error ? err.message : err);
    return false;
  }
}

/**
 * The audit write once more, outside any transaction (after the card's own write committed). A second failure
 * is a structured event, `server.request_card.audit_lost` on the span (no ids) and one JSON log line with the
 * card's message id and attempt, so the missing row can be found and written by hand (Tenny 296b02bc).
 */
export async function retryPreparedRequestAudit(input: Omit<PreparedRequestAuditInput, "executor">): Promise<void> {
  if (await recordPreparedRequestAudit(input)) return;
  addTraceEvent("server.request_card.audit_lost", { kind: input.kind, outcome: input.outcome, operation: input.action.operation });
  console.error(JSON.stringify({
    event: "request_card.audit_lost", kind: input.kind, outcome: input.outcome, operation: input.action.operation,
    cardMessageId: input.card.messageId, attempt: input.attempt, dispatchRequestId: input.dispatchRequestId ?? null,
  }));
}

/** recordPreparedRequestAudit outside a transaction, and once more if that fails (retryPreparedRequestAudit). */
export async function recordPreparedRequestAuditWithRetry(input: Omit<PreparedRequestAuditInput, "executor">): Promise<void> {
  if (!await recordPreparedRequestAudit(input)) await retryPreparedRequestAudit(input);
}

/** Best effort: a redraw after what was recorded (and after the agent's reply) never turns it into an error. */
async function redrawQuietly(io: SocketServer | null | undefined, messageId: string): Promise<void> {
  try {
    await emitUpdated(io, messageId);
  } catch (err) {
    console.warn("[request-cards] redraw failed", err instanceof Error ? err.message : err);
  }
}

// ── At prepare: how much an agent may ask one person ────────────────────────

/** At most this many cards of one agent for one person prepared in any 24 hours, whatever became of them. */
export const PREPARED_REQUEST_PER_DAY = 20;
/** After the person declined a request, the same request (operation, params and body) may not be prepared again for this long. */
export const PREPARED_REQUEST_DECLINE_COOLDOWN_MS = 24 * 60 * 60 * 1000;
const DAY_MS = 24 * 60 * 60 * 1000;

let perDayForTest: number | null = null;
/** Lower the 24-hour budget (null restores it). Test only. */
export function setPreparedRequestPerDayForTest(limit: number | null): void {
  if (process.env.NODE_ENV !== "test") throw new Error("the request card budget hook is test-only");
  perDayForTest = limit;
}

/** "2026-11-14 09:30 UTC": the server knows no agent's time zone. */
function utcMinute(at: Date): string {
  return `${at.toISOString().slice(0, 16).replace("T", " ")} UTC`;
}

/**
 * In prepare's transaction (after the conversation's source lock), under a
 * lock of the (agent, person) pair so two prepares can't both pass:
 *   - at most PREPARED_REQUEST_OPEN_PER_PERSON open cards (prepared, a changed
 *     one waiting to be confirmed again too, not yet 30 days old), naming them;
 *   - at most PREPARED_REQUEST_PER_DAY prepared in the last 24 hours, whatever
 *     became of them (withdrawing or being declined doesn't give the asking
 *     back), until the oldest of them leaves the window;
 *   - none of the same request (operation, params and body) for
 *     PREPARED_REQUEST_DECLINE_COOLDOWN_MS after the person declined it.
 * Each refusal says when the agent may ask again.
 */
export async function assertPreparedRequestBudget(tx: DatabaseExecutor, input: {
  serverId: string;
  requesterAgentId: string;
  action: Pick<PreparedRequestAction, "addressee" | "operation" | "params" | "body">;
}): Promise<void> {
  const addresseeUserId = input.action.addressee.userId;
  await tx.execute(sql`SELECT pg_advisory_xact_lock(hashtextextended(${`prepared-request-open:${input.requesterAgentId}:${addresseeUserId}`}, 0))`);
  const pair = and(
    eq(actionCards.serverId, input.serverId),
    eq(actionCards.requesterAgentId, input.requesterAgentId),
    eq(actionCards.actionType, PREPARED_REQUEST_ACTION_TYPE),
    sql`${actionCards.payload} -> 'addressee' ->> 'userId' = ${addresseeUserId}`,
  );

  const open = await tx.select({ messageId: actionCards.messageId, operation: sql<string>`${actionCards.payload} ->> 'operation'` })
    .from(actionCards)
    .where(and(pair, eq(actionCards.state, "prepared"), sql`${actionCards.createdAt} > now() - (${ACTION_CARD_EXPIRY_MS} * interval '1 millisecond')`))
    .orderBy(asc(actionCards.createdAt), asc(actionCards.id))
    .limit(PREPARED_REQUEST_OPEN_PER_PERSON);
  if (open.length >= PREPARED_REQUEST_OPEN_PER_PERSON) {
    const listed = open.map((card) => `${card.messageId.slice(0, 8)} (${card.operation})`).join(", ");
    throw new RefusalError(409, {
      code: "too_many_open_requests",
      error: `You already have ${PREPARED_REQUEST_OPEN_PER_PERSON} open request cards for this person: ${listed}. You can ask again once one ends, or after you withdraw one you no longer need.`,
    });
  }

  const perDay = perDayForTest ?? PREPARED_REQUEST_PER_DAY;
  const inDay = and(pair, sql`${actionCards.createdAt} > now() - (${DAY_MS} * interval '1 millisecond')`);
  const [day] = await tx.select({ n: count() }).from(actionCards).where(inDay);
  if ((day?.n ?? 0) >= perDay) {
    const [frees] = await tx.select({ at: sql<string>`(${actionCards.createdAt} + (${DAY_MS} * interval '1 millisecond'))::text`, seconds: sql<number>`ceil(extract(epoch from (${actionCards.createdAt} + (${DAY_MS} * interval '1 millisecond') - now())))::int` })
      .from(actionCards).where(inDay)
      .orderBy(desc(actionCards.createdAt))
      .limit(1)
      .offset(perDay - 1);
    const retryAfterSeconds = Math.max(1, Number(frees?.seconds ?? DAY_MS / 1000));
    throw new RefusalError(429, {
      code: "request_card_budget_spent",
      error: `You prepared ${perDay} request cards for this person in the last 24 hours, the most an agent may. You can ask again after ${utcMinute(new Date(Date.now() + retryAfterSeconds * 1000))}.`,
      retryAfterSeconds,
    });
  }

  const [declined] = await tx.select({ decidedAt: sql<string>`${actionCards.result} ->> 'decidedAt'` })
    .from(actionCards)
    .where(and(
      pair,
      eq(actionCards.state, "declined"),
      sql`${actionCards.payload} ->> 'operation' = ${input.action.operation}`,
      sql`${actionCards.payload} -> 'params' = ${JSON.stringify(input.action.params)}::jsonb`,
      sql`${actionCards.payload} -> 'body' = ${JSON.stringify(input.action.body)}::jsonb`,
      sql`(${actionCards.result} ->> 'decidedAt')::timestamptz > now() - (${PREPARED_REQUEST_DECLINE_COOLDOWN_MS} * interval '1 millisecond')`,
    ))
    .orderBy(desc(sql`(${actionCards.result} ->> 'decidedAt')::timestamptz`))
    .limit(1);
  if (declined?.decidedAt) {
    const again = new Date(Date.parse(declined.decidedAt) + PREPARED_REQUEST_DECLINE_COOLDOWN_MS);
    throw new RefusalError(409, {
      code: "request_declined_recently",
      error: `This person declined this same request at ${utcMinute(new Date(declined.decidedAt))}. You can ask again after ${utcMinute(again)}, or sooner if they bring it up.`,
      retryAfterSeconds: Math.max(1, Math.ceil((again.getTime() - Date.now()) / 1000)),
    });
  }
}

// ── The claim ────────────────────────────────────────────────────────────────
//
// A prepared card's action_cards.result is null until it ends, so a claim is
// a marker there: a conditional UPDATE from "prepared, ready, no claim, at
// this attempt", so exactly one of two concurrent confirms wins, and a claim
// is never taken over (that could run the route twice). Every write that ends
// or clears a claim names it (its token, its person and when it was taken), so
// it never touches another press's claim: a refusal (4xx) clears it with the
// next attempt; a throw before the run releases it; once the run has started
// only its record, or the sweep (as `unknown`), ends it.

const CLAIM_KIND = "prepared-request-claim";
/** 2x the runner's timeout (assistantOwnerActionCards OWNER_DISPATCH_TIMEOUT_MS, 30 s): a claim this old outlived any run. */
export const PREPARED_REQUEST_CLAIM_STALE_MS = 2 * 30_000;

export interface PreparedRequestClaim {
  kind: typeof CLAIM_KIND;
  token: string;
  userId: string;
  claimedAt: string;
  attempt: number;
  /** The id the run's dispatched request will carry, known before it runs: the sweep audits an unknown run with it. */
  requestId: string;
}

const isClaimed = sql`${actionCards.result} ->> 'kind' = ${CLAIM_KIND}`;

/** This claim and no other: its token, its person and its time. */
export function isOwnClaim(claim: PreparedRequestClaim): SQL {
  return sql`(${actionCards.result} ->> 'kind' = ${CLAIM_KIND} and ${actionCards.result} ->> 'token' = ${claim.token} and ${actionCards.result} ->> 'userId' = ${claim.userId} and ${actionCards.result} ->> 'claimedAt' = ${claim.claimedAt})`;
}

/** Takes the card's claim for one confirm; null when it is not open at this attempt or someone holds it. */
export async function claimPreparedRequestCard(messageId: string, userId: string, attempt: number): Promise<PreparedRequestClaim | null> {
  const claim: PreparedRequestClaim = { kind: CLAIM_KIND, token: randomUUID(), userId, claimedAt: new Date().toISOString(), attempt, requestId: randomUUID() };
  const claimed = await getDb().update(actionCards)
    .set({ result: claim, updatedAt: new Date() })
    .where(and(
      eq(actionCards.messageId, messageId),
      eq(actionCards.actionType, PREPARED_REQUEST_ACTION_TYPE),
      eq(actionCards.state, "prepared"),
      eq(actionCards.freezeState, "ready"),
      isNull(actionCards.result),
      sql`(${actionCards.payload} ->> 'attempt')::int = ${attempt}`,
    ))
    .returning({ id: actionCards.id });
  return claimed.length === 1 ? claim : null;
}

/** Releases this claim, and only it (nothing ran). False when it is no longer held. */
export async function releasePreparedRequestClaim(messageId: string, claim: PreparedRequestClaim): Promise<boolean> {
  const released = await getDb().update(actionCards)
    .set({ result: null, updatedAt: new Date() })
    .where(and(eq(actionCards.messageId, messageId), eq(actionCards.state, "prepared"), isOwnClaim(claim)))
    .returning({ id: actionCards.id });
  return released.length === 1;
}

// ── Writing the card ─────────────────────────────────────────────────────────

/**
 * The stored card metadata with `action` (and what else changed), its
 * presentation rebuilt from them. `names`: the summary's names for everyone
 * in the conversation, when the summary changed (they replace the old ones,
 * so a name no longer everyone's to see is not kept); otherwise the names the
 * card shows. Who prepared it and for whom stay named either way.
 */
export async function nextMetadata(stored: ActionCardMetadata, action: PreparedRequestAction, change: Partial<ActionCardMetadata>, names?: ActionCardSpecNames): Promise<ActionCardMetadata> {
  const { actionCardPresentationFor, storedActionCardSpecNames } = await import("./actionCardPresentation");
  const shown = storedActionCardSpecNames(stored.presentation);
  const base = names ?? shown;
  const preparer = stored.requesterAgentId ?? null;
  const preparerName = preparer ? shown.agents?.[preparer] : undefined;
  const result = change.result !== undefined ? change.result : stored.result ?? null;
  return {
    ...stored,
    ...change,
    action,
    presentation: actionCardPresentationFor(action, {
      result,
      names: {
        ...base,
        users: { ...base.users, [action.addressee.userId]: action.addressee.handle },
        ...(preparer && preparerName ? { agents: { ...base.agents, [preparer]: preparerName } } : {}),
      },
      ...(preparer ? { requesterAgentId: preparer } : {}),
      ...(stored.targetServerName ? { serverName: stored.targetServerName } : {}),
    }),
  };
}

export async function lockCard(tx: DatabaseExecutor, messageId: string): Promise<void> {
  const { lockActionCardSourceInTransaction } = await import("./actionCardConversionService");
  await lockActionCardSourceInTransaction(tx, messageId);
}

export async function storedMetadata(tx: DatabaseExecutor, messageId: string): Promise<ActionCardMetadata | null> {
  const [row] = await tx.select({ actionMetadata: messages.actionMetadata }).from(messages).where(eq(messages.id, messageId)).limit(1);
  return (row?.actionMetadata as ActionCardMetadata | null | undefined) ?? null;
}

export async function emitUpdated(io: SocketServer | null | undefined, messageId: string): Promise<void> {
  if (!io) return;
  const { emitActionCardMessageUpdated } = await import("./actionCardsService");
  await emitActionCardMessageUpdated(io, { id: messageId });
}

type EndState = "declined" | "expired" | "withdrawn";

/**
 * Ends an open card without running it, under the card's source lock (as
 * execute and a conversion take it), from `prepared` and not mid-conversion,
 * so exactly one end wins. `claim`: only while that confirm holds it (the
 * confirm itself ends it); otherwise only while nobody is confirming.
 */
async function endCardInTransaction(tx: DatabaseExecutor, messageId: string, end: {
  state: EndState;
  result: ActionCardResult | null;
  claim?: PreparedRequestClaim;
  /** Only a card prepared before this (the 30-day expiry). */
  preparedBefore?: Date;
  /** The summary's names for everyone in the conversation now (nextMetadata), when they are to be renewed. */
  names?: ActionCardSpecNames;
}): Promise<{ metadata: ActionCardMetadata; action: PreparedRequestAction; card: { id: string; messageId: string; serverId: string; requesterAgentId: string } } | null> {
  await lockCard(tx, messageId);
  const now = new Date();
  const [ended] = await tx.update(actionCards)
    .set({ state: end.state, freezeState: "ready", result: end.result, updatedAt: now })
    .where(and(
      eq(actionCards.messageId, messageId),
      eq(actionCards.actionType, PREPARED_REQUEST_ACTION_TYPE),
      eq(actionCards.state, "prepared"),
      inArray(actionCards.freezeState, ["ready", "reconfirm_required"]),
      end.claim ? isOwnClaim(end.claim) : isNull(actionCards.result),
      ...(end.preparedBefore ? [sql`${actionCards.createdAt} <= ${end.preparedBefore.toISOString()}::timestamptz`] : []),
    ))
    .returning({ id: actionCards.id, payload: actionCards.payload, serverId: actionCards.serverId, requesterAgentId: actionCards.requesterAgentId });
  if (!ended) return null;
  const stored = await storedMetadata(tx, messageId);
  if (!stored) return null;
  const action = ended.payload as PreparedRequestAction;
  const metadata = await nextMetadata(stored, action, {
    state: end.state,
    ...(end.result ? { result: end.result } : {}),
    ...(end.state === "withdrawn" ? { withdrawnAt: now.toISOString() } : {}),
  }, end.names);
  await tx.update(messages).set({ actionMetadata: metadata, updatedAt: now }).where(eq(messages.id, messageId));
  return { metadata, action, card: { id: ended.id, messageId, serverId: ended.serverId, requesterAgentId: ended.requesterAgentId ?? "" } };
}

/** Who and where for the writes below. */
export interface CardScope {
  messageId: string;
  serverId: string;
  channelId: string;
  requesterAgentId: string;
  userId: string;
  io: SocketServer | null | undefined;
  orchestrator: AgentOrchestrator | null | undefined;
}

/**
 * Stores the summary as it is now (its model, digest and the names everyone
 * in the conversation may see), the card waiting to be confirmed again
 * (`reconfirm_required`, `changePending`, a new confirmation version): from a
 * confirm's own claim, or (no claim) on a card already waiting to be confirmed again.
 */
export async function storeChangedModel(scope: CardScope, entry: DelegableCardEntry, action: PreparedRequestAction, model: PreparedRequestModel, claim: PreparedRequestClaim | null): Promise<boolean> {
  const changed: PreparedRequestAction = { ...action, summaryModel: model, changedAt: new Date().toISOString(), changePending: true };
  const { refusal: _refusal, ...next } = { ...changed, digest: preparedRequestDigest(changed) };
  const names = await entry.template.names(model, { serverId: asServerId(scope.serverId), viewer: { kind: "conversation", channelId: scope.channelId } });
  const moved = await getDb().transaction(async (tx) => {
    await lockCard(tx, scope.messageId);
    const [row] = await tx.update(actionCards)
      .set({ payload: next, freezeState: "reconfirm_required", confirmationVersion: sql`${actionCards.confirmationVersion} + 1`, result: null, updatedAt: new Date() })
      .where(and(
        eq(actionCards.messageId, scope.messageId),
        eq(actionCards.state, "prepared"),
        claim ? and(eq(actionCards.freezeState, "ready"), isOwnClaim(claim)) : and(eq(actionCards.freezeState, "reconfirm_required"), isNull(actionCards.result)),
      ))
      .returning({ confirmationVersion: actionCards.confirmationVersion });
    if (!row) return false;
    const stored = await storedMetadata(tx, scope.messageId);
    if (stored) {
      const metadata = await nextMetadata(stored, next, { state: "reconfirm_required", confirmationVersion: row.confirmationVersion }, names);
      await tx.update(messages).set({ actionMetadata: metadata, updatedAt: new Date() }).where(eq(messages.id, scope.messageId));
    }
    return true;
  });
  if (moved) await emitUpdated(scope.io, scope.messageId);
  return moved;
}

/**
 * Ends a card that can't be confirmed as prepared any more
 * (`changed_since_prepared`: its new summary names something its agent can't
 * see, or its request no longer fits what its operation allows): its state is
 * `expired`, its result says why, its agent is told. From a confirm's own
 * claim, or (no claim) on an open card.
 */
export async function endChanged(scope: CardScope, entry: DelegableCardEntry, action: PreparedRequestAction, claim: PreparedRequestClaim | null): Promise<void> {
  const result: ActionCardResult = {
    kind: "prepared-request", outcome: "changed_since_prepared", status: null, attempt: action.attempt, decidedByUserId: scope.userId, decidedAt: new Date().toISOString(),
  };
  // Named as everyone there may see things now (a channel turned private is no longer named on the card, nor in the reply).
  const names = await entry.template.names(action.summaryModel, { serverId: asServerId(scope.serverId), viewer: { kind: "conversation", channelId: scope.channelId } })
    .catch(() => ({}));
  const ended = await getDb().transaction((tx) => endCardInTransaction(tx, scope.messageId, { state: "expired", result, names, ...(claim ? { claim } : {}) }));
  if (!ended) return;
  await emitUpdated(scope.io, scope.messageId);
  await replyToPreparer({ io: scope.io, orchestrator: scope.orchestrator, messageId: scope.messageId, action: ended.action, outcome: "changed_since_prepared", confirmerUserId: scope.userId });
}

/**
 * The summary changed since it was prepared (RFC 085 §4.2 step 2). Before the
 * new one may be offered, the prepare-time checks run again under the
 * preparing agent's visibility (Warden): if the agent can't see all of it, the
 * card ends `changed_since_prepared`. Otherwise it waits to be confirmed again
 * with the new summary (the old digest is refused from now on). Either way
 * nothing runs: this throws.
 */
export async function changeCard(scope: CardScope, entry: DelegableCardEntry, action: PreparedRequestAction, model: PreparedRequestModel, claim: PreparedRequestClaim | null): Promise<never> {
  const asAgent = await rebuildModel(entry, action, scope.serverId, { kind: "agent", agentId: scope.requesterAgentId });
  if (!asAgent.ok || !sameSummaryModel(asAgent.model, model)) {
    await endChanged(scope, entry, action, claim);
    throw new PreparedRequestCardError(409, "request_changed_unavailable",
      "This changed since it was prepared and now covers something the agent that prepared it can't see, so it can't be confirmed. Nothing ran.");
  }
  await storeChangedModel(scope, entry, action, model, claim);
  throw new PreparedRequestCardError(409, "action_card_reconfirmation_required", "This changed since it was prepared: check what it says now and confirm it again.");
}

// ── The form ─────────────────────────────────────────────────────────────────

/** A form value of the decision field: confirm or decline, nothing else. */
export function preparedRequestDecisionOf(form: ActionCardFormSubmission): "confirm" | "decline" | null {
  const value = form.values[PREPARED_REQUEST_DECISION_FIELD];
  return value === "confirm" || value === "decline" ? value : null;
}

/**
 * The card's form (what it draws and what its submission must be). Both
 * decisions are answered by their own paths (routes/actions.ts: confirm by
 * preparedRequestCommit.ts, decline by declinePreparedRequestCard), never by
 * execute's form path: it refuses either, and nothing there runs.
 */
export const preparedRequestFormHandler: ActionCardFormHandler<"request:prepare", never> = {
  buildForm(action) {
    return buildPreparedRequestForms(action);
  },
  async validate() {
    return { issues: [actionCardFormIssue(PREPARED_REQUEST_DECISION_FIELD, "invalid_option")] };
  },
  async execute() {
    throw new PreparedRequestCardError(409, "BAD_STATE", "A request card is confirmed through its own path.");
  },
};

/** Whether `form` is exactly this card's form with this decision (its id is the digest the card shows). */
export function isPreparedRequestForm(form: ActionCardFormSubmission, action: PreparedRequestAction, decision: "confirm" | "decline"): boolean {
  return form.id === preparedRequestFormId(action.digest)
    && preparedRequestDecisionOf(form) === decision
    && Object.keys(form.values).length === 1;
}

/**
 * Before execute (routes/actions.ts): a card that waits to be confirmed again
 * because its summary changed is said so in its own words (execute's own
 * refusal of a card waiting to be reconfirmed speaks of a channel conversion).
 */
export async function assertPreparedRequestCardConfirmable(messageId: string): Promise<void> {
  const [row] = await getDb().select({ state: actionCards.state, freezeState: actionCards.freezeState, payload: actionCards.payload })
    .from(actionCards).where(eq(actionCards.messageId, messageId)).limit(1);
  if (row?.state === "prepared" && row.freezeState === "reconfirm_required" && (row.payload as PreparedRequestAction).changePending) {
    throw new PreparedRequestCardError(409, "action_card_reconfirmation_required", "This changed since it was prepared: check what it says now and confirm it again.");
  }
}

/** Whether a card waits to be confirmed again because its summary changed (this file's path), not because of a channel conversion. */
export async function isPreparedRequestChangePending(messageId: string): Promise<boolean> {
  const [row] = await getDb().select({ freezeState: actionCards.freezeState, payload: actionCards.payload, actionType: actionCards.actionType })
    .from(actionCards).where(eq(actionCards.messageId, messageId)).limit(1);
  return row?.actionType === PREPARED_REQUEST_ACTION_TYPE && row.freezeState === "reconfirm_required" && (row.payload as PreparedRequestAction).changePending === true;
}

// ── Decline, confirm again, withdraw ─────────────────────────────────────────

export interface PersonCardInput {
  messageId: string;
  serverId: ServerId;
  userId: string;
  io?: SocketServer | null;
  orchestrator?: AgentOrchestrator | null;
}

export interface PersonCard {
  id: string;
  action: PreparedRequestAction;
  requesterAgentId: string;
  serverId: string;
  channelId: string;
  state: string;
  freezeState: string;
  claimed: boolean;
  confirmationVersion: number;
  conversionJobId: string | null;
  executedByUserId: string | null;
  submittedInput: unknown;
}

/** The card as the person acting on it reads it, after the checks every press takes (visible, operable, theirs, not past 30 days). */
export async function cardForPerson(input: Pick<PersonCardInput, "messageId" | "serverId" | "userId">): Promise<PersonCard> {
  const { assertActionCardWritableByUser } = await import("./actionCardsService");
  const db = getDb();
  const [row] = await db.select({
    id: actionCards.id, payload: actionCards.payload, state: actionCards.state, freezeState: actionCards.freezeState, result: actionCards.result,
    requesterAgentId: actionCards.requesterAgentId, serverId: actionCards.serverId, actionType: actionCards.actionType,
    createdAt: actionCards.createdAt, channelId: messages.channelId, confirmationVersion: actionCards.confirmationVersion,
    conversionJobId: actionCards.conversionJobId, executedByUserId: actionCards.executedByUserId, submittedInput: actionCards.submittedInput,
  }).from(actionCards).innerJoin(messages, eq(messages.id, actionCards.messageId)).where(eq(actionCards.messageId, input.messageId)).limit(1);
  if (!row || row.actionType !== PREPARED_REQUEST_ACTION_TYPE) throw new PreparedRequestCardError(404, "NOT_FOUND", "Card message not found");
  await assertActionCardWritableByUser({ messageId: input.messageId, channelId: row.channelId, serverId: input.serverId, userId: input.userId, executor: db });
  const action = row.payload as PreparedRequestAction;
  if (input.userId !== action.addressee.userId) {
    throw new PreparedRequestCardError(403, "NOT_ADDRESSEE", `Only @${action.addressee.handle} can decide on this request.`);
  }
  if (row.state === "prepared") assertActionCardNotExpired({ actionType: row.actionType, createdAt: row.createdAt });
  const claimed = typeof row.result === "object" && row.result !== null && (row.result as { kind?: unknown }).kind === CLAIM_KIND;
  return {
    id: row.id, action, requesterAgentId: row.requesterAgentId ?? "", serverId: row.serverId, channelId: row.channelId, state: row.state,
    freezeState: row.freezeState, claimed, confirmationVersion: row.confirmationVersion, conversionJobId: row.conversionJobId,
    executedByUserId: row.executedByUserId, submittedInput: row.submittedInput,
  };
}

/** Why a card the person pressed can't be acted on any more. */
export function endedRefusal(state: string, claimed: boolean): PreparedRequestCardError {
  if (claimed) return new PreparedRequestCardError(409, "REQUEST_ALREADY_CONFIRMING", "This request is already being confirmed.");
  switch (state) {
    case "executed": return new PreparedRequestCardError(409, "ALREADY_EXECUTED", "This request was already confirmed.");
    case "declined": return new PreparedRequestCardError(409, "REQUEST_DECLINED", "This request was already declined.");
    case "withdrawn": return new PreparedRequestCardError(409, "REQUEST_WITHDRAWN", "The agent withdrew this request.");
    case "expired": return new PreparedRequestCardError(409, "REQUEST_ENDED", "This request has ended and can't be confirmed.");
    default: return new PreparedRequestCardError(409, "BAD_STATE", "This request can't be decided right now; try again shortly.");
  }
}

/**
 * The person named declines (their card's form with `decline`): the card ends
 * `declined` and nothing runs; the agent hears `declined`, and the decline is
 * audited. The form must be the card's current one (an older summary's is
 * refused, as for a confirm). Declining twice answers with the card. Works
 * with the flag off: it stops nothing from ending.
 */
export async function declinePreparedRequestCard(input: PersonCardInput & { form: ActionCardFormSubmission }): Promise<{ messageId: string; metadata: ActionCardMetadata }> {
  const card = await cardForPerson(input);
  if (card.state === "declined") {
    const stored = await storedMetadata(getDb(), input.messageId);
    if (stored) return { messageId: input.messageId, metadata: stored };
  }
  if (!isPreparedRequestForm(input.form, card.action, "decline")) {
    const { ActionCardFormInvalidError } = await import("./actionCardsService");
    throw new ActionCardFormInvalidError([actionCardFormIssue(null, "invalid_format")]);
  }
  const result: ActionCardResult = {
    kind: "prepared-request", outcome: "declined", status: null, attempt: card.action.attempt, decidedByUserId: input.userId, decidedAt: new Date().toISOString(),
  };
  const ended = await getDb().transaction(async (tx) => {
    const out = await endCardInTransaction(tx, input.messageId, { state: "declined", result });
    if (!out) return null;
    const audit: Omit<PreparedRequestAuditInput, "executor"> = {
      kind: "declined", card: out.card, action: out.action, attempt: out.action.attempt, userId: input.userId, outcome: "declined",
    };
    return { ...out, audit, audited: await recordPreparedRequestAudit({ executor: tx, ...audit }) };
  });
  if (!ended) {
    const now = await cardForPerson(input).catch(() => card);
    throw endedRefusal(now.state, now.claimed);
  }
  if (!ended.audited) await retryPreparedRequestAudit(ended.audit);
  // The agent first; the redraw after, and it never undoes or hides what was recorded.
  await replyToPreparer({ io: input.io, orchestrator: input.orchestrator, messageId: input.messageId, action: ended.action, outcome: "declined", confirmerUserId: input.userId });
  await redrawQuietly(input.io, input.messageId);
  return { messageId: input.messageId, metadata: ended.metadata };
}

/**
 * Confirm again (a card whose summary changed, `changePending`): only the
 * person named, only while request cards are on, and only once the
 * prepare-time checks pass again under the preparing agent's visibility
 * (Warden) and the model is still the one shown. Then the card is open again
 * (`prepared`, a new confirmation version), and its confirm runs it. A model
 * that moved again is shown instead; one the agent can't see ends the card
 * `changed_since_prepared`.
 */
export async function reconfirmPreparedRequestCard(input: PersonCardInput): Promise<{ messageId: string; metadata: ActionCardMetadata; confirmationVersion: number }> {
  const card = await cardForPerson(input);
  if (card.state !== "prepared" || card.freezeState !== "reconfirm_required" || !card.action.changePending) {
    throw endedRefusal(card.freezeState === "ready" && card.state === "prepared" ? "open" : card.state, card.claimed);
  }
  const { isPreparedRequestCardEnabled } = await import("./preparedRequestPrepare");
  const entry = delegableCardEntryForRoute(card.action.route);
  if (!await isPreparedRequestCardEnabled(card.serverId) || !entry || entry.route.operation.name !== card.action.operation || entry.route.summaryTemplate !== card.action.template) {
    throw requestNotAvailable();
  }
  const scope: CardScope = {
    messageId: input.messageId, serverId: card.serverId, channelId: card.channelId, requesterAgentId: card.requesterAgentId,
    userId: input.userId, io: input.io, orchestrator: input.orchestrator,
  };
  const asAgent = await rebuildModel(entry, card.action, card.serverId, { kind: "agent", agentId: card.requesterAgentId });
  if (!asAgent.ok) {
    await endChanged(scope, entry, card.action, null);
    throw new PreparedRequestCardError(409, "request_changed_unavailable",
      "This changed since it was prepared and now covers something the agent that prepared it can't see, so it can't be confirmed. Nothing ran.");
  }
  if (!sameSummaryModel(asAgent.model, card.action.summaryModel)) {
    // It moved again: the card shows it as it is now, to be confirmed again.
    await storeChangedModel(scope, entry, card.action, asAgent.model, null);
    throw new PreparedRequestCardError(409, "action_card_reconfirmation_required", "This changed again: check what it says now and confirm it again.");
  }
  const { changePending: _pending, ...opened } = card.action;
  await hooks.beforeReconfirmWrite?.();
  const out = await getDb().transaction(async (tx) => {
    await lockCard(tx, input.messageId);
    // Not while a channel conversion holds the card's conversation: the conversion freezes it, and then it is
    // the conversion's to have confirmed again (actionCardConversionService binds it).
    await assertNoActiveConversionFence(tx, input.messageId);
    const [row] = await tx.update(actionCards)
      .set({ payload: opened, freezeState: "ready", confirmationVersion: sql`${actionCards.confirmationVersion} + 1`, reconfirmedAt: new Date(), reconfirmedByUserId: input.userId, updatedAt: new Date() })
      .where(and(eq(actionCards.messageId, input.messageId), eq(actionCards.state, "prepared"), eq(actionCards.freezeState, "reconfirm_required"), isNull(actionCards.result)))
      .returning({ confirmationVersion: actionCards.confirmationVersion });
    if (!row) return null;
    const stored = await storedMetadata(tx, input.messageId);
    if (!stored) return null;
    const metadata = await nextMetadata(stored, opened, { state: "prepared", confirmationVersion: row.confirmationVersion, reconfirmedAt: new Date().toISOString() });
    await tx.update(messages).set({ actionMetadata: metadata, updatedAt: new Date() }).where(eq(messages.id, input.messageId));
    return { metadata, confirmationVersion: row.confirmationVersion };
  });
  if (!out) throw endedRefusal("unknown", false);
  await emitUpdated(input.io, input.messageId);
  return { messageId: input.messageId, ...out };
}

/** Refuses (frozen, as execute answers it) while a channel conversion's fence is active on the card's conversation. */
async function assertNoActiveConversionFence(tx: DatabaseExecutor, messageId: string): Promise<void> {
  const { resolveActionCardSourceChannelId, ActionCardConversionFrozenError } = await import("./actionCardConversionService");
  const { getActiveChannelConversionFence } = await import("./channelConversionFenceService");
  const [carrier] = await tx.select({ channelId: messages.channelId, bound: actionCards.conversionSourceChannelId })
    .from(messages).innerJoin(actionCards, eq(actionCards.messageId, messages.id)).where(eq(messages.id, messageId)).limit(1);
  if (!carrier) return;
  const sourceChannelId = carrier.bound ?? await resolveActionCardSourceChannelId(tx, carrier.channelId);
  const fence = sourceChannelId ? await getActiveChannelConversionFence(tx, sourceChannelId) : null;
  if (fence) throw new ActionCardConversionFrozenError(fence.conversionEpoch);
}

/**
 * The agent that prepared it withdraws it while it is open (not while someone
 * is confirming it). Its answer is the agent's receipt (no reply is posted):
 * the card as the agent reads it, and the result kind `withdrawn` with the
 * summary as the agent may see it.
 */
export async function withdrawPreparedRequestCard(input: { serverId: string; requesterAgentId: string; messageId: string; io: SocketServer | null }): Promise<{
  messageId: string; metadata: ActionCardMetadata; alreadyWithdrawn: boolean; preparedRequest: { outcome: "withdrawn"; summary: string };
}> {
  const { withoutAgentHiddenActionCardSpec } = await import("./actionCardPresentation");
  // The Agent API's withdraw answers ActionCardErrors (its agent reads `errorCode` and the next step).
  const { ActionCardError } = await import("./actionCardsService");
  const ended = await getDb().transaction((tx) => endCardInTransaction(tx, input.messageId, { state: "withdrawn", result: null }));
  const db = getDb();
  const [row] = await db.select({ state: actionCards.state, result: actionCards.result, payload: actionCards.payload }).from(actionCards).where(eq(actionCards.messageId, input.messageId)).limit(1);
  if (!row) throw new ActionCardError(404, "NOT_FOUND", "No request card with that message id");
  const action = row.payload as PreparedRequestAction;
  if (!ended && row.state !== "withdrawn") {
    const claimed = typeof row.result === "object" && row.result !== null && (row.result as { kind?: unknown }).kind === CLAIM_KIND;
    if (claimed) {
      throw new ActionCardError(409, "REQUEST_ALREADY_CONFIRMING", `@${action.addressee.handle} is confirming this request right now, so it can't be withdrawn`, {
        suggestedNextAction: "Wait for its result: it comes to you as a reply in the card's thread.",
      });
    }
    throw new ActionCardError(409, "NOT_WITHDRAWABLE", `This request already ended (${row.state})`, {
      suggestedNextAction: "Its result came to you as a reply in the card's thread.",
    });
  }
  if (ended) await emitUpdated(input.io, input.messageId);
  const metadata = ended?.metadata ?? await storedMetadata(db, input.messageId);
  if (!metadata) throw new ActionCardError(404, "NOT_FOUND", "No request card with that message id");
  return {
    messageId: input.messageId,
    metadata: withoutAgentHiddenActionCardSpec(metadata),
    alreadyWithdrawn: !ended,
    preparedRequest: { outcome: "withdrawn", summary: await preparedRequestAgentSummary(action, input.serverId, input.requesterAgentId) },
  };
}

// ── The sweep: 30 days, and claims that outlived their run ──────────────────

/**
 * Ends one card whose claim is older than PREPARED_REQUEST_CLAIM_STALE_MS as
 * `unknown` (it may have run: the process stopped between claim and record),
 * under the card's source lock with the row locked, and only that claim (its
 * token), so a record that came first wins and a newer claim is never ended.
 * Never runs it again.
 */
export async function endStalePreparedRequestClaim(input: { messageId: string; io: SocketServer | null | undefined; orchestrator: AgentOrchestrator | null | undefined }): Promise<boolean> {
  const ended = await getDb().transaction(async (tx) => {
    await lockCard(tx, input.messageId);
    const [card] = await tx.select({ id: actionCards.id, serverId: actionCards.serverId, requesterAgentId: actionCards.requesterAgentId, payload: actionCards.payload, result: actionCards.result })
      .from(actionCards)
      .where(and(
        eq(actionCards.messageId, input.messageId),
        eq(actionCards.actionType, PREPARED_REQUEST_ACTION_TYPE),
        eq(actionCards.state, "prepared"),
        isClaimed,
        sql`(${actionCards.result} ->> 'claimedAt')::timestamptz < now() - (${PREPARED_REQUEST_CLAIM_STALE_MS} * interval '1 millisecond')`,
      ))
      .for("update")
      .limit(1);
    if (!card) return null;
    const action = card.payload as PreparedRequestAction;
    const claim = card.result as PreparedRequestClaim;
    const now = new Date();
    const result: ActionCardResult = {
      kind: "prepared-request", outcome: "unknown", status: null, attempt: claim.attempt ?? action.attempt, decidedByUserId: claim.userId, decidedAt: now.toISOString(),
    };
    const [done] = await tx.update(actionCards)
      .set({ state: "executed", result, executedAt: now, executedByUserId: claim.userId, updatedAt: now })
      .where(and(eq(actionCards.id, card.id), eq(actionCards.state, "prepared"), isOwnClaim(claim)))
      .returning({ id: actionCards.id });
    if (!done) return null;
    const stored = await storedMetadata(tx, input.messageId);
    if (stored) {
      const metadata = await nextMetadata(stored, action, { state: "executed", result, executedAt: now.toISOString(), executedByUserId: claim.userId });
      await tx.update(messages).set({ actionMetadata: metadata, updatedAt: now }).where(eq(messages.id, input.messageId));
    }
    // Every run is audited: this one ended unknown, with the id its dispatched request carried.
    const audit: Omit<PreparedRequestAuditInput, "executor"> = {
      kind: "run", card: { id: card.id, messageId: input.messageId, serverId: card.serverId, requesterAgentId: card.requesterAgentId ?? "" },
      action, attempt: claim.attempt ?? action.attempt, userId: claim.userId, outcome: "unknown", routeStatus: null, dispatchRequestId: claim.requestId ?? null,
    };
    const audited = await recordPreparedRequestAudit({ executor: tx, ...audit });
    return { action, userId: claim.userId, audit, audited };
  });
  if (!ended) return false;
  if (!ended.audited) await retryPreparedRequestAudit(ended.audit);
  // The agent first; the redraw after, and it never undoes or hides what was recorded.
  await replyToPreparer({ io: input.io, orchestrator: input.orchestrator, messageId: input.messageId, action: ended.action, outcome: "unknown", confirmerUserId: ended.userId });
  await redrawQuietly(input.io, input.messageId);
  return true;
}

/** Ends one open card prepared more than 30 days ago as `expired` and tells its agent; false when it was not open or not due. Works with the flag off. */
export async function expirePreparedRequestCard(input: { messageId: string; io: SocketServer | null | undefined; orchestrator: AgentOrchestrator | null | undefined; now?: Date }): Promise<boolean> {
  const due = new Date((input.now ?? new Date()).getTime() - ACTION_CARD_EXPIRY_MS);
  const ended = await getDb().transaction((tx) => endCardInTransaction(tx, input.messageId, { state: "expired", result: null, preparedBefore: due }));
  if (!ended) return false;
  await replyToPreparer({ io: input.io, orchestrator: input.orchestrator, messageId: input.messageId, action: ended.action, outcome: "expired", confirmerUserId: null });
  await redrawQuietly(input.io, input.messageId);
  return true;
}

/** Request cards past 30 days, and claims that outlived their run; each agent told. Returns how many ended. */
export async function sweepPreparedRequestCards(io: SocketServer | null | undefined, orchestrator: AgentOrchestrator | null | undefined): Promise<number> {
  const db = getDb();
  const stale = await db.select({ messageId: actionCards.messageId }).from(actionCards).where(and(
    eq(actionCards.actionType, PREPARED_REQUEST_ACTION_TYPE),
    eq(actionCards.state, "prepared"),
    isClaimed,
    sql`(${actionCards.result} ->> 'claimedAt')::timestamptz < now() - (${PREPARED_REQUEST_CLAIM_STALE_MS} * interval '1 millisecond')`,
  )).limit(200);
  const due = await db.select({ messageId: actionCards.messageId }).from(actionCards).where(and(
    eq(actionCards.actionType, PREPARED_REQUEST_ACTION_TYPE),
    eq(actionCards.state, "prepared"),
    isNull(actionCards.result),
    sql`${actionCards.createdAt} <= now() - (${ACTION_CARD_EXPIRY_MS} * interval '1 millisecond')`,
  )).orderBy(asc(actionCards.createdAt), asc(actionCards.id)).limit(200);
  let ended = 0;
  for (const { messageId } of stale) {
    try {
      if (await endStalePreparedRequestClaim({ messageId, io, orchestrator })) ended += 1;
    } catch (err) {
      console.error("[request-cards] could not end a stale claim", messageId, err instanceof Error ? err.message : err);
    }
  }
  for (const { messageId } of due) {
    try {
      if (await expirePreparedRequestCard({ messageId, io, orchestrator })) ended += 1;
    } catch (err) {
      console.error("[request-cards] could not expire", messageId, err instanceof Error ? err.message : err);
    }
  }
  return ended;
}

/** A card's agent-visible summary for prepare's echo (the template's names under the agent). */
export function preparedRequestEchoFor(action: PreparedRequestAction, agentNames: ActionCardSpecNames): { summary: string; title: string; for: string; operation: string; result: "reply" } {
  return {
    summary: preparedRequestSummaryText(action, agentNames),
    title: preparedRequestTitleText(action, agentNames),
    for: `@${action.addressee.handle}`,
    operation: action.operation,
    result: "reply",
  };
}
