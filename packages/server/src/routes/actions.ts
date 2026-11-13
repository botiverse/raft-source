import { isOwnerDispatch, type OwnerConfirmRequest } from "../services/assistantOwnerActionCards";
import { clientIpForRateLimit } from "../lib/clientIpForRateLimit";
import { assertChannelWritableInTransaction } from "../services/channelConversionFenceService";
// User-facing API for committing action cards.
//
// Mounted at /api/actions after requireAuth + requireServer.
//
// Two endpoints:
// - POST /:messageId/execute: agent fully prefilled the action; click runs
//   the underlying create under the user's identity. Each card kind declares
//   the second step it takes (services/actionCardSecondFactor.ts); without it,
//   403 `second_factor_step_up_required` with the methods, and nothing runs.
// - POST /:messageId/mark-executed: dialog-driven flow (channel:create,
//   agent:create, channel:add_member; integration:connect_mcp's picker)
//   — frontend ran the regular create dialog/API and now records the
//   resource reference so the card flips to Done.

import { Router, type Router as RouterType } from "express";
import { z } from "zod";
import type { Request, RequestHandler, Response } from "express";
import type { Server as SocketServer } from "socket.io";
import * as actionCardsService from "../services/actionCardsService";
import * as seatRequestService from "../services/seatRequestService";
import { getServerHistoryWindowForRead, humanHistoryLimitedError, isBehindHistoryWindow } from "../services/historyWindow";
import * as productEventsService from "../services/productEventsService";
import { requestClient, requestClientPlatform } from "../services/productEventContext";
import { eq } from "drizzle-orm";
import { getDb } from "../db/index";
import { actionCards, messages } from "../db/schema";
import type { AgentOrchestrator } from "../services/agentOrchestrator";
import {
  ACTION_CARD_ALREADY_EXECUTED_ERROR_CODE,
  ACTION_CARD_FORM_INVALID_ERROR_CODE,
  AGENT_UPGRADE_CARD_GATES,
  SEAT_REQUEST_REASON_MAX_LENGTH,
  asServerId,
  seatsAddPurposeSchema,
  type ActionCardAction,
  type ActionCardAlreadyExecutedBody,
  type ActionCardFormInvalidBody,
  type ActionCardFormSubmission,
} from "@botiverse/raft-shared";
import { reconfirmActionCard } from "../services/actionCardConversionService";
import { withStoredActionCardSpec } from "../services/actionCardPresentation";
import { servedActionCardMetadata } from "../services/actionCardExpiry";
import { sendJsonServerError } from "./errorResponse";
import { webSessionFamilyOf } from "../services/sessionService";

/**
 * The owner a person's request goes to. Optional: for a member the server
 * hides its people from, the server picks the owner and doesn't read this
 * (seatRequestService.ownerToAsk); anyone else must name one.
 */
const requestOwnerSchema = z.uuid().optional();
/** POST /api/actions/seat-requests (seatRequestService.requestSeats). */
const seatRequestBodySchema = z.strictObject({
  ownerUserId: requestOwnerSchema,
  purpose: seatsAddPurposeSchema,
  reason: z.string().max(SEAT_REQUEST_REASON_MAX_LENGTH).optional(),
});
/** POST /api/actions/upgrade-requests (seatRequestService.requestUpgrade); the reason's own rules are plan:upgrade's. */
const upgradeRequestBodySchema = z.strictObject({
  ownerUserId: requestOwnerSchema,
  reason: z.string().max(2000),
  gate: z.enum(AGENT_UPGRADE_CARD_GATES).optional(),
});

export const actionsRouter: RouterType = Router();

function getIo(req: Request): SocketServer | null {
  return (req.app.get("io") ?? null) as SocketServer | null;
}

function getOrchestrator(req: Request): AgentOrchestrator | null {
  return (req.app.get("agentOrchestrator") ?? null) as AgentOrchestrator | null;
}

