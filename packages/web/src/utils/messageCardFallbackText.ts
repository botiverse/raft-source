// A card message's text outside the card (RFC 086 §4.4). The fallback Raft
// stores as the message's `content` is the card as a client older than acting
// buttons reads it, so each acting button is there as its label and the one
// text Raft stores for such a client: "Approve (disabled: Update Raft to use
// this button)". This client draws those buttons, so wherever it shows a
// message as text instead of its card (Activity and thread previews, quotes,
// search results, Saved, a desktop notification, copied text) an acting
// button reads as its label only.
//
// By the text alone: most of those places hold only a string Raft's server
// made from `content`, with no card beside it. The wording is Raft's own
// constant, which no sender chooses (Raft writes it over whatever they put).
// docs/development/app-link-previews.md, "Card messages with acting buttons".

import { MESSAGE_CARD_ACTING_BUTTON_DISABLED_REASON } from "@botiverse/raft-shared";

/** What follows an acting button's label in the fallback (shared messageCard.ts, cardButtonRun). */
const STORED = ` (disabled: ${MESSAGE_CARD_ACTING_BUTTON_DISABLED_REASON})`;
const MARK = " (disabled";
const escaped = (text: string) => text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
// A fallback cut at its length limit ends in "…": one that ends inside the wording keeps only its start.
const CUT = new RegExp(
  `(?:${Array.from({ length: STORED.length - MARK.length }, (_, index) => escaped(STORED.slice(0, STORED.length - 1 - index))).join("|")})(?=…)`,
  "g",
);

/** `text` with every acting button as its label only: Raft's stored reason for older clients taken out, whole or cut short. */
export function messageCardFallbackText(text: string): string {
  if (!text.includes(MARK)) return text;
  return text.split(STORED).join("").replace(CUT, "");
}
