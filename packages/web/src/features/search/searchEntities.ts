import { isSearchableAgent } from "../../store/searchableAgent";
import { DEFAULT_LOCALE } from "../../i18n/locale";
import type { Agent } from "../../store/agentStore";
import type { User } from "../../store/authStore";
import type { Channel } from "../../store/channelStore";
import type { Machine } from "../../store/machineStore";
import type { CatalogChannel, CatalogDmChannel } from "./searchEntityCatalogSources";
import type { ServerMember } from "../../store/serverStore";
import {
  rankComposerSuggestions,
} from "../../utils/composerSuggestionSearch";
import { buildSearchSnippet } from "@botiverse/raft-shared";
import type { ChannelSearchHit, PersonSearchHit, WebSearchCoreGroupId, WebSearchRequiredAction } from "@botiverse/raft-shared";
import { findSearchHit, searchHighlightTokens } from "./searchHighlightParts";
import type {
  ComposerSuggestionSearchEntry,
  ComposerSuggestionSearchField,
} from "../../utils/composerSuggestionSearch";

export type SearchEntityType = "channel" | "computer" | "agentDm" | "humanDm";

// Typed subtitle descriptor: fallback labels carry a `kind` the render layer
// localizes with the active locale; real data (handles, descriptions) rides in
// `text`. Avoids baking English into the result and avoids branching on
// already-localized strings downstream.
export type SearchEntitySubtitle =
  | { kind: "channel" }
  | { kind: "computer"; hostname: string | null }
  | { kind: "agentDm" }
  | { kind: "selfDm" }
  | { kind: "text"; text: string };

export interface SearchEntityResult {
  key: string;
  type: SearchEntityType;
  title: string;
  subtitle: SearchEntitySubtitle;
  channelId: string | null;
  channelType: Channel["type"] | null;
  machineId: string | null;
  agentId: string | null;
  userId: string | null;
  archivedAt: string | null;
  /** Channels: the description the query also matches (see `searchEntitySubtitleForQuery`). */
  description?: string | null;
  /**
   * The server's status of a result of core's search (`GET /api/search`
   * channels / people groups); absent on the local first paint. The row draws
   * it as it is (docs/contracts/web-search.md: clients only draw it).
   */
  status?: SearchEntityStatus;
  /** A person's avatar as the server sent it (people group). */
  avatarUrl?: string | null;
}

/** ChannelSearchHit / PersonSearchHit status, as a row draws it. */
export interface SearchEntityStatus {
  archived: boolean;
  joined: boolean;
  /** A channel shared with another server (a joint). */
  external: boolean;
  /** A channel Guests take part in, or a person who is a Guest (told to owners and admins only). */
  guest: boolean;
  canPost: boolean;
  requiredAction: WebSearchRequiredAction | null;
}

/** Archived, by the server's status when it has one, else by the loaded channel. */
export function isArchivedEntity(result: SearchEntityResult): boolean {
  return result.status ? result.status.archived : !!result.archivedAt;
}

interface SearchEntityCandidate {
  result: SearchEntityResult;
  fields: ComposerSuggestionSearchField[];
}

function dedupeFields(values: Array<{ raw: string | null | undefined; priority: number }>): ComposerSuggestionSearchField[] {
  const fields: ComposerSuggestionSearchField[] = [];
  const seen = new Set<string>();
  for (const value of values) {
    const raw = value.raw?.trim();
    const normalized = raw?.toLowerCase().replace(/\s+/g, " ");
    if (!raw || !normalized || seen.has(normalized)) continue;
    seen.add(normalized);
    fields.push({ raw, priority: value.priority });
  }
  return fields;
}

export interface SearchEntitySourceParams {
  channels: Channel[];
  members: ServerMember[];
  agents: Agent[];
  machines: Machine[];
  currentUser: User | null;
  dmChannels: Channel[];
}

/** What the catalog build reads: the channel rows' few fields it uses (see searchEntityCatalogSources). */
export type SearchEntityCatalogParams = Omit<SearchEntitySourceParams, "channels" | "dmChannels"> & {
  channels: readonly CatalogChannel[];
  dmChannels: readonly CatalogDmChannel[];
};

