/**
 * The `mcp_connection.*` audit events (RFC 087 §7.4): an MCP App's Connection, shared or a member's
 * own, created, signed in, deleted, given to Agents, and an App's "Members can connect their own
 * account" switched. Written by a person's act, in the act's own transaction. Server-scoped
 * (category `membership`, which the server's owners and admins read).
 *
 * Metadata names the App, the Connection and whose it is; never the account label or email, the
 * endpoint or a secret (integrationAuditService's allowlist drops anything else too).
 */
import type { ServerRole } from "@botiverse/raft-shared";
import type { DatabaseExecutor } from "../db/index";
import { recordIntegrationAuditEvent, type IntegrationAuditEventType } from "./integrationAuditService";

export type McpConnectionAuditEventType = Extract<IntegrationAuditEventType, `mcp_connection.${string}`>;

/** The Connection facts every event carries. */
export interface McpConnectionAuditFacts {
  id: string;
  ownerKind: "shared" | "personal";
  ownerUserId: string | null;
}

export interface McpConnectionAuditInput {
  eventType: Exclude<McpConnectionAuditEventType, "mcp_connection.members_can_connect_changed">;
  serverId: string;
  app: { id: string; name: string };
  connection: McpConnectionAuditFacts;
  actorUserId: string;
  actorRole?: ServerRole | null;
  /** Event-specific keys (integrationAuditService's allowlist for the type). */
  metadata?: Record<string, unknown>;
}

export async function recordMcpConnectionAudit(executor: DatabaseExecutor, input: McpConnectionAuditInput): Promise<void> {
  await recordIntegrationAuditEvent({
    serverId: input.serverId,
    eventType: input.eventType,
    outcome: "success",
    source: "web",
    actor: { type: "human", id: input.actorUserId },
    // A member's own Connection is about that member; a shared one about the App.
    subject: input.connection.ownerKind === "personal" && input.connection.ownerUserId
      ? { type: "human", id: input.connection.ownerUserId }
      : { type: "app", id: input.app.id },
    target: { type: "managed_mcp_connection", id: input.connection.id },
    metadata: {
      ...input.metadata,
      appId: input.app.id,
      appName: input.app.name,
      connectionId: input.connection.id,
      ownerKind: input.connection.ownerKind,
      ...(input.connection.ownerUserId ? { ownerUserId: input.connection.ownerUserId } : {}),
      ...(input.actorRole ? { actorRole: input.actorRole } : {}),
    },
  }, executor);
}

export async function recordMembersCanConnectAudit(executor: DatabaseExecutor, input: {
  serverId: string;
  app: { id: string; name: string };
  actorUserId: string;
  actorRole?: ServerRole | null;
  enabled: boolean;
  previous: boolean;
}): Promise<void> {
  await recordIntegrationAuditEvent({
    serverId: input.serverId,
    eventType: "mcp_connection.members_can_connect_changed",
    outcome: "success",
    source: "web",
    actor: { type: "human", id: input.actorUserId },
    subject: { type: "app", id: input.app.id },
    target: { type: "managed_mcp_server", id: input.app.id },
    metadata: {
      appId: input.app.id,
      appName: input.app.name,
      enabled: input.enabled,
      previous: input.previous,
      ...(input.actorRole ? { actorRole: input.actorRole } : {}),
    },
  }, executor);
}

/** One `agents_changed` per Connection whose shared pins one write changed (the assignments routes). */
export interface McpPinChange {
  connectionId: string;
  added: string[];
  removed: string[];
  /** Added Agents that were pinned to another Connection before. */
  movedFrom: Array<{ agentId: string; connectionId: string; ownerKind: "shared"; ownerUserId: null }>;
}

/**
 * Which pins a write changed, from the (Agent, App) pins read before and after it: a map keyed by
 * `${agentId}:${appId}` to the bound Connection id (null: not pinned, or pinned to nothing).
 */
export function diffPins(
  before: ReadonlyMap<string, string | null>,
  after: ReadonlyMap<string, string | null>,
): McpPinChange[] {
  const changes = new Map<string, McpPinChange>();
  const change = (connectionId: string) => {
    let entry = changes.get(connectionId);
    if (!entry) {
      entry = { connectionId, added: [], removed: [], movedFrom: [] };
      changes.set(connectionId, entry);
    }
    return entry;
  };
  const keys = new Set([...before.keys(), ...after.keys()]);
  for (const key of keys) {
    const agentId = key.split(":")[0]!;
    const was = before.get(key) ?? null;
    const now = after.get(key) ?? null;
    if (was === now) continue;
    if (now) {
      const entry = change(now);
      entry.added.push(agentId);
      if (was) entry.movedFrom.push({ agentId, connectionId: was, ownerKind: "shared", ownerUserId: null });
    }
    if (was) change(was).removed.push(agentId);
  }
  return [...changes.values()];
}
