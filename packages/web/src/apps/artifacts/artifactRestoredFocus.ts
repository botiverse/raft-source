import type { ArtifactCommentDraftId } from "@botiverse/raft-shared";

/**
 * Focus for a draft a deletion's toast made again (its Undo, artifactDraftDelete): the toast goes
 * with the press, so focus moves to the draft, wherever the Artifact shows it, whichever comes
 * first, the ask or the drawing (no waiting by frames). First of: a reply draft's thread card (where
 * its entry is, ArtifactPendingReplies), its Edit in "Your drafts" (ArtifactReviewPanel DraftCard),
 * its card in a Markdown margin (ArtifactMarkdownMargin), its marker beside a text or csv file
 * (ArtifactShellDraftMarker).
 * - drawn already (React may commit the new draft before the undo's promise answers): focused at
 *   once, when asked (`focusDraftWhenDrawn` finds it by its `data-draft-id`);
 * - not yet, or never (an HTML page's marker is in its frame, which is the page's, and with the list
 *   closed nothing here draws the draft): focus left on nothing or on the closing toast is held on
 *   the Artifact surface, as a box closing leaves it (ArtifactReviewParts `finalFocus`: not a header
 *   button, whose tooltip would take the next Esc), so it is never lost. The wish is kept, and the
 *   part that draws the draft asks for it as it mounts (`draftDrawn`, from its ref): a margin's card
 *   waits for the frame to report where its new mark is. That wish yields if the person moved focus
 *   since, and lapses after a while.
 * A focus the comment list planned for a frame later (after the deletion: the next draft's Edit
 * or the heading) yields to this one (`draftFocusRestorations`): the Undo can come before that
 * frame, and the plan must not take focus off the draft made again.
 * Base UI's toast, closing, moves focus only while focus is in its viewport, and does so at once
 * (ToastStore.handleFocusManagement); the undo's answer comes after it, so this focus is the last.
 * Focus it gave back to a real place (where F6 left from) is not nothing: held there, not moved.
 */
const wanted = new Map<ArtifactCommentDraftId, { reply: boolean; until: number; left: Element | null }>();
const LAPSES_MS = 5_000;
/** The Artifact surface: the shell's Panel, which takes focus but isn't in the Tab order. */
const SURFACE = "[data-artifact-focus]";
/** How many times a made-again draft took focus here (or the surface for it): a focus the person's list meant to move later yields to it. */
let restoredFocusCount = 0;

/**
 * A count that goes up each time a made-again draft takes focus. Read when a later focus is
 * planned (the comment list's after a deletion, a frame on): if it changed meanwhile, the Undo's
 * focus came after the plan, and the plan is dropped rather than move focus off the draft.
 */
export function draftFocusRestorations(): number {
  return restoredFocusCount;
}

/** Where draft `id` takes focus if it is drawn now and can take it (a card scrolled out of the margin is inert); else null. */
function drawnTarget(id: ArtifactCommentDraftId, reply: boolean): HTMLElement | null {
  const key = CSS.escape(id);
  const thread = reply ? document.querySelector(`[data-testid='artifact-comment-pending-draft'][data-draft-id="${key}"]`)?.closest<HTMLElement>("[data-thread-id][tabindex]") : null;
  const target = thread
    ?? document.querySelector<HTMLElement>(`[data-testid='artifact-review-draft'][data-draft-id="${key}"] [data-testid='artifact-review-draft-edit']`)
    ?? document.querySelector<HTMLElement>(`[data-testid='artifact-margin-draft'][data-draft-id="${key}"] [data-testid='artifact-margin-draft-open']`)
    ?? document.querySelector<HTMLElement>(`[data-testid='artifact-comment-draft-marker'][data-draft-id="${key}"]`);
  return target && !target.closest("[inert]") ? target : null;
}

function take(target: HTMLElement): void {
  restoredFocusCount += 1;
  target.focus({ preventScroll: true });
}

/** Whether focus is on nothing the person could be at: the page's body, or the toast that is going. */
function focusIsAdrift(): boolean {
  const active = document.activeElement;
  return !active || active === document.body || active.closest("[data-slot='toast-viewport']") !== null;
}

/** Holds focus on the Artifact surface, which only a script can focus: not a header button, whose tooltip would take the next Esc. */
export function focusArtifactSurface(): void {
  document.querySelector<HTMLElement>(SURFACE)?.focus({ preventScroll: true });
}

/** Focus draft `id` (made again; `reply`: a reply draft): at once if it is drawn, else on the surface until it is. */
export function focusDraftWhenDrawn(id: ArtifactCommentDraftId, reply: boolean): void {
  const target = drawnTarget(id, reply);
  if (target) {
    wanted.delete(id);
    take(target);
    return;
  }
  const surface = focusIsAdrift() ? document.querySelector<HTMLElement>(SURFACE) : null;
  if (surface) take(surface);
  wanted.set(id, { reply, until: Date.now() + LAPSES_MS, left: document.activeElement });
}

/** Draft `id` was drawn (from the ref of the part drawing it): it takes focus if that is still wished, once. */
export function draftDrawn(id: ArtifactCommentDraftId): void {
  const wish = wanted.get(id);
  if (!wish) return;
  // In a ref: the whole commit is in the document, so the first of the draft's places is found whichever part asks.
  const target = drawnTarget(id, wish.reply);
  if (!target) return;
  wanted.delete(id);
  if (wish.until < Date.now()) return;
  const active = document.activeElement;
  if (active === wish.left || active === document.body) take(target);
}
