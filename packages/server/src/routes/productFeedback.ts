import { Router, type NextFunction, type Request, type Response, type Router as RouterType } from "express";
import { UUID_RE } from "../lib/messageId";
import multer from "multer";
import { Readable, Transform } from "node:stream";
import { pipeline } from "node:stream/promises";
import { eq } from "drizzle-orm";
import { getDb } from "../db/index";
import { users } from "../db/schema";
import {
  asFeedbackReportId,
  ProductFeedbackConfigurationError,
  ProductFeedbackValidationError,
  isProductFeedbackConfigured,
  normalizeProductFeedbackMetadata,
  parseProductFeedbackDiagnostics,
  type ProductFeedbackKind,
  type ProductFeedbackPresignedAttachment,
  type ProductFeedbackReporterAttribution,
} from "../services/productFeedbackService";
import {
  buildProductFeedbackContact,
  FeedbackCardSenderNotMemberError,
  findFeedbackServerMembership,
  productFeedbackMessage,
  productFeedbackRouteBindingLog,
  productFeedbackSendFailure,
  productFeedbackSourceUnavailableLog,
  resolveReporterAttribution,
  sendFeedbackCard,
  submitBoundProductFeedback,
  type FeedbackCardSent,
  type ProductFeedbackCardResult,
} from "../services/productFeedbackSendService";
import type { Server as SocketServer } from "socket.io";
import { asServerId, type ActionCardMetadata, type ServerId } from "@botiverse/raft-shared";
import * as actionCardsService from "../services/actionCardsService";
import { getServerHistoryWindowForRead, isBehindHistoryWindow } from "../services/historyWindow";
import type { AgentOrchestrator } from "../services/agentOrchestrator";
import {
  closeProductFeedbackTicket,
  commentOnProductFeedbackTicket,
  getProductFeedbackAttachment,
  getProductFeedbackTicket,
  isCanonicalUuid,
  listProductFeedbackTickets,
  ProductFeedbackConversationError,
  productFeedbackConversationFailureLog,
} from "../services/productFeedbackConversationService";
import {
  ensureProductFeedbackRouteBinding,
  isTransientHandsFailure,
  ProductFeedbackRouteBindingError,
} from "../services/productFeedbackRouteBindingService";
import { productFeedbackServerTiming } from "../services/productFeedbackTiming";
import { pushProductFeedbackAppUnread, pushProductFeedbackUnread } from "../services/productFeedbackUnreadRealtime";
import { addTraceEvent } from "../tracing/semanticTrace";
import {
  isProductFeedbackSource,
  ProductFeedbackSourceUnavailableError,
  resolveProductFeedbackEnv,
  type ProductFeedbackSource,
} from "../services/productFeedbackApps";

// Moved to the send service (both a card's dialog and its form file through it); kept here for importers.
export { buildProductFeedbackContact };
import { sendJsonServerError } from "./errorResponse";

export const productFeedbackRouter: RouterType = Router();

export const PRODUCT_FEEDBACK_MAX_ATTACHMENTS = 3;
export const PRODUCT_FEEDBACK_MAX_ATTACHMENT_BYTES = 10 * 1024 * 1024;
const ALLOWED_IMAGE_TYPES = new Set(["image/gif", "image/jpeg", "image/png", "image/webp"]);

function setUpstreamTiming(
  res: Response,
  startedAt: number,
  handsServerTiming: string | null,
): void {
  res.setHeader(
    "Server-Timing",
    productFeedbackServerTiming(performance.now() - startedAt, handsServerTiming),
  );
}

const upload = multer({
  storage: multer.memoryStorage(),
  limits: {
    fileSize: PRODUCT_FEEDBACK_MAX_ATTACHMENT_BYTES,
    files: PRODUCT_FEEDBACK_MAX_ATTACHMENTS,
    // type, message, submission_id, may_contact, metadata, feedback_report_id,
    // diagnostics, action_card_message_id, expected_confirmation_version.
    fields: 10,
  },
});

