import { useCallback, useEffect, useRef, useState } from "react";
import { isArtifactFramedKind } from "@botiverse/raft-shared";
import type { ArtifactViewerData } from "@botiverse/raft-shared";
import type { AnnotationRect } from "@botiverse/porthole";

import type { ArtifactCommentTarget } from "./ArtifactCommentsContext";
import { isShellAnchor } from "./artifactComments";
import { newestUnsentComment, useArtifactLocalDraftScope } from "./artifactLocalDrafts";

/** How long an unsent comment waits at most for its lines or rows to be drawn: then the list's foot. */
export const UNSENT_REOPEN_CAP_MS = 10_000;

interface UnsentOffer {
  id: string;
  /** The draft's key (artifactLocalDrafts). */
  key: string;
  target: ArtifactCommentTarget;
  /** Waiting for the shell to draw its lines or rows, or given to the list's foot. */
  at: "shell" | "list";
}

/**
 * A new comment left unsent here (artifactLocalDrafts: the page was replaced, reloaded, closed) is
 * offered back when the Artifact is opened again, any version (#proj-workspace:#144). Once per
 * Artifact opened, the newest such comment:
 *
 * - at lines or rows of the file shown (a text or csv file the shell draws): its card opens there
 *   again, unfocused, once the shell has drawn them and found the passage (`unsentAt`, answered by
 *   `reopenUnsent` from ArtifactShellComments), within UNSENT_REOPEN_CAP_MS;
 * - anywhere else (a place in a framed page, which only the page can find; another file; the
 *   passage gone), and on the whole Artifact: the comment list opens, its foot box taking the
 *   words (`unsentForList`, the draft's key: after any words it kept, saying "Unsent comment
 *   restored"). Posted from there it is a comment on the whole Artifact.
 *
 * Not while the viewer lands on a comment or a review (`held`), nor where the viewer may not
 * comment. Other unsent comments stay kept, each back in its own box when that box opens.
 */
export function useUnsentCommentOffer({ id, kind, shownPath, canComment, held, openCard, openList }: {
  id: ArtifactViewerData["card"]["id"];
  kind: ArtifactViewerData["card"]["kind"];
  shownPath: string | null;
  canComment: boolean;
  held: boolean;
  openCard: (target: ArtifactCommentTarget, rect: AnnotationRect) => void;
  /** The provider's own list state (set while it renders, as React's "adjusting state"). */
  openList: (open: boolean) => void;
}) {
  const scope = useArtifactLocalDraftScope(id);
  // Decided while rendering (React's "adjusting state when a prop changes"), from what this device
  // kept: set before the page draws, so the list's foot box mounts with the words.
  // oxlint-disable-next-line react-doctor/no-derived-useState -- the Artifact last offered for, so each one opened is offered once.
  const [offeredFor, setOfferedFor] = useState<string | null>(null);
  const [offer, setOffer] = useState<UnsentOffer | null>(null);
  if (scope && offeredFor !== id) {
    setOfferedFor(id);
    const unsent = canComment && !held ? newestUnsentComment(scope) : null;
    const target = unsent?.target;
    const inShell = target?.scope === "file" && target.path === shownPath && isShellAnchor(target.anchor) && !isArtifactFramedKind(kind);
    setOffer(unsent && target ? { id, key: unsent.key, target, at: inShell ? "shell" : "list" } : null);
    if (unsent && !inShell) openList(true);
  }
  const current = offer?.id === id ? offer : null;
  const reopenUnsent = useCallback((rect: AnnotationRect | null) => {
    if (current?.at !== "shell") return;
    if (rect) {
      setOffer(null);
      openCard(current.target, rect);
      return;
    }
    setOffer({ ...current, at: "list" });
    openList(true);
  }, [current, openCard, openList]);
  // The shell never drew those lines (another view, a file that failed): the list's foot instead.
  const reopenRef = useRef(reopenUnsent);
  reopenRef.current = reopenUnsent;
  const waits = current?.at === "shell";
  useEffect(() => {
    if (!waits) return;
    const timer = window.setTimeout(() => reopenRef.current(null), UNSENT_REOPEN_CAP_MS);
    return () => window.clearTimeout(timer);
  }, [waits]);
  return {
    unsentAt: current?.at === "shell" ? current.target : null,
    reopenUnsent,
    unsentForList: current?.at === "list" ? current.key : null,
  };
}
