import { useCallback, useRef } from "react";
import { artifactLinkId } from "@botiverse/raft-shared";
import type { ArtifactId } from "@botiverse/raft-shared";
import type { Dispatch, RefObject, MouseEvent as ReactMouseEvent, SetStateAction } from "react";
import type { Location, NavigateFunction } from "react-router-dom";
import { placeContextMenu } from "../../components/ui/contextMenuPosition";
import { useMobileBack } from "../../hooks/useAppNavigate";
import { ARTIFACT_OPEN_PARAM } from "../../apps/artifacts";
import type { useAppNavigate } from "../../hooks/useAppNavigate";
import { useChannelStore } from "../../store/channelStore";
import { formatSearchOpenParam, useSearchContentStore } from "../../store/searchContentStore";
import { useSearchHitMarkStore } from "../../store/searchHitMarkStore";
import type { SearchHitAnchor } from "../../store/searchHitMarkStore";
import { useThreadStore } from "../../store/threadStore";
import { directTaskConversationChannelId } from "../../utils/taskConversation";
import type { AppSearchHit } from "./AppSearchGroupSection";
import type { SearchEntityResult as SearchEntityRecord } from "./searchEntities";
import { fullPageSearchHopState, SEARCH_PRESENTATION_PAGE, SEARCH_PRESENTATION_PARAM } from "./searchOverlayLocation";
import type { MessageSearchResult } from "./searchResultTypes";
import type { SearchScopeTarget } from "./searchScope";
import { lastOpenedResultKeys } from "./searchSnapshot";

export interface SearchChannelContextMenuState {
  result: SearchEntityRecord;
  x: number;
  y: number;
}

/**
 * What the page does with a result: open it in col 3 of /search, or in the
 * conversation (the ⌘K overlay, a conversation's own search, a double
 * click), plus Escape / Back and the hand-off to the full results page.
 */
