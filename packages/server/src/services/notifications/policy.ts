/**
 * The one notification decision (design §3.3, contract §1.2). Pure.
 *
 * L = resolveEffectiveLevel(server, channel): an explicit channel level beats
 * the server's. A thread has no level: following it is what notifies
 * (category thread). A mute silences everything in the conversation, its
 * threads and @mentions included (Slack). Then by category:
 *
 *   personal (dm, mention, task_assigned, agent_attention, reminder,
 *   personal task_status, system_notice), thread, follower task_status:
 *                                  notify at all / mentions, not at none
 *   channel (ordinary message):    notify at all only
 *
 * The account switch "Replies in threads I follow" (followedThreadReplies,
 * default on) narrows `thread` alone: off, a followed-thread or
 * task-conversation reply notifies only when it @mentions the receiver
 * (normally such a reply is already category `mention`). Following, Activity
 * and its unread count are not decided here and stay as they are.
 *
 * Quiet (paused, or inside the daily quiet hours) overrides every level: no
 * alert anywhere, only the badge sync. `test` skips the policy.
 *
 * A security notice (a `system_notice` whose payload sets `securityNotice`:
 * someone asked to reset the person's two-step verification,
 * services/secondFactor/recovery.ts) is the one exception: it notifies
 * whatever the server level and quiet hours say, for a member of the server
 * it is under. Nothing else can set it (enqueued only by the server).
 *
 * What the inbox facts already filter is not re-decided here: the sender
 * (born-read), a muted channel's ordinary messages, and ordinary replies in an
 * unfollowed thread never reach the outbox.
 */
import {
  isNotificationQuiet,
  resolveEffectiveLevel,
  type NotificationAccountSettings,
  type NotificationCategory,
  type NotificationLevel,
  type NotificationLevelSetting,
} from "@botiverse/raft-shared";
import { isPersonalCategory, type NotificationDecision } from "./types";

export { isNotificationQuiet, resolveEffectiveLevel };

export interface NotificationPolicyInput {
  category: NotificationCategory;
  /** task_status: the receiver is the task's creator / assignee. */
  personal: boolean;
  /** The receiver's server level; null = not a member of the server. */
  serverLevel: NotificationLevel | null;
  /** Explicit channel (or DM) level; for a thread, its parent channel's. */
  channelLevel?: NotificationLevelSetting | null;
  /** The channel (or DM; for a thread, its parent) is muted in Activity. */
  muted: boolean;
  /** The receiver is @mentioned in the message (a DM row with personal_mention). */
  mentioned?: boolean;
  account: Pick<NotificationAccountSettings, "pausedUntil" | "quietHours"> & Partial<Pick<NotificationAccountSettings, "followedThreadReplies">>;
  /** A security notice (file comment): notifies past the level and quiet hours. Honored only for `system_notice`. */
  securityNotice?: boolean;
}

/** The receiver's switches that narrow a category beyond its level. */
export interface CategoryNotifyOptions {
  /** Account "Replies in threads I follow"; absent = on. */
  followedThreadReplies?: boolean;
  /** The message @mentions the receiver. */
  mentioned?: boolean;
}

/** Whether a category notifies at an effective level. */
export function categoryNotifiesAt(
  category: NotificationCategory,
  personal: boolean,
  level: NotificationLevel,
  options: CategoryNotifyOptions = {},
): boolean {
  if (category === "test") return true;
  if (level === "none") return false;
  if (category === "channel") return level === "all";
  if (category === "thread") return options.followedThreadReplies !== false || options.mentioned === true;
  return isPersonalCategory(category, personal) || category === "task_status";
}

function explicit(value: NotificationLevelSetting | null | undefined): NotificationLevel | null {
  return value && value !== "default" ? value : null;
}

export function decideNotification(input: NotificationPolicyInput, now: Date): NotificationDecision {
  if (input.category === "test") return { kind: "notify" };
  if (input.serverLevel === null) return { kind: "suppressed", reason: "not_member" };
  if (input.securityNotice === true && input.category === "system_notice") return { kind: "notify" };
  // A mute silences the conversation entirely, as in Slack: nothing in a muted
  // channel or DM (or a thread under it) pushes, @mentions included. What is
  // about me still reaches Activity and its count; only the alert is dropped.
  const level = resolveEffectiveLevel({
    server: input.serverLevel,
    channel: input.channelLevel ?? null,
    thread: null,
    muted: false,
  });
  const options = { followedThreadReplies: input.account.followedThreadReplies, mentioned: input.mentioned };
  if (!categoryNotifiesAt(input.category, input.personal, level, options)) {
    // The level would notify; only the followed-thread switch held it back.
    if (categoryNotifiesAt(input.category, input.personal, level)) return { kind: "suppressed", reason: "followed_thread_replies_off" };
    if (explicit(input.channelLevel)) return { kind: "suppressed", reason: "channel_level" };
    return { kind: "suppressed", reason: input.serverLevel === "none" ? "server_none" : "server_mentions" };
  }
  if (input.muted) return { kind: "suppressed", reason: "muted" };
  if (isNotificationQuiet(input.account, now)) return { kind: "quiet" };
  return { kind: "notify" };
}

/** What settings.ts loadNotificationPolicyPrefs returns (keys `<scopeId>:<userId>`). */
export interface NotificationPolicyPrefs {
  account: ReadonlyMap<string, NotificationAccountSettings>;
  serverLevel: ReadonlyMap<string, NotificationLevel>;
  channelLevel: ReadonlyMap<string, NotificationLevel>;
  mutedFromSeq: ReadonlyMap<string, number | null>;
}

/** The parts of one outbox row (and its event) the decision reads. */
export interface NotificationPolicyRow {
  receiverId: string;
  serverId: string;
  category: NotificationCategory;
  personal: boolean;
  /** The channel / DM whose level and mute apply (a thread's parent channel). Null: server level only. */
  levelChannelId: string | null;
  /** The thread / task conversation channel, for thread messages. */
  threadChannelId: string | null;
  /**
   * The message seq in `levelChannelId` (null for a thread reply or a
   * non-message event): muted when the mute started at or before it.
   */
  levelChannelSeq: number | null;
  /** The receiver is @mentioned (personal_mention on a message row). */
  mentioned?: boolean;
  /** A security notice (file comment; the notice payload's `securityNotice`). */
  securityNotice?: boolean;
}

export function isMutedFor(mutedFromSeq: number | null | undefined, seq: number | null): boolean {
  if (typeof mutedFromSeq !== "number") return false;
  return seq === null || seq >= mutedFromSeq;
}

/** decide(row, prefs, now): the policy for one receiver of one event. */
export function decide(
  row: NotificationPolicyRow,
  prefs: NotificationPolicyPrefs,
  now: Date,
  defaults: NotificationAccountSettings,
): NotificationDecision {
  const userKey = (scopeId: string) => `${scopeId}:${row.receiverId}`;
  return decideNotification({
    category: row.category,
    personal: row.personal,
    serverLevel: prefs.serverLevel.get(userKey(row.serverId)) ?? null,
    channelLevel: row.levelChannelId ? prefs.channelLevel.get(userKey(row.levelChannelId)) ?? null : null,
    muted: row.levelChannelId ? isMutedFor(prefs.mutedFromSeq.get(userKey(row.levelChannelId)), row.levelChannelSeq) : false,
    mentioned: row.mentioned,
    account: prefs.account.get(row.receiverId) ?? defaults,
    securityNotice: row.securityNotice,
  }, now);
}
