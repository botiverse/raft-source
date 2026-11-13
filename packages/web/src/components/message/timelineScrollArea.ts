/**
 * raft-ui ScrollArea's overlay scrollbar over the list's own scroller: the
 * list is the container of `useScrollAreaContainer`, and the sticky gutters
 * are the scroller's first child, through the list's `header` (a zero-height
 * layer, so the rows are where they are without it). Shown only while the
 * timeline scrolls, as raft-ui's MessageList. It only reads the scroller;
 * anchoring, jumps, paging and onScroll stay the list's and this wrapper's,
 * and the list keeps its own overscroll-behavior (overscroll="auto").
 */
export const TIMELINE_SCROLL_AREA = { overscroll: "auto", trigger: "scroll" } as const;
