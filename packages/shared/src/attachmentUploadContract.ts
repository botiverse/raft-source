// NOTE: do not add `import "zod-openapi"` here. This file is reachable from
// the @botiverse/raft-shared package barrel, so zod-openapi's global
// `declare module 'zod/v4'` augmentation would leak into the published type
// files of every downstream package (sdk, computer/lib) and rewrite their
// consumers' own zod typing. The `.meta()` calls below use only built-in
// zod fields (id/description/readOnly). If a future contract genuinely
// needs OpenAPI-specific meta fields with type checking, the import belongs
// in `openApiContract.ts` (the document-generation end, unreachable from
// the barrel) — and note the augmentation only applies to modules that
// import zod from "zod/v4", so the file using those fields must import from
// "zod/v4" too, not "zod".
import { z } from "zod";
import { lazySchema } from "./lazySchema";

export const ATTACHMENT_UPLOAD_MAX_SIZE_BYTES = 200 * 1024 * 1024;

export const attachmentUploadIdSchema = lazySchema("attachmentUploadIdSchema", () => z.uuid().meta({ id: "AttachmentUploadId" }));
export const attachmentIdSchema = lazySchema("attachmentIdSchema", () => z.uuid().meta({ id: "AttachmentId" }));

export const attachmentUploadStateSchema = lazySchema("attachmentUploadStateSchema", () => z.enum([
  "pending",
  "verifying",
  "completed",
  "canceled",
  "expired",
  "failed",
]).meta({ id: "AttachmentUploadState" }));

export const attachmentReservationStateSchema = lazySchema("attachmentReservationStateSchema", () => z.enum([
  "pending",
  "consumed",
  "canceled",
  "expired",
]).meta({ id: "AttachmentReservationState" }));

export const attachmentSchema = lazySchema("attachmentSchema", () => z.strictObject({
  id: attachmentIdSchema,
  filename: z.string().min(1).max(255),
  mimeType: z.string().min(1).max(255).nullable(),
  sizeBytes: z.int().nonnegative().max(ATTACHMENT_UPLOAD_MAX_SIZE_BYTES),
  thumbnailUrl: z.url().nullable(),
}).meta({ id: "AttachmentUploadResponse" }));

export const attachmentUploadSessionSchema = lazySchema("attachmentUploadSessionSchema", () => z.strictObject({
  uploadId: attachmentUploadIdSchema,
  state: attachmentUploadStateSchema,
  expiresAt: z.iso.datetime(),
  attachment: attachmentSchema.nullable(),
  terminalReason: z.string().min(1).nullable(),
  reservationState: attachmentReservationStateSchema.nullable().optional(),
}).meta({ id: "AttachmentUploadSessionView" }));

export const attachmentUploadRecoverySchema = lazySchema("attachmentUploadRecoverySchema", () => z.strictObject({
  uploadId: attachmentUploadIdSchema,
  filename: z.string().min(1).max(255),
  mimeType: z.string().min(1).max(255),
  sizeBytes: z.int().positive().max(ATTACHMENT_UPLOAD_MAX_SIZE_BYTES),
  state: z.enum(["pending", "verifying"]),
  expiresAt: z.iso.datetime(),
}).meta({ id: "AttachmentUploadRecoveryView" }));

export const attachmentUploadRecoveryListSchema = lazySchema("attachmentUploadRecoveryListSchema", () => z.strictObject({
  uploads: z.array(attachmentUploadRecoverySchema).max(100),
}).meta({ id: "AttachmentUploadRecoveryList" }));

export const attachmentUploadCapabilitiesSchema = lazySchema("attachmentUploadCapabilitiesSchema", () => z.strictObject({
  directUploadEnabled: z.boolean(),
  directUploadThresholdBytes: z.int().positive().max(ATTACHMENT_UPLOAD_MAX_SIZE_BYTES).nullable(),
  maxBytes: z.int().positive().max(ATTACHMENT_UPLOAD_MAX_SIZE_BYTES),
  sessionExpiresInSeconds: z.int().positive().max(86_400).nullable(),
}).meta({ id: "AttachmentUploadCapabilities" }));

/**
 * What is left of the server's monthly file upload quota (Free or AppSumo), so the web
 * composer can refuse a file at selection, as it does a file over `maxBytes`,
 * and say how much is left and when it resets. `month` is the UTC month
 * (`YYYY-MM`) the quota counts; it resets when the next one starts.
 */
export const attachmentMonthlyUploadSchema = lazySchema("attachmentMonthlyUploadSchema", () => z.strictObject({
  source: z.literal("appsumo").optional(),
  month: z.string().regex(/^\d{4}-\d{2}$/),
  limitBytes: z.int().positive(),
  remainingBytes: z.int().nonnegative(),
}).meta({ id: "AttachmentMonthlyUpload" }));

/**
 * The web's capabilities: the agent API's (which the CLI parses strictly, so
 * it never grows) plus the monthly quota, null where none applies (Pro).
 */
