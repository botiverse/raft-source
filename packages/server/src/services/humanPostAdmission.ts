/**
 * Whether a person may post an ordinary message in a conversation: the route
 * checks of a send or reply (POST /messages), shared with forward
 * (services/messageForwardService.ts), which admits each destination and lists
 * thread / task targets through this same function, so a forward into a
 * thread is allowed exactly when a reply there is, for the web and for a
 * personal assistant forwarding as its owner.
 */
import type { ServerId } from "@botiverse/raft-shared";
import * as channelService from "./channelService";
import { isTaskConversationReadOnly } from "./taskChannelSurface";
import { getChannelBillingReadOnly, isChannelReadOnlyByQuota, type ChannelBillingReadOnly } from "./planService";

type MessageChannel = NonNullable<Awaited<ReturnType<typeof channelService.getChannel>>>;

export type HumanPostRefusal = "not_found" | "membership_required" | "joint_task_read_only" | "billing_read_only" | "quota_read_only";

/** Each refusal's answer; `code` is the one the routes' other refusals of the same kind use. */
export const HUMAN_POST_REFUSALS: Record<Exclude<HumanPostRefusal, "billing_read_only">, { status: 403 | 404; code: string; error: string }> = {
  not_found: { status: 404, code: "channel_not_found", error: "Channel not found" },
  membership_required: { status: 403, code: "channel_membership_required", error: "You must join this channel to send messages" },
  // Task v2: a historical joint task's conversation is read-only from a
  // participant workspace, like the task itself.
  joint_task_read_only: { status: 403, code: "joint_task_read_only", error: "Historical tasks are read-only from a participant workspace" },
  quota_read_only: { status: 403, code: "channel_read_only", error: "This channel is read-only on your current plan. Upgrade to continue." },
};

export type HumanPostAdmission =
  | { ok: true; channel: MessageChannel }
  | { ok: false; refusal: Exclude<HumanPostRefusal, "billing_read_only"> }
  | { ok: false; refusal: "billing_read_only"; billing: ChannelBillingReadOnly };

/**
 * Whether a person may post an ordinary message in `channelId` (a channel,
 * DM, thread or task conversation) of `serverId`. The archive gate is the
 * pipeline's (channelService.assertChannelNotArchived, run by
 * broadcastAndDeliver); a caller that persists before the pipeline runs it
 * first.
 */
export async function checkHumanPostAdmission(
  serverId: ServerId,
  userId: string,
  channelId: string,
): Promise<HumanPostAdmission> {
  const channel = await channelService.getChannel(channelId);
  if (!channel || channel.serverId !== serverId) return { ok: false, refusal: "not_found" };
  // Membership (threads and task conversations: the parent channel's;
  // guests: only their own channels).
  if (!(await channelService.canUserPostToChannel(channelId, userId))) {
    // Refused as the read routes refuse (denyChannelAccess): a conversation
    // the caller can't read and has no prior relationship with answers
    // exactly like a missing one, so the 403 can't tell which ids exist (a
    // private channel, a DM, a thread or task conversation under one); one
    // they read before keeps the 403, since they know it exists. Checked
    // only after the post check failed, so whoever may post still posts (a
    // guest, a joint projection).
    if (
      !(await channelService.canUserAccessChannel(channelId, userId, serverId))
      && !(await channelService.hasPriorChannelRelationship(userId, channelId))
    ) return { ok: false, refusal: "not_found" };
    return { ok: false, refusal: "membership_required" };
  }
  if (await isTaskConversationReadOnly(serverId, channel)) return { ok: false, refusal: "joint_task_read_only" };
  // Plan read-only, by reason (planService.getChannelBillingReadOnly): an
  // over-limit joint, or a free server frozen out of its external channels.
  const billing = await getChannelBillingReadOnly(channelId, serverId);
  if (billing) return { ok: false, refusal: "billing_read_only", billing };
  if (await isChannelReadOnlyByQuota(channelId, serverId)) return { ok: false, refusal: "quota_read_only" };
  return { ok: true, channel };
}
