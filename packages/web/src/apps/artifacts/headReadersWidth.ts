import { useLayoutEffect, useState } from "react";
import { resizeObserverOf } from "../../utils/ownerDocument";

/** The meta line's readers (ArtifactPresence's button). */
const READERS = "[data-artifact-meta-row] [data-testid='artifact-presence']";
/** The two 8px gaps before them: the title's to the meta line, the meta text's to the readers (the text may give way to nothing; its gap stays). */
const GAPS = 16;
/** The version tag beside the title (a badge or, with more than one version, its button): it never shrinks either. */
const VERSION = "[data-testid='artifact-version-badge']";
/** The heading's gap between the title and the version tag. */
const VERSION_GAP = 8;

/**
 * #proj-workspace:#286: what the readers in an Artifact head's meta line need
 * beside the title, and the version tag beside it (#283), for its fold
 * (headFit's `content`). They never shrink, so
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
      // The version tag is on the title's own line whatever the layout (#proj-workspace:#283: unmeasured, the title
      // in a narrow side column kept only its 56px minimum, "qa-…").
      const version = head.querySelector<HTMLElement>(VERSION);
      // Its layout width (offsetWidth: a tag isn't transformed, and 0 where nothing is laid out).
      const tag = version ? version.offsetWidth : 0;
      const versionWidth = tag > 0 ? tag + VERSION_GAP : 0;
      setWidth((beside ? Math.ceil(readers.getBoundingClientRect().width) + GAPS : 0) + versionWidth);
      if (readers === observed) return;
      if (observed) resize?.unobserve(observed);
      if (readers) resize?.observe(readers);
      observed = readers;
    };
    // The head's own window's observer (an object window's, #337 PR3).
    const Observer = resizeObserverOf(head);
    const resize = Observer ? new Observer(measure) : null;
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
