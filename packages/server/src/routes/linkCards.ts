import express, { Router, type ErrorRequestHandler, type Request, type RequestHandler, type Response, type Router as RouterType } from "express";
import type { Server as SocketServer } from "socket.io";
import { UUID_RE } from "../lib/messageId";
import {
  executeLinkCardAction, LINK_CARD_EXECUTE_MAX_BODY_BYTES, LINK_CARD_PREPARE_MAX_BODY_BYTES, parseLinkCardExecuteBody, parseLinkCardPrepareBody,
  prepareLinkCardAction, type LinkCardActionResponse,
} from "../services/linkCardActionService";
import type { LinkCardMessageReader } from "../services/linkCardLiveState";
import { linkCardReceiptHints, type LinkCardReceiptHints } from "../services/linkCardReceiptHints";
import {
  LINK_CARD_STATUS_MAX_BODY_BYTES, lookupLinkCardOperations, parseLinkCardOperationsQuery, parseLinkCardStatusBody, readLinkCardOperationStatus,
} from "../services/linkCardReceiptService";
import { LINK_CARD_UPDATE_MAX_BODY_BYTES } from "../services/linkCardUpdateService";
import { readPreviewableMessage } from "./messages";

// Interactive link card actions and receipts (RFC 076 §6.2-§6.4;
// services/linkCardActionService.ts, services/linkCardReceiptService.ts):
// `POST /api/link-cards/prepare`, `POST /api/link-cards/execute`,
// `POST /api/link-cards/status` and `GET /api/link-cards/operations`, for the
// human viewer of an ordinary message. Mounted behind requireAuth,
// requireVerified and requireServer: the viewer and Server are the session's,
// never the handle's. Guests take part on the existing terms: they may act
// only on a message they can still read (the same check as the preview GET).
// Every answer is private and never cached. The App's terminal update,
// `POST /api/oauth/link-preview/card-updates`, lives with the App's other
// link-preview routes (routes/oauth.ts); its body parser is here.

export const LINK_CARD_PREPARE_PATH = "/api/link-cards/prepare";
export const LINK_CARD_EXECUTE_PATH = "/api/link-cards/execute";
export const LINK_CARD_STATUS_PATH = "/api/link-cards/status";
export const LINK_CARD_UPDATES_PATH = "/api/oauth/link-preview/card-updates";
// Bodies are refused above their bound before they are parsed (Tenny); these
// parsers are registered in app.ts ahead of the global one, which then skips
// the parsed body.
export const linkCardPrepareBodyParser: RequestHandler = express.json({ limit: LINK_CARD_PREPARE_MAX_BODY_BYTES });
export const linkCardExecuteBodyParser: RequestHandler = express.json({ limit: LINK_CARD_EXECUTE_MAX_BODY_BYTES });
export const linkCardStatusBodyParser: RequestHandler = express.json({ limit: LINK_CARD_STATUS_MAX_BODY_BYTES });
/**
 * The App's terminal update is kept as raw bytes, whatever its content type, so
 * the strict parser (not JSON.parse, not the form parser) reads it
 * (linkCardUpdateService.ts); a body over the bound is refused unread.
 */
export const linkCardUpdatesBodyParser: RequestHandler = express.raw({ type: () => true, limit: LINK_CARD_UPDATE_MAX_BODY_BYTES });
export const linkCardBodyErrorHandler: ErrorRequestHandler = (err, _req, res, _next) => {
  res.setHeader("Cache-Control", "private, no-store");
  const tooLarge = (err as { type?: unknown }).type === "entity.too.large";
  res.status(tooLarge ? 413 : 400).json({ error: tooLarge ? "Link card request too large" : "Invalid link card request", code: "INVALID_REQUEST" });
};

const BCP47 = /^[A-Za-z]{2,8}(?:-[A-Za-z0-9]{1,8})*$/;
/**
 * The viewer's language for the App call (protocol §5.0: body `locale` and
 * Accept-Language). The prepare and execute bodies carry none, so it is the
 * request's first Accept-Language tag (the web client sends its display
 * language); "en" when there is no usable one.
 */