const SEARCH_ENTITY_TYPE_ORDER: Record<SearchEntityType, number> = {
  channel: 0,
  computer: 1,
  agentDm: 2,
  humanDm: 3,
};

// One collator pair per UI locale, built once: `a.localeCompare(b, locales,
// options)` builds a fresh Intl.Collator per call, and the catalog sort calls it
// O(n log n) times (#532: the hottest function in a socket-flood trace). The
// locale is the UI's (passed by the hooks), explicit as Intl formatters must be.
const collatorsByLocale = new Map<string, { title: Intl.Collator; key: Intl.Collator }>();
function collatorsFor(locale: string): { title: Intl.Collator; key: Intl.Collator } {
  let collators = collatorsByLocale.get(locale);
  if (!collators) {
    collators = { title: new Intl.Collator(locale, { sensitivity: "base" }), key: new Intl.Collator(locale) };
    collatorsByLocale.set(locale, collators);
  }
  return collators;
}

/** Catalog order: by type, then title (case/accent-insensitive), then key, in the UI's locale. */
function compareSearchEntityResults(left: SearchEntityResult, right: SearchEntityResult, locale: string): number {
  const { title, key } = collatorsFor(locale);
  return SEARCH_ENTITY_TYPE_ORDER[left.type] - SEARCH_ENTITY_TYPE_ORDER[right.type]
    || title.compare(left.title, right.title)
    || key.compare(left.key, right.key);
}

/** Each peer's first DM row (as `dmChannels.find` would give), keyed `${peerType}:${peerId}`. */
function dmChannelsByPeer(dmChannels: readonly CatalogDmChannel[]): Map<string, CatalogDmChannel> {
  const byPeer = new Map<string, CatalogDmChannel>();
  for (const channel of dmChannels) {
    if (!channel.peerType || !channel.peerId) continue;
    const key = `${channel.peerType}:${channel.peerId}`;
    if (!byPeer.has(key)) byPeer.set(key, channel);
  }
  return byPeer;
}

/**
 * The local destinations a query is matched against: the instant first paint
 * only. Matching and order here are the composer ranker's; no status rule
 * (archived, joined, Guest) decides anything. Once the server's channels and
 * people groups answer, they replace these rows (composeSearchEntityGroups).
 */
