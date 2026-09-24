import type { components, operations } from "./generated/openapi.js";

type Equal<Left, Right> =
  (<Value>() => Value extends Left ? 1 : 2) extends
  (<Value>() => Value extends Right ? 1 : 2)
    ? true
    : false;
type Assert<Condition extends true> = Condition;

type ExpectedState = "pending" | "verifying" | "completed" | "canceled" | "expired" | "failed";
type ExpectedOperations =
  | "cancelAttachmentUploadSession"
  | "completeAttachmentUploadSession"
  | "createAttachmentUploadSession"
  | "getAttachmentUploadCapabilities"
  | "getAttachmentUploadSession";

type CapabilitiesBody = operations["getAttachmentUploadCapabilities"]["responses"][200]["content"]["application/json"];
type StatusBody = operations["getAttachmentUploadSession"]["responses"][200]["content"]["application/json"];
type CreateBody = operations["createAttachmentUploadSession"]["responses"][201]["content"]["application/json"];
type CompleteBody = operations["completeAttachmentUploadSession"]["responses"][200]["content"]["application/json"];
type RateLimitedBody = operations["createAttachmentUploadSession"]["responses"][429]["content"]["application/json"];
type ObjectNotFoundBody = operations["completeAttachmentUploadSession"]["responses"][404]["content"]["application/json"];

export type AttachmentUploadConsumerAssertions = [
  Assert<Equal<keyof operations, ExpectedOperations>>,
  Assert<Equal<CapabilitiesBody["directUploadThresholdBytes"], number | null>>,
  Assert<Equal<CapabilitiesBody["maxBytes"], number>>,
  Assert<Equal<StatusBody["state"], ExpectedState>>,
  Assert<Equal<StatusBody["attachment"], components["schemas"]["AttachmentUploadResponse"] | null>>,
  Assert<Equal<keyof CreateBody["upload"]["headers"], "Content-Type" | "If-None-Match">>,
  Assert<Equal<CompleteBody["state"], "completed">>,
  Assert<Equal<CompleteBody["attachment"], components["schemas"]["AttachmentUploadResponse"]>>,
  Assert<Equal<RateLimitedBody["code"], "UPLOAD_RATE_LIMITED">>,
  Assert<Equal<RateLimitedBody["retryable"], true>>,
  Assert<Equal<RateLimitedBody["retryAfterMs"], number>>,
  Assert<Equal<ObjectNotFoundBody["code"], "UPLOAD_OBJECT_NOT_FOUND">>,
  Assert<Equal<ObjectNotFoundBody["retryable"], true>>,
];
