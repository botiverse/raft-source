import type { IntlShape } from "react-intl";
import type { MessageMention } from "../../store/messageStore";
import { structuredRaftMentionStillAppears } from "@botiverse/raft-shared";

export type PendingMentionActionExecuteStatus =
  | "queued"
  | "delivered"
  | "dropped"
  | "stale"
  | "expired"
  | "no_permission"
  | "not_found"
  | "ambiguous";
export type PendingMentionActionExecuteAction = "notify" | "add";
export interface PendingMentionActionExecuteResult {
  resolutionId: string;
  action: PendingMentionActionExecuteAction;
  status: PendingMentionActionExecuteStatus;
  reason?: string;
}
export interface PendingMentionActionExecuteResponse {
  ok?: boolean;
  action?: string;
  results?: PendingMentionActionExecuteResult[];
}
export function mentionStillAppears(content: string, mention: MessageMention): boolean {
  return structuredRaftMentionStillAppears(content, mention.name);
}
export interface MentionUndoSnapshot {
  beforeContent: string;
  beforeMentions: MessageMention[];
  beforeCursor: number;
  afterContent: string;
  afterCursor: number;
}
export function mergeFailedSendIntoDraft(failedMessage: string, currentDraft: string): string {
  if (!currentDraft) return failedMessage;
  if (!failedMessage) return currentDraft;
  const separator = failedMessage.endsWith("\n") || currentDraft.startsWith("\n") ? "" : "\n";
  return `${failedMessage}${separator}${currentDraft}`;
}
/** Clear only the request intent that completed; a newer request owns its guard. */
export function releaseSubmittedDraftIntent(
  currentIntent: string | null,
  completedIntent: string,
): string | null {
  return currentIntent === completedIntent ? null : currentIntent;
}
export function formatMentionActionStatusNotice(
  result: PendingMentionActionExecuteResult | undefined,
  formatMessage: IntlShape["formatMessage"],
): string {
  if (!result) return formatMessage({ id: "message.mentionActionNotice.unavailable" });
  if (result.status === "dropped") {
    if (result.reason === "delivery_unavailable") return formatMessage({ id: "message.mentionActionNotice.droppedDeliveryUnavailable" });
    return formatMessage({ id: "message.mentionActionNotice.dropped" });
  }
  if (result.status === "no_permission") {
    if (result.reason === "sender_lacks_channel_access") return formatMessage({ id: "message.mentionActionNotice.senderLacksAccess" });
    if (result.reason === "target_lacks_read_access") return formatMessage({ id: "message.mentionActionNotice.targetLacksReadAccess" });
    if (result.reason === "add_not_allowed_for_surface") return formatMessage({ id: "message.mentionActionNotice.addNotAllowedForSurface" });
    if (result.reason === "add_requires_human_member_authority") return formatMessage({ id: "message.mentionActionNotice.addRequiresHumanMember" });
    if (result.reason === "add_requires_member_management_authority") return formatMessage({ id: "message.mentionActionNotice.addRequiresMemberManagement" });
    return formatMessage({ id: "message.mentionActionNotice.noPermissionDefault" });
  }
  if (result.status === "stale") {
    if (result.reason === "target_already_member") return formatMessage({ id: "message.mentionActionNotice.targetAlreadyMember" });
    if (result.reason === "target_unavailable") return formatMessage({ id: "message.mentionActionNotice.targetUnavailable" });
    return formatMessage({ id: "message.mentionActionNotice.noLongerPending" });
  }
  if (result.status === "expired") return formatMessage({ id: "message.mentionActionNotice.expired" });
  if (result.status === "not_found") return formatMessage({ id: "message.mentionActionNotice.notFound" });
  if (result.status === "ambiguous") return formatMessage({ id: "message.mentionActionNotice.ambiguous" });
  return formatMessage({ id: "message.mentionActionNotice.couldNotApply" });
}
export function mentionActionSucceeded(
  action: PendingMentionActionExecuteAction,
  result: PendingMentionActionExecuteResult | undefined,
): boolean {
  return action === "notify"
    ? result?.status === "queued"
    : result?.status === "delivered";
}
