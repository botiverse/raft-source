import {
  Router,
  type Request,
  type RequestHandler,
  type Response,
  type Router as RouterType,
} from "express";
import { z } from "zod";
import type { ServerId } from "@botiverse/raft-shared";
import {
  attachmentUploadContract,
  attachmentUploadPathParamsSchema,
  createAttachmentUploadSessionRequestSchema,
  getAttachmentUploadResponseSchema,
} from "@botiverse/raft-shared/src/attachmentUploadContract.js";
import * as channelService from "../services/channelService.js";
import {
  getAttachmentFileSizeLimitBytes,
  getLegacyAttachmentFileSizeLimitBytes,
} from "../services/attachmentUploadPolicy.js";
import { getFileUploadQuotaSummary } from "../services/fileUploadQuotaService.js";
import { isChannelReadOnlyByBillingFeature, isChannelReadOnlyByQuota } from "../services/planService.js";

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
): Promise<AttachmentUploadSessionResult | null> {
  const { channelId, sizeBytes } = input;
  const canAccess = await channelService.canUserAccessChannel(channelId, context.userId, context.serverId);
  if (!canAccess || !await channelService.canUserPostToChannel(channelId, context.userId)) {
    return { status: 403, body: forbiddenBody };
  }
  if (
    await channelService.isChannelArchived(channelId)
    || await isChannelReadOnlyByBillingFeature(channelId, context.serverId)
    || await isChannelReadOnlyByQuota(channelId, context.serverId)
  ) {
    return { status: 403, body: forbiddenBody };
  }

  const quota = await getFileUploadQuotaSummary(context.serverId);
  if (sizeBytes > getAttachmentFileSizeLimitBytes(quota.plan)) {
    return { status: 413, body: tooLargeBody };
  }
  if (quota.enforced && sizeBytes > quota.remainingBytes) {
    return { status: 403, body: forbiddenBody };
  }
  return null;
}

const ATTACHMENT_MOUNT = "/api/attachments";
const UUID_SOURCE = "[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}";

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
    sendContractResponse(
      res,
      "capabilities",
      service
        ? await service.capabilities(requestContext(req))
        : await disabledCapabilities(requestContext(req)),
    );
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
    const denied = await canCreateUploadSession(context, parsed.data);
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
