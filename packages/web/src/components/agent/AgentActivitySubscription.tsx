import { useAgentActivitySubscription } from "../../store/agentActivitySubscriptions";

/**
 * Detailed activity for these agents while this is rendered (the surface that
 * shows their live detail is on screen); renders nothing. A component, not a
 * hook call, so a surface can place it after its early returns.
 */
export default function AgentActivitySubscription({ agentIdKey }: {
  /** The agent ids joined by ","; empty: none. */
  agentIdKey: string;
}) {
  const key = agentIdKey ? [...new Set(agentIdKey.split(","))].filter(Boolean).sort().join(",") : "";
  useAgentActivitySubscription(key);
  return null;
}
