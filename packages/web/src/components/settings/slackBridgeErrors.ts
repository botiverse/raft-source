import { isAxiosError } from "axios";
import { slackBridgeProvisioningFailureReasonSchema } from "@botiverse/raft-shared";
import type { SlackBridgeProvisioningFailureReason } from "@botiverse/raft-shared";
import type { MessageId } from "../../i18n/messages";

/** Recovery copy per pairing failure reason; also explains a stale saved pair. */
export const SLACK_BRIDGE_FAILURE_REASON_MESSAGE_ID: Record<SlackBridgeProvisioningFailureReason, MessageId> = {
  privacy_mismatch: "settings.slackBridge.failure.privacyMismatch", // legacy invalidReason value
  not_member: "settings.slackBridge.failure.notMember",
  channel_unavailable: "settings.slackBridge.failure.channelUnavailable",
  provider_unavailable: "settings.slackBridge.failure.providerUnavailable",
};

/** Show bounded recovery copy, never arbitrary HTTP/provider error text. */
export function slackBridgeErrorMessageId(cause: unknown): MessageId {
  if (!isAxiosError<unknown>(cause)) return "settings.slackBridge.operationFailed";
  const data = cause.response?.data;
  if (!data || typeof data !== "object") return "settings.slackBridge.operationFailed";
  if ("code" in data && data.code === "external_app_invalid_state" && "reason" in data) {
    const reason = slackBridgeProvisioningFailureReasonSchema.safeParse(data.reason);
    if (reason.success) return SLACK_BRIDGE_FAILURE_REASON_MESSAGE_ID[reason.data];
  }
  if ("code" in data) {
    switch (data.code) {
      case "external_app_not_authorized": return "settings.slackBridge.failure.notAuthorized";
      case "external_app_workspace_mismatch": return "settings.slackBridge.failure.workspaceMismatch";
      case "external_app_install_conflict": return "settings.slackBridge.failure.installConflict";
      case "external_app_scope_mismatch": return "settings.slackBridge.failure.scopeMismatch";
      case "external_app_invalid_state": return "settings.slackBridge.failure.invalidState";
    }
  }
  return "settings.slackBridge.operationFailed";
}
