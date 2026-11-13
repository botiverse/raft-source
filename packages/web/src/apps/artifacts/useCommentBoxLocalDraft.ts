// A comment box's unsent words kept on this device (artifactLocalDrafts), wired to the box: where
// they are kept and those it starts with (useCommentBoxLocalDraft), and keeping or dropping them
// as the person changes them (useKeptWords).
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { ArtifactActor, ArtifactCommentDraftId, ArtifactCommentImage } from "@botiverse/raft-shared";

import type { ArtifactCommentBoxMode } from "./artifactCommentBoxShapes";
import { mentionedActors } from "./artifactComments";
import {
  discardArtifactLocalDraft,
  discardArtifactLocalDraftKey,
  flushArtifactLocalDrafts,
  joinArtifactLocalDrafts,
  localDraftKey,
  localDraftPlaceKey,
  readArtifactLocalDraft,
  readArtifactLocalDraftKey,
  scheduleArtifactLocalDraft,
  useArtifactLocalDraftScope,
} from "./artifactLocalDrafts";
import type { ArtifactLocalDraftPlace, ArtifactLocalDraftScope } from "./artifactLocalDrafts";

/** Where the box's unsent words are kept on this device, and those it starts with (read on mount). */
export function useCommentBoxLocalDraft({ artifactId, mode, batchDraftId, fromPage, adoptKey }: {
  artifactId: string | null;
  mode: ArtifactCommentBoxMode;
  batchDraftId: ArtifactCommentDraftId | undefined;
  fromPage: boolean;
  adoptKey: string | null;
}) {
  const localScope = useArtifactLocalDraftScope(artifactId);
  const localPlace = useMemo<ArtifactLocalDraftPlace>(() => (mode.kind === "edit"
    ? { kind: "edit", comment: mode.comment.id }
    : batchDraftId ? { kind: "editDraft", draft: batchDraftId }
    : mode.replyTo ? { kind: "reply", replyTo: mode.replyTo.id }
    : { kind: "new", target: mode.target }), [mode, batchDraftId]);
  const [{ restored, adopted }] = useState(() => {
    if (!localScope || fromPage) return { restored: null, adopted: null };
    const kept = readArtifactLocalDraft(localScope, localPlace);
    // An edit's words saved before the comment was edited elsewhere would undo that edit: not
    // offered (the next words typed, or Cancel, replace them).
    const editedSince = mode.kind === "edit" && kept !== null && mode.comment.editedAt !== null && Date.parse(mode.comment.editedAt) > kept.savedAt;
    const own = editedSince ? null : kept;
    const other = adoptKey && adoptKey !== localDraftKey(localScope, localPlace) ? readArtifactLocalDraftKey(localScope.userId, adoptKey) : null;
    return { restored: joinArtifactLocalDrafts(own, other), adopted: other ? adoptKey : null };
  });
  return { localScope, localPlace, restored, adopted };
}

/**
 * The words kept as the person changes them (typed, a name picked): emptied, back to the
 * comment's own text, or the page's untouched suggestion, nothing is kept. Another place (a target
 * picked) takes them along. Gone with the box (a card closed, the page replaced), what waits is written.
 */
export function useKeptWords({ localScope, localPlace, adopted, ready, initialText, pageDraft }: {
  localScope: ArtifactLocalDraftScope | null;
  localPlace: ArtifactLocalDraftPlace;
  /** The words taken from another box (`adoptKey`): kept there until kept here. */
  adopted: string | null;
  /** Its uploaded images, kept with the words (references only), as they change. */
  ready: readonly ArtifactCommentImage[];
  initialText: string;
  pageDraft: string | null;
}) {
  const keptPlace = useRef(localPlace);
  const adoptedFrom = useRef(adopted);
  const readyImages = useRef(ready);
  readyImages.current = ready;
  const keepWords = useCallback((nextText: string, nextPicked: readonly ArtifactActor[], nextImages: readonly ArtifactCommentImage[] = readyImages.current) => {
    if (!localScope) return;
    if (localDraftPlaceKey(keptPlace.current) !== localDraftPlaceKey(localPlace)) discardArtifactLocalDraft(localScope, keptPlace.current);
    keptPlace.current = localPlace;
    const keep = (nextText.trim() !== "" && nextText !== initialText && nextText !== pageDraft) || nextImages.length > 0;
    scheduleArtifactLocalDraft(localScope, localPlace, keep ? { text: nextText, picked: mentionedActors(nextText, nextPicked), images: [...nextImages] } : null);
    if (adoptedFrom.current === null) return;
    flushArtifactLocalDrafts();
    discardArtifactLocalDraftKey(localScope.userId, adoptedFrom.current);
    adoptedFrom.current = null;
  }, [localScope, localPlace, initialText, pageDraft]);
  useEffect(() => () => flushArtifactLocalDrafts(), []);
  const discardLocal = useCallback(() => {
    if (!localScope) return;
    discardArtifactLocalDraft(localScope, localPlace);
    // Kept under a place the box had before (a reply that became a batch reply): gone too.
    if (localDraftPlaceKey(keptPlace.current) !== localDraftPlaceKey(localPlace)) discardArtifactLocalDraft(localScope, keptPlace.current);
    if (adoptedFrom.current !== null) discardArtifactLocalDraftKey(localScope.userId, adoptedFrom.current);
    adoptedFrom.current = null;
  }, [localScope, localPlace]);
  return { keepWords, discardLocal };
}
