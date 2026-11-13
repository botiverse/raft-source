import type { MessageId } from "../../i18n/messages";
import type { Channel } from "../../store/channelStore";

type SlackSyncHeaderState =
  | { kind: "paused"; tooltipId: MessageId }
  | { kind: "waiting"; reasonId: MessageId }
  | { kind: "stalled" };

type SlackPairWaitingReason = NonNullable<NonNullable<Channel["bridge"]>["outbound"]> & { status: "waiting" };

/**
 * Why a pair's Raft messages wait, as one message id for the channel header and the setup list:
 * a Slack workspace admin's approval, a delivery Raft cannot confirm yet (`detail`, instead of the
 * generic "configuration"), or the closed hint.
 */
export function slackPairWaitingReasonId(block: Pick<SlackPairWaitingReason, "reason" | "detail"> & { action?: "workspace_admin" }): MessageId {
  if (block.action === "workspace_admin") return "settings.slackBridge.pairWaiting.workspaceAdmin";
  return block.detail ? `settings.slackBridge.pairWaiting.confirm.${block.detail}` : `settings.slackBridge.pairWaiting.${block.reason}`;
}

/** The Slack sync state worth a header badge: a pair paused after it ran
 *  (privacy mismatch, Slack channel archived or deleted, review needed, the
 *  Slack app needs reauthorizing), or Raft messages held for Slack. Null while syncing or during pair setup. */
export function slackSyncHeaderState(channel: Pick<Channel, "type" | "bridge">): SlackSyncHeaderState | null {
  const bridge = channel.bridge;
  if (bridge?.provider !== "slack") return null;
  // An installation that is not active stops every pair it carries.
  if (bridge.installState === "reauth_required") {
    return { kind: "paused", tooltipId: "message.chatPanel.slackSyncPaused.reauthorize" };
  }
  if (bridge.installState) return { kind: "paused", tooltipId: "message.chatPanel.slackSyncPaused.other" };
  if (bridge.state === "quarantined") return { kind: "paused", tooltipId: "message.chatPanel.slackSyncPaused.other" };
  if (bridge.state === "paused") {
    const reason = bridge.stateReason;
    if (!reason || reason.startsWith("provisioning_")) return null;
    // Legacy pause: visibility flips no longer pause, but old pauses still render.
    if (reason === "raft_privacy_mismatch") {
      return {
        kind: "paused",
        tooltipId: channel.type === "private"
          ? "message.chatPanel.slackSyncPaused.nowPrivate"
          : "message.chatPanel.slackSyncPaused.nowPublic",
      };
    }
    if (reason === "provider_channel_archived") return { kind: "paused", tooltipId: "message.chatPanel.slackSyncPaused.archived" };
    if (reason === "provider_channel_deleted") return { kind: "paused", tooltipId: "message.chatPanel.slackSyncPaused.deleted" };
    return { kind: "paused", tooltipId: "message.chatPanel.slackSyncPaused.other" };
  }
  if (bridge.outbound?.status === "waiting") {
    return { kind: "waiting", reasonId: slackPairWaitingReasonId(bridge.outbound) };
  }
  if (bridge.outbound?.status === "stalled") return { kind: "stalled" };
  return null;
}
