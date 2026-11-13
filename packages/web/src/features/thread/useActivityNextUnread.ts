import { useCallback, useRef } from "react";
import type { Dispatch, RefObject, SetStateAction } from "react";
import { useInboxStore } from "../../store/inboxStore";
import type { InboxItem } from "../../store/inboxStore";
import { useTabRootScroll } from "../../hooks/useTabRootScroll";
import { hasUnloadedUnread, nextActivityRetapTarget } from "../../components/thread/activityRetap";
import type { ActivityRetapAnchor } from "../../components/thread/activityRetap";
import { itemKey, itemUnreadCount } from "./inboxRowShared";
import { RETAP_MAX_PAGE_LOADS, nextFrame, rowLandingOffset } from "./threadsInboxHelpers";

type InboxState = ReturnType<typeof useInboxStore.getState>;

/**
 * Getting to the next unread Activity row: a double click on the desktop
 * title focuses it (`handleHeaderTitleClick`); a phone's second tap on
 * Activity scrolls it to the top of the list (`goToNextUnread`).
 */
export function useActivityNextUnread({
  activeFocusKey,
  isPhoneTabRoot,
  retapAnchorRef,
  scrollRef,
  setFocusedItemKey,
  setRetapTarget,
  visibleItems,
}: {
  activeFocusKey: string | null;
  isPhoneTabRoot: boolean;
  retapAnchorRef: RefObject<ActivityRetapAnchor | null>;
  scrollRef: RefObject<HTMLDivElement | null>;
  setFocusedItemKey: InboxState["setFocusedItemKey"];
  setRetapTarget: Dispatch<SetStateAction<{ key: string; nonce: number } | null>>;
  visibleItems: InboxItem[];
}) {
  const focusNextUnread = useCallback(() => {
    const unreadItems = visibleItems.filter((item) => item.unreadCount > 0);
    if (unreadItems.length === 0) return;
    const currentIdx = activeFocusKey
      ? unreadItems.findIndex((item) => itemKey(item) === activeFocusKey)
      : -1;
    const next = unreadItems[(currentIdx + 1) % unreadItems.length];
    setFocusedItemKey(itemKey(next));
  }, [activeFocusKey, setFocusedItemKey, visibleItems]);

  const handleHeaderTitleClick = useCallback((event: React.MouseEvent) => {
    if (event.detail < 2) return;
    focusNextUnread();
  }, [focusNextUnread]);

  // A phone's second tap on Activity (its tab, or its title bar; artin
  // 2026-10-21, Raft DS › Navigation › Going back): the next unread row below
  // the current position goes to the top of the list and is located (its 2s
  // highlight); after
  // the last one the list goes back to the top. The rows on screen are the
  // current filter's; nothing is marked read. See activityRetap.ts.
  const retapLoadingRef = useRef(false);
  const goToNextUnread = useCallback(() => {
    // Reads the store and the DOM afresh, so a step after loading a page
    // sees the rows that page added.
    const step = (pageLoadsLeft: number) => {
      const container = scrollRef.current;
      if (!container) return;
      const inbox = useInboxStore.getState();
      const unreadItems = inbox.items.filter((item) => itemUnreadCount(item) > 0);
      const unreadKeys = new Set(unreadItems.map(itemKey));
      const containerTop = container.getBoundingClientRect().top;
      const landing = rowLandingOffset(container);
      const from = container.scrollTop;
      const now = Date.now();
      const rows = Array.from(container.querySelectorAll<HTMLElement>("[data-inbox-key]"), (el) => {
        const key = el.dataset.inboxKey ?? "";
        return { key, top: from + el.getBoundingClientRect().top - containerTop - landing, unread: unreadKeys.has(key) };
      });
      const target = nextActivityRetapTarget({
        rows,
        scrollTop: from,
        maxScrollTop: container.scrollHeight - container.clientHeight,
        anchor: retapAnchorRef.current,
        now,
      });
      if (target.kind === "top") {
        // The list loads a page at a time: past the last loaded unread row,
        // load the next page and look again before going to the top.
        const loadedUnreadCount = unreadItems.reduce((sum, item) => sum + itemUnreadCount(item), 0);
        if (pageLoadsLeft > 0 && !inbox.loadingMore
          && hasUnloadedUnread({ loadedUnreadCount, totalUnreadCount: inbox.totalUnreadCount, hasMore: inbox.hasMore })) {
          retapLoadingRef.current = true;
          void inbox.loadInbox()
            .catch(() => {})
            .then(nextFrame)
            .then(() => {
              retapLoadingRef.current = false;
              step(pageLoadsLeft - 1);
            });
          return;
        }
        // A tap during the trip to the top starts again from the first row.
        retapAnchorRef.current = { key: null, to: 0, at: now };
        setRetapTarget(null);
        if (from > 0) container.scrollTo({ top: 0, behavior: "smooth" });
        return;
      }
      retapAnchorRef.current = { key: target.key, to: target.top, at: now };
      container.scrollTo({ top: target.top, behavior: "smooth" });
      // A new nonce each time, so the same row again restarts its highlight.
      setRetapTarget((prev) => ({ key: target.key, nonce: (prev?.nonce ?? 0) + 1 }));
    };
    // A tap while a page loads for the previous one waits for it.
    if (retapLoadingRef.current) return;
    step(RETAP_MAX_PAGE_LOADS);
  }, [retapAnchorRef, scrollRef, setRetapTarget]);
  useTabRootScroll(isPhoneTabRoot ? "activity" : null, scrollRef, { rememberScroll: false, onRetap: goToNextUnread });

  return { goToNextUnread, handleHeaderTitleClick };
}