function handleError(req: Request, res: Response, err: unknown): void {
  // The kind's second step (services/actionCardSecondFactor.ts): the same body
  // as every gated route (routes/secondFactor.ts), so the client steps up and retries.
  if (err instanceof actionCardsService.ActionCardSecondFactorRequiredError) {
    res.status(403).json({ error: err.message, code: "second_factor_step_up_required", methods: err.methods });
    return;
  }
  // form.v1 (spec §3.4): 422 FORM_INVALID carries the issues, 409
  // ALREADY_EXECUTED the card; FORM_REQUIRED (422) is a plain ActionCardError.
  if (err instanceof actionCardsService.ActionCardFormInvalidError) {
    const body: ActionCardFormInvalidBody = { error: err.message, errorCode: ACTION_CARD_FORM_INVALID_ERROR_CODE, issues: err.issues };
    res.status(err.status).json(body);
    return;
  }
  if (err instanceof actionCardsService.ActionCardAlreadyExecutedError) {
    const body: ActionCardAlreadyExecutedBody = {
      error: err.message,
      errorCode: ACTION_CARD_ALREADY_EXECUTED_ERROR_CODE,
      metadata: withStoredActionCardSpec(err.metadata),
    };
    res.status(err.status).json(body);
    return;
  }
  if (err instanceof actionCardsService.ActionCardError) {
    res.status(err.status).json({ error: err.message, errorCode: err.code });
    return;
  }
  if (err && typeof err === "object" && "status" in err && "code" in err && "message" in err) {
    const typed = err as { status: number; code: string; message: string };
    res.status(typed.status).json({ error: typed.message, errorCode: typed.code });
    return;
  }
  sendJsonServerError(req, res, { error: "Internal error", logPrefix: "[actions] unexpected error:", err });
}

actionsRouter.post("/migration-export", async (req, res) => {
  void req;
  res.status(410).json({
    error: "Migration action cards are no longer supported. Use POST /api/agents/:agentId/migrate.",
    code: "migration_action_card_not_supported",
  });
});

/**
 * A card behind the plan's history window is not this person's to act on
 * (services/historyWindow.ts). Visibility first, so a card they can't see is
 * never said to exist (the visibility check throws its own refusal); its
 * message time comes from that check's own read. Cards keep their own
 * visibility rule (services/messageResourceAccess.ts wraps the message one).
 * Returns the card's action type from the same read, or null once it answered.
 */
async function cardInHistoryWindow(req: Request, res: Response): Promise<{ actionType: string | null } | null> {
  const { createdAt, actionType } = await actionCardsService.assertActionCardVisibleToUser({
    messageId: String(req.params.messageId),
    serverId: req.serverId!,
    userId: req.userId!,
  });
  const historyWindow = await getServerHistoryWindowForRead(req.serverId!);
  if (!isBehindHistoryWindow(createdAt, historyWindow)) return { actionType };
  res.status(404).json(humanHistoryLimitedError(historyWindow));
  return null;
}

/** The app's product feedback limiter (app.ts), the one `/api/product-feedback` is mounted behind. */
export const PRODUCT_FEEDBACK_LIMITER = "productFeedbackLimiter";
/** The app's per-person limit on answering question cards (app.ts; question-card spec §5.7). */
export const QUESTION_ANSWER_LIMITER = "questionAnswerLimiter";
/** How many question-card answers one person may send an hour (spec §5.7). */
export const QUESTION_ANSWER_RATE_LIMIT_PER_HOUR = 120;

/**
 * A feedback card's form files the feedback as the dialog does, so it spends
 * the dialog's per-person budget: the same limiter instance (its store and
 * key), run before execute so a refused send never reaches Hands or the card.
 * Every attempt counts, as on the dialog, including a retry after Hands
 * failed. A question card's answer spends the person's answer budget
 * (QUESTION_ANSWER_LIMITER) the same way. False once it answered (429, the
 * limiter's body).
 */
async function withinLimit(req: Request, res: Response, key: typeof PRODUCT_FEEDBACK_LIMITER | typeof QUESTION_ANSWER_LIMITER): Promise<boolean> {
  const limiter = req.app.get(key) as RequestHandler | undefined;
  if (!limiter) {
    res.status(500).json({ error: "The rate limiter is unavailable" });
    return false;
  }
  return new Promise<boolean>((resolve, reject) => {
    // next() lets it through; a refusal sends the 429 without calling next.
    Promise.resolve(limiter(req, res, (err?: unknown) => (err === undefined ? resolve(true) : reject(err))))
      .then(() => resolve(false), reject);
  });
}

const isPlainObject = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

const carriesForm = (body: Record<string, unknown>): boolean => Object.hasOwn(body, "form") && body.form !== undefined;

/**
 * `form` on an execute body: exactly `{ id: string, values: object }`, else
 * 400. What the values hold is checked against the card's form (422).
 */
