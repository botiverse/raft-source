import type { AnchorResult } from "@botiverse/porthole";

import { knownTop } from "./artifactMarginPlaces";

/** How often a landing asks the frame to bring its mark into view again before it gives up on the card (the list instead). */
export const LANDING_FOCUS_TRIES = 3;

/**
 * What a landing (a comment's Activity row, or `?comment=`) does with the frame's report of where
 * its thread's mark is (InNOut's staging QA, #proj-workspace:#152: the page didn't scroll, and the
 * card opened where the mark was before, or nowhere beside the margin):
 * - `list`: the mark is gone (orphaned, no box): the list on the comment instead;
 * - `land`: its top is inside the frame (the frame brought it into view): its card opens there;
 * - `refocus`: its box is clamped to an edge (P104: the report came before the frame scrolled to
 *   it, or the focus asked for was lost): ask the frame to bring it into view again (a `focus` with
 *   a new key), at most LANDING_FOCUS_TRIES times;
 * - `list` too once those tries are used up with the box still clamped (a passage taller than the
 *   frame, whose top the frame holds at its edge; a mark in a scroller of the page's own): a card
 *   opened at the clamped edge would be drawn nowhere beside the margin (it draws only a known
 *   top: RED3 again), so the list on the comment instead.
 * A frame not laid out (no height known) bounds nothing: the mark is taken as in view.
 */
export function landingStep(result: AnchorResult, frameHeight: number, tries: number): "list" | "land" | "refocus" {
  if (result.state !== "attached" || !result.rect) return "list";
  if (knownTop(result.rect, frameHeight > 0 ? frameHeight : Number.POSITIVE_INFINITY)) return "land";
  return tries >= LANDING_FOCUS_TRIES ? "list" : "refocus";
}
