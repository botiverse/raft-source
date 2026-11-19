/**
 * RFC 085 §4.2: confirming a `request:prepare` card (POST
 * /api/actions/:messageId/execute with its form's `confirm`; routes/actions.ts
 * hands it here). In this order (AppFather's Phase 1 notes, Tenny):
 *
 *   0. before anything is written: the person's own full web session; the
 *      card visible, operable, theirs, open, not past 30 days, not frozen by a
 *      conversion; the form is the card's current one (its id is the digest
 *      the card shows); request cards are on for the card's server
 *      (`prepared_request_card_v0`); the route still has its entry on the
 *      delegable list, and is none the runtime backstop refuses. Otherwise
 *      nothing runs (`request_not_available` for the last three);
 *   1. claim: one confirm at a time (preparedRequestCards.ts);
 *   2. re-check: the stored params and body parse under the entry's schemas
 *      as they are now and come out the same (a narrowed schema ends the card
 *      `changed_since_prepared`); the summary model rebuilt under the person's
 *      visibility is the stored one (a different one moves the card to
 *      `reconfirm_required` once the preparing agent still sees all of it,
 *      else it ends `changed_since_prepared`); the request as it would run (path
 *      params a uuid or a word their enum lists; no body key the backstop
 *      refuses, at any depth) passes the runtime backstop again;
 *   3. run: the stored request (its path built from id params only; anything
 *      else is refused as `request_not_runnable` and nothing runs) through the
 *      one runner, dispatchOwnerRoute, with the person's live confirm request,
 *      so it passes the route's own middleware as them; Idempotency-Key the
 *      card's message id and attempt, and a request id of its own;
 *   4. record, under the claim alone (the route may have archived the card's
 *      channel or removed the person, so no permission is checked again): 2xx
 *      `success`; 4xx reopens the card for the next attempt with the route's
 *      status and code (never a step-up's: that is the person's to answer, in
 *      their own /execute answer only, and known only from the step-up gate's
 *      note on the dispatch mark, never from a 403 body's code); a 5xx, no answer in time or a throw
 *      from the runner is `unknown` and never runs again.
 *
 * Every attempt that reaches the run is one audit event (with the dispatched
 * request's id, which the route's own audit rows carry), and its agent hears
 * the outcome (one result kind). /execute answers with the card on a run that
 * ended it, and with the card's own refusal otherwise; never with the route's
 * status (a route's 401 or 429 is not the person's session failing).
 */
import { and, eq } from "drizzle-orm";
import type { Server as SocketServer } from "socket.io";
import {
  preparedRequestFormId,
  type ActionCardFormSubmission,
  type ActionCardMetadata,
  type ActionCardResult,
  type PreparedRequestAction,
  type ServerId,
} from "@botiverse/raft-shared";
import { getDb } from "../db/index";
import { actionCards, messages, users } from "../db/schema";
import { canonicalJson } from "../lib/canonicalJson";
import type { AgentOrchestrator } from "./agentOrchestrator";
import type { OwnerConfirmRequest, OwnerRouteAnswer } from "./assistantOwnerActionCards";
import { delegableCardEntryForRoute, type DelegableCardEntry } from "./delegableCardRegistry";
import { delegableBodyBackstopKey, delegableRouteBackstopRule } from "./delegableRouteBackstop";
import {
  PreparedRequestBuildError,
  preparedRequestHooks,
  PreparedRequestCardError,
  cardForPerson,
  changeCard,
  claimPreparedRequestCard,
  emitUpdated,
  endChanged,
  endedRefusal,
  isOwnClaim,
  isPreparedRequestForm,
  lockCard,
  nextMetadata,
  preparedRequestRouteRequest,
  rebuildModel,
  recordPreparedRequestAudit,
  recordPreparedRequestAuditWithRetry,
  releasePreparedRequestClaim,
  replyToPreparer,
  requestNotAvailable,
  retryPreparedRequestAudit,
  sameSummaryModel,
  storedMetadata,
  type CardScope,
  type PersonCard,
  type PreparedRequestClaim,
} from "./preparedRequestCards";