function parseExecuteForm(body: Record<string, unknown>): ActionCardFormSubmission | undefined {
  if (!carriesForm(body)) return undefined;
  const form = body.form;
  const shaped = isPlainObject(form)
    && Object.keys(form).every((key) => key === "id" || key === "values")
    && typeof form.id === "string"
    && isPlainObject(form.values);
  if (!shaped) {
    throw new actionCardsService.ActionCardError(400, "INVALID_FORM_SUBMISSION", "form must be { id: string, values: object } with no other keys");
  }
  return { id: form.id as string, values: form.values as ActionCardFormSubmission["values"] };
}

// POST /api/actions/:messageId/execute
actionsRouter.post("/:messageId/execute", async (req, res) => {
  try {
    const card = await cardInHistoryWindow(req, res);
    if (!card) return;
    const body = (isPlainObject(req.body) ? req.body : {}) as { expectedState?: unknown; expectedConfirmationVersion?: unknown } & Record<string, unknown>;
    // Only a feedback card's form: other cards, and an execute without a form, are not feedback sends.
    if (carriesForm(body) && card.actionType === "feedback:submit" && !await withinLimit(req, res, PRODUCT_FEEDBACK_LIMITER)) return;
    if (carriesForm(body) && card.actionType === "question:ask" && !await withinLimit(req, res, QUESTION_ANSWER_LIMITER)) return;
    // A request an owner-action Confirm dispatched never confirms one itself (no dispatch inside a dispatch).
    if (card.actionType === "assistant:owner_action" && isOwnerDispatch(req)) {
      res.status(403).json({ error: "An action an assistant asked for can't confirm another one", errorCode: "OWNER_ACTION_NESTED_DISPATCH" });
      return;
    }
    const form = parseExecuteForm(body);
    const expectedState =
      body.expectedState === "prepared" || body.expectedState === "executed"
        ? body.expectedState
        : undefined;
    const out = await actionCardsService.executeActionCard({
      messageId: req.params.messageId,
      serverId: req.serverId!,
      userId: req.userId!,
      webSessionFamilyId: webSessionFamilyOf(req),
      expectedState,
      expectedConfirmationVersion: typeof body.expectedConfirmationVersion === "number" ? body.expectedConfirmationVersion : undefined,
      ...(form ? { form } : {}),
      // A form handler's client facts (a feedback form files them): the
      // request's headers only, never the body.
      client: requestClient(req.get("x-raft-client-platform"), req.get("user-agent")),
      // An assistant owner-action card's Confirm runs the stored route as this very person
      // (their Authorization header, through the app): assistantOwnerActionCards.ts.
      ...(card.actionType === "assistant:owner_action" && form ? { ownerRequest: ownerConfirmRequestOf(req) } : {}),
      io: getIo(req),
      orchestrator: getOrchestrator(req),
    });
    // An idempotent replay answers with the stored card, which may predate presentation.card.
    res.json({ messageId: out.messageId, metadata: withStoredActionCardSpec(out.metadata) });
  } catch (err) {
    handleError(req, res, err);
  }
});

/**
 * The live Confirm request, as an owner-action card's Confirm runs the stored
 * route (assistantOwnerActionCards.ts): its Authorization, Cookie and Origin
 * only (the route runs in the card's own server, never this request's
 * X-Server-Id), and the owner's address as the rate limits read it. Held
 * for this request only; nothing of it is stored with the card.
 */
function ownerConfirmRequestOf(req: Request): OwnerConfirmRequest {
  const headers: OwnerConfirmRequest["headers"] = {};
  const authorization = req.get("authorization");
  const cookie = req.get("cookie");
  const origin = req.get("origin");
  if (authorization) headers.authorization = authorization;
  if (cookie) headers.cookie = cookie;
  if (origin) headers.origin = origin;
  return { app: req.app as unknown as OwnerConfirmRequest["app"], headers, clientIp: clientIpForRateLimit(req) };
}

