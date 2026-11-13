import type { ServerRole } from "@botiverse/raft-shared";
import type { MessageId } from "../../i18n/messages/en";
import type { Agent } from "../../store/agentStore";
import type { Machine } from "../../store/machineStore";
import { isMyComputer } from "../../components/layout/sidebarMachineOrder";
import type { ServerMember } from "../../store/serverStore";

/**
 * The Members page's tabs, grouping and order (raft-design
 * design/products/raft-chat/members.md; cindyz, #triage:36bfa2f8): pure, so
 * the page and its tests read the same rules.
 */
export type MembersTab = "all" | "humans" | "agents";

/** How the Agents tab groups its list. The other tabs have no choice. */
export type AgentsGrouping = "creator" | "computer" | "none";
export const AGENTS_GROUPINGS: readonly AgentsGrouping[] = ["none", "creator", "computer"];
export const DEFAULT_AGENTS_GROUPING: AgentsGrouping = "none";

export type MemberEntry =
  | { kind: "human"; id: string; name: string; handle: string; member: ServerMember }
  | { kind: "agent"; id: string; name: string; handle: string; agent: Agent };

/** A group of entries under a heading. `label` null: an ungrouped list, no heading. */
export interface MemberGroup {
  key: string;
  /** What the heading says, as a message to look up or a name to show as is. */
  label: { id: MessageId } | { text: string } | null;
  /** By creator: the viewer's own group, marked "(you)" and listed first. */
  self?: boolean;
  /** By creator: the creator is an agent, hinted so it never reads as a person of the same name. */
  agentCreator?: boolean;
  entries: MemberEntry[];
}

/** Who made an agent, when the agent's own summary is missing: a name from the member and agent lists. */
export type CreatorNameLookup = (type: "human" | "agent", id: string) => string | null;

/** What grouping by computer reads of a computer: its name, and whether it is the viewer's own (as the sidebar orders them). */
export type GroupingMachine = Pick<Machine, "name" | "computerAttachedByCurrentUser" | "ownerUserId">;

/**
 * The Agents tab's grouping choices. By creator names the people who made
 * agents, so it is left out where the server hides its people from a member
 * (hideHumansFromMembers).
 */
export function agentsGroupingOptions(creatorsHidden: boolean): readonly AgentsGrouping[] {
  return creatorsHidden ? AGENTS_GROUPINGS.filter((grouping) => grouping !== "creator") : AGENTS_GROUPINGS;
}

export function effectiveAgentsGrouping(grouping: AgentsGrouping, creatorsHidden: boolean): AgentsGrouping {
  return creatorsHidden && grouping === "creator" ? "computer" : grouping;
}

export function humanEntry(member: ServerMember): MemberEntry {
  return { kind: "human", id: member.userId, name: member.displayName || member.name, handle: member.name, member };
}

export function agentEntry(agent: Agent): MemberEntry {
  return { kind: "agent", id: agent.id, name: agent.displayName || agent.name, handle: agent.name, agent };
}

/** A name collator for the reader's language (the active locale), as the Computers list sorts. */
function collatorFor(locale: string): Intl.Collator {
  return new Intl.Collator(locale, { sensitivity: "base", numeric: true });
}

/** Every tab and every group reads by name, A–Z; there is no Sort. */
export function byName(collator: Intl.Collator, a: MemberEntry, b: MemberEntry): number {
  return collator.compare(a.name, b.name) || collator.compare(a.handle, b.handle);
}

/** The search matches the shown name or the handle, case-insensitively. */
export function matchesSearch(entry: MemberEntry, query: string): boolean {
  const q = query.trim().toLocaleLowerCase();
  if (!q) return true;
  return entry.name.toLocaleLowerCase().includes(q) || entry.handle.toLocaleLowerCase().includes(q);
}

/**
 * The role word beside a name: only Owner, Admin and Guest. Members are most
 * of the server, so a word on every tile would say nothing.
 */
export function roleWordId(role: ServerRole | null | undefined): MessageId | null {
  if (role === "owner") return "member.detail.roleOwner";
  if (role === "admin") return "member.detail.roleAdmin";
  if (role === "guest") return "member.detail.roleGuest";
  return null;
}

export function entryRole(entry: MemberEntry): ServerRole | null {
  return entry.kind === "human" ? entry.member.role : entry.agent.serverRole;
}

export interface MembersPopulation {
  /** People, guests among them (each with the Guest role word). */
  humans: MemberEntry[];
  agents: MemberEntry[];
}

/** Which tabs the viewer has: All, Humans and Agents, with Humans hidden by
 *  the server's "hide humans" setting for a member. Guests have no tab of
 *  their own: they are Humans (cindyz, three tabs). */
export function visibleTabs({ showHumans }: { showHumans: boolean }): MembersTab[] {
  return showHumans ? ["all", "humans", "agents"] : ["all", "agents"];
}

export function tabCount(tab: MembersTab, population: MembersPopulation): number {
  if (tab === "humans") return population.humans.length;
  if (tab === "agents") return population.agents.length;
  return population.humans.length + population.agents.length;
}

