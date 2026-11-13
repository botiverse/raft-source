import { Button } from "@botiverse/raft-ui";
import { useCallback } from "react";
import { useIntl } from "react-intl";
import { Play, Square } from "lucide-react";
import { useAgentStore, useAgentDisplayState } from "../../store/agentStore";
import { agentRuntimeControls } from "../../utils/agentBlockedState";

// Isolated start/stop button — subscribes to activity for this agent only.
// No Start while the agent's Computer is offline (agentRuntimeControls, #triage:#206); a refusal goes to
// `onStartSettled`, the same handler as the profile header's Start.
export function AgentStartStopButton({ agentId, canStopAgent, onShowStopConfirm, computerOffline, onStartSettled }: {
  agentId: string;
  canStopAgent: boolean;
  onShowStopConfirm: () => void;
  computerOffline: boolean;
  onStartSettled: (error: unknown) => void;
}) {
  const { formatMessage } = useIntl();
  const displayState = useAgentDisplayState(agentId);
  const startAgent = useAgentStore((s) => s.startAgent);
  const isOnline = displayState.isOnline;
  const stoppedByPerson = useAgentStore((s) => s.agents.find((agent) => agent.id === agentId)?.status === "stopped");
  const handleStart = useCallback(() => {
    startAgent(agentId).then(() => onStartSettled(null), onStartSettled);
  }, [startAgent, agentId, onStartSettled]);
  const controls = agentRuntimeControls({ canControl: true, canStop: canStopAgent, isOnline, computerOffline, stoppedByPerson });
  if (!controls.start && !controls.stop) return null;
  return (
    <Button variant="outline" size="lg"
      onClick={controls.stop ? onShowStopConfirm : handleStart}
      className="flex w-full items-center justify-center gap-2"
    >
      {controls.stop ? <Square size={14} /> : <Play size={14} />}
      {controls.stop
        ? formatMessage({ id: "agent.detail.stopAgent" })
        : formatMessage({ id: "agent.detail.startAgent" })}
    </Button>
  );
}