export const webAttachmentUploadCapabilitiesSchema = lazySchema("webAttachmentUploadCapabilitiesSchema", () => attachmentUploadCapabilitiesSchema.extend({
  monthlyUpload: attachmentMonthlyUploadSchema.nullable(),
}).meta({ id: "WebAttachmentUploadCapabilities" }));

export const createAttachmentUploadSessionRequestSchema = lazySchema("createAttachmentUploadSessionRequestSchema", () => z.strictObject({
  channelId: z.uuid(),
  filename: z.string().min(1).max(255),
  mimeType: z.string().min(1).max(255),
  sizeBytes: z.int().positive().max(ATTACHMENT_UPLOAD_MAX_SIZE_BYTES),
  clientRequestId: z.uuid(),
}).meta({ id: "CreateAttachmentUploadSessionRequest" }));

export const listAttachmentUploadSessionsPathParamsSchema = lazySchema("listAttachmentUploadSessionsPathParamsSchema", () => z.strictObject({
  channelId: z.uuid(),
}).meta({ id: "ListAttachmentUploadSessionsPathParams" }));

export const createAttachmentUploadSessionResponseSchema = lazySchema("createAttachmentUploadSessionResponseSchema", () => z.strictObject({
  uploadId: attachmentUploadIdSchema,
  attachmentId: attachmentIdSchema,
  state: z.literal("pending"),
  expiresAt: z.iso.datetime(),
  upload: z.strictObject({
    method: z.literal("PUT"),
    url: z.url().meta({
      description: "Short-lived presigned object-upload URL. Never log or persist this value.",
      readOnly: true,
    }),
    headers: z.strictObject({
      "Content-Type": z.string().min(1).max(255),
      "If-None-Match": z.literal("*"),
    }),
  }),
}).meta({ id: "CreateAttachmentUploadSessionResponse" }));

export const completeAttachmentUploadSessionResponseSchema = lazySchema("completeAttachmentUploadSessionResponseSchema", () => z.strictObject({
  uploadId: attachmentUploadIdSchema,
  state: z.literal("completed"),
  attachment: attachmentSchema,
}).meta({ id: "CompleteAttachmentUploadSessionResponse" }));

export const attachmentUploadPathParamsSchema = lazySchema("attachmentUploadPathParamsSchema", () => z.strictObject({
  uploadId: attachmentUploadIdSchema,
}));

const flatError = <Code extends string, Retryable extends boolean>(
  id: string,
  code: Code,
  retryable: Retryable,
  includeRetryAfter = false,
) => z.strictObject({
  code: z.literal(code),
  message: z.string().min(1),
  retryable: z.literal(retryable),
  ...(includeRetryAfter
    ? { retryAfterMs: z.int().positive().max(300_000) }
    : {}),
}).meta({ id });

export const invalidUploadRequestErrorSchema = flatError(
  "InvalidUploadRequestError",
  "UPLOAD_INVALID_REQUEST",
  false,
);
export const attachmentUploadForbiddenErrorSchema = flatError(
  "AttachmentUploadForbiddenError",
  "UPLOAD_FORBIDDEN",
  false,
);
/** A file the server's monthly upload quota has no room for (Free). */
export const attachmentUploadQuotaExceededErrorSchema = lazySchema("attachmentUploadQuotaExceededErrorSchema", () => z.strictObject({
  code: z.literal("FILE_UPLOAD_QUOTA_EXCEEDED"),
  message: z.string().min(1),
  retryable: z.literal(false),
  monthlyUpload: attachmentMonthlyUploadSchema,
}).meta({ id: "AttachmentUploadQuotaExceededError" }));
export const attachmentUploadIdempotencyConflictErrorSchema = flatError(
  "AttachmentUploadIdempotencyConflictError",
  "UPLOAD_IDEMPOTENCY_CONFLICT",
  false,
);
export const attachmentUploadTooLargeErrorSchema = flatError(
  "AttachmentUploadTooLargeError",
  "UPLOAD_TOO_LARGE",
  false,
);
export const attachmentUploadRateLimitedErrorSchema = flatError(
  "AttachmentUploadRateLimitedError",
  "UPLOAD_RATE_LIMITED",
  true,
  true,
);
export const attachmentUploadObjectNotFoundErrorSchema = flatError(
  "UploadObjectNotFoundError",
  "UPLOAD_OBJECT_NOT_FOUND",
  true,
  true,
);
export const attachmentUploadVerificationInProgressErrorSchema = flatError(
  "AttachmentUploadVerificationInProgressError",
  "UPLOAD_VERIFICATION_IN_PROGRESS",
  true,
  true,
);
export const attachmentUploadExpiredErrorSchema = flatError(
  "UploadSessionExpiredError",
  "UPLOAD_SESSION_EXPIRED",
  false,
);
export const attachmentUploadVerificationFailedErrorSchema = flatError(
  "UploadObjectMismatchError",
  "UPLOAD_OBJECT_MISMATCH",
  false,
);
export const attachmentUploadSessionNotFoundErrorSchema = flatError(
  "AttachmentUploadSessionNotFoundError",
  "UPLOAD_SESSION_NOT_FOUND",
  false,
);
export const attachmentAlreadyConsumedErrorSchema = flatError(
  "AttachmentAlreadyConsumedError",
  "ATTACHMENT_ALREADY_CONSUMED",
  false,
);

