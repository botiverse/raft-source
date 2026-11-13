/**
 * Canonical eligibility for human Activity mute.
 *
 * This module exists because server and web each carried their own copy and
 * they disagreed on exactly one type: `dm`. The server advertised
 * `activityMuteSupported: true` for every non-thread channel (so DMs claimed
 * support), while the web only ever renders the toggle for
 * channel / private / joint. The result was a capability the API announced and
 * no user-reachable surface exposed — observed on staging by @Jianwei
 * (#proj-qa:8aad2993, Web f5cf0470 x Server ef98efe4: DM API returned
 * `activityMuteSupported=true` while the DM DOM had zero `activity-mute-toggle`
 * nodes in both en and zh).
 *
 * Per-DM mute exists only for a DM with an App bot (artin 2026-10-28,
 * #proj-apps:6c85e2b5): a person can mute what an App posts to them, as they
 * mute a channel. Every other DM (with a person or an ordinary agent) is still
 * direct and cannot be muted — see
 * `manual/agent-knowledge/what-raft-doesnt-have.md` and
 * `manual/agent-knowledge/notifications.md`. Storage being per-target is not a
 * feature; a capability claim has to be sourced from a reachable surface.
 *
 * Keep this the single definition. A capability flag that is computed twice is
 * a crack waiting to reopen.
 */
export type ActivityMuteChannelType = "channel" | "private" | "joint" | "dm" | "thread";

/** Channel types with a user-reachable Activity mute control. */
export const ACTIVITY_MUTE_SUPPORTED_CHANNEL_TYPES = ["channel", "private", "joint"] as const;

export type ActivityMuteSupportedChannelType = (typeof ACTIVITY_MUTE_SUPPORTED_CHANNEL_TYPES)[number];

/**
 * True when this channel type has a user-reachable Activity mute control.
 *
 * Deliberately excluded:
 * - `dm`    — only a DM with an App bot can be muted; see `activityMuteSupportedFor`.
 * - `thread` — threads inherit their parent channel's mute state.
 */
export function channelTypeSupportsActivityMute(type: string | null | undefined): boolean {
  return (ACTIVITY_MUTE_SUPPORTED_CHANNEL_TYPES as readonly string[]).includes(type ?? "");
}

/**
 * True when a person can Activity-mute this conversation: a channel type above,
 * or a DM whose peer is an App bot that has not been removed.
 */
export function activityMuteSupportedFor(conversation: {
  type: string | null | undefined;
  dmPeerIsAppBot?: boolean;
}): boolean {
  if (conversation.type === "dm") return conversation.dmPeerIsAppBot === true;
  return channelTypeSupportsActivityMute(conversation.type);
}
