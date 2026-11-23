import { useCallback } from "react";

import { useRuntimeAuthView } from "../../components/machine/useRuntimeAuthView";
import { runtimeAuthClient } from "../../utils/runtimeAuthClient";
import { runtimeSignInState } from "../../utils/runtimeSignInState";
import type { RuntimeSignInState } from "../../utils/runtimeSignInState";

/**
 * Create Cindy's read of the Computer's runtime sign-in state, for its pick
 * (pickCreateAgentRuntime): a bundled runtime is always "available", signed in
 * or not (mail #214). Off (`enabled` false) everything is `unknown`, and so
 * is every runtime until the read lands.
 */
export function useCreateCindySignInState(serverId: string | null | undefined, machineId: string, enabled: boolean): (runtimeId: string) => RuntimeSignInState {
  const { view } = useRuntimeAuthView(runtimeAuthClient, serverId ?? "", machineId, enabled && Boolean(serverId) && Boolean(machineId));
  return useCallback((runtimeId: string) => runtimeSignInState(view, runtimeId), [view]);
}
