import { useCallback, useMemo } from "react";
import type { RefObject } from "react";
import type { IntlShape } from "react-intl";
import { showToast } from "../../components/toastBridge";
import { appSearchHitKeyOf, appSearchHits, appSearchLabelId, isRenderedSearchApp, useAppSearchEnabled } from "./AppSearchGroupSection";
import type { AppSearchHit } from "./AppSearchGroupSection";
import { getCommittedSearchQuery } from "./searchComposition";
import { OVERLAY_MESSAGE_PREVIEW_LIMIT } from "./searchConstants";
import { SearchHighlight } from "./SearchHighlight";
import type { SearchScopeTarget } from "./searchScope";
import { useAppSearchGroups } from "./useAppSearchGroups";

/**
 * The app groups (core's GET /api/search), beside the message search: each
 * lands on its own. Server-wide, so not in a conversation's own search; and
 * only while some app that searches is on for the server (its flag).
 */
export function useSearchAppResults({
  query,
  isComposing,
  scope,
  serverId,
  searchSurface,
  activateResultsInChat,
  formatMessageRef,
}: {
  query: string;
  isComposing: boolean;
  scope: SearchScopeTarget | null;
  serverId: string | undefined;
  searchSurface: string;
  activateResultsInChat: boolean;
  formatMessageRef: RefObject<IntlShape["formatMessage"]>;
}) {
  const appSearchEnabled = useAppSearchEnabled(serverId ?? null);
  const appSearch = useAppSearchGroups({
    // oxlint-disable-next-line react-doctor/no-event-handler -- an async loader keyed on the committed words, as the message search's: debounced, and aborted when they change.
    q: getCommittedSearchQuery(query, isComposing),
    enabled: !scope && appSearchEnabled,
    serverId: serverId ?? null,
    surface: searchSurface,
    limit: activateResultsInChat ? OVERLAY_MESSAGE_PREVIEW_LIMIT : undefined,
    isKnownApp: isRenderedSearchApp,
    keyOf: appSearchHitKeyOf,
  });
  const { loadMore: loadMoreAppSearchGroup, refresh: refreshAppSearch } = appSearch;
  const appSearchQuery = appSearch.state.q;
  const highlightAppHit = useCallback((text: string) => <SearchHighlight text={text} query={appSearchQuery} />, [appSearchQuery]);
  const appGroupPreviewLimit = activateResultsInChat ? OVERLAY_MESSAGE_PREVIEW_LIMIT : Number.POSITIVE_INFINITY;
  const appHits = useMemo(
    () => appSearch.state.groups.flatMap((group) => appSearchHits(group, appGroupPreviewLimit)),
    [appGroupPreviewLimit, appSearch.state.groups],
  );
  const appSearchPending = appSearch.state.status === "loading" || appSearch.state.groups.some((group) => group.status === "loading");
  const appSearchFailed = appSearch.state.status === "failed" || appSearch.state.groups.some((group) => group.status === "failed");

  const loadMoreAppGroup = useCallback((app: AppSearchHit["app"]) => {
    void loadMoreAppSearchGroup(app).then((ok) => {
      // A one-off action failed; the rows on screen stay (Feedback: a warning toast).
      if (!ok) showToast({ title: formatMessageRef.current({ id: "search.appGroup.moreFailed" }, { app: formatMessageRef.current({ id: appSearchLabelId(app) }) }), type: "warning" });
    });
  }, [formatMessageRef, loadMoreAppSearchGroup]);

  return {
    appSearch,
    refreshAppSearch,
    highlightAppHit,
    appGroupPreviewLimit,
    appHits,
    appSearchPending,
    appSearchFailed,
    loadMoreAppGroup,
  };
}