export interface ConfirmPreparedRequestInput {
  messageId: string;
  serverId: ServerId;
  userId: string;
  /** The person's own web (`full`) sign-in (sessionService.webSessionFamilyOf), else null: refused. */
  webSessionFamilyId: string | null;
  form: ActionCardFormSubmission;
  expectedConfirmationVersion?: number;
  ownerRequest: OwnerConfirmRequest;
  io: SocketServer | null;
  orchestrator: AgentOrchestrator | null;
}

/** Whether the request a card stores still fits its entry's schemas as they are now, parsing to the same values. */
function stillFits(entry: DelegableCardEntry, action: PreparedRequestAction): boolean {
  const params = entry.route.paramsSchema.safeParse(action.params);
  const body = entry.route.bodySchema.safeParse(action.body);
  return params.success && body.success
    && canonicalJson(params.data) === canonicalJson(action.params)
    && canonicalJson(body.data) === canonicalJson(action.body);
}

/** The route's own refusal code: its `code` (or `errorCode`), else `http_<status>`; at most 80 safe characters. */
function routeCodeOf(answer: OwnerRouteAnswer): string {
  const raw = typeof answer.body.code === "string" ? answer.body.code : typeof answer.body.errorCode === "string" ? answer.body.errorCode : "";
  const code = raw.replace(/[^A-Za-z0-9_.:-]/g, "").slice(0, 80);
  return code || `http_${answer.status}`;
}

/**
 * The card funnel's attempt, success and failure (product_events), as execute
 * records them. Best effort: a funnel that fails never hides an outcome (the
 * card is recorded and its agent told before it runs).
 */
async function funnel(cardId: string, userId: string, eventType: "action_card.execute_attempt" | "action_card.execute_success" | "action_card.execute_fail", failure?: { status?: number; code?: string }): Promise<void> {
  try {
    const testFunnel = preparedRequestHooks().funnel;
    if (testFunnel) { await testFunnel(); return; }
    const { recordActionCardEvent, classifyExecuteError } = await import("./productEventsService");
    await recordActionCardEvent({
      cardId, eventType, actor: { type: "human", id: userId }, source: "server",
      metadata: { action_type: "request:prepare", ...(failure ? classifyExecuteError(failure) : {}) },
    });
  } catch (err) {
    console.warn("[request-cards] funnel event failed", err instanceof Error ? err.message : err);
  }
}

/** Best effort: what follows a recorded outcome (a redraw) never turns it into an error. */
async function quietly(what: string, work: () => Promise<void>): Promise<void> {
  try {
    await work();
  } catch (err) {
    console.warn(`[request-cards] ${what} failed`, err instanceof Error ? err.message : err);
  }
}

/** The card's served answer (withStoredActionCardSpec is the route's). */
async function cardNow(messageId: string): Promise<{ messageId: string; metadata: ActionCardMetadata }> {
  const metadata = await storedMetadata(getDb(), messageId);
  if (!metadata) throw new PreparedRequestCardError(404, "NOT_FOUND", "Card message not found");
  return { messageId, metadata };
}

