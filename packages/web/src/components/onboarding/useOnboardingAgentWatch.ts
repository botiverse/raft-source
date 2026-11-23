import { useEffect } from "react";

import { useAgentStore } from "../../store/agentStore";
import { useAgentActivitySubscription } from "../../store/agentActivitySubscriptions";
import { startVisiblePoll } from "../../utils/visiblePoll";

/** How often the handoff step re-reads the agent list while it watches her start. */
const ONBOARDING_AGENT_RECHECK_MS = 10_000;

/**
 * The onboarding agent's status and activity for the handoff step, on every
 * surface. The dedicated native page renders only the setup gate: no app
 * shell loads the agent list or carries its live pushes there, so the agent
 * is read on its own (`ensureAgentProfile`, GET /agents/:id, with its
 * activity) and subscribed to like any surface showing an agent. With `poll`
 * (the dedicated page only; the app shell carries live pushes elsewhere) it is
 * also re-read with the agent list (GET /agents) while the step shows and the
 * page is visible. Existing endpoints only.
 */
export function useOnboardingAgentWatch(agentId: string, poll: boolean): void {
  useAgentActivitySubscription(agentId);
  useEffect(() => {
    if (!agentId) return;
    const store = useAgentStore.getState();
    void store.ensureAgentProfile(agentId).catch(() => undefined);
    if (!poll) return;
    return startVisiblePoll(() => {
      void useAgentStore.getState().loadAgents().catch(() => undefined);
    }, { intervalMs: ONBOARDING_AGENT_RECHECK_MS });
  }, [agentId, poll]);
}
