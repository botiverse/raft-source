import { sql, type SQL, type SQLWrapper } from "drizzle-orm";

import { agents } from "../db/schema";

/**
 * The kinds of agent, and what each kind may do on a server. One row a kind, so
 * a new kind is one row here rather than a judgement at every query that reads
 * `agents`; the type makes that row required. The conditions below are built
 * from it (agentKindRules.api.test.ts holds them to it, kind by kind).
 *
 * - `member`: in lists read from memberships (activeAppBotOrOrdinaryAgent).
 *   `while_bound`: only while its App binding and installation are active.
 * - `listed`: in server-wide sets (listedServerAgent).
 * - `findable`: who finds it at all (agentFindableBy): anyone, or its owner and
 *   itself.
 * - `seat`: takes a billing seat and counts against the free limit (seatAgent).
 * - `headcount`: in the shown agent count and the `#all` threshold
 *   (headcountAgent). An App's Bot is counted here but takes no seat.
 *
 * RaftBench service agents are not a kind here: nothing on the row says so
 * (raftbench_service_agents), and they are listed, findable and counted as
 * ordinary agents.
 */
export const AGENT_KIND_RULES = {
  ordinary: { member: "always", listed: "always", findable: "anyone", seat: true, headcount: true },
  personal_assistant: { member: "always", listed: "never", findable: "owner", seat: false, headcount: false },
  app_bot: { member: "while_bound", listed: "while_bound", findable: "anyone", seat: false, headcount: true },
} as const satisfies Record<string, {
  member: "always" | "while_bound";
  listed: "always" | "never" | "while_bound";
  findable: "anyone" | "owner";
  seat: boolean;
  headcount: boolean;
}>;

export type AgentKind = keyof typeof AGENT_KIND_RULES;

/** Which kind a row is. An assistant is never an App's Bot: each is created one way. */
export function agentKindOf(agent: { assistantOwnerUserId?: string | null; managedByAppInstallId?: string | null }): AgentKind {
  if (agent.assistantOwnerUserId) return "personal_assistant";
  if (agent.managedByAppInstallId) return "app_bot";
  return "ordinary";
}

type KindColumns = { id: SQLWrapper; managedByAppInstallId: SQLWrapper; assistantOwnerUserId: SQLWrapper };

/** The column that marks each kind that isn't ordinary: a row of that kind has it set. */
const KIND_MARK: Record<Exclude<AgentKind, "ordinary">, (agent: KindColumns) => SQLWrapper> = {
  personal_assistant: (agent) => agent.assistantOwnerUserId,
  app_bot: (agent) => agent.managedByAppInstallId,
};
const MARKED_KINDS = Object.keys(KIND_MARK) as (keyof typeof KIND_MARK)[];

/** The rows of the kinds `keeps` keeps, as one condition: an empty column for each kind it drops. */
function keptKinds(agent: KindColumns, keeps: (kind: AgentKind) => boolean): SQL<boolean> {
  const dropped = MARKED_KINDS.filter((kind) => !keeps(kind)).map((kind) => sql`${KIND_MARK[kind](agent)} is null`);
  return dropped.length === 0 ? sql<boolean>`true` : sql<boolean>`(${sql.join(dropped, sql` and `)})`;
}

/** Takes a billing seat and counts against the free limit (`seat`): for billing usage and downgrade stops. */
export function seatAgent(agent: KindColumns = agents): SQL<boolean> {
  return keptKinds(agent, (kind) => AGENT_KIND_RULES[kind].seat);
}

/** In the agent count a server shows and the `#all` threshold (`headcount`). */
export function headcountAgent(agent: KindColumns = agents): SQL<boolean> {
  return keptKinds(agent, (kind) => AGENT_KIND_RULES[kind].headcount);
}

