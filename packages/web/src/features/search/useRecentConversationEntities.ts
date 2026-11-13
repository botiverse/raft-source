import { useMemo } from "react";
import { useAgentStore } from "../../store/agentStore";
import { useAuthStore } from "../../store/authStore";
import { useChannelStore } from "../../store/channelStore";
import { useMachineStore } from "../../store/machineStore";
import {
  EMPTY_RECENT_CONVERSATION_IDS,
  getRecentConversationScopeKey,
  useRecentConversationStore,
} from "../../store/recentConversationStore";
import { useServerStore } from "../../store/serverStore";
import type { ComposerSuggestionSearchEntry } from "../../utils/composerSuggestionSearch";
import { selectRecentConversationEntities } from "./recentConversations";
import { buildSearchEntityEntries } from "./searchEntities";
import type { SearchEntityResult } from "./searchEntities";

// One resolution of "the conversations you were in most recently" for every
// surface that lists them: the ⌘K overlay's empty state (task #113) and the
// desktop top bar's History menu (task #127). Both read the same visit store
// and resolve ids through the same destination catalog, so they can never
// disagree about what counts as a recent conversation.

export interface SearchEntityCatalog {
  /** Every destination the current server offers (channels, computers, agent / human DMs), search-indexed. */
  entries: ComposerSuggestionSearchEntry<SearchEntityResult>[];
  /** Destination keys allowed to surface as conversations: no computers, no DMs the user hid. */
  eligibleEntityKeys: ReadonlySet<string>;
}

const EMPTY_ENTITIES: readonly SearchEntityResult[] = Object.freeze([]);

const EMPTY_CATALOG: SearchEntityCatalog = Object.freeze({
  entries: Object.freeze([]) as unknown as SearchEntityCatalog["entries"],
  eligibleEntityKeys: new Set<string>(),
});

/**
 * The server's destination catalog, built from the live stores (memoised on
 * their identities). Pass an already-resolved catalog to reuse it: the build is
 * skipped (the store selectors still subscribe — hooks cannot be conditional —
 * but the O(destinations) work runs once per tree).
 */
export function useSearchEntityCatalog(provided?: SearchEntityCatalog): SearchEntityCatalog {
  const channels = useChannelStore((s) => s.channels);
  const dmChannels = useChannelStore((s) => s.dmChannels);
  const members = useServerStore((s) => s.members);
  const hiddenDmIds = useServerStore((s) => s.sidebarOrder.hiddenDmIds);
  const agents = useAgentStore((s) => s.agents);
  const machines = useMachineStore((s) => s.machines);
  const currentUser = useAuthStore((s) => s.user);
  const skip = provided !== undefined;

  const entries = useMemo(
    () => (skip ? EMPTY_CATALOG.entries : buildSearchEntityEntries({ channels, members, agents, machines, currentUser, dmChannels })),
    [agents, channels, currentUser, dmChannels, machines, members, skip],
  );
  const eligibleEntityKeys = useMemo(() => {
    if (skip) return EMPTY_CATALOG.eligibleEntityKeys;
    const hiddenDmIdSet = new Set(hiddenDmIds);
    return new Set(entries
      .map((entry) => entry.suggestion)
      .filter((entity) => {
        if (entity.type === "computer") return false;
        if (entity.type === "channel") return true;
        return !entity.channelId || !hiddenDmIdSet.has(entity.channelId);
      })
      .map((entity) => entity.key));
  }, [entries, hiddenDmIds, skip]);

  const own = useMemo(() => ({ entries, eligibleEntityKeys }), [eligibleEntityKeys, entries]);
  return provided ?? own;
}

export interface RecentConversationEntitiesOptions {
  /**
   * A catalog the caller already resolved (a surface that also lists frequent
   * destinations, like the search page). Without it the hook resolves its own —
   * two hook calls in one tree would otherwise build the catalog twice.
   */
  catalog?: SearchEntityCatalog;
  /** `false` short-circuits to an empty selection (surface not showing). */
  enabled?: boolean;
  /** The conversation the surface already sits on — a row for "where you already are" is noise. */
  excludeChannelId?: string | null;
  /**
   * Whether to pad a short visit history with the most recently active
   * conversations. The ⌘K palette wants a never-empty list; a History menu
   * lists only places the user has actually been.
   */
  fillFromActivity?: boolean;
  limit?: number;
}

/**
 * The current server+user's recently visited conversations as destination
 * records, most recent first, deduped, archived / hidden / current excluded.
 */
export function useRecentConversationEntities({
  catalog,
  enabled = true,
  excludeChannelId = null,
  fillFromActivity = true,
  limit,
}: RecentConversationEntitiesOptions = {}): readonly SearchEntityResult[] {
  const serverId = useServerStore((s) => s.current?.id);
  const userId = useAuthStore((s) => s.user?.id);
  const channelActivity = useChannelStore((s) => s.channelActivity);
  const scopeKey = getRecentConversationScopeKey(serverId, userId);
  const recentChannelIds = useRecentConversationStore((state) => (
    scopeKey ? state.scopes[scopeKey]?.channelIds ?? EMPTY_RECENT_CONVERSATION_IDS : EMPTY_RECENT_CONVERSATION_IDS
  ));
  const ownCatalog = useSearchEntityCatalog(catalog);
  const { entries, eligibleEntityKeys } = catalog ?? ownCatalog;

  return useMemo(
    () => (enabled
      ? selectRecentConversationEntities({
          recentChannelIds,
          entities: entries.map((entry) => entry.suggestion),
          activity: channelActivity,
          eligibleEntityKeys,
          excludeChannelId,
          fillFromActivity,
          limit,
        })
      : EMPTY_ENTITIES),
    [channelActivity, eligibleEntityKeys, enabled, entries, excludeChannelId, fillFromActivity, limit, recentChannelIds],
  );
}
