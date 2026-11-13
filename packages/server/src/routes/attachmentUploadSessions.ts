import {
  Router,
  type Request,
  type RequestHandler,
  type Response,
  type Router as RouterType,
} from "express";
import { z } from "zod";
import { PRO_SINGLE_FILE_UPLOAD_LIMIT_BYTES } from "@botiverse/raft-shared";
import type { ServerId } from "@botiverse/raft-shared";
import {
  attachmentUploadContract,
  attachmentUploadPathParamsSchema,
  createAttachmentUploadSessionRequestSchema,
  getAttachmentUploadResponseSchema,
  listAttachmentUploadSessionsPathParamsSchema,
} from "@botiverse/raft-shared/src/attachmentUploadContract";
import * as channelService from "../services/channelService";
import {
  getAttachmentFileSizeLimitBytes,
  getLegacyAttachmentFileSizeLimitBytes,
} from "../services/attachmentUploadPolicy";
import {
  FILE_UPLOAD_QUOTA_EXCEEDED_MESSAGE,
  FILE_UPLOAD_APPSUMO_QUOTA_EXCEEDED_MESSAGE,
  getFileUploadQuotaSummary,
  type FileUploadQuotaSummary,
} from "../services/fileUploadQuotaService";
import { getChannelBillingReadOnly, isChannelReadOnlyByQuota } from "../services/planService";
import { notePaywallHit } from "./paywallHit";
import type { PaywallHitUsage } from "../services/serverProductEvents";

export type AttachmentUploadSessionContext = Readonly<
  | { serverId: ServerId; userId: string; agentId?: never }
  | { serverId: ServerId; agentId: string; userId?: never }
>;

export type CreateAttachmentUploadSessionInput = Readonly<z.infer<typeof createAttachmentUploadSessionRequestSchema>>;

export type AttachmentUploadSessionResult = Readonly<{
  status: number;
  body: unknown;
}>;

export interface AttachmentUploadSessionService {
  capabilities(context: AttachmentUploadSessionContext): Promise<AttachmentUploadSessionResult>;
  listActive(context: AttachmentUploadSessionContext, channelId: string): Promise<AttachmentUploadSessionResult>;
  create(
    context: AttachmentUploadSessionContext,
    input: CreateAttachmentUploadSessionInput,
  ): Promise<AttachmentUploadSessionResult>;
  complete(context: AttachmentUploadSessionContext, uploadId: string): Promise<AttachmentUploadSessionResult>;
  cancel(context: AttachmentUploadSessionContext, uploadId: string): Promise<AttachmentUploadSessionResult>;
  status(context: AttachmentUploadSessionContext, uploadId: string): Promise<AttachmentUploadSessionResult>;
}

type AttachmentUploadSessionRouterOptions = Readonly<{
  securityMiddleware: readonly RequestHandler[];
  createLimiter: RequestHandler;
}>;

const invalidRequestBody = {
  code: "UPLOAD_INVALID_REQUEST",
  message: "The upload request is invalid.",
  retryable: false,
} as const;

const invalidChannelBody = {
  code: "UPLOAD_INVALID_REQUEST",
  message: "The channel id is invalid.",
  retryable: false,
} as const;

const forbiddenBody = {
  code: "UPLOAD_FORBIDDEN",
  message: "The member cannot upload to this channel.",
  retryable: false,
} as const;

const tooLargeBody = {
  code: "UPLOAD_TOO_LARGE",
  message: "The attachment exceeds the plan limit.",
  retryable: false,
} as const;

const rateLimitedBody = {
  code: "UPLOAD_RATE_LIMITED",
  message: "Too many upload sessions were created.",
  retryable: true,
  retryAfterMs: 60_000,
} as const;

/** The monthly quota as the web is told it: null where none is enforced (ordinary Pro). */
function monthlyUpload(quota: FileUploadQuotaSummary) {
  return quota.enforced
    ? { month: quota.month, limitBytes: quota.limitBytes, remainingBytes: quota.remainingBytes, ...(quota.appsumo ? { source: "appsumo" as const } : {}) }
    : null;
}

/**
 * The web's capabilities: the service's (shared with the agent API, whose
 * schema never grows) plus what is left of the monthly quota.
 */
async function webCapabilities(
  service: AttachmentUploadSessionService | null,
  context: AttachmentUploadSessionContext,
): Promise<AttachmentUploadSessionResult> {
  const result = service ? await service.capabilities(context) : await disabledCapabilities(context);
  if (result.status !== 200) return result;
  const quota = await getFileUploadQuotaSummary(context.serverId);
  return { status: 200, body: { ...(result.body as object), monthlyUpload: monthlyUpload(quota) } };
}