export function useSearchResultActions({
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
}: {
  activateResultsInChat: boolean;
  scope: SearchScopeTarget | null;
  slug: string | undefined;
  searchShortcutSource: string | null;
  railSearchSource: string | null;
  queryParam: string;
  deferUntilQuery: boolean;
  channelIdParam: string;
  query: string;
  visibleSearchParams: URLSearchParams;
  location: Location;
  navigate: NavigateFunction;
  nav: ReturnType<typeof useAppNavigate>;
  closeThread: () => void;
  rememberCurrentSearchQuery: () => void;
  rememberMessageResultsSearchQuery: () => void;
  rememberSearchEntityOpen: (entityKey: string) => void;
  rememberOpenedChannel: (channelId: string, kind: "channel" | "dm") => void;
  keepRestoredResultsInViewRef: RefObject<boolean>;
  searchSurfaceRef: RefObject<string>;
  selectedIndexHintRef: RefObject<number>;
  setSelectedResultIdentity: Dispatch<SetStateAction<string | null>>;
  resultClickTimerRef: RefObject<number | null>;
  entityResultClickTimerRef: RefObject<number | null>;
  pendingEntityResultRef: RefObject<SearchEntityRecord | null>;
  setChannelContextMenu: Dispatch<SetStateAction<SearchChannelContextMenuState | null>>;
}) {
  const openDM = useChannelStore((s) => s.openDM);
  const openUserDM = useChannelStore((s) => s.openUserDM);

  // A conversation's own search goes back to the conversation.
  const scopePath = scope && slug ? `/s/${slug}/${scope.kind}/${scope.id}` : null;
  const handleBack = useMobileBack(scopePath ?? searchShortcutSource ?? railSearchSource ?? (slug ? `/s/${slug}` : "/"));
  const handleSearchEscape = useCallback(() => {
    if (scopePath) {
      handleBack();
      return;
    }
    const hasCommittedQuery = queryParam.trim().length > 0;
    if (hasCommittedQuery && railSearchSource) {
      navigate(railSearchSource, { replace: true });
      return;
    }
    const exitsToServerRoot =
      (!hasCommittedQuery && !searchShortcutSource && !deferUntilQuery)
      || (!!channelIdParam && !deferUntilQuery);
    if (exitsToServerRoot) {
      navigate(slug ? `/s/${slug}` : "/", { replace: true });
      return;
    }
    handleBack();
  }, [channelIdParam, deferUntilQuery, handleBack, navigate, queryParam, railSearchSource, scopePath, searchShortcutSource, slug]);

  // Task #102 (Slack "Search for: … → results page"): hand the current query and
  // filters to the full results page (list + col-3 context preview). Replaces the
  // overlay's history entry so Back returns to the conversation, not to a
  // re-opened overlay. `?presentation=page` in the URL is what lets the desktop
  // render the page instead of the overlay (resolveSearchOverlayBackground); it is
  // a URL param — not history state — because the page's other URL writers
  // (preview open, thread sync) replace without state.
  const openAllResults = useCallback(() => {
    rememberCurrentSearchQuery();
    const params = new URLSearchParams(visibleSearchParams);
    params.delete("defer");
    const committedQuery = query.trim();
    if (committedQuery) params.set("q", committedQuery);
    else params.delete("q");
    params.set(SEARCH_PRESENTATION_PARAM, SEARCH_PRESENTATION_PAGE);
    navigate(
      { pathname: location.pathname, search: `?${params.toString()}` },
      { replace: true, state: fullPageSearchHopState(location.state) },
    );
  }, [location.pathname, location.state, navigate, query, rememberCurrentSearchQuery, visibleSearchParams]);

  // task #311 stdrc msg=b61ab472: clicking a result opens the picked entity
  // in col 3 of the /search master/detail layout (not navigate-away). The
  // URL sync hook in MainLayout mirrors searchContentStore → ?open=<...>.
  const openSearchContent = useSearchContentStore((s) => s.open);
  const closeSearchContent = useSearchContentStore((s) => s.close);
  const slot = useSearchContentStore((s) => s.slot);
  const slotOpen = !!slot;

  // Ref pattern: syncSelectedKey is referenced by openResult / openEntityResult
  // which are declared BEFORE selectableResults. Reading the array via ref
  // avoids the TDZ on the `const selectableResults` declared below.
  const selectableResultsRef = useRef<Array<{ key: string }>>([]);
  const syncSelectedKey = useCallback((key: string) => {
    // On a phone the result replaces this page; the list it comes back to
    // locates this row (returnedResultKey).
    if (keepRestoredResultsInViewRef.current) lastOpenedResultKeys.set(searchSurfaceRef.current, key);
    // Clicking a card is the canonical "select this result" gesture — it
    // must update selectedResultIdentity so selectedResultKey points at the clicked
    // card. Without this, the keyboard-focus shadow stays on whatever card
    // was first-mounted (always index 0) and the clicked card draws no
    // active treatment. Reference: pre-rail search behavior — one state.
    const next = selectableResultsRef.current.findIndex((entry) => entry.key === key);
    if (next < 0) return;
    selectedIndexHintRef.current = next;
    setSelectedResultIdentity(key);
  }, [keepRestoredResultsInViewRef, searchSurfaceRef, selectedIndexHintRef, setSelectedResultIdentity]);

  // Task v2: a hit in a task's own conversation opens its task, focused on the
  // hit: in col 3 from the page (openResult), the dialog from the ⌘K overlay
  // (openResultInChat). The hit names its task; its channel is the
  // conversation as stored (canonical), which is also the local one outside a
  // joint channel (the dialog resolves a joint task's local conversation).
  const openTaskConversationHit = useCallback((result: MessageSearchResult) => {
    if (!result.taskId) return;
    useThreadStore.getState().openTaskConversation({
      taskId: result.taskId,
      parentChannelId: result.parentChannelId,
      conversationChannelId: directTaskConversationChannelId({
        conversationChannelId: result.channelId,
        channelType: result.parentChannelType,
      }),
      focusedMessageId: result.id,
    });
  }, []);

  // Task #83: the opened message marks the query's words in its conversation
  // (searchHitMarkStore). `anchors` are what the URL shows while that
  // conversation is on screen: `?open=<kind>:<id>` in col 3 of /search,
  // `/channel/<id>` / `/dm/<id>` in chat, `?thread=<parent channel>:<parent>`
  // for a thread in chat. The mark clears once they leave the URL.
  const markOpenedSearchHit = useCallback((result: MessageSearchResult, anchors: readonly SearchHitAnchor[]) => {
    useSearchHitMarkStore.getState().setMark({
      messageId: result.id,
      query,
      anchors,
      url: `${location.pathname}${location.search}`,
    });
  }, [location.pathname, location.search, query]);

  const openResult = useCallback(async (result: MessageSearchResult) => {
    if (!slug) return;
    rememberMessageResultsSearchQuery();
    syncSelectedKey(`message:${result.id}`);
    // Thread hit: open the thread directly in col 3 per stdrc msg=54304d0e —
    // NOT a parent-channel + col-4-thread-overlay split. Slot.id is the
    // thread channel itself; messageId is the reply to scroll/highlight.
    //
    // First-principles correction (stdrc msg=41f5c906 2026-05-28 "点开 thread
    // 还是错位"): a thread is parent-message-anchored, NOT a regular channel
    // surface. SearchContentRoute renders <ThreadPanel embedded /> for thread
    // slots, and ThreadPanel reads from threadStore — so seed it here with
    // the parent ids we already have on the search hit. The store→URL sync
    // mirrors threadStore into ?thread=<parentChId>:<parentMsgId>, which the
    // URL→Store sync restores on cold-load deeplinks (col-4 overlay stays
    // suppressed by RightPanel's structural guard on /search).
    // A task hit: the task in col 3, as Activity opens a task row (TaskContentSlot), not its dialog.
    if (result.channelType === "task") {
      if (!result.taskId) return;
      if (!slot || slot.kind !== "task" || slot.id !== result.taskId) closeThread();
      openTaskConversationHit(result);
      markOpenedSearchHit(result, [{ param: "open", value: `task:${result.taskId}` }]);
      // The hit rides on the slot (`&msg=`): the one clicked stays the selected result, not the task's first.
      openSearchContent({ kind: "task", id: result.taskId, messageId: result.id });
      return;
    }
    if (result.channelType === "thread") {
      if (result.parentChannelId && result.parentMessageId) {
        // openThread() returns a Promise we don't need to await — it sets
        // panel-open state synchronously before the network round-trip.
        // Stryker disable all: typed thread payload shape is covered by openThread payload/source contracts.
        // The hit already carries the thread channel's own id — hand it over
        // so the panel loads the thread directly instead of re-resolving it
        // through the parent-message lookup (task #14).
        void useThreadStore
          .getState()
          .openThread({
            parentChannelId: result.parentChannelId,
            parentMessageId: result.parentMessageId,
            threadChannelId: result.channelId,
            focusedMessageId: result.id,
          });
        // Stryker restore all
      }
      markOpenedSearchHit(result, [{ param: "open", value: `thread:${result.channelId}` }]);
      openSearchContent({ kind: "thread", id: result.channelId, messageId: result.id });
      return;
    }
    // DM message hit must use kind="dm" so SearchContentRoute dispatches to
    // DmById (was a bug previously misclassified as "channel"; chat panel
    // for DM has different membership / header semantics).
    const kind = result.channelType === "dm" ? "dm" : "channel";
    // Only close a col-4 thread when the chosen search result actually swaps
    // col 3 to a different entity. Re-selecting the already-open channel/DM
    // from the search input is not a context swap, so it must not collapse the
    // thread the user is currently working in.
    if (!slot || slot.kind !== kind || slot.id !== result.channelId) {
      closeThread();
    }
    markOpenedSearchHit(result, [{ param: "open", value: `${kind}:${result.channelId}` }]);
    openSearchContent({ kind, id: result.channelId, messageId: result.id });
    rememberOpenedChannel(result.channelId, kind);
  }, [closeThread, markOpenedSearchHit, openSearchContent, openTaskConversationHit, rememberMessageResultsSearchQuery, rememberOpenedChannel, slug, slot, syncSelectedKey]);

  const openEntityResult = useCallback(async (result: SearchEntityRecord) => {
    if (!slug) return;
    rememberCurrentSearchQuery();
    syncSelectedKey(result.key);
    if (result.type === "channel" && result.channelId) {
      if (!slot || slot.kind !== "channel" || slot.id !== result.channelId) {
        closeThread();
      }
      openSearchContent({ kind: "channel", id: result.channelId });
      rememberSearchEntityOpen(result.key);
      return;
    }
    if (result.type === "computer" && result.machineId) {
      if (!slot || slot.kind !== "machine" || slot.id !== result.machineId) {
        closeThread();
      }
      openSearchContent({ kind: "machine", id: result.machineId });
      return;
    }
    try {
      if (result.type === "agentDm" && result.agentId) {
        const dmChannel = result.channelId
          ? { id: result.channelId }
          : await openDM(result.agentId);
        if (!slot || slot.kind !== "dm" || slot.id !== dmChannel.id) {
          closeThread();
        }
        openSearchContent({ kind: "dm", id: dmChannel.id });
        rememberSearchEntityOpen(result.key);
        return;
      }
      if (result.type === "humanDm" && result.userId) {
        const dmChannel = result.channelId
          ? { id: result.channelId }
          : await openUserDM(result.userId);
        if (!slot || slot.kind !== "dm" || slot.id !== dmChannel.id) {
          closeThread();
        }
        openSearchContent({ kind: "dm", id: dmChannel.id });
        rememberSearchEntityOpen(result.key);
      }
    } catch {
      if (result.type === "agentDm" && result.agentId) {
        if (!slot || slot.kind !== "agent" || slot.id !== result.agentId) {
          closeThread();
        }
        openSearchContent({ kind: "agent", id: result.agentId });
        return;
      }
      if (result.type === "humanDm" && result.userId) {
        closeThread();
        nav.toHuman(result.userId);
      }
    }
  }, [closeThread, nav, openDM, openUserDM, openSearchContent, rememberCurrentSearchQuery, rememberSearchEntityOpen, slug, slot, syncSelectedKey]);

  const openResultInChat = useCallback(async (result: MessageSearchResult) => {
    if (!slug) return;
    rememberMessageResultsSearchQuery();
    syncSelectedKey(`message:${result.id}`);
    closeSearchContent();
    if (result.channelType === "task") {
      openTaskConversationHit(result);
      return;
    }
    if (result.channelType === "thread") {
      if (result.parentChannelId && result.parentMessageId) {
        markOpenedSearchHit(result, [{ param: "thread", value: `${result.parentChannelId}:${result.parentMessageId}` }]);
        // Route-level opening has one transition owner. The canonical URL
        // hydrates threadStore through the existing URL→store projection;
        // pre-opening the store here would add an intermediate history entry.
        nav.toThreadMessage(
          result.parentChannelId,
          result.parentMessageId,
          result.id,
          result.parentChannelType === "dm" ? "dm" : "channel",
          result.parentChannelType === "dm" ? undefined : { sidebarFocus: "center" },
        );
      } else {
        void openResult(result);
      }
      return;
    }
    closeThread();
    markOpenedSearchHit(result, [{ route: result.channelType === "dm" ? "dm" : "channel", id: result.channelId }]);
    if (result.channelType === "dm") {
      nav.toDmMessage(result.channelId, result.id);
      rememberOpenedChannel(result.channelId, "dm");
      return;
    }
    nav.toMessage(result.channelId, result.id, { sidebarFocus: "center" });
    rememberOpenedChannel(result.channelId, "channel");
  }, [closeSearchContent, closeThread, markOpenedSearchHit, nav, openResult, openTaskConversationHit, rememberMessageResultsSearchQuery, rememberOpenedChannel, slug, syncSelectedKey]);

  const openEntityResultInChat = useCallback(async (result: SearchEntityRecord) => {
    if (!slug) return;
    rememberCurrentSearchQuery();
    syncSelectedKey(result.key);
    closeSearchContent();
    closeThread();
    if (result.type === "channel" && result.channelId) {
      nav.toChannel(result.channelId, { sidebarFocus: "center" });
      rememberSearchEntityOpen(result.key);
      return;
    }
    if (result.type === "computer" && result.machineId) {
      nav.toComputer(result.machineId);
      return;
    }
    try {
      if (result.type === "agentDm" && result.agentId) {
        const dmChannel = result.channelId
          ? { id: result.channelId }
          : await openDM(result.agentId);
        nav.toDm(dmChannel.id);
        rememberSearchEntityOpen(result.key);
        return;
      }
      if (result.type === "humanDm" && result.userId) {
        const dmChannel = result.channelId
          ? { id: result.channelId }
          : await openUserDM(result.userId);
        nav.toDm(dmChannel.id);
        rememberSearchEntityOpen(result.key);
      }
    } catch {
      if (result.type === "agentDm" && result.agentId) {
        nav.toAgent(result.agentId);
        return;
      }
      if (result.type === "humanDm" && result.userId) {
        nav.toHuman(result.userId);
      }
    }
  }, [closeSearchContent, closeThread, nav, openDM, openUserDM, rememberCurrentSearchQuery, rememberSearchEntityOpen, slug, syncSelectedKey]);

  // The ⌘K overlay and a conversation's own search have no col-3 preview: a
  // hit opens in the conversation.
  const resultsOpenInChat = activateResultsInChat || !!scope;

  // An app's hit opens in Search's detail area, beside the results, as any
  // result does (#proj-workspace:#104: an Artifact clicked in Raft opens in the
  // layout it was clicked in). The ⌘K overlay and a conversation's own search
  // have no detail area: the hit opens on the search page, with it open there.
  const openAppHit = useCallback((hit: AppSearchHit) => {
    rememberCurrentSearchQuery();
    syncSelectedKey(hit.key);
    if (resultsOpenInChat) {
      const params = new URLSearchParams();
      const committedQuery = query.trim();
      if (committedQuery) params.set("q", committedQuery);
      // An Artifact hit at the one Artifact address (`?artifact=`, artifactOpenAddress.ts), any other as `?open=`.
      if (hit.slot.kind === "artifact") params.set(ARTIFACT_OPEN_PARAM, artifactLinkId(hit.slot.id as ArtifactId));
      else params.set("open", formatSearchOpenParam(hit.slot));
      // The full page, not the overlay: without the marker a /search URL on
      // desktop renders as the overlay again (resolveSearchOverlayBackground),
      // over the same background, and the hit never opens.
      params.set(SEARCH_PRESENTATION_PARAM, SEARCH_PRESENTATION_PAGE);
      if (activateResultsInChat) {
        // From the overlay, as "View all results" does: replace its entry so
        // Back returns to where the overlay was opened.
        navigate(
          { pathname: location.pathname, search: `?${params.toString()}` },
          { replace: true, state: fullPageSearchHopState(location.state) },
        );
        return;
      }
      nav.toServerPath(`/search?${params.toString()}`);
      return;
    }
    if (!slot || slot.kind !== hit.slot.kind || slot.id !== hit.slot.id) closeThread();
    openSearchContent(hit.slot);
  }, [activateResultsInChat, closeThread, location.pathname, location.state, nav, navigate, openSearchContent, query, rememberCurrentSearchQuery, resultsOpenInChat, slot, syncSelectedKey]);

  const handleMessageResultClick = useCallback((event: ReactMouseEvent<HTMLButtonElement>, result: MessageSearchResult) => {
    // Overlay mode: a single click jumps to the message in chat (there is no col-3
    // preview to open). No double-click affordance / 220ms disambiguation needed.
    if (resultsOpenInChat) {
      void openResultInChat(result);
      return;
    }
    if (event.detail >= 2) {
      if (resultClickTimerRef.current !== null) {
        window.clearTimeout(resultClickTimerRef.current);
        resultClickTimerRef.current = null;
      }
      void openResultInChat(result);
      return;
    }
    if (resultClickTimerRef.current !== null) {
      window.clearTimeout(resultClickTimerRef.current);
    }
    resultClickTimerRef.current = window.setTimeout(() => {
      resultClickTimerRef.current = null;
      void openResult(result);
    }, 220);
  }, [openResult, openResultInChat, resultClickTimerRef, resultsOpenInChat]);

  const handleEntityResultClick = useCallback((event: ReactMouseEvent<HTMLButtonElement>, result: SearchEntityRecord) => {
    // Overlay mode: a single click jumps to the entity in chat (no col-3 preview).
    if (resultsOpenInChat) {
      void openEntityResultInChat(result);
      return;
    }
    if (event.detail >= 2) {
      if (entityResultClickTimerRef.current !== null) {
        window.clearTimeout(entityResultClickTimerRef.current);
        entityResultClickTimerRef.current = null;
      }
      pendingEntityResultRef.current = null;
      void openEntityResultInChat(result);
      return;
    }
    if (entityResultClickTimerRef.current !== null) {
      window.clearTimeout(entityResultClickTimerRef.current);
      entityResultClickTimerRef.current = null;
      const pendingResult = pendingEntityResultRef.current;
      pendingEntityResultRef.current = null;
      if (pendingResult && pendingResult.key !== result.key) {
        void openEntityResult(pendingResult);
      }
    }
    pendingEntityResultRef.current = result;
    entityResultClickTimerRef.current = window.setTimeout(() => {
      entityResultClickTimerRef.current = null;
      const pendingResult = pendingEntityResultRef.current;
      pendingEntityResultRef.current = null;
      if (pendingResult) {
        void openEntityResult(pendingResult);
      }
    }, 220);
  }, [entityResultClickTimerRef, openEntityResult, openEntityResultInChat, pendingEntityResultRef, resultsOpenInChat]);

  const handleChannelResultContextMenu = useCallback((
    event: ReactMouseEvent,
    result: SearchEntityRecord,
  ) => {
    event.preventDefault();
    event.stopPropagation();
    const position = placeContextMenu({
      x: event.clientX,
      y: event.clientY,
      width: 192,
      height: 40,
    });
    setChannelContextMenu({
      result,
      x: position.x,
      y: position.y,
    });
  }, [setChannelContextMenu]);

  return {
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
  };
}
