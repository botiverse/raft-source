import { useMemo } from "react";
import { useIntl } from "react-intl";
import { useAgentCurrentActivityState, useAgentStore } from "../../store/agentStore";
import type { AgentDisplayState } from "../../store/agentStore";
import { useMachineStore } from "../../store/machineStore";
import { useAgentRuntimeSignInView } from "../machine/useAgentRuntimeSignInView";
import { runtimeSignInNeededOf } from "../../utils/activity";
import { formatRuntimeSignInNeededDetail, formatRuntimeSignInNeededText } from "../../utils/runtimeSignInNeededCopy";

/** What the status surfaces show while the agent's start waits for its runtime's sign-in. */
export interface AgentRuntimeSignInNeeded {
  /** The agent's runtime id (Kimi Code is `kimi-sdk`), for the sign-in flow. */
  runtimeId: string;
  /** Its Computer, for the sign-in flow; null when the agent has none on record. */
  machineId: string | null;
  /** "Sign-in needed for Kimi Code". */
  fullText: string;
  /** "Sign-in needed", where there is no room for the runtime. */
  shortText: string;
  /** The sentence that replaces the daemon's (hover or secondary line). */
  detail: string;
}

/**
 * #triage:#494: `runtimeSignInNeededOf` for one agent, with its words: the
 * live failed start (this agent's current activity) and the stored record
 * (`lastRuntimeError`) from the agent list, its display name, its runtime's
 * name and its Computer's name ("this Computer" when the list has none).
 * Null for every other state, for an agent the list doesn't hold (its
 * runtime is unknown, so there is nothing to name), and once the viewer's
 * live read of the Computer says the runtime is signed in.
 *
 * `displayState` is the caller's `useAgentDisplayState` for the same agent.
 */
export function useAgentRuntimeSignInNeeded(agentId: string, displayState: AgentDisplayState): AgentRuntimeSignInNeeded | null {
  const { formatMessage } = useIntl();
  const agent = useAgentStore((state) => state.agents.find((candidate) => candidate.id === agentId));
  const activityState = useAgentCurrentActivityState(agentId);
  const machineId = agent?.machineId ?? null;
  const machineName = useMachineStore((state) => {
    if (!machineId) return null;
    const machine = state.machines.find((candidate) => candidate.id === machineId);
    return machine?.name?.trim() || machine?.hostname?.trim() || null;
  });
  const needed = Boolean(agent?.runtime) && runtimeSignInNeededOf({
    activity: displayState.activity,
    spawnFailure: activityState?.spawnFailure,
    lastRuntimeError: agent?.lastRuntimeError,
    blocked: displayState.blocked,
    paused: displayState.paused,
    likelyOnline: displayState.likelyOnline,
    isExternal: displayState.isExternal,
  });
  const runtimeId = agent?.runtime ?? "";
  const name = agent ? agent.displayName || agent.name : "";
  // The failed start (above all a stored one, kept until the next good start)
  // can outlive the sign-in it waited for: a viewer whose live read of the
  // Computer says the runtime is signed in now is not told otherwise.
  // `unknown` / `unavailable` keep the status (RuntimeSignInAction offers no Sign in then).
  const live = useAgentRuntimeSignInView(machineId, runtimeId, needed);
  const signedInNow = live.status?.kind === "logged_in";
  return useMemo(() => {
    if (!needed || signedInNow) return null;
    const computer = machineName ?? formatMessage({ id: "machine.runtimeAuth.thisComputer" });
    return {
      runtimeId,
      machineId,
      fullText: formatRuntimeSignInNeededText(formatMessage, runtimeId, "full"),
      shortText: formatRuntimeSignInNeededText(formatMessage, runtimeId, "short"),
      detail: formatRuntimeSignInNeededDetail(formatMessage, { name, runtime: runtimeId, computer }),
    };
  }, [formatMessage, machineId, machineName, name, needed, runtimeId, signedInNow]);
}
