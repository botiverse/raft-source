// Agent Lounge v0 (#proj-chat:#15, behind agent_lounge_v0): one public
// channel per agent where every non-guest human of the Server talks with that
// agent. The channel is an ordinary public channel (type 'channel'); an
// agent_lounges row is what makes it a lounge. Rules (#proj-chat:30a58e4d):
//
// - The lounge's own agent is its only agent member. Other agents may read it
//   by link or id and find it in search, as any public channel, but never take
//   part: no join, post, react, add, follow, mute or task action, and no
//   mention delivery. The database refuses their channel_agents row (trigger
//   channel_agents_agent_lounge_guard), which closes every membership-based
//   write; isLoungeOutsiderAgent closes the few writes that do not need
//   membership.
// - It is not listed: not in other agents' channel directory, not in the human
//   channel list (the web gets it from the DM list), not in public search.
// - Humans: any non-guest member of the Server may post; the first post joins.
//   Guests cannot read it (they read only their own channel).
import { and, eq, inArray, isNull, sql, type SQL, type Column } from "drizzle-orm";
import { getDb, type DatabaseExecutor } from "../db/index";
import { agentLounges, agents, channelAgents, channelHumans, channels } from "../db/schema";
import { withServerLock } from "./planService";

/** The pending-mention reason for an agent mentioned in a lounge it is not the agent of. */
export const AGENT_LOUNGE_EXCLUDED_REASON = "lounge_agent_excluded";

/** The refusal an outsider agent gets (join, add, follow, task assignment). */
export const AGENT_LOUNGE_OUTSIDER_REFUSAL =
  "This is another agent's lounge. You can read it, but only its own agent takes part.";

/** The refusal for adding another agent to a lounge. */
export const AGENT_LOUNGE_OUTSIDER_ADD_REFUSAL =
  "Only the lounge's own agent takes part in an agent's lounge; other agents cannot be added.";

export class AgentLoungeOutsiderError extends Error {
  readonly code = "AGENT_LOUNGE_OUTSIDER";
  constructor() {
    super(AGENT_LOUNGE_OUTSIDER_REFUSAL);
  }
}

/** A refusal for a lounge setting no one may change (name, visibility, type). */
export class AgentLoungeImmutableError extends Error {
  readonly code = "AGENT_LOUNGE_IMMUTABLE";
  constructor() {
    super("An agent's lounge cannot be renamed, made private or converted.");
  }
}

/** SQL: the channel in `column` is not a lounge (for list queries). */
export function notAgentLoungeChannel(column: Column | SQL): SQL {
  return sql`not exists (select 1 from ${agentLounges} where ${agentLounges.channelId} = ${column})`;
}

/** channelId -> the lounge's agent (null when that agent is gone) for the lounges among `channelIds`. */
export async function getLoungeAgentIds(
  channelIds: readonly string[],
  executor: DatabaseExecutor = getDb(),
): Promise<Map<string, string | null>> {
  const ids = [...new Set(channelIds)];
  if (ids.length === 0) return new Map();
  const rows = await executor
    .select({ channelId: agentLounges.channelId, agentId: agentLounges.agentId })
    .from(agentLounges)
    .where(inArray(agentLounges.channelId, ids));
  return new Map(rows.map((row) => [row.channelId, row.agentId]));
}

/** `loungeAgentId` on each row: the agent whose lounge it is, or null for any other channel. */
export async function withLoungeAgentIds<T extends { id: string }>(
  rows: readonly T[],
  executor: DatabaseExecutor = getDb(),
): Promise<Array<T & { loungeAgentId: string | null }>> {
  const lounges = await getLoungeAgentIds(rows.map((row) => row.id), executor);
  return rows.map((row) => ({ ...row, loungeAgentId: lounges.get(row.id) ?? null }));
}

/**
 * The lounge a conversation belongs to: the channel itself, or for a thread
 * or task conversation the channel it hangs under (two levels: a thread in a
 * task's conversation). Null when it is not in a lounge. One indexed query:
 * it runs on hot paths (every agent thread follow).
 */
export async function resolveAgentLounge(
  channelId: string,
  executor: DatabaseExecutor = getDb(),
): Promise<{ channelId: string; agentId: string | null } | null> {
  const result = await executor.execute<{ channel_id: string; agent_id: string | null }>(sql`
    SELECT l.channel_id, l.agent_id
    FROM channels c
    LEFT JOIN channels p ON p.id = c.parent_channel_id
    JOIN agent_lounges l ON l.channel_id IN (c.id, c.parent_channel_id, p.parent_channel_id)
    WHERE c.id = ${channelId}::uuid
    LIMIT 1
  `);
  const row = result.rows[0];
  return row ? { channelId: row.channel_id, agentId: row.agent_id } : null;
}

/**
 * The one check for writes that do not need channel membership: true when
 * `channelId` (or the channel it hangs under) is a lounge and `agentId` is not
 * its agent. Membership-based writes are closed by the database trigger.
 */
export async function isLoungeOutsiderAgent(
  channelId: string,
  agentId: string,
  executor: DatabaseExecutor = getDb(),
): Promise<boolean> {
  const lounge = await resolveAgentLounge(channelId, executor);
  return lounge !== null && lounge.agentId !== agentId;
}

/** The subset of `agentIds` that may not take part in `channelId` (all of them but its agent, when it is a lounge). */
export async function filterLoungeOutsiderAgents(
  channelId: string,
  agentIds: readonly string[],
  executor: DatabaseExecutor = getDb(),
): Promise<Set<string>> {
  if (agentIds.length === 0) return new Set();
  const lounge = await resolveAgentLounge(channelId, executor);
  if (!lounge) return new Set();
  return new Set(agentIds.filter((agentId) => agentId !== lounge.agentId));
}