// POST /api/actions/:messageId/event
//
// Client-emitted product-funnel events for an action card. Whitelist is
// narrow and split by emitter:
//
//   - `action_card.open` / `action_card.dismiss` — dialog open + close-
//     without-submit signals. Always client-emitted.
//   - `action_card.execute_attempt` / `action_card.execute_fail` —
//     dialog-driven submit lifecycle (CreateAgentDialog /
//     CreateChannelDialog / AddMembersDialog). The dialogs run their own
//     create API and don't reach `mark-executed` on failure, so the FE
//     emits these directly. Per Dozy guardrail (msg=a1dbc464):
//     `execute_success` is NEVER client-emittable — it must come from the
//     server-authoritative path (executeActionCard / markActionCardExecuted)
//     so a client can't manufacture funnel "successes".
//   - `action_card.expired` — system-only (cron); not in client whitelist.
//
// The DB check constraint is the second line of defense.
//
// We also gate the request to a real action card the user has channel
// access to — otherwise anyone could pollute someone else's funnel by
// posting to a random card message id. Per Leiysky/Dozy review
// (msg=086dc014 / msg=9d0f10bd): orphan UUID probes belong to security/API
// metrics, NOT to product_events.
//
// `subject_id` is the canonical `action_cards.id`, NOT the carrier message
// id (Dozy + meichen msg=174ba78c). FE only knows the message id; we
// resolve it here.
//
// `metadata.action_type` is ALWAYS derived server-side from the validated
// card metadata; any client-supplied `action_type` is dropped. Same for
// `error_code` / `http_status` from server-side classification on the
// inline path. Client may supply `error_class` (low-cardinality enum) on
// `execute_fail` and `dismiss_reason` on `dismiss`.
const CLIENT_EVENT_TYPES = new Set([
  "action_card.open",
  "action_card.dismiss",
  "action_card.execute_attempt",
  "action_card.execute_fail",
]);

const ACTION_CARD_ERROR_CLASSES = new Set([
  "validation",
  "permission",
  "not_found",
  "conflict",
  "network",
  "unknown",
]);

actionsRouter.post("/:messageId/event", async (req, res) => {
  try {
    const body = (req.body ?? {}) as {
      eventType?: unknown;
      metadata?: unknown;
      idempotencyKey?: unknown;
    };
    if (typeof body.eventType !== "string" || !CLIENT_EVENT_TYPES.has(body.eventType)) {
      res.status(400).json({
        error:
          "eventType must be one of action_card.open, action_card.dismiss, action_card.execute_attempt, action_card.execute_fail",
      });
      return;
    }

    // Authority: the message must (a) exist, (b) be an action card, (c) be
    // in this server, (d) be in a channel the user has read access to.
    const db = getDb();
    const [row] = await db.select().from(messages).where(eq(messages.id, req.params.messageId));
    if (!row) {
      res.status(404).json({ error: "Card message not found" });
      return;
    }
    const meta = row.actionMetadata as { kind?: string; action?: ActionCardAction } | null;
    if (!meta || meta.kind !== "action-card") {
      res.status(400).json({ error: "Message is not an action card" });
      return;
    }
    // Joint carriers live in canonical storage; resolve access through the
    // viewer's own projection like every other card read path.
    const allowed = await actionCardsService.assertActionCardVisibleToUser({
      messageId: req.params.messageId,
      serverId: asServerId(req.serverId!),
      userId: req.userId!,
    }).then(() => true, () => false);
    if (!allowed) {
      res.status(403).json({ error: "Not allowed to emit events for this card" });
      return;
    }

    // Resolve carrier message id → canonical action_cards.id. This is the
    // grain agreed with Dozy + meichen (msg=174ba78c): subject_id is the
    // product entity, not its message surface.
    const [cardRow] = await db
      .select({ id: actionCards.id })
      .from(actionCards)
      .where(eq(actionCards.messageId, req.params.messageId));
    if (!cardRow) {
      // Card row missing for an action-card-typed message is a corruption
      // signal — refuse rather than silently emit with a stale subject id.
      res.status(404).json({ error: "Action card row not found for message" });
      return;
    }

    // Filter metadata to known low-cardinality fields only — clients must
    // not be able to dump arbitrary JSON into the funnel table. Each
    // recognised field is type-checked.
    const safeMetadata: productEventsService.ActionCardEventMetadata = {};
    const m = (body.metadata ?? {}) as Record<string, unknown>;
    if (
      m.dismiss_reason === "close_button" ||
      m.dismiss_reason === "esc" ||
      m.dismiss_reason === "backdrop" ||
      m.dismiss_reason === "route_change"
    ) {
      safeMetadata.dismiss_reason = m.dismiss_reason;
    }
    if (typeof m.latency_ms === "number" && m.latency_ms >= 0 && m.latency_ms < 1_000_000) {
      safeMetadata.latency_ms = Math.round(m.latency_ms);
    }

    // `action_type` is ALWAYS derived from validated server-side card
    // metadata. Any `m.action_type` from the client payload is ignored —
    // letting the client pick this dimension would give them a free knob
    // to spoof funnel groupings (Dozy / meichen review 2026-05-13).
    if (
      meta.action?.type === "channel:create" ||
      meta.action?.type === "agent:create" ||
      meta.action?.type === "channel:add_member" ||
      meta.action?.type === "integration:approve_agent_login" ||
      meta.action?.type === "integration:install_marketplace_app" ||
      meta.action?.type === "integration:register_app" ||
      meta.action?.type === "integration:update_app_registration" ||
      meta.action?.type === "feedback:submit" ||
      meta.action?.type === "plan:upgrade"
    ) {
      safeMetadata.action_type = meta.action.type;
    }

    // `error_class` (low-cardinality bucket) accepted on execute_fail only.
    // Raw `error_message` is NEVER accepted from clients — same boundary
    // as the server-side classifier. `error_code` accepted only as a
    // bounded-length categorical refiner.
    if (body.eventType === "action_card.execute_fail") {
      if (typeof m.error_class === "string" && ACTION_CARD_ERROR_CLASSES.has(m.error_class)) {
        safeMetadata.error_class = m.error_class as productEventsService.ActionCardErrorClass;
      }
      if (typeof m.error_code === "string" && m.error_code.length > 0 && m.error_code.length <= 64) {
        safeMetadata.error_code = m.error_code;
      }
      if (typeof m.http_status === "number" && m.http_status >= 100 && m.http_status < 600) {
        safeMetadata.http_status = Math.round(m.http_status);
      }
    }

    const idempotencyKey =
      typeof body.idempotencyKey === "string" && body.idempotencyKey.length > 0 && body.idempotencyKey.length <= 128
        ? body.idempotencyKey
        : undefined;

    await productEventsService.recordActionCardEvent({
      cardId: cardRow.id,
      eventType: body.eventType as productEventsService.ActionCardEventType,
      actor: { type: "human", id: req.userId! },
      source: "web",
      idempotencyKey,
      metadata: safeMetadata,
      platform: requestClientPlatform(req.get("x-raft-client-platform"), req.get("user-agent")),
    });

    res.status(204).end();
  } catch (err) {
    handleError(req, res, err);
  }
});

