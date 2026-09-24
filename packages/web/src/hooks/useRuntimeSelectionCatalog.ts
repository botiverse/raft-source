import { useEffect, useState } from "react";
import type { RuntimeSelectionCatalog, RuntimeSelectionOption } from "@botiverse/raft-shared";
import api from "../api/client";
import { useServerStore } from "../store/serverStore";

type RuntimeSelectionCatalogState = {
  requestKey: string;
  options: RuntimeSelectionOption[];
  loading: boolean;
};

const EMPTY_OPTIONS: RuntimeSelectionOption[] = [];

function catalogOptions(payload: RuntimeSelectionCatalog): RuntimeSelectionOption[] {
  return Array.isArray(payload?.options) ? payload.options : EMPTY_OPTIONS;
}

function capabilitySignature(runtimeIds: readonly string[]): string {
  return [...runtimeIds].sort().join("\u0000");
}

function useRuntimeSelectionCatalog(
  path: string | null,
  refreshKey: string,
): { options: RuntimeSelectionOption[]; loading: boolean } {
  const requestKey = path ? `${path}:${refreshKey}` : "";
  const [state, setState] = useState<RuntimeSelectionCatalogState>({
    requestKey: "",
    options: EMPTY_OPTIONS,
    loading: false,
  });

  // Async-loader: fail closed while the contextual server projection is stale,
  // unavailable, or malformed. Runtime admission must never fall back to the
  // raw Computer capability list.
  // oxlint-disable-next-line react-doctor/no-cascading-set-state
  useEffect(() => {
    if (!path) return;
    let cancelled = false;
    setState({ requestKey, options: EMPTY_OPTIONS, loading: true });
    void api.get<RuntimeSelectionCatalog>(path)
      .then(({ data }) => {
        if (!cancelled) setState({ requestKey, options: catalogOptions(data), loading: false });
      })
      .catch(() => {
        if (!cancelled) setState({ requestKey, options: EMPTY_OPTIONS, loading: false });
      });
    return () => {
      cancelled = true;
    };
  }, [path, requestKey]);

  if (!path || state.requestKey !== requestKey) {
    return { options: EMPTY_OPTIONS, loading: Boolean(path) };
  }
  return { options: state.options, loading: state.loading };
}

export function useNewAgentRuntimeOptions(
  machineId: string | null | undefined,
  machineRuntimeIds: readonly string[],
) {
  const serverId = useServerStore((state) => state.current?.id);
  const path = serverId && machineId
    ? `/servers/${serverId}/machines/${machineId}/runtime-options`
    : null;
  const signature = capabilitySignature(machineRuntimeIds);
  return useRuntimeSelectionCatalog(path, signature);
}

/**
 * `enabled` exists because suppressing a surface in the render tree does not
 * suppress its loaders: hooks run unconditionally. A peer-server agent's public
 * profile hides every operational control, yet this catalog would still ask the
 * CURRENT server for a FOREIGN agent's runtime options — a private subresource
 * the viewer's server has no business being asked for. (task #21)
 *
 * Mirrors `useProviderConnections(enabled)` in the same panel.
 */
export function useExistingAgentRuntimeOptions(
  agentId: string,
  machineRuntimeIds: readonly string[],
  enabled = true,
) {
  const signature = capabilitySignature(machineRuntimeIds);
  return useRuntimeSelectionCatalog(
    enabled ? `/agents/${agentId}/runtime-options` : null,
    signature,
  );
}
