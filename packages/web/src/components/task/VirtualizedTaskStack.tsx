import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useId,
  useLayoutEffect,
  useRef,
  useState,
} from "react";
import type {
  ComponentPropsWithoutRef,
  Key,
  KeyboardEvent as ReactKeyboardEvent,
  ReactNode,
  RefObject,
} from "react";
import { useVirtualizer } from "@tanstack/react-virtual";

const DEFAULT_VIEWPORT_HEIGHT = 720;
const FOCUSABLE_SELECTOR = [
  "button:not([disabled])",
  "a[href]",
  "input:not([disabled])",
  "select:not([disabled])",
  "textarea:not([disabled])",
  '[tabindex]:not([tabindex="-1"])',
].join(",");

type TaskScrollAnchor = { key: string; stackId: string; top: number; index: number };
type TaskStackAnchorPosition = { index: number; estimatedStep: number };
type TaskStackAnchorResolver = (key: string) => TaskStackAnchorPosition | null;
type RegisterTaskStack = (id: string, resolver: TaskStackAnchorResolver) => () => void;

const TaskVirtualLayoutContext = createContext<RegisterTaskStack | null>(null);

function captureVisibleTaskAnchors(
  rootElement: HTMLElement | null,
  scrollElement: HTMLElement | null,
  stackResolvers: Map<string, TaskStackAnchorResolver>,
): TaskScrollAnchor[] {
  if (!rootElement || !scrollElement) return [];
  const viewport = scrollElement.getBoundingClientRect();
  return Array.from(rootElement.querySelectorAll<HTMLElement>("[data-task-virtual-key]"))
    .map((row) => ({
      key: row.dataset.taskVirtualKey ?? "",
      stackId: row.dataset.taskVirtualStackId ?? "",
      index: Number(row.dataset.index),
      rect: row.getBoundingClientRect(),
    }))
    .filter(({ key, stackId, index, rect }) => (
      key.length > 0
      && stackResolvers.has(stackId)
      && Number.isFinite(index)
      && rect.bottom > viewport.top
      && rect.top < viewport.bottom
      && rect.right > viewport.left
      && rect.left < viewport.right
    ))
    .sort((a, b) => a.rect.top - b.rect.top || a.rect.left - b.rect.left)
    .map(({ key, stackId, rect, index }) => ({ key, stackId, top: rect.top, index }));
}

/**
 * One scroll-anchor coordinator for every virtual stack that shares the Tasks
 * scroller. A per-stack anchor is incorrect for Board: moving one task between
 * columns lets both source and target write competing scrollTop adjustments.
 * This wrapper captures the first visible surviving keyed row across the whole
 * layout and applies at most one compensation after a collection/layout change.
 */
