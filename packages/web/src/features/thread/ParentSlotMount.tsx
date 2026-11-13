import { useLayoutEffect, useRef } from "react";

/**
 * Places the panel's single `parentSlot` host node at this point in the DOM.
 * The loading view, the empty view and the reply timeline each show the slot
 * in a different place; moving one DOM node between them (instead of rendering
 * `parentSlot` three times) keeps the slot's React subtree mounted, so an open
 * menu in the task header survives replies finishing loading (task #28).
 */
export function ParentSlotMount({ host }: { host: HTMLDivElement }) {
  const ref = useRef<HTMLDivElement>(null);
  useLayoutEffect(() => {
    const mount = ref.current;
    if (!mount) return;
    mount.appendChild(host);
    return () => {
      if (host.parentNode === mount) mount.removeChild(host);
    };
  }, [host]);
  return <div ref={ref} className="contents" />;
}
