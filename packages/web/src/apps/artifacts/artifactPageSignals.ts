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
 * reports (ArtifactFrame), and delete `guessPagePresses` and `handFocusBack`. Nothing else changes: the
 * layer hears only `onPageSignal`.
 *
 * The guess is per window: the Artifact may be drawn in an object window (#337 PR3), whose own window
 * blurs when its frame takes a press (the main window's doesn't), so it is watched on each window
 * that has a card open (useArtifactDismiss), and the frame is looked for in that window's document.
 */
export type PageSignal = "press" | "escape";

/** True: the signal was taken (an Esc that closed something isn't also comment mode's). */
type PageListener = (signal: PageSignal) => boolean;

const listeners = new Set<PageListener>();
/** The windows watched for the guess, each with how many asked. */
const guessing = new Map<Window, { count: number; stop: () => void }>();

/** A frame element of any window (an object window's are another realm's: no `instanceof HTMLIFrameElement`). */
function frameElement(element: Element | null): HTMLIFrameElement | null {
  return element?.localName === "iframe" ? element as HTMLIFrameElement : null;
}

/**
 * Today's guess at a press in the page, on `view` (the window a card is open in): it blurred, a frame
 * of its document holding the focus. Watched once per window however many ask. Returns the stop.
 */
export function guessPagePresses(view: Window = window): () => void {
  const watched = guessing.get(view);
  if (watched) watched.count += 1;
  else {
    const blurred = () => {
      if (frameElement(view.document.activeElement)) pagePressed();
    };
    view.addEventListener("blur", blurred);
    guessing.set(view, { count: 1, stop: () => view.removeEventListener("blur", blurred) });
  }
  let stopped = false;
  return () => {
    if (stopped) return;
    stopped = true;
    const entry = guessing.get(view);
    if (!entry) return;
    entry.count -= 1;
    if (entry.count > 0) return;
    entry.stop();
    guessing.delete(view);
  };
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

/** Hear the page's signals until the returned function is called (a press is guessed only where guessPagePresses watches). */
export function onPageSignal(listener: PageListener): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

/**
 * Part of today's guess: a press in the page is heard only as this window losing the focus, so
 * with the focus already in a frame (a marker pressed there opened the card) it is handed back to
 * this window, to nothing in it. Returns that frame (Esc gives the focus back to it), or null. `doc`:
 * the document the card opens in (an object window's own).
 */
export function handFocusBack(doc: Document = document): HTMLIFrameElement | null {
  const active = frameElement(doc.activeElement);
  if (!active) return null;
  active.blur();
  return active;
}
