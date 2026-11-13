// Agent activity, scoped to who is watching (#proj-frontend:#8, Tenny's design).
//
// Today every member's tab gets every agent's detailed `agent:activity` push
// (several a second on a server with many agents). A client that declares
// AGENT_ACTIVITY_SUBSCRIPTIONS_CAPABILITY in its socket handshake instead:
// - gets the detailed `agent:activity` push only for the agents it subscribes
//   to (AGENT_ACTIVITY_SUBSCRIBE_EVENT), while a surface that shows their
//   detail is on screen (the agent's DM, its detail panel, a channel's member
//   list);
// - gets AGENT_ACTIVITY_STATE_EVENT for every agent of the server, sent only
//   when the coarse state (offline / online / busy / error) changes and at
//   most once per agent every AGENT_ACTIVITY_STATE_MIN_INTERVAL_MS: enough for
//   status dots and the sidebar.
// A client without the capability (the current mobile App, an old web tab)
// keeps receiving every detailed push, unchanged.

export const AGENT_ACTIVITY_SUBSCRIPTIONS_CAPABILITY = "agent_activity_subscriptions_v1";

/** Client -> server: `{ agentIds: string[] }`; answered with AGENT_ACTIVITY_SUBSCRIBED_EVENT. */
export const AGENT_ACTIVITY_SUBSCRIBE_EVENT = "agent:activity:subscribe";
/** Client -> server: `{ agentIds: string[] }`. */
export const AGENT_ACTIVITY_UNSUBSCRIBE_EVENT = "agent:activity:unsubscribe";
/** Server -> client: `{ agentIds: string[] }`, the ids this socket now receives detail for (denied ids left out). */
export const AGENT_ACTIVITY_SUBSCRIBED_EVENT = "agent:activity:subscribed";
/** Server -> client: AgentActivityStatePayload. */
export const AGENT_ACTIVITY_STATE_EVENT = "agent:activity_state";

export const AGENT_ACTIVITY_STATE_MIN_INTERVAL_MS = 5_000;
/** Most agent ids one subscribe or unsubscribe may name. */
export const AGENT_ACTIVITY_SUBSCRIBE_MAX_IDS = 200;

export type AgentActivityCoarseState = "offline" | "online" | "busy" | "error";

export interface AgentActivityStatePayload {
  agentId: string;
  state: AgentActivityCoarseState;
  /** The detailed activity this state was derived from (working / thinking for busy). */
  activity: string;
  timestamp: number;
  /** The server seq of the detailed push it was derived from (same counter as `agent:activity`). */
  serverSeq: number;
}

/** The coarse state of an activity: what a status dot shows (thinking and working are both busy). */
export function coarseAgentActivityState(activity: string): AgentActivityCoarseState {
  if (activity === "working" || activity === "thinking") return "busy";
  if (activity === "error") return "error";
  if (activity === "offline") return "offline";
  return "online";
}

/** The socket room of one agent's detailed activity. */
export function agentActivityRoom(agentId: string): string {
  return `agent-activity:${agentId}`;
}

/** The socket room of a server's members whose client declared the capability. */
export function agentActivityCapableServerRoom(serverId: string): string {
  return `server:${serverId}:agent-activity-v1`;
}

/** The capabilities a handshake `auth` object declares (unknown shapes: none). */
export function socketHandshakeCapabilities(auth: unknown): Set<string> {
  if (!auth || typeof auth !== "object" || Array.isArray(auth)) return new Set();
  const value = (auth as Record<string, unknown>).capabilities;
  if (!Array.isArray(value)) return new Set();
  return new Set(value.filter((item): item is string => typeof item === "string").slice(0, 32));
}
