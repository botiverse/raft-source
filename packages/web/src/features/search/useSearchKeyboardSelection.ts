import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { Dispatch, KeyboardEvent as ReactKeyboardEvent, RefObject, SetStateAction } from "react";
import type { AppSearchHit } from "./AppSearchGroupSection";
import { isSearchKeyboardComposing } from "./searchComposition";
import { ENTITY_PREVIEW_COUNT } from "./searchConstants";
import { findExactDestination } from "./searchEntities";
import type { SearchEntityResult as SearchEntityRecord } from "./searchEntities";
import { isSelectableRow, OVERLAY_ALL_RESULTS_ROW } from "./searchResultTypes";
import type { MessageSearchResult, SelectableSearchResult } from "./searchResultTypes";
import { expandedEntitySearches } from "./searchSnapshot";
import type { SearchFilterMenu } from "./useSearchFilters";

/**
 * The rail's selectable rows (overlay head, destinations, app hits,
 * messages), which of them is the keyboard cursor, and the rail's
 * ↑ / ↓ / Return / Escape handling.
 */
export function useSearchKeyboardSelection({
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
  openFilterMenu,
  openAllResults,
  openAppHit,
  openEntityResult,
  openEntityResultInChat,
  openResult,
  openResultInChat,
}: {
  activateResultsInChat: boolean;
  hasSearchIntent: boolean;
  query: string;
  serverId: string | undefined;
  searchSurface: string;
  rankedEntityResults: readonly SearchEntityRecord[];
  entityResults: SearchEntityRecord[];
  recentConversationRows: SelectableSearchResult[];
  appHits: AppSearchHit[];
  visibleMessageResults: MessageSearchResult[];
  selectableResultsRef: RefObject<Array<{ key: string }>>;
  selectedResultIdentity: string | null;
  setSelectedResultIdentity: Dispatch<SetStateAction<string | null>>;
  selectedIndexHintRef: RefObject<number>;
  slotOpen: boolean;
  resultsOpenInChat: boolean;
  closeSearchContent: () => void;
  handleSearchEscape: () => void;
  /** The filter menu open now, if any: its Escape is the menu's, not the page's. */
  openFilterMenu: SearchFilterMenu | null;
  openAllResults: () => void;
  openAppHit: (hit: AppSearchHit) => void;
  openEntityResult: (result: SearchEntityRecord) => Promise<void>;
  openEntityResultInChat: (result: SearchEntityRecord) => Promise<void>;
  openResult: (result: MessageSearchResult) => Promise<void>;
  openResultInChat: (result: MessageSearchResult) => Promise<void>;
}) {
  // Overlay (task #102, Slack model): an exact destination match ranks above the
  // "view all results" row (Return enters that channel / DM); otherwise that row is
  // first (Return opens the full results page). Remaining destinations and the
  // message preview follow. Full page: unchanged order, no action row.
  // oxlint-disable-next-line react-doctor/no-event-handler -- render-derived row visibility (task #102): composes the overlay's selectable rows, no Effect or setState-in-Effect involved.
  const showAllResultsAction = activateResultsInChat && hasSearchIntent;
  // Searched over the FULL ranked list (not the MAX_ENTITY_RESULTS slice): the
  // looser ranking score can place a punctuation-different sibling first, and a
  // strict match may sit past the display cut. See findExactDestination.
  const exactDestinationCandidate = useMemo(
    () => findExactDestination(query, rankedEntityResults),
    [query, rankedEntityResults],
  );
  const exactDestination = showAllResultsAction ? exactDestinationCandidate : null;
  const allResultsRow = showAllResultsAction ? OVERLAY_ALL_RESULTS_ROW : null;
  const exactDestinationRow = useMemo<SelectableSearchResult | null>(
    () => (exactDestination === null ? null : { key: exactDestination.key, kind: "entity", result: exactDestination }),
    [exactDestination],
  );
  const remainingEntityResults = useMemo(
    () => (exactDestination ? entityResults.filter((result) => result.key !== exactDestination.key) : entityResults),
    [entityResults, exactDestination],
  );
  // Expanded for this server and typed query only: a new query starts collapsed.
  const entityListKey = `${serverId ?? ""}|${query.trim()}`;
  const [expandedEntitySearch, setExpandedEntitySearch] = useState(() => expandedEntitySearches.get(searchSurface) ?? null);
  // oxlint-disable-next-line react-doctor/no-event-handler -- render-derived: the list is expanded for the query it was expanded for; the state is set only by the Show All click, no Effect involved.
  const entityListExpanded = expandedEntitySearch === entityListKey;
  const visibleEntityResults = useMemo(
    () => (entityListExpanded ? remainingEntityResults : remainingEntityResults.slice(0, ENTITY_PREVIEW_COUNT)),
    [entityListExpanded, remainingEntityResults],
  );
  // Show All / Show Fewer stays mounted, so keyboard focus stays on it and the
  // page's arrow keys keep working after the list expands.
  const toggleEntityResults = useCallback(() => {
    if (entityListExpanded) {
      expandedEntitySearches.delete(searchSurface);
      setExpandedEntitySearch(null);
      return;
    }
    expandedEntitySearches.set(searchSurface, entityListKey);
    setExpandedEntitySearch(entityListKey);
  }, [entityListExpanded, entityListKey, searchSurface]);
  const selectableResults = useMemo<SelectableSearchResult[]>(
    () => [
      // Overlay empty state: the recent-conversation rows are the keyboard rail
      // (↑↓ + Return, first row active by default like Slack).
      ...recentConversationRows,
      ...[exactDestinationRow, allResultsRow].filter(isSelectableRow),
      ...visibleEntityResults.map((result) => ({ key: result.key, kind: "entity" as const, result })),
      // The app groups sit between the destinations and the messages, as drawn.
      ...appHits.map((hit) => ({ key: hit.key, kind: "appHit" as const, hit })),
      // oxlint-disable-next-line react-doctor/no-event-handler -- YMNNE-family: pre-existing non-bug site grandfathered; rule now gates new code (see docs/frontend/render-cost-contract.md)
      ...visibleMessageResults.map((result) => ({ key: `message:${result.id}`, kind: "message" as const, result })),
    ],
    [allResultsRow, appHits, exactDestinationRow, recentConversationRows, visibleEntityResults, visibleMessageResults]
  );
  selectableResultsRef.current = selectableResults;

  // Results arrive in independent waves (local entity ranking, worker reranks,
  // then message search). The keyboard cursor belongs to a stable result, not
  // to whichever row currently occupies its numeric index. Preserve that key
  // across refreshes; if the selected result disappeared, stay at the nearest
  // surviving position instead of surprising the user by jumping to the top.
  // Overlay (task #102): a palette's cursor returns to the top row whenever the
  // query changes (or an exact destination surfaces from a later rerank), so Return
  // always means "the first row for what I just typed" — the exact destination if
  // any, else "view all results". Adjusted during render (same-component setState),
  // and a cleared identity maps to row 0 here instead of the nearest-survivor hint.
  // Full page keeps the nearest-survivor behaviour untouched.
  const overlayCursorEpoch = activateResultsInChat ? `${query}\u0000${exactDestination?.key ?? ""}` : null;
  const [seenOverlayCursorEpoch, setSeenOverlayCursorEpoch] = useState(overlayCursorEpoch);
  if (overlayCursorEpoch !== seenOverlayCursorEpoch) {
    setSeenOverlayCursorEpoch(overlayCursorEpoch);
    if (overlayCursorEpoch !== null && selectedResultIdentity !== null) setSelectedResultIdentity(null);
  }
  const identityIndex = selectedResultIdentity
    ? selectableResults.findIndex((entry) => entry.key === selectedResultIdentity)
    : -1;
  const selectedIndex = identityIndex >= 0
    ? identityIndex
    : selectableResults.length > 0
      ? (activateResultsInChat ? 0 : Math.min(selectedIndexHintRef.current, selectableResults.length - 1))
      : 0;
  const selectedResultKey = selectableResults[selectedIndex]?.key;
  const entityResultsListRef = useRef<HTMLDivElement>(null);
  // Keep the keyboard-selected entity row visible in the page's scroller
  // (↑↓ through a long expanded list would otherwise select an off-screen row).
  useEffect(() => {
    const activeRow = entityResultsListRef.current?.querySelector<HTMLElement>("[data-active=\"true\"]");
    activeRow?.scrollIntoView({ block: "nearest" });
  }, [selectedResultKey]);
  useEffect(() => {
    selectedIndexHintRef.current = selectedIndex;
    const nextIdentity = selectableResults[selectedIndex]?.key ?? null;
    if (nextIdentity === selectedResultIdentity) return;
    // When the selected row disappears, selectedIndex is the nearest surviving
    // position. Promote that survivor to the canonical identity immediately so
    // a later insertion/rerank continues following the same row instead of the
    // old numeric position.
    // The selection identity is MessageSearchPage's own state (its click handlers set it too); this hook is the page's.
    // oxlint-disable-next-line react-doctor/no-derived-state, react-doctor/no-pass-live-state-to-parent -- result removal intentionally reconciles the user-owned selection identity to its nearest surviving row.
    setSelectedResultIdentity(nextIdentity);
  }, [selectableResults, selectedIndex, selectedIndexHintRef, selectedResultIdentity, setSelectedResultIdentity]);


  // Search-rail keyboard handler. Scoped to the rail container via React
  // onKeyDown on the root <div>, so it only fires when focus is inside the
  // rail (search input, filter buttons, or a result card). When the col-3
  // slot opens a thread/channel and focus moves to its composer textarea,
  // keydown there bubbles within col-3's subtree and never reaches this
  // handler — the prior document-level listener required target-sniffing
  // guards (`isEditableKeyboardTarget` + `defaultPrevented` + a special
  // case for the search input) to avoid hijacking composer Enter/Arrow,
  // and a regression in any of those guards would close the slot from
  // anywhere on the page. Scoping by DOM subtree removes the whole
  // attack surface: focus location is the source of truth.
  const handleRailKeyDown = useCallback((event: ReactKeyboardEvent<HTMLDivElement>) => {
    if (isSearchKeyboardComposing(event)) return;
    if (event.key === "Escape") {
      // A filter menu closes itself on Escape. Its popup is portaled, but the
      // keydown still bubbles here through the React tree, so without this
      // the same Escape would also close the slot or leave the search page.
      // Marked handled, so the shortcut registry's layers (the ⌘K overlay's
      // dismiss) leave it too: the menu's Base UI listener only marks it after
      // the registry has already heard it.
      if (openFilterMenu !== null) {
        event.preventDefault();
        return;
      }
      // Overlay mode: SearchOverlay owns Escape-to-dismiss. A plain Escape (no
      // filter menu open) must bubble to it — don't preventDefault and don't run
      // the page's slot-close / back-navigation here, or the overlay would either
      // never close (we swallowed the event) or double-act with its onClose.
      if (activateResultsInChat) return;
      event.preventDefault();
      if (slotOpen) {
        closeSearchContent();
        return;
      }
      handleSearchEscape();
      return;
    }
    if (!selectableResults.length) return;
    if (event.key === "ArrowDown") {
      event.preventDefault();
      const nextIndex = Math.min(selectedIndex + 1, selectableResults.length - 1);
      selectedIndexHintRef.current = nextIndex;
      setSelectedResultIdentity(selectableResults[nextIndex]?.key ?? null);
      return;
    }
    if (event.key === "ArrowUp") {
      event.preventDefault();
      const nextIndex = Math.max(selectedIndex - 1, 0);
      selectedIndexHintRef.current = nextIndex;
      setSelectedResultIdentity(selectableResults[nextIndex]?.key ?? null);
      return;
    }
    if (event.key === "Enter" && !event.shiftKey) {
      const selected = selectableResults[selectedIndex];
      if (selected) {
        event.preventDefault();
        if (selected.kind === "allResults") {
          openAllResults();
          return;
        }
        if (selected.kind === "appHit") {
          openAppHit(selected.hit);
          return;
        }
        // Overlay mode: keyboard activation matches a mouse click — jump to the
        // hit in chat (no col-3 preview in the overlay), which closes the overlay.
        if (selected.kind === "entity") {
          void (resultsOpenInChat ? openEntityResultInChat(selected.result) : openEntityResult(selected.result));
        } else {
          void (resultsOpenInChat ? openResultInChat(selected.result) : openResult(selected.result));
        }
      }
    }
  }, [activateResultsInChat, closeSearchContent, handleSearchEscape, openAllResults, openFilterMenu, openAppHit, openEntityResult, openEntityResultInChat, openResult, openResultInChat, resultsOpenInChat, selectableResults, selectedIndex, selectedIndexHintRef, setSelectedResultIdentity, slotOpen]);

  return {
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
  };
}
