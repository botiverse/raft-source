// MessageTimeline's contract (messageTimelineShared) on raft-ui's VirtualList:
// only the rows in or near the view are mounted. The timeline of every surface
// (channel, DM, thread, public page).
//
// What the list owns: which rows are mounted and their measured heights;
// scrolling away the size change of a row above the view (an image loads, a
// reaction is added); keeping the top row in place when rows are added or
// removed above it (`keepAnchorOnItemsChange`: older pages); jumps to a row
// at start / center / end (`scrollTo({ key, align })`, exact before the first
// paint); keyboard paging on the focused scroller.
// What this wrapper owns: following the bottom (only a user gesture or an
// explicit call changes it), loading pages near the loaded edges and the
// pagination barrier of a bounded context window, the initial position (focus,
// then the remembered row, then the tail), scroll memory, the at-bottom
// signal and the visible window.
//
// The list's items are the timeline's rows (MessageTimelineRow): the leading
// rows (a thread's parent, the history boundary) and then the messages, keyed
// `<kind>:<id>`. A leading row is measured, virtualized and anchored like a
// message; message ids, indexes and the visible window skip it.
import { forwardRef, useCallback, useEffect, useImperativeHandle, useLayoutEffect, useMemo, useRef, useState } from "react";
import type { CSSProperties, ReactNode } from "react";
import { useIntl } from "react-intl";
import { ScrollAreaGutters, VirtualList, useScrollAreaContainer } from "@botiverse/raft-ui";
import { TIMELINE_SCROLL_AREA } from "./timelineScrollArea";
import type { VirtualListApi, VirtualListItemRenderProps, VirtualListMeasuredRef } from "@botiverse/raft-ui";
import { useJumpEndsShortcut } from "./useJumpEndsShortcut";
import {
  AT_BOTTOM_THRESHOLD,
  buildMessageTimelineRows,
  distanceFromBottom,
  forgetScroll,
  MessageTimelineKeepMessageVisibleContext,
  MessageTimelinePreserveViewportContext,
  MessageTimelineRowMessageIdContext,
  messageTimelineRowKey,
  messageTimelineRowKeyOfMessageId,
  messageTimelineMessages,
  messageRowSelector,
  recallScroll,
  rememberScroll,
  SCROLL_NAVIGATION_KEYS,
  USER_SCROLL_MOMENTUM_WINDOW_MS,
  VISIBLE_WINDOW_REPORT_INTERVAL_MS,
} from "./messageTimelineShared";
import { InlineAudioKeepAliveContext, useInlineAudioKeepAliveScope } from "../../utils/inlineAudioKeepAlive";
import { useAllTimelineRowsMounted } from "../../utils/timelineMountAll";
import { useTimelineTimeReveal } from "./useTimelineTimeReveal";
import { useTimelineWidthAnchor } from "./timelineWidthAnchor";
import { messageRowElements, topVisibleMessage, useSpotBeforeReload } from "./timelineTopRow";
import { rowViewportPositionOfList, useViewportChangeNotifier, visibleMessageIdsOfList } from "./timelineVisibleRows";
import type {
  MessageTimelineHandle,
  MessageTimelineLeadingRow,
  MessageTimelineProps,
  MessageTimelineRow,
} from "./messageTimelineShared";

// Load the next page when the view is this close to a loaded edge: two
// screens, at least 600px. At 600px (under a screen) a quick fling reached the
// top and stopped there 0.5-0.8s for every page (task #5, InNOut on staging).
const EDGE_LOAD_PX = 600;
const EDGE_LOAD_SCREENS = 2;
const edgeLoadPx = (el: HTMLElement) => Math.max(EDGE_LOAD_PX, el.clientHeight * EDGE_LOAD_SCREENS);
const ESTIMATED_ROW_PX = 72;
// At most the shortest row (a grouped one-line message).
const MIN_ROW_PX = 20;
// How long a layout anchor taken before a width change (a thread opening
// beside the channel) waits for that change.
const ANCHOR_PRESERVE_LAYOUT_CHANGE_MS = 1200;
// How long a jump to a message that isn't loaded yet waits for it: a surface
// asks for the jump right after setting the messages that hold it, and the
// call can come before that render commits.
const PENDING_JUMP_MS = 1500;
const GESTURE_EVENTS = ["wheel", "touchstart", "touchmove", "pointerdown", "keydown"] as const;

