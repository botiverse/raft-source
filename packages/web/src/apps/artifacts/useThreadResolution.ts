import { useCallback, useContext, useState } from "react";
import { useIntl } from "react-intl";
import type { IntlShape } from "react-intl";
import type { ArtifactCommentId, ArtifactId } from "@botiverse/raft-shared";

import { showToast } from "../../components/toastBridge";
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
 * or open. Resolved, a toast says so (announced) with Undo, which reopens it (undoResolve).
 */
export function useThreadResolution(thread: ArtifactCommentThread, onChanged?: (threadId: ArtifactCommentId, resolved: boolean, wanted: () => boolean) => void): ThreadResolution {
  const { formatMessage } = useIntl();
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
        showToast({
          title: formatMessage({ id: "artifacts.comments.resolvedToast" }),
          type: "success",
          actionProps: { children: formatMessage({ id: "artifacts.review.undo" }), onClick: () => void undoResolve(comments, id, thread.id, formatMessage) },
        });
      }
    } catch {
      wanted();
      showToast({ title: formatMessage({ id: "common.confirm.somethingWentWrong" }), type: "error" });
      reload?.();
    } finally {
      setBusy(false);
    }
  }, [root, id, busy, hold, resolved, replaced, added, onChanged, thread.id, formatMessage, reload, comments]);
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
 */
async function undoResolve(comments: ArtifactCommentsState, id: ArtifactId, rootId: ArtifactCommentId, formatMessage: IntlShape["formatMessage"]): Promise<void> {
  let theirs = false;
  const stop = () => {
    theirs = true;
  };
  document.addEventListener("pointerdown", stop, true);
  // keydown-global-exempt: ends the post-Undo focus hold on the user's own key press; never handles, prevents or redirects the key
  document.addEventListener("keydown", stop, true);
  const done = () => {
    document.removeEventListener("pointerdown", stop, true);
    document.removeEventListener("keydown", stop, true);
  };
  try {
    comments.replaced((await artifactSource().reopenComment(id, rootId)).comment);
  } catch {
    done();
    showToast({ title: formatMessage({ id: "common.confirm.somethingWentWrong" }), type: "error" });
    comments.reload();
    return;
  }
  const writing = () => {
    const active = document.activeElement;
    return !!active && isTextEditableElement(active);
  };
  const openCard = (): HTMLElement | null => {
    const card = document.querySelector<HTMLElement>(`[data-testid='artifact-comments-panel'] [data-thread-id="${CSS.escape(rootId)}"]`);
    return card && !card.closest("[data-testid='artifact-comments-resolved']") && canTakeFocus(card) ? card : null;
  };
  const look = (tries: number, held: number) => {
    if (theirs || writing()) return done();
    const card = openCard();
    if (card && document.activeElement !== card) card.focus({ preventScroll: true });
    const holding = card !== null && document.activeElement === card ? held + 1 : 0;
    if (holding >= UNDO_FOCUS_HELD) return done();
    const listShown = document.querySelector("[data-testid='artifact-comments-panel']") !== null;
    if (tries > 0 && (listShown || holding > 0)) {
      window.setTimeout(() => look(tries - 1, holding), UNDO_FOCUS_STEP_MS);
      return;
    }
    done();
    if (!card) focusArtifactSurface();
  };
  window.setTimeout(() => look(UNDO_FOCUS_TRIES, 0), 0);
}
