import { useCallback, useEffect, useRef, useState } from "react";
import type { RefObject } from "react";

import { useShortcutLayer } from "../../features/shortcuts";
import { useOwnerDocument, viewOf } from "../../utils/ownerDocument";
import { createDismissLayer } from "./artifactDismissLayer";
import type { Dismissable, DismissBy } from "./artifactDismissLayer";
import { guessPagePresses, handFocusBack, onPageSignal } from "./artifactPageSignals";

/**
 * The dismissal layer (artifactDismissLayer: the rule and who is open) and what it hears, wired while
 * anything is open: a click anywhere in the document a card is open in (for what is drawn in the
 * page's flow), and the Artifact's page (artifactPageSignals). One for the app: cards of Raft's are
 * one at a time across it, and the page's signals are heard once. Each document with a card open is
 * wired on its own: the main window's, or an object window's (#337 PR3), whose clicks and blur never
 * reach the main window's.
 */
export const artifactDismissLayer = createDismissLayer();

/** The documents wired, each with how many open things are in it. */
const wiredDocuments = new Map<Document, { count: number; unwire: () => void }>();
let open = 0;
let offPage: (() => void) | null = null;

function wireDocument(doc: Document): () => void {
  const pressed = (event: MouseEvent) => artifactDismissLayer.press(event);
  // A click, not the pointer going down: closing a card moves what is under the pointer (the
  // margin's cards re-place), and the press would then end on something else and click nothing.
  doc.addEventListener("click", pressed, true);
  const stopGuessing = guessPagePresses(viewOf(doc));
  return () => {
    doc.removeEventListener("click", pressed, true);
    stopGuessing();
  };
}

function addDismissable(entry: DismissableOptions, doc: Document): () => void {
  // Today's way to hear the next press in the page (artifactPageSignals): the focus back from its frame.
  const left = entry.handsFocusBack ? handFocusBack(doc) : null;
  if (left && entry.leftFrame) entry.leftFrame.current = left;
  const remove = artifactDismissLayer.add(entry);
  const wired = wiredDocuments.get(doc);
  if (wired) wired.count += 1;
  else wiredDocuments.set(doc, { count: 1, unwire: wireDocument(doc) });
  open += 1;
  offPage ??= onPageSignal((signal) => {
    if (signal === "escape") return artifactDismissLayer.pageEscape();
    artifactDismissLayer.pagePress();
    return true;
  });
  return () => {
    remove();
    const own = wiredDocuments.get(doc);
    if (own) {
      own.count -= 1;
      if (own.count === 0) {
        own.unwire();
        wiredDocuments.delete(doc);
      }
    }
    open -= 1;
    if (open > 0) return;
    offPage?.();
    offPage = null;
  };
}

/** A marker's `activated` that only repeats the press that just closed its card (ArtifactFrame). */
export const sameMarkAgain = (mark: string) => artifactDismissLayer.sameMarkAgain(mark);

/** Raft's own Esc, taken by nothing under the focus: closes the card on top (the surface's key handler). */
export const escapeTopCard = (event: Event) => artifactDismissLayer.escape(event);

export interface DismissableOptions extends Dismissable {
  /**
   * Whether the focus is taken back from the Artifact's frame as it opens, so Esc is heard in Raft
   * and, for what hears one, the next press in the page (artifactPageSignals `handFocusBack`).
   * Never for a box the page's own button opened: the focus stays where the person had it (Tenny,
   * #11389).
   */
  handsFocusBack?: boolean;
  /** Set to the frame the focus was handed back from (`handsFocusBack`): where Esc may give it back. */
  leftFrame?: RefObject<HTMLIFrameElement | null>;
}

export interface DismissableHandle {
  /** A raft-ui Popover's or Drawer's `onOpenChange`: Esc and a press outside go through the rule, its other ways out close it. */
  change: (next: boolean, details?: { reason?: string; event?: Event }) => void;
  /** What its own handlers heard (Esc in an in-flow card), through the rule. True: it answered. */
  signal: (by: DismissBy, event?: Event | null) => boolean;
}

/**
 * One card, box or bar on the dismissal layer while `open` (artifactDismissLayer has the rule).
 * The component keeps what it alone knows: how to close (`close`, told what closed it), and where
 * it is drawn (`element`). It never listens for a press outside or reads the page itself.
 */
export function useDismissable(isOpen: boolean, options: DismissableOptions): DismissableHandle {
  const latest = useRef(options);
  useEffect(() => {
    latest.current = options;
  });
  const [entry] = useState<DismissableOptions>(() => ({
    element: () => latest.current.element(),
    close: (by, event) => latest.current.close(by, event),
    get card() { return latest.current.card; },
    get mark() { return latest.current.mark; },
    get presses() { return latest.current.presses; },
    get inFlow() { return latest.current.inFlow; },
    get pressKeepsWords() { return latest.current.pressKeepsWords; },
    get hearsPagePress() { return latest.current.hearsPagePress; },
    get handsFocusBack() { return latest.current.handsFocusBack; },
    get leftFrame() { return latest.current.leftFrame; },
  }));
  const { card = false, inFlow = false } = options;
  const doc = useOwnerDocument();
  // After the effect above (in order), so the entry, and a card the layer closes as this one opens,
  // read the latest options.
  useEffect(() => {
    if (!isOpen) return;
    return addDismissable(entry, doc);
  }, [entry, isOpen, doc]);
  const signal = useCallback((by: DismissBy, event: Event | null = null) => artifactDismissLayer.signal(entry, by, event), [entry]);
  const change = useCallback((next: boolean, details?: { reason?: string; event?: Event }) => {
    if (next) return;
    const event = details?.event ?? null;
    if (details?.reason === "escape-key") signal("escape", event);
    else if (details?.reason === "outside-press") signal("press", event);
    else entry.close("closed", event);
  }, [entry, signal]);
  // A card in the page's flow has no Popover to hear Esc with the focus nowhere (handed back from
  // the frame, or dropped by a press on blank ground): Esc closes it then too. With the focus on
  // something, the key is that thing's, or the surface's (`escapeTopCard`).
  useShortcutLayer("commentCard", isOpen && inFlow && card, {
    onEscape: (event) => {
      // The focus in the card's own document (an object window's has its own).
      const active = doc.activeElement;
      if (active !== null && active !== doc.body) return false;
      return signal("escape", event);
    },
  });
  return { change, signal };
}