function sortedMatching(entries: MemberEntry[], query: string, collator: Intl.Collator): MemberEntry[] {
  return entries.filter((entry) => matchesSearch(entry, query)).sort((a, b) => byName(collator, a, b));
}

const NO_CREATOR_KEY = "creator:none";
const NO_COMPUTER_KEY = "computer:none";

function creatorOf(agent: Agent, lookup: CreatorNameLookup): { type: "human" | "agent"; id: string; name: string } | null {
  if (agent.creator) {
    return { type: agent.creator.type, id: agent.creator.id, name: agent.creator.displayName || agent.creator.name };
  }
  // A creator id the list sent no summary for: named from the members and agents the page has, if it can be.
  if (!agent.creatorId || !agent.creatorType) return null;
  const type = agent.creatorType === "user" ? "human" : "agent";
  const name = lookup(type, agent.creatorId);
  return name ? { type, id: agent.creatorId, name } : null;
}

function groupAgents(
  entries: MemberEntry[],
  grouping: AgentsGrouping,
  machines: ReadonlyMap<string, GroupingMachine>,
  selfId: string | undefined,
  lookup: CreatorNameLookup,
  collator: Intl.Collator,
): MemberGroup[] {
  if (grouping === "none") return entries.length ? [{ key: "agents", label: null, entries }] : [];
  const groups = new Map<string, MemberGroup>();
  // The viewer's own: the agents they made (By creator), their computers (By computer: isMyComputer, attached or owned).
  const ownKeys = new Set<string>();
  for (const entry of entries) {
    if (entry.kind !== "agent") continue;
    const { agent } = entry;
    let key: string;
    let label: MemberGroup["label"];
    let marks: Pick<MemberGroup, "self" | "agentCreator"> = {};
    if (grouping === "creator") {
      const creator = creatorOf(agent, lookup);
      if (creator) {
        key = `creator:${creator.type}:${creator.id}`;
        label = { text: creator.name };
        marks = creator.type === "agent" ? { agentCreator: true } : creator.id === selfId ? { self: true } : {};
        if (marks.self) ownKeys.add(key);
      } else {
        key = NO_CREATOR_KEY;
        label = { id: "members.page.group.noKnownCreator" };
      }
    } else {
      const machine = agent.machineId ? machines.get(agent.machineId) : undefined;
      if (agent.machineId && machine?.name) {
        key = `computer:${agent.machineId}`;
        label = { text: machine.name };
        if (isMyComputer(machine, selfId)) ownKeys.add(key);
      } else {
        key = NO_COMPUTER_KEY;
        label = { id: "members.page.group.noComputer" };
      }
    }
    let group = groups.get(key);
    if (!group) {
      group = { key, label, ...marks, entries: [] };
      groups.set(key, group);
    }
    group.entries.push(entry);
  }
  // The viewer's own first, then groups by their heading, A–Z; the one with
  // no creator (or no computer) last.
  const last = grouping === "creator" ? NO_CREATOR_KEY : NO_COMPUTER_KEY;
  const rank = (group: MemberGroup) => (group.key === last ? 2 : ownKeys.has(group.key) ? 0 : 1);
  return [...groups.values()].sort((a, b) => {
    if (rank(a) !== rank(b)) return rank(a) - rank(b);
    const at = a.label && "text" in a.label ? a.label.text : "";
    const bt = b.label && "text" in b.label ? b.label.text : "";
    return collator.compare(at, bt) || a.key.localeCompare(b.key);
  });
}

/**
 * What a tab shows: All by type (Humans, then Agents), guests among the
 * Humans by name; Humans as one list; Agents by the chosen grouping. Empty
 * groups are left out, so a search that matches no agent shows no Agents
 * heading.
 */
export function groupsForTab({
  tab,
  population,
  query,
  agentsGrouping,
  machines,
  selfId,
  creatorName = () => null,
  locale,
}: {
  /** The active locale: names sort in the reader's language. */
  locale: string;
  tab: MembersTab;
  population: MembersPopulation;
  query: string;
  /** The grouping in effect (effectiveAgentsGrouping). */
  agentsGrouping: AgentsGrouping;
  machines: ReadonlyMap<string, GroupingMachine>;
  selfId?: string;
  creatorName?: CreatorNameLookup;
}): MemberGroup[] {
  const collator = collatorFor(locale);
  if (tab === "all") {
    const typed: MemberGroup[] = [
      { key: "type:humans", label: { id: "layout.sidebar.humans" }, entries: sortedMatching(population.humans, query, collator) },
      { key: "type:agents", label: { id: "layout.sidebar.agents" }, entries: sortedMatching(population.agents, query, collator) },
    ];
    return typed.filter((group) => group.entries.length > 0);
  }
  if (tab === "agents") {
    return groupAgents(sortedMatching(population.agents, query, collator), agentsGrouping, machines, selfId, creatorName, collator);
  }
  const entries = sortedMatching(population.humans, query, collator);
  return entries.length ? [{ key: tab, label: null, entries }] : [];
}