export function TaskVirtualLayout({
  scrollElementRef,
  children,
  ...props
}: {
  scrollElementRef: RefObject<HTMLDivElement | null>;
} & ComponentPropsWithoutRef<"div">) {
  const rootRef = useRef<HTMLDivElement>(null);
  const anchorsRef = useRef<TaskScrollAnchor[]>([]);
  const stackResolversRef = useRef(new Map<string, TaskStackAnchorResolver>());
  const restoringRef = useRef(false);
  const restoreAttemptsRef = useRef(0);
  const restoreFrameRef = useRef(0);
  const restoreAndCaptureRef = useRef<() => void>(() => {});

  const registerStack = useCallback<RegisterTaskStack>((id, resolver) => {
    stackResolversRef.current.set(id, resolver);
    return () => {
      if (stackResolversRef.current.get(id) === resolver) stackResolversRef.current.delete(id);
    };
  }, []);

  const restoreAndCapture = useCallback(() => {
    const rootElement = rootRef.current;
    const scrollElement = scrollElementRef.current;
    if (!rootElement || !scrollElement) return;

    let adjusted = false;
    if (anchorsRef.current.length > 0) {
      const rowsByKey = new Map(
        Array.from(rootElement.querySelectorAll<HTMLElement>("[data-task-virtual-key]"))
          .map((row) => [row.dataset.taskVirtualKey ?? "", row] as const),
      );
      for (const anchor of anchorsRef.current) {
        const survivingRow = rowsByKey.get(anchor.key);
        const survivingInOriginalStack = survivingRow?.dataset.taskVirtualStackId === anchor.stackId;
        const resolvedPosition = stackResolversRef.current.get(anchor.stackId)?.(anchor.key) ?? null;
        let delta: number | null = survivingInOriginalStack
          ? survivingRow.getBoundingClientRect().top - anchor.top
          : null;
        if (survivingInOriginalStack && resolvedPosition) {
          // A scroll compensation can move the keyed row outside overscan
          // before the settle RAF. Keep its logical index current while the
          // DOM rect is available so a later fallback does not replay the
          // already-consumed collection shift.
          anchor.index = resolvedPosition.index;
        }
        if (!survivingInOriginalStack && !resolvedPosition) {
          // The keyed task left this stack (for example, a status move). It is
          // no longer a valid anchor candidate for the original collection;
          // keeping it through a transient empty-window settle would let a
          // rapid move back mask the surviving source row whose index shifted.
          anchorsRef.current = anchorsRef.current.filter((candidate) => candidate !== anchor);
          continue;
        }
        if (delta == null) {
          const next = resolvedPosition;
          if (next) {
            delta = (next.index - anchor.index) * next.estimatedStep;
            // The fallback is an estimate for an anchor that is currently
            // outside overscan. Consume the index shift once; the next settle
            // pass must use its real DOM rect (if mounted), not apply the same
            // estimated batch delta again.
            anchor.index = next.index;
          }
        }
        if (delta != null) {
          if (Math.abs(delta) >= 0.5) {
            scrollElement.scrollTop += delta;
            adjusted = true;
          }
          break;
        }
      }
    }

    if (adjusted && restoreAttemptsRef.current < 5) {
      restoringRef.current = true;
      restoreAttemptsRef.current += 1;
      cancelAnimationFrame(restoreFrameRef.current);
      restoreFrameRef.current = requestAnimationFrame(() => restoreAndCaptureRef.current());
      return;
    }

    const capturedAnchors = captureVisibleTaskAnchors(
      rootElement,
      scrollElement,
      stackResolversRef.current,
    );
    // Virtualizer measurement can transiently leave no row intersecting the
    // viewport between collection commits. Do not erase the last meaningful
    // keyed anchor during that gap; a real user/programmatic scroll clears it
    // in captureAfterScroll before taking a new viewport snapshot.
    if (capturedAnchors.length > 0) anchorsRef.current = capturedAnchors;
    if (restoringRef.current) {
      // Chromium may dispatch the scroll event from our final scrollTop write
      // after this settle callback returns. Keep the coordinator-owned window
      // alive for one more frame so that delayed event cannot clear the freshly
      // captured anchors as if it were an external scroll.
      cancelAnimationFrame(restoreFrameRef.current);
      restoreFrameRef.current = requestAnimationFrame(() => {
        restoringRef.current = false;
        restoreAttemptsRef.current = 0;
        const settledAnchors = captureVisibleTaskAnchors(
          rootRef.current,
          scrollElementRef.current,
          stackResolversRef.current,
        );
        if (settledAnchors.length > 0) anchorsRef.current = settledAnchors;
      });
      return;
    }
    restoreAttemptsRef.current = 0;
  }, [scrollElementRef]);
  restoreAndCaptureRef.current = restoreAndCapture;

  useLayoutEffect(restoreAndCapture);

  useEffect(() => {
    const rootElement = rootRef.current;
    const scrollElement = scrollElementRef.current;
    if (!rootElement || !scrollElement) return;
    let frame = 0;
    const captureAfterScroll = () => {
      if (restoringRef.current) return;
      // Do not let a ResizeObserver callback restore an anchor captured before
      // an intentional user/programmatic scroll. Re-capture after the scroll
      // event's render/measurement work settles on the next frame.
      anchorsRef.current = [];
      cancelAnimationFrame(frame);
      frame = requestAnimationFrame(() => {
        anchorsRef.current = captureVisibleTaskAnchors(
          rootElement,
          scrollElement,
          stackResolversRef.current,
        );
      });
    };
    const cancelRestoreForUserInput = () => {
      restoringRef.current = false;
      restoreAttemptsRef.current = 0;
      anchorsRef.current = [];
      cancelAnimationFrame(restoreFrameRef.current);
    };
    const observer = new ResizeObserver(restoreAndCapture);
    observer.observe(rootElement);
    scrollElement.addEventListener("scroll", captureAfterScroll, { passive: true });
    scrollElement.addEventListener("wheel", cancelRestoreForUserInput, { passive: true });
    scrollElement.addEventListener("touchstart", cancelRestoreForUserInput, { passive: true });
    scrollElement.addEventListener("pointerdown", cancelRestoreForUserInput, { passive: true });
    return () => {
      cancelAnimationFrame(frame);
      cancelAnimationFrame(restoreFrameRef.current);
      observer.disconnect();
      scrollElement.removeEventListener("scroll", captureAfterScroll);
      scrollElement.removeEventListener("wheel", cancelRestoreForUserInput);
      scrollElement.removeEventListener("touchstart", cancelRestoreForUserInput);
      scrollElement.removeEventListener("pointerdown", cancelRestoreForUserInput);
    };
  }, [restoreAndCapture, scrollElementRef]);

  return (
    <TaskVirtualLayoutContext.Provider value={registerStack}>
      <div ref={rootRef} data-task-virtual-layout-root {...props}>
        {children}
      </div>
    </TaskVirtualLayoutContext.Provider>
  );
}