export async function confirmPreparedRequestCard(input: ConfirmPreparedRequestInput): Promise<{ messageId: string; metadata: ActionCardMetadata }> {
  // 0. What every confirm takes before anything is written.
  if (!input.webSessionFamilyId) {
    throw new PreparedRequestCardError(403, "FULL_SESSION_REQUIRED", "Confirm this card from Raft, signed in as yourself.");
  }
  const card = await cardForPerson(input);
  if (card.state === "executed") return replayExecuted(input, card);
  if (card.state !== "prepared" || card.claimed) throw endedRefusal(card.state, card.claimed);
  await assertNotFrozen(input.messageId, card, input.expectedConfirmationVersion);
  if (!isPreparedRequestForm(input.form, card.action, "confirm")) {
    const { ActionCardFormInvalidError } = await import("./actionCardsService");
    const { actionCardFormIssue } = await import("@botiverse/raft-shared");
    throw new ActionCardFormInvalidError([actionCardFormIssue(null, "invalid_format")]);
  }
  const entry = await runnableEntry(card);

  // 1. Claim.
  await preparedRequestHooks().beforeClaim?.();
  const claim = await claimPreparedRequestCard(input.messageId, input.userId, card.action.attempt);
  if (!claim) throw new PreparedRequestCardError(409, "REQUEST_ALREADY_CONFIRMING", "This request is already being confirmed.");
  const scope: CardScope = {
    messageId: input.messageId, serverId: card.serverId, channelId: card.channelId, requesterAgentId: card.requesterAgentId,
    userId: input.userId, io: input.io, orchestrator: input.orchestrator,
  };
  let ran = false;
  try {
    await funnel(card.id, input.userId, "action_card.execute_attempt");
    // 2. Re-check what it runs, as things are now.
    if (!stillFits(entry, card.action)) {
      await endChanged(scope, entry, card.action, claim);
      throw new PreparedRequestCardError(409, "request_changed_unavailable",
        "This request no longer fits what its operation allows, so it can't be confirmed as prepared. Nothing ran.");
    }
    const now = await rebuildModel(entry, card.action, card.serverId, { kind: "user", userId: input.userId });
    if (!now.ok) throw new PreparedRequestCardError(now.status, now.refusal.code, now.refusal.error);
    if (!sameSummaryModel(now.model, card.action.summaryModel)) await changeCard(scope, entry, card.action, now.model, claim);
    // A summary that changed since it was prepared (confirmed again by this path or by a conversion's): the
    // preparing agent must still see all of it, as when it changed (Warden).
    if (card.action.changedAt) {
      const asAgent = await rebuildModel(entry, card.action, card.serverId, { kind: "agent", agentId: card.requesterAgentId });
      if (!asAgent.ok || !sameSummaryModel(asAgent.model, card.action.summaryModel)) {
        await endChanged(scope, entry, card.action, claim);
        throw new PreparedRequestCardError(409, "request_changed_unavailable",
          "This changed since it was prepared and now covers something the agent that prepared it can't see, so it can't be confirmed. Nothing ran.");
      }
    }

    // 3. Build it, then run it.
    let request;
    try {
      request = preparedRequestRouteRequest(card.action, entry.route.paramsSchema);
    } catch (err) {
      if (!(err instanceof PreparedRequestBuildError)) throw err;
      // Refused, not run: never `unknown`. The card stays open at the next attempt (the person may decline it).
      console.error("[request-cards] could not build the request", err.message);
      await reopen(scope, card, claim, { status: null, code: "request_not_runnable" }, null);
      throw new PreparedRequestCardError(409, "request_not_runnable", "This request can't be made into a request to run, so it was refused. Nothing ran.");
    }
    // The request as it will run, its params filled in, against the backstop again (a param can't carry a refused route in).
    const concrete = delegableRouteBackstopRule(`${request.method} ${request.path}`);
    if (concrete) {
      console.error("[request-cards] the runtime backstop refused a request as it would run", request.method, request.path, concrete.name);
      throw requestNotAvailable();
    }
    // And its body, as it will be sent: no field that makes content public, carries a secret, or sets a role or scopes.
    const forbiddenKey = delegableBodyBackstopKey(request.body);
    if (forbiddenKey) {
      console.error("[request-cards] the runtime backstop refused a body field as it would run", card.action.route, forbiddenKey);
      throw requestNotAvailable();
    }
    const { ownerRouteDispatcher, OWNER_DISPATCH_TIMEOUT_CODE } = await import("./assistantOwnerActionCards");
    const requestId = claim.requestId;
    ran = true;
    let answer: OwnerRouteAnswer | null = null;
    try {
      answer = await ownerRouteDispatcher()({
        ownerRequest: input.ownerRequest,
        serverId: card.serverId,
        request,
        cardMessageId: input.messageId,
        idempotencyKey: `${input.messageId}:${card.action.attempt}`,
        requestId,
      });
    } catch (err) {
      // It threw after it started: it may have run.
      console.warn("[request-cards] the run threw", err instanceof Error ? err.message : err);
    }

    // 4. Record.
    if (answer && answer.status >= 400 && answer.status < 500 && answer.body.code !== OWNER_DISPATCH_TIMEOUT_CODE) {
      const code = routeCodeOf(answer);
      const sentence = typeof answer.body.error === "string" && answer.body.error.trim() ? answer.body.error.trim().slice(0, 500) : `The request was refused (HTTP ${answer.status}).`;
      // Only the step-up gate's own refusal, read from the dispatch mark (dispatchOwnerRoute reports it), never the
      // body's code: a route that relays another answer, or refuses after it wrote, could carry that code, and
      // treating it as a step-up would leave the attempt open for a second press to run again (Tenny 296b02bc).
      if (answer.stepUpRequired === true) {
        // The person verifies and presses again; this answer is the only place the step-up is said. The card the
        // agent and every viewer read doesn't change at all (no attempt, no redraw): the next press retries this
        // attempt (the route refused before it ran). Released, audited (platform-admin only) and counted.
        await releasePreparedRequestClaim(input.messageId, claim);
        await recordPreparedRequestAuditWithRetry({
          kind: "run", card: { id: card.id, messageId: input.messageId, serverId: card.serverId, requesterAgentId: card.requesterAgentId },
          action: card.action, attempt: card.action.attempt, userId: input.userId, outcome: "refused", routeStatus: answer.status, routeCode: code, dispatchRequestId: requestId,
        });
        await funnel(card.id, input.userId, "action_card.execute_fail", { status: answer.status, code });
        const { ActionCardSecondFactorRequiredError } = await import("./actionCardsService");
        const methods = Array.isArray(answer.body.methods) ? answer.body.methods : [];
        throw new ActionCardSecondFactorRequiredError(sentence, methods as ConstructorParameters<typeof ActionCardSecondFactorRequiredError>[1]);
      }
      await reopen(scope, card, claim, { status: answer.status, code }, requestId, answer.status, code);
      await funnel(card.id, input.userId, "action_card.execute_fail", { status: answer.status, code });
      const served = await cardNow(input.messageId);
      throw new PreparedRequestCardError(409, "request_refused", sentence, { routeStatus: answer.status, routeCode: code, metadata: served.metadata });
    }
    const outcome = answer && answer.status >= 200 && answer.status < 300 ? "success" : "unknown";
    await record(scope, card, claim, { outcome, status: answer?.status ?? null, requestId });
    // The card as it is now; none when the run deleted it (its conversation went): the outcome as far as known.
    const metadata = await storedMetadata(getDb(), input.messageId);
    if (!metadata) throw new PreparedRequestCardError(410, "REQUEST_CARD_GONE", `It ran (${outcome}), and the card went with its conversation.`);
    return { messageId: input.messageId, metadata };
  } catch (err) {
    // Released only while nothing has run (and only this press's own claim): once the run
    // started the route may have run, so the claim stays and the sweep ends the card as unknown.
    if (!ran) await releasePreparedRequestClaim(input.messageId, claim);
    throw err;
  }
}