// POST /api/actions/:messageId/mark-executed
//
// Used by the dialog-driven flows: channel:create, agent:create and
// channel:add_member open the existing create dialog with prefilled fields,
// integration:connect_mcp its connection picker. The user submits via the
// regular API (e.g. POST /api/agents), and on success the frontend calls this
// endpoint with the resulting resource reference so the card flips to Done
// with a link.
actionsRouter.post("/:messageId/mark-executed", async (req, res) => {
  try {
    if (!await cardInHistoryWindow(req, res)) return;
    const body = (req.body ?? {}) as { result?: unknown };
    if (!body.result || typeof body.result !== "object") {
      res.status(400).json({ error: "result is required" });
      return;
    }
    const out = await actionCardsService.markActionCardExecuted({
      messageId: req.params.messageId,
      serverId: req.serverId!,
      userId: req.userId!,
      result: body.result as Parameters<typeof actionCardsService.markActionCardExecuted>[0]["result"],
      expectedConfirmationVersion: typeof (body as { expectedConfirmationVersion?: unknown }).expectedConfirmationVersion === "number"
        ? (body as { expectedConfirmationVersion: number }).expectedConfirmationVersion
        : undefined,
      io: getIo(req),
      orchestrator: getOrchestrator(req),
    });
    // An idempotent replay answers with the stored card, which may predate presentation.card.
    res.json({ messageId: out.messageId, metadata: withStoredActionCardSpec(out.metadata) });
  } catch (err) {
    handleError(req, res, err);
  }
});

// Seat requests (task #10 #proj-commercial): a member or admin asks an owner for
// Pro seats with a card in their DM; the owner adds the seats and completes it.
// Authority as for every card: whether the caller can see the card first
// (cardInHistoryWindow), then what its type takes (an owner). seatRequestService.ts.
actionsRouter.post("/seat-requests", async (req, res) => {
  try {
    const body = seatRequestBodySchema.safeParse(req.body ?? {});
    if (!body.success) {
      res.status(400).json({ error: body.error.issues[0]?.message ?? "The request is not valid", errorCode: "INVALID_REQUEST" });
      return;
    }
    const out = await seatRequestService.requestSeats({
      io: getIo(req),
      orchestrator: getOrchestrator(req),
      serverId: req.serverId!,
      requesterUserId: req.userId!,
      ownerUserId: body.data.ownerUserId,
      purpose: body.data.purpose,
      reason: body.data.reason,
    });
    res.status(out.existing ? 200 : 201).json(out);
  } catch (err) {
    handleError(req, res, err);
  }
});

