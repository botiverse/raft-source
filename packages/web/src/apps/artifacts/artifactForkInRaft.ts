import { useEffect, useRef } from "react";
import type { IntlShape } from "react-intl";
import type { ArtifactCard } from "@botiverse/raft-shared";

import { readsAsOutsider } from "./artifactOwnServer";
import { artifactShareHost } from "./artifactShareHost";

/**
 * Fork in Raft (#proj-workspace:#140, xxchan): on another server's public
 * Artifact, "Send to conversation" is a visible header button with this name
 * instead of an item in ⋯. It opens the same dialog, its note started with
 * Fork's words (the reader may change them); nothing is copied on the server.
 *
 * A visitor who isn't signed in signs in first: the address takes the marker
 * (`?fork=1`), and sign-in, sign-up and a social sign-in come back to the
 * address with it (they return to the page's path and query, through the
 * app's own same-origin return path, sanitizeAppLocalReturnPath). Back there
 * signed in, the page takes the marker once (it leaves the address) and opens
 * the dialog.
 */

const FORK_PARAM = "fork";

/** Where Fork in Raft takes Send to conversation's place: another server's public Artifact, read as an outsider (readsAsOutsider, the one question). */
export function offersForkInRaft(card: Pick<ArtifactCard, "home" | "fromAnotherServer">): boolean {
  return readsAsOutsider(card);
}

/** Whether an address's query carries the marker. */
export function artifactForkAsked(search: string): boolean {
  return new URLSearchParams(search).get(FORK_PARAM) === "1";
}

/** This page's address with its query changed, in place of the current entry (the history keeps its state). */
function replaceQuery(change: (params: URLSearchParams) => void): void {
  const url = new URL(window.location.href);
  change(url.searchParams);
  window.history.replaceState(window.history.state, "", url);
}

/** Before a visitor signs in: the marker on this address, for sign-in to come back to. */
export function markArtifactForkForSignIn(): void {
  replaceQuery((params) => params.set(FORK_PARAM, "1"));
}

/** True once when the address carries the marker, which it then no longer does. */
export function takeArtifactForkMarker(): boolean {
  if (!artifactForkAsked(window.location.search)) return false;
  replaceQuery((params) => params.delete(FORK_PARAM));
  return true;
}

/**
 * What a page does with the marker: "open" (it offers Fork in Raft: the
 * dialog opens), "drop" (it doesn't, e.g. a member of the Artifact's own
 * server: the marker only leaves the address), or "wait" (a visitor's page:
 * it stays for the sign-in to come back with).
 */
export type ArtifactForkMarkerUse = "open" | "drop" | "wait";

/**
 * A page back at the address with the marker: takes it at its first chance
 * (the address, read once), and calls `open` where the page offers Fork in
 * Raft (`use`). Once per page: the marker is gone from the address after it.
 */
export function useArtifactForkMarker(use: ArtifactForkMarkerUse, open: () => void): void {
  const taken = useRef(false);
  // Dropped: the marker only leaves the address; nothing to open.
  const onTaken = use === "open" ? open : dropMarkerOnly;
  const waits = use === "wait";
  useEffect(() => {
    if (taken.current || waits) return;
    taken.current = true;
    if (takeArtifactForkMarker()) onTaken();
  }, [waits, onTaken]);
}

function dropMarkerOnly(): void {}

/** Fork's words in the note of the dialog about to open (its draft, `draftKey`), unless the reader already wrote one. */
export function startArtifactForkNote(draftKey: string, formatMessage: IntlShape["formatMessage"]): void {
  artifactShareHost().startNote?.(draftKey, formatMessage({ id: "artifacts.fork.note" }));
}
