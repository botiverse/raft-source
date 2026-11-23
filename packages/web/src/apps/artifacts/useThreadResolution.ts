import { useCallback, useContext, useState } from "react";
import { useIntl } from "react-intl";
import type { IntlShape } from "react-intl";
import type { ArtifactCommentId, ArtifactId } from "@botiverse/raft-shared";

import { useToast } from "@botiverse/raft-ui";
import { timersOf, useOwnerDocument } from "../../utils/ownerDocument";
import { watchFocusIntent } from "../../utils/focusRequest";
import { isTextEditableElement } from "../../utils/keyboardShortcuts";
import type { ArtifactCommentsState } from "./ArtifactCommentsContext";
import { ArtifactCardHoldContext } from "./artifactCardHold";
import { isResolvedThread, mayResolveThread } from "./artifactComments";
import type { ArtifactCommentThread } from "./artifactComments";
import { useArtifactComments } from "./ArtifactCommentsContext";
import { focusArtifactSurface } from "./artifactRestoredFocus";
import { artifactSource } from "./artifactSource";
import { canTakeFocus } from "./artifactViewerStore";
import { POLITE_ERROR } from "./artifactToasts";

export interface ThreadResolution {
  /** The viewer may resolve and reopen it (mayResolveThread: the server's rule). */
  may: boolean;
  resolved: boolean;
  busy: boolean;
  /** Resolve it, or reopen it when resolved. */
  toggle: () => Promise<void>;
}

/**
 * Resolving a thread (#249), from its card. Not optimistic, as a delete: the root the server
 * answers takes its place in the list (`replaced`), which moves the card to the list's Resolved
 * section (or out of it) and takes its marker off the page (or puts it back). A held card
 * (artifactCardHold) writes nothing until pressed in. A refusal (another's change raced it: a
 * role, a reply) says it went wrong, and the list is read again. `onChanged`: done, resolved now
 * or open. Resolved, a toast says so (announced) with Undo, which reopens it (undoResolve). In the window the card is
 * drawn in (an object window's own, #337 PR3): its toasts, its focus, its timers.
 */
export function useThreadResolution(thread: ArtifactCommentThread, onChanged?: (threadId: ArtifactCommentId, resolved: boolean, wanted: () => boolean) => void): ThreadResolution {
  const { formatMessage } = useIntl();
  const toast = useToast();
  const doc = useOwnerDocument();
  const comments = useArtifactComments();
  const hold = useContext(ArtifactCardHoldContext);
  const [busy, setBusy] = useState(false);
  const root = thread.root;
  const may = !!comments && mayResolveThread(root, comments.viewer, comments.data.capabilities);
  const resolved = isResolvedThread(thread);
  const id = comments?.data.card.id ?? null;
  const replaced = comments?.replaced;
  const added = comments?.added;
  const reload = comments?.reload;
  const toggle = useCallback(async () => {
    if (!root || id === null || busy) return;
    if (hold) {
      hold();
      return;
    }
    setBusy(true);
    // Whether a focus move made once the server answers is still wanted then (focus plan rule 3), for `onChanged`.
    const wanted = watchFocusIntent();
    try {
      const answer = await (resolved ? artifactSource().reopenComment(id, root.id) : artifactSource().resolveComment(id, root.id));
      replaced?.(answer.comment);
      if (answer.note) added?.(answer.note);
      if (onChanged) onChanged(thread.id, answer.comment.resolvedAt !== null, wanted);
      else wanted();
      if (!resolved && answer.changed && comments) {
        toast.success(formatMessage({ id: "artifacts.comments.resolvedToast" }), {
          action: { label: formatMessage({ id: "artifacts.review.undo" }), onClick: () => void undoResolve(comments, id, thread.id, { formatMessage, toast, doc }, onChanged) },
        });
      }
    } catch {
      wanted();
      toast.error(formatMessage({ id: "common.confirm.somethingWentWrong" }), POLITE_ERROR);
      reload?.();
    } finally {
      setBusy(false);
    }
  }, [root, id, busy, hold, resolved, replaced, added, onChanged, thread.id, formatMessage, reload, comments, toast, doc]);
  return { may, resolved, busy, toggle };
}