export function runProductFeedbackUpload(req: Request, res: Response, next: NextFunction): void {
  upload.array("attachments", PRODUCT_FEEDBACK_MAX_ATTACHMENTS)(req, res, (err: unknown) => {
    if (err instanceof multer.MulterError) {
      if (err.code === "LIMIT_FILE_SIZE") {
        res.status(413).json({
          error: "Each screenshot must be 10MB or smaller",
          code: "feedback_attachment_too_large",
        });
        return;
      }
      if (err.code === "LIMIT_FILE_COUNT" || err.code === "LIMIT_UNEXPECTED_FILE") {
        res.status(400).json({
          error: `Attach at most ${PRODUCT_FEEDBACK_MAX_ATTACHMENTS} screenshots`,
          code: "feedback_attachment_count_invalid",
        });
        return;
      }
    }
    if (err) {
      res.status(400).json({ error: "Invalid feedback upload", code: "feedback_upload_invalid" });
      return;
    }
    next();
  });
}

function cleanField(value: unknown, maxLength: number): string | undefined {
  if (typeof value !== "string") return undefined;
  const trimmed = value.trim();
  return trimmed ? trimmed.slice(0, maxLength) : undefined;
}

function parseMetadata(value: unknown): Record<string, unknown> {
  if (typeof value !== "string" || !value.trim()) return {};
  try {
    const parsed = JSON.parse(value) as unknown;
    return parsed && typeof parsed === "object" && !Array.isArray(parsed)
      ? parsed as Record<string, unknown>
      : {};
  } catch {
    return {};
  }
}

/**
 * Log an attribution resolution failure without leaking the submitted header
 * value or any identifier. Attribution is optional context, so a failure here is
 * recorded and swallowed rather than surfaced to the reporter.
 */
function productFeedbackAttributionFailureLog(error: unknown): void {
  const name = error instanceof Error ? error.name : "UnknownError";
  console.warn(`[product-feedback] reporter attribution skipped (${name})`);
}

function trustedFeedbackClientKind(req: Request): string | undefined {
  const raw = req.get("x-raft-client-kind") ?? req.get("x-slock-client-kind");
  return raw?.trim() || undefined;
}

class ProductFeedbackSourceInvalidError extends Error {}

/** The Hands app of the calling client: the trusted header, default web. The list reads only this one. */
function conversationFeedbackSource(req: Request): ProductFeedbackSource {
  const raw = trustedFeedbackClientKind(req);
  if (raw === undefined) return "web";
  if (!isProductFeedbackSource(raw)) throw new ProductFeedbackSourceInvalidError();
  return raw;
}

/**
 * The Hands app one ticket lives in. `?platform=` names it outright: a ticket
 * link copied in a mobile App carries it, so the web can open that ticket.
 * Without it, the caller's own app. Either way the reporter is the signed-in
 * user, so `platform` reaches only that user's own tickets in the named app.
 */
function ticketFeedbackSource(req: Request): ProductFeedbackSource {
  const raw = req.query.platform;
  if (raw === undefined) return conversationFeedbackSource(req);
  if (!isProductFeedbackSource(raw)) throw new ProductFeedbackSourceInvalidError();
  return raw;
}

function positiveInt(value: unknown, fallback: number, max: number): number | null {
  if (value === undefined) return fallback;
  if (typeof value !== "string" || !/^\d+$/.test(value)) return null;
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) && parsed >= 1 && parsed <= max ? parsed : null;
}

function sendConversationError(res: Response, error: unknown): boolean {
  if (error instanceof ProductFeedbackSourceInvalidError) {
    res.status(400).json({ error: "Invalid feedback request", code: "feedback_invalid" });
    return true;
  }
  if (error instanceof ProductFeedbackSourceUnavailableError) productFeedbackSourceUnavailableLog(error);
  if (error instanceof ProductFeedbackRouteBindingError) productFeedbackRouteBindingLog(error);
  if (error instanceof ProductFeedbackRouteBindingError || error instanceof ProductFeedbackSourceUnavailableError) {
    // Binding failures are transient in practice (a fresh task's first calls to
    // Hands); tell clients when retrying is reasonable.
    if (error instanceof ProductFeedbackRouteBindingError) res.setHeader("Retry-After", "5");
    res.status(503).json({
      error: "Feedback service is temporarily unavailable",
      code: "feedback_integration_unavailable",
    });
    return true;
  }
  if (!(error instanceof ProductFeedbackConversationError)) return false;
  if (error.retryAfterSeconds !== null) {
    res.setHeader("Retry-After", String(error.retryAfterSeconds));
  }
  res.status(error.status).json({
    error: error.code === "feedback_not_found"
      ? "Feedback ticket not found"
      : error.code === "feedback_invalid"
        ? "Invalid feedback request"
        : error.code === "feedback_comment_conflict"
          ? "This comment retry does not match the original submission"
          : error.code === "feedback_rate_limited"
            ? "Too many feedback requests. Please try again later."
            : "Feedback service is temporarily unavailable",
    code: error.code,
    ...(error.retryAfterSeconds === null ? {} : { retry_after_seconds: error.retryAfterSeconds }),
  });
  return true;
}