export function buildSearchEntityEntries(
  params: SearchEntityCatalogParams & { locale?: string },
): ComposerSuggestionSearchEntry<SearchEntityResult>[] {
  const locale = params.locale ?? DEFAULT_LOCALE;
  const candidates: SearchEntityCandidate[] = [];
  const dmByPeer = dmChannelsByPeer(params.dmChannels);

  for (const channel of params.channels) {
    // Thread rows live in `channelStore.channels` after `ensureChannel(threadId)`
    // runs for a thread search hit (search-rail PR #2164: SearchContentRoute
    // → ChannelById fetches the thread by id). They are not user-discoverable
    // surfaces — there's no "join thread by name" gesture and threads carry no
    // independent identity outside their parent — so they must not surface as
    // channel candidates in the entity rail (stdrc msg=4b24a914 2026-05-28:
    // "为什么你会搜出来 thread channel？怎么可能呢").
    if (channel.type === "thread") continue;
    candidates.push({
      result: {
        key: `channel:${channel.id}`,
        type: "channel",
        title: channel.name,
        subtitle: { kind: "channel" },
        channelId: channel.id,
        channelType: channel.type,
        machineId: null,
        agentId: null,
        userId: null,
        archivedAt: channel.archivedAt ?? null,
        description: channel.description ?? null,
      },
      fields: dedupeFields([
        { raw: channel.name, priority: 0 },
        { raw: channel.description, priority: 3 },
      ]),
    });
  }

  for (const machine of params.machines) {
    if (!machine.isComputer) continue;
    candidates.push({
      result: {
        key: `computer:${machine.id}`,
        type: "computer",
        title: machine.name,
        subtitle: { kind: "computer", hostname: machine.hostname ?? null },
        channelId: null,
        channelType: null,
        machineId: machine.id,
        agentId: null,
        userId: null,
        archivedAt: null,
      },
      fields: dedupeFields([
        { raw: machine.name, priority: 0 },
        { raw: machine.hostname, priority: 1 },
        { raw: machine.description, priority: 3 },
        { raw: machine.os, priority: 4 },
      ]),
    });
  }

  for (const agent of params.agents) {
    if (!isSearchableAgent(agent, params.currentUser?.id)) continue;
    const dmChannel = dmByPeer.get(`agent:${agent.id}`);
    const visibleName = agent.displayName || agent.name;
    candidates.push({
      result: {
        key: `agent:${agent.id}`,
        type: "agentDm",
        title: visibleName,
        subtitle: agent.displayName ? { kind: "text", text: `@${agent.name}` } : { kind: "agentDm" },
        channelId: dmChannel?.id ?? null,
        channelType: null,
        machineId: null,
        agentId: agent.id,
        userId: null,
        archivedAt: null,
      },
      fields: dedupeFields([
        { raw: visibleName, priority: 0 },
        { raw: agent.name, priority: 1 },
        { raw: agent.description, priority: 3 },
      ]),
    });
  }

  for (const member of params.members) {
    const dmChannel = dmByPeer.get(`user:${member.userId}`);
    const visibleName = member.displayName || member.name;
    const isSelf = member.userId === params.currentUser?.id;
    candidates.push({
      result: {
        key: `human:${member.userId}`,
        type: "humanDm",
        title: visibleName,
        subtitle: isSelf
          ? { kind: "selfDm" }
          : { kind: "text", text: member.description || (member.displayName ? member.name : "") },
        channelId: dmChannel?.id ?? null,
        channelType: null,
        machineId: null,
        agentId: null,
        userId: member.userId,
        archivedAt: null,
      },
      fields: dedupeFields([
        { raw: visibleName, priority: 0 },
        { raw: member.name, priority: 1 },
        { raw: member.description, priority: 3 },
        ...(isSelf
          ? [
              { raw: "self", priority: 4 },
              { raw: "me", priority: 4 },
              { raw: "myself", priority: 4 },
              { raw: "self dm", priority: 4 },
            ]
          : []),
      ]),
    });
  }

  return candidates
    .sort((left, right) => compareSearchEntityResults(left.result, right.result, locale))
    .map((candidate, index) => ({
      index,
      suggestion: candidate.result,
      fields: candidate.fields,
    }));
}

/**
 * The subtitle a result row shows for `query`: a channel whose description
 * holds the hit shows that description, cut by the same snippet rules as a
 * message preview (raft-shared `buildSearchSnippet`: from just before the hit,
 * on word boundaries, "…" on elided sides) so the one-line subtitle shows the
 * hit, instead of the bare "Channel" label. Exact
 * destination matching keeps using `result.subtitle`.
 */
/**
 * An App bot's subtitle: never the "Agent DM" fallback (it is a Bot, not an
 * Agent), but its handle, as every other Bot row shows it.
 */
export function appBotEntitySubtitle(subtitle: SearchEntitySubtitle, appBot: { name: string } | null): SearchEntitySubtitle {
  return appBot && subtitle.kind === "agentDm" ? { kind: "text", text: `@${appBot.name}` } : subtitle;
}

export function searchEntitySubtitleForQuery(result: SearchEntityResult, query: string): SearchEntitySubtitle {
  if (result.type !== "channel" || !result.description || findSearchHit(result.description, query) < 0) {
    return result.subtitle;
  }
  return { kind: "text", text: buildSearchSnippet(result.description, searchHighlightTokens(query)) };
}

export function buildSearchEntityEntriesWhenQueryPresent(
  hasEntityQuery: boolean,
  params: SearchEntitySourceParams & { locale?: string },
): ComposerSuggestionSearchEntry<SearchEntityResult>[] {
  if (!hasEntityQuery) return [];
  return buildSearchEntityEntries(params);
}

