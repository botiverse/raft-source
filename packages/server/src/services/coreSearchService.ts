// Core's own groups of `GET /api/search` (shared webSearchContract.ts
// WebSearchItemsByCoreGroup): `channels` and `people`, searched by core for
// the signed-in person in their server. The server decides what is found and
// in which order; clients only draw it (CTO, #proj-mobile:#177). Contract and
// ranking: docs/contracts/web-search.md.
//
// Cost (product lead, same thread): query-driven only, never the whole
// eligible set. Each group is a constant number of queries however many
// matches there are:
// - channels: 1 match query (server-scoped through idx_channels_server_name_type,
//   whose predicate it repeats), the visibility batch
//   (filterUserAccessibleChannelIds, the one human rule visibilityService
//   reuses), 1 membership read; then for the page only: the Guest-channel
//   read (owners/admins), the joint metadata batch and one quota read.
// - people: the viewer's role and directory switch, 1 human match query
//   (server_members' primary key, each person by id), 1 agent match query (idx_agents_server),
//   then 1 DM-identity read for the page (idx_dm_channel_identities_peer) and,
//   when the page has DMs, one quota read (DMs read-only by the plan).
// Matching is a case-insensitive substring (ILIKE) filter inside one
// server's rows; no trigram index (docs/contracts/web-search.md, Performance).
import { createHash } from "node:crypto";
import { and, asc, eq, ilike, inArray, isNull, or, sql, type SQL } from "drizzle-orm";
import {
  asSearchCursor,
  isAdminOrOwner,
  type ChannelSearchHit,
  type PersonSearchHit,
  type SearchCursor,
  type ServerId,
  type ServerRole,
  type WebSearchCoreGroupId,
  type WebSearchItemsByCoreGroup,
} from "@botiverse/raft-shared";
import { getDb } from "../db/index";
import { agents, channelHumans, channels, dmChannelIdentities, serverAgentMembers, serverMembers, users } from "../db/schema";
import { notAgentLoungeChannel } from "./agentLoungeService";
import { activeAppBotOrOrdinaryAgent, agentFindableBy } from "./agentMemberListPolicy";
import { attachJointChannelMetadata, filterUserAccessibleChannelIds, isAllSystemChannel, isEnabledAllChannel } from "./channelService";
import { channelIdsReadOnlyByQuota } from "./planService";
import { getActorServerRoleInServer } from "../lib/actorPermissions";
import { shouldHideHumanDirectoryFromRequester } from "./serverService";

export interface CoreSearchInput {
  viewer: { userId: string; serverId: ServerId };
  /** Trimmed, 1 to WEB_SEARCH_QUERY_MAX_CHARS code points (checked by the route). */
  q: string;
  limit: number;
  cursor: SearchCursor | null;
}

export type CoreSearchPage<T> =
  | { kind: "page"; items: T[]; nextCursor: SearchCursor | null; total: number }
  | { kind: "invalid_cursor" };

// ---- matching and ranking (the one place; docs/contracts/web-search.md) ----

/** How well `text` matches `q` (both lowercased): lower is stronger; null: no match. */
export type MatchStrength = 0 | 1 | 2 | 3;
const WORD_SEPARATOR = /[\s\-_./]/;

export function matchStrength(text: string | null | undefined, q: string): MatchStrength | null {
  if (!text) return null;
  const value = text.toLowerCase();
  if (value === q) return 0;
  if (value.startsWith(q)) return 1;
  for (let at = value.indexOf(q, 1); at !== -1; at = value.indexOf(q, at + 1)) {
    if (WORD_SEPARATOR.test(value[at - 1]!)) return 2;
  }
  return value.includes(q) ? 3 : null;
}

/** The words as matched: trimmed, lowercased, inner whitespace collapsed, a leading `#`/`@` dropped. */
export function normalizeCoreQuery(q: string, sigil: "#" | "@"): string {
  const words = q.trim().toLowerCase().replace(/\s+/g, " ");
  return (words.startsWith(sigil) ? words.slice(1) : words).trim();
}

/** ILIKE '%q%' with the pattern characters escaped. */
function containsPattern(q: string): string {
  return `%${q.replace(/[\\%_]/g, (char) => `\\${char}`)}%`;
}

/**
 * The sort key of a match: band (0 exact name, 1 other name match, 2 only the
 * description), then tier (channels: live joined 0, live not joined 1,
 * archived 2; people 0), then strength, then name, then id.
 */
