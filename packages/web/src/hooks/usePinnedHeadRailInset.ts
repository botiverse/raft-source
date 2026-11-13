import { useLayoutEffect, useMemo, useState } from "react";
import type { RefObject } from "react";
import type { ScrollAreaRailInset } from "@botiverse/raft-ui";

/**
 * A raft-ui ScrollArea's `railInset` for a header pinned inside it
 * (`position: sticky; top: 0`): its measured height, so the vertical
 * scrollbar starts below it. Its height can change (the filter row wraps on a
 * narrow panel), so it is observed. `undefined` while off or not measured.
 */
export function usePinnedHeadRailInset(
  headRef: RefObject<HTMLElement | null>,
  enabled: boolean,
): ScrollAreaRailInset | undefined {
  const [height, setHeight] = useState(0);
  useLayoutEffect(() => {
    const head = headRef.current;
    if (!enabled || !head) {
      setHeight(0);
      return;
    }
    const read = () => setHeight(Math.round(head.getBoundingClientRect().height));
    read();
    if (typeof ResizeObserver === "undefined") return;
    const observer = new ResizeObserver(read);
    observer.observe(head);
    return () => observer.disconnect();
  }, [enabled, headRef]);
  return useMemo(() => (enabled && height > 0 ? { top: height } : undefined), [enabled, height]);
}