/** Absent: undefined; a canonical UUID: the value; anything else: null. */
function optionalUuidField(value: unknown): string | null | undefined {
  if (value === undefined) return undefined;
  return typeof value === "string" && UUID_RE.test(value) ? value : null;
}

/** Absent: undefined; a positive integer: the value; anything else: null. */
function optionalVersionField(value: unknown): number | null | undefined {
  if (value === undefined) return undefined;
  return typeof value === "string" && /^[1-9]\d{0,8}$/.test(value) ? Number(value) : null;
}

/** Action-card refusals (ActionCardError and the conversion errors) carry a status and code. */
function feedbackCardRefusal(error: unknown): { status: number; code: string; message: string } | null {
  if (!(error instanceof Error) || !("status" in error) || !("code" in error)) return null;
  const { status, code } = error as Error & { status: unknown; code: unknown };
  if (typeof status !== "number" || typeof code !== "string") return null;
  return { status, code, message: error.message };
}

function sendFeedbackCardRefusal(res: Response, error: unknown): boolean {
  const refusal = feedbackCardRefusal(error);
  if (!refusal) return false;
  res.status(refusal.status).json({ error: refusal.message, code: refusal.code });
  return true;
}

/**
 * Mark the card done once Hands has filed it, with the result sendFeedbackCard
 * built from the receipt. The ticket exists either way: if the card can no
 * longer be marked (sent from another tab, reconverted), the reporter still
 * gets the receipt and the miss is logged.
 */
async function completeFeedbackCard(
  req: Request,
  card: { messageId: string; viewerServerId: ServerId },
  userId: string,
  expectedConfirmationVersion: number | undefined,
  result: ProductFeedbackCardResult,
): Promise<{ message_id: string; metadata: ActionCardMetadata } | null> {
  try {
    const out = await actionCardsService.markFeedbackCardSubmitted({
      messageId: card.messageId,
      serverId: card.viewerServerId,
      userId,
      expectedConfirmationVersion,
      result,
      io: (req.app.get("io") ?? null) as SocketServer | null,
      orchestrator: (req.app.get("agentOrchestrator") ?? null) as AgentOrchestrator | null,
    });
    return { message_id: out.messageId, metadata: out.metadata };
  } catch (error) {
    const code = error instanceof Error && "code" in error && typeof error.code === "string" ? error.code : "unknown";
    // A fixed code only; never the card, ticket or text.
    console.warn(`[product-feedback] filed feedback card could not be marked done (${code})`);
    return null;
  }
}

/**
 * Hands slow or refusing for a moment, as on a fresh task right after a deploy
 * (v1.21.49 switch: 95 list 503s from binding and read timeouts and the open
 * breaker). Configuration and authorization failures are not: those stay
 * errors so they are seen.
 */
function transientFeedbackReadFailure(error: unknown): { step: "binding" | "read"; reason: string } | null {
  if (error instanceof ProductFeedbackRouteBindingError) {
    return error.reason === "circuit_open" || isTransientHandsFailure(error.reason)
      ? { step: "binding", reason: error.reason }
      : null;
  }
  if (!(error instanceof ProductFeedbackConversationError) || error.code !== "feedback_service_unavailable") return null;
  const { stage, upstreamStatus } = error.diagnostic;
  const transient = stage === "breaker_open"
    || stage === "upstream_transport"
    || stage === "reporter_session_transport"
    || ((stage === "upstream_response" || stage === "reporter_session_response") && upstreamStatus !== null && upstreamStatus >= 500);
  return transient ? { step: "read", reason: stage } : null;
}