export function filterSearchEntityEntriesForQuery(
  query: string,
  entries: ComposerSuggestionSearchEntry<SearchEntityResult>[],
): ComposerSuggestionSearchEntry<SearchEntityResult>[] {
  const prefix = query.trim()[0];
  if (prefix === "#") return entries.filter((entry) => entry.suggestion.type === "channel");
  if (prefix === "@") {
    return entries.filter((entry) => entry.suggestion.type === "agentDm" || entry.suggestion.type === "humanDm");
  }
  return entries;
}

export function buildSearchEntityResults(
  params: SearchEntitySourceParams & { query: string; locale?: string },
): SearchEntityResult[] {
  if (!params.query.trim()) return [];
  const entries = filterSearchEntityEntriesForQuery(params.query, buildSearchEntityEntries(params));
  return rankComposerSuggestions(params.query, entries);
}

/**
 * Task #102 (desktop ⌘K overlay, Slack model): a destination counts as an EXACT
 * match when the query names it outright — its title, or its handle for people /
 * agents — ignoring a leading `#` / `@`, case and whitespace runs. Deliberately
 * STRICTER than `rankComposerSuggestions`' exact score (which also drops
 * punctuation and matches pinyin): Return entering the wrong channel is worse than
 * Return opening the results page. And deliberately NOT "head of the ranked list
 * only": with channels `design-system` and `designsystem`, query `designsystem`
 * ranks `design-system` first under the looser score, so the strict match must be
 * searched for in the whole ranked candidate list (before any display truncation)
 * and hoisted. Returns the first strict match in ranking order.
 */