type ResponseDefinition = Readonly<{
  description: string;
  schema: z.ZodType;
}>;

type OperationDefinition = Readonly<{
  method: "get" | "post" | "delete";
  path: string;
  operationId: string;
  summary: string;
  requestParams?: z.ZodObject;
  requestBody?: z.ZodType;
  responses: Readonly<Record<number, ResponseDefinition>>;
}>;

const defineOperation = <const Operation extends OperationDefinition>(operation: Operation) => operation;

export const attachmentUploadContract = {
  capabilities: defineOperation({
    method: "get",
    path: "/api/attachments/upload-capabilities",
    operationId: "getAttachmentUploadCapabilities",
    summary: "Get server-authoritative attachment upload limits",
    responses: {
      200: { description: "Current upload capability", schema: webAttachmentUploadCapabilitiesSchema },
    },
  }),
  list: defineOperation({
    method: "get",
    path: "/api/attachments/upload-sessions/{channelId}/active",
    operationId: "listAttachmentUploadSessions",
    summary: "List active attachment uploads for a channel",
    requestParams: listAttachmentUploadSessionsPathParamsSchema,
    responses: {
      200: { description: "Active uploads owned by the current member", schema: attachmentUploadRecoveryListSchema },
      400: { description: "Invalid channel id", schema: invalidUploadRequestErrorSchema },
      403: { description: "Upload is forbidden", schema: attachmentUploadForbiddenErrorSchema },
    },
  }),
  create: defineOperation({
    method: "post",
    path: "/api/attachments/upload-sessions",
    operationId: "createAttachmentUploadSession",
    summary: "Create a direct attachment upload session",
    requestBody: createAttachmentUploadSessionRequestSchema,
    responses: {
      201: { description: "Upload session created", schema: createAttachmentUploadSessionResponseSchema },
      400: { description: "Invalid upload request", schema: invalidUploadRequestErrorSchema },
      403: {
        description: "Upload is forbidden, or the monthly upload quota has no room for it",
        schema: z.union([attachmentUploadForbiddenErrorSchema, attachmentUploadQuotaExceededErrorSchema]),
      },
      409: { description: "Idempotency key conflicts with another request", schema: attachmentUploadIdempotencyConflictErrorSchema },
      413: { description: "Attachment is larger than the plan limit", schema: attachmentUploadTooLargeErrorSchema },
      429: { description: "Upload creation is rate limited", schema: attachmentUploadRateLimitedErrorSchema },
    },
  }),
  complete: defineOperation({
    method: "post",
    path: "/api/attachments/upload-sessions/{uploadId}/complete",
    operationId: "completeAttachmentUploadSession",
    summary: "Verify and complete a direct attachment upload",
    requestParams: attachmentUploadPathParamsSchema,
    responses: {
      200: { description: "Upload verification completed", schema: completeAttachmentUploadSessionResponseSchema },
      403: { description: "Upload is forbidden", schema: attachmentUploadForbiddenErrorSchema },
      404: { description: "Uploaded object is not visible yet", schema: attachmentUploadObjectNotFoundErrorSchema },
      409: { description: "Upload verification is already in progress", schema: attachmentUploadVerificationInProgressErrorSchema },
      410: { description: "Upload session expired", schema: attachmentUploadExpiredErrorSchema },
      422: { description: "Uploaded object failed verification", schema: attachmentUploadVerificationFailedErrorSchema },
    },
  }),
  cancel: defineOperation({
    method: "delete",
    path: "/api/attachments/upload-sessions/{uploadId}",
    operationId: "cancelAttachmentUploadSession",
    summary: "Cancel a direct attachment upload session",
    requestParams: attachmentUploadPathParamsSchema,
    responses: {
      200: { description: "Upload session canceled", schema: attachmentUploadSessionSchema },
      403: { description: "Upload is forbidden", schema: attachmentUploadForbiddenErrorSchema },
      404: { description: "Upload session does not exist", schema: attachmentUploadSessionNotFoundErrorSchema },
      409: { description: "The completed upload is already attached to a message", schema: attachmentAlreadyConsumedErrorSchema },
    },
  }),
  status: defineOperation({
    method: "get",
    path: "/api/attachments/upload-sessions/{uploadId}",
    operationId: "getAttachmentUploadSession",
    summary: "Get a direct attachment upload session",
    requestParams: attachmentUploadPathParamsSchema,
    responses: {
      200: { description: "Current upload session", schema: attachmentUploadSessionSchema },
      403: { description: "Upload is forbidden", schema: attachmentUploadForbiddenErrorSchema },
      404: { description: "Upload session does not exist", schema: attachmentUploadSessionNotFoundErrorSchema },
    },
  }),
} as const;

export type AttachmentUploadOperationKey = keyof typeof attachmentUploadContract;

export const getAttachmentUploadResponseSchema = (
  operation: AttachmentUploadOperationKey,
  status: number,
): z.ZodType | undefined => {
  const definition: OperationDefinition = attachmentUploadContract[operation];
  return definition.responses[status]?.schema;
};
