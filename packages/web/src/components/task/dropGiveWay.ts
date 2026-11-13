import { useLayoutEffect } from "react";

import { ROW_SELECTOR } from "./sideCardsLayout";

/**
 * #189 rule 7: a new column's drop strip past the row's last column has no seam to stand on, so while the hand is
 * there that column (`data-side-col` `index`) gives the strip its width (index.css `data-drop-give-way`): the strip
 * stands in its own room, over none of the column's buttons. The columns are otherwise as they were until the drop.
 */
export function useDropGiveWay(row: HTMLElement | null, index: number | undefined): void {
  useLayoutEffect(() => {
    const column = index === undefined ? null : sideColumnOf(row, index);
    if (!column) return;
    column.dataset.dropGiveWay = "";
    return () => {
      delete column.dataset.dropGiveWay;
    };
  }, [index, row]);
}

/** The column of `row` marked `data-side-col` `index`. */
export function sideColumnOf(row: HTMLElement | null, index: number): HTMLElement | null {
  return Array.from(row?.querySelectorAll<HTMLElement>("[data-side-col]") ?? []).find((element) => element.closest(ROW_SELECTOR) === row && Number(element.dataset.sideCol) === index) ?? null;
}