// A member or admin of a Free server asks an owner for Pro (the upgrade dialog's
// "ask an owner"): the same plan:upgrade card an agent offers it with.
actionsRouter.post("/upgrade-requests", async (req, res) => {
  try {
    const body = upgradeRequestBodySchema.safeParse(req.body ?? {});
    if (!body.success) {
      res.status(400).json({ error: body.error.issues[0]?.message ?? "The request is not valid", errorCode: "INVALID_REQUEST" });
      return;
    }
    const out = await seatRequestService.requestUpgrade({
      io: getIo(req),
      orchestrator: getOrchestrator(req),
      serverId: req.serverId!,
      requesterUserId: req.userId!,
      ownerUserId: body.data.ownerUserId,
      gate: body.data.gate,
      reason: body.data.reason,
    });
    res.status(out.existing ? 200 : 201).json(out);
  } catch (err) {
    handleError(req, res, err);
  }
});

// Before an owner pays for a request: can the requester still do it, and how
// many seats are short now. Owners only.
actionsRouter.get("/:messageId/seat-request", async (req, res) => {
  try {
    if (!await cardInHistoryWindow(req, res)) return;
    res.json(await seatRequestService.checkSeatRequest({
      io: getIo(req),
      orchestrator: getOrchestrator(req),
      serverId: req.serverId!,
      userId: req.userId!,
      messageId: req.params.messageId,
    }));
  } catch (err) {
    handleError(req, res, err);
  }
});

actionsRouter.post("/:messageId/seats-added", async (req, res) => {
  try {
    if (!await cardInHistoryWindow(req, res)) return;
    const out = await seatRequestService.completeSeatRequest({
      io: getIo(req),
      orchestrator: getOrchestrator(req),
      serverId: req.serverId!,
      userId: req.userId!,
      messageId: req.params.messageId,
    });
    // Served as every card is (withStoredActionCardSpec).
    res.json({ messageId: req.params.messageId, metadata: withStoredActionCardSpec(out.metadata), outcome: out.outcome });
  } catch (err) {
    handleError(req, res, err);
  }
});

// After an agent's seat request is done, the owner sends the requester an
// ordinary agent:create card in the same DM (named from the outcome only;
// one per request, a repeat answers with it).
actionsRouter.post("/:messageId/send-create-agent-card", async (req, res) => {
  try {
    if (!await cardInHistoryWindow(req, res)) return;
    const out = await seatRequestService.sendCreateAgentCard({
      io: getIo(req),
      orchestrator: getOrchestrator(req),
      serverId: req.serverId!,
      userId: req.userId!,
      messageId: req.params.messageId,
    });
    res.status(out.existing ? 200 : 201).json(out);
  } catch (err) {
    handleError(req, res, err);
  }
});

// Explicit post-cutover confirmation. This endpoint is deliberately separate
// from execute/mark-executed: old prepared credentials cannot be silently
// revived by a stale click or a telemetry /event call.
actionsRouter.post("/:messageId/reconfirm", async (req, res) => {
  try {
    if (!await cardInHistoryWindow(req, res)) return;
    const db = getDb();
    const out = await db.transaction(async (tx) => {
      const [message] = await tx.select({ channelId: messages.channelId }).from(messages).where(eq(messages.id, req.params.messageId));
      if (!message) throw new actionCardsService.ActionCardError(404, "NOT_FOUND", "Card message not found");
      await assertChannelWritableInTransaction(tx, message.channelId);
      await actionCardsService.assertActionCardWritableByUser({
        messageId: req.params.messageId, channelId: message.channelId,
        userId: req.userId!, serverId: req.serverId!, executor: tx as ReturnType<typeof getDb>, lock: true,
      });
      return reconfirmActionCard(tx, { messageId: req.params.messageId, userId: req.userId! });
    });
    const io = getIo(req);
    if (io) await actionCardsService.emitActionCardMessageUpdated(io, { id: req.params.messageId });
    // Served as every read serves a prepared card: with its deadline (stored without it).
    res.json({ messageId: req.params.messageId, metadata: servedActionCardMetadata(out.metadata, out.card), confirmationVersion: out.confirmationVersion });
  } catch (err) {
    handleError(req, res, err);
  }
});
