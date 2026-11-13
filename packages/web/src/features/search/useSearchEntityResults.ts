import { useMemo } from "react";
import type { Location } from "react-router-dom";
import { useRankedComposerSuggestions } from "../../hooks/useRankedComposerSuggestions";
import { conversationChannelIdFromPath } from "./recentConversations";
import { MAX_ENTITY_RESULTS } from "./searchConstants";
import {
  buildSearchEntityEntriesWhenQueryPresent,
  filterSearchEntityEntriesForQuery,
} from "./searchEntities";
import type { SearchEntitySourceParams } from "./searchEntities";
import { selectFrequentSearchEntities } from "./searchHome";
import { resolveSearchOverlayBackground } from "./searchOverlayLocation";
import type { SelectableSearchResult } from "./searchResultTypes";
import type { SearchScopeTarget } from "./searchScope";
import { useRecentConversationEntities, useSearchEntityCatalog } from "./useRecentConversationEntities";

/**
 * The destinations (channels, DMs, computers) search shows: the search
 * home's frequent list, the ⌘K overlay's recent conversations, and the
 * typed query's ranked entity results.
 */
export function useSearchEntityResults({
  query,
  scope,
  overlayHome,
  location,
  searchEntityUsage,
  channels,
  members,
  agents,
  machines,
  currentUser,
  dmChannels,
}: SearchEntitySourceParams & {
  query: string;
  scope: SearchScopeTarget | null;
  overlayHome: boolean;
  location: Location;
  searchEntityUsage: Parameters<typeof selectFrequentSearchEntities>[0]["usage"];
}) {
  // Destination catalog + eligibility shared with the desktop History menu
  // (useRecentConversationEntities): one resolution of "what is a conversation".
  const searchEntityCatalog = useSearchEntityCatalog();
  const { entries: allEntitySearchEntries, eligibleEntityKeys: eligibleFrequentEntityKeys } = searchEntityCatalog;
  const frequentSearchEntities = useMemo(
    () => selectFrequentSearchEntities({
      entities: allEntitySearchEntries.map((entry) => entry.suggestion),
      usage: searchEntityUsage,
      eligibleEntityKeys: eligibleFrequentEntityKeys,
      currentUserId: currentUser?.id,
    }),
    [allEntitySearchEntries, currentUser?.id, eligibleFrequentEntityKeys, searchEntityUsage],
  );
  // The conversation behind the overlay: resolved the same way MainLayout
  // decides what to float over (explicit backgroundLocation → searchFrom →
  // remembered location → server home), so entries without explicit state
  // (rail, "search this channel", deep links — task #96) exclude it too.
  const currentConversationId = conversationChannelIdFromPath(resolveSearchOverlayBackground(location)?.pathname);
  const recentConversationEntities = useRecentConversationEntities({
    catalog: searchEntityCatalog,
    enabled: overlayHome,
    excludeChannelId: currentConversationId,
  });
  const recentConversationRows = useMemo<SelectableSearchResult[]>(
    () => recentConversationEntities.map((result) => ({ key: result.key, kind: "entity" as const, result })),
    [recentConversationEntities],
  );

  const hasEntityQuery = query.trim().length > 0;
  const entitySearchEntries = useMemo(
    () => buildSearchEntityEntriesWhenQueryPresent(hasEntityQuery && !scope, {
      channels,
      members,
      agents,
      machines,
      currentUser,
      dmChannels,
    }),
    [agents, channels, currentUser, dmChannels, hasEntityQuery, machines, members, scope],
  );
  const scopedEntitySearchEntries = useMemo(
    () => filterSearchEntityEntriesForQuery(query, entitySearchEntries),
    [entitySearchEntries, query],
  );
  const rankedEntityResults = useRankedComposerSuggestions(query, scopedEntitySearchEntries);
  const entityResults = useMemo(
    () => {
      // oxlint-disable-next-line react-doctor/no-event-handler -- YMNNE-family: pre-existing search draft behavior; shared ranking is render-derived and does not add an Effect.
      return query.trim() ? rankedEntityResults.slice(0, MAX_ENTITY_RESULTS) : [];
    },
    [query, rankedEntityResults],
  );

  return {
    frequentSearchEntities,
    recentConversationEntities,
    recentConversationRows,
    rankedEntityResults,
    entityResults,
  };
}
