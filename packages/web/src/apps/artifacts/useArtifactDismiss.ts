import { useCallback, useEffect, useRef, useState } from "react";
import type { RefObject } from "react";

import { useShortcutLayer } from "../../features/shortcuts";
import { createDismissLayer } from "./artifactDismissLayer";
import type { Dismissable, DismissBy } from "./artifactDismissLayer";
import { handFocusBack, onPageSignal } from "./artifactPageSignals";

/**
 * The document's dismissal layer (artifactDismissLayer: the rule and who is open) and what it
 * hears, wired while anything is open: a click anywhere in Raft's document (for what is drawn in
 * the page's flow), and the Artifact's page (artifactPageSignals). One for the document: cards of
 * Raft's are one at a time across it, and the page's signals are the document's too.
 */
export const artifactDismissLayer = createDismissLayer();

let wired = 0;
let unwire: (() => void) | null = null;

function wire(): () => void {
  const pressed = (event: MouseEvent) => artifactDismissLayer.press(event);
  // A click, not the pointer going down: closing a card moves what is under the pointer (the
  // margin's cards re-place), and the press would then end on something else and click nothing.
  document.addEventListener("click", pressed, true);
  const offPage = onPageSignal((signal) => {
    if (signal === "escape") return artifactDismissLayer.pageEscape();
    artifactDismissLayer.pagePress();
    return true;
  });
  return () => {
    document.removeEventListener("click", pressed, true);
    offPage();
  };
}

function addDismissable(entry: DismissableOptions): () => void {
  // Today's way to hear the next press in the page (artifactPageSignals): the focus back from its frame.
  const left = entry.handsFocusBack ? handFocusBack() : null;
  if (left && entry.leftFrame) entry.leftFrame.current = left;
  const remove = artifactDismissLayer.add(entry);
  if (wired === 0) unwire = wire();
  wired += 1;
  return () => {
    remove();
    wired -= 1;
    if (wired > 0) return;
    unwire?.();
    unwire = null;
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
export function useDismissable(open: boolean, options: DismissableOptions): DismissableHandle {
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
  // After the effect above (in order), so the entry, and a card the layer closes as this one opens,
  // read the latest options.
  useEffect(() => {
    if (!open) return;
    return addDismissable(entry);
  }, [entry, open]);
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
  useShortcutLayer("commentCard", open && inFlow && card, {
    onEscape: (event) => {
      const active = document.activeElement;
      if (active !== null && active !== document.body) return false;
      return signal("escape", event);
    },
  });
  return { change, signal };
}