async function disabledCapabilities(context: AttachmentUploadSessionContext): Promise<AttachmentUploadSessionResult> {
  const quota = await getFileUploadQuotaSummary(context.serverId);
  return {
    status: 200,
    body: {
      directUploadEnabled: false,
      directUploadThresholdBytes: null,
      maxBytes: getLegacyAttachmentFileSizeLimitBytes(quota.plan),
      sessionExpiresInSeconds: null,
    },
  };
}

type AttachmentUploadOperation = keyof typeof attachmentUploadContract;

export const attachmentUploadRateLimitedResponse = (() => {
  const schema = getAttachmentUploadResponseSchema("create", 429);
  if (!schema) throw new Error("Attachment upload create contract must declare 429");
  return schema.parse(rateLimitedBody);
})();

function sendContractResponse(
  res: Response,
  operation: AttachmentUploadOperation,
  result: AttachmentUploadSessionResult,
): void {
  const schema = getAttachmentUploadResponseSchema(operation, result.status);
  const parsed = schema?.safeParse(result.body);
  if (!parsed?.success) {
    sendInternalContractViolation(res, operation, result.status, parsed?.error.issues.length);
    return;
  }
  res.status(result.status).json(parsed.data);
}

function sendInternalContractViolation(
  res: Response,
  operation: AttachmentUploadOperation,
  status?: number,
  issueCount = 1,
): void {
  console.error("[attachment-upload-contract-violation]", {
    operation,
    status,
    issueCount,
  });
  res.status(500).json({
    error: "Attachment upload contract violation",
    code: "attachment_upload_contract_violation",
  });
}

function requestContext(req: Request): Extract<AttachmentUploadSessionContext, { userId: string }> {
  return {
    serverId: req.serverId!,
    userId: req.userId!,
  };
}

async function canCreateUploadSession(
  context: Extract<AttachmentUploadSessionContext, { userId: string }>,
  input: CreateAttachmentUploadSessionInput,
  /** A refusal that is a plan paywall (paywall_hit); `usage` with the monthly quota's. */
  onPaywall: (gate: "upload_file_size" | "upload_monthly_quota" | "joint_channel_read_only", usage?: PaywallHitUsage) => void,
): Promise<AttachmentUploadSessionResult | null> {
  const { channelId, sizeBytes } = input;
  const canAccess = await channelService.canUserAccessChannel(channelId, context.userId, context.serverId);
  if (!canAccess || !await channelService.canUserPostToChannel(channelId, context.userId)) {
    return { status: 403, body: forbiddenBody };
  }
  if (await channelService.isChannelArchived(channelId)) {
    return { status: 403, body: forbiddenBody };
  }
  const billingReadOnly = await getChannelBillingReadOnly(channelId, context.serverId);
  if (billingReadOnly) {
    if (billingReadOnly.reason === "joint_over_limit") onPaywall("joint_channel_read_only");
    return { status: 403, body: forbiddenBody };
  }
  if (await isChannelReadOnlyByQuota(channelId, context.serverId)) {
    return { status: 403, body: forbiddenBody };
  }

  const quota = await getFileUploadQuotaSummary(context.serverId);
  if (sizeBytes > getAttachmentFileSizeLimitBytes(quota.plan)) {
    // A Free paywall only when Pro would take the file.
    if (quota.plan === "free" && sizeBytes <= PRO_SINGLE_FILE_UPLOAD_LIMIT_BYTES) onPaywall("upload_file_size");
    return { status: 413, body: tooLargeBody };
  }
  if (quota.enforced && sizeBytes > quota.remainingBytes) {
    if (quota.plan === "free") onPaywall("upload_monthly_quota", { requestedBytes: sizeBytes, monthUsedBytes: quota.usedBytes });
    return {
      status: 403,
      body: {
        code: "FILE_UPLOAD_QUOTA_EXCEEDED",
        // The legacy route's sentence, which older web builds already recognise.
        message: quota.appsumo ? FILE_UPLOAD_APPSUMO_QUOTA_EXCEEDED_MESSAGE : FILE_UPLOAD_QUOTA_EXCEEDED_MESSAGE,
        retryable: false,
        monthlyUpload: monthlyUpload(quota)!,
      },
    };
  }
  return null;
}

const ATTACHMENT_MOUNT = "/api/attachments";
// Same shape as the shared UUID_RE (lib/messageId.ts) — kept as a source
// string because it is interpolated into route-matching regexes.
const UUID_SOURCE = "[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}";

