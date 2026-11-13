import { Fragment, useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import type { KeyboardEvent as ReactKeyboardEvent, ReactNode, UIEvent } from "react";
import { createPortal } from "react-dom";
import { useIntl } from "react-intl";
import Tooltip from "../../components/ui/Tooltip";
import { ArrowUp, CheckCheck, ChevronDown, ListFilter, TriangleAlert } from "lucide-react";
import { isUnreadInboxFilter, objectUnreadCountForFilter, useInboxStore } from "../../store/inboxStore";
import type { InboxItem, MarkDoneOptions } from "../../store/inboxStore";
import { inboxItemChannelId } from "../../store/inboxItem";
import { isScopeMarkedUnread } from "../../store/markedUnreadStore";
import { activityFilterOf, inboxStateForActivityFilter, parseActivityFilterChoice, writeActivityFilterChoice } from "../../store/activityFilterPreference";
import type { ActivityFilterChoice } from "../../store/activityFilterPreference";
import { ActivityInboxPanel, Banner, BannerAction, BannerDescription, Button, DropdownMenu, DropdownMenuContent, DropdownMenuItemLabel, DropdownMenuRadioGroup, DropdownMenuRadioItem, DropdownMenuSeparator, DropdownMenuTrigger, PickerTriggerButton, ScrollArea, useLocated } from "@botiverse/raft-ui";
import { MessageIcon } from "@botiverse/ricons";
import { InboxItemListGroup, InboxItemListHeading } from "@botiverse/raft-ui/wip";
import { useMessageStore } from "../../store/messageStore";
import { captureReceiverPrivateIngressContext } from "../../store/receiverPrivateIngress";
import { useServerStore } from "../../store/serverStore";
import { TASK_V2_CONVERSATIONS_FLAG_KEY, useServerFeatureFlag } from "../../store/serverFeatureFlags";
import { useSavedStore } from "../../store/savedStore";
import { useThreadStore } from "../../store/threadStore";
import { useSearchContentStore } from "../../store/searchContentStore";
import { trackActivityItemOpen, trackActivityMark } from "../../analytics/activity";
import { useAppNavigate } from "../../hooks/useAppNavigate";
import { useSettledValue } from "../../hooks/useSettledValue";
import { activityInboxTraceScope, currentActivityInboxTraceCycle, traceActivityInboxTransition } from "../../utils/activityInboxTrace";
import { TabRootBar } from "../../components/layout/TabRootBar";
import { isHostShell } from "../../embed";
import EmptyState from "../../components/ui/EmptyState";
import { placeInboxContextMenu } from "../../components/thread/inboxContextMenuPosition";
import DismissBackdrop from "../../components/ui/DismissBackdrop";
import { InboxContextMenu } from "../../components/thread/InboxContextMenu";
import { useRetireJump } from "../../hooks/useRetireJump";
import { swallowClickAfterPress } from "../../hooks/useRowSwipe";
import { useActivitySwipeActions } from "../../components/thread/activitySwipeActions";
import { activityReadTogglesSettled } from "../../components/thread/inboxRowActions";
import { PHONE_MEDIA_QUERY } from "../../components/ui/NarrowDialog";
import { useMediaQuery } from "../../hooks/effectPrimitives";
import type { ActivityRetapAnchor } from "../../components/thread/activityRetap";
import { isActivityMasterDetailViewport } from "../../components/thread/activityLayout";
import { activityVisit, useActivityVisitSurface } from "../../components/thread/activityVisit";
import { recordActivityUnreadSnapshot, showActivityUnreadSnapshot, useActivityUnreadSnapshot } from "../../store/activityUnreadSnapshot";
import { ContentLoading } from "../../components/ui/ContentLoading";
import { ACTIVITY_SURFACES, StaleCountsNotice } from "../../components/layout/StaleCountsNotice";
import { useRwUnconfigured } from "../../store/rwFreshness";
import { ACTIVITY_FILTER_ICON, ACTIVITY_FILTER_LABEL_ID, ACTIVITY_FILTER_MENU } from "./activityFilterMenu";
import { ActiveFilterChip } from "./ActiveFilterChip";
import { sortInboxRowsByTime } from "./activityDayGroups";
import { useActivityDayGroups } from "./useActivityDayGroups";
import { InboxRow } from "./InboxRow";
import { ObjectInboxRow } from "./ObjectInboxRow";
import { itemKey, rowSwipeFor } from "./inboxRowShared";
import { ActivityInboxSkeleton } from "./ActivityInboxSkeleton";
import { moveRowFocus, RETAP_ANCHOR_DROPPING_INPUT, nearLoadedEnd, MAX_PAGES_WITHOUT_SCROLL, rowLandingOffset, activityReadFilter, ACTIVITY_RAIL_INSET, PHONE_ACTIVITY_RAIL_INSET, slotItemKey } from "./threadsInboxHelpers";
import type { CtxMenu } from "./threadsInboxHelpers";
import { useActivityNextUnread } from "./useActivityNextUnread";
import { useRowFocusAcrossDays } from "./useRowFocusAcrossDays";
import { useThreadsInboxOpen } from "./useThreadsInboxOpen";

export function ThreadsInbox() {
  const { formatMessage } = useIntl();
  const items = useInboxStore((s) => s.items);
  const filter = useInboxStore((s) => s.filter);
  const channelFilterId = useInboxStore((s) => s.channelFilterId);
  const loading = useInboxStore((s) => s.loading);
  const loaded = useInboxStore((s) => s.loaded);
  const loadFailed = useInboxStore((s) => s.loadFailed);
  // 503 rw_unconfigured: the failed state says Activity is temporarily unavailable.
  const inboxUnconfigured = useRwUnconfigured(ACTIVITY_SURFACES);
  const loadingMore = useInboxStore((s) => s.loadingMore);
  const hasMore = useInboxStore((s) => s.hasMore);
  const totalCount = useInboxStore((s) => s.totalCount);
  const totalUnreadCount = useInboxStore((s) => s.totalUnreadCount);
  // Object rows (Artifacts) count apart from the conversations' (shared
  // activityObjectsContract); their unread as the filter lists them (under
  // Mentions, only the rows Mentions lists), as totalUnreadCount counts the
  // conversations'.
  const objectCount = useInboxStore((s) => s.objectCount);
  const objectUnreadCount = useInboxStore((s) => s.objectUnreadCount);
  const filterObjectUnreadCount = useInboxStore((s) => objectUnreadCountForFilter(s.filter, s));
  const inboxSearchQuery = useInboxStore((s) => s.searchQuery);
  const taskV2 = useServerFeatureFlag(TASK_V2_CONVERSATIONS_FLAG_KEY).enabled;
  const focusedItemKey = useInboxStore((s) => s.focusedItemKey);
  const focusRequestId = useInboxStore((s) => s.focusRequestId);
  const pendingFocusKind = useInboxStore((s) => s.pendingFocusKind);
  const setFilter = useInboxStore((s) => s.setFilter);
  const setSavedScrollTop = useInboxStore((s) => s.setScrollTop);
  const setFocusedItemKey = useInboxStore((s) => s.setFocusedItemKey);
  const loadInbox = useInboxStore((s) => s.loadInbox);
  const markRead = useInboxStore((s) => s.markRead);
  const markAllRead = useInboxStore((s) => s.markAllRead);
  const markDone = useInboxStore((s) => s.markDone);
  const openThread = useThreadStore((s) => s.openThread);
  const openTaskConversation = useThreadStore((s) => s.openTaskConversation);
  const openContentSlot = useSearchContentStore((s) => s.open);
  const contentSlot = useSearchContentStore((s) => s.slot);
  const nav = useAppNavigate();
  const [ctxMenu, setCtxMenu] = useState<CtxMenu | null>(null);
  const scrollRef = useRef<HTMLDivElement>(null);
  // On a phone /activity is the Activity tab root: its name is the page's h1
  // and its filter row pins inside the scroller (see `toolbar`).
  const isPhoneTabRoot = useMediaQuery(PHONE_MEDIA_QUERY);
  const coarsePointer = useMediaQuery("(pointer: coarse)");
  // Its scroll position across tab switches is the inbox store's
  // (`scrollTop`). Re-tapping the tab goes to the next unread item
  // (`goToNextUnread` below).
  const retapAnchorRef = useRef<ActivityRetapAnchor | null>(null);
  // The row the last re-tap went to; `nonce` counts the taps, so going to the
  // same row again restarts its located highlight.
  const [retapTarget, setRetapTarget] = useState<{ key: string; nonce: number } | null>(null);
  const focusedRowRef = useRef<HTMLDivElement>(null);
  const autoScrolledFocusKeyRef = useRef<string | null>(null);
  const isNearTopRef = useRef(true);
  const [newUpdateCount, setNewUpdateCount] = useState(0);
  const restoredScrollRef = useRef(false);
  const activeFocusKey = focusedItemKey;
  const scope = useInboxStore((s) => s.scope);
  const sidebarPinnedRefs = useServerStore((s) => s.sidebarOrder.pinned);
  // Pinned lists what the sidebar pins (the server resolves them): pinning or
  // unpinning while it is shown reloads it.
  const pinnedRefsKey = JSON.stringify(sidebarPinnedRefs ?? []);
  const pinnedRefsKeyRef = useRef(pinnedRefsKey);
  useEffect(() => {
    if (pinnedRefsKeyRef.current === pinnedRefsKey) return;
    pinnedRefsKeyRef.current = pinnedRefsKey;
    if (scope === "pinned") void loadInbox({ reset: true, reuseAllCount: true, reason: "manual" });
  }, [loadInbox, pinnedRefsKey, scope]);
  // Saved lists the threads followed through a save: a save or unsave the
  // server accepted while it is shown reloads it.
  const savedWriteRevision = useSavedStore((s) => s.writeRevision);
  const savedWriteRevisionRef = useRef(savedWriteRevision);
  useEffect(() => {
    if (savedWriteRevisionRef.current === savedWriteRevision) return;
    savedWriteRevisionRef.current = savedWriteRevision;
    if (scope === "saved") void loadInbox({ reset: true, reuseAllCount: true, reason: "manual" });
  }, [loadInbox, savedWriteRevision, scope]);
  // Under an Unread filter the list is a snapshot that only grows
  // (store/activityUnreadSnapshot): every row it has shown stays, read, where
  // it was, until the list changes, the server changes or the visit ends.
  const sortDirection = useInboxStore((s) => s.sortDirection);
  const serverId = useServerStore((s) => s.current?.id ?? null);
  const snapshotList = isUnreadInboxFilter(filter)
    ? JSON.stringify([serverId, filter, scope, channelFilterId, sortDirection, inboxSearchQuery])
    : null;
  const visit = activityVisit.current();
  const snapshot = useActivityUnreadSnapshot();
  const currentSnapshot = snapshotList !== null && snapshot?.list === snapshotList && snapshot.visit === visit
    ? snapshot
    : null;
  const shown = useMemo(() => showActivityUnreadSnapshot(items, currentSnapshot), [items, currentSnapshot]);
  const visibleItems = shown.rows;
  // When an item is open in col 3 of the Activity master/detail, keep its row
  // visually selected in the master list — same affordance as the selected
  // /search result card. Slot kind→item-key mirrors getInboxItemKey:
  // thread → `thread:<threadChannelId>`, channel/dm → `<kind>:<channelId>`,
  // artifact → `object:artifact:<id>`, task → its conversation's row.
  const openItemKey = contentSlot ? slotItemKey(contentSlot, visibleItems) : null;
  // The order on screen, for whatever picks a row by its place in the list.
  const shownInOrder = useMemo(() => sortInboxRowsByTime(visibleItems, sortDirection), [sortDirection, visibleItems]);
  useLayoutEffect(() => {
    recordActivityUnreadSnapshot(snapshotList === null ? null : { list: snapshotList, visit, ...shown });
  }, [shown, snapshotList, visit]);
  // A new filter, scope, sort or search empties the page and its totals until
  // the server answers. Mark all read and the header's counts keep the last
  // settled page's values meanwhile: dropping the button for that moment gave
  // the filters its room, so they showed their labels and went back to icons
  // when it returned (task #157; Raft DS › Responsive layout, "The first frame
  // is the settled one"). Before the first page, the filter-independent
  // unread count is the hint.
  const activeUnreadCount = useInboxStore((s) => s.activeUnreadCount);
  const shownTotalCount = useSettledValue(totalCount + objectCount, loaded);
  const shownTotalUnreadCount = useSettledValue(totalUnreadCount + filterObjectUnreadCount, loaded, activeUnreadCount + objectUnreadCount);
  const showMarkAllRead = shownTotalUnreadCount > 0;
  // Whether a page has ever settled: until then the head has no counts to
  // keep, and says nothing rather than "0 in progress · 0 unread".
  const countsKnown = useSettledValue(true, loaded, false);
  const prevItemsRef = useRef(shownInOrder);

  useEffect(() => {
    if (!loaded && !loading) {
      loadInbox({ reset: true, reason: "initial" });
    }
  }, [loadInbox, loaded, loading]);

  // Resolve a deferred "focus first unread" intent (set by the sidebar
  // dbl-click) once items are actually loaded — data-driven, so it doesn't
  // matter when items arrive or which loadInbox call populated them. If items
  // are loaded but none are unread, keep the intent pending until a later items
  // update (e.g. a new reply) can resolve it.
  useEffect(() => {
    if (!pendingFocusKind) return;
    const firstUnread = shownInOrder.find((item) => item.unreadCount > 0);
    if (!firstUnread) return;
    setFocusedItemKey(itemKey(firstUnread));
    useInboxStore.getState().setPendingFocusKind(null);
  }, [pendingFocusKind, setFocusedItemKey, shownInOrder]);

  useEffect(() => {
    restoredScrollRef.current = false;
    // Another filter is another list: Activity's re-tap starts from its top.
    retapAnchorRef.current = null;
  }, [channelFilterId, filter]);

  // The user moving the list themselves ends "where the last re-tap sent it".
  useEffect(() => {
    const scroller = scrollRef.current;
    if (!scroller) return;
    const drop = () => { retapAnchorRef.current = null; };
    for (const type of RETAP_ANCHOR_DROPPING_INPUT) scroller.addEventListener(type, drop, { passive: true });
    return () => {
      for (const type of RETAP_ANCHOR_DROPPING_INPUT) scroller.removeEventListener(type, drop);
    };
  }, []);

  useEffect(() => {
    if (restoredScrollRef.current || visibleItems.length === 0) return;
    const container = scrollRef.current;
    if (!container) return;
    const raf = requestAnimationFrame(() => {
      // Read, not subscribed: the list writes its scrollTop on every scroll
      // event, and a subscription re-rendered the whole list each time
      // (task #5). Only this one restore needs the saved value.
      const savedScrollTop = useInboxStore.getState().scrollTop;
      container.scrollTop = savedScrollTop;
      isNearTopRef.current = savedScrollTop < 50;
      restoredScrollRef.current = true;
    });
    return () => cancelAnimationFrame(raf);
  }, [visibleItems.length]);

  useEffect(() => {
    if (!activeFocusKey) {
      autoScrolledFocusKeyRef.current = null;
      return;
    }
    // Key + request id: re-requesting the focused key (same value) scrolls again.
    const focusRequest = `${focusRequestId}:${activeFocusKey}`;
    if (autoScrolledFocusKeyRef.current === focusRequest) return;
    const idx = visibleItems.findIndex((item) => itemKey(item) === activeFocusKey);
    if (idx === -1) return;
    const raf = requestAnimationFrame(() => {
      const container = scrollRef.current;
      const row = focusedRowRef.current;
      if (!container || !row) return;
      const containerRect = container.getBoundingClientRect();
      const rowRect = row.getBoundingClientRect();
      container.scrollTo({ top: container.scrollTop + rowRect.top - containerRect.top - rowLandingOffset(container), behavior: "smooth" });
      autoScrolledFocusKeyRef.current = focusRequest;
      traceActivityInboxTransition({
        source: "focus_scroll",
        itemKey: activeFocusKey,
        fromIndex: idx,
        toIndex: idx,
        focusOwner: true,
      }, currentActivityInboxTraceCycle(activityInboxTraceScope(
        captureReceiverPrivateIngressContext(useMessageStore.getState().currentUserId),
        activeFocusKey,
      )));
      isNearTopRef.current = false;
    });
    return () => cancelAnimationFrame(raf);
  }, [activeFocusKey, focusRequestId, visibleItems]);

  // The located highlight (states.md#located) on the row a jump went to: a
  // focus request (desktop double-click, "next unread"), which is then
  // retired; or a phone re-tap. Both last LOCATED_MS and look the same.
  //
  // A focus request always names a listed row (both are picked from
  // `visibleItems`), and it is keyed on the request alone, not on the row
  // staying listed: a row that leaves the list meanwhile (read under Unread,
  // marked done, another filter) must not stop the retire, or the focus would
  // stay behind and light the row again whenever it came back.
  const focusJump = focusedItemKey ? `${focusedItemKey}:${focusRequestId}` : null;
  const focusLocated = useLocated(focusJump);
  const retireFocusedItem = useCallback(() => setFocusedItemKey(null), [setFocusedItemKey]);
  useRetireJump(focusJump, retireFocusedItem);
  const retapJump = retapTarget ? `${retapTarget.key}:${retapTarget.nonce}` : null;
  const retapLocated = useLocated(retapJump);
  const retireRetapTarget = useCallback(() => setRetapTarget(null), []);
  useRetireJump(retapJump, retireRetapTarget);

  useEffect(() => {
    const prev = prevItemsRef.current;
    prevItemsRef.current = shownInOrder;
    if (prev === shownInOrder) return;
    const prevTopId = prev[0] ? itemKey(prev[0]) : null;
    const newTopId = shownInOrder[0] ? itemKey(shownInOrder[0]) : null;
    if (prevTopId && newTopId && prevTopId !== newTopId && !isNearTopRef.current) {
      // oxlint-disable-next-line react-doctor/no-chain-state-updates -- YMNNE-family: pre-existing new-update counter now observes the atomic receiver result; behavior is unchanged.
      setNewUpdateCount((count) => count + 1);
    }
    if (restoredScrollRef.current && isNearTopRef.current && scrollRef.current) {
      scrollRef.current.scrollTop = 0;
      setSavedScrollTop(0);
    }
  }, [shownInOrder, setSavedScrollTop]);

  const { activateTimerRef, handleOpen, navigateToChat, openObjectRow } = useThreadsInboxOpen({
    contentSlot,
    loaded,
    markRead,
    nav,
    openContentSlot,
    openTaskConversation,
    openThread,
    visibleItems,
  });
  useActivityVisitSurface();

  const handleActivate = useCallback((event: React.MouseEvent | ReactKeyboardEvent, item: InboxItem) => {
    const activationDetail = "detail" in event ? event.detail : 1;
    if (item.kind === "object") {
      // Opened by the double click's first click: its second opens nothing again.
      if (activationDetail < 2) openObjectRow(item);
      return;
    }
    // A phone has no list beside the conversation: it opens as a page pushed
    // inside Activity at once.
    if (!isActivityMasterDetailViewport()) {
      if (activateTimerRef.current !== null) {
        window.clearTimeout(activateTimerRef.current);
        activateTimerRef.current = null;
      }
      handleOpen(item);
      return;
    }
    if (activationDetail >= 2) {
      if (activateTimerRef.current !== null) {
        window.clearTimeout(activateTimerRef.current);
        activateTimerRef.current = null;
      }
      trackActivityItemOpen(item.kind);
      if (item.unreadCount > 0 || isScopeMarkedUnread(inboxItemChannelId(item))) void markRead(item);
      navigateToChat(item);
      return;
    }
    if (activateTimerRef.current !== null) window.clearTimeout(activateTimerRef.current);
    activateTimerRef.current = window.setTimeout(() => {
      activateTimerRef.current = null;
      handleOpen(item);
    }, 220);
  }, [activateTimerRef, handleOpen, markRead, navigateToChat, openObjectRow]);

  const openCtxMenu = useCallback((e: React.MouseEvent, item: InboxItem) => {
    e.preventDefault();
    setCtxMenu(placeInboxContextMenu({ x: e.clientX, y: e.clientY, item }));
  }, []);
  // iOS can land a synthetic click after the long-press touchend; it must
  // not dismiss the menu that press just opened.
  const ctxMenuTouchOpenedAtRef = useRef(0);
  const openCtxMenuFromLongPress = useCallback((coords: { x: number; y: number }, item: InboxItem) => {
    ctxMenuTouchOpenedAtRef.current = Date.now();
    setCtxMenu(placeInboxContextMenu({ x: coords.x, y: coords.y, item }));
  }, []);
  const closeCtxMenu = useCallback(() => setCtxMenu(null), []);
  const dismissCtxMenu = useCallback(() => {
    if (Date.now() - ctxMenuTouchOpenedAtRef.current < 500) return;
    setCtxMenu(null);
  }, []);

  const handleRowDone = useCallback((item: InboxItem, options?: MarkDoneOptions) => {
    trackActivityMark("done");
    return markDone(item, options);
  }, [markDone]);
  // A phone (the phone layout, by touch): no Mark as Done button in the row;
  // a left swipe and the press-and-hold menu instead (stdrc, raft-design
  // #769). A tablet and a desktop keep the button. A narrow window with a
  // mouse is not a phone: a mouse can't swipe, and its hover-only button
  // costs the list nothing at rest.
  const phoneTouch = isPhoneTabRoot && coarsePointer;
  const swipeActions = useActivitySwipeActions(handleRowDone);
  const swipeHiddenKeys = swipeActions.hiddenKeys;
  // Done and Unfollow take the row out of the list on every route, so every
  // route offers the same Undo: the swipe, the row's Mark as Done button and
  // the row menu (Raft DS › Feedback, "Confirming").
  const { done: rowDone, unfollow: rowUnfollow } = swipeActions;
  const listedItems = useMemo(
    () => (swipeHiddenKeys.size === 0 ? visibleItems : visibleItems.filter((item) => !swipeHiddenKeys.has(itemKey(item)))),
    [swipeHiddenKeys, visibleItems],
  );
  // From the listed rows, so a day with no rows left has no heading.
  const dayGroups = useActivityDayGroups(listedItems, sortDirection);
  useRowFocusAcrossDays(scrollRef, dayGroups);
  // One row is open on its buttons at a time: opening another, tapping
  // anywhere else or scrolling the list closes it (raft-design #785). As in
  // iOS Mail, the press that closes it does nothing else: a tap on another
  // row, Mark all read or a filter only closes the open one, so the click
  // that follows is swallowed. Only in the list (its scroller: the rows, and
  // on a phone the filter row and Mark all read): a press outside it (a
  // toast, the tab bar, the header) closes the row and acts too. A press on
  // the open row itself is the row's (useRowSwipe): its buttons run, the
  // rest of it closes it.
  const [openSwipeKey, setOpenSwipeKey] = useState<string | null>(null);
  const handleSwipeOpenChange = useCallback((key: string, open: boolean) => {
    setOpenSwipeKey((current) => (open ? key : current === key ? null : current));
  }, []);
  // A row is open only while rows swipe (a phone, by touch) and it is still
  // listed: one that left the list (a refresh after a Done elsewhere) or a
  // list that stopped swiping (rotated wider, a mouse) has none open, so no
  // press is taken for closing it.
  const liveOpenSwipeKey = useMemo(
    () => (phoneTouch && openSwipeKey !== null && listedItems.some((item) => itemKey(item) === openSwipeKey) ? openSwipeKey : null),
    [listedItems, openSwipeKey, phoneTouch],
  );
  useEffect(() => {
    if (liveOpenSwipeKey === null) return;
    const closeOnPressElsewhere = (event: PointerEvent) => {
      const target = event.target instanceof Element ? event.target : null;
      const row = target?.closest("[data-inbox-key]");
      if (row?.getAttribute("data-inbox-key") === liveOpenSwipeKey) return;
      setOpenSwipeKey(null);
      if (target && scrollRef.current?.contains(target)) swallowClickAfterPress(event);
    };
    document.addEventListener("pointerdown", closeOnPressElsewhere, true);
    return () => {
      document.removeEventListener("pointerdown", closeOnPressElsewhere, true);
      // Leaving this key behind (its row left the list, or rows stopped
      // swiping) forgets it, so it is not open if it comes back; a key that
      // replaced it stays.
      setOpenSwipeKey((current) => (current === liveOpenSwipeKey ? null : current));
    };
  }, [liveOpenSwipeKey]);
  const rowSwipe = useMemo(() => ({ onOpenChange: handleSwipeOpenChange, actions: swipeActions }), [handleSwipeOpenChange, swipeActions]);
  // The same two objects for every row, so a memoized row sees no change.
  const closedRowSwipe = useMemo(() => rowSwipeFor(rowSwipe, false), [rowSwipe]);
  const openRowSwipe = useMemo(() => rowSwipeFor(rowSwipe, true), [rowSwipe]);

  const { goToNextUnread, handleHeaderTitleClick } = useActivityNextUnread({
    activeFocusKey,
    isPhoneTabRoot,
    retapAnchorRef,
    scrollRef,
    setFocusedItemKey,
    setRetapTarget,
    visibleItems: shownInOrder,
  });

  const jumpToNextUnreadTitle = formatMessage({ id: "thread.header.jumpToNextUnread" });
  // On a phone the whole title bar takes a single tap, the same as the tab's.
  // It is a pointer shortcut: the Activity tab button is the accessible path
  // to the same gesture, so the bar stays a plain heading (no button role).
  // Its "Double-click to jump…" tooltip is desktop's: there a double-click on
  // the title focuses the next unread row.
  const headerContainerProps = useMemo(() => ({
    "data-testid": "inbox-header",
    title: isPhoneTabRoot ? undefined : jumpToNextUnreadTitle,
    onClick: isPhoneTabRoot ? goToNextUnread : undefined,
  }), [goToNextUnread, isPhoneTabRoot, jumpToNextUnreadTitle]);
  const headerTitleClickProps = useMemo(() => ({
    "data-testid": "inbox-header-title",
    title: isPhoneTabRoot ? undefined : jumpToNextUnreadTitle,
    onClick: isPhoneTabRoot ? undefined : handleHeaderTitleClick,
  }), [handleHeaderTitleClick, isPhoneTabRoot, jumpToNextUnreadTitle]);

  const handleMarkAllRead = useCallback(() => {
    trackActivityMark("read_all");
    // After any read toggle still writing (a queued Unread), as the server should end.
    const after = activityReadTogglesSettled();
    void markAllRead(after ? { after } : undefined);
  }, [markAllRead]);
  const scrollToTop = useCallback(() => {
    scrollRef.current?.scrollTo({ top: 0, behavior: "smooth" });
    setNewUpdateCount(0);
  }, []);

  const pagesWithoutScrollRef = useRef(0);
  // Another list (filter, channel, scope, sort or search) starts the count
  // again: a short one that can't be scrolled would otherwise never ask for
  // its next page (Tenny, #11357).
  useEffect(() => {
    pagesWithoutScrollRef.current = 0;
  }, [filter, channelFilterId, scope, sortDirection, inboxSearchQuery]);
  const handleScroll = useCallback((event: UIEvent<HTMLDivElement>) => {
    const target = event.currentTarget;
    // Scrolling the list closes the open row.
    if (openSwipeKey !== null) setOpenSwipeKey(null);
    isNearTopRef.current = target.scrollTop < 50;
    setSavedScrollTop(target.scrollTop);
    if (isNearTopRef.current) setNewUpdateCount(0);
    pagesWithoutScrollRef.current = 0;
    if (nearLoadedEnd(target) && hasMore && !loadingMore) void loadInbox();
  }, [hasMore, loadInbox, loadingMore, openSwipeKey, setSavedScrollTop]);

  const contextMenuBackdrop = ctxMenu ? (
    <DismissBackdrop onDismiss={dismissCtxMenu} trapContextMenu />
  ) : null;

  const contextMenuPortal = ctxMenu ? createPortal(
    <InboxContextMenu ctxMenu={ctxMenu} onClose={closeCtxMenu} onDone={rowDone} onUnfollow={rowUnfollow} />,
    document.body,
  ) : null;

  // Counts are numbers, so Space Mono, like Tasks' count. Both numbers use
  // the one <mono> tag, so each chunk gets its own key.
  let monoChunk = 0;
  const headerSubtitle = formatMessage({ id: "thread.header.subtitle" }, {
    activeCount: shownTotalCount,
    unreadCount: shownTotalUnreadCount,
    mono: (chunks: ReactNode[]) => <span key={`mono-${monoChunk++}`} className="font-mono">{chunks}</span>,
  });

  // Task #172 (stdrc, Option A): one Filter button opens the four lists; the
  // one shown, when it isn't All, is a chip beside it whose × goes back to
  // All. The choice is kept per server (store/activityFilterPreference) and
  // the inbox store restores it when the server becomes current.
  const activeFilter = activityFilterOf(filter, scope);
  const filterTriggerRef = useRef<HTMLButtonElement>(null);
  const chooseFilter = useCallback((choice: ActivityFilterChoice) => {
    writeActivityFilterChoice(serverId, choice);
    const next = inboxStateForActivityFilter(choice);
    setFilter(next.filter, next.scope);
  }, [serverId, setFilter]);
  const handleFilterChange = useCallback((value: unknown) => {
    chooseFilter(parseActivityFilterChoice(value));
  }, [chooseFilter]);
  const clearFilter = useCallback(() => {
    chooseFilter("all");
    // The chip and its × go away: focus stays in the row, on the Filter button.
    filterTriggerRef.current?.focus();
  }, [chooseFilter]);
  const toolbar = (
    <div
      data-testid="inbox-toolbar"
      // Match ConversationPanelTabs: 32px tabs, 8px above/below, and its 1px seam;
      // with a mouse on a desktop a 44px header row, its seam included, as
      // raft-ui's tab row and the Tasks toolbar (stdrc, 2026-11-04).
      // Its sides are the list column's margin, 20px at every width: the
      // Filter button, the title above and the rows' leading content start
      // on one line (raft-design patterns/lists.md, One edge).
      // At least 16px between the filter chip and Mark all read: the chip's
      // × tap area reaches 10px past its end (raft-ui 0.73 FilterChip).
      className={`@container flex h-[calc(--spacing(12)+1px)] md:pointer-fine:h-(--header-height) shrink-0 items-center justify-between gap-4 border-b border-line-seam bg-layer-canvas px-(--column-margin) ${isPhoneTabRoot ? "sticky top-0 z-chrome" : ""}`}
    >
      <div className="flex min-w-0 items-center gap-2">
        <DropdownMenu>
          <DropdownMenuTrigger
            ref={filterTriggerRef}
            data-testid="inbox-filter-button"
            // Open, the outlined trigger takes its hover fill, like any
            // button whose popup is open (mockup s1-option-a).
            className="data-popup-open:bg-fill-medium"
            render={<PickerTriggerButton type="button" />}
          >
            <ListFilter aria-hidden data-icon="inline-start" />
            {formatMessage({ id: "thread.filter.button" })}
            <span data-picker-trigger-indicator="" aria-hidden="true">
              <ChevronDown />
            </span>
          </DropdownMenuTrigger>
          <DropdownMenuContent aria-label={formatMessage({ id: "thread.filter.ariaLabel" })} data-testid="inbox-filter-menu">
            <DropdownMenuRadioGroup value={activeFilter} onValueChange={handleFilterChange}>
              {ACTIVITY_FILTER_MENU.map(({ choice, separated }) => {
                const Icon = ACTIVITY_FILTER_ICON[choice];
                return (
                  <Fragment key={choice}>
                    {separated && <DropdownMenuSeparator />}
                    <DropdownMenuRadioItem value={choice} data-testid={`inbox-filter-${choice}`}>
                      <Icon aria-hidden />
                      <DropdownMenuItemLabel>{formatMessage({ id: ACTIVITY_FILTER_LABEL_ID[choice] })}</DropdownMenuItemLabel>
                    </DropdownMenuRadioItem>
                  </Fragment>
                );
              })}
            </DropdownMenuRadioGroup>
          </DropdownMenuContent>
        </DropdownMenu>
        {activeFilter !== "all" && (
          <ActiveFilterChip
            choice={activeFilter}
            label={formatMessage({ id: ACTIVITY_FILTER_LABEL_ID[activeFilter] })}
            clearLabel={formatMessage({ id: "thread.filter.clear" })}
            onClear={clearFilter}
          />
        )}
      </div>
      {showMarkAllRead && (
        <Tooltip content={formatMessage({ id: "thread.markAllRead.title" })}>
          <Button
            onClick={handleMarkAllRead}
            size="md"
            variant="ghost"
            // Frameless at the bar's end: its words end on the margin, the
            // line the rows' times end on, and its padding hangs outward
            // (raft-design foundations/alignment.md); icon only, its icon box.
            // With a mouse on a desktop it is a 28px bar button (r6), as a
            // head's actions; its padding 10px and its icon box 6px in.
            className="-mr-[calc(--spacing(3)+1.5px)] shrink-0 whitespace-nowrap @max-[30rem]:-mr-2 @max-[30rem]:size-8 @max-[30rem]:px-0 md:pointer-fine:h-(--bar-button-size) md:pointer-fine:rounded-(--bar-button-radius) md:pointer-fine:px-2.5 md:pointer-fine:-mr-[calc(--spacing(2.5)+1.5px)] md:pointer-fine:@max-[30rem]:size-(--bar-button-size) md:pointer-fine:@max-[30rem]:px-0 md:pointer-fine:@max-[30rem]:-mr-1.5"
            data-testid="inbox-mark-all-read"
          >
            <CheckCheck aria-hidden className="hidden @max-[30rem]:block" />
            <span className="@max-[30rem]:sr-only">{formatMessage({ id: "thread.markAllRead.label" })}</span>
          </Button>
        </Tooltip>
      )}
    </div>
  );

  const firstLoad = loading && visibleItems.length === 0;
  const DayHeading = isPhoneTabRoot ? "h2" : "h3";

  // A page that lands while the reader is still near the end asks for the
  // next one at once: no scroll event would, and the reader would reach the
  // end and wait (task #5).
  useEffect(() => {
    const container = scrollRef.current;
    if (!container || firstLoad || !hasMore || loadingMore) return;
    if (pagesWithoutScrollRef.current >= MAX_PAGES_WITHOUT_SCROLL || !nearLoadedEnd(container)) return;
    pagesWithoutScrollRef.current += 1;
    void loadInbox();
  }, [firstLoad, hasMore, listedItems.length, loadInbox, loadingMore]);
  // Nothing to keep and the load failed: the failed state, never the empty
  // one (Raft DS › Feedback, "Empty, loading and failed"; task #164).
  const showLoadFailed = !firstLoad && loadFailed && listedItems.length === 0;
  const retryLoad = useCallback(() => {
    void loadInbox({ reset: true, reason: "manual" });
  }, [loadInbox]);

  return (
    // Its left neighbour (the rail, or the sidebar) already draws the seam.
    <ActivityInboxPanel edge="inset">
      {/* No Back: on a phone /activity is the Activity tab root, reached from
          the tab bar (Raft DS › Navigation: tab roots have no Back), so its
          head is the tab roots' bar and its name the page's one h1. A host
          shell draws its own title bar, so the web draws none. */}
      {!isHostShell() && (
        <TabRootBar
          name={formatMessage({ id: "thread.header.title" })}
          // Before any page has settled the counts are not known: the
          // subtitle's line stays (so the head keeps its height) but shows
          // nothing; it is the subtitle itself, invisible and hidden from
          // assistive technology. A refilter keeps the last settled counts
          // (above). Not a Skeleton bar: the line is a <p>, Skeleton a <div>.
          subtitle={!countsKnown ? <span aria-hidden className="invisible" data-testid="inbox-loading-counts">{headerSubtitle}</span> : headerSubtitle}
          headingLevel={isPhoneTabRoot ? 1 : 2}
          containerProps={headerContainerProps}
          titleProps={headerTitleClickProps}
        />
      )}

      {/* Task #164: the rows and counts may be the last known ones; say so
          once, under the head. Not with the failed state: that already says
          the list did not load. */}
      {!showLoadFailed && (
        <StaleCountsNotice
          surfaces={ACTIVITY_SURFACES}
          messageId="thread.staleNotice"
          unavailableMessageId="thread.unavailableNotice"
          data-testid="activity-stale-notice"
        />
      )}

      <div className="flex min-h-0 flex-1">
        <section className="flex min-w-0 flex-1 flex-col">
          {isPhoneTabRoot ? null : toolbar}

          {/* raft-ui ScrollArea: the element every scroll ref here reads
              and scrolls (restore, focus landing, next unread, re-tap). Its
              scrollbars show while it is pointed at or scrolls, as on the
              page scrollers. The padding is the content's, so the scrollbar
              stays at the edge; the content is a full-height column so the
              empty state fills what is left. The scrollbar starts below the
              day's heading, and on the phone the pinned filter row above it
              (railInset, ACTIVITY_RAIL_INSET). */}
          <ScrollArea
            ref={scrollRef}
            data-testid="inbox-scroll"
            // The scroller stays when the rows arrive, so it carries the busy
            // state; the skeleton list goes away (raft-ui InboxItem, Loading).
            aria-busy={firstLoad || undefined}
            className="flex-1 bg-layer-canvas"
            contentClassName={`flex min-h-full flex-col *:shrink-0 safe-bottom ${isPhoneTabRoot ? "pb-1" : "py-1"}`}
            railInset={isPhoneTabRoot ? PHONE_ACTIVITY_RAIL_INSET : ACTIVITY_RAIL_INSET}
            onScroll={handleScroll}
          >
            {/* Phone tab root: the filter row is the scroller's first child
                and pins under the bar, like Tasks' (TasksPanel). */}
            {isPhoneTabRoot && toolbar}
            {newUpdateCount > 0 && (
              <Button
                onClick={scrollToTop}
                size="md"
                variant="outline"
                // z-float: over the rows (an InboxItem's parts are z-raised)
                // and the stuck day heading (z-sticky); at the rows' level the
                // rows after this pill painted their text and faces over it
                // (artin). It sits below the stuck heading (26px), which is
                // all that dates the rows under it.
                data-testid="inbox-new-updates"
                className={`sticky z-float mx-auto my-2 flex w-fit ${isPhoneTabRoot ? "top-[81px]" : "top-8"}`}
              >
                <ArrowUp size={14} />
                {formatMessage({ id: "thread.newUpdates" }, { count: newUpdateCount })}
              </Button>
            )}
            {firstLoad ? (
              <ActivityInboxSkeleton phone={isPhoneTabRoot} />
            ) : showLoadFailed ? (
              <div className="px-(--column-margin) py-3">
                <Banner status="warning" role="alert" data-testid="inbox-load-failed">
                  <TriangleAlert aria-hidden />
                  <BannerDescription>
                    {formatMessage({ id: inboxUnconfigured ? "thread.unavailableNotice" : "thread.loadFailed" })}
                  </BannerDescription>
                  <BannerAction>
                    <Button
                      type="button"
                      size="md"
                      variant="default"
                      onClick={retryLoad}
                      data-testid="inbox-load-failed-retry"
                    >
                      {formatMessage({ id: "thread.loadFailedRetry" })}
                    </Button>
                  </BannerAction>
                </Banner>
              </div>
            ) : listedItems.length === 0 ? (
              <EmptyState
                // Fill what is left of the scroller (under the phone's filter row).
                className="flex flex-1 flex-col items-center justify-center"
                icon={<MessageIcon width={36} height={36} />}
                title={scope === "pinned"
                  ? formatMessage({ id: "thread.empty.pinnedTitle" })
                  : scope === "saved"
                  ? formatMessage({ id: "thread.empty.savedTitle" })
                  : scope === "artifacts"
                  ? formatMessage({ id: "thread.empty.artifactsTitle" })
                  : filter === "mentions"
                  ? formatMessage({ id: "thread.empty.mentionsTitle" })
                  : activityReadFilter(filter) === "unread"
                    ? formatMessage({ id: "thread.empty.unreadTitle" })
                    : formatMessage({ id: "thread.empty.defaultTitle" })}
                description={scope === "pinned"
                  ? formatMessage({ id: "thread.empty.pinnedDescription" })
                  : scope === "saved"
                  ? formatMessage({ id: "thread.empty.savedDescription" })
                  // Why it's empty and what fills it: back after #250 because it tells people what's happening
                  // (xxchan, Kirby), as Pinned's and Saved's lines do.
                  : scope === "artifacts"
                  ? formatMessage({ id: "thread.empty.artifactsDescription" })
                  : filter === "mentions"
                  ? formatMessage({ id: "thread.empty.mentionsDescription" })
                  : formatMessage({ id: "thread.empty.defaultDescription" })}
              />
            ) : (
              // A list of cells: 2px between rows, 8px at its ends with the
              // scroller's own 4px (raft-design patterns/lists.md), one group
              // per day, so the next day's heading pushes the last one out. The
              // scroll margin keeps a row focused from the keyboard out from
              // under the stuck heading (and on a phone the filter row).
              <div className={`flex flex-col gap-0.5 ${isPhoneTabRoot ? "pt-2 pb-1 [&_button]:scroll-mt-[79px]" : "py-1 [&_button]:scroll-mt-[30px]"}`} data-layout="list" onKeyDown={moveRowFocus}>
                {dayGroups.map((group) => (
                  <InboxItemListGroup key={group.day} data-testid="inbox-day-group">
                    {group.label ? (
                      // z-sticky: over the rows' z-raised parts, under the pill
                      // (z-float) and the phone's filter row (z-chrome). On the list's own surface, so
                      // no row shows through; on a phone it sticks under that row,
                      // and is an h2, one level under the page's h1 there.
                      <InboxItemListHeading data-testid="inbox-day-heading" render={<DayHeading>{group.label}</DayHeading>} className={`sticky z-sticky bg-layer-canvas ${isPhoneTabRoot ? "top-[49px]" : "top-0"}`} />
                    ) : null}
                    {group.rows.map((item) => {
                      const key = itemKey(item);
                      // `active` = sticky "open in col 3" highlight, styled the same
                      // as an active search result (stdrc 2026-06-23); `located` =
                      // the 2s highlight of the row a jump went to.
                      const isFocused = key === activeFocusKey;
                      const rowProps = {
                        filter,
                        onOpen: handleActivate,
                        onDone: rowDone,
                        onContextMenu: openCtxMenu,
                        onLongPress: openCtxMenuFromLongPress,
                        focused: isFocused,
                        active: key === openItemKey,
                        located: (focusLocated && key === focusedItemKey) || (retapLocated && key === retapTarget?.key),
                        focusRef: isFocused ? focusedRowRef : undefined,
                      };
                      return item.kind === "object" ? (
                        <ObjectInboxRow key={key} item={item} swipe={phoneTouch ? rowSwipeFor(rowSwipe, key === liveOpenSwipeKey) : undefined} {...rowProps} />
                      ) : (
                        <InboxRow key={key} item={item} searchQuery={inboxSearchQuery} taskV2={taskV2} swipe={phoneTouch ? (key === liveOpenSwipeKey ? openRowSwipe : closedRowSwipe) : undefined} {...rowProps} />
                      );
                    })}
                  </InboxItemListGroup>
                ))}
                {loadingMore && (
                  <ContentLoading className="py-3">{formatMessage({ id: "thread.loadingMore" })}</ContentLoading>
                )}
              </div>
            )}
          </ScrollArea>
        </section>
      </div>

      {contextMenuBackdrop}
      {contextMenuPortal}
    </ActivityInboxPanel>
  );
}
