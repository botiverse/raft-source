// Raft voice calls (#wg-runtime-form:#22): the call window's host, mounted
// once at the app root (App.tsx), so the call and its window stay while the
// person moves around the app. Nothing while there is no call.
import { useAgentVoiceCallStore } from "./agentVoiceCallStore";
import { AgentVoiceCallCard } from "./AgentVoiceCallCard";

export function AgentVoiceCallWindow() {
  const call = useAgentVoiceCallStore((s) => s.call);
  return call ? <AgentVoiceCallCard call={call} /> : null;
}