function measureScrollMargin(
  scrollElement: HTMLElement | null,
  listElement: HTMLElement | null,
): number {
  if (!scrollElement || !listElement) return 0;
  const scrollRect = scrollElement.getBoundingClientRect();
  const listRect = listElement.getBoundingClientRect();
  return listRect.top - scrollRect.top + scrollElement.scrollTop;
}

/**
 * A variable-height virtual stack inside TasksPanel's shared scroll element.
 *
 * Board columns and list sections cannot own independent scroll containers:
 * doing so would change the Tasks interaction model and make every column
 * scroll separately. `scrollMargin` tells the virtualizer where this stack
 * starts inside the shared scroller, while measured rows replace the estimate
 * as soon as they mount.
 */
export default function VirtualizedTaskStack<T>({
  items,
  scrollElementRef,
  estimateSize,
  gap,
  getItemKey,
  renderItem,
}: {
  items: T[];
  scrollElementRef: RefObject<HTMLDivElement | null>;
  estimateSize: number;
  gap: number;
  getItemKey: (item: T) => Key;
  renderItem: (item: T) => ReactNode;
}) {
  const listRef = useRef<HTMLDivElement>(null);
  const [scrollMargin, setScrollMargin] = useState(0);
  const registerStack = useContext(TaskVirtualLayoutContext);
  const stackId = useId();
  const anchorItemsRef = useRef(items);
  const anchorGetItemKeyRef = useRef(getItemKey);
  const anchorEstimateSizeRef = useRef(estimateSize);
  const anchorGapRef = useRef(gap);
  anchorItemsRef.current = items;
  anchorGetItemKeyRef.current = getItemKey;
  anchorEstimateSizeRef.current = estimateSize;
  anchorGapRef.current = gap;

  useLayoutEffect(() => {
    const listElement = listRef.current;
    if (!listElement) return;
    const scrollElement = scrollElementRef.current
      ?? listElement.closest<HTMLElement>("[data-task-virtual-scroll]");
    if (!scrollElement) return;
    // ResizeObserver does not fire when this stack is merely pushed by a
    // preceding sibling. Observe the nearest shared Tasks layout root so a
    // preceding section's measured/collapsed extent invalidates our margin.
    const layoutElement = listElement.closest<HTMLElement>("[data-task-virtual-layout-root]");

    const updateMargin = () => {
      const next = measureScrollMargin(scrollElement, listElement);
      setScrollMargin((current) => (Math.abs(current - next) < 0.5 ? current : next));
    };

    updateMargin();
    const observer = new ResizeObserver(updateMargin);
    observer.observe(scrollElement);
    // The stack's own height changes as estimates become measurements. Its
    // top can also move when an earlier list section is measured/collapsed.
    observer.observe(listElement);
    if (layoutElement && layoutElement !== listElement && layoutElement !== scrollElement) {
      observer.observe(layoutElement);
    }
    window.addEventListener("resize", updateMargin);
    return () => {
      observer.disconnect();
      window.removeEventListener("resize", updateMargin);
    };
  }, [items.length, scrollElementRef]);

  const virtualizer = useVirtualizer({
    count: items.length,
    getScrollElement: () => scrollElementRef.current
      ?? listRef.current?.closest<HTMLElement>("[data-task-virtual-scroll]")
      ?? null,
    estimateSize: () => estimateSize,
    getItemKey: (index) => getItemKey(items[index]!),
    gap,
    overscan: 6,
    scrollMargin,
    // Keeps the first commit bounded even before the ref-backed scroller has
    // been observed. The real element rect replaces this immediately.
    initialRect: { width: 320, height: DEFAULT_VIEWPORT_HEIGHT },
  });

  const resolveAnchorStart = useCallback((key: string) => {
    const index = anchorItemsRef.current.findIndex(
      (item) => String(anchorGetItemKeyRef.current(item)) === key,
    );
    if (index < 0) return null;
    return { index, estimatedStep: anchorEstimateSizeRef.current + anchorGapRef.current };
  }, []);

  useLayoutEffect(
    () => registerStack?.(stackId, resolveAnchorStart),
    [registerStack, resolveAnchorStart, stackId],
  );

  const handleTabKeyDown = (event: ReactKeyboardEvent<HTMLDivElement>) => {
    if (event.key !== "Tab" || event.defaultPrevented) return;
    const mounted = virtualizer.getVirtualItems();
    const first = mounted[0];
    const last = mounted[mounted.length - 1];
    if (!first || !last) return;

    const rows = Array.from(
      listRef.current?.querySelectorAll<HTMLElement>("[data-task-virtual-row-index]") ?? [],
    );
    const edgeRow = event.shiftKey ? rows[0] : rows[rows.length - 1];
    if (!edgeRow) return;
    const focusable = Array.from(edgeRow.querySelectorAll<HTMLElement>(FOCUSABLE_SELECTOR));
    const edgeControl = event.shiftKey ? focusable[0] : focusable[focusable.length - 1];
    if (event.target !== edgeControl) return;

    const targetIndex = event.shiftKey ? first.index - 1 : last.index + 1;
    if (targetIndex < 0 || targetIndex >= items.length) return;
    event.preventDefault();
    virtualizer.scrollToIndex(targetIndex, { align: event.shiftKey ? "end" : "start" });
    requestAnimationFrame(() => {
      requestAnimationFrame(() => {
        const targetRow = listRef.current?.querySelector<HTMLElement>(
          `[data-task-virtual-row-index="${targetIndex}"]`,
        );
        const controls = Array.from(targetRow?.querySelectorAll<HTMLElement>(FOCUSABLE_SELECTOR) ?? []);
        (event.shiftKey ? controls[controls.length - 1] : controls[0])?.focus();
      });
    });
  };

  return (
    <div
      ref={listRef}
      onKeyDownCapture={handleTabKeyDown}
      data-testid="task-virtual-window"
      data-total-count={items.length}
      data-scroll-margin={scrollMargin}
      style={{ height: virtualizer.getTotalSize(), position: "relative", width: "100%" }}
    >
      {virtualizer.getVirtualItems().map((virtualItem) => {
        const item = items[virtualItem.index]!;
        return (
          <div
            key={virtualItem.key}
            ref={virtualizer.measureElement}
            data-index={virtualItem.index}
            data-task-virtual-row-index={virtualItem.index}
            data-task-virtual-key={String(virtualItem.key)}
            data-task-virtual-stack-id={stackId}
            data-testid="task-virtual-row"
            style={{
              left: 0,
              position: "absolute",
              top: 0,
              transform: `translateY(${virtualItem.start - scrollMargin}px)`,
              width: "100%",
            }}
          >
            {renderItem(item)}
          </div>
        );
      })}
    </div>
  );
}