export function linkCardRequestLocale(header: string | undefined): string {
  const first = header?.split(",")[0]?.split(";")[0]?.trim() ?? "";
  return first.length <= 35 && BCP47.test(first) ? first : "en";
}

export function sendLinkCardResponse(res: Response, result: LinkCardActionResponse) {
  if (result.retryAfterSeconds !== undefined) res.setHeader("Retry-After", String(result.retryAfterSeconds));
  res.status(result.status).json(result.body);
}
const send = sendLinkCardResponse;

const messageReader = (req: Request): LinkCardMessageReader => async (messageId) =>
  (UUID_RE.test(messageId) ? await readPreviewableMessage(req, messageId) : null);

/** Receipt hints through this app's Socket.IO server (RFC 076 §6.8). */
export const requestLinkCardHints = (req: Request): LinkCardReceiptHints => linkCardReceiptHints(req.app.get("io") as SocketServer | undefined);

export const linkCardRouter: RouterType = Router();

linkCardRouter.post("/prepare", async (req, res) => {
  res.setHeader("Cache-Control", "private, no-store");
  const request = parseLinkCardPrepareBody(req.body);
  if (!request) { res.status(400).json({ error: "Invalid link card request", code: "INVALID_REQUEST" }); return; }
  try {
    send(res, await prepareLinkCardAction({
      viewerId: req.userId!, serverId: req.serverId!, request, locale: linkCardRequestLocale(req.get("accept-language")), readMessage: messageReader(req),
    }));
  } catch (error) {
    // Never log the handle, body, endpoint or App answer.
    console.error("[LinkCardPrepare] failed", error instanceof Error ? error.name : "unknown");
    res.status(500).json({ error: "Couldn't prepare this action", code: "INTERNAL" });
  }
});

linkCardRouter.post("/execute", async (req, res) => {
  res.setHeader("Cache-Control", "private, no-store");
  const request = parseLinkCardExecuteBody(req.body);
  if (!request) { res.status(400).json({ error: "Invalid link card request", code: "INVALID_REQUEST" }); return; }
  try {
    send(res, await executeLinkCardAction({
      viewerId: req.userId!, serverId: req.serverId!, request, locale: linkCardRequestLocale(req.get("accept-language")), readMessage: messageReader(req),
      hints: requestLinkCardHints(req),
    }));
  } catch (error) {
    console.error("[LinkCardExecute] failed", error instanceof Error ? error.name : "unknown");
    res.status(500).json({ error: "Couldn't run this action. Try again with the same request.", code: "INTERNAL" });
  }
});

// Status never answers 410 (RFC 076 §6.4): it does not depend on a handle.
linkCardRouter.post("/status", async (req, res) => {
  res.setHeader("Cache-Control", "private, no-store");
  const request = parseLinkCardStatusBody(req.body);
  if (!request) { res.status(400).json({ error: "Invalid link card request", code: "INVALID_REQUEST" }); return; }
  try {
    send(res, await readLinkCardOperationStatus({
      viewerId: req.userId!, serverId: req.serverId!, operationId: request.operationId, locale: linkCardRequestLocale(req.get("accept-language")),
      readMessage: messageReader(req), hints: requestLinkCardHints(req),
    }));
  } catch (error) {
    // Never log the operation's endpoint, assertion or App answer.
    console.error("[LinkCardStatus] failed", error instanceof Error ? error.name : "unknown");
    res.status(500).json({ error: "Couldn't read this action's status. Try again.", code: "INTERNAL" });
  }
});

linkCardRouter.get("/operations", async (req, res) => {
  res.setHeader("Cache-Control", "private, no-store");
  const query = parseLinkCardOperationsQuery(req.query);
  if (!query) { res.status(400).json({ error: "Invalid link card request", code: "INVALID_REQUEST" }); return; }
  try {
    send(res, await lookupLinkCardOperations({ viewerId: req.userId!, serverId: req.serverId!, query, readMessage: messageReader(req) }));
  } catch (error) {
    console.error("[LinkCardOperations] failed", error instanceof Error ? error.name : "unknown");
    res.status(500).json({ error: "Couldn't look up card actions. Try again.", code: "INTERNAL" });
  }
});
