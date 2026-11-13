/**
 * The App's toolbar row (the host shell): room above and below its bar buttons for their focus ring
 * (raft-ui `--focus-ring`, 4px outside the button) with 2px clear of the row's edges and its 1px
 * seam (Kirby, on Back's ring, #14027). A head is `--header-height-short`, 48px, on a viewport under
 * 600px tall (index.css), which left a 44px touch button 2px: its ring ran into the row's top and
 * the seam. Raft-ui's bar buttons draw their ring outside, so the row makes the room.
 */
// 13px: 2 x (4px ring + 2px clear) + the 1px seam.
export const HOST_TOOLBAR_ROOM = "min-h-[calc(var(--bar-button-size)+13px)]";