export function findExactDestination(query: string, entities: readonly SearchEntityResult[]): SearchEntityResult | null {
  const normalize = (value: string) => value.trim().replace(/\s+/g, " ").toLowerCase();
  const wanted = normalize(query.replace(/^\s*[#@]/, ""));
  if (!wanted) return null;
  for (const entity of entities) {
    if (normalize(entity.title) === wanted) return entity;
    if (entity.subtitle.kind === "text" && normalize(entity.subtitle.text.replace(/^\s*@/, "")) === wanted) return entity;
  }
  return null;
}

// ---- core's search groups (GET /api/search channels / people) ----

/** The section a destination is drawn in. */
export type SearchEntityGroupId = WebSearchCoreGroupId | "computers";
export const SEARCH_ENTITY_GROUP_ORDER: readonly SearchEntityGroupId[] = ["channels", "people", "computers"];

export function searchEntityGroupOf(result: SearchEntityResult): SearchEntityGroupId {
  return result.type === "channel" ? "channels" : result.type === "computer" ? "computers" : "people";
}

/** A channel of the server's `channels` group, as a destination row. */
export function channelHitToEntity(hit: ChannelSearchHit): SearchEntityResult {
  return {
    key: `channel:${hit.id}`,
    type: "channel",
    title: hit.name,
    subtitle: { kind: "channel" },
    channelId: hit.id,
    channelType: hit.type,
    machineId: null,
    agentId: null,
    userId: null,
    archivedAt: null,
    description: hit.description,
    status: {
      archived: hit.archived,
      joined: hit.joined,
      external: hit.external,
      guest: hit.guest,
      canPost: hit.canPost,
      requiredAction: hit.requiredAction,
    },
  };
}

/** A person or agent of the server's `people` group, as a destination row (the same key as the local row). */
export function personHitToEntity(hit: PersonSearchHit, currentUserId: string | null | undefined): SearchEntityResult {
  const visibleName = hit.displayName || hit.name;
  const agent = hit.kind === "agent";
  const isSelf = !agent && hit.id === currentUserId;
  return {
    key: `${agent ? "agent" : "human"}:${hit.id}`,
    type: agent ? "agentDm" : "humanDm",
    title: visibleName,
    subtitle: isSelf
      ? { kind: "selfDm" }
      : agent
        ? (hit.displayName ? { kind: "text", text: `@${hit.name}` } : { kind: "agentDm" })
        : { kind: "text", text: hit.displayName ? hit.name : "" },
    channelId: hit.dmChannelId,
    channelType: null,
    machineId: null,
    agentId: agent ? hit.id : null,
    userId: agent ? null : hit.id,
    archivedAt: null,
    avatarUrl: hit.avatarUrl,
    status: {
      archived: false,
      joined: hit.dmChannelId !== null,
      external: false,
      guest: hit.guest,
      canPost: hit.canPost,
      requiredAction: hit.requiredAction,
    },
  };
}

/** One destinations section: the server's rows (and how many it has in all), or the local first paint. */
export interface SearchEntityGroupView {
  id: SearchEntityGroupId;
  results: SearchEntityResult[];
  /** Every match: the server's `total`, else the local rows' count. */
  total: number;
  /** `server`: the group's answer for these words replaced the local rows. */
  source: "local" | "server";
  /** The server has more rows past `results` (Show all pages on). */
  hasMore: boolean;
  /** A next page is loading. */
  paging: boolean;
  /** The last next page failed: the section shows Retry in Load more's place. */
  pageFailed: boolean;
  /**
   * The group's server answer for these words hasn't arrived yet: the local
   * rows are shown, but not a count or Show all (its total is the server's).
   */
  pending: boolean;
}

/** What composeSearchEntityGroups reads of a core group (useCoreSearchGroups' state). */
export type CoreGroupAnswer<T> =
  | { status: "idle" }
  /** `retry`: asked again after a failure (the incomplete line's Retry). */
  | { status: "loading"; q?: string; retry?: boolean }
  | { status: "failed"; q: string }
  | { status: "ok"; q: string; items: T[]; nextCursor: string | null; total: number; paging: boolean; pageFailed?: boolean };

/**
 * The destinations sections for `query`: each core group's server answer for
 * these exact words replaces the local rows of that group, in the server's
 * order and with its status; until it arrives (and when it can't: offline, a
 * failed request) the local rows stay. Computers have no server group yet:
 * always local. `incomplete`: some group shows local rows because its request
 * failed, so what is shown may not be everything; `retrying`: a failed group is
 * being asked again; `pending`: some group is still being asked for these
 * words (whether or not it has local rows to show meanwhile). While an IME
 * composition is open (`query` empty: no committed words) nothing is pending.
 */
export function composeSearchEntityGroups({
  query,
  local,
  channels,
  people,
  currentUserId,
}: {
  query: string;
  /** The local first paint (ranked), every type. */
  local: readonly SearchEntityResult[];
  channels: CoreGroupAnswer<ChannelSearchHit>;
  people: CoreGroupAnswer<PersonSearchHit>;
  currentUserId: string | null | undefined;
}): { groups: SearchEntityGroupView[]; incomplete: boolean; retrying: boolean; pending: boolean } {
  const words = query.trim();
  let incomplete = false;
  let retrying = false;
  let anyPending = false;
  const groups = SEARCH_ENTITY_GROUP_ORDER.flatMap((id): SearchEntityGroupView[] => {
    const localRows = local.filter((result) => searchEntityGroupOf(result) === id);
    const answer = id === "channels" ? channels : id === "people" ? people : null;
    if (answer?.status === "ok" && answer.q === words) {
      const results = id === "channels"
        ? (answer.items as ChannelSearchHit[]).map(channelHitToEntity)
        : (answer.items as PersonSearchHit[]).map((hit) => personHitToEntity(hit, currentUserId));
      return results.length === 0 ? [] : [{
        id, results, total: Math.max(answer.total, results.length), source: "server",
        hasMore: answer.nextCursor !== null, paging: answer.paging, pageFailed: answer.pageFailed === true, pending: false,
      }];
    }
    if (answer?.status === "failed" && answer.q === words) incomplete = true;
    // Asked and not answered yet for these words (an answer for other words is about to be replaced).
    const pending = words !== "" && answer !== null
      && (answer.status === "loading" || ((answer.status === "ok" || answer.status === "failed") && answer.q !== words));
    if (pending) anyPending = true;
    if (pending && answer?.status === "loading" && answer.retry) retrying = true;
    return localRows.length === 0 ? [] : [{ id, results: localRows, total: localRows.length, source: "local", hasMore: false, paging: false, pageFailed: false, pending }];
  });
  return { groups, incomplete, retrying, pending: anyPending };
}
