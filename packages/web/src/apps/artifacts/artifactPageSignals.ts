/**
 * The one place Raft hears what the person does in the Artifact's page that Raft's own cards and
 * boxes go away on (artifactDismissLayer): a press there, and Esc there. The page is another
 * document, so neither event reaches Raft's; what is known today:
 *
 * - A press: a guess. This window loses focus to a frame (`blur`, the frame then the active
 *   element). True only if this window had the focus before the press, so a card that wants to hear
 *   the next one first hands the focus back from the frame (`handFocusBack`). Missed when the focus
 *   was already in the page (a box the page's own button opened leaves it there on purpose, Tenny
 *   #11389), and on a browser that keeps the focus in a blurred frame. A page can make the same
 *   thing happen with no press at all, by taking the focus into its frame, so the layer lets this
 *   guess close only what a page could already close that way (`hearsPagePress`).
 * - Esc: Porthole's `cancelled` report, sent only while the page is asked for a pick or for text
 *   (P112). ArtifactReviewContext passes it on (`pageEscaped`), and only while Raft itself has
 *   such a request out (a page's report is the page's word). With nothing asked, an Esc in the
 *   page is not heard at all.
 *
 * Porthole 0.15.2 reports both for real. Then: call `pagePressed` and `pageEscaped` from the frame's
 * reports (ArtifactFrame), and delete `guessPresses` and `handFocusBack`. Nothing else changes: the
 * layer hears only `onPageSignal`.
 */
export type PageSignal = "press" | "escape";

/** True: the signal was taken (an Esc that closed something isn't also comment mode's). */
type PageListener = (signal: PageSignal) => boolean;

const listeners = new Set<PageListener>();
let stopGuessing: (() => void) | null = null;

/** Today's guess at a press in the page: this window blurred, a frame holding the focus. */
function guessPresses(): () => void {
  const blurred = () => {
    if (document.activeElement instanceof HTMLIFrameElement) pagePressed();
  };
  window.addEventListener("blur", blurred);
  return () => window.removeEventListener("blur", blurred);
}

const tell = (signal: PageSignal) => [...listeners].map((listener) => listener(signal)).some(Boolean);

/** A press landed in the Artifact's page. */
export function pagePressed(): void {
  tell("press");
}

/** Esc was pressed in the Artifact's page. True: something of Raft's took it. */
export function pageEscaped(): boolean {
  return tell("escape");
}

/** Hear the page's signals until the returned function is called. */
export function onPageSignal(listener: PageListener): () => void {
  listeners.add(listener);
  stopGuessing ??= guessPresses();
  return () => {
    listeners.delete(listener);
    if (listeners.size > 0) return;
    stopGuessing?.();
    stopGuessing = null;
  };
}

/**
 * Part of today's guess: a press in the page is heard only as this window losing the focus, so
 * with the focus already in a frame (a marker pressed there opened the card) it is handed back to
 * this window, to nothing in it. Returns that frame (Esc gives the focus back to it), or null.
 */
export function handFocusBack(): HTMLIFrameElement | null {
  const active = document.activeElement;
  if (!(active instanceof HTMLIFrameElement)) return null;
  active.blur();
  return active;
}