/** The same form again on a card this person already confirmed: the card (a retry). Anyone else: already done. */
async function replayExecuted(input: ConfirmPreparedRequestInput, card: PersonCard): Promise<{ messageId: string; metadata: ActionCardMetadata }> {
  const served = await cardNow(input.messageId);
  if (card.executedByUserId === input.userId && isPreparedRequestForm(input.form, card.action, "confirm")) return served;
  const { ActionCardAlreadyExecutedError } = await import("./actionCardsService");
  throw new ActionCardAlreadyExecutedError(served.metadata);
}

/**
 * A card a channel conversion holds is not confirmed here, as execute answers
 * it (frozen, reconfirm first, its confirmation version, an active fence); one
 * whose summary changed is confirmed again first.
 */
async function assertNotFrozen(messageId: string, card: PersonCard, expectedConfirmationVersion: number | undefined): Promise<void> {
  if (card.freezeState === "reconfirm_required" && card.action.changePending) {
    throw new PreparedRequestCardError(409, "action_card_reconfirmation_required", "This changed since it was prepared: check what it says now and confirm it again.");
  }
  const conversion = await import("./actionCardConversionService");
  // In execute's order: frozen, then confirm again, then the confirmation version.
  if (card.freezeState === "frozen") throw new conversion.ActionCardConversionFrozenError(card.confirmationVersion.toString());
  if (card.freezeState === "reconfirm_required") throw new conversion.ActionCardReconfirmationRequiredError();
  if (card.conversionJobId !== null && card.confirmationVersion > 1 && expectedConfirmationVersion === undefined) throw new conversion.ActionCardConfirmationRequiredError();
  await getDb().transaction((tx) => conversion.assertActionCardWritableInTransaction(tx, card.serverId, messageId, expectedConfirmationVersion, { activeFenceError: "conversion" }));
}

