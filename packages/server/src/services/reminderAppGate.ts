import { evaluateFeatureFlag, REMINDER_APP_FEATURE_FLAG_KEY } from "./featureFlagService";
import { reminderAppMigratedForServer } from "../apps/reminder/appMigration";
import { serializeErrorForLog } from "../tracing/safeErrorLog";

/**
 * Whether reminders on this server live in the Reminder App: the
 * `reminder_app` flag is on, or the app is installed there and that
 * installation's legacy migration completed. The one gate for both the
 * legacy-write refusal (409 `reminders_moved_to_app`) and the agent prompt's
 * switch to the app (`config.reminderApp`), so the two never disagree. Any
 * failure reads as off: the legacy commands keep working.
 */
export async function reminderAppActiveForServer(serverId: string | null | undefined): Promise<boolean> {
  if (!serverId) return false;
  try {
    if ((await evaluateFeatureFlag({ key: REMINDER_APP_FEATURE_FLAG_KEY, serverId })).enabled === true) return true;
  } catch (error) {
    console.warn(`[reminder] ${REMINDER_APP_FEATURE_FLAG_KEY} evaluation failed; checking the install`, serializeErrorForLog(error));
  }
  try {
    return await reminderAppMigratedForServer(serverId);
  } catch (error) {
    console.warn("[reminder] Reminder App migration check failed; leaving legacy reminders on", serializeErrorForLog(error));
    return false;
  }
}

/**
 * The same gate without its fallbacks: any failure throws, for a caller that
 * must not answer "off" when it could not tell (the daemon's
 * `server:features`). `flagEnabled` is the `reminder_app` flag, evaluated by
 * the caller (in its own batch).
 */
export async function reminderAppActiveForServerStrict(serverId: string, flagEnabled: boolean): Promise<boolean> {
  return flagEnabled || await reminderAppMigratedForServer(serverId);
}
