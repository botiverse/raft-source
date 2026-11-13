/**
 * #proj-runtime:#51: what a person did to an agent, and the restarts Raft did
 * by itself, as the agent's Activity overview shows them between turns.
 *
 * Producer: the server, from `agent_operator_events` (written by the route
 * that accepted the action) and `agent_config_change_events` (runtime, model
 * or reasoning effort changes). Consumer: the web overview, through
 * `GET /api/agents/:id/operator-events`. Ids and enums only: no message
 * content, no runtime config.
 */

/** Kinds stored in `agent_operator_events` (its CHECK constraint lists the same). */
export const AGENT_OPERATOR_EVENT_STORED_KINDS = [
  "start",
  "stop",
  "restart",
  "reset_session",
  "reset_full",
  "turn_stopped",
  "migration_started",
  "migration_cancelled",
  "system_restart",
] as const;
export type AgentOperatorEventStoredKind = typeof AGENT_OPERATOR_EVENT_STORED_KINDS[number];

/** What the overview shows: the stored kinds, plus a configuration change. */
export type AgentOperatorEventKind = AgentOperatorEventStoredKind | "config_changed";

/**
 * Who did it. `user` with `name: null` is a person the server no longer
 * names here (left the server, or deleted their account): shown as "someone".
 */
export type AgentOperatorEventActor =
  | { kind: "user"; name: string | null }
  | { kind: "system" };

export interface AgentOperatorEventDetails {
  /** migration_*: the Computers' names when the server still has them. */
  fromComputer?: string;
  toComputer?: string;
  /** config_changed: before → after of what changed (absent: unchanged). */
  beforeModel?: string;
  afterModel?: string;
  beforeRuntime?: string;
  afterRuntime?: string;
  beforeReasoningEffort?: string | null;
  afterReasoningEffort?: string | null;
}

export interface AgentOperatorEventView {
  id: string;
  /** Epoch ms. */
  at: number;
  kind: AgentOperatorEventKind;
  actor: AgentOperatorEventActor;
  details?: AgentOperatorEventDetails;
}

/** `GET /api/agents/:id/operator-events?since=<ms>&until=<ms>`: newest first. */
export interface AgentOperatorEventsPage {
  events: AgentOperatorEventView[];
  /** More events in the window than the page holds; the oldest are left out. */
  truncated: boolean;
}

export const AGENT_OPERATOR_EVENTS_PAGE_LIMIT = 200;
