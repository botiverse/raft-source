import { useServerPermissions } from "../../hooks/useServerPermissions";
import { useAuthStore } from "../../store/authStore";
import { useMachineStore } from "../../store/machineStore";
import { useServerStore } from "../../store/serverStore";
import { canViewMachineRuntimeAccountUsage } from "../../utils/machineRuntimeUsageVisibility";
import { runtimeAuthClient, runtimeAuthStatusOf } from "../../utils/runtimeAuthClient";
import type { RuntimeAuthClient, RuntimeAuthView } from "../../utils/runtimeAuthClient";
import type { RuntimeAuthRuntime, RuntimeAuthStatus } from "@botiverse/raft-shared";
import { signInRuntimeFor } from "../../utils/runtimeSignInState";
import { runtimeSignInOffered } from "./runtimeSignInGate";
import { useRuntimeAuthView } from "./useRuntimeAuthView";

export interface AgentRuntimeSignInView {
  serverId: string | null;
  /** The runtime whose sign-in the agent's runtime uses; null when it has no single sign-in. */
  authRuntime: RuntimeAuthRuntime | null;
  view: RuntimeAuthView | null;
  /** The Computer's live state for that runtime; null while unread or for a viewer who may not see it. */
  status: RuntimeAuthStatus | null;
  /** Sign in is offered (`runtimeSignInOffered`). */
  offered: boolean;
}

/**
 * #triage:#494: the Computer's live sign-in state for an agent's runtime, for
 * the viewer who may see it (`canViewMachineRuntimeAccountUsage`, as the
 * runtime picker's notice): read only while `enabled` (the agent's start is
 * waiting for a sign-in), cached per Computer and re-read when it reports a
 * new one. The status hides "Sign-in needed" once this says signed in; the
 * Sign in button shows only when it is offered.
 */
export function useAgentRuntimeSignInView(
  machineId: string | null,
  runtimeId: string,
  enabled: boolean,
  client: RuntimeAuthClient = runtimeAuthClient,
): AgentRuntimeSignInView {
  const serverId = useServerStore((s) => s.current?.id ?? null);
  const machine = useMachineStore((s) => (machineId ? s.machines.find((m) => m.id === machineId) : undefined));
  const currentUserId = useAuthStore((s) => s.user?.id ?? null);
  const { capabilities } = useServerPermissions();
  const authRuntime = signInRuntimeFor(runtimeId);
  const active = enabled && authRuntime !== null && Boolean(serverId) && Boolean(machineId)
    && canViewMachineRuntimeAccountUsage(machine, currentUserId, capabilities);
  const { view } = useRuntimeAuthView(client, serverId ?? "", machineId ?? "", active);
  const status = active && authRuntime ? runtimeAuthStatusOf(view, authRuntime) : null;
  return {
    serverId,
    authRuntime,
    view: active ? view : null,
    status,
    offered: active && authRuntime !== null && runtimeSignInOffered(view, authRuntime),
  };
}
