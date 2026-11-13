import { useCallback, useRef, useState } from "react";
import type { ReactNode } from "react";
import type { IntlShape } from "react-intl";
import { useIntl } from "react-intl";
import type { ArtifactCommentDraft } from "@botiverse/raft-shared";

import ConfirmDialog from "../../components/ConfirmDialog";
import { closeToast, showToast } from "../../components/toastBridge";
import { anchorLabel } from "./ArtifactActorParts";
import type { DraftHistoryStep } from "./artifactDraftHistory";
import { focusArtifactSurface, focusDraftWhenDrawn } from "./artifactRestoredFocus";
import { draftFromBody, shortQuote } from "./artifactComments";
import { useArtifactReview } from "./ArtifactReviewContext";

/** How much of a draft's words name it (its Edit and Delete buttons, #148 follow-up). */
const EXCERPT_CHARS = 40;

/**
 * A draft in a few words, to tell its buttons apart for assistive tech ("Edit draft: On the
 * milestones…"): the start of its text, else (images alone) where it is: its anchor's label, its
 * file, or the whole Artifact; a reply draft without words, whom it answers (`replyPlace`).
 */
export function draftExcerpt(draft: ArtifactCommentDraft, intl: IntlShape, replyPlace: string | null): string {
  const words = shortQuote(draftFromBody(draft.body).text, EXCERPT_CHARS);
  if (words) return words;
  if (replyPlace) return replyPlace;
  if (draft.target.scope === "file") return draft.target.anchor ? anchorLabel(draft.target.anchor, intl) || draft.target.path : draft.target.path;
  return intl.formatMessage({ id: "artifacts.comments.groupArtifact" });
}

/** A draft with images: deleting it lets its uploads go, so it can't be made again (artifactDraftHistory records none). */
const hasImages = (draft: ArtifactCommentDraft) => (draft.images?.length ?? 0) > 0;

/**
 * Deleting one of the person's drafts: "Your drafts" in the list, C's cards, a reply draft under
 * its thread, a draft's own view. As raft-design feedback.md says of anything removed from a list,
 * it goes at once and the app's toast says so with Undo ("Draft deleted"), on every route. Its
 * Undo brings that draft back and nothing
 * else, whatever changed since (artifactDraftHistory `undoStep`, Gmail's way), and the toast closes
 * once that deletion is no longer there to undo (`watch`: ⌘Z undid it, a clear, the viewer
 * closed); other drafts changing leave it open, the toast being what
 * assistive tech hears (its viewport is a polite live region). A draft with images can't be undone,
 * so it is asked first (the app's ConfirmDialog: its images go too, and it can't be undone, in the
 * dialog's destructive banner), then deleted with a plain "Draft deleted". `askFirst` asks for every
 * draft: a draft without images is asked with the title alone (the orange Delete, not the red
 * confirmation: it can be undone), and once confirmed goes as any other, its toast and step the same.
 * Failed, a toast (in the dialog, its error). Returns the delete, whether it was deleted, and the
 * confirmation to render (null while none is asked).
 */
