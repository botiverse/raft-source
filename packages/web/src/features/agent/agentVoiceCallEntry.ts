// Raft voice calls (#wg-runtime-form:#22): who sees a Call button. The flag
// (agent_voice_v1) is on, the viewer is not a Guest, and the agent is one they
// can message that isn't deleted, an App's bot, stopped, or on a Computer known
// to be offline (no button where a call can't go through; artin, #22). An idle
// agent whose runtime is asleep can be called. Nothing else is asked of the
// server before the press: its answer to the start says whether the call can
// happen, and the call window says it.
import { useCallback } from "react";
import { AGENT_VOICE_FEATURE_FLAG_KEY } from "@botiverse/raft-shared";
import { useServerFeatureFlag } from "../../store/serverFeatureFlags";
import { useServerStore } from "../../store/serverStore";
import { isMachineOffline, useMachineStore } from "../../store/machineStore";
import { useAgentVoiceCallStore } from "./agentVoiceCallStore";

export type CallableAgent = {
  id: string;
  name: string;
  displayName?: string | null;
  avatarUrl?: string | null;
  deletedAt?: string | null;
  managedByAppInstallId?: string | null;
  /** "stopped": a person stopped it; no Call button. */
  status?: string | null;
  machineId?: string | null;
};

/** Start a call to the agent (or bring the call on now forward); undefined where there is no Call button. */
export function useAgentVoiceCallAction(agent: CallableAgent | null | undefined): (() => void) | undefined {
  const enabled = useServerFeatureFlag(AGENT_VOICE_FEATURE_FLAG_KEY).enabled;
  const serverId = useServerStore((s) => (s.current && s.current.role !== "guest" ? s.current.id : null));
  const startCall = useAgentVoiceCallStore((s) => s.startCall);
  const computerOffline = useMachineStore((s) => isMachineOffline(s.machines, agent?.machineId));
  const callable = enabled && !!serverId && !!agent && !agent.deletedAt && !agent.managedByAppInstallId
    && agent.status !== "stopped" && agent.machineId !== null && !computerOffline;
  const id = agent?.id;
  const name = agent ? agent.displayName || agent.name : "";
  const avatarUrl = agent?.avatarUrl ?? null;
  const call = useCallback(() => {
    if (id && serverId) startCall({ id, name, avatarUrl }, serverId);
  }, [avatarUrl, id, name, serverId, startCall]);
  return callable ? call : undefined;
}
