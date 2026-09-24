import type { Agent } from "../../store/agentStore";
import type { User } from "../../store/authStore";
import type { Channel } from "../../store/channelStore";
import type { Machine } from "../../store/machineStore";
import type { ServerMember } from "../../store/serverStore";
import {
  rankComposerSuggestions,
} from "../../utils/composerSuggestionSearch";
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
    if (agent.deletedAt) continue;
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
    }));
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
