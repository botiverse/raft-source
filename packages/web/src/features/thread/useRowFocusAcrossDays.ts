import { useEffect, useLayoutEffect, useRef } from "react";
import type { RefObject } from "react";
import type { ActivityDayGroup } from "./activityDayGroups";
import { itemKey } from "./inboxRowShared";
import { rowTrigger } from "./threadsInboxHelpers";

const ROW_SELECTOR = "[data-inbox-key]";

function rowKeyOf(element: Element | null): string | null {
  return element?.closest<HTMLElement>(ROW_SELECTOR)?.dataset.inboxKey ?? null;
}

/**
 * A row that moves to another day moves to another group, so React mounts it
 * anew and the focus inside it falls to the page: the row's next arrow key does
 * nothing. Focus goes back to the row's trigger, only when it fell there: focus
 * is on the page and the row it was in is still listed.
 *
 * The key is tracked from focusin, since by the commit the old element has gone.
 * focusout can't clear it at once: a browser may fire it for the removal itself,
 * in the middle of the commit. So it looks again in a microtask, which runs after
 * the commit's effects if the removal fired it, and straight away if the person
 * moved focus (a click on the page, a menu, a dialog): then the key is cleared and
 * nothing is taken back. A browser that fires nothing for a removal keeps the key,
 * which the row leaving the list clears.
 */
export function useRowFocusAcrossDays(scrollRef: RefObject<HTMLElement | null>, dayGroups: readonly ActivityDayGroup[]) {
  const focusedRowKeyRef = useRef<string | null>(null);

  useEffect(() => {
    const scroller = scrollRef.current;
    if (!scroller) return;
    const onFocusIn = (event: FocusEvent) => {
      focusedRowKeyRef.current = rowKeyOf(event.target instanceof Element ? event.target : null);
    };
    const onFocusOut = () => {
      queueMicrotask(() => {
        if (rowKeyOf(document.activeElement) !== focusedRowKeyRef.current) focusedRowKeyRef.current = null;
      });
    };
    scroller.addEventListener("focusin", onFocusIn);
    scroller.addEventListener("focusout", onFocusOut);
    return () => {
      scroller.removeEventListener("focusin", onFocusIn);
      scroller.removeEventListener("focusout", onFocusOut);
    };
  }, [scrollRef]);

  useLayoutEffect(() => {
    const key = focusedRowKeyRef.current;
    if (key === null) return;
    if (!dayGroups.some((group) => group.rows.some((item) => itemKey(item) === key))) {
      focusedRowKeyRef.current = null;
      return;
    }
    const scroller = scrollRef.current;
    if (!scroller || (document.activeElement !== null && document.activeElement !== document.body)) return;
    // Where the person was reading stays: the row may have moved far up the list.
    rowTrigger(scroller, key)?.focus({ preventScroll: true });
  }, [dayGroups, scrollRef]);
}
