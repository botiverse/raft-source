import { useAgentDisplayState } from "../../store/agentStore";
import type { Agent } from "../../store/agentStore";
import { RuntimeSignInAction } from "../machine/RuntimeSignInAction";
import { useAgentRuntimeSignInNeeded } from "./useAgentRuntimeSignInNeeded";

/**
 * #triage:#494: a channel member row's Sign in while the agent's start waits
 * for its runtime's sign-in, for a viewer who can act on its Computer
 * (`RuntimeSignInAction`'s gate). A sibling of the row's profile button (in
 * the trailing slot), never inside it. Its own module: `channelMemberParts`
 * is also read by rows that never offer it (and by code without a browser).
 */
export function AgentRuntimeSignInRowAction({ agentId, fallbackStatus }: { agentId: string; fallbackStatus: Agent["status"] }) {
  const displayState = useAgentDisplayState(agentId, { status: fallbackStatus });
  const signIn = useAgentRuntimeSignInNeeded(agentId, displayState);
  if (!signIn) return null;
  return <RuntimeSignInAction machineId={signIn.machineId} runtimeId={signIn.runtimeId} testId="member-row-sign-in" />;
}