/** Seconds a client that asked for degraded answers waits before listing again. */
const DEGRADED_LIST_RETRY_AFTER_SECONDS = 5;

productFeedbackRouter.get("/tickets", async (req, res) => {
  // Opt-in (`degraded_ok=1`, first page only): an older client reads an empty
  // list as "no feedback" and its unread_total as 0, so it keeps the 503.
  const degradedOk = req.query.degraded_ok === "1" && req.query.cursor === undefined;
  const limit = positiveInt(req.query.limit, 20, 50);
  const cursor = typeof req.query.cursor === "string" ? req.query.cursor : undefined;
  if (limit === null || (req.query.cursor !== undefined && cursor === undefined)) {
    res.status(400).json({ error: "Invalid feedback request", code: "feedback_invalid" });
    return;
  }
  try {
    const env = await resolveProductFeedbackEnv({ source: conversationFeedbackSource(req) });
    const { reporterId } = await ensureProductFeedbackRouteBinding({ userId: req.userId!, env });
    const upstreamStartedAt = performance.now();
    let handsServerTiming: string | null = null;
    const list = await listProductFeedbackTickets({
      userId: req.userId!, reporterId, limit, cursor, env,
      onUpstreamServerTiming: (value) => { handsServerTiming = value; },
    });
    setUpstreamTiming(res, upstreamStartedAt, handsServerTiming);
    res.json(list);
  } catch (error) {
    const transient = degradedOk ? transientFeedbackReadFailure(error) : null;
    if (transient) {
      if (error instanceof ProductFeedbackRouteBindingError) productFeedbackRouteBindingLog(error);
      // A degraded answer is a 200, so the request span alone no longer shows
      // it: count these by step and fixed reason code (Tenny).
      addTraceEvent("server.product_feedback.list_degraded", { step: transient.step, reason: transient.reason });
      res.setHeader("Retry-After", String(DEGRADED_LIST_RETRY_AFTER_SECONDS));
      // unread_total null, not 0: the count is unknown, and a client must keep
      // the one it has.
      res.json({ tickets: [], next_cursor: null, unread_total: null, degraded: true, retry_after_seconds: DEGRADED_LIST_RETRY_AFTER_SECONDS });
      return;
    }
    if (!sendConversationError(res, error)) {
      console.error("[ProductFeedback] Failed to list feedback", error);
      res.status(503).json({ error: "Feedback service is temporarily unavailable", code: "feedback_service_unavailable" });
    }
  }
});

productFeedbackRouter.get("/tickets/:ticketId", async (req, res) => {
  const ticketId = req.params.ticketId ?? "";
  const commentLimit = positiveInt(req.query.comment_limit, 50, 100);
  const commentCursor = typeof req.query.comment_cursor === "string" ? req.query.comment_cursor : undefined;
  if (!isCanonicalUuid(ticketId)) {
    res.status(404).json({ error: "Feedback ticket not found", code: "feedback_not_found" });
    return;
  }
  if (commentLimit === null || (req.query.comment_cursor !== undefined && commentCursor === undefined)) {
    res.status(400).json({ error: "Invalid feedback request", code: "feedback_invalid" });
    return;
  }
  try {
    const source = ticketFeedbackSource(req);
    const env = await resolveProductFeedbackEnv({ source });
    const { reporterId } = await ensureProductFeedbackRouteBinding({ userId: req.userId!, env });
    const upstreamStartedAt = performance.now();
    let handsServerTiming: string | null = null;
    const detail = await getProductFeedbackTicket({
      userId: req.userId!, reporterId, ticketId, commentLimit, commentCursor, env,
      onUpstreamServerTiming: (value) => { handsServerTiming = value; },
    });
    setUpstreamTiming(res, upstreamStartedAt, handsServerTiming);
    res.json(detail);
    // This read moved the reporter's read receipt in the app the ticket lives
    // in: the user's other tabs and devices get that app's new total (the one
    // Hands just answered, no extra call), so their unread dot clears. Each
    // app has its own total and event (productFeedbackUnreadRealtime): the
    // web event carries the web app's only, so a mobile app's ticket, also
    // one the web opened by its link (`platform`), goes out as that app's.
    if (source === "web") pushProductFeedbackUnread(req.userId!, detail.unread_total);
    else pushProductFeedbackAppUnread(req.userId!, source, detail.unread_total);
  } catch (error) {
    if (!sendConversationError(res, error)) {
      console.error("[ProductFeedback] Failed to read feedback", error);
      res.status(503).json({ error: "Feedback service is temporarily unavailable", code: "feedback_service_unavailable" });
    }
  }
});

