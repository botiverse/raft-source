import type { ArtifactCommentId } from "@botiverse/raft-shared";
import { focusLost } from "../../utils/focusGuard";
import { isTextEditableElement } from "../../utils/keyboardShortcuts";

import type { ArtifactCommentsState } from "./ArtifactCommentsContext";
import { focusArtifactSurface } from "./artifactRestoredFocus";
import { canTakeFocus } from "./artifactViewerStore";

const MARKERS = "[data-testid='artifact-comment-marker'][data-thread-id]";
const RESOLVED_TOGGLE = "[data-testid='artifact-comments-resolved-toggle']";
/** A phone's sheet hands focus back as it finishes closing, after its animation: looked at again then. */
const SHEET_SETTLE_MS = 400;

/**
 * Where the keyboard goes once the card beside a marker (a popover, a phone's sheet, the margin's
 * card) resolved its thread (#249) and closed with its marker, the focus on nothing otherwise: the
 * comment list's Resolved (N) while the list is open; else the next open thread's marker (a text
 * or csv file's, or the frame's through Porthole's `focusMark`), the one before when it was the
 * last; else the Artifact's surface. The markers are read now, before the list draws the change.
 * The person's last act was Resolve in the card, so the first move overrides the card's own return
 * of the focus (to what had it before the card opened, by now anything); the later look, for a
 * phone's sheet, moves it only off the body.
 */
export function focusAfterResolvedCard(comments: ArtifactCommentsState, threadId: ArtifactCommentId): void {
  const shellIds = [...document.querySelectorAll<HTMLElement>(MARKERS)].map((marker) => marker.dataset.threadId!);
  const ids = shellIds.length > 0 ? shellIds : comments.frame.marks.filter((mark) => !("kind" in mark && mark.kind === "draft")).map((mark) => mark.id);
  const at = ids.indexOf(threadId);
  const next = at < 0 ? ids[0] ?? null : ids[at + 1] ?? ids[at - 1] ?? null;
  const listOpen = comments.panelOpen;
  const frame = comments.frame.box?.current?.querySelector("iframe") ?? null;
  const { focusMark } = comments;
  const settle = () => {
    const toggle = listOpen ? document.querySelector(RESOLVED_TOGGLE) : null;
    if (toggle && canTakeFocus(toggle)) {
      toggle.focus({ preventScroll: true });
      return;
    }
    const marker = next && shellIds.length > 0 ? document.querySelector(`${MARKERS}[data-thread-id="${CSS.escape(next)}"]`) : null;
    if (marker && canTakeFocus(marker)) {
      marker.focus({ preventScroll: true });
      return;
    }
    if (next && shellIds.length === 0 && frame) {
      frame.focus({ preventScroll: true });
      if (focusMark(next as ArtifactCommentId)) return;
    }
    focusArtifactSurface();
  };
  window.setTimeout(() => {
    // Not off the person's own words, should a box have taken the focus since.
    const active = document.activeElement;
    if (!active || !isTextEditableElement(active)) settle();
  }, 0);
  window.setTimeout(() => {
    if (focusLost()) settle();
  }, SHEET_SETTLE_MS);
}
