// View Context grants (#wg-ax:#15, Warden's rule): a server owner or admin
// lets one ordinary agent search and read other agents' View Context on that
// server (`raft context search|read` on a message another agent sent).
//
// Routes (human session, behind `agent_context_view_v0`):
// - GET    /api/servers/:id/agent-context-view-grants            the active grants (owners and admins)
// - POST   /api/servers/:id/agent-context-view-grants {agentId}  grant (owners and admins)
// - DELETE /api/servers/:id/agent-context-view-grants/:grantId   revoke (its granter, or any owner or admin)
//
// A grant is checked on every call and again when the result arrives: the
// granter must still be able to view the target agent's context
// (canViewAgentContext), the grantee must still be an ordinary agent of the
// server, and a personal assistant's context is never viewable through one.
// A grant that fails any of these stays in the table and simply stops working.

import type { Brand } from "./brandedIds";

/** One grant row. Opaque; minted by the Server only. */
export type AgentContextViewGrantId = Brand<string, "AgentContextViewGrantId">;

const GRANT_ID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** The Server's mint for a new grant id. */
export function mintAgentContextViewGrantId(): AgentContextViewGrantId {
  return globalThis.crypto.randomUUID() as AgentContextViewGrantId;
}

/** The only other mint: a grant id read back from the database or a route, checked. */
export function asAgentContextViewGrantId(value: string): AgentContextViewGrantId | null {
  return GRANT_ID_PATTERN.test(value) ? (value.toLowerCase() as AgentContextViewGrantId) : null;
}

/**
 * Why an active grant doesn't work right now, from the checks that don't
 * depend on a target: the granter left the server or deleted their account
 * (until the account-deletion cleanup removes that account's grants),
 * the granter is no longer an owner or admin, or the agent holding it is no
 * longer an ordinary, live agent of the server.
 */
export type AgentContextViewGrantUnusableReason = "granter_gone" | "granter_not_admin" | "agent_ineligible";

/** An active grant as the grants list shows it. */
export type AgentContextViewGrant = {
  id: AgentContextViewGrantId;
  /** The agent holding the grant. */
  agent: { id: string; name: string };
  /** Who granted it, while a current (not retired) member of the server; null for a former member. */
  granter: { id: string; name: string } | null;
  /** ISO 8601. */
  grantedAt: string;
  /**
   * False while one of the target-independent checks fails (`unusableReason`
   * says which). True does not mean the agent can view every agent: whether a
   * given target is viewable (the granter's canViewAgentContext for it, never a
   * personal assistant) is decided per target at call time. Absent from older
   * Servers.
   */
  usable?: boolean;
  unusableReason?: AgentContextViewGrantUnusableReason;
};

export type AgentContextViewGrantList = { grants: AgentContextViewGrant[] };

/** POST's answer: the active grant, and whether this request created it (false: it already had one). */
export type AgentContextViewGrantCreated = { grant: AgentContextViewGrant; created: boolean };

/** DELETE's answer: `revoked` false when it was already revoked (the request changes nothing). */
export type AgentContextViewGrantRevoked = { ok: true; revoked: boolean };