productFeedbackRouter.post("/tickets/:ticketId/comments", runProductFeedbackUpload, async (req, res) => {
  const rawTicketId = req.params.ticketId;
  const ticketId = typeof rawTicketId === "string" ? rawTicketId : "";
  if (!isCanonicalUuid(ticketId)) {
    res.status(404).json({ error: "Feedback ticket not found", code: "feedback_not_found" });
    return;
  }
  const body = typeof req.body?.body === "string" ? req.body.body : "";
  const submissionId = typeof req.body?.submission_id === "string" ? req.body.submission_id : "";
  const files = (req.files ?? []) as Express.Multer.File[];
  if (files.some((file) => !ALLOWED_IMAGE_TYPES.has(file.mimetype))) {
    res.status(400).json({
      error: "Feedback attachments must be PNG, JPEG, GIF, or WebP images",
      code: "feedback_attachment_type_invalid",
    });
    return;
  }
  try {
    const env = await resolveProductFeedbackEnv({ source: ticketFeedbackSource(req) });
    const { reporterId } = await ensureProductFeedbackRouteBinding({ userId: req.userId!, env });
    const result = await commentOnProductFeedbackTicket({
      reporterId,
      ticketId,
      body,
      submissionId,
      attachments: files.map((file) => ({
        buffer: file.buffer,
        filename: file.originalname,
        contentType: file.mimetype,
      })),
      env,
    });
    res.status(result.status).json(result.comment);
  } catch (error) {
    if (!sendConversationError(res, error)) {
      console.error("[ProductFeedback] Failed to comment on feedback", error);
      res.status(503).json({ error: "Feedback service is temporarily unavailable", code: "feedback_service_unavailable" });
    }
  }
});

productFeedbackRouter.post("/tickets/:ticketId/close", async (req, res) => {
  const rawTicketId = req.params.ticketId;
  const ticketId = typeof rawTicketId === "string" ? rawTicketId : "";
  if (!isCanonicalUuid(ticketId)) {
    res.status(404).json({ error: "Feedback ticket not found", code: "feedback_not_found" });
    return;
  }
  const reason = req.body?.reason;
  if (reason !== "completed" && reason !== "no_longer_needed") {
    res.status(400).json({
      error: "Feedback close reason is invalid",
      code: "feedback_invalid",
    });
    return;
  }
  try {
    const env = await resolveProductFeedbackEnv({ source: ticketFeedbackSource(req) });
    const { reporterId } = await ensureProductFeedbackRouteBinding({ userId: req.userId!, env });
    const result = await closeProductFeedbackTicket({ reporterId, ticketId, reason, env });
    res.json({ id: ticketId, ...result });
  } catch (error) {
    if (error instanceof ProductFeedbackConversationError) {
      console.error(
        "[ProductFeedback] Conversation failure",
        productFeedbackConversationFailureLog("close", error),
      );
    }
    if (!sendConversationError(res, error)) {
      console.error("[ProductFeedback] Failed to close feedback", error);
      res.status(503).json({
        error: "Feedback service is temporarily unavailable",
        code: "feedback_service_unavailable",
      });
    }
  }
});

