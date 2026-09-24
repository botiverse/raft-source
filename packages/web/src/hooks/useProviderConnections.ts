import { useCallback, useEffect, useState } from "react";
import { PROVIDER_CONNECTIONS_FEATURE_FLAG_KEY } from "@botiverse/raft-shared";
import type {
  ProviderConnectionCatalog,
  ProviderConnectionProviderOption,
  ProviderConnectionSummary,
} from "@botiverse/raft-shared";
import api from "../api/client";
import { useServerFeatureFlag } from "../store/serverFeatureFlags";
import { useServerStore } from "../store/serverStore";

export function useProviderConnections(enabled = true) {
  const serverId = useServerStore((state) => state.current?.id ?? null);
  const feature = useServerFeatureFlag(PROVIDER_CONNECTIONS_FEATURE_FLAG_KEY);
  const requestEnabled = enabled && feature.enabled;
  const [connections, setConnections] = useState<ProviderConnectionSummary[]>([]);
  const [providerOptions, setProviderOptions] = useState<ProviderConnectionProviderOption[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState(false);

  const refresh = useCallback(async () => {
    if (!requestEnabled || !serverId) return;
    setLoading(true);
    setError(false);
    try {
      const { data } = await api.get<ProviderConnectionCatalog>("/provider-connections");
      setConnections(Array.isArray(data.connections) ? data.connections : []);
      setProviderOptions(Array.isArray(data.providerOptions) ? data.providerOptions : []);
    } catch {
      setConnections([]);
      setProviderOptions([]);
      setError(true);
    } finally {
      setLoading(false);
    }
  }, [requestEnabled, serverId]);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  return {
    connections: requestEnabled ? connections : [],
    providerOptions: requestEnabled ? providerOptions : [],
    loading: requestEnabled && loading,
    error: requestEnabled && error,
    refresh,
    featureEnabled: feature.enabled,
    featureResolved: feature.resolved,
  };
}
