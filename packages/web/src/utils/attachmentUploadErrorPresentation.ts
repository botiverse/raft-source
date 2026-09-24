import type { IntlShape } from "react-intl";

import type { MessageId } from "../i18n/messages";
import type { AttachmentUploadClientError } from "./directAttachmentUpload";

const UPLOAD_ERROR_MESSAGE_ID: Record<string, MessageId> = {
  UPLOAD_COMPLETE_FAILED: "message.composer.uploadError.completeFailed",
  UPLOAD_SESSION_EXPIRED: "message.composer.uploadError.sessionExpired",
  UPLOAD_SESSION_CANCELED: "message.composer.uploadError.sessionCanceled",
  UPLOAD_OBJECT_MISMATCH: "message.composer.uploadError.objectMismatch",
  UPLOAD_SESSION_STATUS_FAILED: "message.composer.uploadError.sessionStatusFailed",
  UPLOAD_SESSION_CREATE_FAILED: "message.composer.uploadError.sessionCreateFailed",
  UPLOAD_CAPABILITY_FAILED: "message.composer.uploadError.capabilityFailed",
  UPLOAD_INVALID_REQUEST: "message.composer.uploadError.empty",
  UPLOAD_TOO_LARGE: "message.composer.uploadError.tooLarge",
  UPLOAD_OBJECT_PUT_UNCERTAIN: "message.composer.uploadError.putUncertain",
  UPLOAD_OBJECT_PUT_FAILED: "message.composer.uploadError.putFailed",
  UPLOAD_STALLED: "message.composer.uploadError.stalled",
};

const SERVER_UPLOAD_ERROR_MESSAGE_ID: Record<string, MessageId> = {
  "Attachment storage timed out": "message.composer.uploadError.storageTimedOut",
};

export function formatAttachmentUploadClientError(
  error: AttachmentUploadClientError,
  formatMessage: IntlShape["formatMessage"],
): string {
  if (error.code === "UPLOAD_OBJECT_PUT_FAILED") {
    const statusMatch = /HTTP\s+(\d+)/i.exec(error.message);
    return formatMessage(
      { id: "message.composer.uploadError.putFailed" },
      { status: statusMatch?.[1] ?? "?" },
    );
  }
  const id = UPLOAD_ERROR_MESSAGE_ID[error.code];
  if (id) return formatMessage({ id });
  return error.message;
}

export function formatAttachmentUploadServerError(
  error: string,
  formatMessage: IntlShape["formatMessage"],
): string {
  const id = SERVER_UPLOAD_ERROR_MESSAGE_ID[error];
  return id ? formatMessage({ id }) : error;
}
