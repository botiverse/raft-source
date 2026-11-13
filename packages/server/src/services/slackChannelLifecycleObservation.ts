import { parseSlackEditTimestamp, slackEditTimestampIsNewer } from "./slackMessageEditTimestamp";

declare const slackLifecycleClockBrand: unique symbol;
export type SlackLifecycleClock = string & { readonly [slackLifecycleClockBrand]: true };

/** Only provider adapters produce the normalized microsecond ordering key. */
export function parseSlackLifecycleClock(value: unknown): SlackLifecycleClock | null {
  const parsed = parseSlackEditTimestamp(value);
  return parsed as SlackLifecycleClock | null;
}

export function slackLifecycleClockAt(now: Date): SlackLifecycleClock {
  const ms = now.getTime();
  if (!Number.isSafeInteger(ms) || ms < 0) throw new Error("Invalid Slack lifecycle observation time");
  return `${Math.floor(ms / 1000)}.${String(ms % 1000).padStart(3, "0")}000` as SlackLifecycleClock;
}

export type SlackChannelLifecycleObservation = {
  recovery?: { attempt: number; lastCheckedAt: string; nextCheckAt: string };
  /** Fences member events that arrive while a provider audience read is in flight. */
  audienceEventRevision?: number;
  name?: { value: string; clock: SlackLifecycleClock };
  archive?: { archived: boolean; clock: SlackLifecycleClock };
  botMembership?: { member: boolean; clock: SlackLifecycleClock };
};

export function slackAudienceEventRevision(observation: SlackChannelLifecycleObservation | null): number | null {
  const value = observation?.audienceEventRevision ?? 0;
  return Number.isSafeInteger(value) && value >= 0 && value < Number.MAX_SAFE_INTEGER ? value : null;
}

export function slackLifecycleClockIsNewer(next: SlackLifecycleClock, previous?: SlackLifecycleClock): boolean {
  return !previous || slackEditTimestampIsNewer(next, previous);
}

/** Compare both observations; a provider refresh can be newer than the last event. */
export function latestSlackLifecycleClock(left: SlackLifecycleClock | null | undefined, right: SlackLifecycleClock): SlackLifecycleClock {
  return left && slackLifecycleClockIsNewer(left, right) ? left : right;
}

/** Provider event time truncated to the database's millisecond precision. */
export function slackLifecycleClockDate(clock: SlackLifecycleClock): Date {
  const [seconds, fraction = ""] = clock.split(".");
  return new Date(Number(seconds) * 1000 + Number(fraction.padEnd(3, "0").slice(0, 3)));
}

/** Verified presentation only; the signed event supplies actor identity. */
export interface SlackLifecycleMemberProfile {
  displayName: string;
  handle: string | null;
  actorKind: "human" | "guest" | "remote";
}
