import { closestOverlay } from "@botiverse/raft-ui";
import { currentTimeMs } from "@botiverse/raft-shared";

/**
 * How every Artifact comment card and box goes away, written once (xxchan, #proj-workspace): the
 * floating thread card, the Markdown margin's card, a draft's view, the composer at a selection or
 * a picked block, the box a page's own button opens, the comment list's reply and edit boxes, and
 * the find bar are each one `Dismissable` here, and none of them decides this for itself.
 *
 * The rule (`dismissRule`):
 * - Empty (no typed words in it): a press outside it closes it, and so does Esc, in Raft or in the
 *   Artifact's page.
 * - Holding typed words: it stays open, on a press outside, on Esc in the page, and when another
 *   card opens (a marker's word is the page's too). Only Raft's own Esc on the card closes it, and
 *   its words are then kept on this device, back when it opens again (ArtifactCommentBox,
 *   artifactLocalDrafts). No key and no press here deletes typed words: only a box's own × or
 *   Cancel does. (A box that takes its own Esc, an edit or a reply opened in place, stays open
 *   over typed words on that too: ArtifactCommentBox.)
 * - One card at a time: a card opening closes the card that was open ("replaced"), unless that
 *   one holds typed words. A press on the marker of the card that press just closed leaves it
 *   closed (`sameMarkAgain`).
 * - A key something inside already took (an edit box's Esc, an @ picker's) never also closes what
 *   is around it: an Esc that is `defaultPrevented` is nobody's here.
 *
 * "Typed words" is read from the page as it is, at the moment of the press or key: whatever is
 * drawn inside the dismissable and marked `data-artifact-typed` (a comment box holding words the
 * person typed; an edit left as the comment reads is not marked). So nothing here knows what kind
 * of box it is, or what mode opened it.
 *
 * What it hears: `press` (a click in Raft's own document, for what is drawn in the page's flow and
 * has no Popover or sheet to say so; those say it themselves, `useDismissable`'s `change`),
 * `pagePress` and `pageEscape` (artifactPageSignals: the one place the Artifact's page is heard
 * from), `escape` (Raft's own Esc, for the card on top). No listeners of its own: useArtifactDismiss
 * wires the document's.
 *
 * What the page says is the page's word, and an agent wrote the page (Porthole THREAT_MODEL §6:
 * hints, never permissions). So neither signal from it ever closes anything over typed words, a
 * press in the page reaches only what says it hears one (`hearsPagePress`: today's press is a
 * guess a page can forge by taking the focus, so it closes only what a page could already close
 * that way before this layer), and the page's Esc is passed on only while Raft asked the page
 * for a pick or for text (ArtifactReviewContext). docs/development/workspace-artifacts.md, "What
 * a page can make Raft close", lists it all.
 */
export type DismissBy = "press" | "pagePress" | "escape" | "pageEscape" | "replaced";

/** The rule: whether what `by` says closes something that holds typed words (`typed`) or not. */
export function dismissRule(by: DismissBy, typed: boolean): "close" | "stay" {
  if (!typed) return "close";
  return by === "escape" ? "close" : "stay";
}

/** Marks what holds words the person typed (ArtifactCommentBox's root). */
export const TYPED_ATTRIBUTE = "data-artifact-typed";
const TYPED = `[${TYPED_ATTRIBUTE}]`;
/** How long after a press in the page closed a card its marker's own word (`activated`) can still be that same press. */
export const SAME_MARK_MS = 1000;