export function useDeleteDraft({ onAsked, askFirst = false }: {
  /** The confirmation closed (Cancel, Esc, or confirmed: `deleted`), in its own event: the caller's card may reopen then. */
  onAsked?: (deleted: boolean) => void;
  /** Ask before deleting any draft: a draft's own view, which a page's pin can open (comments.md, "Three deletes ask first"). */
  askFirst?: boolean;
} = {}): [(draft: ArtifactCommentDraft) => Promise<boolean>, ReactNode] {
  const { formatMessage } = useIntl();
  const review = useArtifactReview();
  const removeDraft = review?.removeDraft;
  const undoStep = review?.history.undoStep;
  const watch = review?.history.watch;
  const [confirming, setConfirming] = useState<{ draft: ArtifactCommentDraft; resolve: (deleted: boolean) => void } | null>(null);
  const deleted = useRef(false);
  const said = useCallback((step: DraftHistoryStep | null) => {
    const title = formatMessage({ id: "artifacts.review.draftDeleted" });
    if (!step || !undoStep || !watch) {
      showToast({ title, type: "success" });
      return;
    }
    const toastId = showToast({
      title,
      type: "success",
      actionProps: {
        children: formatMessage({ id: "artifacts.review.undo" }),
        // This deletion, wherever it is in the history now (a failure toasts as any undo's); the
        // toast goes with it, so focus moves to the draft made again, or to the Artifact surface
        // where nothing here draws it (pressed by keyboard, it would be left on nothing):
        // artifactRestoredFocus.
        onClick: () => {
          void undoStep(step).then((madeAgain) => {
            if (madeAgain) focusDraftWhenDrawn(madeAgain, step.draft.replyTo !== null);
          });
        },
      },
    });
    watch(step, () => closeToast(toastId));
  }, [formatMessage, undoStep, watch]);
  const remove = useCallback(async (draft: ArtifactCommentDraft) => {
    if (!removeDraft) return false;
    if (askFirst || hasImages(draft)) return new Promise<boolean>((resolve) => setConfirming({ draft, resolve }));
    let step: DraftHistoryStep | null;
    try {
      step = await removeDraft(draft.id);
    } catch {
      showToast({ title: formatMessage({ id: "artifacts.review.deleteFailed" }), type: "error" });
      return false;
    }
    said(step);
    return true;
  }, [removeDraft, formatMessage, said, askFirst]);
  // A failure throws to the dialog, which keeps itself open with its error; done, it closes.
  const confirm = useCallback(async () => {
    if (!confirming || !removeDraft) return;
    // A draft with images is never recorded (null): a plain toast. Any other's step is its toast's Undo.
    said(await removeDraft(confirming.draft.id));
    deleted.current = true;
    confirming.resolve(true);
  }, [confirming, removeDraft, said]);
  // Deleted from the draft's own view, focus goes to the surface: left to Base UI, it goes to the
  // viewer's first control, a header button, where the toast's Undo would give it back. Moved here, as
  // Base UI moves it only to a tabbable element. Cancelled, nothing here: the view, closed while this
  // asks, opens again and takes it (ArtifactReviewParts).
  const finalFocus = useCallback(() => {
    if (deleted.current) {
      deleted.current = false;
      // Base UI asks this in its effect cleanup, inside React's commit, and React ends that commit by
      // focusing again whatever had focus as it began, if still there (a header button, when the
      // dialog's own focus hadn't arrived yet): so the surface takes it after the commit, as Base
      // UI's own return focus does (a microtask).
      queueMicrotask(focusArtifactSurface);
    }
    return false;
  }, []);
  const close = useCallback(() => {
    confirming?.resolve(false);
    setConfirming(null);
    onAsked?.(deleted.current);
  }, [confirming, onAsked]);
  // While it asks, Esc is the confirmation's alone: the dialog is a modal shortcut layer (useOverlayLayer), and the
  // surface's own Esc (useArtifactSurfaceKeyDown) leaves a key while one is open, so it can't close the card the
  // confirmation stepped aside for, even when Esc comes before the dialog's initial focus (a frame later) lands.
  const undoable = confirming !== null && !hasImages(confirming.draft);
  const dialog = confirming ? (
    <ConfirmDialog
      title={formatMessage({ id: "artifacts.review.deleteImageDraftTitle" })}
      message={undoable ? null : formatMessage({ id: "artifacts.review.deleteImageDraftBody" })}
      // Red says it can't be taken back, and then the button names what goes (Raft DS writing.md: the red
      // confirmation keeps its object); orange, it can be undone, and the verb alone does.
      confirmLabel={formatMessage({ id: undoable ? "artifacts.review.delete" : "artifacts.review.deleteDraftConfirm" })}
      confirmVariant={undoable ? "warning" : "danger"}
      confirmTestId={askFirst ? "artifact-draft-view-delete-confirm" : "artifact-draft-delete-confirm"}
      initialFocus="cancel"
      {...(askFirst ? { finalFocus } : null)}
      onConfirm={confirm}
      onClose={close}
    />
  ) : null;
  return [remove, dialog];
}
