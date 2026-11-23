import { useLocale } from "../../i18n/LocaleProvider";
import { useCallback, useMemo } from "react";
import type { Location } from "react-router-dom";
import { useRankedComposerSuggestions } from "../../hooks/useRankedComposerSuggestions";
import { conversationChannelIdFromPath } from "./recentConversations";
import { MAX_ENTITY_RESULTS } from "./searchConstants";
import {
  buildSearchEntityEntriesWhenQueryPresent,
  composeSearchEntityGroups,
  filterSearchEntityEntriesForQuery,
} from "./searchEntities";
import type { SearchEntityGroupId, SearchEntitySourceParams } from "./searchEntities";
import { getCommittedSearchQuery } from "./searchComposition";
import { useCoreSearchGroups } from "./useCoreSearchGroups";
import { selectFrequentSearchEntities } from "./searchHome";
import { resolveSearchOverlayBackground } from "./searchOverlayLocation";
import type { SelectableSearchResult } from "./searchResultTypes";
import type { SearchScopeTarget } from "./searchScope";
import { useRecentConversationEntities, useSearchEntityCatalog } from "./useRecentConversationEntities";

/**
 * The destinations (channels, DMs, computers) search shows: the search
 * home's frequent list, the ⌘K overlay's recent conversations, and the
 * typed query's entity results, one section per group. A typed query paints
 * the local rows at once; core's search (`GET /api/search` channels and
 * people, useCoreSearchGroups) replaces them group by group when it answers.
 */
export function useSearchEntityResults({
  query,
  isComposing,
  serverId,
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
  isComposing: boolean;
  serverId: string | undefined;
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
  const { locale } = useLocale();
  const entitySearchEntries = useMemo(
    () => buildSearchEntityEntriesWhenQueryPresent(hasEntityQuery && !scope, {
      channels,
      members,
      agents,
      machines,
      currentUser,
      dmChannels,
      locale,
    }),
    [agents, channels, currentUser, dmChannels, hasEntityQuery, locale, machines, members, scope],
  );
  const scopedEntitySearchEntries = useMemo(
    () => filterSearchEntityEntriesForQuery(query, entitySearchEntries),
    [entitySearchEntries, query],
  );
  const localRankedEntityResults = useRankedComposerSuggestions(query, scopedEntitySearchEntries);
  // Channels and people are core: asked for whatever app flags are on (the
  // app groups' gate, useAppSearchEnabled, is not theirs).
  const coreSearch = useCoreSearchGroups({
    // oxlint-disable-next-line react-doctor/no-event-handler -- an async loader keyed on the committed words, as the app groups': debounced, and aborted when they change.
    q: getCommittedSearchQuery(query, isComposing),
    enabled: !scope,
    serverId: serverId ?? null,
  });
  const { groups: entityGroups, incomplete: entityResultsIncomplete, retrying: entityResultsRetrying, pending: entityResultsPending } = useMemo(
    () => composeSearchEntityGroups({
      // oxlint-disable-next-line react-doctor/no-event-handler -- YMNNE-family: render-derived composition of the local first paint and the server's groups; no Effect.
      query: getCommittedSearchQuery(query, isComposing) ?? "",
      local: query.trim() ? localRankedEntityResults.slice(0, MAX_ENTITY_RESULTS) : [],
      channels: coreSearch.state.channels,
      people: coreSearch.state.people,
      currentUserId: currentUser?.id,
    }),
    [coreSearch.state.channels, coreSearch.state.people, currentUser?.id, isComposing, localRankedEntityResults, query],
  );
  // Every destination row, in the sections' order (the exact-destination match reads the whole of it).
  const entityResults = useMemo(() => entityGroups.flatMap((group) => group.results), [entityGroups]);
  // A group's next page (Load more). Computers come only from the local list, so they never page;
  // a failed page leaves the rows on screen and shows Retry in Load more's place (SearchEntityResultsSection).
  const coreLoadMore = coreSearch.loadMore;
  const loadMoreEntityGroup = useCallback(
    async (group: SearchEntityGroupId): Promise<boolean> => (group === "computers" ? false : coreLoadMore(group)),
    [coreLoadMore],
  );

  return {
    frequentSearchEntities,
    recentConversationEntities,
    recentConversationRows,
    entityGroups,
    entityResults,
    entityResultsIncomplete,
    /** A core group is still being asked for these words (its section may yet appear). */
    entityResultsPending,
    /** A failed core group is being asked again (the incomplete line's Retry). */
    entityResultsRetrying,
    loadMoreEntityGroup,
    /** Asks again for the core groups that failed (the incomplete line's Retry). */
    retryEntityGroups: coreSearch.retry,
  };
}