productFeedbackRouter.get("/tickets/:ticketId/attachments/:attachmentId", async (req, res) => {
  const ticketId = req.params.ticketId ?? "";
  const attachmentId = req.params.attachmentId ?? "";
  if (!isCanonicalUuid(ticketId) || !isCanonicalUuid(attachmentId)) {
    res.status(404).json({ error: "Feedback ticket not found", code: "feedback_not_found" });
    return;
  }
  try {
    const env = await resolveProductFeedbackEnv({ source: ticketFeedbackSource(req) });
    const { reporterId } = await ensureProductFeedbackRouteBinding({ userId: req.userId!, env });
    const stream = await getProductFeedbackAttachment({
      userId: req.userId!, reporterId, ticketId, attachmentId, env,
    });
    const cleanup = () => stream.abort();
    res.once("close", cleanup);
    try {
      const encoded = encodeURIComponent(stream.filename).replace(/['()]/g, (char) => `%${char.charCodeAt(0).toString(16).toUpperCase()}`);
      const ascii = stream.filename.replace(/[^\x20-\x7e]/g, "_").replace(/["\\]/g, "_");
      res.setHeader("Content-Type", stream.contentType);
      res.setHeader("Content-Length", String(stream.metadata.size_bytes));
      res.setHeader("Content-Disposition", `attachment; filename="${ascii}"; filename*=UTF-8''${encoded}`);
      res.setHeader("X-Content-Type-Options", "nosniff");
      res.setHeader("Cache-Control", "private, no-store");
      const readable = Readable.fromWeb(stream.response.body! as import("node:stream/web").ReadableStream);
      let streamedBytes = 0;
      const exactLength = new Transform({
        transform(chunk: Buffer, _encoding, callback) {
          streamedBytes += chunk.length;
          if (streamedBytes > stream.metadata.size_bytes) {
            callback(new Error("Feedback attachment exceeded its declared size"));
            return;
          }
          callback(null, chunk);
        },
        flush(callback) {
          callback(streamedBytes === stream.metadata.size_bytes
            ? undefined
            : new Error("Feedback attachment ended before its declared size"));
        },
      });
      await pipeline(readable, exactLength, res);
    } finally {
      res.off("close", cleanup);
      cleanup();
    }
  } catch (error) {
    if (res.headersSent) {
      res.destroy(error instanceof Error ? error : undefined);
      return;
    }
    if (!sendConversationError(res, error)) {
      console.error("[ProductFeedback] Failed to stream feedback attachment", error);
      res.status(503).json({ error: "Feedback service is temporarily unavailable", code: "feedback_service_unavailable" });
    }
  }
});

// The draft of a `feedback:submit` card, for the mobile feedback page that
// opens it prefilled (/feedback/?actionCard=…&server=…). The same checks as
// sending it from the server in X-Server-Id, minus the confirmation version,
// which it returns for that send. Writes nothing and never calls Hands. Every
// refusal is the same 404, which does not say why; the page then opens as usual.
productFeedbackRouter.get("/action-card/:messageId", async (req, res) => {
  const userId = req.userId!;
  const messageId = req.params.messageId ?? "";
  const headerServerId = typeof req.headers["x-server-id"] === "string" ? req.headers["x-server-id"].trim() : "";
  const unavailable = () => {
    res.status(404).json({ error: "Feedback card unavailable", code: "feedback_card_unavailable" });
  };
  if (!UUID_RE.test(messageId) || !UUID_RE.test(headerServerId)) {
    unavailable();
    return;
  }
  try {
    const draft = await actionCardsService.readSendableFeedbackCardDraft({
      messageId,
      serverId: asServerId(headerServerId),
      userId,
    });
    // A send also requires membership of the card's server (its attribution).
    if (!await findFeedbackServerMembership(draft.targetServerId, userId)) {
      unavailable();
      return;
    }
    // A card behind the plan's history window is not this reader's to open
    // (services/historyWindow.ts); it refuses like the rest. Its time is the
    // one the card's visibility check read.
    if (isBehindHistoryWindow(draft.messageCreatedAt, await getServerHistoryWindowForRead(headerServerId))) {
      unavailable();
      return;
    }
    res.json({
      message_id: messageId,
      feedback_type: draft.feedbackType,
      message: draft.message,
      confirmation_version: draft.confirmationVersion,
    });
  } catch (error) {
    const refusal = feedbackCardRefusal(error);
    if (refusal && refusal.status >= 400 && refusal.status < 500) {
      unavailable();
      return;
    }
    sendJsonServerError(req, res, { error: "Failed to read feedback card", code: "feedback_card_read_failed", logPrefix: "[ProductFeedback] Failed to read feedback card", err: error });
  }
});

productFeedbackRouter.post("/", runProductFeedbackUpload, async (req, res) => {
  const userId = req.userId!;
  const kind: ProductFeedbackKind | null = req.body?.type === "idea"
    ? "idea"
    : req.body?.type === "problem"
      ? "problem"
      : null;
  const message = productFeedbackMessage(req.body?.message);
  const submissionId = cleanField(req.body?.submission_id, 64);
  const mayContact = req.body?.may_contact === "true";
  const metadata = parseMetadata(req.body?.metadata);
  const files = (req.files ?? []) as Express.Multer.File[];
  const rawFeedbackReportId = req.body?.feedback_report_id;
  const feedbackReportId = rawFeedbackReportId === undefined ? undefined : asFeedbackReportId(rawFeedbackReportId);
  // Sent from a `feedback:submit` action card's dialog: the card is checked
  // before Hands and completed after it, from the receipt.
  const cardMessageId = optionalUuidField(req.body?.action_card_message_id);
  const expectedConfirmationVersion = optionalVersionField(req.body?.expected_confirmation_version);

  if (
    !kind || !message || !submissionId || !UUID_RE.test(submissionId) || feedbackReportId === null
    || cardMessageId === null || expectedConfirmationVersion === null
    || (cardMessageId === undefined && expectedConfirmationVersion !== undefined)
    || (cardMessageId !== undefined && feedbackReportId !== undefined)
  ) {
    res.status(400).json({ error: "Invalid feedback submission", code: "feedback_invalid" });
    return;
  }
  const unsupportedAttachment = files.find((file) => !ALLOWED_IMAGE_TYPES.has(file.mimetype));
  if (unsupportedAttachment) {
    res.status(400).json({
      error: "Feedback attachments must be PNG, JPEG, GIF, or WebP images",
      code: "feedback_attachment_type_invalid",
    });
    return;
  }
  let feedbackMetadata: ReturnType<typeof normalizeProductFeedbackMetadata>;
  try {
    feedbackMetadata = normalizeProductFeedbackMetadata({
      trustedClientKind: trustedFeedbackClientKind(req),
      clientKind: metadata.client_kind,
      platform: metadata.platform,
      clientVersion: metadata.client_version,
      webVersion: metadata.web_version,
      locale: metadata.locale,
      browser: metadata.browser,
      osVersion: metadata.os_version,
      viewport: metadata.viewport,
    });
  } catch (error) {
    if (error instanceof ProductFeedbackValidationError) {
      res.status(400).json({ error: "Invalid feedback submission", code: "feedback_invalid" });
      return;
    }
    throw error;
  }
  let diagnostics: ProductFeedbackPresignedAttachment | null;
  try {
    diagnostics = parseProductFeedbackDiagnostics(req.body?.diagnostics, feedbackMetadata.clientKind);
  } catch (error) {
    if (error instanceof ProductFeedbackValidationError) {
      res.status(400).json({ error: "Invalid feedback diagnostics", code: "feedback_diagnostics_invalid" });
      return;
    }
    throw error;
  }

  const [user] = await getDb().select({
    email: users.email,
    name: users.name,
    displayName: users.displayName,
  }).from(users).where(eq(users.id, userId));
  if (!user) {
    res.status(401).json({ error: "Unauthorized", code: "auth_required" });
    return;
  }

  // Reporter attribution is optional, best-effort context. The server id arrives
  // via the standard `X-Server-Id` header that the client already attaches; a
  // missing header (older clients) or a failed membership check simply yields no
  // attribution and must not block the submission itself.
  // Attribution must never be able to fail a submission. The header is
  // attacker-controlled, so it is shape-checked before it can reach a uuid
  // column, and the whole resolution is additionally wrapped so that any
  // unexpected failure degrades to "no attribution" instead of a 500 — the
  // reporter's feedback is what matters, not the context we attach to it.
  const rawHeaderServerId = typeof req.headers["x-server-id"] === "string"
    ? req.headers["x-server-id"].trim()
    : "";
  const headerServerId = UUID_RE.test(rawHeaderServerId) ? rawHeaderServerId : null;

  // A card submission is refused before anything reaches Hands unless the
  // caller may operate the card (as for executing any card), it still waits
  // and its confirmation is current. sendFeedbackCard then requires the
  // attribution and derives it: the card's server, plus who drafted it (the
  // card's form files through it too).
  let feedbackCard: { messageId: string; viewerServerId: ServerId; requesterAgentId: string; targetServerId: ServerId } | null = null;
  if (cardMessageId !== undefined) {
    if (!headerServerId) {
      res.status(400).json({ error: "Invalid feedback submission", code: "feedback_invalid" });
      return;
    }
    try {
      const card = await actionCardsService.assertFeedbackCardSendable({
        messageId: cardMessageId,
        serverId: asServerId(headerServerId),
        userId,
        expectedConfirmationVersion,
      });
      feedbackCard = {
        messageId: cardMessageId,
        viewerServerId: asServerId(headerServerId),
        requesterAgentId: card.requesterAgentId,
        targetServerId: card.targetServerId,
      };
    } catch (error) {
      if (sendFeedbackCardRefusal(res, error)) return;
      sendJsonServerError(req, res, { error: "Failed to submit feedback", code: "feedback_submit_failed", logPrefix: "[ProductFeedback] Failed to check feedback card", err: error });
      return;
    }
  } else {
    let reporterAttribution: ProductFeedbackReporterAttribution | null = null;
    try {
      reporterAttribution = await resolveReporterAttribution({
        serverId: headerServerId,
        userId,
        handle: user.name,
      });
    } catch (error) {
      productFeedbackAttributionFailureLog(error);
    }
    if (reporterAttribution) feedbackMetadata.reporterAttribution = reporterAttribution;
  }

  const attachments = files.map((file) => ({
    buffer: file.buffer,
    filename: file.originalname,
    contentType: file.mimetype,
  }));
  try {
    if (feedbackCard) {
      const upstream = { startedAt: performance.now(), serverTiming: null as string | null };
      const sent: FeedbackCardSent = await sendFeedbackCard({
        card: feedbackCard,
        user: { id: userId, ...user },
        kind,
        message,
        mayContact,
        metadata: feedbackMetadata,
        attachments,
        diagnostics,
        upstream,
      });
      const actionCard = await completeFeedbackCard(req, feedbackCard, userId, expectedConfirmationVersion, sent.result);
      if (!sent.receipt) {
        // Hands already had this person's feedback for this card; the card
        // completed without a ticket (sendFeedbackCard).
        res.status(409).json({
          error: "You already sent this feedback card",
          code: "feedback_card_already_sent",
          ...(actionCard ? { action_card: actionCard } : {}),
        });
        return;
      }
      setUpstreamTiming(res, upstream.startedAt, upstream.serverTiming);
      res.status(201).json(actionCard ? { ...sent.receipt, action_card: actionCard } : sent.receipt);
      return;
    }
    const env = await resolveProductFeedbackEnv({ source: feedbackMetadata.clientKind });
    if (!isProductFeedbackConfigured(env)) throw new ProductFeedbackConfigurationError();
    await ensureProductFeedbackRouteBinding({ userId, env });
    const upstreamStartedAt = performance.now();
    let handsServerTiming: string | null = null;
    const receipt = await submitBoundProductFeedback({
      submissionId,
      kind,
      message,
      contact: mayContact ? buildProductFeedbackContact(user) : null,
      userId,
      metadata: feedbackMetadata,
      ...(feedbackReportId ? { feedbackReportId } : {}),
      ...(diagnostics ? { diagnostics } : {}),
      attachments,
    }, {
      env,
      onUpstreamServerTiming: (value) => { handsServerTiming = value; },
    });
    setUpstreamTiming(res, upstreamStartedAt, handsServerTiming);
    res.status(201).json(receipt);
  } catch (error) {
    if (error instanceof FeedbackCardSenderNotMemberError) {
      res.status(error.status).json({ error: error.message, code: error.code });
      return;
    }
    const failure = productFeedbackSendFailure(error, { withDiagnostics: diagnostics !== null });
    if (failure) {
      if (failure.retryAfter) res.setHeader("Retry-After", failure.retryAfter);
      res.status(failure.status).json({
        error: failure.error,
        code: failure.code,
        ...(failure.upstreamStatus === null ? {} : { upstream_status: failure.upstreamStatus }),
        ...(failure.upstreamError === null ? {} : { upstream_error: failure.upstreamError }),
      });
      return;
    }
    sendJsonServerError(req, res, { error: "Failed to submit feedback", code: "feedback_submit_failed", logPrefix: "[ProductFeedback] Failed to submit feedback", err: error });
  }
});
