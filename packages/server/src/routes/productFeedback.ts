import { Router, type NextFunction, type Request, type Response, type Router as RouterType } from "express";
import multer from "multer";
import { eq } from "drizzle-orm";
import { Readable, Transform } from "node:stream";
import { pipeline } from "node:stream/promises";
import { getDb } from "../db/index.js";
import { users } from "../db/schema.js";
import {
  ProductFeedbackConfigurationError,
  ProductFeedbackUpstreamError,
  ProductFeedbackValidationError,
  isProductFeedbackConfigured,
  normalizeProductFeedbackMetadata,
  submitProductFeedback,
  type ProductFeedbackKind,
} from "../services/productFeedbackService.js";
import {
  closeProductFeedbackTicket,
  commentOnProductFeedbackTicket,
  getProductFeedbackAttachment,
  getProductFeedbackTicket,
  isCanonicalUuid,
  listProductFeedbackTickets,
  ProductFeedbackConversationError,
  productFeedbackConversationFailureLog,
} from "../services/productFeedbackConversationService.js";
import {
  ensureProductFeedbackRouteBinding,
  ProductFeedbackRouteBindingError,
} from "../services/productFeedbackRouteBindingService.js";
import { productFeedbackServerTiming } from "../services/productFeedbackTiming.js";

export const productFeedbackRouter: RouterType = Router();

export const PRODUCT_FEEDBACK_MAX_ATTACHMENTS = 3;
export const PRODUCT_FEEDBACK_MAX_ATTACHMENT_BYTES = 10 * 1024 * 1024;
const PRODUCT_FEEDBACK_MAX_MESSAGE_LENGTH = 10_000;
const CANONICAL_UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
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
    fields: 8,
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

function trustedFeedbackClientKind(req: Request): string | undefined {
  const raw = req.get("x-raft-client-kind") ?? req.get("x-slock-client-kind");
  return raw?.trim() || undefined;
}

function mapUpstreamError(error: ProductFeedbackUpstreamError): { status: number; code: string } {
  if (error.upstreamStatus === 401 || error.upstreamStatus === 403) {
    return { status: 503, code: "feedback_integration_unavailable" };
  }
  if (error.upstreamStatus === 409) return { status: 409, code: "feedback_submission_conflict" };
  if (error.upstreamStatus === 413) return { status: 413, code: "feedback_attachment_too_large" };
  if (error.upstreamStatus === 429) return { status: 429, code: "feedback_rate_limited" };
  if (error.upstreamStatus === 400) return { status: 400, code: "feedback_invalid" };
  return { status: 503, code: "feedback_service_unavailable" };
}

function positiveInt(value: unknown, fallback: number, max: number): number | null {
  if (value === undefined) return fallback;
  if (typeof value !== "string" || !/^\d+$/.test(value)) return null;
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) && parsed >= 1 && parsed <= max ? parsed : null;
}

