import { useCallback, useMemo } from "react";
import { useAgentStore } from "../../store/agentStore";
import type { Agent } from "../../store/agentStore";
import type { AgentCredentialInvalidInput } from "./AgentStatusBadge";

/**
 * #proj-raft-computer:#48: what the profile's status badge needs to name an
 * invalid credential, and its Retry. Retry is the menu's Restart (the same
 * request, `POST /agents/:id/reset {mode:"restart"}`), offered to exactly who
 * may make it: the reset route checks `controlAgentRuntime` (or the human
 * creator), as the caller's `canControlAgentRuntime` does. The badge shows it
 * whenever the agent cannot run until someone restarts it (an invalid
 * credential, an error, a paused or failed start: `agentNeedsManualRestart`),
 * not only for a credential.
 */
export function useAgentStatusCredential(
  agent: Pick<Agent, "id" | "runtime" | "model" | "lastRuntimeError" | "deletedAt"> | undefined,
  canControlAgentRuntime: boolean,
): AgentCredentialInvalidInput | undefined {
  const resetAgent = useAgentStore((s) => s.resetAgent);
  const agentId = agent?.id;
  const restartAgent = useCallback(() => (agentId ? resetAgent(agentId, "restart") : Promise.resolve()), [agentId, resetAgent]);
  return useMemo(() => agent ? {
    runtime: agent.runtime,
    model: agent.model,
    lastRuntimeError: agent.lastRuntimeError ?? null,
    ...(canControlAgentRuntime && !agent.deletedAt ? { onRetry: restartAgent } : {}),
  } : undefined, [agent, canControlAgentRuntime, restartAgent]);
}
