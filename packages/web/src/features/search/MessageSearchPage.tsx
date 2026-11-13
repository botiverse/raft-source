import { PLAN_CONFIG, getEffectiveLimits } from "@botiverse/raft-shared";
import type { ServerPlan } from "@botiverse/raft-shared";
import { useCallback, useContext, useEffect, useMemo, useRef, useState } from "react";
import type { ChangeEvent as ReactChangeEvent, CompositionEvent as ReactCompositionEvent } from "react";
import { useIntl } from "react-intl";
import { ScrollArea, SearchResultsSummary, SearchShellRoot, useLocated } from "@botiverse/raft-ui";
import { useLocation, useNavigate } from "react-router-dom";
import { useSearchHitMarkStore } from "../../store/searchHitMarkStore";
import { useAuthStore } from "../../store/authStore";
import { useServerStore } from "../../store/serverStore";
import { useChannelStore } from "../../store/channelStore";
import { findLoungeAgentId, findStoredChannel } from "../../store/storedChannel";
import { loungeAgentDisplayName } from "../../components/agent/agentLounge";
import { useAgentStore } from "../../store/agentStore";
import { useMachineStore } from "../../store/machineStore";
import { useThreadStore } from "../../store/threadStore";
import { SearchScopeContext } from "./searchScope";
import { useAppNavigate } from "../../hooks/useAppNavigate";
import { useLiveSearchParams } from "../../hooks/useLiveSearchParams";
import { useRetireJump } from "../../hooks/useRetireJump";
import { HistoryWindowBanner } from "../../components/message/HistoryWindowNotices";
import { groupMessageSearchResults } from "./searchGrouping";
import { registerMountedSearchInput } from "../../utils/searchFocusRequest";
import { useTabRootScroll } from "../../hooks/useTabRootScroll";
import { usePagePullToRefresh } from "../../hooks/usePagePullToRefresh";
import { PagePullToRefreshIndicator } from "../../components/ui/PagePullToRefreshIndicator";
import { useShortcutBinding } from "../shortcuts/useShortcutBinding";
import type { SearchEntityResult as SearchEntityRecord } from "./searchEntities";
import { captureSearchState, getSearchStateStorageKey } from "./searchHome";
import { AppSearchFailed, AppSearchGroupSection } from "./AppSearchGroupSection";
import { OVERLAY_ALL_RESULTS_KEY, OVERLAY_MESSAGE_PREVIEW_LIMIT } from "./searchConstants";
import { lastOpenedResultKeys } from "./searchSnapshot";
import { getSearchEntry, getSearchShortcutSource, getValidSearchSource } from "./searchLocationState";
import { useSearchUrlState } from "./useSearchUrlState";
import { useSearchViewportScroll } from "./useSearchViewportScroll";
import { useSearchStatePersistence } from "./useSearchStatePersistence";
import { useSearchHistory } from "./useSearchHistory";
import { useSearchFilters } from "./useSearchFilters";
import { useSearchEntityResults } from "./useSearchEntityResults";
import { useSearchAppResults } from "./useSearchAppResults";
import { useMessageSearchQuery } from "./useMessageSearchQuery";
import { useSearchResultActions } from "./useSearchResultActions";
import type { SearchChannelContextMenuState } from "./useSearchResultActions";
import { useSearchKeyboardSelection } from "./useSearchKeyboardSelection";
import { useSearchSlotSelectionSync } from "./useSearchSlotSelectionSync";
import { useSearchResultRows } from "./useSearchResultRows";
import { SearchQueryField } from "./SearchQueryField";
import { SearchPageHeader } from "./SearchPageHeader";
import { SearchFilterBar } from "./SearchFilterBar";
import { SearchEverywhereRow } from "./SearchEverywhereRow";
import { SearchHomeContent } from "./SearchHomeContent";
import { SearchOverlayHead } from "./SearchOverlayHead";
import { SearchNoResultsState } from "./SearchNoResultsState";
import { SearchEntityResultsSection } from "./SearchEntityResultsSection";
import { SearchMessageResultsSection } from "./SearchMessageResultsSection";
import { SearchLoadMoreFooter } from "./SearchLoadMoreFooter";
import { SearchChannelContextMenu } from "./SearchChannelContextMenu";

