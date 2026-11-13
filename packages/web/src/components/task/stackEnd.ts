import { useLayoutEffect, useMemo } from "react";
import { create } from "zustand";

import type { SideSectionHead } from "./sideSectionDrag";

/**
 * The sections standing last in their column with their heads alone, folded by an expansion or their own chevron,
 * on the column's bottom edge because another section above shows its body and fills the column (ChannelSideArea,
 * `stackEndOf`): nothing under them to divide them from, so their heads draw no seam along that edge (index.css
 * `[data-slot="panel-header"][data-stack-end]`, on the head itself: a panel nested in a section keeps its own).
 * Between sections the folded head's seam stays.
 */
const useStackEnds = create<{ ends: Readonly<Record<string, true>> }>(() => ({ ends: {} }));

/**
 * The section of a column, top to bottom, whose head stands on the column's bottom edge: the last, where it shows its
 * head alone (`folded`) and another shows its body above it. Where every one shows its head alone they all stand at
 * the column's top, the column empty under them: each keeps its seam, as before (none).
 */
export function stackEndOf<Section extends string>(sections: readonly Section[], folded: (section: Section) => boolean): Section | null {
  const last = sections.at(-1);
  return last !== undefined && folded(last) && sections.some((section) => !folded(section)) ? last : null;
}

/** Marks `section` its column's last, its head alone on the column's bottom edge, while `end`. */
export function useMarkStackEnd(section: string, end: boolean) {
  useLayoutEffect(() => {
    if (!end) return;
    useStackEnds.setState((s) => ({ ends: { ...s.ends, [section]: true } }));
    return () => useStackEnds.setState((s) => {
      const ends = { ...s.ends };
      delete ends[section];
      return { ends };
    });
  }, [end, section]);
}

export type StackEndHead = SideSectionHead & { props: SideSectionHead["props"] & { "data-stack-end"?: string } };

/** `head` (useSideSectionHead's, spread on the section's PanelHeader) with the mark where `section` is so marked. */
export function useStackEndHead(section: string | null, head: SideSectionHead): StackEndHead {
  const end = useStackEnds((s) => section !== null && s.ends[section] === true);
  return useMemo(() => (end ? { ...head, props: { ...head.props, "data-stack-end": "" } } : head), [end, head]);
}
