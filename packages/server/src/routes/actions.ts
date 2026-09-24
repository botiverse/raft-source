// User-facing API for committing action cards.
//
// Mounted at /api/actions after requireAuth + requireServer.
//
// Two endpoints:
// - POST /:messageId/execute: agent fully prefilled the action; click runs
//   the underlying create under the user's identity.
// - POST /:messageId/mark-executed: dialog-driven flow (agent:create today)
//   — frontend ran the regular create dialog/API and now records the
//   resource reference so the card flips to Done.

import { Router, type Router as RouterType } from "express";
import type { Request, Response } from "express";
import type { Server as SocketServer } from "socket.io";
import * as actionCardsService from "../services/actionCardsService.js";
import * as productEventsService from "../services/productEventsService.js";
import { eq } from "drizzle-orm";
import { getDb } from "../db/index.js";
import { actionCards, messages } from "../db/schema.js";
import * as channelService from "../services/channelService.js";
import type { AgentOrchestrator } from "../services/agentOrchestrator.js";
import type { ActionCardAction } from "@botiverse/raft-shared";

export const actionsRouter: RouterType = Router();

function getIo(req: Request): SocketServer | null {
  return (req.app.get("io") ?? null) as SocketServer | null;
}

function getOrchestrator(req: Request): AgentOrchestrator | null {
  return (req.app.get("agentOrchestrator") ?? null) as AgentOrchestrator | null;
}

function handleError(res: Response, err: unknown): void {
  if (err instanceof actionCardsService.ActionCardError) {
    res.status(err.status).json({ error: err.message, errorCode: err.code });
    return;
  }
  console.error("[actions] unexpected error:", err);
  res.status(500).json({ error: "Internal error" });
}

actionsRouter.post("/migration-export", async (req, res) => {
  void req;
  res.status(410).json({
    error: "Migration action cards are no longer supported. Use POST /api/agents/:agentId/migrate.",
    code: "migration_action_card_not_supported",
  });
});

// POST /api/actions/:messageId/execute
actionsRouter.post("/:messageId/execute", async (req, res) => {
  try {
    const body = (req.body ?? {}) as { expectedState?: unknown };
    const expectedState =
      body.expectedState === "prepared" || body.expectedState === "executed"
        ? body.expectedState
        : undefined;
    const out = await actionCardsService.executeActionCard({
      messageId: req.params.messageId,
      serverId: req.serverId!,
      userId: req.userId!,
      expectedState,
      io: getIo(req),
      orchestrator: getOrchestrator(req),
    });
    res.json({ messageId: out.messageId, metadata: out.metadata });
  } catch (err) {
    handleError(res, err);
  }
});

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
    const allowed = await channelService.canUserAccessChannel(
      row.channelId,
      req.userId!,
      req.serverId!,
    );
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
      meta.action?.type === "integration:update_app_registration"
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
    });

    res.status(204).end();
  } catch (err) {
    handleError(res, err);
  }
});

// POST /api/actions/:messageId/mark-executed
//
// Used by the dialog-driven flow (agent:create today; future variants
// where the user must complete the form themselves). The frontend opens
// the existing create dialog with prefilled fields, the user submits via
// the regular API (e.g. POST /api/agents), and on success the frontend
// calls this endpoint with the resulting resource reference so the card
// flips to Done with a link.
actionsRouter.post("/:messageId/mark-executed", async (req, res) => {
  try {
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
      io: getIo(req),
      orchestrator: getOrchestrator(req),
    });
    res.json({ messageId: out.messageId, metadata: out.metadata });
  } catch (err) {
    handleError(res, err);
  }
});
