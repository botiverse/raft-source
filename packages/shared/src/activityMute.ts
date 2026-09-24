/**
 * Canonical channel-type eligibility for human Activity mute.
 *
 * This predicate exists because server and web each carried their own copy and
 * they disagreed on exactly one type: `dm`. The server advertised
 * `activityMuteSupported: true` for every non-thread channel (so DMs claimed
 * support), while the web only ever renders the toggle for
 * channel / private / joint. The result was a capability the API announced and
 * no user-reachable surface exposed — observed on staging by @Jianwei
 * (#proj-qa:8aad2993, Web f5cf0470 x Server ef98efe4: DM API returned
 * `activityMuteSupported=true` while the DM DOM had zero `activity-mute-toggle`
 * nodes in both en and zh).
 *
 * Per-DM mute is documented as NOT a product feature — see
 * `manual/agent-knowledge/what-slock-doesnt-have.md` ("No per-DM mute. The
 * storage layer is per-target, but no user-reachable surface exposes it") and
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
 * - `dm`    — no per-DM mute surface exists (see module doc).
 * - `thread` — threads inherit their parent channel's mute state.
 */
export function channelTypeSupportsActivityMute(type: string | null | undefined): boolean {
  return (ACTIVITY_MUTE_SUPPORTED_CHANNEL_TYPES as readonly string[]).includes(type ?? "");
}
