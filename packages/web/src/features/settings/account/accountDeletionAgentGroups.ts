/**
 * Delete Account's agent rows (v7, #triage:d10ace06): the person's agents,
 * one row per computer of theirs they run on, then one row per server for the
 * rest (hosted, or on someone else's computer). Built from GET's `agents`
 * (what becomes of each) and `computers` (the person's own computers and the
 * agents bound to each). Agents that close with their server aren't rows here:
 * the closing server's row says so.
 */
import type { AccountDeletionAgent, AccountDeletionChecklist, AccountDeletionServer, OthersAgentOnComputer } from "./accountDeletionApi";

export interface AccountDeletionAgentGroup {
  /** `computer:<id>` or `server:<id>`. */
  key: string;
  server: AccountDeletionServer;
  /** The person's computer these agents run on; null for the server's other agents. */
  computer: { id: string; name: string } | null;
  /** The person's agents in the row: handed to the server's owner, or (the personal assistant) archived. */
  agents: AccountDeletionAgent[];
  /** Who the handed-over agents go to; null while the person is still the server's only owner. */
  owner: { id: string; name: string } | null;
  /** How many of `agents` are handed over (the rest is the personal assistant). */
  handedOver: number;
  /** The personal assistant is one of `agents`. */
  hasAssistant: boolean;
  /** Other members' agents on this computer (they're Needs action rows: othersAgentsOnComputers). */
  othersAgents: Array<{ id: string; name: string }>;
}

const byName = (a: { name: string; id: string }, b: { name: string; id: string }) => a.name.localeCompare(b.name) || a.id.localeCompare(b.id);

function groupOf(
  key: string,
  server: AccountDeletionServer,
  computer: AccountDeletionAgentGroup["computer"],
  agents: AccountDeletionAgent[],
  othersAgents: AccountDeletionAgentGroup["othersAgents"],
): AccountDeletionAgentGroup {
  const handed = agents.filter((agent) => agent.outcome === "transfer_to_owner");
  return {
    key,
    server,
    computer,
    agents: [...agents].sort(byName),
    owner: handed.find((agent) => agent.toUser)?.toUser ?? null,
    handedOver: handed.length,
    hasAssistant: agents.some((agent) => agent.outcome === "archive_personal_assistant"),
    othersAgents: [...othersAgents].sort(byName),
  };
}

/**
 * Null while GET hasn't listed the agents (an older server): the page then
 * says it in general terms. `newOwners` names who the person just made an
 * Owner here, by server: GET's `toUser` stays empty until the cleanup picks
 * the owner, so the row says that name instead of "the new Owner".
 */
export function accountDeletionAgentGroups(
  checklist: Pick<AccountDeletionChecklist, "agents" | "computers"> | null,
  newOwners: ReadonlyMap<string, string> = new Map(),
): AccountDeletionAgentGroup[] | null {
  if (!checklist?.agents) return null;
  const kept = new Map(checklist.agents
    .filter((agent) => agent.outcome !== "closes_with_server")
    .map((agent) => [agent.id, agent]));
  const placed = new Set<string>();
  const computers = [...(checklist.computers ?? [])].sort((a, b) => a.server.name.localeCompare(b.server.name)
    || a.server.id.localeCompare(b.server.id)
    || byName(a, b));

  const groups: AccountDeletionAgentGroup[] = [];
  for (const computer of computers) {
    const own = computer.agents.flatMap((bound) => {
      const agent = bound.ownedByMe ? kept.get(bound.id) : undefined;
      return agent && !placed.has(agent.id) ? [agent] : [];
    });
    const others = computer.agents.filter((bound) => !bound.ownedByMe).map(({ id, name }) => ({ id, name }));
    if (own.length === 0 && others.length === 0) continue;
    for (const agent of own) placed.add(agent.id);
    groups.push(groupOf(`computer:${computer.id}`, computer.server, { id: computer.id, name: computer.name }, own, others));
  }

  const byServer = new Map<string, AccountDeletionAgent[]>();
  for (const agent of kept.values()) {
    if (placed.has(agent.id)) continue;
    byServer.set(agent.server.id, [...(byServer.get(agent.server.id) ?? []), agent]);
  }
  const serverGroups = [...byServer.values()]
    .map((agents) => groupOf(`server:${agents[0]!.server.id}`, agents[0]!.server, null, agents, []))
    .sort((a, b) => a.server.name.localeCompare(b.server.name) || a.server.id.localeCompare(b.server.id));
  return [...groups, ...serverGroups].map((group) => {
    const named = group.owner || group.handedOver === 0 ? undefined : newOwners.get(group.server.id);
    return named ? { ...group, owner: { id: "", name: named } } : group;
  });
}

/**
 * Other members' agents on the person's computers (GET's `computers`), each
 * a Needs action row until its owner moves it: by server, computer, then name.
 */
export function othersAgentsOnComputers(checklist: Pick<AccountDeletionChecklist, "computers"> | null): OthersAgentOnComputer[] {
  const seen = new Set<string>();
  return (checklist?.computers ?? []).flatMap((computer) => computer.agents.flatMap((agent) => {
    if (agent.ownedByMe || seen.has(agent.id)) return [];
    seen.add(agent.id);
    return [{
      id: agent.id,
      name: agent.name,
      server: computer.server,
      computer: { id: computer.id, name: computer.name },
      owner: agent.owner ?? null,
      ownerNotifiedAt: agent.ownerNotifiedAt ?? null,
      ownerNextNotifyAt: agent.ownerNextNotifyAt ?? null,
      personalAssistant: agent.personalAssistant === true,
    }];
  })).sort(othersAgentOrder);
}

export function othersAgentOrder(a: OthersAgentOnComputer, b: OthersAgentOnComputer): number {
  return a.server.name.localeCompare(b.server.name) || a.server.id.localeCompare(b.server.id)
    || byName(a.computer, b.computer) || byName(a, b);
}
