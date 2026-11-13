/**
 * The offer side of a split setup step (Meet Cindy, the Pro step): cream paper with a
 * faint dot grid, and the hero on a tilted white sticker card. Lighter than the yellow
 * frame panel these steps used to sit on, and the same card language as the account
 * setup preview.
 */
export const SETUP_PAPER = "relative overflow-hidden bg-layer-sidebar";

/** Lay over SETUP_PAPER, first child, aria-hidden. Same 14px grid as the create-server shell. */
export const SETUP_PAPER_DOT_GRID =
  "pointer-events-none absolute inset-0 opacity-60 [background-image:radial-gradient(var(--line-hairline)_1.5px,transparent_1.5px)] [background-size:14px_14px]";

/** A sticker card: ink edge, hard shadow. Add the tilt where it is used. */
export const SETUP_STICKER_CARD =
  "relative rounded-container border-[1.5px] border-line-strong bg-layer-canvas shadow-sticker";