interface Ranked { band: number; tier: number; strength: number; name: string; id: string }

export function compareRanked(a: Ranked, b: Ranked): number {
  return a.band - b.band || a.tier - b.tier || a.strength - b.strength
    || (a.name < b.name ? -1 : a.name > b.name ? 1 : 0)
    || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0);
}

function bandOf(strength: number): number {
  return strength === 0 ? 0 : strength <= 3 ? 1 : 2;
}

// ---- cursors: an offset into the ranked matches, bound to the group and the words ----

function queryTag(group: WebSearchCoreGroupId, q: string): string {
  return createHash("sha256").update(`${group}\0${q}`).digest("base64url").slice(0, 16);
}

export function coreCursor(group: WebSearchCoreGroupId, q: string, offset: number): SearchCursor {
  return asSearchCursor(`${group}.${offset}.${queryTag(group, q)}`);
}

/** The offset a cursor continues from; null: not this group's cursor for these words. */
export function readCoreCursor(group: WebSearchCoreGroupId, q: string, cursor: SearchCursor | null): number | null {
  if (cursor === null) return 0;
  const match = /^([a-z]+)\.(\d{1,6})\.([A-Za-z0-9_-]{16})$/.exec(cursor);
  if (!match || match[1] !== group || match[3] !== queryTag(group, q)) return null;
  return Number(match[2]);
}

function pageOf<T extends Ranked>(group: WebSearchCoreGroupId, q: string, ranked: T[], offset: number, limit: number): { page: T[]; nextCursor: SearchCursor | null } {
  const page = ranked.slice(offset, offset + limit);
  const next = offset + page.length;
  return { page, nextCursor: next < ranked.length ? coreCursor(group, q, next) : null };
}

// ---- channels ----

export async function searchChannels(input: CoreSearchInput): Promise<CoreSearchPage<ChannelSearchHit>> {
  const { userId, serverId } = input.viewer;
  const q = normalizeCoreQuery(input.q, "#");
  const offset = readCoreCursor("channels", q, input.cursor);
  if (offset === null) return { kind: "invalid_cursor" };
  if (q.length === 0) return { kind: "page", items: [], nextCursor: null, total: 0 };
  const db = getDb();
  const pattern = containsPattern(q);

  // 1. The matches in the reader's server. Same predicate as
  // idx_channels_server_name_type (server_id, name; type in channel/private/joint, not deleted).
  const matched = await db
    .select({ id: channels.id, serverId: channels.serverId, name: channels.name, description: channels.description, type: channels.type, archivedAt: channels.archivedAt })
    .from(channels)
    .where(and(
      eq(channels.serverId, serverId),
      inArray(channels.type, ["channel", "private", "joint"]),
      isNull(channels.deletedAt),
      or(ilike(channels.name, pattern), ilike(channels.description, pattern)),
      notAgentLoungeChannel(channels.id),
    ));
  if (matched.length === 0) return { kind: "page", items: [], nextCursor: null, total: 0 };

  // 2. Of those, what the reader can read (Guests, #all, private and joint membership): core's one rule.
  const ids = matched.map((row) => row.id);
  const [visible, role, memberships] = await Promise.all([
    filterUserAccessibleChannelIds(ids, userId, serverId, { executor: db }),
    getActorServerRoleInServer(serverId, "user", userId),
    db.select({ channelId: channelHumans.channelId }).from(channelHumans)
      .where(and(eq(channelHumans.userId, userId), inArray(channelHumans.channelId, ids))),
  ]);
  const member = new Set(memberships.map((row) => row.channelId));
  const isGuest = role === "guest";

  // 3. Rank every readable match (the order is the server's), then cut the page.
  const ranked = matched.flatMap((row) => {
    if (!visible.has(row.id)) return [];
    const type = row.type as ChannelSearchHit["type"];
    const archived = row.archivedAt !== null;
    // As listChannels: a readable joint is joined; #all is joined by every non-guest member.
    const joined = type === "joint" ? true
      : isAllSystemChannel(row) ? !isGuest && (isEnabledAllChannel(row) || member.has(row.id))
      : member.has(row.id);
    const nameStrength = matchStrength(row.name, q);
    const strength = nameStrength ?? 4;
    return [{ row, type, archived, joined, band: bandOf(strength), tier: archived ? 2 : joined ? 0 : 1, strength, name: row.name.toLowerCase(), id: row.id }];
  }).sort(compareRanked);
  const { page, nextCursor } = pageOf("channels", q, ranked, offset, input.limit);
  if (page.length === 0) return { kind: "page", items: [], nextCursor, total: ranked.length };

  // 4. The page's status, batched: Guest channels (owners and admins only), plan read-only.
  const pageIds = page.map((entry) => entry.id);
  const [guestChannels, joint, quotaReadOnly] = await Promise.all([
    isAdminOrOwner(role)
      ? db.selectDistinct({ channelId: serverMembers.guestChannelId }).from(serverMembers)
        .where(and(eq(serverMembers.serverId, serverId), eq(serverMembers.role, "guest"), inArray(serverMembers.guestChannelId, pageIds)))
      : Promise.resolve([]),
    attachJointChannelMetadata(page.map(({ row }) => ({ id: row.id, type: row.type, serverId: row.serverId }))),
    channelIdsReadOnlyByQuota(serverId, pageIds),
  ]);
  const withGuests = new Set(guestChannels.map((row) => row.channelId));
  const now = Date.now();
  const items = page.map((entry, index): ChannelSearchHit => {
    const meta = joint[index]!;
    const frozen = meta.externalFreezeAt != null && Date.parse(meta.externalFreezeAt) <= now;
    const readOnly = meta.jointBillingLocked === true || frozen || quotaReadOnly.has(entry.id);
    return {
      id: entry.id,
      name: entry.row.name,
      description: entry.row.description ?? null,
      type: entry.type,
      archived: entry.archived,
      joined: entry.joined,
      external: entry.type === "joint",
      guest: withGuests.has(entry.id),
      canPost: entry.joined && !entry.archived && !readOnly,
      requiredAction: entry.type === "channel" && !entry.joined && !entry.archived && !isGuest ? "join_channel" : null,
    };
  });
  return { kind: "page", items, nextCursor, total: ranked.length };
}

