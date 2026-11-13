import { useLayoutEffect, useState } from "react";

/** The meta line's readers (ArtifactPresence's button). */
const READERS = "[data-artifact-meta-row] [data-testid='artifact-presence']";
/** The two 8px gaps before them: the title's to the meta line, the meta text's to the readers (the text may give way to nothing; its gap stays). */
const GAPS = 16;

/**
 * #proj-workspace:#286: what the readers in an Artifact head's meta line need
 * beside the title, for its fold (headFit's `content`). They never shrink, so
 * a head that didn't count them gave them the room the title's minimum had,
 * and in a narrow column the title went to nothing. 0 where the meta line sits
 * under the title (a phone's column: the head's content is a column) and where
 * no one else is here. Measured again as the readers appear, change or go.
 */
export function useHeadReadersWidth(head: HTMLElement | null): number {
  const [width, setWidth] = useState(0);
  useLayoutEffect(() => {
    if (!head) return;
    let observed: Element | null = null;
    const measure = () => {
      const readers = head.querySelector<HTMLElement>(READERS);
      const content = readers?.closest<HTMLElement>("[data-slot='panel-header-content']");
      const style = content ? getComputedStyle(content) : null;
      const beside = !!readers && style?.display === "flex" && style.flexDirection === "row";
      setWidth(beside ? Math.ceil(readers.getBoundingClientRect().width) + GAPS : 0);
      if (readers === observed) return;
      if (observed) resize?.unobserve(observed);
      if (readers) resize?.observe(readers);
      observed = readers;
    };
    const resize = typeof ResizeObserver !== "undefined" ? new ResizeObserver(measure) : null;
    const added = typeof MutationObserver !== "undefined" ? new MutationObserver(measure) : null;
    added?.observe(head, { childList: true, subtree: true });
    measure();
    return () => {
      resize?.disconnect();
      added?.disconnect();
    };
  }, [head]);
  return width;
}
