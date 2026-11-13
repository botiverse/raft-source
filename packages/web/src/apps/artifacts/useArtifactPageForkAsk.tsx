import { useCallback, useContext, useRef, useState } from "react";
import type { ReactNode } from "react";
import { useIntl } from "react-intl";
import { currentTimeMs } from "@botiverse/raft-shared";

import ConfirmDialog from "../../components/ConfirmDialog";
import { createPageOpenGate } from "./artifactPageOpenGate";
import { ArtifactPageForkContext } from "./artifactPageForkContext";

/**
 * The page's comment button for another server's reader, and for anyone on the public page (xxchan):
 * the page hears false (it says it can't comment here) and Raft asks "Comment on your own copy?",
 * with Fork in Raft (the fork flow) and Cancel. A signed-out visitor has no server to fork into yet,
 * so their sentence says to sign in first (`signedOut`; Fork in Raft takes them there). `ask` is called only from the page's `comments.open`
 * (no proof of a click is asked of it: Porthole's default since 0.16.0), and asks at
 * most once a second, less often once the person has cancelled it three times in a row
 * (artifactPageOpenGate). `offered`: false elsewhere,
 * where `comments.open` goes to the comment box as before.
 */
export function useArtifactPageForkAsk(): { offered: boolean; ask: () => void; dialog: ReactNode } {
  const { formatMessage } = useIntl();
  const pageFork = useContext(ArtifactPageForkContext);
  const openFork = pageFork?.open;
  const [asked, setAsked] = useState(false);
  // How often the page may ask by itself (artifactPageOpenGate): Cancel is a close, Fork is the person's doing.
  const [asks] = useState(createPageOpenGate);
  const askedNow = useRef(false);
  // Fork in Raft chosen: it opens once the question closes, and focus is left to its dialog.
  const forking = useRef(false);
  // What had focus as the page asked: its frame, where the press was.
  const askedFrom = useRef<Element | null>(null);
  const ask = useCallback(() => {
    if (!asks.ask(currentTimeMs(), askedNow.current)) return;
    forking.current = false;
    askedFrom.current = document.activeElement;
    askedNow.current = true;
    setAsked(true);
  }, [asks]);
  const choose = useCallback(() => {
    forking.current = true;
    asks.acted();
  }, [asks]);
  const close = useCallback(() => {
    askedNow.current = false;
    setAsked(false);
    if (forking.current) openFork?.();
  }, [openFork]);
  // Cancelled: focus goes to the Artifact's surface, not back into the page's frame where Base UI
  // would return it (a frame Raft focuses itself holds the keyboard without the person having
  // put it there). Focus the person put elsewhere stays.
  const finalFocus = useCallback(() => {
    if (forking.current) return false;
    const frame = askedFrom.current;
    if (!(frame instanceof HTMLIFrameElement)) return true;
    // After React's commit, which leaves focus on the body as the question goes.
    queueMicrotask(() => {
      const active = document.activeElement;
      if (active && active !== document.body && active !== frame) return;
      frame.closest<HTMLElement>("[data-artifact-focus]")?.focus({ preventScroll: true });
      if (document.activeElement === frame) frame.blur();
    });
    return false;
  }, []);
  const dialog = asked && pageFork !== null ? (
    <ConfirmDialog
      title={formatMessage({ id: "artifacts.fork.commentTitle" })}
      message={formatMessage({ id: pageFork.signedOut ? "artifacts.fork.commentBodySignedOut" : "artifacts.fork.commentBody" })}
      confirmLabel={formatMessage({ id: "artifacts.fork.inRaft" })}
      confirmVariant="primary"
      onConfirm={choose}
      onClose={close}
      finalFocus={finalFocus}
      confirmTestId="artifact-page-fork-confirm"
    />
  ) : null;
  return { offered: pageFork !== null, ask, dialog };
}
