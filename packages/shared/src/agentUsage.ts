/**
 * Agent token usage, as `GET /api/servers/:id/agent-usage` returns it
 * (#proj-o11y:42f2af5c). Built from each finished turn's `tokens`
 * (ActivityTurnSummary), added per agent, model and UTC day. Only the agents
 * the reader may inspect (the Activity rule) are in it; totals over them are
 * "the N agents you can see", not the whole server.
 *
 * A count is null when no turn of that row reported it (a runtime that does
 * not report reasoning, for instance): readers show it as unknown and leave it
 * out of sums, never as 0. Numbers and model names only.
 */
export interface AgentUsageRow {
  /** UTC date, YYYY-MM-DD, of the turns' end. */
  day: string;
  agent_id: string;
  /** The agent's runtime when the row was last added to. */
  runtime: string | null;
  /** The model as the runtime named it; "" when the turn did not say. */
  model: string;
  input_new: number | null;
  cache_read: number | null;
  cache_write: number | null;
  output: number | null;
  reasoning_output: number | null;
  /** Turns added to this row. */
  turns: number;
}

export interface AgentUsageContext {
  agent_id: string;
  /** Context in use at the end of the agent's latest turn that reported it. */
  context_used: number | null;
  context_window: number | null;
  /** ISO time of that turn's end. */
  at: string;
}

export interface AgentUsageAgent {
  agent_id: string;
  /** First UTC day with usage for this agent; null when it has none yet. */
  since: string | null;
  /**
   * Whether any of this agent's turns has reported usage. False reads as "its
   * Computer does not send usage yet" (an older Raft Computer, or a runtime
   * that reports none).
   */
  usage_reported: boolean;
}

export interface AgentUsageResponse {
  /** The UTC date range answered, inclusive. */
  from: string;
  to: string;
  /** ISO time the data is complete up to (the answer's time). */
  as_of: string;
  /** First UTC day this server has usage for; null when none yet. */
  since: string | null;
  /** How many agents the reader may inspect (the rows cover only these). */
  visible_agents: number;
  agents: AgentUsageAgent[];
  rows: AgentUsageRow[];
  context: AgentUsageContext[];
}

/** Longest range one request may ask for, in days (the panel's widest is 30; comparing needs 60). */
export const AGENT_USAGE_MAX_RANGE_DAYS = 90;