// ---- people ----

interface PersonRow { kind: "human" | "agent"; id: string; name: string; displayName: string | null; avatarUrl: string | null; role: string | null }

export async function searchPeople(input: CoreSearchInput): Promise<CoreSearchPage<PersonSearchHit>> {
  const { userId, serverId } = input.viewer;
  const q = normalizeCoreQuery(input.q, "@");
  const offset = readCoreCursor("people", q, input.cursor);
  if (offset === null) return { kind: "invalid_cursor" };
  const empty = { kind: "page" as const, items: [], nextCursor: null, total: 0 };
  if (q.length === 0) return empty;
  const db = getDb();
  const [role, hideHumans] = await Promise.all([
    getActorServerRoleInServer(serverId, "user", userId),
    shouldHideHumanDirectoryFromRequester(serverId, userId),
  ]);
  // Guests have no member directory (GET /servers/:id/members is 403 to them) and no DMs.
  if (role === null || role === "guest") return empty;
  const pattern = containsPattern(q);

  // The Members page's rule (serverService.listServerMemberDirectory): Guests
  // only for owners and admins; only yourself where the directory is hidden.
  const humanScope: SQL = hideHumans
    ? sql`AND sm.user_id = ${userId}`
    : isAdminOrOwner(role) ? sql`` : sql`AND (sm.role <> 'guest' OR sm.user_id = ${userId})`;
  const [humans, agentRows] = await Promise.all([
    // Driven from the server's members (server_members' primary key), each
    // person read by id (OFFSET 0 keeps the lookup per member): the cost is
    // the server's size, never the deployment's users table.
    db.execute(sql`
      SELECT person.id, person.name, person.display_name AS "displayName", person.avatar_url AS "avatarUrl", sm.role
      FROM ${serverMembers} sm
      CROSS JOIN LATERAL (
        SELECT u.id, u.name, u.display_name, u.avatar_url, u.retired_at FROM ${users} u WHERE u.id = sm.user_id OFFSET 0
      ) person
      WHERE sm.server_id = ${serverId} ${humanScope}
        AND person.retired_at IS NULL
        AND (person.name ILIKE ${pattern} OR person.display_name ILIKE ${pattern})
    `).then((result) => result.rows as Array<{ id: string; name: string; displayName: string | null; avatarUrl: string | null; role: string }>),
    // Live agents the reader may find (never another person's assistant; an App's Bot only while bound): the web's isSearchableAgent.
    db.select({ id: agents.id, name: agents.name, displayName: agents.displayName, avatarUrl: agents.avatarUrl, role: serverAgentMembers.role })
      .from(agents)
      .leftJoin(serverAgentMembers, and(eq(serverAgentMembers.agentId, agents.id), eq(serverAgentMembers.serverId, serverId)))
      .where(and(
        eq(agents.serverId, serverId),
        isNull(agents.deletedAt),
        agentFindableBy({ userId }),
        activeAppBotOrOrdinaryAgent(),
        or(ilike(agents.name, pattern), ilike(agents.displayName, pattern)),
      ))
      .orderBy(asc(agents.createdAt)),
  ]);
  const rows: PersonRow[] = [
    ...humans.map((row) => ({ kind: "human" as const, ...row })),
    ...agentRows.map((row) => ({ kind: "agent" as const, ...row })),
  ];
  const ranked = rows.flatMap((row) => {
    const strengths = [matchStrength(row.name, q), matchStrength(row.displayName, q)].filter((s): s is MatchStrength => s !== null);
    if (strengths.length === 0) return [];
    const strength = Math.min(...strengths);
    return [{ row, band: bandOf(strength), tier: 0, strength, name: (row.displayName || row.name).toLowerCase(), id: `${row.kind}:${row.id}` }];
  }).sort(compareRanked);
  const { page, nextCursor } = pageOf("people", q, ranked, offset, input.limit);

  // The reader's DMs with the page's people, one indexed read.
  const keyOf = (row: PersonRow) => (row.kind === "human" && row.id === userId ? userId : [userId, row.id].sort().join(":"));
  const kindOf = (row: PersonRow) => (row.kind === "agent" ? "human_agent" : row.id === userId ? "human_self" : "human_human");
  const dms = page.length === 0 ? [] : await db
    .select({ channelId: dmChannelIdentities.channelId, kind: dmChannelIdentities.kind, peerKey: dmChannelIdentities.peerKey })
    .from(dmChannelIdentities)
    .innerJoin(channels, eq(channels.id, dmChannelIdentities.channelId))
    .where(and(
      eq(dmChannelIdentities.serverId, serverId),
      inArray(dmChannelIdentities.kind, ["human_self", "human_human", "human_agent"]),
      inArray(dmChannelIdentities.peerKey, [...new Set(page.map(({ row }) => keyOf(row)))]),
      eq(channels.type, "dm"),
      isNull(channels.deletedAt),
    ))
    .orderBy(asc(channels.createdAt), asc(channels.id));
  const dmByKey = new Map<string, string>();
  for (const dm of dms) if (!dmByKey.has(`${dm.kind}|${dm.peerKey}`)) dmByKey.set(`${dm.kind}|${dm.peerKey}`, dm.channelId);
  // A DM the reader can't write to now is not `canPost`. The send gate
  // (getChannelBillingReadOnly + isChannelReadOnlyByQuota) reduces to the
  // quota rule for a DM: the external freeze and the joint limit only reach
  // external channels, joints and their threads, never a DM. One batched
  // read for the page's DMs (none when the page has no DM).
  const readOnlyDms = await channelIdsReadOnlyByQuota(serverId, [...new Set(dmByKey.values())]);

  const items = page.map(({ row }): PersonSearchHit => {
    const dmChannelId = dmByKey.get(`${kindOf(row)}|${keyOf(row)}`) ?? null;
    const memberRole = (row.role as ServerRole | null) ?? null;
    return {
      kind: row.kind,
      id: row.id,
      name: row.name,
      displayName: row.displayName ?? null,
      avatarUrl: row.avatarUrl ?? null,
      role: memberRole,
      guest: memberRole === "guest",
      dmChannelId,
      canPost: dmChannelId !== null && !readOnlyDms.has(dmChannelId),
      requiredAction: dmChannelId === null ? "create_dm" : null,
    };
  });
  return { kind: "page", items, nextCursor, total: ranked.length };
}

/** Each core group's search, by group id. */
export const CORE_SEARCHES = {
  channels: searchChannels,
  people: searchPeople,
} satisfies { [G in WebSearchCoreGroupId]: (input: CoreSearchInput) => Promise<CoreSearchPage<WebSearchItemsByCoreGroup[G]>> };