/** The list's entry the card still runs from, while request cards are on and the backstop lets its route through. */
async function runnableEntry(card: PersonCard): Promise<DelegableCardEntry> {
  const { isPreparedRequestCardEnabled } = await import("./preparedRequestPrepare");
  const entry = delegableCardEntryForRoute(card.action.route);
  const blocked = delegableRouteBackstopRule(card.action.route);
  if (blocked) console.error("[request-cards] the runtime backstop refused a listed route", card.action.route, blocked.name);
  if (!await isPreparedRequestCardEnabled(card.serverId) || !entry || blocked
    || entry.route.operation.name !== card.action.operation || entry.route.summaryTemplate !== card.action.template) {
    throw requestNotAvailable();
  }
  return entry;
}

/**
 * Reopens the card for the next attempt, under this press's claim alone: the
 * route refused it (`refusal`: its status and code, shown on the card), or a
 * step-up was asked (`refusal` null: nothing about it goes on the card the agent
 * and every viewer read). The agent hears `refused` with the code, except for a
 * step-up, which is the person's to answer. Audited when the route ran.
 */
async function reopen(
  scope: CardScope,
  card: PersonCard,
  claim: PreparedRequestClaim,
  refusal: { status: number | null; code: string },
  requestId: string | null,
  routeStatus?: number,
  routeCode?: string,
): Promise<void> {
  const next: PreparedRequestAction = {
    ...card.action,
    attempt: card.action.attempt + 1,
    refusal: { status: refusal.status ?? 409, code: refusal.code, attempt: card.action.attempt, at: new Date().toISOString() },
  };
  const audit = { kind: "run" as const, card: { id: card.id, messageId: scope.messageId, serverId: card.serverId, requesterAgentId: card.requesterAgentId },
    action: card.action, attempt: card.action.attempt, userId: scope.userId, outcome: "refused" as const,
    routeStatus: routeStatus ?? null, routeCode: routeCode ?? refusal.code, dispatchRequestId: requestId };
  let audited = false;
  const reopened = await whileCardExists(scope.messageId, () => getDb().transaction(async (tx) => {
    await lockCard(tx, scope.messageId);
    const [row] = await tx.update(actionCards)
      .set({ payload: next, result: null, updatedAt: new Date() })
      .where(and(eq(actionCards.messageId, scope.messageId), eq(actionCards.state, "prepared"), isOwnClaim(claim)))
      .returning({ id: actionCards.id });
    if (!row) return false;
    const stored = await storedMetadata(tx, scope.messageId);
    if (stored) await tx.update(messages).set({ actionMetadata: await nextMetadata(stored, next, {}), updatedAt: new Date() }).where(eq(messages.id, scope.messageId));
    audited = await recordPreparedRequestAudit({ executor: tx, ...audit });
    return true;
  }));
  if (!reopened) {
    // The route's run deleted the card itself (its conversation went): the run is still audited, outside it.
    if (requestId && !await cardExists(scope.messageId)) await recordPreparedRequestAuditWithRetry(audit);
    return;
  }
  if (!audited) await retryPreparedRequestAudit(audit);
  await replyToPreparer({ io: scope.io, orchestrator: scope.orchestrator, messageId: scope.messageId, action: next, outcome: "refused", confirmerUserId: scope.userId, code: refusal.code });
  await quietly("redraw", () => emitUpdated(scope.io, scope.messageId));
}