/**
 * The one condition, beside `deleted_at IS NULL`, for an agent to be listed as
 * a member: in member lists and counts, the `#all` audience, mention
 * candidates and member pickers. Every such query uses this rather than
 * restating it, so the lists cannot disagree (Tenny, #proj-apps c6224144).
 * A server-wide set (not read from memberships) uses listedServerAgent, which
 * adds the personal-assistant exclusion.
 *
 * Why: removing an App's Bot (`disableManagedAppBot`) disables its binding but
 * keeps the agent row active and its channel memberships, so re-adding it
 * returns it to its channels. Until then it is hidden, not labelled (Kirby,
 * #proj-apps 1a58dba7). An ordinary agent always passes; a managed Bot passes
 * only while its binding and its installation are active.
 *
 * Not for history: message senders, open DMs and the Bot's own profile by id
 * keep resolving it, so old messages still show it with its Bot badge.
 */
export function activeAppBotOrOrdinaryAgent(
  agent: { id: SQLWrapper; managedByAppInstallId: SQLWrapper } = agents,
): SQL<boolean> {
  return sql<boolean>`(${agent.managedByAppInstallId} is null or exists (
    select 1
    from "app_bot_bindings" listed_bot_binding
    inner join "oauth_client_installs" listed_bot_install
      on listed_bot_install."id" = listed_bot_binding."install_id"
    where listed_bot_binding."agent_id" = ${agent.id}
      and listed_bot_binding."install_id" = ${agent.managedByAppInstallId}
      and listed_bot_binding."state" = 'active'
      and listed_bot_install."status" = 'active'
  ))`;
}

/**
 * activeAppBotOrOrdinaryAgent, less personal assistants: the agents a
 * server-wide set lists — the agents directory's member lists, member and
 * mention candidates, head counts, and the `#all` audience (tygg,
 * #proj-assistant a859e8fd). An assistant belongs to its owner, not the
 * server, and its only channel is the DM with its owner.
 *
 * Not for membership reads (channel_agents, thread follows): those decide who
 * a message is delivered to, and the assistant's DM must keep reaching it.
 */
export function listedServerAgent(
  agent: { id: SQLWrapper; managedByAppInstallId: SQLWrapper; assistantOwnerUserId: SQLWrapper } = agents,
): SQL<boolean> {
  return sql<boolean>`(${keptKinds(agent, (kind) => AGENT_KIND_RULES[kind].listed !== "never")} and ${activeAppBotOrOrdinaryAgent(agent)})`;
}

/**
 * Who may find an agent at all (tygg, Tenny, #proj-assistant 5cc12a51): a
 * personal assistant is found only by its owner (and by itself); nobody else,
 * a server owner or admin included, finds it in any list, by name or by id.
 * Every other agent passes. Unlike listedServerAgent this keeps the viewer's
 * own assistant and removed App Bots, which still resolve for history.
 *
 * Old messages an assistant sent for its owner still show it: they are the
 * owner's messages and carry `delegatedBy` (name, avatar) on the row itself.
 */
export type AgentFinder = { userId?: string | null; agentId?: string | null };

export function agentFindableBy(
  finder: AgentFinder,
  agent: { id: SQLWrapper; assistantOwnerUserId: SQLWrapper } = agents,
): SQL<boolean> {
  const own = finder.userId ? sql` or ${agent.assistantOwnerUserId} = ${finder.userId}` : sql``;
  const self = finder.agentId ? sql` or ${agent.id} = ${finder.agentId}` : sql``;
  return sql<boolean>`(${agent.assistantOwnerUserId} is null${own}${self})`;
}

/** agentFindableBy for a row already read. */
export function isAgentFindableBy(
  finder: AgentFinder,
  agent: { id: string; assistantOwnerUserId?: string | null },
): boolean {
  if (AGENT_KIND_RULES[agentKindOf(agent)].findable === "anyone") return true;
  return (!!finder.userId && agent.assistantOwnerUserId === finder.userId)
    || (!!finder.agentId && agent.id === finder.agentId);
}
