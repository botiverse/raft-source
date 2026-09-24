import { useServerStore } from "./serverStore";
import {
  SYNC_CORE_NOTIFICATION_PREFS_FLAG_KEY,
  prefetchServerFeatureFlags,
  readServerFeatureFlag,
  resetServerFeatureFlagsForTests,
} from "./serverFeatureFlags";

export function isSyncCoreNotificationPrefsFlagEnabled(): boolean {
  const serverId = useServerStore.getState().current?.id ?? null;
  return readServerFeatureFlag(serverId, SYNC_CORE_NOTIFICATION_PREFS_FLAG_KEY);
}

export function refreshSyncCoreNotificationPrefsFlagForCurrentServer(): Promise<boolean> {
  const serverId = useServerStore.getState().current?.id ?? null;
  if (!serverId) return Promise.resolve(false);
  return prefetchServerFeatureFlags(serverId).then(
    (snapshot) => snapshot.values[SYNC_CORE_NOTIFICATION_PREFS_FLAG_KEY] === true,
  );
}

export function resetSyncCoreNotificationPrefsFlagForTests(): void {
  resetServerFeatureFlagsForTests();
}
