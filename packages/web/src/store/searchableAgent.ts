import type { Agent } from "./agentStore";

/**
 * Whether search and pickers (quick search, the sender filter, task filters)
 * may offer this directory agent to `viewerUserId`: a live agent that is not
 * another person's personal assistant (tygg, #proj-assistant task 15). The
 * server already leaves others' assistants out of `GET /agents` and its
 * events (agentFindableBy); this is the safety net for any record that still
 * reaches the store. The viewer's own assistant stays findable.
 */
export function isSearchableAgent(
  agent: Pick<Agent, "deletedAt" | "assistantOwnerUserId">,
  viewerUserId: string | null | undefined,
): boolean {
  if (agent.deletedAt) return false;
  return !agent.assistantOwnerUserId || (!!viewerUserId && agent.assistantOwnerUserId === viewerUserId);
}