/** An agent's lounge as the DM list carries it on the agent's DM row (unread: the unread summary, by channelId). */
export type AgentLoungeDmSummary = { channelId: string; joined: boolean };

/**
 * agentId -> its lounge (if it has one that is not deleted) and whether
 * `userId` has joined it, for the agents of a DM list. Two queries.
 */
export async function loungeSummariesForAgents(
  agentIds: readonly string[],
  userId: string,
  executor: DatabaseExecutor = getDb(),
): Promise<Map<string, AgentLoungeDmSummary>> {
  const ids = [...new Set(agentIds)];
  if (ids.length === 0) return new Map();
  const lounges = await executor
    .select({ agentId: agentLounges.agentId, channelId: agentLounges.channelId })
    .from(agentLounges)
    .innerJoin(channels, eq(channels.id, agentLounges.channelId))
    .where(and(inArray(agentLounges.agentId, ids), isNull(channels.deletedAt)));
  if (lounges.length === 0) return new Map();
  const joined = new Set((await executor
    .select({ channelId: channelHumans.channelId })
    .from(channelHumans)
    .where(and(eq(channelHumans.userId, userId), inArray(channelHumans.channelId, lounges.map((row) => row.channelId)))))
    .map((row) => row.channelId));
  return new Map(lounges.map((row) => [row.agentId!, { channelId: row.channelId, joined: joined.has(row.channelId) }]));
}

/**
 * Every lounge of `serverId`, and whether it is live: the channel is neither
 * deleted nor archived and its agent is still there (an agent's deletion
 * ends its lounge as a sidebar target). Says nothing about who may read
 * them; callers apply the channel read rule (filterUserAccessibleChannelIds).
 */
export async function listServerLounges(
  serverId: string,
  executor: DatabaseExecutor = getDb(),
): Promise<Array<{ channelId: string; live: boolean }>> {
  const rows = await executor
    .select({
      channelId: agentLounges.channelId,
      live: sql<boolean>`(${channels.deletedAt} is null and ${channels.archivedAt} is null and ${agents.id} is not null and ${agents.deletedAt} is null)`,
    })
    .from(agentLounges)
    .innerJoin(channels, eq(channels.id, agentLounges.channelId))
    .leftJoin(agents, eq(agents.id, agentLounges.agentId))
    .where(eq(agentLounges.serverId, serverId));
  return rows.map((row) => ({ channelId: row.channelId, live: row.live === true }));
}

export async function isAgentLoungeChannel(channelId: string, executor: DatabaseExecutor = getDb()): Promise<boolean> {
  const [row] = await executor
    .select({ channelId: agentLounges.channelId })
    .from(agentLounges)
    .where(eq(agentLounges.channelId, channelId));
  return Boolean(row);
}

function loungeChannelBaseName(agentName: string): string {
  // Channel names are [\p{L}\p{N}_-]+ (RAFT_REF_CHANNEL_NAME_PATTERN).
  const base = agentName.toLowerCase().replace(/[^\p{L}\p{N}_-]+/gu, "-").replace(/^-+|-+$/g, "");
  return `${base || "agent"}-lounge`;
}

export type OpenedAgentLounge = {
  channel: typeof channels.$inferSelect;
  created: boolean;
};

export class AgentLoungeAgentNotFoundError extends Error {
  constructor() {
    super("Agent not found");
  }
}

/**
 * The agent's lounge, created on first open. Only for an active agent of
 * `serverId`; the caller has checked the flag and that the opener is a
 * non-guest member. Opening does not join the opener (the first post does).
 * The channel is not counted against the plan's channel limit and gets no
 * channel admin: nobody becomes its manager by opening it.
 */
export async function openOrCreateAgentLounge(serverId: string, agentId: string): Promise<OpenedAgentLounge> {
  return withServerLock(serverId, 3, async (tx) => {
    const [agent] = await tx
      .select({ id: agents.id, name: agents.name })
      .from(agents)
      .where(and(eq(agents.id, agentId), eq(agents.serverId, serverId), isNull(agents.deletedAt)));
    if (!agent) throw new AgentLoungeAgentNotFoundError();

    const [existing] = await tx
      .select({ channel: channels })
      .from(agentLounges)
      .innerJoin(channels, eq(channels.id, agentLounges.channelId))
      .where(eq(agentLounges.agentId, agentId));
    if (existing && existing.channel.deletedAt === null) return { channel: existing.channel, created: false };
    if (existing) {
      // Deleted by an admin: release the binding (the deleted channel stays a
      // lounge closed to every agent) and start a new one.
      await tx.update(agentLounges).set({ agentId: null }).where(eq(agentLounges.channelId, existing.channel.id));
    }

    const base = loungeChannelBaseName(agent.name);
    const taken = new Set((await tx
      .select({ name: channels.name })
      .from(channels)
      .where(and(
        eq(channels.serverId, serverId),
        inArray(channels.type, ["channel", "private", "joint"]),
        isNull(channels.deletedAt),
        sql`${channels.name} like ${`${base}%`}`,
      ))).map((row) => row.name));
    let name = base;
    for (let suffix = 2; taken.has(name); suffix += 1) name = `${base}-${suffix}`;

    const [channel] = await tx.insert(channels).values({ serverId, name, type: "channel" }).returning();
    await tx.insert(agentLounges).values({ channelId: channel.id, serverId, agentId });
    // read-position: new conversation, no history before this join (no row = position 0)
    await tx.insert(channelAgents).values({ channelId: channel.id, agentId, role: "member" });
    return { channel, created: true };
  });
}
