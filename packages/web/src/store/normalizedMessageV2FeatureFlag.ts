import { useServerStore } from "./serverStore";
import {
  prefetchServerFeatureFlags,
  getServerFeatureFlagSnapshot,
  readServerFeatureFlag,
  resetServerFeatureFlagsForTests,
  subscribeServerFeatureFlags,
  SYNC_CORE_MESSAGES_FLAG_KEY,
} from "./serverFeatureFlags";

type NormalizedMessageV2ActivationHandler = (serverId: string) => void;

const activationHandlers = new Set<NormalizedMessageV2ActivationHandler>();
const activatedServers = new Set<string>();

function observeCurrentServerFlagTransition(): void {
  const serverId = useServerStore.getState().current?.id ?? null;
  if (!serverId) return;
  const snapshot = getServerFeatureFlagSnapshot(serverId);
  const enabled = snapshot.resolved
    && snapshot.values[SYNC_CORE_MESSAGES_FLAG_KEY] === true;
  if (!enabled) {
    activatedServers.delete(serverId);
    return;
  }
  if (activatedServers.has(serverId)) return;
  activatedServers.add(serverId);
  for (const handler of activationHandlers) handler(serverId);
}

subscribeServerFeatureFlags(observeCurrentServerFlagTransition);

export function registerNormalizedMessageV2Activation(
  handler: NormalizedMessageV2ActivationHandler,
): () => void {
  activationHandlers.add(handler);
  observeCurrentServerFlagTransition();
  return () => activationHandlers.delete(handler);
}

export function isNormalizedMessageV2FlagEnabled(): boolean {
  const serverId = useServerStore.getState().current?.id ?? null;
  return readServerFeatureFlag(serverId, SYNC_CORE_MESSAGES_FLAG_KEY);
}

export function refreshNormalizedMessageV2FlagForCurrentServer(): Promise<boolean> {
  const serverId = useServerStore.getState().current?.id ?? null;
  if (!serverId) return Promise.resolve(false);
  return prefetchServerFeatureFlags(serverId).then(
    (snapshot) => snapshot.values[SYNC_CORE_MESSAGES_FLAG_KEY] === true,
  );
}

export function resetNormalizedMessageV2FlagForTests(): void {
  activatedServers.clear();
  resetServerFeatureFlagsForTests();
}
