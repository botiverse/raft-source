// `notification_followed_thread_replies_switch` (shared featureFlags.ts;
// docs/contracts/notifications.md §1.2, §2.1): whether the account switch
// "Replies in threads I follow" (followedThreadReplies) is offered and counts.
// Evaluated per user with no server (the setting is account-wide, so every
// server, device and the dispatcher get the same answer). Default off; a
// missing flag or an evaluation failure reads as off. Off:
// - the settings read, the PATCH answer and the account prefs frame leave
//   the field out (accountSettingsForClient);
// - a PATCH that sends it is accepted and the field ignored (no write);
// - the policy treats it as on whatever is stored (loadNotificationPolicyPrefs
//   asks only for receivers who stored it off; decideNotification).
// The column and its stored values are kept untouched either way.
import {
  NOTIFICATION_FOLLOWED_THREAD_REPLIES_SWITCH_FEATURE_FLAG_KEY,
  type NotificationAccountSettings,
} from "@botiverse/raft-shared";
import { getDb, type DatabaseExecutor } from "../../db/index";
import { serializeErrorForLog } from "../../tracing/safeErrorLog";
import { evaluateFeatureFlags } from "../featureFlagService";

/** Account settings as a client sees them: `followedThreadReplies` only while the switch is offered. */
export type ClientNotificationAccountSettings =
  Omit<NotificationAccountSettings, "followedThreadReplies"> & Partial<Pick<NotificationAccountSettings, "followedThreadReplies">>;

/** The users (of `userIds`) for whom the switch is on. Any failure reads as off for all. */
export async function followedThreadRepliesSwitchOnFor(
  userIds: readonly string[],
  executor: DatabaseExecutor = getDb(),
): Promise<Set<string>> {
  const ids = [...new Set(userIds)];
  const on = new Set<string>();
  if (ids.length === 0) return on;
  try {
    const evaluations = await evaluateFeatureFlags(
      ids.map((userId) => ({ key: NOTIFICATION_FOLLOWED_THREAD_REPLIES_SWITCH_FEATURE_FLAG_KEY, userId })),
      executor,
    );
    evaluations.forEach((evaluation, index) => {
      if (evaluation.enabled === true) on.add(ids[index]!);
    });
  } catch (error) {
    console.warn(`[Notifications] ${NOTIFICATION_FOLLOWED_THREAD_REPLIES_SWITCH_FEATURE_FLAG_KEY} evaluation failed; reading off`, serializeErrorForLog(error));
    on.clear();
  }
  return on;
}

export async function isFollowedThreadRepliesSwitchOn(userId: string, executor: DatabaseExecutor = getDb()): Promise<boolean> {
  return (await followedThreadRepliesSwitchOnFor([userId], executor)).has(userId);
}

/** The settings as answered to the person: off, without `followedThreadReplies`. */
export function accountSettingsForClient(settings: NotificationAccountSettings, switchOn: boolean): ClientNotificationAccountSettings {
  if (switchOn) return settings;
  const { followedThreadReplies: _hidden, ...rest } = settings;
  return rest;
}