// The scroller: the list's own CSS sets overflow-anchor: none already (it
// compensates size changes itself); inline as well, so the contract holds
// even before the stylesheet applies. overscroll-behavior is left to the
// list's CSS (none): its iOS momentum compensation depends on it.
const SCROLLER_STYLE: CSSProperties = { overflowAnchor: "none" };

const NO_LEADING_ROWS: readonly MessageTimelineLeadingRow[] = [];

const VirtualMessageTimeline = forwardRef<MessageTimelineHandle, MessageTimelineProps>(
  function VirtualMessageTimeline(
    {
      source,
      renderItem,
      leadingRows = NO_LEADING_ROWS,
      renderLeadingRow,
      footer,
      foldedMessageIds,
      onAtBottomChange,
      onVisibleMessageWindowChange, onViewportChange,
      className,
      testId = "message-scroller",
      persistKey,
      sparseAnchor = "top",
      keepTopOnWidthChange = false,
    },
    ref,
  ) {
    const { messages } = source;
    const { formatMessage } = useIntl();
    // Every row mounted (`virtual` off) while a capture needs rows far from
    // the view ("Share as image" of a selection; utils/timelineMountAll).
    // Rows stay mounted for focus and the text selection by the list itself:
    // a drag-selection carried far keeps growing the mounted rows, which is
    // raft-ui's intended selection behaviour.
    const mountAll = useAllTimelineRowsMounted();
    const mountAllRef = useRef(mountAll);
    mountAllRef.current = mountAll;
    // A voice note plays on while its row is scrolled out (recycled), and
    // stops when this timeline unmounts or moves to another conversation.
    const audioKeepAlive = useInlineAudioKeepAliveScope(persistKey);
    // A collapsed system-message group is one row (its summary): its hidden
    // messages are not rows, so they cannot fill the window the list mounts
    // (sized by MIN_ROW_PX) with empty ones.
    const rows = useMemo(
      () => buildMessageTimelineRows(leadingRows, messages, foldedMessageIds),
      [foldedMessageIds, leadingRows, messages],
    );
    const rowsRef = useRef(rows);
    rowsRef.current = rows;
    // `renderItem`'s index is the message's index in `messages`, folded
    // messages included.
    const messageIndexById = useMemo(() => {
      const map = new Map<string, number>();
      messages.forEach((m, i) => map.set(m.id, i));
      return map;
    }, [messages]);
    const leadingCount = leadingRows.length;
    const apiRef = useRef<VirtualListApi>(null);
    const listEl = useCallback(() => apiRef.current?.listElRef.current ?? null, []);
    useJumpEndsShortcut(listEl, apiRef);

    // The row kept in place when rows are added or removed. New rows go below
    // the leading rows (older replies under the boundary): keeping the
    // boundary, or a parent the reader has scrolled into, would push the
    // messages being read. The parent is kept only after a jump onto it (a
    // restore, its search hit), until the reader scrolls: then it is what is
    // being read. Scrolled to the top by hand, the replies are, and older ones
    // load above them.
    const parentAnchorRef = useRef(false);
    const canAnchorRow = useCallback((row: MessageTimelineRow) => (
      row.kind === "message" || (row.kind === "parent" && parentAnchorRef.current)
    ), []);
    // A message id names its message row, or the parent row for the thread's
    // parent (its search hit, a remembered position on it).
    const leadingRowsRef = useRef(leadingRows);
    leadingRowsRef.current = leadingRows;
    const messagesRef = useRef(messages);
    messagesRef.current = messages;
    const foldedRef = useRef(foldedMessageIds);
    foldedRef.current = foldedMessageIds;
    const rowKeyOfMessageId = useCallback((id: string) => (
      messageTimelineRowKeyOfMessageId(id, leadingRowsRef.current, foldedRef.current)
    ), []);
    const hasRowFor = useCallback((id: string) => (
      messagesRef.current.some((m) => m.id === id)
      || leadingRowsRef.current.some((row) => row.kind === "parent" && row.message?.id === id)
    ), []);

    const sourceRef = useRef(source);
    sourceRef.current = source;
    const persistKeyRef = useRef(persistKey);
    persistKeyRef.current = persistKey;
    const onAtBottomChangeRef = useRef(onAtBottomChange);
    onAtBottomChangeRef.current = onAtBottomChange;
    const onVisibleRef = useRef(onVisibleMessageWindowChange);
    onVisibleRef.current = onVisibleMessageWindowChange;

    // Follow-bottom is the reader's intent: only a user-gesture scroll, or an
    // explicit scrollToBottom / armFollowOnNextAppend, changes it.
    const followRef = useRef(true);
    const armedFollowRef = useRef(false);
    const lastGestureAtRef = useRef(0);
    // Set by a gesture, consumed by the next scroll event however late it
    // comes (a busy main thread can delay it past the momentum window).
    const gestureIntentRef = useRef(false);
    const gestureGenerationRef = useRef(0);
    const userHasScrolledRef = useRef(false);
    // The initial position was a focus or a remembered row, not the tail:
    // don't load newer pages until the reader scrolls.
    const restoredRef = useRef(false);
    const [atBottom, setAtBottom] = useState(true);
    const atBottomRef = useRef(true);
    const lastWindowKeyRef = useRef("");

    // The pagination barrier of a bounded context window (a thread search
    // hit): no edge loading until a gesture newer than the window's key.
    const blockKeyRef = useRef(source.sentinelAutoLoadBlockKey);
    const blockedRef = useRef(source.sentinelAutoLoadBlockKey != null);
    const blockGestureGenerationRef = useRef(0);
    if (source.sentinelAutoLoadBlockKey !== blockKeyRef.current) {
      blockKeyRef.current = source.sentinelAutoLoadBlockKey;
      blockedRef.current = source.sentinelAutoLoadBlockKey != null;
      blockGestureGenerationRef.current = gestureGenerationRef.current;
    }

    // Initial position, once per mount (and again after the messages empty):
    // focus, then the remembered row, then the tail.
    const didInitialRef = useRef(false);
    const pendingInitialRef = useRef<{ key: string; align: "start" | "center" } | null>(null);
    const pendingJumpRef = useRef<{ id: string; align: "start" | "center" | "end"; smooth: boolean; until: number } | null>(null);

    // A layout anchor taken before an expected width change (thread open):
    // the top message and its offset, put back exactly once the list resizes.
    const layoutAnchorRef = useRef<{ id: string; offset: number; until: number } | null>(null);
    const widthAnchor = useTimelineWidthAnchor(keepTopOnWidthChange, listEl, topVisibleMessage, followRef);

    // A programmatic jump owns its scroll events: a gesture just before it
    // (the click that asked for it) must not attribute them to the reader.
    const dropGestureAttribution = useCallback(() => {
      gestureIntentRef.current = false;
      lastGestureAtRef.current = 0;
    }, []);

    // A page landing while an instant jump settles does not move its target:
    // the list (raft-ui 0.12.0) holds the jump's row by key.
    const scrollToKey = useCallback((messageId: string, align: "start" | "center" | "end", smooth = false) => {
      dropGestureAttribution();
      const key = rowKeyOfMessageId(messageId);
      parentAnchorRef.current = key.startsWith("parent:");
      apiRef.current?.scrollTo({
        key,
        align,
        behavior: smooth ? "smooth" : "instant",
      });
    }, [dropGestureAttribution, rowKeyOfMessageId]);

    // While a smooth scroll to the bottom runs, its frames are short of the
    // bottom without being a reason to stop following.
    const smoothBottomUntilRef = useRef(0);
    const scrollToBottom = useCallback((smooth = false) => {
      parentAnchorRef.current = false;
      if (smooth) smoothBottomUntilRef.current = performance.now() + 1000;
      apiRef.current?.scrollTo({ position: "bottom", behavior: smooth ? "smooth" : "instant" });
    }, []);

    // The message rows in view, plus as many again below them: roughly one
    // viewport of lookahead (the rows below the view aren't mounted, so the
    // lookahead is taken from the messages).
    const reportVisibleWindow = useCallback(() => {
      const el = listEl();
      const callback = onVisibleRef.current;
      if (!el || !callback) return;
      const rect = el.getBoundingClientRect();
      const ids: string[] = [];
      for (const row of messageRowElements(el)) {
        const r = row.getBoundingClientRect();
        if (r.bottom >= rect.top && r.top <= rect.bottom && row.dataset.timelineMessageId) {
          ids.push(row.dataset.timelineMessageId);
        }
      }
      if (ids.length > 0) {
        const all = messagesRef.current;
        const last = all.findIndex((m) => m.id === ids[ids.length - 1]);
        if (last >= 0) {
          for (const m of all.slice(last + 1, last + 1 + ids.length)) ids.push(m.id);
        }
      }
      const key = ids.join("|");
      if (key === lastWindowKeyRef.current) return;
      lastWindowKeyRef.current = key;
      callback(ids);
    }, [listEl]);
    // Throttled: immediate when the last report is older than the interval,
    // otherwise one trailing report (in a frame) at the end of the interval.
    const lastReportAtRef = useRef(Number.NEGATIVE_INFINITY);
    const reportTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
    const reportFrameRef = useRef<number | null>(null);
    const scheduleVisibleWindowReport = useCallback(() => {
      if (!onVisibleRef.current) return;
      if (reportTimerRef.current !== null || reportFrameRef.current !== null) return;
      const run = () => {
        lastReportAtRef.current = performance.now();
        reportVisibleWindow();
      };
      const wait = lastReportAtRef.current + VISIBLE_WINDOW_REPORT_INTERVAL_MS - performance.now();
      if (wait <= 0) {
        run();
        return;
      }
      reportTimerRef.current = setTimeout(() => {
        reportTimerRef.current = null;
        reportFrameRef.current = requestAnimationFrame(() => {
          reportFrameRef.current = null;
          run();
        });
      }, wait);
    }, [reportVisibleWindow]);
    useEffect(() => () => {
      if (reportTimerRef.current !== null) clearTimeout(reportTimerRef.current);
      if (reportFrameRef.current !== null) cancelAnimationFrame(reportFrameRef.current);
    }, []);

    const notifyVisible = useViewportChangeNotifier(onViewportChange, rows);
    const maybeLoadEdges = useCallback(() => {
      const el = listEl();
      // With every row mounted for a capture the view's position says
      // nothing about the reader: no pages until it is back to normal.
      if (!el || !didInitialRef.current || blockedRef.current || mountAllRef.current) return;
      const s = sourceRef.current;
      if (s.loading) return;
      const edge = edgeLoadPx(el);
      if (s.hasOlder && el.scrollTop < edge) void s.loadOlder();
      else if (
        s.hasNewer
        && distanceFromBottom(el) < edge
        && !(restoredRef.current && !userHasScrolledRef.current)
      ) void s.loadNewer();
    }, [listEl]);

    const updateAtBottom = useCallback((el: HTMLElement) => {
      const next = distanceFromBottom(el) <= AT_BOTTOM_THRESHOLD;
      if (atBottomRef.current !== next) {
        atBottomRef.current = next;
        setAtBottom(next);
        // Outside any state updater: React may run those while rendering.
        onAtBottomChangeRef.current?.(next);
      }
      return next;
    }, []);

    // Gestures mark the following scroll events as the reader's: wheel,
    // touch, a press on the scrollbar itself (not a control inside a row) and
    // scrolling keys pressed on the focused scroller.
    useEffect(() => {
      const el = listEl();
      if (!el) return;
      const mark = (event: Event) => {
        if (event.type === "pointerdown" && event.target !== el) return;
        if (event.type === "keydown") {
          const key = event as KeyboardEvent;
          if (event.target !== el || key.defaultPrevented || key.altKey || key.ctrlKey) return;
          // Cmd+Up / Cmd+Down go to either end (VirtualList's keyboard).
          if (key.metaKey && key.key !== "ArrowUp" && key.key !== "ArrowDown") return;
          if (!SCROLL_NAVIGATION_KEYS.includes(key.key)) return;
        }
        gestureGenerationRef.current += 1;
        lastGestureAtRef.current = performance.now();
        gestureIntentRef.current = true;
      };
      for (const type of GESTURE_EVENTS) el.addEventListener(type, mark, { passive: true });
      return () => {
        for (const type of GESTURE_EVENTS) el.removeEventListener(type, mark);
      };
    }, [listEl]);

    const onScroll = useCallback(() => {
      const el = listEl();
      if (!el) return;
      const bottom = updateAtBottom(el);
      const now = performance.now();
      const byUser = gestureIntentRef.current
        || (lastGestureAtRef.current > 0 && now - lastGestureAtRef.current <= USER_SCROLL_MOMENTUM_WINDOW_MS);
      gestureIntentRef.current = false;
      if (byUser) {
        lastGestureAtRef.current = now;
        userHasScrolledRef.current = true;
        pendingInitialRef.current = null;
        pendingJumpRef.current = null;
        layoutAnchorRef.current = null;
        parentAnchorRef.current = false;
        if (gestureGenerationRef.current > blockGestureGenerationRef.current) blockedRef.current = false;
        followRef.current = bottom;
        if (!bottom) armedFollowRef.current = false;
        const key = persistKeyRef.current;
        if (key) {
          if (bottom) {
            // Back at the live tail by the reader's hand: forget the spot.
            forgetScroll(key);
          } else {
            const top = topVisibleMessage(el);
            if (top) rememberScroll(key, top.id);
          }
        }
        if (bottom) restoredRef.current = false;
      } else if (!bottom && performance.now() > smoothBottomUntilRef.current) {
        // Scrolled off the bottom by something other than a gesture or this
        // timeline (scrollIntoView, find in page, a script): stop following.
        // Rows are measured as they mount, so the content resizes on every
        // scroll, and a follower would be pulled straight back to the bottom.
        followRef.current = false;
        armedFollowRef.current = false;
      }
      scheduleVisibleWindowReport();
      maybeLoadEdges();
      widthAnchor.note();
      notifyVisible();
    }, [listEl, maybeLoadEdges, notifyVisible, scheduleVisibleWindowReport, updateAtBottom, widthAnchor]);

    // Reloading itself onto a new Web release: this spot first.
    useSpotBeforeReload(persistKeyRef, followRef, listEl);

    // The messages emptied (a context window swapped in place): start over.
    useEffect(() => {
      if (messages.length > 0) return;
      didInitialRef.current = false;
      pendingInitialRef.current = null;
      layoutAnchorRef.current = null;
      followRef.current = true;
      userHasScrolledRef.current = false;
      restoredRef.current = false;
      atBottomRef.current = true;
      setAtBottom(true);
      if (lastWindowKeyRef.current) {
        lastWindowKeyRef.current = "";
        onVisibleRef.current?.([]);
      }
    }, [messages.length]);

    // Initial jump, once the first rows are there.
    useLayoutEffect(() => {
      if (didInitialRef.current || messages.length === 0) return;
      didInitialRef.current = true;
      const focus = sourceRef.current.initialFocusMessageId;
      if (!focus && sourceRef.current.initialAtStart && rowsRef.current[0]) {
        // The history paywall a jump to an old message lands on: the top.
        followRef.current = false;
        restoredRef.current = true;
        apiRef.current?.scrollTo({ key: messageTimelineRowKey(rowsRef.current[0]), align: "start", behavior: "instant" });
        return;
      }
      const saved = persistKeyRef.current ? recallScroll(persistKeyRef.current) : undefined;
      // Alignment follows what was saved: a focus (permalink, search) is
      // shown centered; a remembered row is the top of where the reader was.
      const initial = focus
        ? { key: focus, align: "center" as const }
        : saved
          ? { key: saved, align: "start" as const }
          : null;
      const target = initial && hasRowFor(initial.key) ? initial : null;
      // The remembered row can arrive after the replies: a thread's parent
      // comes from its own request. Show the tail meanwhile, and jump to it
      // when it comes, unless the reader has scrolled by then.
      pendingInitialRef.current = initial && !target ? initial : null;
      if (target) {
        followRef.current = false;
        restoredRef.current = true;
        scrollToKey(target.key, target.align);
      } else {
        followRef.current = true;
        scrollToBottom();
      }
    }, [hasRowFor, messages, scrollToBottom, scrollToKey]);

    useLayoutEffect(() => {
      const jump = pendingJumpRef.current;
      if (!jump) return;
      if (performance.now() > jump.until) {
        pendingJumpRef.current = null;
        return;
      }
      if (!hasRowFor(jump.id)) return;
      pendingJumpRef.current = null;
      followRef.current = false;
      armedFollowRef.current = false;
      scrollToKey(jump.id, jump.align, jump.smooth);
    }, [hasRowFor, rows, scrollToKey]);

    useLayoutEffect(() => {
      const pending = pendingInitialRef.current;
      if (!pending || !hasRowFor(pending.key)) return;
      pendingInitialRef.current = null;
      if (userHasScrolledRef.current) return;
      followRef.current = false;
      armedFollowRef.current = false;
      restoredRef.current = true;
      scrollToKey(pending.key, pending.align);
    }, [hasRowFor, rows, scrollToKey]);

    // A jump to a message behind the history window, in a list already
    // mounted: land on the paywall at the top, as on mount. Keyed on the jump,
    // since the window after the target can be the rows already shown.
    const atStartKey = source.atStartKey ?? null;
    const prevAtStartKeyRef = useRef(atStartKey);
    useLayoutEffect(() => {
      if (atStartKey === prevAtStartKeyRef.current) return;
      prevAtStartKeyRef.current = atStartKey;
      const first = rowsRef.current[0];
      if (atStartKey === null || !didInitialRef.current || !first) return;
      followRef.current = false;
      armedFollowRef.current = false;
      restoredRef.current = true;
      apiRef.current?.scrollTo({ key: messageTimelineRowKey(first), align: "start", behavior: "instant" });
    }, [atStartKey]);

    // Appends while following the bottom stay pinned. Prepends need nothing:
    // keepAnchorOnItemsChange keeps the row on screen in place.
    const prevLastIdRef = useRef<string | null>(null);
    const prevFirstIdRef = useRef<string | null>(null);
    useLayoutEffect(() => {
      const firstId = messages[0]?.id ?? null;
      const lastId = messages[messages.length - 1]?.id ?? null;
      const lastChanged = lastId !== prevLastIdRef.current;
      const firstChanged = firstId !== prevFirstIdRef.current;
      prevFirstIdRef.current = firstId;
      prevLastIdRef.current = lastId;
      if (!didInitialRef.current || !lastChanged) return;
      const focus = sourceRef.current.initialFocusMessageId;
      if (firstChanged && focus && messages.some((m) => m.id === focus)) {
        // Context jump (search result, permalink): show the focused message.
        followRef.current = false;
        armedFollowRef.current = false;
        restoredRef.current = true;
        scrollToKey(focus, "center");
        return;
      }
      if ((followRef.current || armedFollowRef.current) && !sourceRef.current.hasNewer) {
        armedFollowRef.current = false;
        scrollToBottom();
      }
    }, [messages, scrollToBottom, scrollToKey]);

    useEffect(() => {
      if (messages.length === 0) return;
      // A short first page never scrolls, and a jump that lands where the
      // view already was fires no scroll event: check the edges and the
      // at-bottom state after each commit.
      const id = requestAnimationFrame(() => {
        const el = listEl();
        if (el) updateAtBottom(el);
        maybeLoadEdges();
        scheduleVisibleWindowReport();
      });
      return () => cancelAnimationFrame(id);
    }, [listEl, messages, maybeLoadEdges, scheduleVisibleWindowReport, updateAtBottom]);

    // Rows growing or shrinking (images, reactions, edits, a reply streaming
    // in, the typing line in the footer) change the content's height: stay on
    // the bottom while following it.
    const onContentResize = useCallback(() => {
      if (followRef.current && !sourceRef.current.hasNewer) scrollToBottom();
      widthAnchor.note();
      notifyVisible();
    }, [notifyVisible, scrollToBottom, widthAnchor]);

    // The scroller resized (a thread opening beside the channel, the window,
    // the soft keyboard): re-pin while following, else put back the anchor
    // taken before an expected width change, exactly. Rows the view's top cuts
    // through reflow too, which the list itself does not compensate.
    const onListResize = useCallback(() => {
      notifyVisible();
      const scroller = listEl();
      const kept = scroller ? widthAnchor.take(scroller, !sourceRef.current.hasNewer) : null;
      // At its end before the width changed (a seam, a fold, a restored row; #189): at its end again, else the message.
      if (kept) {
        followRef.current = kept === "end";
        if (kept !== "end") armedFollowRef.current = false;
        layoutAnchorRef.current = kept === "end" ? null : { ...kept, until: performance.now() + ANCHOR_PRESERVE_LAYOUT_CHANGE_MS };
      }
      if (followRef.current && !sourceRef.current.hasNewer) {
        scrollToBottom();
        return;
      }
      const anchor = layoutAnchorRef.current;
      if (!anchor) return;
      if (performance.now() > anchor.until) {
        layoutAnchorRef.current = null;
        return;
      }
      const adjust = () => {
        const el = listEl();
        const row = el?.querySelector<HTMLElement>(messageRowSelector(anchor.id));
        if (!el || !row) return;
        const delta = row.getBoundingClientRect().top - el.getBoundingClientRect().top - anchor.offset;
        if (Math.abs(delta) > 0.5) el.scrollTop += delta;
        // Kept across a width change and still at the end (the replies fit again): follow it again.
        if (keepTopOnWidthChange && distanceFromBottom(el) <= 1) followRef.current = true;
        widthAnchor.note();
      };
      // A width change has laid the rows out already: put the message back now too (a list with every row mounted
      // runs no adjusting task), and again as the rows are measured.
      if (kept) adjust();
      apiRef.current?.submitScrollAdjustingTask(adjust);
    }, [keepTopOnWidthChange, listEl, notifyVisible, scrollToBottom, widthAnchor]);

    const preserveViewport = useCallback(() => {
      // An in-message expansion is a reading action: stop following so the
      // row grows downward. The list keeps the rows above in place.
      followRef.current = false;
      armedFollowRef.current = false;
    }, []);
    // Collapsing a long message can leave its row wholly outside the view
    // (its top was far above; the rows below move up). When the row's size
    // collapses, bring it back to the nearest edge, exactly; a row still partly
    // in view is left alone.
    const keepMessageVisible = useCallback((messageId: string) => {
      const el = listEl();
      const row = el?.querySelector<HTMLElement>(messageRowSelector(foldedRef.current?.get(messageId) ?? messageId));
      if (!el || !row) return;
      const ro = new ResizeObserver(() => {
        ro.disconnect();
        window.clearTimeout(timeout);
        const view = el.getBoundingClientRect();
        const rect = row.getBoundingClientRect();
        const align = rect.bottom <= view.top ? "start" : rect.top >= view.bottom ? "end" : null;
        if (!align) return;
        followRef.current = false;
        armedFollowRef.current = false;
        apiRef.current?.scrollTo({ key: rowKeyOfMessageId(messageId), align });
      });
      // Called on the click, before the collapse renders: the observer's
      // first report comes after that render's layout, before paint.
      ro.observe(row);
      const timeout = window.setTimeout(() => ro.disconnect(), 1000);
    }, [listEl, rowKeyOfMessageId]);

    useImperativeHandle(ref, (): MessageTimelineHandle => ({
      scrollToTop: () => {
        pendingJumpRef.current = null;
        followRef.current = false;
        armedFollowRef.current = false;
        layoutAnchorRef.current = null;
        dropGestureAttribution();
        // Instant: rows mounting above the view during a smooth scroll have
        // their sizes scrolled away by the list, which writes scrollTop and so
        // stops the smooth scroll short of the top. An instant jump is
        // replayed as rows are measured, so it lands.
        parentAnchorRef.current = false;
        apiRef.current?.scrollTo({ position: "top" });
      },
      scrollToBottom: ({ smooth = false } = {}) => {
        pendingJumpRef.current = null;
        const key = persistKeyRef.current;
        if (key) forgetScroll(key);
        restoredRef.current = false;
        layoutAnchorRef.current = null;
        followRef.current = true;
        armedFollowRef.current = true;
        dropGestureAttribution();
        scrollToBottom(smooth);
      },
      scrollToMessage: (id, { smooth = false, align = "center" } = {}) => {
        if (!hasRowFor(id)) {
          pendingJumpRef.current = { id, align, smooth, until: performance.now() + PENDING_JUMP_MS };
          return;
        }
        pendingJumpRef.current = null;
        followRef.current = false;
        armedFollowRef.current = false;
        layoutAnchorRef.current = null;
        scrollToKey(id, align, smooth);
      },
      isAtBottom: () => atBottom,
      isFollowingBottom: () => followRef.current,
      preserveAnchorOnNextLayoutChange: () => {
        const el = listEl();
        if (!el || distanceFromBottom(el) <= AT_BOTTOM_THRESHOLD) return;
        const top = topVisibleMessage(el);
        if (!top) return;
        followRef.current = false;
        armedFollowRef.current = false;
        layoutAnchorRef.current = { ...top, until: performance.now() + ANCHOR_PRESERVE_LAYOUT_CHANGE_MS };
      },
      armFollowOnNextAppend: () => {
        layoutAnchorRef.current = null;
        armedFollowRef.current = true;
        followRef.current = true;
      },
      getMessages: () => messageTimelineMessages(leadingRowsRef.current, messagesRef.current),
      getVisibleMessageIds: (options) => visibleMessageIdsOfList(apiRef.current, rowsRef.current, options?.bottomOcclusion),
      getMessageViewportPosition: (id, options) => rowViewportPositionOfList(apiRef.current, rowsRef.current, rowKeyOfMessageId(id), options?.bottomOcclusion),
    }), [atBottom, dropGestureAttribution, hasRowFor, listEl, rowKeyOfMessageId, scrollToBottom, scrollToKey]);

    const renderRow = useCallback(
      ({ domRef, item, index, style }: VirtualListItemRenderProps<MessageTimelineRow>) => {
        const key = messageTimelineRowKey(item);
        if (item.kind !== "message") {
          return (
            <LeadingRowFrame key={key} domRef={domRef} style={style} rowKey={key} kind={item.kind}>
              {renderLeadingRow?.(item)}
            </LeadingRowFrame>
          );
        }
        const messageIndex = messageIndexById.get(item.message.id) ?? (index ?? leadingCount) - leadingCount;
        return (
          <div
            key={key}
            ref={domRef ?? undefined}
            style={style}
            data-timeline-row-key={key}
            data-index={messageIndex}
            data-message-id={item.message.id}
            data-timeline-message-id={item.message.id}
          >
            <MessageTimelineRowMessageIdContext.Provider value={item.message.id}>
              {renderItem(item.message, messageIndex)}
            </MessageTimelineRowMessageIdContext.Provider>
          </div>
        );
      },
      [leadingCount, messageIndexById, renderItem, renderLeadingRow],
    );
    // A function footer: the list observes its element, so the typing line
    // growing under the last message keeps a follower at the bottom.
    const listFooter = useCallback(
      ({ domRef }: { domRef: VirtualListMeasuredRef }) => (footer ? <div ref={domRef} className="shrink-0">{footer}</div> : null),
      [footer],
    );

    const { containerProps: scrollAreaContainer, guttersProps: scrollAreaGutters } =
      useScrollAreaContainer<HTMLDivElement>(TIMELINE_SCROLL_AREA);
    const scrollerStyle = useMemo(() => ({ ...SCROLLER_STYLE, ...scrollAreaContainer.style }), [scrollAreaContainer.style]);
    // Touch: drag the list left to see every message's time.
    const timeRevealRef = useTimelineTimeReveal();

    return (
      <div ref={timeRevealRef} className={`relative ${className ?? "flex-1 min-h-0"}`} data-virtual-timeline="">
        <InlineAudioKeepAliveContext.Provider value={audioKeepAlive}>
          <MessageTimelineKeepMessageVisibleContext.Provider value={keepMessageVisible}>
            <MessageTimelinePreserveViewportContext.Provider value={preserveViewport}>
              <VirtualList<MessageTimelineRow>
                componentRef={apiRef}
                // The scroll area's container (this wrapper reads it through apiRef).
                domRef={scrollAreaContainer.ref}
                header={<ScrollAreaGutters {...scrollAreaGutters} />}
                data-testid={testId}
                // The scroller is focusable (keyboard paging): name it for
                // screen readers. aria-live off: rows mounting as the reader
                // scrolls are not new messages and must not be announced.
                role="log"
                aria-label={formatMessage({ id: "message.timeline.ariaLabel" })}
                aria-live="off"
                virtual={!mountAll}
                // Only the rows near the view are in the DOM: how many messages
                // are loaded, for browser tests and debugging.
                data-loaded-message-count={messages.length}
                items={rows}
                getKey={messageTimelineRowKey}
                itemEstimatedSize={ESTIMATED_ROW_PX}
                itemMinSize={MIN_ROW_PX}
                itemResizable
                keepAnchorOnItemsChange
                canAnchorItem={canAnchorRow}
                footer={listFooter}
                onScroll={onScroll}
                onResize={onListResize}
                onContentResize={onContentResize}
                // Flex column so a short channel can rest on the input bar
                // (sparseAnchor="bottom": the rows' margin-top is auto).
                className={`${scrollAreaContainer.className} flex flex-col`}
                style={scrollerStyle}
                itemsClassName={sparseAnchor === "bottom" ? "mt-auto shrink-0" : "shrink-0"}
              >
                {renderRow}
              </VirtualList>
            </MessageTimelinePreserveViewportContext.Provider>
          </MessageTimelineKeepMessageVisibleContext.Provider>
        </InlineAudioKeepAliveContext.Provider>
      </div>
    );
  },
);

// A leading row's wrapper: the list's measured element. A size change while
// it is above the view (the boundary's "Loading older", the parent's
// reactions) is scrolled away by the list, like any row's.
function LeadingRowFrame({
  domRef,
  style,
  rowKey,
  kind,
  children,
}: {
  domRef: VirtualListMeasuredRef | null;
  style: CSSProperties | undefined;
  rowKey: string;
  kind: MessageTimelineLeadingRow["kind"];
  children: ReactNode;
}) {
  return (
    <div
      ref={domRef ?? undefined}
      style={style}
      data-timeline-row-key={rowKey}
      data-timeline-row-kind={kind}
    >
      {children}
    </div>
  );
}

export default VirtualMessageTimeline;
