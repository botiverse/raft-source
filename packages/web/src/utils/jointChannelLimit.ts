import { useEffect, useState } from "react";
import type { IntlShape } from "react-intl";
import { MAX_JOINT_CHANNEL_SERVERS } from "@botiverse/raft-shared";

// Contract v0.3 §18.8. The server computes `jointBillingLocked` when it builds
// channel metadata and never pushes a flip at the deadline, so a snapshot
// fetched during the grace period stays `false` after it ends. Clients compare
// the deadline against their own clock; the server still rejects writes with
// its own clock, so skew only moves the banner by the skew.
/** Channel metadata of the free plan's external channel freeze (channelStore's Channel). */
export type ExternalFreezeFields = {
  /**
   * The freeze of this server's side, on its external channels (any type):
   * read-only from this time, a notice before it; null otherwise.
   */
  externalFreezeAt?: string | null;
};

type JointLimitFields = ExternalFreezeFields & {
  type?: string;
  jointBillingLocked?: boolean | null;
  jointOverLimitGraceEndsAt?: string | null;
};

function deadlineMs(value: string | null | undefined): number {
  return value ? Date.parse(value) : Number.NaN;
}

/** This server is frozen out of the channel: it is over the free plan's external channel limit and the time has passed. */
export function isExternalFreezeActive(channel: JointLimitFields | null | undefined, nowMs: number = Date.now()): boolean {
  const deadline = deadlineMs(channel?.externalFreezeAt);
  return Number.isFinite(deadline) && nowMs >= deadline;
}

/** The freeze time while it is still ahead (the notice before it); null otherwise. */
export function externalFreezeUpcomingAt(channel: JointLimitFields | null | undefined, nowMs: number = Date.now()): string | null {
  if (!channel?.externalFreezeAt || !Number.isFinite(deadlineMs(channel.externalFreezeAt))) return null;
  return isExternalFreezeActive(channel, nowMs) ? null : channel.externalFreezeAt;
}

/**
 * Read-only by a plan limit: a joint past its over-limit grace, or any
 * channel this server is frozen out of (isExternalFreezeActive).
 */
export function isJointChannelReadOnly(channel: JointLimitFields | null | undefined, nowMs: number = Date.now()): boolean {
  if (!channel) return false;
  if (isExternalFreezeActive(channel, nowMs)) return true;
  if (channel.type !== "joint") return false;
  if (channel.jointBillingLocked === true) return true;
  const deadline = deadlineMs(channel.jointOverLimitGraceEndsAt);
  return Number.isFinite(deadline) && nowMs >= deadline;
}

/**
 * Grace deadline while over the limit and not yet read-only; null otherwise.
 * Null too while the external channel freeze applies: one notice at a time,
 * and the freeze's is the one shown.
 */
export function jointChannelGraceEndsAt(channel: JointLimitFields | null | undefined, nowMs: number = Date.now()): string | null {
  if (!channel || channel.type !== "joint" || !channel.jointOverLimitGraceEndsAt) return null;
  if (channel.externalFreezeAt) return null;
  return isJointChannelReadOnly(channel, nowMs) ? null : channel.jointOverLimitGraceEndsAt;
}

/** The read-only banner's message for a channel isJointChannelReadOnly locks. */
export function channelLimitLockedMessageId(channel: JointLimitFields | null | undefined, nowMs: number = Date.now()): "message.chatPanel.externalLimitFrozen" | "message.chatPanel.jointLocked" {
  return isExternalFreezeActive(channel, nowMs) ? "message.chatPanel.externalLimitFrozen" : "message.chatPanel.jointLocked";
}

/**
 * Re-render once when the grace deadline passes, so an open channel switches
 * from the grace banner to read-only without waiting for new metadata.
 */
export function useRerenderAtJointDeadline(deadline: string | null | undefined): void {
  const [, setTick] = useState(0);
  useEffect(() => {
    if (!deadline) return;
    const delay = Date.parse(deadline) - Date.now();
    if (!Number.isFinite(delay) || delay < 0) return;
    // setTimeout caps at ~24.8 days; the joint grace is 3 days and the
    // external freeze's launch grace 14, so one timer suffices.
    const timer = setTimeout(() => setTick((tick) => tick + 1), delay + 50);
    return () => clearTimeout(timer);
  }, [deadline]);
}

