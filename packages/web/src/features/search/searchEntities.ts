import { isSearchableAgent } from "../../store/searchableAgent";
import type { Agent } from "../../store/agentStore";
import type { User } from "../../store/authStore";
import type { Channel } from "../../store/channelStore";
import type { Machine } from "../../store/machineStore";
import type { ServerMember } from "../../store/serverStore";
import {
  rankComposerSuggestions,
} from "../../utils/composerSuggestionSearch";
import { buildSearchSnippet } from "@botiverse/raft-shared";
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
}

interface SearchEntityCandidate {
  result: SearchEntityResult;
  fields: ComposerSuggestionSearchField[];
  tier?: number;
}

/**
 * The ranker's tier (ComposerSuggestionSearchEntry `tier`): live results, then live channels you
 * haven't joined, then archived channels, among matches of comparable strength (xxchan,
 * #triage:666d1506). An exact name still comes first whatever its tier, so Enter goes to it.
 */
const SEARCH_ENTITY_TIER = { live: 0, notJoined: 1, archived: 2 } as const;

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

const SEARCH_ENTITY_TYPE_ORDER: Record<SearchEntityType, number> = {
  channel: 0,
  computer: 1,
  agentDm: 2,
  humanDm: 3,
};

export function buildSearchEntityEntries(
  params: SearchEntitySourceParams,
): ComposerSuggestionSearchEntry<SearchEntityResult>[] {
  const candidates: SearchEntityCandidate[] = [];

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
      tier: channel.archivedAt
        ? SEARCH_ENTITY_TIER.archived
        : channel.joined === false ? SEARCH_ENTITY_TIER.notJoined : SEARCH_ENTITY_TIER.live,
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
    const dmChannel = params.dmChannels.find((channel) => channel.peerType === "agent" && channel.peerId === agent.id);
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
    const dmChannel = params.dmChannels.find((channel) => channel.peerType === "user" && channel.peerId === member.userId);
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
    .sort((left, right) => {
      const typeDelta = SEARCH_ENTITY_TYPE_ORDER[left.result.type] - SEARCH_ENTITY_TYPE_ORDER[right.result.type];
      return typeDelta
        || left.result.title.localeCompare(right.result.title, undefined, { sensitivity: "base" })
        || left.result.key.localeCompare(right.result.key);
    })
    .map((candidate, index) => ({
      index,
      suggestion: candidate.result,
      fields: candidate.fields,
      ...(candidate.tier ? { tier: candidate.tier } : {}),
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
  params: SearchEntitySourceParams,
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
  params: SearchEntitySourceParams & { query: string },
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
