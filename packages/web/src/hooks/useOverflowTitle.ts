import { useCallback, useRef } from "react";
import type { RefCallback } from "react";

/**
 * Gives a truncated element its whole text as its `title` only while the text
 * is cut off, and removes it again once the text fits: a value shown in full
 * needs no tooltip repeating it (raft-ui forms.md, "Long values in fields").
 * Same check as raft-ui's internal `useOverflowTitle`; raft-ui does not
 * export it.
 *
 * Put the returned ref on the element that carries `truncate`. The ref is
 * stable, so the observers are built once per mounted element.
 *
 * `parts`, a selector, is for a line whose pieces truncate each on their
 * own (an Activity row's text, then what else is new, then where it lives):
 * the element itself gets the title, the whole line, its pieces' texts joined
 * by a space, while any of them is cut off.
 */
export function useOverflowTitle<T extends HTMLElement>(parts?: string): RefCallback<T> {
  const cleanup = useRef<(() => void) | undefined>(undefined);

  return useCallback((node: T | null) => {
    cleanup.current?.();
    cleanup.current = undefined;
    const view = node?.ownerDocument.defaultView;
    if (!node || !view || !("ResizeObserver" in view)) return;

    const pieces = () => (parts === undefined ? [node] : Array.from(node.querySelectorAll<HTMLElement>(parts)));
    const update = () => {
      const measured = pieces();
      const text = measured.map((piece) => piece.textContent?.trim() ?? "").filter(Boolean).join(" ");
      if (text && measured.some((piece) => piece.scrollWidth > piece.clientWidth + 1)) node.title = text;
      else node.removeAttribute("title");
    };
    // Measured from the observers, which report once layout is done; a text
    // change (another sender picked) can leave the capped width unchanged, so
    // the mutation observer catches it.
    const resize = new view.ResizeObserver(update);
    resize.observe(node);
    for (const piece of pieces()) if (piece !== node) resize.observe(piece);
    const mutation = new view.MutationObserver(update);
    mutation.observe(node, { childList: true, characterData: true, subtree: true });
    cleanup.current = () => {
      resize.disconnect();
      mutation.disconnect();
    };
  }, [parts]);
}
