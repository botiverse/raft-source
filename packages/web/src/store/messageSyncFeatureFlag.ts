import { useServerStore } from "./serverStore";
import {
  SYNC_CORE_MESSAGES_FLAG_KEY,
  prefetchServerFeatureFlags,
  readServerFeatureFlag,
  resetServerFeatureFlagsForTests,
} from "./serverFeatureFlags";

export function isSyncCoreMessagesFlagEnabled(): boolean {
  const serverId = useServerStore.getState().current?.id ?? null;
  return readServerFeatureFlag(serverId, SYNC_CORE_MESSAGES_FLAG_KEY);
}

export function refreshSyncCoreMessagesFlagForCurrentServer(): Promise<boolean> {
  const serverId = useServerStore.getState().current?.id ?? null;
  if (!serverId) return Promise.resolve(false);
  return prefetchServerFeatureFlags(serverId).then(
    (snapshot) => snapshot.values[SYNC_CORE_MESSAGES_FLAG_KEY] === true,
  );
}

export function resetSyncCoreMessagesFlagForTests(): void {
  resetServerFeatureFlagsForTests();
}