export interface Dismissable {
  /** Where it is drawn now (null: not drawn, as a card that stepped aside for its confirmation). */
  element: () => Element | null;
  /**
   * Close it. `by`: what closed it, for what follows a close (where focus goes after Esc), or
   * "closed" for its own way out (its ×, a sheet swiped away), which no rule is asked about.
   */
  close: (by: DismissBy | "closed", event: Event | null) => void;
  /** One of the cards beside the page: one open at a time, and Raft's Esc closes the one on top. */
  card?: boolean;
  /** The marker in the page it is open for (a thread's, a draft's), if any. */
  mark?: string | null;
  /** Whether presses outside reach it (default true). The find bar stays through them, as a browser's does. */
  presses?: boolean;
  /**
   * Whether a press in the Artifact's page reaches it (default false). Only a thread's floating
   * card and the composer at a selection or a picked block: what a page could already close by
   * taking the focus before this layer. Nothing else gains that from the guess (Kirby).
   */
  hearsPagePress?: boolean;
  /** Drawn in the page's flow, with no Popover or sheet around it to hear a press outside: the layer hears it. */
  inFlow?: boolean;
  /**
   * A press closes it with typed words too, because its `close` keeps them itself: a phone's sheet
   * (modal: a tap outside is its way out; the words kept on this device), the composer at a
   * selection (kept as a draft, #proj-workspace:#229).
   */
  pressKeepsWords?: boolean;
}

export function createDismissLayer(now: () => number = currentTimeMs) {
  const entries: Dismissable[] = [];
  let closedByPagePress: { mark: string; at: number } | null = null;

  const typedIn = (entry: Dismissable) => {
    const element = entry.element();
    return element !== null && (element.matches(TYPED) || element.querySelector(TYPED) !== null);
  };
  /** One signal to one dismissable. True: it was its to answer (closed, or kept open over its words). */
  const signal = (entry: Dismissable, by: DismissBy, event: Event | null = null): boolean => {
    if (by === "escape" && event?.defaultPrevented) return false;
    const pressed = by === "press" || by === "pagePress";
    if ((pressed && entry.presses === false) || (by === "pagePress" && !entry.hearsPagePress)) return false;
    const typed = typedIn(entry);
    if ((pressed && entry.pressKeepsWords ? "close" : dismissRule(by, typed)) === "stay") return true;
    if (by === "pagePress" && entry.mark) closedByPagePress = { mark: entry.mark, at: now() };
    entry.close(by, event);
    return true;
  };

  return {
    signal,
    /** Open: a card takes the place of the card that was (one holding typed words stays). Returns its removal. */
    add(entry: Dismissable): () => void {
      if (entry.card) for (const other of [...entries]) if (other.card) signal(other, "replaced");
      entries.push(entry);
      return () => {
        const index = entries.indexOf(entry);
        if (index >= 0) entries.splice(index, 1);
      };
    },
    /** A click in Raft's own document: a press outside whatever is in the page's flow and doesn't hold its target. */
    press(event: Event): void {
      const target = event.target;
      if (!(target instanceof Node)) return;
      // A menu, popover or dialog drawn over the page (raft-ui's `closestOverlay`): a press in one is not a press on the ground under it.
      const overlay = closestOverlay(target);
      for (const entry of [...entries]) {
        const element = entry.inFlow ? entry.element() : null;
        if (!element || element.contains(target) || (overlay && !overlay.contains(element))) continue;
        signal(entry, "press", event);
      }
    },
    /** A press in the Artifact's page: outside everything of Raft's, heard by what says it hears one. */
    pagePress(): void {
      closedByPagePress = null;
      for (const entry of [...entries]) signal(entry, "pagePress");
    },
    /** Raft's own Esc that nothing under the focus took: the card on top. False: no card, or not its key. */
    escape(event: Event): boolean {
      const top = entries.filter((entry) => entry.card).at(-1);
      return top ? signal(top, "escape", event) : false;
    },
    /** Esc in the Artifact's page: whatever opened last. False: nothing is open. */
    pageEscape(): boolean {
      const top = entries.at(-1);
      return top ? signal(top, "pageEscape") : false;
    },
    /**
     * A marker's own word that it was pressed (`activated`): true when that press, heard first as a
     * press in the page, has just closed that marker's card, which then stays closed (once).
     */
    sameMarkAgain(mark: string): boolean {
      const closed = closedByPagePress;
      closedByPagePress = null;
      return closed !== null && closed.mark === mark && now() - closed.at < SAME_MARK_MS;
    },
    /** Whether anything is open (tests). */
    get size() { return entries.length; },
  };
}

export type DismissLayer = ReturnType<typeof createDismissLayer>;
