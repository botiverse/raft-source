/**
 * What a person may pick when approving a one-time device-login grant
 * (device-auth design v2 §3.1, §3.4): the servers they may add a machine to
 * (`registerMachines`, the check POST /api/computer/attach makes) and the
 * external agents they may give a key to (the check POST
 * /api/agents/:id/credentials makes: `issueAgentCredentials` or human creator
 * authority, external runtime only). The approval page lists these; approve
 * checks the one picked against the same rule. Nothing is ever picked for
 * the person, even when there is only one choice.
 */
import { and, eq, inArray, isNull } from "drizzle-orm";
import { agentFindableBy } from "./agentMemberListPolicy";
import { isExternalAgentRuntime } from "@botiverse/raft-shared";
import { getDb } from "../db/index";
import { agents, serverMembers, servers } from "../db/schema";
import { actorRoleHasServerCapability, userCanActOnAgentResource } from "../lib/actorPermissions";

export interface AttachableServer {
  id: string;
  slug: string;
  name: string;
}

export interface KeyableAgent {
  id: string;
  name: string;
  displayName: string | null;
  serverId: string;
  serverName: string;
}

async function liveMemberships(userId: string, serverIds?: readonly string[]) {
  return getDb()
    .select({ serverId: servers.id, slug: servers.slug, name: servers.name, role: serverMembers.role })
    .from(serverMembers)
    .innerJoin(servers, eq(serverMembers.serverId, servers.id))
    .where(and(
      eq(serverMembers.userId, userId),
      isNull(servers.deletedAt),
      ...(serverIds ? [inArray(servers.id, [...serverIds])] : []),
    ));
}

/** Servers the person may add a machine to, by name. */
export async function listAttachableServers(userId: string): Promise<AttachableServer[]> {
  const memberships = await liveMemberships(userId);
  return memberships
    .filter((m) => actorRoleHasServerCapability(m.role, "registerMachines"))
    .map((m) => ({ id: m.serverId, slug: m.slug, name: m.name }))
    .sort((a, b) => a.name.localeCompare(b.name));
}

/** External agents the person may give a key to, by server then name. */
export async function listKeyableAgents(userId: string, onlyAgentId?: string): Promise<KeyableAgent[]> {
  const memberships = await liveMemberships(userId);
  if (memberships.length === 0) return [];
  const membershipByServer = new Map(memberships.map((m) => [m.serverId, m] as const));
  const rows = await getDb()
    .select({
      id: agents.id,
      name: agents.name,
      displayName: agents.displayName,
      serverId: agents.serverId,
      runtime: agents.runtime,
      creatorType: agents.creatorType,
      creatorId: agents.creatorId,
      assistantOwnerUserId: agents.assistantOwnerUserId,
    })
    .from(agents)
    .where(and(
      isNull(agents.deletedAt),
      // Never another person's personal assistant, as a choice or a pick.
      agentFindableBy({ userId }),
      inArray(agents.serverId, [...membershipByServer.keys()]),
      ...(onlyAgentId ? [eq(agents.id, onlyAgentId)] : []),
    ));
  return rows
    .filter((agent) => isExternalAgentRuntime(agent.runtime)
      && userCanActOnAgentResource(membershipByServer.get(agent.serverId)?.role, userId, agent, "issueAgentCredentials"))
    .map((agent) => ({
      id: agent.id,
      name: agent.name,
      displayName: agent.displayName,
      serverId: agent.serverId,
      serverName: membershipByServer.get(agent.serverId)!.name,
    }))
    .sort((a, b) => a.serverName.localeCompare(b.serverName) || a.name.localeCompare(b.name));
}

/** The server, when the person may add a machine to it; null otherwise (missing, deleted, not a member, no capability). */
export async function attachableServer(userId: string, serverId: string): Promise<AttachableServer | null> {
  const [m] = await liveMemberships(userId, [serverId]);
  if (!m || !actorRoleHasServerCapability(m.role, "registerMachines")) return null;
  return { id: m.serverId, slug: m.slug, name: m.name };
}

/** The agent, when the person may give it a key; null otherwise. */
export async function keyableAgent(userId: string, agentId: string): Promise<KeyableAgent | null> {
  return (await listKeyableAgents(userId, agentId))[0] ?? null;
}
