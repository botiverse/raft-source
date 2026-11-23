import type { MessageId } from "../../../i18n/messages";
import type { ConnectedAppStatus } from "./connectedAppTypes";

export function canEditSourceOwnedConnectedApp(status: ConnectedAppStatus) {
  return status === "private" || status === "publish_requested" || status === "in_review" || status === "published" || status === "rejected";
}

export function canDeleteSourceOwnedConnectedApp(status: ConnectedAppStatus) {
  return status === "private" || status === "publish_requested" || status === "in_review" || status === "rejected";
}

export function canRequestOfflineSourceOwnedConnectedApp(status: ConnectedAppStatus) {
  return status === "published";
}

export function sourceOwnedConnectedAppStatusHint(status: ConnectedAppStatus): MessageId | null {
  if (status === "publish_requested" || status === "in_review") {
    return "settings.connectedApps.editor.statusHint.reviewPending";
  }
  if (status === "unpublish_requested") {
    return "settings.connectedApps.editor.statusHint.offlinePending";
  }
  return null;
}

export function connectedAppDistributionStatus(status: ConnectedAppStatus | null): MessageId {
  if (!status) return "settings.connectedApps.editor.distribution.availableAfterSave";
  if (status === "publish_requested" || status === "in_review") return "settings.connectedApps.editor.distribution.reviewPending";
  if (status === "unpublish_requested") return "settings.connectedApps.editor.distribution.offlinePending";
  if (status === "published") return "settings.connectedApps.editor.distribution.published";
  if (status === "rejected") return "settings.connectedApps.editor.distribution.rejected";
  return "settings.connectedApps.editor.distribution.private";
}