function contractRoute(
  operation: AttachmentUploadOperation,
  expectedMethod: "get" | "post" | "delete",
): string {
  const definition = attachmentUploadContract[operation];
  if (definition.method !== expectedMethod || !definition.path.startsWith(`${ATTACHMENT_MOUNT}/`)) {
    throw new Error(`Attachment upload ${operation} route drifted from its P1 mount contract`);
  }
  return definition.path.slice(ATTACHMENT_MOUNT.length);
}

function uuidContractRoute(
  operation: Exclude<AttachmentUploadOperation, "capabilities" | "create">,
  method: "get" | "post" | "delete",
) {
  const route = contractRoute(operation, method);
  if (!route.includes("{uploadId}")) {
    throw new Error(`Attachment upload ${operation} route must contain uploadId`);
  }
  return new RegExp(`^${route.replace("{uploadId}", `(${UUID_SOURCE})`)}/?$`, "i");
}

export const attachmentUploadCreatePath = contractRoute("create", "post");
export const attachmentUploadCapabilitiesPath = contractRoute("capabilities", "get");
const completePath = uuidContractRoute("complete", "post");
const cancelPath = uuidContractRoute("cancel", "delete");
const statusPath = uuidContractRoute("status", "get");
const listPath = contractRoute("list", "get").replace("{channelId}", ":channelId");

function parsedUploadId(req: Request): string | null {
  const result = attachmentUploadPathParamsSchema.safeParse({ uploadId: req.params[0] });
  return result.success ? result.data.uploadId : null;
}

export function createAttachmentUploadSessionRouter(
  service: AttachmentUploadSessionService | null,
  options: AttachmentUploadSessionRouterOptions,
): RouterType {
  const router = Router();
  const securityMiddleware = [...options.securityMiddleware];

  router.get(attachmentUploadCapabilitiesPath, ...securityMiddleware, async (req, res) => {
    sendContractResponse(res, "capabilities", await webCapabilities(service, requestContext(req)));
  });

  router.get(listPath, ...securityMiddleware, async (req, res) => {
    const parsed = listAttachmentUploadSessionsPathParamsSchema.safeParse({ channelId: req.params.channelId });
    if (!parsed.success) {
      sendContractResponse(res, "list", { status: 400, body: invalidChannelBody });
      return;
    }
    if (!service) {
      sendContractResponse(res, "list", { status: 200, body: { uploads: [] } });
      return;
    }
    sendContractResponse(res, "list", await service.listActive(requestContext(req), parsed.data.channelId));
  });

  router.post(attachmentUploadCreatePath, ...securityMiddleware, options.createLimiter, async (req, res) => {
    if (!service) {
      sendContractResponse(res, "create", { status: 403, body: forbiddenBody });
      return;
    }
    const parsed = createAttachmentUploadSessionRequestSchema.safeParse(req.body);
    if (!parsed.success) {
      sendContractResponse(res, "create", { status: 400, body: invalidRequestBody });
      return;
    }
    const context = requestContext(req);
    const denied = await canCreateUploadSession(context, parsed.data, (gate, usage) => notePaywallHit(req, gate, usage));
    if (denied) {
      sendContractResponse(res, "create", denied);
      return;
    }
    sendContractResponse(res, "create", await service.create(context, parsed.data));
  });

  router.post(completePath, ...securityMiddleware, async (req, res) => {
    if (!service) {
      sendContractResponse(res, "complete", { status: 403, body: forbiddenBody });
      return;
    }
    const uploadId = parsedUploadId(req);
    if (!uploadId) {
      sendInternalContractViolation(res, "complete");
      return;
    }
    sendContractResponse(res, "complete", await service.complete(requestContext(req), uploadId));
  });

  router.delete(cancelPath, ...securityMiddleware, async (req, res) => {
    if (!service) {
      sendContractResponse(res, "cancel", { status: 403, body: forbiddenBody });
      return;
    }
    const uploadId = parsedUploadId(req);
    if (!uploadId) {
      sendInternalContractViolation(res, "cancel");
      return;
    }
    sendContractResponse(res, "cancel", await service.cancel(requestContext(req), uploadId));
  });

  router.get(statusPath, ...securityMiddleware, async (req, res) => {
    if (!service) {
      sendContractResponse(res, "status", { status: 403, body: forbiddenBody });
      return;
    }
    const uploadId = parsedUploadId(req);
    if (!uploadId) {
      sendInternalContractViolation(res, "status");
      return;
    }
    sendContractResponse(res, "status", await service.status(requestContext(req), uploadId));
  });

  return router;
}