/** Undo's focus: looked at every UNDO_FOCUS_STEP_MS, for UNDO_FOCUS_TRIES at most; done once its card held it for UNDO_FOCUS_HELD looks. */
const UNDO_FOCUS_STEP_MS = 16;
const UNDO_FOCUS_TRIES = 120;
const UNDO_FOCUS_HELD = 10;

/**
 * The resolve toast's Undo: reopen the thread (its root), into the list as Reopen does. The toast
 * goes with the press, and the focus with it; it goes to the thread's card, once the list has drawn
 * it back among the open threads. Until then, and for a few frames after, other moves set off by
 * the same change (the toggle that had the focus going, a focus move the resolve had asked for, a
 * fallback that picks the header's first control) don't stand: the card takes it back. Only the
 * person ends that early, with a press or a key of their own, or by writing in a box. With the list
 * closed, or the card not drawn within about two seconds, the Artifact's surface (its marker is back).
 * `onChanged` (the list's, which resolved it) hears it reopened, so the card moves back as a Reopen
 * moves it; it plans no focus of its own (its `wanted` says no): the focus is this one's.
 */
async function undoResolve(
  comments: ArtifactCommentsState,
  id: ArtifactId,
  rootId: ArtifactCommentId,
  { formatMessage, toast, doc }: { formatMessage: IntlShape["formatMessage"]; toast: ReturnType<typeof useToast>; doc: Document },
  onChanged?: (threadId: ArtifactCommentId, resolved: boolean, wanted: () => boolean) => void,
): Promise<void> {
  // The card's own document and window: an object window draws frames and runs timers while the main one is hidden.
  const timers = timersOf(doc);
  let theirs = false;
  const stop = () => {
    theirs = true;
  };
  doc.addEventListener("pointerdown", stop, true);
  // keydown-global-exempt: ends the post-Undo focus hold on the user's own key press; never handles, prevents or redirects the key
  doc.addEventListener("keydown", stop, true);
  const done = () => {
    doc.removeEventListener("pointerdown", stop, true);
    doc.removeEventListener("keydown", stop, true);
  };
  try {
    comments.replaced((await artifactSource().reopenComment(id, rootId)).comment);
    onChanged?.(rootId, false, () => false);
  } catch {
    done();
    toast.error(formatMessage({ id: "common.confirm.somethingWentWrong" }), POLITE_ERROR);
    comments.reload();
    return;
  }
  const writing = () => {
    const active = doc.activeElement;
    return !!active && isTextEditableElement(active);
  };
  const openCard = (): HTMLElement | null => {
    const card = doc.querySelector<HTMLElement>(`[data-testid='artifact-comments-panel'] [data-thread-id="${CSS.escape(rootId)}"]`);
    return card && !card.closest("[data-testid='artifact-comments-resolved']") && canTakeFocus(card) ? card : null;
  };
  const look = (tries: number, held: number) => {
    if (theirs || writing()) return done();
    const card = openCard();
    if (card && doc.activeElement !== card) card.focus({ preventScroll: true });
    const holding = card !== null && doc.activeElement === card ? held + 1 : 0;
    if (holding >= UNDO_FOCUS_HELD) return done();
    const listShown = doc.querySelector("[data-testid='artifact-comments-panel']") !== null;
    if (tries > 0 && (listShown || holding > 0)) {
      timers.setTimeout(() => look(tries - 1, holding), UNDO_FOCUS_STEP_MS);
      return;
    }
    done();
    if (!card) focusArtifactSurface(doc);
  };
  timers.setTimeout(() => look(UNDO_FOCUS_TRIES, 0), 0);
}