function sendConversationError(res: Response, error: unknown): boolean {
  if (error instanceof ProductFeedbackRouteBindingError) {
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

export function buildProductFeedbackContact(user: {
  email: string;
  name: string;
  displayName: string | null;
}): string {
  return `${user.displayName?.trim() || user.name} (@${user.name}) <${user.email}>`;
}

productFeedbackRouter.get("/tickets", async (req, res) => {
  const limit = positiveInt(req.query.limit, 20, 50);
  const cursor = typeof req.query.cursor === "string" ? req.query.cursor : undefined;
  if (limit === null || (req.query.cursor !== undefined && cursor === undefined)) {
    res.status(400).json({ error: "Invalid feedback request", code: "feedback_invalid" });
    return;
  }
  try {
    const { reporterId } = await ensureProductFeedbackRouteBinding({ userId: req.userId! });
    const upstreamStartedAt = performance.now();
    let handsServerTiming: string | null = null;
    const list = await listProductFeedbackTickets({
      userId: req.userId!, reporterId, limit, cursor,
      onUpstreamServerTiming: (value) => { handsServerTiming = value; },
    });
    setUpstreamTiming(res, upstreamStartedAt, handsServerTiming);
    res.json(list);
  } catch (error) {
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
    const { reporterId } = await ensureProductFeedbackRouteBinding({ userId: req.userId! });
    const upstreamStartedAt = performance.now();
    let handsServerTiming: string | null = null;
    const detail = await getProductFeedbackTicket({
      userId: req.userId!, reporterId, ticketId, commentLimit, commentCursor,
      onUpstreamServerTiming: (value) => { handsServerTiming = value; },
    });
    setUpstreamTiming(res, upstreamStartedAt, handsServerTiming);
    res.json(detail);
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
    const { reporterId } = await ensureProductFeedbackRouteBinding({ userId: req.userId! });
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
    const { reporterId } = await ensureProductFeedbackRouteBinding({ userId: req.userId! });
    const result = await closeProductFeedbackTicket({ reporterId, ticketId, reason });
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
    const { reporterId } = await ensureProductFeedbackRouteBinding({ userId: req.userId! });
    const stream = await getProductFeedbackAttachment({
      userId: req.userId!, reporterId, ticketId, attachmentId,
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

productFeedbackRouter.post("/", runProductFeedbackUpload, async (req, res) => {
  const userId = req.userId!;
  const kind: ProductFeedbackKind | null = req.body?.type === "idea"
    ? "idea"
    : req.body?.type === "problem"
      ? "problem"
      : null;
  const rawMessage = typeof req.body?.message === "string" ? req.body.message.trim() : "";
  const message = rawMessage.length > 0 && rawMessage.length <= PRODUCT_FEEDBACK_MAX_MESSAGE_LENGTH
    ? rawMessage
    : undefined;
  const submissionId = cleanField(req.body?.submission_id, 64);
  const mayContact = req.body?.may_contact === "true";
  const metadata = parseMetadata(req.body?.metadata);
  const files = (req.files ?? []) as Express.Multer.File[];

  if (!kind || !message || !submissionId || !CANONICAL_UUID_RE.test(submissionId)) {
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

  const [user] = await getDb().select({
    email: users.email,
    name: users.name,
    displayName: users.displayName,
  }).from(users).where(eq(users.id, userId));
  if (!user) {
    res.status(401).json({ error: "Unauthorized", code: "auth_required" });
    return;
  }

  try {
    if (!isProductFeedbackConfigured()) throw new ProductFeedbackConfigurationError();
    await ensureProductFeedbackRouteBinding({ userId });
    const upstreamStartedAt = performance.now();
    let handsServerTiming: string | null = null;
    const receipt = await submitProductFeedback({
      submissionId,
      kind,
      message,
      contact: mayContact ? buildProductFeedbackContact(user) : null,
      userId,
      metadata: feedbackMetadata,
      attachments: files.map((file) => ({
        buffer: file.buffer,
        filename: file.originalname,
        contentType: file.mimetype,
      })),
    }, {
      onUpstreamServerTiming: (value) => { handsServerTiming = value; },
    });
    setUpstreamTiming(res, upstreamStartedAt, handsServerTiming);
    res.status(201).json(receipt);
  } catch (error) {
    if (error instanceof ProductFeedbackRouteBindingError) {
      res.status(503).json({
        error: "Feedback service is temporarily unavailable",
        code: "feedback_integration_unavailable",
      });
      return;
    }
    if (error instanceof ProductFeedbackConfigurationError) {
      res.status(503).json({
        error: "Product feedback is not configured",
        code: "feedback_not_configured",
      });
      return;
    }
    if (error instanceof ProductFeedbackUpstreamError) {
      const mapped = mapUpstreamError(error);
      if (error.retryAfter) res.setHeader("Retry-After", error.retryAfter);
      res.status(mapped.status).json({
        error: mapped.status === 429
          ? "Too many feedback submissions. Please try again later."
          : mapped.status === 409
            ? "This feedback draft changed after it was submitted. Start a new draft and try again."
            : mapped.status === 400
              ? "Hands rejected this feedback submission"
              : "Feedback service is temporarily unavailable",
        code: mapped.code,
        ...(error.upstreamStatus === null ? {} : { upstream_status: error.upstreamStatus }),
        ...(error.upstreamError === null ? {} : { upstream_error: error.upstreamError }),
      });
      return;
    }
    console.error("[ProductFeedback] Failed to submit feedback", error);
    res.status(500).json({ error: "Failed to submit feedback", code: "feedback_submit_failed" });
  }
});