export function MessageSearchPage({ activateResultsInChat = false, overlayChrome = false }: {
  /**
   * Overlay mode (desktop ⌘K search overlay): a SINGLE click on a result jumps
   * straight to it in chat (openResultInChat) instead of opening the col-3
   * master/detail preview — there is no col-3 in the overlay. Navigating away
   * clears the overlay's backgroundLocation, so the overlay closes itself. When
   * false (the default, i.e. the full /search page) behavior is unchanged.
   */
  activateResultsInChat?: boolean;
  /**
   * Command-palette chrome for the desktop ⌘K overlay: a slim header (the input
   * IS the top bar, search icon inline) instead of the full PanelHeader with its
   * mobile-back button + icon badge, plus tighter filter/empty-state spacing.
   * Purely presentational and gated so the full /search page (Web) is unchanged.
   */
  overlayChrome?: boolean;
} = {}) {
  const intl = useIntl();
  const { formatMessage } = intl;
  // A conversation's own search (Raft DS › Navigation › Search on a phone),
  // when the page is one: a pushed page with Back that says its scope ("In
  // #launch-week"), searches that conversation only, opens hits in the
  // conversation, and offers to search everywhere, which switches to the
  // Search tab with the same words. It keeps none of the Search tab's state
  // and touches none of it.
  const scope = useContext(SearchScopeContext);
  // Which search this page is: the Search tab ("") or one conversation's
  // ("channel:<id>"). Fixed for the page's life (MainLayout keys a
  // conversation's search by the conversation).
  const searchSurface = scope ? `${scope.kind}:${scope.id}` : "";
  // Render reads formatMessage directly; event handlers that build
  // panel-source titles read formatMessageRef.current so they stay stable
  // across a locale switch.
  const formatMessageRef = useRef(formatMessage);
  formatMessageRef.current = formatMessage;
  // Search state contract (SSOT):
  // - URL params = ONLY source of truth for committed search state (q/tab/filter/page).
  // - Local state = draft input only; must NOT drive results/tabs as committed.
  // - URL writes go through ONE commit path; do NOT add bidirectional URL<->state mirror effects.
  // - External URL change (deep link / rail nav / back-forward) wins over stale draft.
  // (v1: lift this into a typed useSearchUrlController so the rule is enforced by construction, not comment.)
  const [searchParams, setSearchParams] = useLiveSearchParams();
  const location = useLocation();
  const navigate = useNavigate();
  const nav = useAppNavigate();
  const serverId = useServerStore((s) => s.current?.id);
  const slug = useServerStore((s) => s.current?.slug);
  const searchShortcutSource = getSearchShortcutSource(location.state, slug);
  const searchEntry = getSearchEntry(location.state);
  const railSearchSource = searchEntry === "rail" ? getValidSearchSource(location.state, slug) : null;
  const channels = useChannelStore((s) => s.channels);
  const dmChannels = useChannelStore((s) => s.dmChannels);
  const loungeChannels = useChannelStore((s) => s.loungeChannels);
  const members = useServerStore((s) => s.members);
  const serverPublicPageLive = useServerStore((s) => s.current?.publicPageLive === true);
  const serverPlan = useServerStore((s) => (s.billing?.plan || s.current?.plan || "free") as ServerPlan);
  // A plan with a history window: search reaches back only that far (the
  // server leaves older hits out, routes/messages.ts), and the page says so.
  const historyWindowed = getEffectiveLimits(serverPlan).messageHistoryDays !== -1;
  const agents = useAgentStore((s) => s.agents);
  const machines = useMachineStore((s) => s.machines);
  const currentUser = useAuthStore((s) => s.user);
  const searchStateStorageKey = getSearchStateStorageKey(serverId, currentUser?.id);
  const serializedSearchParams = searchParams.toString();
  const {
    visibleSearchParams,
    initialQuery,
    senderIdParam,
    channelIdParam,
    channelFilterParam,
    timeRange,
    scopes,
    scopeSet,
    sort,
    queryParam,
    deferUntilQuery,
    hasActiveFilters,
  } = useSearchUrlState({
    searchParams,
    serializedSearchParams,
    location,
    scope,
    searchSurface,
    searchEntry,
    searchStateStorageKey,
  });
  const closeThread = useThreadStore((s) => s.closeThread);
  const inputRef = useRef<HTMLInputElement>(null);
  const searchScrollKey = `${serverId ?? ""}|${JSON.stringify(captureSearchState(visibleSearchParams))}`;
  const { viewportRef, rememberViewportScroll, searchSurfaceRef } = useSearchViewportScroll(searchSurface, searchScrollKey);
  const filtersPortalRef = useRef<HTMLDivElement>(null);
  const resultClickTimerRef = useRef<number | null>(null);
  const entityResultClickTimerRef = useRef<number | null>(null);
  const pendingEntityResultRef = useRef<SearchEntityRecord | null>(null);
  const shortcutHint = useShortcutBinding("search").menuText;

  const [query, setQuery] = useState(initialQuery);
  const [isComposing, setIsComposing] = useState(false);
  const [selectedResultIdentity, setSelectedResultIdentity] = useState<string | null>(null);
  const selectedIndexHintRef = useRef(0);
  const [channelContextMenu, setChannelContextMenu] = useState<SearchChannelContextMenuState | null>(null);

  // oxlint-disable-next-line react-doctor/no-event-handler -- YMNNE-family taint via task #102's render-derived overlay rows (no Effect, no setState-in-Effect added); the boolean itself is unchanged.
  const hasSearchIntent = Boolean(query.trim() || (hasActiveFilters && !deferUntilQuery));
  // Desktop ⌘K overlay with nothing typed (task #113, Slack): the palette's
  // empty state is "recent conversations" (switch back), not the full page's
  // history + frequent sections; filters wait until there is a query.
  // oxlint-disable-next-line react-doctor/no-event-handler -- same YMNNE-family taint as hasSearchIntent above (it is derived from it); a render-time boolean, no Effect, no setState.
  const overlayHome = overlayChrome && !hasSearchIntent;
  const { skipNextSearchStateRestoreRef, selectRestoredQueryRef } = useSearchStatePersistence({
    scope,
    location,
    searchEntry,
    searchStateStorageKey,
    searchParams,
    serializedSearchParams,
    setSearchParams,
  });

  const {
    searchHistory,
    searchEntityUsage,
    rememberCurrentSearchQuery,
    rememberSearchQuery,
    isTouchSearchHome,
    searchHistoryEditing,
    toggleSearchHistoryEdit,
    forgetSearchQuery,
    clearSearchHistory,
    rememberSearchEntityOpen,
    rememberOpenedChannel,
  } = useSearchHistory({
    query,
    isComposing,
    dmChannels,
  });

  useEffect(() => {
    setQuery(initialQuery);
  }, [initialQuery]);

  // On a phone, Search is a tab (design lead 2026-10-21): switching to it,
  // or coming back to it, never raises the keyboard, so the tab bar and the
  // selected tab stay in view. Tapping the field does, and so does tapping
  // Search again at the top of the page (useTabRootScroll below). A
  // conversation's own search was opened to type into, so it takes the focus
  // while it is empty; coming back to its results (Back) does not.
  const keepRestoredResultsInViewRef = useRef(isTouchSearchHome);
  keepRestoredResultsInViewRef.current = isTouchSearchHome;
  // Back from a result opened on a phone lands on this list again, scrolled
  // where it was (cachedSearchScrolls), and the row that was opened is
  // located (raft-ui's `data-located`, states.md#located), so the user sees
  // where they came from (Raft DS › Navigation).
  const [returnedResultKey, setReturnedResultKey] = useState<string | null>(() => {
    const key = isTouchSearchHome ? lastOpenedResultKeys.get(searchSurface) ?? null : null;
    lastOpenedResultKeys.delete(searchSurface);
    return key;
  });
  const returnedResultLocated = useLocated(returnedResultKey);
  const locatedResultKey = returnedResultLocated ? returnedResultKey : null;
  const retireReturnedResult = useCallback(() => setReturnedResultKey(null), []);
  useRetireJump(returnedResultKey, retireReturnedResult);
  useEffect(() => {
    if (keepRestoredResultsInViewRef.current && (!searchSurface || inputRef.current?.value || selectRestoredQueryRef.current)) return;
    inputRef.current?.focus({ preventScroll: true });
    if (inputRef.current?.value) {
      inputRef.current.select();
    }
  }, [searchSurface, selectRestoredQueryRef]);

  useEffect(() => {
    if (keepRestoredResultsInViewRef.current) return;
    if (!selectRestoredQueryRef.current || !query) return;
    if (searchParams.get("q") !== query) return;
    const input = inputRef.current;
    if (!input || input.value !== query) return;
    selectRestoredQueryRef.current = false;
    input.focus({ preventScroll: true });
    input.select();
  }, [query, searchParams, selectRestoredQueryRef]);

  // The click timers are set by the result click handlers (useSearchResultActions).
  /* oxlint-disable react-hooks/exhaustive-deps -- the cleanup reads the timers as they are at unmount, as it always has; they are not DOM refs. */
  useEffect(() => {
    return () => {
      if (resultClickTimerRef.current !== null) {
        window.clearTimeout(resultClickTimerRef.current);
      }
      if (entityResultClickTimerRef.current !== null) {
        window.clearTimeout(entityResultClickTimerRef.current);
      }
      pendingEntityResultRef.current = null;
    };
  }, []);
  /* oxlint-enable react-hooks/exhaustive-deps */

  // ⌘K on this page focuses this field (focusMountedSearch).
  useEffect(() => registerMountedSearchInput(() => inputRef.current), []);

  // Phone Search tab tapped again on its root: back to the top of the
  // results first, then (tapped at the top) into the field. The results'
  // scroll position across tab switches is kept above (cachedSearchScrolls).
  // Focused inside the tap's click, so iOS opens the keyboard; raft-ui (0.39+)
  // leaves the focus where the click moved it instead of taking it for the tab.
  // A field that already had the focus (Android: keyboard closed with Back)
  // reads to raft-ui as "not moved", so the tab takes it after the click; the
  // field takes it back in a microtask, still inside the touchend's dispatch.
  const focusSearchField = useCallback(() => {
    const input = inputRef.current;
    if (!input) return;
    if (input.ownerDocument.activeElement === input) queueMicrotask(() => input.focus({ preventScroll: true }));
    else input.focus({ preventScroll: true });
  }, []);
  useTabRootScroll(isTouchSearchHome && !scope && !overlayChrome ? "search" : null, viewportRef, {
    rememberScroll: false,
    onRetapAtTop: focusSearchField,
  });

  const filters = useSearchFilters({
    location,
    setSearchParams,
    skipNextSearchStateRestoreRef,
    channels,
    members,
    agents,
    currentUser,
    senderIdParam,
    scopes,
    formatMessage,
    filtersPortalRef,
  });

  const {
    frequentSearchEntities,
    recentConversationEntities,
    recentConversationRows,
    rankedEntityResults,
    entityResults,
  } = useSearchEntityResults({
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
  });
  const hasSearchHomeContent = searchHistory.length > 0 || frequentSearchEntities.length > 0;
  const {
    appSearch,
    refreshAppSearch,
    highlightAppHit,
    appGroupPreviewLimit,
    appHits,
    appSearchPending,
    appSearchFailed,
    loadMoreAppGroup,
  } = useSearchAppResults({
    query,
    isComposing,
    scope,
    serverId,
    searchSurface,
    activateResultsInChat,
    formatMessageRef,
  });

  const {
    results,
    resultsSearchQuery,
    loading,
    loadingMore,
    hasMore,
    continuation,
    searchError,
    loadMoreError,
    searchNonce,
    loadMoreResults,
    refreshSearchResults,
    retrySearch,
  } = useMessageSearchQuery({
    query,
    isComposing,
    queryParam,
    location,
    setSearchParams,
    skipNextSearchStateRestoreRef,
    senderIdParam,
    channelIdParam,
    channelFilterParam,
    timeRange,
    scopes,
    scopeSet,
    sort,
    deferUntilQuery,
    searchSurface,
    serverId,
    serverPlan,
    refreshAppSearch,
    formatMessage,
  });

  const rememberMessageResultsSearchQuery = useCallback(() => {
    if (resultsSearchQuery) rememberSearchQuery(resultsSearchQuery);
  }, [rememberSearchQuery, resultsSearchQuery]);

  const {
    handleBack,
    handleSearchEscape,
    openAllResults,
    closeSearchContent,
    slotOpen,
    selectableResultsRef,
    openResult,
    openEntityResult,
    openResultInChat,
    openEntityResultInChat,
    resultsOpenInChat,
    openAppHit,
    handleMessageResultClick,
    handleEntityResultClick,
    handleChannelResultContextMenu,
  } = useSearchResultActions({
    activateResultsInChat,
    scope,
    slug,
    searchShortcutSource,
    railSearchSource,
    queryParam,
    deferUntilQuery,
    channelIdParam,
    query,
    visibleSearchParams,
    location,
    navigate,
    nav,
    closeThread,
    rememberCurrentSearchQuery,
    rememberMessageResultsSearchQuery,
    rememberSearchEntityOpen,
    rememberOpenedChannel,
    keepRestoredResultsInViewRef,
    searchSurfaceRef,
    selectedIndexHintRef,
    setSelectedResultIdentity,
    resultClickTimerRef,
    entityResultClickTimerRef,
    pendingEntityResultRef,
    setChannelContextMenu,
  });

  // Overlay mode previews only the first few hits (Slack "Recent messages"); the
  // full list, Load More and the col-3 preview live on the results page.
  const messagePreviewLimit = activateResultsInChat ? OVERLAY_MESSAGE_PREVIEW_LIMIT : Number.POSITIVE_INFINITY;
  const visibleMessageResults = useMemo(
    // oxlint-disable-next-line react-doctor/no-event-handler -- render-derived preview cap (task #102); the only downstream Effect is the pre-existing selection reconciliation.
    () => results.slice(0, messagePreviewLimit),
    [messagePreviewLimit, results],
  );
  const groupedMessageResults = useMemo(
    () => groupMessageSearchResults(visibleMessageResults),
    [visibleMessageResults]
  );
  // The server stopped at its scan budget: what is shown is not every match.
  const searchIncomplete = continuation.incomplete && continuation.nextCursor !== null;
  const incompleteSearchNote = continuation.searchedThrough
    ? formatMessage(
      { id: "search.incompleteSearchedThrough" },
      { time: intl.formatDate(new Date(continuation.searchedThrough), { dateStyle: "medium", timeStyle: "short" }) },
    )
    : formatMessage({ id: "search.incompleteSearchedPart" });

  const {
    showAllResultsAction,
    exactDestination,
    remainingEntityResults,
    entityListExpanded,
    visibleEntityResults,
    toggleEntityResults,
    selectableResults,
    selectedResultKey,
    entityResultsListRef,
    handleRailKeyDown,
  } = useSearchKeyboardSelection({
    activateResultsInChat,
    hasSearchIntent,
    query,
    serverId,
    searchSurface,
    rankedEntityResults,
    entityResults,
    recentConversationRows,
    appHits,
    visibleMessageResults,
    selectableResultsRef,
    selectedResultIdentity,
    setSelectedResultIdentity,
    selectedIndexHintRef,
    slotOpen,
    resultsOpenInChat,
    closeSearchContent,
    handleSearchEscape,
    openFilterMenu: filters.openFilterMenu,
    openAllResults,
    openAppHit,
    openEntityResult,
    openEntityResultInChat,
    openResult,
    openResultInChat,
  });

  const totalResults = entityResults.length + appHits.length + results.length;
  // "No results" only once every part has answered and none has anything or
  // failed: an app group still searching may yet have hits, a failed one says so itself.
  const showNoResults = !loading && totalResults === 0 && !searchError && !appSearchPending && !appSearchFailed;
  const boundaryKey = `${queryParam}|${senderIdParam}|${scopes.join(",")}|${timeRange}|${sort}|${searchNonce}|${channelIdParam}`;
  const showInitialSkeleton = loading && entityResults.length === 0 && results.length === 0 && !searchError;
  // A plan with a history window says so on every search, before anything is
  // typed too (cindyz, 2026-10-29): it is a fact of the plan, not of a result.
  // Not beside a failed search's own Banner: one Banner in one place.
  const showsHistoryNotice = historyWindowed && !searchError && !appSearchFailed;
  const historyNotice = showsHistoryNotice ? (
    // Inset by a wrapper, as the other Banners on this page.
    <HistoryWindowBanner surface="search" className="px-(--column-margin)" testId="search-history-limited">
      {formatMessage({ id: "search.historyLimited" }, { days: PLAN_CONFIG.free.limits.messageHistoryDays })}
    </HistoryWindowBanner>
  ) : null;
  const searchPull = usePagePullToRefresh(viewportRef, {
    onRefresh: refreshSearchResults,
    // Search's home, and a search still on its first load, have nothing to refresh.
    // A failed first load has its own Retry instead.
    disabled: !hasSearchIntent || loading || searchError !== null,
  });

  useSearchSlotSelectionSync({ selectableResults, selectedIndexHintRef, setSelectedResultIdentity });

  const {
    getSourceLabel,
    renderMessageHit,
    renderSearchHomeEntity,
    renderEntityResultRow,
  } = useSearchResultRows({
    members,
    currentUser,
    agents,
    dmChannels,
    query,
    selectedResultKey,
    locatedResultKey,
    channelContextMenu,
    activateResultsInChat,
    handleMessageResultClick,
    handleEntityResultClick,
    handleChannelResultContextMenu,
    openEntityResult,
    openEntityResultInChat,
  });

  const chooseSearchHistoryEntry = useCallback((historyQuery: string) => {
    useSearchHitMarkStore.getState().clear();
    setQuery(historyQuery);
    window.requestAnimationFrame(() => {
      inputRef.current?.focus({ preventScroll: true });
      inputRef.current?.setSelectionRange(historyQuery.length, historyQuery.length);
    });
  }, []);

  // The query input + clear button + Esc hint, shared by both the full-page
  // PanelHeader and the slim overlay header so the field behavior is identical.
  // Overlay: no ⌘K hint inside the field you just opened with ⌘K (Slack's
  // "Channels, people, files, and more").
  // Starting a new search clears the opened hit's marks (task #83).
  const handleQueryChange = useCallback((event: ReactChangeEvent<HTMLInputElement>) => {
    useSearchHitMarkStore.getState().clear();
    setQuery(event.target.value);
  }, []);
  const handleQueryCompositionStart = useCallback(() => {
    setIsComposing(true);
  }, []);
  const handleQueryCompositionEnd = useCallback((event: ReactCompositionEvent<HTMLInputElement>) => {
    setQuery(event.currentTarget.value);
    setIsComposing(false);
  }, []);
  const clearQuery = useCallback(() => {
    useSearchHitMarkStore.getState().clear();
    setQuery("");
  }, []);

  // A phone has no keyboard shortcut to advertise: the ⌘K / Ctrl+K hint is
  // dropped there (it was clipped to "Ctrl+" in the narrow field anyway).
  // The conversation a scoped search is in, as the hits name theirs: #channel
  // or @person.
  const scopeConversation = useMemo(() => {
    if (!scope) return null;
    if (scope.kind === "dm") {
      const dm = dmChannels.find((channel) => channel.id === scope.id);
      return `@${dm?.peerDisplayName || dm?.peerName || dm?.name || formatMessage({ id: "search.channel" })}`;
    }
    const lists = { channels, dmChannels, loungeChannels };
    const channel = findStoredChannel(lists, scope.id);
    // A scope in an agent's Lounge names the Lounge, as its header does.
    const loungeAgentId = findLoungeAgentId(lists, scope.id);
    if (loungeAgentId) {
      const name = loungeAgentDisplayName(agents.find((agent) => agent.id === loungeAgentId), channel?.name ?? "");
      return formatMessage({ id: "agent.lounge.title" }, { name });
    }
    return `#${channel?.name ?? formatMessage({ id: "search.channel" })}`;
  }, [agents, channels, dmChannels, formatMessage, loungeChannels, scope]);
  const searchPlaceholder = overlayChrome
    ? formatMessage({ id: "search.overlay.placeholder" })
    : scopeConversation
      ? formatMessage({ id: "search.scoped.placeholder" }, { conversation: scopeConversation })
      : formatMessage({ id: "search.placeholder" }, { shortcutHint: isTouchSearchHome ? "" : shortcutHint }).trim();
  // Searching everywhere is the Search tab's job: switch to it with the same
  // words. This page stays what it is (Back still returns here).
  const searchEverywhere = useCallback(() => {
    if (!slug) return;
    const committedQuery = query.trim();
    navigate(committedQuery ? `/s/${slug}/search?q=${encodeURIComponent(committedQuery)}` : `/s/${slug}/search`);
  }, [navigate, query, slug]);
  const searchFieldInner = (
    <SearchQueryField
      inputRef={inputRef}
      query={query}
      placeholder={searchPlaceholder}
      onChange={handleQueryChange}
      onCompositionStart={handleQueryCompositionStart}
      onCompositionEnd={handleQueryCompositionEnd}
      onClear={clearQuery}
    />
  );

  const closeChannelContextMenu = useCallback(() => setChannelContextMenu(null), []);
  const openChannelFromContextMenu = useCallback(() => {
    if (!channelContextMenu) return;
    void openEntityResultInChat(channelContextMenu.result);
    setChannelContextMenu(null);
  }, [channelContextMenu, openEntityResultInChat]);

  return (
    <SearchShellRoot className="flex min-h-0 flex-1 flex-col" onKeyDown={handleRailKeyDown}>
      <SearchPageHeader
        overlayChrome={overlayChrome}
        scoped={!!scope}
        isTouchSearchHome={isTouchSearchHome}
        onMobileBack={handleBack}
        field={searchFieldInner}
      />

      {overlayHome ? null : (
        <SearchFilterBar
          filtersPortalRef={filtersPortalRef}
          overlayChrome={overlayChrome}
          filters={filters}
          senderIdParam={senderIdParam}
          scopes={scopes}
          scopeConversation={scopeConversation}
          channelIdParam={channelIdParam}
          channels={channels}
          dmChannels={dmChannels}
          serverPublicPageLive={serverPublicPageLive}
          timeRange={timeRange}
          sort={sort}
          query={query}
          hasActiveFilters={hasActiveFilters}
        />
      )}

      {/* raft-ui ScrollArea: the element the scroll memory, the tab-root
          re-tap and pull to refresh read and scroll. raft-ui
          SearchShellViewport's frame, its 16px bottom padding on the content
          so the scrollbar stays at the edges; the content is a full-height
          column so the search home fills the view (flex-1). Its scrollbar
          shows while it is pointed at or scrolls, as on the page scrollers. */}
      <ScrollArea
        ref={viewportRef}
        onScroll={rememberViewportScroll}
        className="min-h-0 flex-1 bg-layer-canvas"
        contentClassName="flex min-h-full flex-col pb-4 *:shrink-0"
        data-testid="search-page-scroller"
      >
        <PagePullToRefreshIndicator pull={searchPull} />
        {scope ? <SearchEverywhereRow query={query} onClick={searchEverywhere} /> : null}
        {/* The search home fills the view: the plan's notice, then the home, so a
            centered empty state stays centered under the notice. */}
        {!hasSearchIntent ? (
          <SearchHomeContent
            historyNotice={historyNotice}
            scoped={!!scope}
            scopeConversation={scopeConversation}
            overlayHome={overlayHome}
            hasRecentConversations={recentConversationEntities.length > 0}
            hasSearchHomeContent={hasSearchHomeContent}
            searchHistory={searchHistory}
            isTouchSearchHome={isTouchSearchHome}
            searchHistoryEditing={searchHistoryEditing}
            onToggleHistoryEdit={toggleSearchHistoryEdit}
            onClearHistory={clearSearchHistory}
            onChooseHistory={chooseSearchHistoryEntry}
            onForgetHistory={forgetSearchQuery}
            frequentSearchEntities={frequentSearchEntities}
            renderSearchHomeEntity={renderSearchHomeEntity}
          >
            {recentConversationEntities.map((result) => renderEntityResultRow(result, { returnHint: true }))}
          </SearchHomeContent>
        ) : null}

        {hasSearchIntent && (
          <div>
            {showAllResultsAction ? (
              <SearchOverlayHead
                query={query}
                allResultsSelected={selectedResultKey === OVERLAY_ALL_RESULTS_KEY}
                onOpenAllResults={openAllResults}
              >
                {exactDestination ? renderEntityResultRow(exactDestination) : null}
              </SearchOverlayHead>
            ) : (
              <SearchResultsSummary>
                {loading ? formatMessage({ id: "search.searching" }) : formatMessage({ id: "search.resultsCount" }, { count: totalResults })}
              </SearchResultsSummary>
            )}

            {historyNotice}

            {showNoResults ? (
              <SearchNoResultsState
                query={query}
                searchIncomplete={searchIncomplete}
                tooBroad={continuation.tooBroad}
                incompleteSearchNote={incompleteSearchNote}
                loadingMore={loadingMore}
                onContinueSearching={loadMoreResults}
              />
            ) : (
              <>
                {remainingEntityResults.length > 0 && (
                  <SearchEntityResultsSection
                    count={remainingEntityResults.length}
                    listRef={entityResultsListRef}
                    expanded={entityListExpanded}
                    onToggleExpanded={toggleEntityResults}
                  >
                    {visibleEntityResults.map((result) => renderEntityResultRow(result))}
                  </SearchEntityResultsSection>
                )}

                {/* One section per group of core's search, as the answer has them. */}
                {appSearch.state.groups.map((group) => (
                  <AppSearchGroupSection
                    key={group.app}
                    group={group}
                    highlight={highlightAppHit}
                    previewLimit={appGroupPreviewLimit}
                    canShowMore={!activateResultsInChat}
                    selectedKey={selectedResultKey}
                    onOpen={openAppHit}
                    onRetry={appSearch.retryGroup}
                    onMore={loadMoreAppGroup}
                  />
                ))}
                {appSearch.state.status === "failed" && appSearch.state.groups.length === 0 ? (
                  <AppSearchFailed onRetry={appSearch.retryAll} />
                ) : null}

                <SearchMessageResultsSection
                  loading={loading}
                  searchError={searchError}
                  resultsCount={results.length}
                  totalResults={totalResults}
                  showInitialSkeleton={showInitialSkeleton}
                  groupedMessageResults={groupedMessageResults}
                  sort={sort}
                  relevanceFallback={continuation.relevanceFallback}
                  boundaryKey={boundaryKey}
                  selectedResultKey={selectedResultKey}
                  onRetry={retrySearch}
                  onSortByRecent={filters.sortByRecent}
                  renderMessageHit={renderMessageHit}
                  getSourceLabel={getSourceLabel}
                />

                {(hasMore || searchIncomplete) && !activateResultsInChat && (
                  <SearchLoadMoreFooter
                    searchIncomplete={searchIncomplete}
                    incompleteSearchNote={incompleteSearchNote}
                    loadMoreError={loadMoreError}
                    loadingMore={loadingMore}
                    onLoadMore={loadMoreResults}
                  />
                )}
              </>
            )}
          </div>
        )}
      </ScrollArea>
      {channelContextMenu && (
        <SearchChannelContextMenu
          menu={channelContextMenu}
          onClose={closeChannelContextMenu}
          onOpen={openChannelFromContextMenu}
        />
      )}
    </SearchShellRoot>
  );
}