/**
 * A card write after a run, or false when the run took the card with it (its
 * conversation deleted, the card's row by cascade): the write's own lock finds
 * no card then, and that is not an error of the run.
 */
async function whileCardExists(messageId: string, write: () => Promise<boolean>): Promise<boolean> {
  try {
    return await write();
  } catch (err) {
    if (!await cardExists(messageId)) return false;
    throw err;
  }
}

async function cardExists(messageId: string): Promise<boolean> {
  const [row] = await getDb().select({ id: actionCards.id }).from(actionCards).where(eq(actionCards.messageId, messageId)).limit(1);
  return !!row;
}

/**
 * Records the run (`success` or `unknown`), under this press's claim alone: no
 * permission is checked again, since the route itself may have archived the
 * card's conversation or removed the person from it. A claim that is gone (the
 * sweep ended it as unknown first) records nothing more.
 */
async function record(scope: CardScope, card: PersonCard, claim: PreparedRequestClaim, ran: { outcome: "success" | "unknown"; status: number | null; requestId: string }): Promise<void> {
  const now = new Date();
  const result: ActionCardResult = {
    kind: "prepared-request", outcome: ran.outcome, status: ran.status, attempt: card.action.attempt, decidedByUserId: scope.userId, decidedAt: now.toISOString(),
  };
  const audit = { kind: "run" as const, card: { id: card.id, messageId: scope.messageId, serverId: card.serverId, requesterAgentId: card.requesterAgentId },
    action: card.action, attempt: card.action.attempt, userId: scope.userId, outcome: ran.outcome, routeStatus: ran.status, dispatchRequestId: ran.requestId };
  let audited = false;
  const recorded = await whileCardExists(scope.messageId, () => getDb().transaction(async (tx) => {
    await lockCard(tx, scope.messageId);
    const [row] = await tx.update(actionCards)
      .set({ state: "executed", result, executedAt: now, executedByUserId: scope.userId, submittedInput: { form: preparedRequestFormId(card.action.digest), values: { decision: "confirm" } }, updatedAt: now })
      .where(and(eq(actionCards.messageId, scope.messageId), eq(actionCards.state, "prepared"), isOwnClaim(claim)))
      .returning({ id: actionCards.id });
    if (!row) return false;
    const [person] = await tx.select({ name: users.name, displayName: users.displayName }).from(users).where(eq(users.id, scope.userId)).limit(1);
    const stored = await storedMetadata(tx, scope.messageId);
    if (stored) {
      const metadata = await nextMetadata(stored, card.action, {
        state: "executed", result, executedAt: now.toISOString(), executedByUserId: scope.userId, executedByUserName: person?.displayName || person?.name || null,
      });
      await tx.update(messages).set({ actionMetadata: metadata, updatedAt: now }).where(eq(messages.id, scope.messageId));
    }
    audited = await recordPreparedRequestAudit({ executor: tx, ...audit });
    return true;
  }));
  if (!recorded) {
    // Either the sweep ended the claim first (it audited the run), or the route's run deleted the card itself (its
    // conversation went, the card's row with it): the run is still audited, outside it.
    if (!await cardExists(scope.messageId)) await recordPreparedRequestAuditWithRetry(audit);
    return;
  }
  if (!audited) await retryPreparedRequestAudit(audit);
  // The agent first; then the redraw and the funnel, which never undo or hide what was recorded.
  await replyToPreparer({ io: scope.io, orchestrator: scope.orchestrator, messageId: scope.messageId, action: card.action, outcome: ran.outcome, confirmerUserId: scope.userId });
  await quietly("redraw", () => emitUpdated(scope.io, scope.messageId));
  await funnel(card.id, scope.userId, ran.outcome === "success" ? "action_card.execute_success" : "action_card.execute_fail", ran.outcome === "success" ? undefined : {});
}
