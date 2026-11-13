import { createContext } from "react";

import type { ArtifactBubbleKeyboard, ArtifactCommentBubble } from "./artifactCommentsShapes";

/**
 * A thread's card a frame's report opened with the focus in the frame is held (Porthole P134,
 * THREAT_MODEL §6's second exception; bubble `keyboard`): the page can bring that about, forged, and
 * have the person's next keys land in the card. So keys alone can't send, a real click comes first:
 * nothing in it writes until the person presses in it with a pointer, which no keys of theirs can
 * stand in for: the card's reply and edit boxes (ArtifactCommentBox, for all of Enter, ⌘Enter, Send
 * and Save Draft; the field is out of the Tab order as well) and its deletes. The gate is at the
 * write, not on typing: a screen reader can focus the field and ⋯'s Edit focuses its box, and keys
 * can type there, on purpose, so don't block keyboard input here. The design says the rest: the
 * field isn't focused for the person and its placeholder asks for the click. Someone without a pointer goes on from the first item of its ⋯ to the comment
 * list, on the thread and never in a box (`openThreadInList`). This is what a write calls instead
 * of writing; null where nothing is held.
 *
 * Only that press lifts a hold, whatever the page reports: a card that replaces a held one inherits
 * it (`heldKeyboard`), and while one is held no report opens anything else in its place or beside
 * it (`cardHeld`: `comments.open`, a selection's box, a draft's view). Its ⋯'s item goes to the
 * list, held or not, and a press there lifts the hold like any other; closing it (Esc, Tab out past its end, a press elsewhere, the page taking the focus back)
 * ends it with the card.
 */
export const ArtifactCardHoldContext = createContext<(() => void) | null>(null);

/**
 * A card that took the focus off the frame: its way to the list, an item of a ⋯ (CommentItem).
 * `off` while the card is armed: the menu is portaled out of what the card holds `inert`.
 */
export interface ArtifactCardListWay {
  open: () => void;
  off: boolean;
}

/** The hold a bubble carries, for the card that replaces it: null when it isn't held. */
export function heldKeyboard(bubble: ArtifactCommentBubble | null): ArtifactBubbleKeyboard | null {
  return bubble?.kind === "thread" && bubble.keyboard?.held ? bubble.keyboard : null;
}