/**
 * Message for a failed joint invite accept. Limit codes get their localized
 * copy; anything else falls back to the server's text, then a generic line.
 * `acceptingServerName`: the server accepting, named by the one-external-
 * channel refusal (always the accepting server's limit).
 */
export function jointInviteAcceptErrorMessage(
  err: unknown,
  formatMessage: IntlShape["formatMessage"],
  acceptingServerName?: string,
): string {
  const data = (err as { response?: { data?: { error?: unknown; code?: unknown } } } | null)?.response?.data;
  if (data?.code === "free_external_limit" && acceptingServerName) {
    return formatMessage({ id: "externalInvite.error.targetFreeLimit" }, { target: acceptingServerName });
  }
  if (data?.code === "joint_free_server_limit") return formatMessage({ id: "channel.joint.freeServerLimit" });
  if (data?.code === "joint_channel_free_limit_reached" || data?.code === "joint_channel_plan_limit_reached") return formatMessage({ id: "channel.joint.inviteHostFreeLimit" });
  if (data?.code === "joint_server_limit") {
    return formatMessage({ id: "channel.joint.serverLimit" }, { max: MAX_JOINT_CHANNEL_SERVERS });
  }
  if (typeof data?.error === "string" && data.error.trim()) return data.error;
  return formatMessage({ id: "channel.joint.acceptFailed" });
}

/**
 * Localized copy for Free and finite paid hosted-Joint caps on
 * create and convert; null for any other failure so callers keep their own
 * handling.
 */
export function jointFreeHostLimitMessage(
  err: unknown,
  formatMessage: IntlShape["formatMessage"],
): string | null {
  const data = (err as {
    response?: { data?: { code?: unknown; blockingChannel?: { name?: unknown } } };
  } | null)?.response?.data;
  if (data?.code === "joint_channel_plan_limit_reached") return formatMessage({ id: "channel.joint.hostPlanLimit" });
  if (data?.code !== "joint_channel_free_limit_reached") return null;
  const name = typeof data.blockingChannel?.name === "string" ? data.blockingChannel.name.trim() : "";
  return name
    ? formatMessage({ id: "channel.joint.freeHostLimit" }, { name })
    : formatMessage({ id: "channel.joint.freeHostLimitUnnamed" });
}

/**
 * `joint_invite_rate_limited` (429): the inviter spent their hourly budget of
 * invited people. Names the wait in whole minutes from `retryAfterSeconds`.
 */
export function formatJointInviteRateLimited(retryAfterSeconds: number | undefined, formatMessage: IntlShape["formatMessage"]): string {
  const minutes = Math.max(1, Math.ceil((Number.isFinite(retryAfterSeconds) ? retryAfterSeconds! : 60) / 60));
  return formatMessage({ id: "channel.jointInvite.error.rateLimited" }, { minutes });
}

function refusalCode(err: unknown): unknown {
  return (err as { response?: { data?: { code?: unknown } } } | null)?.response?.data?.code;
}

/**
 * Converting a channel with bound Guests to a joint channel (P3, #wg-rbac:#25):
 * `guests_present` (the host's external_channels_v1 off: Guests keep it from
 * being shared) and `joint_party_limit` (flag on: the host, its Guests and the
 * server it is shared with would be over the 30-party cap). Null for any other
 * failure so callers keep their own handling. `channelName` without its #.
 */
export function jointConversionGuestRefusalMessage(
  err: unknown,
  channelName: string,
  formatMessage: IntlShape["formatMessage"],
): string | null {
  const code = refusalCode(err);
  if (code === "guests_present") return formatMessage({ id: "externalInvite.error.guestsPresent" }, { channel: `#${channelName}` });
  if (code === "joint_party_limit") {
    return formatMessage({ id: "channel.edit.convertJointPartyLimit" }, { channel: `#${channelName}`, max: MAX_JOINT_CHANNEL_SERVERS });
  }
  return null;
}

/**
 * Disconnecting this server's copy of a joint channel while Guests are bound
 * to it (`guests_present`, P3; the server refuses it whatever the flag says):
 * they would be stranded. Null for any other failure. `channelName` without its #.
 */
export function jointDisconnectGuestRefusalMessage(
  err: unknown,
  channelName: string,
  formatMessage: IntlShape["formatMessage"],
): string | null {
  if (refusalCode(err) !== "guests_present") return null;
  return formatMessage({ id: "channel.edit.disconnectGuestsPresent" }, { channel: `#${channelName}` });
}
