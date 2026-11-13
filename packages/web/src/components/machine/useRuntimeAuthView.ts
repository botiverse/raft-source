import { useCallback, useEffect, useRef, useState } from "react";
import type { RuntimeAuthClient, RuntimeAuthView } from "../../utils/runtimeAuthClient";

/**
 * The Computer's runtime sign-in state for this card: read once (cached per
 * Computer), and again whenever the Computer reports a new one.
 */
export function useRuntimeAuthView(client: RuntimeAuthClient, serverId: string, machineId: string, enabled: boolean) {
  const [state, setState] = useState<{ client: RuntimeAuthClient; serverId: string; machineId: string; view: RuntimeAuthView } | null>(null);
  const readRef = useRef<(() => void) | null>(null);
  useEffect(() => {
    if (!enabled) return;
    let live = true;
    // Only the newest read may land: an older answer that arrives after a
    // newer read started (a status update mid-read) is stale.
    let latest = 0;
    const load = () => {
      const seq = ++latest;
      client.read(serverId, machineId).then((view) => {
        if (live && seq === latest) setState({ client, serverId, machineId, view });
      }, () => {
        // Not allowed to see it, or the read failed: the card stays as usage alone.
      });
    };
    readRef.current = load;
    load();
    const unwatch = client.watch(machineId, load);
    return () => {
      live = false;
      readRef.current = null;
      unwatch();
    };
  }, [client, enabled, machineId, serverId]);
  const view = enabled && state && state.client === client && state.serverId === serverId && state.machineId === machineId
    ? state.view
    : null;
  const reread = useCallback(() => readRef.current?.(), []);
  return { view, reread };
}
