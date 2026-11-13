// View Context status (`GET /api/agents/:id/context-view/status`): whether a
// context view can be opened for an agent now, and why not. The Server derives
// it from the agent's current Computer (online, advertised capability) and the
// latest availability report that Computer sent (agentContextView.ts).

import type { AgentContextViewFailureReason } from "./agentContextView";
import type { AgentContextViewGrantId } from "./agentContextViewGrant";

/**
 * Why a context view is unavailable:
 * - `no_computer`: the agent does not run on a Computer (none bound, e.g. an
 *   external-runtime agent), so there is no context to show.
 * - `offline`: the agent's Computer is not connected.
 * - `old_daemon`: the Computer did not advertise `agent-context-view:v0`.
 * - `unsupported_runtime`: the daemon cannot read this runtime's context.
 * - `no_session`: nothing retained for the agent on its current Computer
 *   (no report yet, or the report came from another Computer).
 */
export const AGENT_CONTEXT_VIEW_STATUS_REASONS = ["no_computer", "offline", "old_daemon", "unsupported_runtime", "no_session"] as const;
export type AgentContextViewStatusReason = (typeof AGENT_CONTEXT_VIEW_STATUS_REASONS)[number];

/** Fields every status carries, available or not. */
export type AgentContextViewStatusDetails = {
  /** The report's runtime when there is one from the current Computer, else the agent's. */
  runtime: string;
  /** The agent's current Computer; null when the agent has none. */
  computer: { id: string; name: string } | null;
  /** The Computer's owner, only while a current (not retired) member of the agent's Server. */
  computerOwner: { id: string; name: string } | null;
  /** ISO 8601: the oldest request the Computer retains for the agent; null when unknown or none. */
  retainedSince: string | null;
  /** The Computer's retention (`AGENT_CONTEXT_VIEW_DEFAULT_RETENTION_DAYS` when it did not say). */
  retentionDays: number;
};

export type AgentContextViewStatus = AgentContextViewStatusDetails & (
  | { state: "available" }
  | { state: "unavailable"; reason: AgentContextViewStatusReason }
);

/**
 * How one view attempt ended (`GET /api/agents/:id/context-views`): `ok`, a
 * failure reason the viewer was shown (`AgentContextViewFailureReason`), or one
 * the Server alone records:
 * - `refused`: the viewer lost access (or the flag went off) between the
 *   request and the result; they were answered as for an unknown agent.
 * - `cancelled`: the viewer left before the answer was complete, or no
 *   outcome was recorded for the attempt (e.g. the viewer's replica stopped
 *   mid-view).
 */
export type AgentContextViewOutcome = "ok" | AgentContextViewFailureReason | "refused" | "cancelled";

/** One view attempt of an agent's context, newest first in `AgentContextViewRecordList`. Never anything from the context. */
/** What an agent's search or read asked (#wg-ax:#15); every viewer of the context can see it. */
export type AgentContextViewQueryRecord =
  | { mode: "search"; query: string; matches: number | null }
  | { mode: "read"; around: string };

export type AgentContextViewRecord = {
  /** The person who viewed, only while a current (not retired) member of the agent's Server; null for a former member. */
  viewer: { id: string; name: string } | null;
  /** ISO 8601, when the view was requested. */
  at: string;
  outcome: AgentContextViewOutcome;
  /** An agent viewed (its search or read); absent for a person's view. `viewer.id` is then the agent's. */
  viewerKind?: "agent";
  query?: AgentContextViewQueryRecord;
  /**
   * The grant an agent used to view another agent's context (agentContextViewGrant.ts);
   * absent for a person's view and for an agent viewing its own. `granter` is
   * named only while a current, not retired, non-Guest member of the server.
   */
  grant?: { id: AgentContextViewGrantId; granter: { id: string; name: string } | null };
};

export type AgentContextViewRecordList = { views: AgentContextViewRecord[] };
