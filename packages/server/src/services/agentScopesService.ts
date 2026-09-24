// agentScopesService — load and update an agent's permission scope grant.
//
// Contract locked at #proj-permission:10bdc2c9. Single row per agent in
// `agent_scopes`; whole-set updates only (no incremental scope add/remove).
//
// Authority model:
//   • Server-side checks are authoritative — `loadAgentScopes()` is the
//     read path that middleware and route handlers (including the
//     `/internal/agent-api/*` scope checks) all funnel through.
//   • Daemon caches are cooperative; `loadAgentScopes()` returns a stable
//     wire shape (`AgentScopeSet`) that the cache invalidation event can
//     replay verbatim.
//
// Default seeding:
//   When the row is missing, a read returns the full grantable set (every
//   scope is default-on in v1) without writing the row. The first explicit
//   write — admin clicks "Save scopes" — materializes the row at
//   revision 1. This keeps existing agents (created before this migration)
//   working without a backfill migration step.

import { eq } from "drizzle-orm";
import { getDb } from "../db/index.js";
import { agentScopes, agents } from "../db/schema.js";
import {
  AGENT_GRANTABLE_SCOPES,
  hasScope as hasScopeShared,
  sanitizeGrantedScopes,
  type AgentGrantableScope,
  type AgentScope,
  type AgentScopeSet,
} from "@botiverse/raft-shared";

export class AgentScopesNotFoundError extends Error {
  constructor(public readonly agentId: string) {
    super(`Agent ${agentId} not found`);
    this.name = "AgentScopesNotFoundError";
  }
}

function completeDefaultScopes(raw: readonly string[] | null | undefined): AgentGrantableScope[] {
  void raw;
  return [...AGENT_GRANTABLE_SCOPES];
}

/**
 * Load an agent's scope set. If the agent has no `agent_scopes` row yet,
 * returns the default-on set (synthesizing a virtual record) rather than
 * writing a row. The caller can treat the returned `AgentScopeSet` as
 * authoritative for permission checks.
 */
export async function loadAgentScopes(agentId: string): Promise<AgentScopeSet> {
  const db = getDb();
  const row = await db.query.agentScopes.findFirst({
    where: eq(agentScopes.agentId, agentId),
  });
  if (row) {
    const mode = row.mode ?? "custom";
    return {
      agentId,
      granted: mode === "default"
        ? completeDefaultScopes(row.scopes as readonly string[] | null)
        : sanitizeGrantedScopes(row.scopes as readonly string[] | null),
      mode,
      revision: row.revision,
      updatedAt: row.updatedAt.toISOString(),
    };
  }
  // No row yet — synthesize the full grantable set (every scope default-on
  // in v1). Treat it as revision 0 so the first explicit write bumps to
  // revision 1 and triggers the initial cache push.
  const agentExists = await db.query.agents.findFirst({
    where: eq(agents.id, agentId),
    columns: { id: true },
  });
  if (!agentExists) {
    throw new AgentScopesNotFoundError(agentId);
  }
  return {
    agentId,
    granted: [...AGENT_GRANTABLE_SCOPES],
    mode: "default",
    revision: 0,
    updatedAt: new Date(0).toISOString(),
  };
}

export interface UpdateAgentScopesArgs {
  agentId: string;
  /** Full grant set the human selected; sanitized inside the service. */
  scopes: readonly string[];
  /** Admin user committing the change. Recorded for audit. */
  updatedByUserId: string;
}

async function findAgentScopeTarget(agentId: string) {
  const db = getDb();
  const agentRow = await db.query.agents.findFirst({
    where: eq(agents.id, agentId),
    columns: { id: true, serverId: true },
  });
  if (!agentRow) {
    throw new AgentScopesNotFoundError(agentId);
  }
  return agentRow;
}

/**
 * Replace an agent's grant set wholesale and bump revision.
 * Returns the post-write `AgentScopeSet` (callers push this verbatim
 * over the `agent:scope-updated` ws event).
 */
export async function updateAgentScopes(args: UpdateAgentScopesArgs): Promise<AgentScopeSet> {
  const db = getDb();
  const sanitized = sanitizeGrantedScopes(args.scopes);

  const agentRow = await findAgentScopeTarget(args.agentId);

  const existing = await db.query.agentScopes.findFirst({
    where: eq(agentScopes.agentId, args.agentId),
  });
  const now = new Date();

  if (existing) {
    const nextRevision = existing.revision + 1;
    await db
      .update(agentScopes)
      .set({
        scopes: sanitized,
        mode: "custom",
        revision: nextRevision,
        updatedByUserId: args.updatedByUserId,
        updatedAt: now,
      })
      .where(eq(agentScopes.agentId, args.agentId));
    return {
      agentId: args.agentId,
      granted: sanitized,
      mode: "custom",
      revision: nextRevision,
      updatedAt: now.toISOString(),
    };
  }

  await db.insert(agentScopes).values({
    agentId: args.agentId,
    serverId: agentRow.serverId,
    scopes: sanitized,
    mode: "custom",
    revision: 1,
    updatedByUserId: args.updatedByUserId,
    createdAt: now,
    updatedAt: now,
  });
  return {
    agentId: args.agentId,
    granted: sanitized,
    mode: "custom",
    revision: 1,
    updatedAt: now.toISOString(),
  };
}

export async function resetAgentScopesToDefault(args: {
  agentId: string;
  updatedByUserId: string;
}): Promise<AgentScopeSet> {
  const db = getDb();
  const agentRow = await findAgentScopeTarget(args.agentId);
  const existing = await db.query.agentScopes.findFirst({
    where: eq(agentScopes.agentId, args.agentId),
  });
  const now = new Date();
  const scopes = [...AGENT_GRANTABLE_SCOPES];

  if (existing) {
    const nextRevision = existing.revision + 1;
    await db
      .update(agentScopes)
      .set({
        scopes,
        mode: "default",
        revision: nextRevision,
        updatedByUserId: args.updatedByUserId,
        updatedAt: now,
      })
      .where(eq(agentScopes.agentId, args.agentId));
    return {
      agentId: args.agentId,
      granted: scopes,
      mode: "default",
      revision: nextRevision,
      updatedAt: now.toISOString(),
    };
  }

  await db.insert(agentScopes).values({
    agentId: args.agentId,
    serverId: agentRow.serverId,
    scopes,
    mode: "default",
    revision: 1,
    updatedByUserId: args.updatedByUserId,
    createdAt: now,
    updatedAt: now,
  });
  return {
    agentId: args.agentId,
    granted: scopes,
    mode: "default",
    revision: 1,
    updatedAt: now.toISOString(),
  };
}

/** Convenience wrapper around `loadAgentScopes` + `hasScope` for callers
 *  that don't need to keep the scope set around. */
export async function agentHasScope(agentId: string, scope: AgentScope): Promise<boolean> {
  try {
    const set = await loadAgentScopes(agentId);
    return hasScopeShared(set, scope);
  } catch (err) {
    if (err instanceof AgentScopesNotFoundError) return false;
    throw err;
  }
}

/** Pure helper exposed for tests: same behavior as `hasScope` from shared,
 *  but accepts the granted array directly. */
export function grantedHasScope(granted: readonly AgentGrantableScope[], scope: AgentScope): boolean {
  return hasScopeShared(
    { agentId: "", granted: [...granted], mode: "custom", revision: 0, updatedAt: new Date(0).toISOString() },
    scope,
  );
}
