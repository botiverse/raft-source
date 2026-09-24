import type { Channel } from "../../store/channelStore";
import type { Agent } from "../../store/agentStore";
import type { ServerMember } from "../../store/serverStore";
import { rankComposerSuggestions } from "../../utils/composerSuggestionSearch";
import type { ComposerSuggestionSearchEntry } from "../../utils/composerSuggestionSearch";
import { sidebarDmLabel } from "./sidebarSort";

// Pure model + search for the "Find a conversation…" sidebar jump box. Kept
// separate from the React component so the dedup and ranking behaviour is unit
// testable without a DOM.
export type FinderResult =
  | { key: string; kind: "channel"; label: string; sublabel: string | null; channelId: string; private: boolean }
  | { key: string; kind: "dm"; label: string; sublabel: string | null; dmChannelId: string; peerIsAgent: boolean; avatarUrl: string | null; gravatarHash: string | null }
  | { key: string; kind: "agent"; label: string; sublabel: string | null; agentId: string; avatarUrl: string | null }
  | { key: string; kind: "human"; label: string; sublabel: string | null; userId: string; avatarUrl: string | null; gravatarHash: string | null };

export const FINDER_MAX_RENDERED = 20;

export interface BuildFinderResultsArgs {
  channels: Channel[];
  dmChannels: Channel[];
  agents: Agent[];
  members: ServerMember[];
  currentUserId?: string | null;
  /** Localized tag shown next to agent conversations. */
  agentTag: string;
}

/**
 * Flatten the sidebar stores into a single searchable list. Channels of type
 * `dm`/`thread` are excluded (DMs come from `dmChannels`, threads are not
 * conversations). People/agents that already have a DM channel are represented
 * by that DM (dedup by peer id) so each conversation appears exactly once, and
 * the current user is never listed (no self-DM).
 */
export function buildFinderResults({
  channels,
  dmChannels,
  agents,
  members,
  currentUserId,
  agentTag,
}: BuildFinderResultsArgs): FinderResult[] {
  const dmPeerIds = new Set(
    dmChannels.map((dm) => dm.peerId).filter((id): id is string => Boolean(id)),
  );
  const results: FinderResult[] = [];

  for (const ch of channels) {
    if (ch.type === "dm" || ch.type === "thread") continue;
    results.push({
      key: `channel:${ch.id}`,
      kind: "channel",
      label: ch.name,
      sublabel: ch.description?.trim() || null,
      channelId: ch.id,
      private: ch.type === "private",
    });
  }
  for (const dm of dmChannels) {
    results.push({
      key: `dm:${dm.id}`,
      kind: "dm",
      label: sidebarDmLabel(dm),
      sublabel: dm.peerType === "agent" ? agentTag : null,
      dmChannelId: dm.id,
      peerIsAgent: dm.peerType === "agent",
      avatarUrl: dm.peerAvatarUrl ?? null,
      gravatarHash: dm.peerGravatarHash ?? null,
    });
  }
  for (const agent of agents) {
    if (dmPeerIds.has(agent.id)) continue;
    results.push({
      key: `agent:${agent.id}`,
      kind: "agent",
      label: agent.displayName ?? agent.name,
      sublabel: agentTag,
      agentId: agent.id,
      avatarUrl: agent.avatarUrl ?? null,
    });
  }
  for (const member of members) {
    if (member.userId === currentUserId) continue;
    if (dmPeerIds.has(member.userId)) continue;
    results.push({
      key: `human:${member.userId}`,
      kind: "human",
      label: member.displayName ?? member.name,
      sublabel: member.name && member.displayName ? `@${member.name}` : null,
      userId: member.userId,
      avatarUrl: member.avatarUrl ?? null,
      gravatarHash: member.gravatarHash ?? null,
    });
  }
  return results;
}

/** Wrap results as ranking entries: name is the primary field, sublabel secondary. */
export function finderSearchEntries(
  results: FinderResult[],
): ComposerSuggestionSearchEntry<FinderResult>[] {
  return results.map((result, index) => ({
    index,
    suggestion: result,
    fields: [
      { raw: result.label, priority: 0 },
      { raw: result.sublabel ?? "", priority: 2 },
    ],
  }));
}

/** Rank the entries against a query, capped at the rendered maximum. Empty query → no results. */
export function rankFinderResults(
  query: string,
  entries: ComposerSuggestionSearchEntry<FinderResult>[],
): FinderResult[] {
  const trimmed = query.trim();
  if (!trimmed) return [];
  return rankComposerSuggestions(trimmed, entries).slice(0, FINDER_MAX_RENDERED);
}
